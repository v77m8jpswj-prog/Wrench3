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
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, Literal

from fastapi import APIRouter, HTTPException, Depends, Header, UploadFile, File, Form, Query
from pydantic import BaseModel, Field
from motor.motor_asyncio import AsyncIOMotorClient

import httpx

log = logging.getLogger("datawrench.brain")

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
        scored = []
        for c in all_cases:
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
        return StatsResp(
            shop_id=shop_id,
            total_cases=total,
            total_vehicles_seen=len([v for v in vehicles if v]),
            technicians_contributing=len([t for t in techs if t]),
            last_ingest_at=last_at,
            top_makes=top_makes,
            brain_version="0.1.0",
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

    @router.post("/cases/from-chat/{session_id}")
    async def case_from_chat(session_id: str, user=Depends(get_user)):
        """Convert a chat session into a draft case (Doc fills in root cause + repair after)."""
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
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
        # Try to find the linked vehicle in chat_sessions
        vehicle = {}
        # Build draft case
        case_id = str(uuid.uuid4())
        doc = {
            "id": case_id,
            "shop_id": shop_id,
            "vehicle": vehicle,
            "symptom": symptom[:1000],
            "dtc_codes": [],
            "root_cause": "",
            "repair_summary": "",
            "parts": [],
            "technician_name": user.get("name", ""),
            "technician_id": user.get("id", ""),
            "outcome": "FIXED",
            "labor_hours": None,
            "photos_base64": [],
            "confidence_note": f"Drafted from chat session {session_id[:8]}. Wrench's last reply:\n\n{last_reply[:800]}",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": "chat_draft",
            "linked_chat_session_id": session_id,
            "created_by_user_id": user.get("id"),
        }
        doc["embedding"] = await embed_text(case_text_blob(doc))
        await db.brain_cases.insert_one(doc)
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

    return router
