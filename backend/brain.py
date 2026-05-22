"""
Data Wrench — BRAIN module
External-facing endpoints under /api/brain/* for cross-project integration
(e.g., Dr. Underhood Live Assist calls our /api/brain/ask to get RAG context).

Auth: shared bearer token from BRAIN_INGRESS_TOKEN env var.
Multi-tenant: every record scoped by shop_id.

Internal-facing endpoints under /api/cases/* (user JWT auth) are also here
so Doc's UI can create/edit/list cases in the same brain store.
"""
import os
import io
import json
import math
import uuid
import base64
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any, Literal

from fastapi import APIRouter, HTTPException, Depends, Header, UploadFile, File, Form, Query, Request
from pydantic import BaseModel, Field
from motor.motor_asyncio import AsyncIOMotorClient

import httpx

log = logging.getLogger("datawrench.brain")

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")

BRAIN_TOKEN = os.environ.get("BRAIN_INGRESS_TOKEN", "")
DEFAULT_SHOP_ID = os.environ.get("DEFAULT_SHOP_ID", "drunderhood-fortsmith")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
# Comma-separated allowlist of origins permitted to call /api/brain/*
# (in addition to bearer-token auth — defense in depth). Empty = allow any.
BRAIN_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("BRAIN_ALLOWED_ORIGINS", "").split(",") if o.strip()]


# ============ Models ============
class VehicleBrief(BaseModel):
    vin: Optional[str] = ""
    year: Optional[str] = ""
    make: Optional[str] = ""
    model: Optional[str] = ""
    engine: Optional[str] = ""


class AskReq(BaseModel):
    shop_id: str
    vehicle: Optional[VehicleBrief] = None
    symptom: str
    dtc_codes: Optional[List[str]] = []
    image_base64: Optional[str] = None
    k: int = 5
    case_ids_already_seen: Optional[List[str]] = []  # Partner sends ids from prior /ask calls in same diag session; we suppress them so re-diagnose surfaces FRESH matches.


class CaseMatch(BaseModel):
    case_id: str
    similarity: float
    vehicle_summary: str
    symptom: str
    root_cause: str
    repair_summary: str
    parts: List[str] = []
    technician: str = ""
    outcome: str = "FIXED"
    date: str = ""
    photo_urls: List[str] = []


class AskResp(BaseModel):
    matches: List[CaseMatch] = []
    confidence: str = "empty"  # high | medium | low | empty
    total_cases_in_brain: int = 0


class LearnReq(BaseModel):
    shop_id: str
    case_id: Optional[str] = None  # external id for de-dupe
    vehicle: Optional[VehicleBrief] = None
    symptom: str
    dtc_codes: Optional[List[str]] = []
    root_cause: str = ""
    repair_summary: str = ""
    parts: Optional[List[str]] = []
    technician_name: Optional[str] = ""
    technician_id: Optional[str] = ""
    outcome: Literal["FIXED", "PARTIAL", "NOT_FIXED"] = "FIXED"
    labor_hours: Optional[float] = None
    photos_base64: Optional[List[str]] = []
    confidence_note: Optional[str] = ""


class LearnResp(BaseModel):
    case_id_in_brain: str
    ingested: bool
    embedded: bool
    total_cases_in_brain_now: int


class StatsResp(BaseModel):
    shop_id: str
    total_cases: int
    total_vehicles_seen: int
    technicians_contributing: int
    last_ingest_at: Optional[str] = None
    top_makes: List[str] = []
    brain_version: str = "0.1.0"
    shop_name: Optional[str] = ""
    capabilities: List[str] = []
    specialties: List[str] = []
    service_areas: List[str] = []


class FeedbackReq(BaseModel):
    shop_id: str
    case_id_in_brain: str
    drunderhood_session_id: Optional[str] = ""
    was_helpful: bool
    actual_outcome: Literal["FIXED", "PARTIAL", "NOT_FIXED"] = "FIXED"


class FeedbackResp(BaseModel):
    received: bool


# ============ Helpers ============
def cosine(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def case_text_blob(c: Dict[str, Any]) -> str:
    """Concat the fields we embed for similarity search."""
    v = c.get("vehicle") or {}
    parts = [
        f"{v.get('year','')} {v.get('make','')} {v.get('model','')} {v.get('engine','')}".strip(),
        f"SYMPTOM: {c.get('symptom','')}",
        f"DTC: {', '.join(c.get('dtc_codes') or [])}",
        f"ROOT CAUSE: {c.get('root_cause','')}",
        f"REPAIR: {c.get('repair_summary','')}",
        f"PARTS: {', '.join(c.get('parts') or [])}",
    ]
    return "\n".join(p for p in parts if p.strip() and not p.endswith(": "))


async def embed_text(text: str) -> List[float]:
    """Returns 1536-dim embedding via OpenAI text-embedding-3-small (Doc's API key)."""
    if not text.strip() or not OPENAI_API_KEY:
        return []
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                json={"model": "text-embedding-3-small", "input": text[:6000]},
            )
        if r.status_code != 200:
            log.warning(f"embed_text {r.status_code}: {r.text[:200]}")
            return []
        data = r.json()
        return list(data["data"][0]["embedding"])
    except Exception as e:
        log.warning(f"embed_text failed: {e}")
        return []


_EXTRACT_SYSTEM = """You are a data-extraction tool for an automotive shop's repair-history brain.
Doc pastes the raw text of one or more repair orders (RO). Your job is to extract STRUCTURED case data.

OUTPUT FORMAT — strict JSON, no commentary:
{
  "cases": [
    {
      "vehicle": {"year":"", "make":"", "model":"", "engine":"", "vin":""},
      "symptom": "customer concern in their words OR the tech write-up of the complaint",
      "dtc_codes": ["P0300"],
      "root_cause": "the actual finding — what was wrong",
      "repair_summary": "what the tech did to fix it",
      "parts": ["list of parts used, one per item, SKU or description"],
      "outcome": "FIXED" | "PARTIAL" | "NOT_FIXED",
      "technician_name": "if mentioned, else empty",
      "labor_hours": null
    }
  ]
}

RULES:
- If the input contains MULTIPLE repair orders (separated by blank lines, "---", "===", or obvious RO breaks), return one case per RO.
- If a field is not in the text, return empty string "" or empty array [] — DON'T invent.
- Year/make/model/engine: extract aggressively. "2014 Silverado 5.3" → year=2014, make=Chevrolet, model=Silverado, engine=5.3L.
- VIN: 17-char alphanumeric, all caps. Only fill if present in text.
- DTC codes: regex P/B/C/U + 4 digits (e.g. P0300, B1234).
- Outcome: assume FIXED unless text says "didn't fix", "still doing it", "came back", "no resolution" → then PARTIAL or NOT_FIXED.
- Labor hours: numeric if mentioned (e.g. "1.5 hr", "2 hours" → 1.5 / 2.0). Else null.
- DO NOT include any text outside the JSON object. NO markdown fences. JUST {"cases": [...]}.
"""


async def extract_cases_from_text(raw_text: str) -> List[Dict[str, Any]]:
    """Use GPT-5.2 (via Emergent LLM key) to parse raw RO text into structured cases."""
    if not raw_text.strip():
        return []
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(api_key=EMERGENT_LLM_KEY, session_id=f"extract-{uuid.uuid4().hex[:8]}", system_message=_EXTRACT_SYSTEM).with_model("openai", "gpt-5.2")
        reply = await chat.send_message(UserMessage(text=raw_text[:12000]))
        # Strip any code fences
        cleaned = reply.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```", 2)[1]
            if cleaned.lower().startswith("json"):
                cleaned = cleaned[4:]
            cleaned = cleaned.rsplit("```", 1)[0].strip()
        data = json.loads(cleaned)
        cases = data.get("cases", []) if isinstance(data, dict) else []
        return [c for c in cases if isinstance(c, dict) and (c.get("symptom") or c.get("root_cause") or c.get("repair_summary"))]
    except Exception as e:
        log.warning(f"extract_cases_from_text failed: {e}")
        return []


def vehicle_summary(v: Dict[str, Any]) -> str:
    parts = [v.get("year") or "", v.get("make") or "", v.get("model") or "", v.get("engine") or ""]
    return " ".join(p for p in parts if p).strip() or "unknown vehicle"


def case_doc_to_match(c: Dict[str, Any], sim: float) -> CaseMatch:
    return CaseMatch(
        case_id=c.get("id") or c.get("case_id") or "",
        similarity=round(sim, 4),
        vehicle_summary=vehicle_summary(c.get("vehicle") or {}),
        symptom=c.get("symptom") or "",
        root_cause=c.get("root_cause") or "",
        repair_summary=c.get("repair_summary") or "",
        parts=c.get("parts") or [],
        technician=c.get("technician_name") or "",
        outcome=c.get("outcome") or "FIXED",
        date=(c.get("created_at") or "")[:10],
        photo_urls=c.get("photo_urls") or [],
    )


# ============ Dependencies ============
def get_brain_token(authorization: Optional[str] = Header(None)) -> str:
    """External brain bearer token check (NOT the user JWT).

    Note on CORS / Origin lock:
    The Emergent platform's proxy (Cloudflare) rewrites the upstream Origin
    header, so a literal Origin allowlist would block all real partner traffic.
    The bearer token IS the security boundary here. Browser-side CSRF is not
    a concern because no browser can obtain the token in the first place.
    For documentation purposes the allowlist of partner origins is still kept
    in BRAIN_ALLOWED_ORIGINS but it is informational only."""
    if not BRAIN_TOKEN:
        raise HTTPException(503, "Brain not configured (missing BRAIN_INGRESS_TOKEN)")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing brain bearer token")
    if authorization[7:] != BRAIN_TOKEN:
        raise HTTPException(401, "Invalid brain bearer token")
    return BRAIN_TOKEN


# ============ Router factory (called from server.py with db) ============
def make_brain_router(db, get_user):
    """Create the /api/brain/* and /api/cases/* router bound to this db."""
    router = APIRouter()

    # ----- External brain endpoints (bearer token) -----
    @router.post("/brain/ask", response_model=AskResp)
    async def brain_ask(body: AskReq, _t: str = Depends(get_brain_token)):
        shop_id = body.shop_id or DEFAULT_SHOP_ID
        # Build query text and embed
        query_text = "\n".join([
            f"{(body.vehicle.year if body.vehicle else '')} {(body.vehicle.make if body.vehicle else '')} {(body.vehicle.model if body.vehicle else '')} {(body.vehicle.engine if body.vehicle else '')}".strip(),
            f"SYMPTOM: {body.symptom}",
            f"DTC: {', '.join(body.dtc_codes or [])}",
        ])
        q_emb = await embed_text(query_text)

        # Pull all cases for this shop. For >10k cases swap to Atlas Vector Search.
        cur = db.brain_cases.find({"shop_id": shop_id}, {"_id": 0})
        all_cases = await cur.to_list(20000)
        # Filter out cases the partner has already surfaced this diag session
        seen = set((body.case_ids_already_seen or [])[:50])
        scored = []
        for c in all_cases:
            cid = c.get("id") or c.get("case_id") or ""
            if cid and cid in seen:
                continue
            emb = c.get("embedding") or []
            sim = cosine(q_emb, emb) if q_emb and emb else 0.0
            scored.append((sim, c))
        scored.sort(key=lambda x: x[0], reverse=True)
        k = max(1, min(10, body.k or 5))
        top = scored[:k]
        matches = [case_doc_to_match(c, s) for s, c in top if s > 0.2]

        # Confidence heuristic
        if not matches:
            conf = "empty"
        elif matches[0].similarity >= 0.78:
            conf = "high"
        elif matches[0].similarity >= 0.55:
            conf = "medium"
        else:
            conf = "low"
        total = await db.brain_cases.count_documents({"shop_id": shop_id})
        return AskResp(matches=matches, confidence=conf, total_cases_in_brain=total)

    @router.post("/brain/learn", response_model=LearnResp)
    async def brain_learn(body: LearnReq, _t: str = Depends(get_brain_token)):
        shop_id = body.shop_id or DEFAULT_SHOP_ID
        case_id = body.case_id or str(uuid.uuid4())
        # store photos in GridFS would be cleanest, for MVP store base64 inline (capped to 5 @ 4MB each)
        photos = (body.photos_base64 or [])[:5]
        doc = {
            "id": case_id,
            "shop_id": shop_id,
            "vehicle": (body.vehicle.dict() if body.vehicle else {}),
            "symptom": body.symptom,
            "dtc_codes": body.dtc_codes or [],
            "root_cause": body.root_cause,
            "repair_summary": body.repair_summary,
            "parts": body.parts or [],
            "technician_name": body.technician_name or "",
            "technician_id": body.technician_id or "",
            "outcome": body.outcome,
            "labor_hours": body.labor_hours,
            "photos_base64": photos,
            "confidence_note": body.confidence_note or "",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": "brain_api",
        }
        emb = await embed_text(case_text_blob(doc))
        doc["embedding"] = emb
        await db.brain_cases.update_one({"id": case_id, "shop_id": shop_id}, {"$set": doc}, upsert=True)
        total = await db.brain_cases.count_documents({"shop_id": shop_id})
        return LearnResp(case_id_in_brain=case_id, ingested=True, embedded=bool(emb), total_cases_in_brain_now=total)

    @router.get("/brain/stats", response_model=StatsResp)
    async def brain_stats(shop_id: str = Query(...), _t: str = Depends(get_brain_token)):
        total = await db.brain_cases.count_documents({"shop_id": shop_id})
        vehicles = await db.brain_cases.distinct("vehicle.vin", {"shop_id": shop_id})
        techs = await db.brain_cases.distinct("technician_name", {"shop_id": shop_id})
        last = await db.brain_cases.find({"shop_id": shop_id}, {"_id": 0, "created_at": 1}).sort("created_at", -1).limit(1).to_list(1)
        last_at = last[0]["created_at"] if last else None
        # top makes
        pipeline = [
            {"$match": {"shop_id": shop_id}},
            {"$group": {"_id": "$vehicle.make", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 5},
        ]
        top_makes_docs = await db.brain_cases.aggregate(pipeline).to_list(5)
        top_makes = [d["_id"] for d in top_makes_docs if d.get("_id")]
        # Pull shop profile (capabilities/specialties) for the partner app
        profile = await db.shop_profiles.find_one({"shop_id": shop_id}, {"_id": 0}) or {}
        return StatsResp(
            shop_id=shop_id,
            total_cases=total,
            total_vehicles_seen=len([v for v in vehicles if v]),
            technicians_contributing=len([t for t in techs if t]),
            last_ingest_at=last_at,
            top_makes=top_makes,
            brain_version="0.1.0",
            shop_name=profile.get("name", ""),
            capabilities=profile.get("capabilities", []),
            specialties=profile.get("specialties", []),
            service_areas=profile.get("service_areas", []),
        )

    @router.post("/brain/feedback", response_model=FeedbackResp)
    async def brain_feedback(body: FeedbackReq, _t: str = Depends(get_brain_token)):
        await db.brain_feedback.insert_one({
            "id": str(uuid.uuid4()),
            "shop_id": body.shop_id,
            "case_id_in_brain": body.case_id_in_brain,
            "drunderhood_session_id": body.drunderhood_session_id,
            "was_helpful": body.was_helpful,
            "actual_outcome": body.actual_outcome,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        return FeedbackResp(received=True)

    @router.get("/brain/cases")
    async def brain_cases_index(
        shop_id: str = Query(...),
        limit: int = Query(50, ge=1, le=200),
        skip: int = Query(0, ge=0),
        outcome: Optional[str] = Query(None, description="Filter by FIXED | PARTIAL | NOT_FIXED"),
        _t: str = Depends(get_brain_token),
    ):
        """Paginated list of cases ingested for a shop. Lightweight payload (no embeddings, no photos).
        For shop-admin dashboards on the customer-facing app side."""
        q = {"shop_id": shop_id}
        if outcome:
            q["outcome"] = outcome.upper()
        total = await db.brain_cases.count_documents(q)
        cur = db.brain_cases.find(q, {"_id": 0, "embedding": 0, "photos_base64": 0}).sort("created_at", -1).skip(skip).limit(limit)
        cases = await cur.to_list(limit)
        return {
            "shop_id": shop_id,
            "total": total,
            "skip": skip,
            "limit": limit,
            "returned": len(cases),
            "cases": cases,
        }

    # ----- Team conversations (Partner Phase 2 employee dashboard) -----
    @router.get("/brain/team-conversations")
    async def brain_team_conversations(
        shop_id: str = Query(...),
        technician_id: Optional[str] = Query(None, description="Scope to threads visible to this tech. Omit to return all threads (manager view)."),
        thread_key: Optional[str] = Query(None, description="If set, returns just this thread's messages. e.g. 'shop' or 'uid1|uid2'"),
        message_limit: int = Query(50, ge=1, le=500),
        thread_limit: int = Query(20, ge=1, le=100),
        _t: str = Depends(get_brain_token),
    ):
        """Bearer-token gated endpoint for the partner app's employee dashboard.
        Returns: shop's team chat threads + recent messages for each.
        Multi-tenant: scoped by shop_id, optionally further scoped to a single technician's
        visible threads (the #shop channel plus any DM thread that includes their user id)."""
        # All techs in the shop (for thread naming + DM resolution)
        techs = await db.users.find({"shop_id": shop_id}, {"_id": 0, "password": 0, "settings": 0}).to_list(500)
        tech_by_id = {t["id"]: t for t in techs}

        # Distinct thread keys present in the shop's team messages
        all_thread_keys = await db.team_chat_messages.distinct("thread_key", {"shop_id": shop_id})

        def thread_visible_to(tech_id: str, key: str) -> bool:
            if key == "shop":
                return True
            return tech_id in key.split("|")

        if thread_key:
            keys = [thread_key]
        elif technician_id:
            keys = [k for k in all_thread_keys if thread_visible_to(technician_id, k)]
        else:
            keys = all_thread_keys

        # Build threads payload
        threads = []
        for k in keys[:thread_limit]:
            if k == "shop":
                name = "#SHOP"
                kind = "channel"
                members = [t["id"] for t in techs]
            else:
                kind = "dm"
                parts = k.split("|")
                member_names = [tech_by_id.get(p, {}).get("name") or p for p in parts]
                name = " ↔ ".join(member_names)
                members = parts
            cur = db.team_chat_messages.find(
                {"shop_id": shop_id, "thread_key": k},
                {"_id": 0, "shop_id": 0},
            ).sort("created_at", -1).limit(message_limit)
            msgs = await cur.to_list(message_limit)
            msgs.reverse()  # chronological order for the partner UI
            count = await db.team_chat_messages.count_documents({"shop_id": shop_id, "thread_key": k})
            threads.append({
                "thread_key": k,
                "name": name,
                "kind": kind,
                "members": members,
                "message_count": count,
                "messages": msgs,
            })
        # Sort threads by most-recent activity (channel first when tied)
        threads.sort(
            key=lambda t: (t["messages"][-1]["created_at"] if t["messages"] else "", t["kind"] == "channel"),
            reverse=True,
        )
        return {
            "shop_id": shop_id,
            "technician_id": technician_id,
            "thread_count": len(threads),
            "threads": threads,
        }

    # ----- Shop Profile (multi-tenant capabilities) -----
    class ShopCapabilityList(BaseModel):
        shop_id: Optional[str] = None
        name: Optional[str] = ""
        capabilities: List[str] = []  # ["AFM/DOD delete", "ECM/TCM tuning", ...]
        specialties: List[str] = []   # ["GM 5.3 V8", "Ford Powerstroke 6.7", ...]
        service_areas: List[str] = [] # ["Fort Smith AR", "NW Arkansas", ...]
        hours: Optional[str] = ""
        phone: Optional[str] = ""
        address: Optional[str] = ""
        notes: Optional[str] = ""

    DEFAULT_PROFILE = {
        "name": "Dr. Underhood",
        "capabilities": [
            "AFM / DOD delete tuning",
            "HP Tuners ECM/TCM flashing",
            "Datalog diagnostics",
            "Diesel performance tuning",
            "General automotive repair",
        ],
        "specialties": [],
        "service_areas": [],
        "hours": "",
        "phone": "",
        "address": "",
        "notes": "",
    }

    async def _get_or_seed_profile(sid: str) -> Dict[str, Any]:
        doc = await db.shop_profiles.find_one({"shop_id": sid}, {"_id": 0})
        if doc:
            return doc
        seed = {
            "shop_id": sid,
            **DEFAULT_PROFILE,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.shop_profiles.insert_one(dict(seed))
        seed.pop("_id", None)
        return seed

    @router.get("/shop/profile")
    async def get_shop_profile(user=Depends(get_user)):
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        return await _get_or_seed_profile(sid)

    @router.put("/shop/profile")
    async def put_shop_profile(body: ShopCapabilityList, user=Depends(get_user)):
        if (user.get("role") or "owner") != "owner":
            raise HTTPException(403, "Only the shop owner can edit the shop profile.")
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        existing = await db.shop_profiles.find_one({"shop_id": sid}, {"_id": 0}) or {}
        merged = {
            **existing,
            "shop_id": sid,
            "name": body.name if body.name is not None else existing.get("name", ""),
            "capabilities": [c.strip() for c in (body.capabilities or []) if c and c.strip()][:50],
            "specialties": [c.strip() for c in (body.specialties or []) if c and c.strip()][:50],
            "service_areas": [c.strip() for c in (body.service_areas or []) if c and c.strip()][:50],
            "hours": body.hours or "",
            "phone": body.phone or "",
            "address": body.address or "",
            "notes": body.notes or "",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if not existing.get("created_at"):
            merged["created_at"] = merged["updated_at"]
        await db.shop_profiles.update_one({"shop_id": sid}, {"$set": merged}, upsert=True)
        merged.pop("_id", None)
        return merged

    @router.get("/brain/shop-profile")
    async def brain_shop_profile(shop_id: str = Query(...), _t: str = Depends(get_brain_token)):
        """Partner-facing read of a shop's capabilities/specialties so their LLM
        can ground responses (e.g. \"Yes, this shop does AFM delete tuning\")."""
        return await _get_or_seed_profile(shop_id)

    # ----- Recent outcomes (partner polls this to learn from closed jobs) -----
    @router.get("/brain/recent-outcomes")
    async def brain_recent_outcomes(
        shop_id: str = Query(...),
        since: Optional[str] = Query(None, description="ISO-8601 timestamp. Returns only events created after this. Omit for last 50 events."),
        outcome: Optional[str] = Query(None, description="Filter by FIXED | PARTIAL | NOT_FIXED"),
        limit: int = Query(50, ge=1, le=500),
        _t: str = Depends(get_brain_token),
    ):
        """Lightweight feed of every job Doc has closed since `since`. Partner polls
        this every minute or so and uses it to: (a) downweight similarity matches
        whose outcome turned out NOT_FIXED, (b) surface fresh repair patterns to
        their dashboard, (c) celebrate FIXED outcomes back to the original
        symptom reporter."""
        q = {"shop_id": shop_id}
        if since:
            q["created_at"] = {"$gt": since}
        if outcome:
            q["outcome"] = outcome.upper()
        cur = db.brain_outcome_events.find(q, {"_id": 0}).sort("created_at", -1).limit(limit)
        events = await cur.to_list(limit)
        return {
            "shop_id": shop_id,
            "since": since,
            "count": len(events),
            "events": events,
        }

    # ----- Tune history (partner pulls Doc's prior tuning edits per VIN) -----
    @router.get("/brain/tune-history")
    async def brain_tune_history(
        shop_id: str = Query(...),
        vehicle_vin: Optional[str] = Query(None, description="17-char VIN. If omitted, returns most recent tune edits across the shop."),
        limit: int = Query(50, ge=1, le=500),
        _t: str = Depends(get_brain_token),
    ):
        """Returns Doc's structured tune log per VIN for use by partner agents.

        Use cases:
          a) Repeat-visit context — inject last 3-5 edits into the partner LLM prompt
             when a previously-tuned vehicle returns with a new complaint.
          b) UI affordance — render a "PREVIOUSLY TUNED" pill if events > 0.
          c) Disambiguation when a customer owns multiple similar vehicles.

        Auth: bearer token, same as ask/learn/stats.
        """
        # Find users belonging to this shop, then their tune_log entries
        shop_user_ids = [u["id"] async for u in db.users.find({"shop_id": shop_id}, {"_id": 0, "id": 1})]
        if not shop_user_ids:
            return {"shop_id": shop_id, "vin": vehicle_vin, "events": []}
        q = {"user_id": {"$in": shop_user_ids}}
        if vehicle_vin:
            # Map VIN → vehicle_id(s)
            vids = [v["id"] async for v in db.vehicles.find(
                {"user_id": {"$in": shop_user_ids}, "vin": vehicle_vin},
                {"_id": 0, "id": 1}
            )]
            if not vids:
                return {"shop_id": shop_id, "vin": vehicle_vin, "events": []}
            q["vehicle_id"] = {"$in": vids}
        cur = db.tune_log.find(q, {"_id": 0}).sort("created_at", -1).limit(limit)
        rows = await cur.to_list(limit)
        events = [
            {
                "ts": r.get("created_at"),
                "vehicle_id": r.get("vehicle_id"),
                "section": r.get("section", ""),
                "tab": r.get("tab", ""),
                "subtab": r.get("subtab", ""),
                "table_name": r.get("table_name", ""),
                "symptom": r.get("symptom", ""),
                "instruction": r.get("instruction", ""),
                "before": r.get("before_table", ""),
                "after": r.get("after_table", ""),
            }
            for r in rows
        ]
        return {"shop_id": shop_id, "vin": vehicle_vin, "count": len(events), "events": events}

    # ----- Internal Cases endpoints (user JWT) -----
    @router.get("/cases")
    async def list_cases(user=Depends(get_user)):
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        cur = db.brain_cases.find({"shop_id": shop_id}, {"_id": 0, "embedding": 0, "photos_base64": 0}).sort("created_at", -1).limit(200)
        return await cur.to_list(200)

    @router.get("/cases/{case_id}")
    async def get_case(case_id: str, user=Depends(get_user)):
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        doc = await db.brain_cases.find_one({"id": case_id, "shop_id": shop_id}, {"_id": 0, "embedding": 0})
        if not doc:
            raise HTTPException(404, "Case not found")
        return doc

    @router.post("/cases")
    async def create_case(body: LearnReq, user=Depends(get_user)):
        # Same flow as /brain/learn but scoped to current user's shop
        shop_id = body.shop_id or user.get("shop_id") or DEFAULT_SHOP_ID
        case_id = body.case_id or str(uuid.uuid4())
        photos = (body.photos_base64 or [])[:5]
        doc = {
            "id": case_id,
            "shop_id": shop_id,
            "vehicle": (body.vehicle.dict() if body.vehicle else {}),
            "symptom": body.symptom,
            "dtc_codes": body.dtc_codes or [],
            "root_cause": body.root_cause,
            "repair_summary": body.repair_summary,
            "parts": body.parts or [],
            "technician_name": body.technician_name or user.get("name", ""),
            "technician_id": body.technician_id or user.get("id", ""),
            "outcome": body.outcome,
            "labor_hours": body.labor_hours,
            "photos_base64": photos,
            "confidence_note": body.confidence_note or "",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": "ui",
            "created_by_user_id": user.get("id"),
        }
        emb = await embed_text(case_text_blob(doc))
        doc["embedding"] = emb
        await db.brain_cases.update_one({"id": case_id, "shop_id": shop_id}, {"$set": doc}, upsert=True)
        # Return without the embedding for response payload
        doc.pop("embedding", None)
        doc.pop("_id", None)
        return doc

    @router.put("/cases/{case_id}")
    async def update_case(case_id: str, body: LearnReq, user=Depends(get_user)):
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        existing = await db.brain_cases.find_one({"id": case_id, "shop_id": shop_id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, "Case not found")
        merged = {
            **existing,
            "vehicle": (body.vehicle.dict() if body.vehicle else existing.get("vehicle") or {}),
            "symptom": body.symptom,
            "dtc_codes": body.dtc_codes or [],
            "root_cause": body.root_cause,
            "repair_summary": body.repair_summary,
            "parts": body.parts or [],
            "technician_name": body.technician_name or existing.get("technician_name", ""),
            "technician_id": body.technician_id or existing.get("technician_id", ""),
            "outcome": body.outcome,
            "labor_hours": body.labor_hours if body.labor_hours is not None else existing.get("labor_hours"),
            "confidence_note": body.confidence_note or existing.get("confidence_note", ""),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        merged["embedding"] = await embed_text(case_text_blob(merged))
        await db.brain_cases.update_one({"id": case_id, "shop_id": shop_id}, {"$set": merged})
        merged.pop("embedding", None)
        merged.pop("_id", None)
        return merged

    @router.delete("/cases/{case_id}")
    async def delete_case(case_id: str, user=Depends(get_user)):
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        r = await db.brain_cases.delete_one({"id": case_id, "shop_id": shop_id})
        return {"deleted": r.deleted_count > 0}

    class CloseToCaseReq(BaseModel):
        outcome: Literal["FIXED", "PARTIAL", "NOT_FIXED"] = "FIXED"
        root_cause: Optional[str] = ""
        repair_summary: Optional[str] = ""
        parts: Optional[List[str]] = []
        close_session: bool = True  # Also flip the chat session to status=closed

    @router.post("/cases/from-chat/{session_id}")
    async def case_from_chat(session_id: str, body: Optional[CloseToCaseReq] = None, user=Depends(get_user)):
        """Convert a chat session into a brain case (used when Doc hits CLOSE on a job).
        Body is optional — if omitted, a draft case is created (legacy behavior).
        If body.close_session is true, the chat session is also moved to status='closed'."""
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        body = body or CloseToCaseReq()
        msgs = await db.chat_messages.find({"session_id": session_id, "user_id": user["id"]}, {"_id": 0}).sort("created_at", 1).to_list(100)
        if not msgs:
            raise HTTPException(404, "Chat session not found")
        sess = await db.chat_sessions.find_one({"id": session_id, "user_id": user["id"]}, {"_id": 0}) or {}
        # Pull the first user message as the symptom (rough heuristic)
        user_msgs = [m for m in msgs if m.get("role") == "user"]
        symptom = (user_msgs[0]["content"] if user_msgs else (sess.get("preview") or "(no symptom captured)"))
        # Concat the assistant's last reply as the proposed root cause / repair starting point
        asst_msgs = [m for m in msgs if m.get("role") == "assistant"]
        last_reply = asst_msgs[-1]["content"] if asst_msgs else ""
        # Pull the linked vehicle (if Doc tagged it on the session)
        vehicle = {}
        if sess.get("vehicle_id"):
            v = await db.vehicles.find_one({"id": sess["vehicle_id"], "user_id": user["id"]}, {"_id": 0}) or {}
            if v:
                vehicle = {
                    "year": str(v.get("year") or ""),
                    "make": v.get("make") or "",
                    "model": v.get("model") or "",
                    "engine": v.get("engine_summary") or v.get("engine") or "",
                    "vin": v.get("vin") or "",
                }
        # Build the case
        case_id = str(uuid.uuid4())
        doc = {
            "id": case_id,
            "shop_id": shop_id,
            "vehicle": vehicle,
            "symptom": symptom[:1000],
            "dtc_codes": [],
            "root_cause": (body.root_cause or "")[:2000],
            "repair_summary": (body.repair_summary or "")[:4000],
            "parts": body.parts or [],
            "technician_name": user.get("name", ""),
            "technician_id": user.get("id", ""),
            "outcome": body.outcome,
            "labor_hours": None,
            "photos_base64": [],
            "confidence_note": f"Closed from chat session {session_id[:8]} (\"{sess.get('title') or 'untitled'}\"). Wrench's last reply:\n\n{last_reply[:800]}",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": "chat_close",
            "linked_chat_session_id": session_id,
            "created_by_user_id": user.get("id"),
        }
        doc["embedding"] = await embed_text(case_text_blob(doc))
        await db.brain_cases.insert_one(doc)
        # Also write a lightweight outcome event so the partner can poll
        # /api/brain/recent-outcomes and learn from closed jobs (downweight bad
        # matches, surface fresh repair patterns, etc.) without us needing to
        # know their webhook URL.
        await db.brain_outcome_events.insert_one({
            "id": str(uuid.uuid4()),
            "shop_id": shop_id,
            "case_id_in_brain": case_id,
            "linked_chat_session_id": session_id,
            "outcome": body.outcome,
            "symptom_preview": (symptom or "")[:200],
            "vehicle_summary": vehicle_summary(vehicle),
            "technician_id": user.get("id", ""),
            "created_at": doc["created_at"],
        })
        # Flip the chat session to closed and link the case
        if body.close_session:
            await db.chat_sessions.update_one(
                {"id": session_id, "user_id": user["id"]},
                {"$set": {"status": "closed", "closed_at": doc["created_at"],
                          "linked_brain_case_id": case_id, "close_outcome": body.outcome}},
            )
        doc.pop("embedding", None)
        doc.pop("_id", None)
        return doc

    @router.post("/cases/search")
    async def cases_search_for_voice(body: Dict[str, Any], user=Depends(get_user)):
        """Wrench's voice tool uses this — same as /brain/ask but scoped to user's shop, no bearer token needed."""
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        symptom = body.get("symptom") or ""
        vehicle = body.get("vehicle") or {
            "year": body.get("year",""), "make": body.get("make",""),
            "model": body.get("model",""), "engine": body.get("engine",""),
        }
        dtc = body.get("dtc_codes") or []
        query_text = "\n".join([
            f"{vehicle.get('year','')} {vehicle.get('make','')} {vehicle.get('model','')} {vehicle.get('engine','')}".strip(),
            f"SYMPTOM: {symptom}",
            f"DTC: {', '.join(dtc)}",
        ])
        q_emb = await embed_text(query_text)
        all_cases = await db.brain_cases.find({"shop_id": shop_id}, {"_id": 0}).to_list(20000)
        scored = [(cosine(q_emb, c.get("embedding") or []), c) for c in all_cases if c.get("embedding")]
        scored.sort(key=lambda x: x[0], reverse=True)
        k = max(1, min(5, body.get("k", 3)))
        matches = [case_doc_to_match(c, s) for s, c in scored[:k] if s > 0.2]
        conf = "empty" if not matches else "high" if matches[0].similarity >= 0.78 else "medium" if matches[0].similarity >= 0.55 else "low"
        return {"matches": [m.model_dump() for m in matches], "confidence": conf, "total_cases_in_brain": len(all_cases)}

    @router.post("/brain/learn-bulk")
    async def brain_learn_bulk(body: Dict[str, Any], _t: str = Depends(get_brain_token)):
        """Bulk-ingest. items[] entries are either {raw_text: '...'} (parsed via GPT) or structured case dicts."""
        shop_id = body.get("shop_id") or DEFAULT_SHOP_ID
        items = body.get("items") or []
        return await _bulk_ingest(db, shop_id, items, user_name="", user_id="brain_api")

    @router.post("/cases/learn-bulk")
    async def cases_learn_bulk(body: Dict[str, Any], user=Depends(get_user)):
        """Same as /brain/learn-bulk, but scoped to logged-in user's shop. For Doc's UI."""
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        items = body.get("items") or []
        return await _bulk_ingest(db, shop_id, items, user_name=user.get("name",""), user_id=user.get("id",""))

    @router.post("/cases/learn-pdf")
    async def cases_learn_pdf(file: UploadFile = File(...), user=Depends(get_user)):
        """Drop an AutoLeap (or any) PDF full of repair orders. We extract text page-by-page,
        chunk it, feed each chunk through GPT-5.2 to pull structured cases, and embed them.
        If the PDF is a scan / image-only (no text layer), we fall back to GPT-5.2 Vision
        to OCR each page as an image. Returns the same shape as /cases/learn-bulk."""
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        raw = await file.read()
        if not raw:
            raise HTTPException(400, "Empty file.")
        if len(raw) > 25 * 1024 * 1024:
            raise HTTPException(413, "PDF too big (25MB max). Split it.")
        # ---- 1) Try text-layer extraction first (fast, no AI cost) ----
        ocr_used = False
        ocr_pages = 0
        try:
            import pypdf
            reader = pypdf.PdfReader(io.BytesIO(raw))
            pages = []
            for p in reader.pages:
                try:
                    t = p.extract_text() or ""
                except Exception:
                    t = ""
                if t.strip():
                    pages.append(t)
            total_text = sum(len(p) for p in pages)
        except Exception as e:
            log.warning(f"pypdf failed on {file.filename}: {e}")
            pages = []
            total_text = 0
        # ---- 2) If text layer is thin (scanned PDF), OCR via GPT-5.2 Vision ----
        OCR_TRIGGER_CHARS = 200
        if total_text < OCR_TRIGGER_CHARS:
            log.info(f"PDF '{file.filename}' has only {total_text} chars of text — falling back to Vision OCR.")
            try:
                import fitz  # PyMuPDF
            except ImportError as e:
                raise HTTPException(500, f"PDF appears scanned (no text). Vision OCR library not installed: {e}")
            if not OPENAI_API_KEY:
                raise HTTPException(503, "PDF is a scan and needs Vision OCR. OPENAI_API_KEY not configured.")
            try:
                pdfdoc = fitz.open(stream=raw, filetype="pdf")
            except Exception as e:
                raise HTTPException(400, f"Couldn't open the PDF: {e}")
            ocr_pages = min(len(pdfdoc), 20)  # cap at 20 pages per call
            page_texts = []
            for i in range(ocr_pages):
                page = pdfdoc[i]
                pix = page.get_pixmap(dpi=180)  # 180 DPI is plenty for OCR
                png_bytes = pix.tobytes("png")
                b64 = base64.b64encode(png_bytes).decode()
                # Call GPT-5.2 Vision via OpenAI Chat Completions
                async with httpx.AsyncClient(timeout=90) as c:
                    r = await c.post(
                        "https://api.openai.com/v1/chat/completions",
                        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                        json={
                            "model": "gpt-5.2",
                            "messages": [{
                                "role": "user",
                                "content": [
                                    {"type": "text", "text": "Transcribe ALL text from this repair-order PDF page exactly as it appears. Preserve vehicle info, VIN, symptom/concern, diagnosis/repair, parts list (Qty + part # + description), labor, technician, totals. Output plain text only — no commentary, no markdown."},
                                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}
                                ]
                            }],
                            "max_completion_tokens": 4000,
                        },
                    )
                if r.status_code != 200:
                    log.warning(f"OCR page {i+1} failed: {r.status_code} {r.text[:300]}")
                    continue
                jr = r.json()
                page_text = jr.get("choices", [{}])[0].get("message", {}).get("content", "")
                if page_text.strip():
                    page_texts.append(page_text)
            pdfdoc.close()
            pages = page_texts
            total_text = sum(len(p) for p in pages)
            ocr_used = True
        if not pages or total_text < 50:
            raise HTTPException(400, "PDF had no extractable text, even after OCR. Try a clearer scan or paste the RO as text.")
        # ---- 3) Chunk: send pages combined unless they're huge ----
        # AutoLeap ROs often span 2-4 pages — combine until ~12000 chars.
        items = []
        buf = ""
        for pg in pages:
            if len(buf) + len(pg) > 12000 and buf:
                items.append({"raw_text": buf})
                buf = pg
            else:
                buf = (buf + "\n\n" + pg).strip() if buf else pg
        if buf:
            items.append({"raw_text": buf})
        items = items[:50]
        # ---- 4) Feed to GPT-5.2 extractor ----
        result = await _bulk_ingest(db, shop_id, items, user_name=user.get("name",""), user_id=user.get("id",""))
        result["source_filename"] = file.filename
        result["pdf_pages"] = len(pages)
        result["chunks_sent_to_gpt"] = len(items)
        result["ocr_used"] = ocr_used
        result["ocr_pages"] = ocr_pages
        result["total_extracted_chars"] = total_text
        if ocr_used:
            result["note"] = f"PDF was scanned (no text layer) — used Vision OCR on {ocr_pages} page(s)."
        # If GPT couldn't extract ANY cases, include a preview of what we sent so Doc sees what went in
        if result.get("ingested", 0) == 0 and items:
            result["extracted_text_preview"] = (items[0]["raw_text"][:600] if items else "") + ("..." if items and len(items[0]["raw_text"]) > 600 else "")
        return result

    # ===================== PUBLIC SHOP LANDING (no auth) =====================
    @router.get("/public/shop/{shop_id}")
    async def public_shop(shop_id: str):
        """Public shop info — drives the marketing landing page at /shop/{shop_id}.
        No auth, scoped to one shop. Safe fields only (no internal stats)."""
        profile = await db.shop_profiles.find_one({"shop_id": shop_id}, {"_id": 0}) or {}
        if not profile:
            raise HTTPException(404, "Shop not found.")
        return {
            "shop_id": shop_id,
            "name": profile.get("name") or "",
            "capabilities": profile.get("capabilities") or [],
            "specialties": profile.get("specialties") or [],
            "service_areas": profile.get("service_areas") or [],
            "hours": profile.get("hours") or "",
            "phone": profile.get("phone") or "",
            "address": profile.get("address") or "",
            "notes": profile.get("notes") or "",
        }

    class PublicLeadReq(BaseModel):
        shop_id: str
        name: str
        contact: str  # phone OR email — they pick one
        vehicle: Optional[str] = ""  # "2017 GMC Sierra 5.3"
        what_they_need: str  # symptom / quote request / question
        source: Optional[str] = "landing"  # "landing" | "qr" | etc.

    @router.post("/public/leads")
    async def public_lead(body: PublicLeadReq, request: Request):
        """Customer fills the contact form on the public landing page. We store the lead,
        no auth. Naive rate limit: 5/min per IP per shop."""
        ip = request.client.host if request.client else "unknown"
        # Naive rate limit
        one_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        recent = await db.leads.count_documents({"shop_id": body.shop_id, "ip": ip, "created_at": {"$gt": one_min_ago}})
        if recent >= 5:
            raise HTTPException(429, "Slow down — you've sent a bunch of these in the last minute.")
        # Trim
        doc = {
            "id": str(uuid.uuid4()),
            "shop_id": body.shop_id,
            "name": body.name.strip()[:120],
            "contact": body.contact.strip()[:160],
            "vehicle": (body.vehicle or "").strip()[:200],
            "what_they_need": body.what_they_need.strip()[:2000],
            "source": body.source or "landing",
            "ip": ip,
            "status": "new",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        if not doc["name"] or not doc["contact"] or not doc["what_they_need"]:
            raise HTTPException(400, "Name, contact, and what you need are all required.")
        await db.leads.insert_one(doc)
        doc.pop("_id", None)
        return {"ok": True, "lead_id": doc["id"]}

    # ----- Owner-side lead inbox (user-JWT) -----
    @router.get("/leads")
    async def list_leads(user=Depends(get_user)):
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        cur = db.leads.find({"shop_id": sid}, {"_id": 0}).sort("created_at", -1).limit(100)
        return await cur.to_list(100)

    class LeadStatusReq(BaseModel):
        status: Literal["new", "contacted", "won", "lost"] = "new"

    @router.patch("/leads/{lead_id}")
    async def update_lead(lead_id: str, body: LeadStatusReq, user=Depends(get_user)):
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        r = await db.leads.update_one({"id": lead_id, "shop_id": sid}, {"$set": {"status": body.status}})
        if r.matched_count == 0:
            raise HTTPException(404, "Lead not found.")
        return {"ok": True, "status": body.status}

    return router


async def _bulk_ingest(db, shop_id: str, items: List[Dict[str, Any]], user_name: str, user_id: str) -> Dict[str, Any]:
    if not items:
        raise HTTPException(400, "items[] is empty")
    if len(items) > 50:
        raise HTTPException(413, "Max 50 items per bulk call. Send in batches.")
    results = []
    ingested = 0
    failed = 0
    for it in items:
        try:
            if isinstance(it, dict) and it.get("raw_text"):
                parsed_cases = await extract_cases_from_text(it["raw_text"])
                if not parsed_cases:
                    failed += 1
                    results.append({"ok": False, "error": "Couldn't extract a case from that text.", "raw_preview": it["raw_text"][:120]})
                    continue
                for pc in parsed_cases:
                    case_id = await _persist_case(db, shop_id, pc, user_name, user_id, source="bulk_paste")
                    results.append({"ok": True, "case_id_in_brain": case_id, "parsed_summary": _summary_line(pc), "parsed_case": _safe_case(pc)})
                    ingested += 1
            elif isinstance(it, dict):
                case_id = await _persist_case(db, shop_id, it, user_name, user_id, source="bulk_structured")
                results.append({"ok": True, "case_id_in_brain": case_id, "parsed_summary": _summary_line(it), "parsed_case": _safe_case(it)})
                ingested += 1
            else:
                failed += 1
                results.append({"ok": False, "error": "Item must be an object."})
        except Exception as e:
            failed += 1
            results.append({"ok": False, "error": str(e)})
    total = await db.brain_cases.count_documents({"shop_id": shop_id})
    return {"ingested": ingested, "failed": failed, "total_cases_in_brain": total, "results": results}


def _summary_line(c: Dict[str, Any]) -> str:
    v = c.get("vehicle") or {}
    veh = " ".join(filter(None, [str(v.get("year","")), v.get("make",""), v.get("model","")])) or "unknown vehicle"
    sym = (c.get("symptom") or "").strip()[:60]
    cause = (c.get("root_cause") or "").strip()[:60]
    return f"{veh} / {sym}" + (f" → {cause}" if cause else "")


def _safe_case(c: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "vehicle": c.get("vehicle") or {},
        "symptom": c.get("symptom") or "",
        "dtc_codes": c.get("dtc_codes") or [],
        "root_cause": c.get("root_cause") or "",
        "repair_summary": c.get("repair_summary") or "",
        "parts": c.get("parts") or [],
        "outcome": (c.get("outcome") or "FIXED").upper(),
    }


async def _persist_case(db, shop_id: str, c: Dict[str, Any], user_name: str, user_id: str, source: str) -> str:
    case_id = str(uuid.uuid4())
    doc = {
        "id": case_id,
        "shop_id": shop_id,
        "vehicle": c.get("vehicle") or {},
        "symptom": c.get("symptom") or "",
        "dtc_codes": c.get("dtc_codes") or [],
        "root_cause": c.get("root_cause") or "",
        "repair_summary": c.get("repair_summary") or "",
        "parts": c.get("parts") or [],
        "technician_name": c.get("technician_name") or user_name or "",
        "technician_id": user_id,
        "outcome": (c.get("outcome") or "FIXED").upper(),
        "labor_hours": c.get("labor_hours"),
        "photos_base64": [],
        "confidence_note": c.get("confidence_note") or "",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "created_by_user_id": user_id,
    }
    doc["embedding"] = await embed_text(case_text_blob(doc))
    await db.brain_cases.insert_one(doc)
    return case_id
