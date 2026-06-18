"""
Data Wrench — LEARN module (auto-learn harvester)

Watches every channel Doc uses (chat, email out, RO close notes, tune log)
and uses Claude to extract candidate "facts about Doc" — beliefs, decision
rules, stock phrases, diagnostic patterns — that we can lock into memory.

Two tiers:
  - HIGH confidence (>=0.85) AND seen >= 2 times across sources → auto-locked
    into memory_facts as [LOCKED]. Doc only sees it in the "Just Learned" log.
  - LOW/MED confidence → dropped into `candidate_facts` queue for Doc to
    approve/reject with one tap.

Endpoints (mounted under /api/learn/*):
  GET  /api/learn/candidates       → pending facts to review
  POST /api/learn/candidates/{id}  → {action: approve|reject}
  POST /api/learn/harvest          → kick a harvest pass now (testing)
  GET  /api/learn/log              → "Just Learned" auto-locked feed
  POST /api/learn/import/chatgpt   → upload ChatGPT export zip, sweep retro
  GET  /api/learn/stats            → counts: pending/auto-locked/rejected
"""
import os
import io
import re
import json
import uuid
import zipfile
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any, Literal

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Query
from pydantic import BaseModel

from emergentintegrations.llm.chat import LlmChat, UserMessage

log = logging.getLogger("datawrench.learn")

EMERGENT_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
LEARN_MODEL = ("anthropic", "claude-sonnet-4-6")
AUTO_LOCK_MIN_CONF = 0.85
AUTO_LOCK_MIN_SEEN = 2  # same fact extracted >= N times before auto-lock


# ============ Extraction prompt ============
EXTRACT_SYS = """You are an expert at distilling personality and expertise from conversation transcripts.

You'll be given a transcript of messages from DOC (a master mechanic / HP Tuners tuner who runs Dr. Underhood Automotive). Your job: extract concrete, reusable FACTS about how Doc thinks, decides, communicates, or solves problems.

WHAT QUALIFIES AS A FACT:
- Decision rules ("Doc never quotes a cam tune under $850")
- Diagnostic patterns ("Doc checks AFR cells 6-8 before swapping coils for P0301 on a 5.3")
- Preferences ("Doc prefers HP Tuners over EFI Live for GM ECMs")
- Stock phrases / standard replies ("Doc's go-to answer for 'is my truck safe' is 'send me the VIN'")
- Beliefs / opinions stated with conviction ("Doc believes most P0420 codes on Silverados are bad gas, not the cat")
- Customer-handling rules ("Doc won't take work without a VIN")
- Tuning-specific knowledge ("Doc's known-good cam tune base for LS 5.3 is X")

WHAT DOES NOT QUALIFY:
- One-off chitchat
- Questions Doc asked (we want Doc's STATEMENTS, not his queries)
- Generic mechanic knowledge already in any textbook
- Personal life trivia unrelated to the shop
- Anything that contradicts a previous fact unless Doc explicitly updated it

OUTPUT FORMAT — strict JSON only, no prose:
{
  "facts": [
    {
      "fact": "single sentence stated as a declarative third-person rule, e.g. 'Doc verifies knock retard before adjusting spark on any GM LS platform.'",
      "confidence": 0.0-1.0,
      "category": "diagnostic|tuning|customer|pricing|process|belief|phrase"
    }
  ]
}

Be CONSERVATIVE on confidence:
- 0.9+ = Doc said it explicitly and clearly with no ambiguity
- 0.7-0.89 = strongly implied but not spelled out
- 0.5-0.69 = inferred from context, might be wrong
- below 0.5 = don't include

Return EMPTY facts array if nothing qualifies. Don't reach. Quality over quantity.
"""


# ============ Models ============
class CandidateAction(BaseModel):
    action: Literal["approve", "reject"]


class HarvestReq(BaseModel):
    since_hours: int = 24
    limit_messages: int = 200


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _norm_fact(s: str) -> str:
    """Normalize for de-dup: lowercase, strip leading 'Doc' prefix, collapse spaces."""
    t = (s or "").strip().lower()
    for pre in ("doc ", "doc's ", "he ", "his "):
        if t.startswith(pre):
            t = t[len(pre):]
            break
    return " ".join(t.split())[:300]


async def _extract_facts(transcript: str) -> List[Dict[str, Any]]:
    """Run Claude on a transcript and return a list of fact dicts."""
    if not transcript.strip():
        return []
    chat = LlmChat(
        api_key=EMERGENT_KEY,
        session_id=f"learn-{uuid.uuid4()}",
        system_message=EXTRACT_SYS,
    ).with_model(*LEARN_MODEL)
    try:
        raw = await chat.send_message(UserMessage(text=transcript[:18000]))
    except Exception as e:
        log.warning(f"extract LLM call failed: {e}")
        return []
    # Pull the first JSON object out of the response
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end < 0:
            return []
        parsed = json.loads(raw[start:end + 1])
        facts = parsed.get("facts") or []
        # filter to dicts with required fields
        return [f for f in facts if isinstance(f, dict) and f.get("fact") and isinstance(f.get("confidence"), (int, float))]
    except Exception as e:
        log.warning(f"couldn't parse extraction JSON: {e}")
        return []


# ============ Router factory ============
def make_learn_router(db, get_user):
    router = APIRouter()

    async def _save_or_promote(user_id: str, fact_text: str, confidence: float,
                                category: str, source: str, source_ref: str = "") -> Dict[str, Any]:
        """Insert/update a candidate. If it crosses auto-lock threshold, promote
        straight to memory_facts as [LOCKED] and mark candidate auto_locked."""
        norm = _norm_fact(fact_text)
        if not norm:
            return {"skipped": True}

        # Find existing candidate
        existing = await db.candidate_facts.find_one({"user_id": user_id, "norm": norm})

        # Check if already in memory_facts (don't re-add)
        snippet = re.escape(fact_text[:60])
        already_locked = await db.memory_facts.find_one({
            "user_id": user_id,
            "fact": {"$regex": snippet, "$options": "i"},
        })
        if already_locked:
            return {"already_known": True}

        if existing:
            new_seen = existing.get("seen_count", 1) + 1
            new_conf = max(existing.get("confidence", 0.0), confidence)
            sources = list(set((existing.get("sources") or []) + [source]))
            await db.candidate_facts.update_one(
                {"_id": existing["_id"]},
                {"$set": {
                    "seen_count": new_seen,
                    "confidence": new_conf,
                    "sources": sources,
                    "updated_at": _now().isoformat(),
                }},
            )
            cand_id = existing["id"]
            status = existing.get("status", "pending")
        else:
            cand_id = str(uuid.uuid4())
            new_seen = 1
            new_conf = confidence
            sources = [source]
            await db.candidate_facts.insert_one({
                "id": cand_id,
                "user_id": user_id,
                "fact": fact_text.strip(),
                "norm": norm,
                "category": category or "general",
                "confidence": new_conf,
                "seen_count": new_seen,
                "sources": sources,
                "source_ref": source_ref,
                "status": "pending",
                "created_at": _now().isoformat(),
                "updated_at": _now().isoformat(),
            })
            status = "pending"

        # Auto-lock?
        if status == "pending" and new_conf >= AUTO_LOCK_MIN_CONF and new_seen >= AUTO_LOCK_MIN_SEEN:
            # Promote to memory_facts as [LOCKED]
            await db.memory_facts.insert_one({
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "fact": f"[LOCKED] {fact_text.strip()}",
                "is_locked": True,
                "source": f"auto-learn:{source}",
                "created_at": _now().isoformat(),
            })
            await db.candidate_facts.update_one(
                {"id": cand_id},
                {"$set": {"status": "auto_locked", "locked_at": _now().isoformat()}},
            )
            return {"auto_locked": True, "fact": fact_text}

        return {"queued": True, "seen": new_seen, "confidence": new_conf}

    async def _harvest_messages(user_id: str, since: datetime, limit: int) -> Dict[str, int]:
        """Pull chat messages from the user since a cutoff, batch them, extract, save."""
        # Only Doc's USER turns — those are him talking, not Wrench
        cur = db.chat_messages.find(
            {"user_id": user_id, "role": "user", "created_at": {"$gt": since.isoformat()}},
            {"_id": 0, "content": 1, "session_id": 1, "created_at": 1},
        ).sort("created_at", 1).limit(limit)
        msgs = await cur.to_list(limit)
        if not msgs:
            return {"processed": 0, "candidates": 0, "auto_locked": 0}

        # Batch by session for context
        from collections import defaultdict
        by_session: Dict[str, List[Dict]] = defaultdict(list)
        for m in msgs:
            by_session[m.get("session_id", "no-sess")].append(m)

        candidates = 0
        auto_locked = 0
        for sid, batch in by_session.items():
            transcript = "\n\n".join(
                f"[Doc, {m.get('created_at','')[:16]}]: {(m.get('content') or '')[:1500]}"
                for m in batch[:30]
            )
            facts = await _extract_facts(transcript)
            for f in facts:
                res = await _save_or_promote(
                    user_id, f["fact"], float(f["confidence"]),
                    f.get("category", "general"), "chat", source_ref=sid,
                )
                if res.get("auto_locked"):
                    auto_locked += 1
                elif res.get("queued") or res.get("skipped") is None:
                    candidates += 1
        return {"processed": len(msgs), "candidates": candidates, "auto_locked": auto_locked}

    # ----- Pending review queue -----
    @router.get("/learn/candidates")
    async def list_candidates(user=Depends(get_user)):
        cur = db.candidate_facts.find(
            {"user_id": user["id"], "status": "pending"},
            {"_id": 0},
        ).sort("confidence", -1).limit(50)
        return await cur.to_list(50)

    @router.post("/learn/candidates/{cand_id}")
    async def act_candidate(cand_id: str, body: CandidateAction, user=Depends(get_user)):
        doc = await db.candidate_facts.find_one({"id": cand_id, "user_id": user["id"]})
        if not doc:
            raise HTTPException(404, "Candidate not found")
        if body.action == "approve":
            await db.memory_facts.insert_one({
                "id": str(uuid.uuid4()),
                "user_id": user["id"],
                "fact": f"[LOCKED] {doc['fact']}",
                "is_locked": True,
                "source": f"auto-learn:approved",
                "created_at": _now().isoformat(),
            })
            await db.candidate_facts.update_one(
                {"id": cand_id}, {"$set": {"status": "approved", "approved_at": _now().isoformat()}},
            )
            return {"ok": True, "locked": doc["fact"]}
        else:
            await db.candidate_facts.update_one(
                {"id": cand_id}, {"$set": {"status": "rejected", "rejected_at": _now().isoformat()}},
            )
            return {"ok": True, "rejected": True}

    # ----- "Just Learned" log -----
    @router.get("/learn/log")
    async def learn_log(limit: int = 30, user=Depends(get_user)):
        cur = db.candidate_facts.find(
            {"user_id": user["id"], "status": {"$in": ["auto_locked", "approved"]}},
            {"_id": 0},
        ).sort("updated_at", -1).limit(limit)
        return await cur.to_list(limit)

    # ----- Stats -----
    @router.get("/learn/stats")
    async def learn_stats(user=Depends(get_user)):
        pending = await db.candidate_facts.count_documents({"user_id": user["id"], "status": "pending"})
        auto = await db.candidate_facts.count_documents({"user_id": user["id"], "status": "auto_locked"})
        approved = await db.candidate_facts.count_documents({"user_id": user["id"], "status": "approved"})
        rejected = await db.candidate_facts.count_documents({"user_id": user["id"], "status": "rejected"})
        locked_total = await db.memory_facts.count_documents({"user_id": user["id"], "is_locked": True})
        return {
            "pending": pending,
            "auto_locked": auto,
            "approved": approved,
            "rejected": rejected,
            "locked_total": locked_total,
        }

    # ----- Manual harvest trigger (also used by cron) -----
    @router.post("/learn/harvest")
    async def manual_harvest(body: HarvestReq, user=Depends(get_user)):
        since = _now() - timedelta(hours=max(1, body.since_hours))
        res = await _harvest_messages(user["id"], since, body.limit_messages)
        return {"ok": True, **res}

    # ----- ChatGPT export importer -----
    @router.post("/learn/import/chatgpt")
    async def import_chatgpt(file: UploadFile = File(...), user=Depends(get_user)):
        """Accept a ChatGPT data export zip. Find conversations.json, extract
        every USER turn (that's Doc talking), run extraction in batches."""
        raw = await file.read()
        if len(raw) > 200 * 1024 * 1024:  # 200MB hard cap
            raise HTTPException(413, "File too big — split it or trim down.")
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
        except Exception:
            raise HTTPException(400, "Not a valid zip file. Upload the ChatGPT export .zip directly.")

        target = None
        for name in zf.namelist():
            if name.endswith("conversations.json"):
                target = name
                break
        if not target:
            raise HTTPException(400, "No conversations.json found in zip. Did you upload the right export?")

        try:
            data = json.loads(zf.read(target).decode("utf-8", errors="ignore"))
        except Exception as e:
            raise HTTPException(400, f"conversations.json is corrupted: {e}")

        if not isinstance(data, list):
            raise HTTPException(400, "Unexpected ChatGPT export format.")

        total_user_msgs = 0
        candidates = 0
        auto_locked = 0
        already_known = 0
        convo_count = 0

        for convo in data[:1000]:  # cap to be safe
            convo_count += 1
            mapping = (convo or {}).get("mapping") or {}
            user_msgs = []
            for node in mapping.values():
                msg = (node or {}).get("message")
                if not msg:
                    continue
                author = ((msg.get("author") or {}).get("role")) or ""
                if author != "user":
                    continue
                parts = ((msg.get("content") or {}).get("parts")) or []
                text_parts = [p for p in parts if isinstance(p, str)]
                if not text_parts:
                    continue
                txt = " ".join(text_parts).strip()
                if len(txt) < 40:  # skip trivial pings
                    continue
                user_msgs.append(txt[:2000])
                total_user_msgs += 1

            if not user_msgs:
                continue

            transcript = "\n\n".join(f"[Doc]: {m}" for m in user_msgs[:25])
            facts = await _extract_facts(transcript)
            for f in facts:
                res = await _save_or_promote(
                    user["id"], f["fact"], float(f["confidence"]),
                    f.get("category", "general"), "chatgpt-import",
                    source_ref=(convo.get("title") or "")[:120],
                )
                if res.get("auto_locked"):
                    auto_locked += 1
                elif res.get("already_known"):
                    already_known += 1
                else:
                    candidates += 1

        return {
            "ok": True,
            "conversations_scanned": convo_count,
            "user_messages": total_user_msgs,
            "auto_locked": auto_locked,
            "queued_for_review": candidates,
            "already_known": already_known,
        }

    return router
