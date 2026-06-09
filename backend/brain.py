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

from fastapi import APIRouter, HTTPException, Depends, Header, UploadFile, File, Form, Query, Request, Response
from pydantic import BaseModel, Field
from motor.motor_asyncio import AsyncIOMotorClient

import asyncio
import html as _html

import httpx

from email_mod import notify_shop
from twilio_mod import notify_owner as twilio_notify_owner, send_sms as twilio_send_sms

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
    presented = authorization[7:].strip()
    if presented == BRAIN_TOKEN:
        return BRAIN_TOKEN
    # Also accept any peer-scoped brain token (revocable per-agent tokens)
    # stored in env as BRAIN_PEER_TOKENS=peer1:abc,peer2:def
    # OR as individual envs BRAIN_PEER_TOKEN_<NAME>=<value> (preferred for secrets)
    peer_tokens_blob = os.environ.get("BRAIN_PEER_TOKENS", "")
    if peer_tokens_blob:
        for pair in peer_tokens_blob.split(","):
            if ":" in pair:
                _, tok = pair.split(":", 1)
                if presented == tok.strip():
                    return presented
    for env_key, env_val in os.environ.items():
        if env_key.startswith("BRAIN_PEER_TOKEN_") and env_val and presented == env_val.strip():
            return presented
    raise HTTPException(401, "Invalid brain bearer token")


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

    # ----- Cross-env sync (Preview → Prod) for memory_facts + library -----
    async def _resolve_owner_id(sid: str) -> str:
        owner = await db.users.find_one({"shop_id": sid, "role": "owner"}, {"_id": 0, "id": 1}) \
                or await db.users.find_one({"role": "owner"}, {"_id": 0, "id": 1})
        if not owner:
            raise HTTPException(404, f"No owner user found for shop_id={sid}")
        return owner["id"]

    @router.post("/brain/sync-facts")
    async def sync_facts(body: Dict[str, Any], _t: str = Depends(get_brain_token)):
        """Bearer-protected upsert of memory_facts + candidate_facts for a shop's owner.
        Idempotent: dedupes by normalized fact text within a user. Used by the
        Preview→Prod migration script. Body:
          { shop_id: str,
            memory_facts: [{fact: str, created_at?: str}, ...],
            candidate_facts: [{fact: str, category?: str, confidence?: float,
                              seen_count?: int, status?: str, created_at?: str}, ...] }
        """
        sid = (body.get("shop_id") or DEFAULT_SHOP_ID).strip()
        owner_id = await _resolve_owner_id(sid)

        # Build set of existing normalized facts so we don't dupe
        existing_mem = {((m.get("fact") or "").strip().lower())
                       async for m in db.memory_facts.find({"user_id": owner_id}, {"_id": 0, "fact": 1})}
        existing_cand = {((c.get("norm") or (c.get("fact") or "").strip().lower()))
                        async for c in db.candidate_facts.find({"user_id": owner_id}, {"_id": 0, "fact": 1, "norm": 1})}

        mf_inserted = 0
        mf_skipped = 0
        for item in (body.get("memory_facts") or []):
            fact = (item.get("fact") or "").strip()
            if not fact:
                continue
            norm = fact.lower()
            if norm in existing_mem:
                mf_skipped += 1
                continue
            await db.memory_facts.insert_one({
                "id": item.get("id") or str(uuid.uuid4()),
                "user_id": owner_id,
                "fact": fact,
                "created_at": item.get("created_at") or datetime.now(timezone.utc).isoformat(),
                "source": "sync",
                "is_locked": fact.startswith("[LOCKED]"),
            })
            existing_mem.add(norm)
            mf_inserted += 1

        cf_inserted = 0
        cf_skipped = 0
        for item in (body.get("candidate_facts") or []):
            fact = (item.get("fact") or "").strip()
            if not fact:
                continue
            norm = (item.get("norm") or fact.lower()).strip()
            if norm in existing_cand or norm in existing_mem:
                cf_skipped += 1
                continue
            await db.candidate_facts.insert_one({
                "id": item.get("id") or str(uuid.uuid4()),
                "user_id": owner_id,
                "fact": fact,
                "norm": norm,
                "category": item.get("category") or "general",
                "confidence": float(item.get("confidence") or 0.7),
                "seen_count": int(item.get("seen_count") or 1),
                "status": item.get("status") or "pending",
                "sources": item.get("sources") or [],
                "created_at": item.get("created_at") or datetime.now(timezone.utc).isoformat(),
            })
            existing_cand.add(norm)
            cf_inserted += 1

        mem_total = await db.memory_facts.count_documents({"user_id": owner_id})
        cand_total = await db.candidate_facts.count_documents({"user_id": owner_id})
        return {
            "ok": True,
            "owner_id": owner_id,
            "memory_facts": {"inserted": mf_inserted, "skipped_duplicate": mf_skipped, "total_now": mem_total},
            "candidate_facts": {"inserted": cf_inserted, "skipped_duplicate": cf_skipped, "total_now": cand_total},
        }

    @router.post("/brain/sync-library")
    async def sync_library(body: Dict[str, Any], _t: str = Depends(get_brain_token)):
        """Bearer-protected upsert of library_items + library_chunks for a shop's
        owner. Idempotent on item.id (skip if it already exists). Body:
          { shop_id: str,
            items: [{id, name, kind, size, status, chunk_count, created_at,
                     chunks: [{id, item_id, source, text, created_at}, ...]}, ...] }
        Chunks are inserted alongside their item. Embeddings not required —
        library retrieval is keyword-scored, not vector-scored.
        """
        sid = (body.get("shop_id") or DEFAULT_SHOP_ID).strip()
        owner_id = await _resolve_owner_id(sid)

        existing_items = {x["id"]
                         async for x in db.library_items.find({"user_id": owner_id}, {"_id": 0, "id": 1})}

        items_inserted = 0
        items_skipped = 0
        chunks_inserted = 0
        for it in (body.get("items") or []):
            item_id = it.get("id") or str(uuid.uuid4())
            if item_id in existing_items:
                items_skipped += 1
                continue
            await db.library_items.insert_one({
                "id": item_id,
                "user_id": owner_id,
                "name": it.get("name") or "synced-item",
                "kind": it.get("kind") or "txt",
                "size": int(it.get("size") or 0),
                "status": it.get("status") or "ready",
                "chunk_count": int(it.get("chunk_count") or 0),
                "source_tier": it.get("source_tier"),
                "source_label": it.get("source_label"),
                "created_at": it.get("created_at") or datetime.now(timezone.utc).isoformat(),
                "source": "sync",
            })
            items_inserted += 1
            existing_items.add(item_id)

            for ch in (it.get("chunks") or []):
                txt = (ch.get("text") or "").strip()
                if not txt:
                    continue
                await db.library_chunks.insert_one({
                    "id": ch.get("id") or str(uuid.uuid4()),
                    "user_id": owner_id,
                    "item_id": item_id,
                    "source": ch.get("source") or it.get("name") or "synced",
                    "text": txt,
                    "created_at": ch.get("created_at") or datetime.now(timezone.utc).isoformat(),
                })
                chunks_inserted += 1

        item_total = await db.library_items.count_documents({"user_id": owner_id})
        chunk_total = await db.library_chunks.count_documents({"user_id": owner_id})
        return {
            "ok": True,
            "owner_id": owner_id,
            "items": {"inserted": items_inserted, "skipped_duplicate": items_skipped, "total_now": item_total},
            "chunks": {"inserted": chunks_inserted, "total_now": chunk_total},
        }

    # ----- Bud-driven customer SMS (draft -> confirm -> send) -----
    _SMS_DRAFT_TTL_MIN = 15  # drafts expire after 15 min un-sent

    def _normalize_e164(num: str) -> str:
        n = (num or "").strip().replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
        if not n.startswith("+"):
            raise HTTPException(400, f"to_phone must be E.164 with leading +, got {num!r}")
        if len(n) < 8 or len(n) > 16:
            raise HTTPException(400, f"to_phone length invalid: {num!r}")
        return n

    def _sms_segments(body: str) -> int:
        # Single-segment SMS: 160 GSM-7 chars / 70 UCS-2 chars.
        # Multi-part: 153 / 67. Approximate (no encoding sniffing).
        n = len(body)
        if n <= 160:
            return 1
        return (n + 152) // 153

    _SMS_DRAFT_SYSTEM = (
        "You are Wrench, the shop voice for Dr. Underhood Automotive Specialist (Fort Smith, AR). "
        "You are drafting a customer SMS on behalf of Doc (the owner). Compose ONE message body — "
        "no preamble, no quotes, no markdown — that Doc will text to a customer. Rules:\n"
        "  - Stay short: 160 chars target, hard cap 320 chars (2 SMS segments).\n"
        "  - Professional but warm. Use 'we' / 'your truck' / 'your car'. Plain English.\n"
        "  - Sign off with: -Dr. Underhood Automotive (only if room).\n"
        "  - Never use emoji.\n"
        "  - Never use markdown bolding (**), exclamation overload, or ALL CAPS shouting.\n"
        "  - If Doc's intent is unclear, write the safest minimum-info message.\n"
        "  - Do not invent prices, times, or part names not in Doc's intent.\n"
        "  - If 'Prior SMS Doc has sent to THIS customer' samples are provided in the prompt, "
        "MATCH that voice — terse if those were terse, warmer if those were warm. The samples "
        "are Doc's actual past texts to this exact number, they are the source of truth on tone.\n"
        "  - Reply with the message body ONLY. No 'Here is the draft:' wrapper."
    )

    @router.post("/brain/sms-draft")
    async def sms_draft(body: Dict[str, Any], _t: str = Depends(get_brain_token)):
        """Bud calls this to have Wrench compose a customer SMS. Returns a
        draft (not sent) and a draft_id. Bud reads it back to Doc, who says
        'SEND IT' or 'FIX IT'. Then Bud calls /brain/sms-send.

        Body:
          { shop_id: str,
            to_phone: '+1...',
            intent: 'tell the camry lady her car is ready, pickup any time',
            customer_hint?: 'Mrs. Jenkins, 2018 Camry, brakes',
            tone?: 'friendly' | 'urgent' | 'apologetic' | 'professional' }
        """
        sid = (body.get("shop_id") or DEFAULT_SHOP_ID).strip()
        to_phone = _normalize_e164(body.get("to_phone") or "")
        intent = (body.get("intent") or "").strip()
        if not intent:
            raise HTTPException(400, "intent required (what should the SMS say?)")
        if len(intent) > 600:
            raise HTTPException(400, "intent too long (max 600 chars)")
        customer_hint = (body.get("customer_hint") or "").strip()[:200]
        tone = (body.get("tone") or "professional").strip().lower()
        if tone not in ("friendly", "urgent", "apologetic", "professional"):
            tone = "professional"

        sp = await db.shop_profiles.find_one({"shop_id": sid}, {"_id": 0}) or {}
        shop_name = sp.get("name") or "Dr. Underhood Automotive"

        # Tone-match: pull the last 3 outbound SMS Doc has sent to this number
        # (voice samples) AND the last 2 inbound SMS the customer has sent us
        # (question/context Wrench should respond to). Both filter to ok=true to
        # avoid polluting with failed sends.
        prior_out_cur = db.sms_messages.find(
            {"direction": "outbound", "to_number": to_phone, "ok": True},
            {"_id": 0, "body": 1, "created_at": 1},
        ).sort("created_at", -1).limit(3)
        prior_out = await prior_out_cur.to_list(3)

        prior_in_cur = db.sms_messages.find(
            {"direction": "inbound", "from_number": to_phone},
            {"_id": 0, "body": 1, "created_at": 1},
        ).sort("created_at", -1).limit(2)
        prior_in = await prior_in_cur.to_list(2)

        prior_block = ""
        if prior_out:
            samples = list(reversed(prior_out))
            lines = []
            for i, p in enumerate(samples, 1):
                body_sample = (p.get("body") or "").strip()
                if body_sample:
                    lines.append(f"  [prior #{i}, {p.get('created_at','')[:10]}] {body_sample}")
            if lines:
                prior_block += (
                    "\nPrior SMS Doc has sent to THIS customer (match his voice/length to them):\n"
                    + "\n".join(lines) + "\n"
                )

        if prior_in:
            samples_in = list(reversed(prior_in))
            lines_in = []
            for i, p in enumerate(samples_in, 1):
                body_sample = (p.get("body") or "").strip()
                if body_sample:
                    lines_in.append(f"  [customer wrote, {p.get('created_at','')[:10]}] {body_sample}")
            if lines_in:
                prior_block += (
                    "\nRecent inbound SMS from this customer (your draft should answer "
                    "or acknowledge what they said, if relevant to Doc's intent):\n"
                    + "\n".join(lines_in) + "\n"
                )

        prompt = (
            f"Shop: {shop_name}\n"
            f"Tone target: {tone}\n"
            f"Customer context (may be empty): {customer_hint or '(none provided)'}\n"
            f"{prior_block}"
            f"Doc's intent (what he wants the customer to know):\n  {intent}\n\n"
            f"Write the customer-facing SMS body now (text only, no quotes)."
        )

        try:
            from emergentintegrations.llm.chat import LlmChat, UserMessage
            chat = LlmChat(
                api_key=EMERGENT_LLM_KEY,
                session_id=f"sms-draft-{uuid.uuid4().hex[:8]}",
                system_message=_SMS_DRAFT_SYSTEM,
            ).with_model("anthropic", "claude-sonnet-4-5-20250929")
            draft_text = await chat.send_message(UserMessage(text=prompt))
            draft_text = (draft_text or "").strip().strip('"').strip("'")
        except Exception as e:
            log.warning(f"sms-draft LLM call failed: {e}")
            raise HTTPException(502, f"SMS draft generation failed: {e}")

        if not draft_text:
            raise HTTPException(502, "LLM returned empty SMS draft")
        # Hard safety: never send a draft over 320 chars without truncating
        if len(draft_text) > 320:
            draft_text = draft_text[:317].rstrip() + "..."

        draft_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        expires = now + timedelta(minutes=_SMS_DRAFT_TTL_MIN)
        await db.sms_drafts.insert_one({
            "id": draft_id,
            "shop_id": sid,
            "to_phone": to_phone,
            "intent": intent,
            "customer_hint": customer_hint,
            "tone": tone,
            "body": draft_text,
            "status": "pending",
            "created_at": now.isoformat(),
            "expires_at": expires.isoformat(),
            "drafted_by": "bud-via-wrench",
        })
        return {
            "draft_id": draft_id,
            "to_phone": to_phone,
            "body": draft_text,
            "character_count": len(draft_text),
            "segment_count": _sms_segments(draft_text),
            "expires_at": expires.isoformat(),
            "shop_name": shop_name,
            "tone_matched": bool(prior_out),
            "prior_sample_count": len(prior_out),
            "inbound_context_used": bool(prior_in),
            "inbound_sample_count": len(prior_in),
        }

    @router.post("/brain/sms-send")
    async def sms_send_confirmed(body: Dict[str, Any], _t: str = Depends(get_brain_token)):
        """Fire a previously-drafted SMS once Doc has confirmed. Body:
          { draft_id: str,
            confirmed: true,                 # required, must be exactly true
            override_body?: str }            # if Doc said 'send this instead'
        Returns Twilio send result. Marks draft as 'sent' (idempotent — re-call
        with same draft_id returns the original send record without re-firing)."""
        draft_id = (body.get("draft_id") or "").strip()
        if not draft_id:
            raise HTTPException(400, "draft_id required")
        if body.get("confirmed") is not True:
            raise HTTPException(400, "confirmed must be exactly true (Doc must approve the draft)")

        d = await db.sms_drafts.find_one({"id": draft_id}, {"_id": 0})
        if not d:
            raise HTTPException(404, f"draft not found: {draft_id}")

        # Idempotency: re-call returns the original result
        if d.get("status") == "sent":
            return {
                "ok": True,
                "already_sent": True,
                "draft_id": draft_id,
                "twilio_ok": d.get("twilio_ok"),
                "sent_at": d.get("sent_at"),
                "to_phone": d.get("to_phone"),
                "body": d.get("body"),
            }
        if d.get("status") in ("expired", "cancelled"):
            raise HTTPException(409, f"draft is {d.get('status')} — re-draft via /brain/sms-draft")

        # Expiry check
        try:
            exp = datetime.fromisoformat(d.get("expires_at"))
            if datetime.now(timezone.utc) > exp:
                await db.sms_drafts.update_one({"id": draft_id}, {"$set": {"status": "expired"}})
                raise HTTPException(409, "draft expired — re-draft via /brain/sms-draft")
        except HTTPException:
            raise
        except Exception:
            pass  # malformed expires_at, allow send

        override = (body.get("override_body") or "").strip()
        final_body = override if override else d["body"]
        if len(final_body) > 1600:
            raise HTTPException(400, "final SMS body too long (max 1600 chars)")

        to = d["to_phone"]
        ok = await twilio_send_sms(to, final_body)
        now = datetime.now(timezone.utc).isoformat()

        await db.sms_drafts.update_one(
            {"id": draft_id},
            {"$set": {
                "status": "sent" if ok else "send_failed",
                "final_body": final_body,
                "was_overridden": bool(override),
                "twilio_ok": bool(ok),
                "sent_at": now,
            }},
        )

        # Mirror into sms_messages so it shows in Doc's SMS log alongside everything else
        if ok:
            try:
                await db.sms_messages.insert_one({
                    "id": str(uuid.uuid4()),
                    "direction": "outbound",
                    "from_number": os.environ.get("TWILIO_FROM_NUMBER", ""),
                    "to_number": to,
                    "body": final_body,
                    "created_at": now,
                    "read": True,
                    "ok": True,
                    "source": "bud-via-wrench",
                    "draft_id": draft_id,
                })
            except Exception as e:
                log.warning(f"sms_messages mirror insert failed: {e}")

        return {
            "ok": ok,
            "draft_id": draft_id,
            "to_phone": to,
            "body": final_body,
            "was_overridden": bool(override),
            "sent_at": now if ok else None,
            "twilio_ok": bool(ok),
            "note": None if ok else "Twilio send returned False — check sms logs / TFV status",
        }

    @router.post("/brain/sms-cancel")
    async def sms_cancel(body: Dict[str, Any], _t: str = Depends(get_brain_token)):
        """Cancel a pending draft (Doc said 'FIX IT' or 'DROP IT'). Body: { draft_id }."""
        draft_id = (body.get("draft_id") or "").strip()
        if not draft_id:
            raise HTTPException(400, "draft_id required")
        r = await db.sms_drafts.update_one(
            {"id": draft_id, "status": "pending"},
            {"$set": {"status": "cancelled", "cancelled_at": datetime.now(timezone.utc).isoformat()}},
        )
        if r.matched_count == 0:
            d = await db.sms_drafts.find_one({"id": draft_id}, {"_id": 0, "status": 1})
            if not d:
                raise HTTPException(404, f"draft not found: {draft_id}")
            return {"ok": False, "draft_id": draft_id, "current_status": d.get("status")}
        return {"ok": True, "draft_id": draft_id, "current_status": "cancelled"}

    # ----- Morning briefing (Bud pushes Doc's 7am digest into the shared brain) -----
    @router.post("/brain/morning-briefing")
    async def post_morning_briefing(body: Dict[str, Any], _t: str = Depends(get_brain_token)):
        """Receive a structured morning briefing from a peer agent (e.g. Bud).
        Stored keyed by date+shop_id so chat-side retrieval can answer
        'what is on the board today' without Doc repeating himself.

        Expected body:
          { shop_id, date: 'YYYY-MM-DD', source_agent: 'bud',
            sections: { inbox_top:[], ro_board:[], shop_status:[], flags:[] },
            summary?: '<one-paragraph plain-text recap>' }
        """
        shop_id = (body.get("shop_id") or DEFAULT_SHOP_ID).strip()
        date = (body.get("date") or "").strip() or datetime.now(timezone.utc).date().isoformat()
        source_agent = (body.get("source_agent") or "unknown").lower().strip()[:40]
        sections = body.get("sections") or {}
        if not isinstance(sections, dict):
            raise HTTPException(400, "sections must be an object")
        summary = (body.get("summary") or "")[:8000]
        doc = {
            "id": f"{shop_id}::{date}::{source_agent}",
            "shop_id": shop_id,
            "date": date,
            "source_agent": source_agent,
            "sections": sections,
            "summary": summary,
            "received_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.morning_briefings.update_one(
            {"id": doc["id"]}, {"$set": doc}, upsert=True,
        )
        return {"ok": True, "id": doc["id"], "received_at": doc["received_at"]}

    @router.get("/brain/morning-briefing")
    async def get_morning_briefing(
        shop_id: str = Query(...),
        date: Optional[str] = Query(None),
        _t: str = Depends(get_brain_token),
    ):
        """Read the most recent briefing for shop+date. If date omitted, returns the latest."""
        q: Dict[str, Any] = {"shop_id": shop_id}
        if date:
            q["date"] = date
        doc = await db.morning_briefings.find_one(q, {"_id": 0}, sort=[("date", -1), ("received_at", -1)])
        if not doc:
            raise HTTPException(404, "No briefing found")
        return doc

    @router.get("/brain/operator-profile")
    async def operator_profile(
        shop_id: str = Query(...),
        since_days: int = Query(7, ge=1, le=365, description="Window for chat + voice transcripts. Default 7 days, no count cap."),
        cases_limit: int = Query(20, ge=0, le=200),
        max_messages: int = Query(5000, ge=100, le=20000, description="Hard safety ceiling per message stream to prevent OOM."),
        _t: str = Depends(get_brain_token),
    ):
        """One-shot operator profile for peer agents (Bud, OG, etc.) to learn who
        Doc is and how he talks. Returns:
          - shop_profile: name, address, hours, capabilities, specialties
          - locked_memory_facts: explicit personality / preference rules
          - candidate_facts: pending facts (lower confidence, may shift)
          - recent_chat_turns: ALL chat exchanges within `since_days` (default 7d, no cap)
          - voice_turn_highlights: ALL voice turns within `since_days`
          - recent_cases: N most recent brain cases (shop work history)
          - operator_style: a concise text block summarizing tone, language, dont's
        Heavyweight payload — call once on peer init, then poll lighter
        endpoints for deltas. Safe for cross-agent sharing under bearer token.
        """
        sp = await db.shop_profiles.find_one({"shop_id": shop_id}, {"_id": 0}) or {}

        # Find Doc's user_id from the shop owner
        owner = await db.users.find_one({"shop_id": shop_id, "role": "owner"}, {"_id": 0}) \
                or await db.users.find_one({"role": "owner"}, {"_id": 0}) \
                or {}
        owner_id = owner.get("id", "")

        locked_facts: List[str] = []
        candidate_facts: List[Dict[str, Any]] = []
        if owner_id:
            mem_cur = db.memory_facts.find({"user_id": owner_id}, {"_id": 0}).sort("created_at", -1).limit(200)
            for m in await mem_cur.to_list(200):
                fact = (m.get("fact") or "").strip()
                if fact:
                    locked_facts.append(fact)
            cand_cur = db.candidate_facts.find(
                {"user_id": owner_id, "status": "pending"},
                {"_id": 0, "fact": 1, "category": 1, "confidence": 1, "seen_count": 1},
            ).sort("confidence", -1).limit(60)
            candidate_facts = await cand_cur.to_list(60)

        # Time window — created_at is stored as ISO string, so string compare works
        cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()

        # Recent chat — ALL messages within window (no count cap, only safety ceiling)
        chat_turns: List[Dict[str, Any]] = []
        if owner_id:
            chat_cur = db.chat_messages.find(
                {"user_id": owner_id,
                 "role": {"$in": ["user", "assistant"]},
                 "created_at": {"$gte": cutoff}},
                {"_id": 0, "role": 1, "content": 1, "session_id": 1, "created_at": 1},
            ).sort("created_at", 1).limit(max_messages)
            chat_turns = await chat_cur.to_list(max_messages)
            # Truncate excessively long content (some have full RAG context)
            for t in chat_turns:
                if t.get("content") and len(t["content"]) > 2500:
                    t["content"] = t["content"][:2500] + " …[truncated]"

        # Voice turns — ALL within window
        voice_turns: List[Dict[str, Any]] = []
        if owner_id:
            v_cur = db.voice_turns.find(
                {"user_id": owner_id, "created_at": {"$gte": cutoff}},
                {"_id": 0, "role": 1, "text": 1, "session_id": 1, "caller_agent": 1, "created_at": 1},
            ).sort("created_at", 1).limit(max_messages)
            voice_turns = await v_cur.to_list(max_messages)

        # Recent shop cases (still count-based — cases age slower than chat)
        cases: List[Dict[str, Any]] = []
        if cases_limit > 0:
            c_cur = db.brain_cases.find(
                {"shop_id": shop_id},
                {"_id": 0, "id": 1, "vehicle": 1, "symptom": 1, "root_cause": 1,
                 "repair_summary": 1, "outcome": 1, "created_at": 1, "technician_name": 1},
            ).sort("created_at", -1).limit(cases_limit)
            cases = await c_cur.to_list(cases_limit)

        operator_style = (
            "Doc Underhood — operator of Dr. Underhood Automotive Specialist, LLC, Fort Smith AR. "
            "Talks like a gruff, no-bullshit shop owner. Often types in ALL CAPS, curses freely, "
            "expects fast direct answers, no preamble, no markdown bolding (** breaks immersion), "
            "no emoji. Despises padding and apology spirals. Direct mechanic tone wins. "
            "If he's frustrated, acknowledge briefly and just FIX it. Never lecture."
        )

        return {
            "shop_profile": {
                "shop_id": shop_id,
                "name": sp.get("name", ""),
                "address": sp.get("address", ""),
                "phone": sp.get("phone", ""),
                "hours": sp.get("hours", ""),
                "capabilities": sp.get("capabilities", []),
                "specialties": sp.get("specialties", []),
                "service_areas": sp.get("service_areas", []),
                "notes": sp.get("notes", ""),
            },
            "operator_style": operator_style,
            "locked_memory_facts": locked_facts,
            "candidate_facts": candidate_facts,
            "recent_chat_turns": chat_turns,
            "voice_turn_highlights": voice_turns,
            "recent_cases": cases,
            "window": {
                "since_days": since_days,
                "cutoff_iso": cutoff,
                "max_messages_ceiling": max_messages,
            },
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "counts": {
                "locked_facts": len(locked_facts),
                "candidate_facts": len(candidate_facts),
                "chat_turns": len(chat_turns),
                "voice_turns": len(voice_turns),
                "cases": len(cases),
            },
        }

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
        response: Response,
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
        symptom reporter.

        Response header `X-Brain-Corpus-Version` is a short SHA derived from the
        latest brain_case + brain_outcome_event + library_item timestamps for this
        shop. Partners cache prompt fragments keyed by this version — when it
        changes, they invalidate. Cheap consistency primitive."""
        q = {"shop_id": shop_id}
        if since:
            q["created_at"] = {"$gt": since}
        if outcome:
            q["outcome"] = outcome.upper()
        cur = db.brain_outcome_events.find(q, {"_id": 0}).sort("created_at", -1).limit(limit)
        events = await cur.to_list(limit)

        # Corpus version — hash latest update timestamps across the things that
        # would change Doc's prior-repair signal.
        import hashlib
        parts = []
        for coll, query in (
            (db.brain_outcome_events, {"shop_id": shop_id}),
            (db.brain_cases, {"shop_id": shop_id}),
        ):
            r = await coll.find_one(query, {"_id": 0, "created_at": 1}, sort=[("created_at", -1)])
            parts.append((r or {}).get("created_at") or "")
        shop_user_ids = [u["id"] async for u in db.users.find({"shop_id": shop_id}, {"_id": 0, "id": 1})]
        if shop_user_ids:
            r = await db.library_items.find_one(
                {"user_id": {"$in": shop_user_ids}, "kind": "url"},
                {"_id": 0, "created_at": 1},
                sort=[("created_at", -1)],
            )
            parts.append((r or {}).get("created_at") or "")
        corpus_v = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]
        response.headers["X-Brain-Corpus-Version"] = corpus_v
        response.headers["Access-Control-Expose-Headers"] = "X-Brain-Corpus-Version"

        return {
            "shop_id": shop_id,
            "since": since,
            "count": len(events),
            "events": events,
            "corpus_version": corpus_v,
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

    # ----- Crawl source summary (partner can see what's in the brain + tier mix) -----
    @router.get("/brain/crawl-sources")
    async def brain_crawl_sources(
        shop_id: str = Query(...),
        _t: str = Depends(get_brain_token),
    ):
        """Returns the watchlist + library source-tier breakdown for a shop.

        Lets the partner agent inspect what knowledge sources are feeding our
        brain so it can render attribution ("per HP Tuners forum", "per NHTSA")
        in user-facing responses, and weight low-tier forum content lower than
        OEM data in its own RAG.

        Auth: bearer token.
        """
        shop_user_ids = [u["id"] async for u in db.users.find({"shop_id": shop_id}, {"_id": 0, "id": 1})]
        if not shop_user_ids:
            return {"shop_id": shop_id, "sources": [], "by_tier": {}}
        # Aggregate library_items by source_tier
        pipeline = [
            {"$match": {"user_id": {"$in": shop_user_ids}, "kind": "url"}},
            {"$group": {
                "_id": {"tier": "$source_tier", "label": "$source_label"},
                "count": {"$sum": 1},
                "chunks": {"$sum": "$chunk_count"},
                "last_seen": {"$max": "$created_at"},
            }},
            {"$sort": {"count": -1}},
        ]
        rows = await db.library_items.aggregate(pipeline).to_list(200)
        by_tier: Dict[int, int] = {}
        sources = []
        for r in rows:
            tier = (r.get("_id") or {}).get("tier") or 4
            label = (r.get("_id") or {}).get("label") or "Unknown"
            by_tier[tier] = by_tier.get(tier, 0) + r.get("count", 0)
            sources.append({
                "tier": tier,
                "label": label,
                "documents": r.get("count", 0),
                "chunks": r.get("chunks", 0),
                "last_seen": r.get("last_seen"),
            })
        return {
            "shop_id": shop_id,
            "by_tier": by_tier,
            "tier_rubric": {
                "1": "Doc's own ROs / NHTSA / iATN — highest signal",
                "2": "Open pro/enthusiast forums + named YouTube + trade pubs",
                "3": "Paid TOS-restricted (manual paste only, never auto-crawled)",
                "4": "Unknown / fallback",
            },
            "sources": sources[:100],
            "pii_scrubbed": True,
            "dedup_method": "sha256 fingerprint over number-normalized text sample",
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

    @router.get("/public/shop-html/{shop_id}", response_class=Response)
    async def public_shop_html(shop_id: str):
        """SEO-optimized static HTML page for AI search crawlers (GPTBot, ClaudeBot,
        PerplexityBot, OAI-SearchBot, Google-Extended, Bingbot). Returns:
          - JSON-LD AutoRepair LocalBusiness schema (the killer feature — this is
            what LLM crawlers actually consume when answering 'best diesel shop in...')
          - Real content in the static HTML (no JS required)
          - Open Graph + Twitter Cards for sharing previews
          - Canonical link to the React landing page for humans
        Serve this URL from sitemap.xml and link to it from the SPA.
        """
        profile = await db.shop_profiles.find_one({"shop_id": shop_id}, {"_id": 0}) or {}
        if not profile:
            raise HTTPException(404, "Shop not found.")
        e = _html.escape

        name = profile.get("name") or "Dr. Underhood Automotive"
        phone = profile.get("phone") or ""
        address = profile.get("address") or ""
        hours = profile.get("hours") or ""
        notes = profile.get("notes") or ""
        capabilities = profile.get("capabilities") or []
        specialties = profile.get("specialties") or []
        service_areas = profile.get("service_areas") or []

        # Best-effort split of address into structured fields (street, city, state, zip).
        street_address = address
        city = ""
        region = ""
        postal_code = ""
        if address:
            parts = [p.strip() for p in address.split(",")]
            if len(parts) >= 3:
                street_address = parts[0]
                city = parts[1]
                last = parts[-1].split()
                if last:
                    region = last[0]
                    if len(last) > 1:
                        postal_code = last[-1]

        # Build JSON-LD AutoRepair (a subtype of LocalBusiness — most accurate for a shop)
        ld: Dict[str, Any] = {
            "@context": "https://schema.org",
            "@type": "AutoRepair",
            "name": name,
            "url": f"https://foreman.drunderhood.com/shop/{shop_id}",
            "image": "https://foreman.drunderhood.com/drunderhood-logo.jpg",
            "description": (
                notes
                or f"{name} — performance diagnostics, ECM tuning, and full-service repair. "
                + (f"Specializing in {', '.join(specialties[:4])}. " if specialties else "")
                + (f"Serving {', '.join(service_areas)}." if service_areas else "")
            ),
        }
        if phone:
            ld["telephone"] = phone
        if address:
            ld["address"] = {
                "@type": "PostalAddress",
                "streetAddress": street_address,
                "addressLocality": city,
                "addressRegion": region,
                "postalCode": postal_code,
                "addressCountry": "US",
            }
        if service_areas:
            ld["areaServed"] = [{"@type": "City", "name": a} for a in service_areas]
        if hours:
            ld["openingHours"] = hours
        all_services = list({*capabilities, *specialties})
        if all_services:
            ld["makesOffer"] = [
                {"@type": "Offer", "itemOffered": {"@type": "Service", "name": s}}
                for s in all_services[:20]
            ]
            ld["knowsAbout"] = all_services[:20]
        ld["priceRange"] = "$$"

        ld_json = json.dumps(ld, separators=(",", ":"))

        title = f"{name} — Performance Diagnostics, ECM Tuning & Full-Service Repair"
        if service_areas:
            title += f" — {service_areas[0]}"
        meta_desc = ld["description"][:170]

        # Real content in static HTML so crawlers without JS still get the goods
        caps_html = "".join(f"<li>{e(c)}</li>" for c in capabilities)
        specs_html = "".join(f"<li>{e(s)}</li>" for s in specialties)
        areas_html = ", ".join(e(a) for a in service_areas)

        canonical = f"https://foreman.drunderhood.com/shop/{shop_id}"

        body = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(meta_desc)}">
<link rel="canonical" href="{e(canonical)}">

<meta property="og:type" content="website">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(meta_desc)}">
<meta property="og:url" content="{e(canonical)}">
<meta property="og:image" content="https://foreman.drunderhood.com/drunderhood-logo.jpg">
<meta property="og:site_name" content="{e(name)}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{e(title)}">
<meta name="twitter:description" content="{e(meta_desc)}">
<meta name="twitter:image" content="https://foreman.drunderhood.com/drunderhood-logo.jpg">

<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">
<meta name="googlebot" content="index,follow,max-snippet:-1,max-image-preview:large">

<script type="application/ld+json">{ld_json}</script>

<style>
body {{ font-family: -apple-system,Helvetica,Arial,sans-serif; max-width: 760px; margin: 0 auto; padding: 32px 20px; line-height: 1.55; color: #1a1a1a; }}
h1 {{ font-size: 32px; margin: 0 0 6px; }}
h2 {{ font-size: 20px; margin: 28px 0 8px; color: #b8360c; border-bottom: 2px solid #b8360c; padding-bottom: 4px; }}
.tagline {{ color: #555; text-transform: uppercase; letter-spacing: 0.18em; font-size: 11px; }}
.contact {{ background: #fff7ed; border-left: 4px solid #b8360c; padding: 12px 16px; margin: 16px 0; }}
.contact a {{ color: #b8360c; font-weight: 700; text-decoration: none; }}
ul {{ padding-left: 22px; }}
.note {{ color: #666; font-size: 13px; margin-top: 32px; }}
</style>
</head>
<body>
<div class="tagline">PERFORMANCE · DIAGNOSTICS · TUNING</div>
<h1>{e(name)}</h1>

<div class="contact">
  {('<div><strong>Phone:</strong> <a href="tel:' + e(phone) + '">' + e(phone) + '</a></div>') if phone else ''}
  {('<div><strong>Address:</strong> ' + e(address) + '</div>') if address else ''}
  {('<div><strong>Hours:</strong> ' + e(hours) + '</div>') if hours else ''}
  {('<div><strong>Serving:</strong> ' + areas_html + '</div>') if areas_html else ''}
</div>

{('<h2>About</h2><p>' + e(notes) + '</p>') if notes else ''}

{('<h2>What we do</h2><ul>' + caps_html + '</ul>') if caps_html else ''}

{('<h2>Specialties</h2><ul>' + specs_html + '</ul>') if specs_html else ''}

<p class="note">For the full site, visit <a href="{e(canonical)}">{e(canonical)}</a>.</p>
</body>
</html>"""
        return Response(content=body, media_type="text/html; charset=utf-8")

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

        # Fire-and-forget owner notification email (won't block the response).
        try:
            def esc(s):
                return _html.escape(s or "")
            subject = f"NEW QUOTE LEAD — {esc(doc['name'])}"
            body_html = (
                f"<div style='font-family:Arial,sans-serif;max-width:600px;'>"
                f"<h2 style='color:#B91C1C;border-bottom:3px solid #D4A017;padding-bottom:8px;margin:0 0 16px 0;'>NEW QUOTE LEAD</h2>"
                f"<table style='border-collapse:collapse;width:100%;font-size:15px;'>"
                f"<tr><td style='padding:6px 12px 6px 0;color:#666;width:120px;'>NAME</td><td style='padding:6px 0;font-weight:bold;'>{esc(doc['name'])}</td></tr>"
                f"<tr><td style='padding:6px 12px 6px 0;color:#666;'>CONTACT</td><td style='padding:6px 0;font-weight:bold;'>{esc(doc['contact'])}</td></tr>"
                f"<tr><td style='padding:6px 12px 6px 0;color:#666;'>VEHICLE</td><td style='padding:6px 0;'>{esc(doc.get('vehicle') or '—')}</td></tr>"
                f"<tr><td style='padding:6px 12px 6px 0;color:#666;'>SOURCE</td><td style='padding:6px 0;'>{esc(doc.get('source') or 'landing')}</td></tr>"
                f"</table>"
                f"<div style='margin-top:18px;padding:14px;background:#f5f5f5;border-left:4px solid #D4A017;'>"
                f"<div style='font-size:12px;color:#666;letter-spacing:1px;margin-bottom:6px;'>WHAT THEY NEED</div>"
                f"<div style='font-size:15px;white-space:pre-wrap;'>{esc(doc['what_they_need'])}</div>"
                f"</div>"
                f"<div style='margin-top:18px;font-size:12px;color:#999;'>Lead ID: {doc['id']} · {doc['created_at']}</div>"
                f"</div>"
            )
            asyncio.create_task(notify_shop(db, body.shop_id, subject, body_html))

            # Also text Doc's cell — SMS is the urgent channel, email is the paper trail
            sms_body = (
                f"NEW LEAD — {doc['name']}\n"
                f"Contact: {doc['contact']}\n"
                + (f"Vehicle: {doc.get('vehicle')}\n" if doc.get('vehicle') else "")
                + f"\n{doc['what_they_need'][:400]}\n\n"
                f"foreman.drunderhood.com/leads"
            )
            asyncio.create_task(twilio_notify_owner(sms_body))
        except Exception as e:
            log.warning(f"lead notify dispatch failed: {e}")

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
