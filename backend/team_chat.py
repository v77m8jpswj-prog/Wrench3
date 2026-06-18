"""
Data Wrench — TEAM CHAT module
Tech-to-tech messaging inside the shop. Every message is tagged with shop_id.

Threads:
- 'shop' channel: everyone in the shop, all messages visible to all techs
- Direct messages: any tech can DM another tech in the same shop

Brain absorption:
- Background: a tech can mark a thread/message "→ BRAIN" which ingests the
  conversation as a context note that future Wrench answers can search.
"""
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

DEFAULT_SHOP_ID = os.environ.get("DEFAULT_SHOP_ID", "drunderhood-fortsmith")


class SendMsgReq(BaseModel):
    to_user_id: Optional[str] = None  # None = #shop channel
    content: str


class MarkReadReq(BaseModel):
    thread_key: str  # "shop" or other user_id
    message_ids: Optional[List[str]] = None  # if None, mark all in thread as read


class AbsorbReq(BaseModel):
    thread_key: str  # "shop" or other user_id
    limit: int = 50  # how many recent messages to ingest


def thread_key_for(from_uid: str, to_uid: Optional[str]) -> str:
    """Stable thread key. 'shop' for broadcast, or sorted pair 'a|b' for DM."""
    if not to_uid:
        return "shop"
    a, b = sorted([from_uid, to_uid])
    return f"{a}|{b}"


def make_team_chat_router(db, get_user, embed_text=None, case_text_blob=None):
    router = APIRouter()

    @router.get("/team-chat/threads")
    async def list_threads(user=Depends(get_user)):
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        # All techs in shop (for DM list)
        techs = await db.users.find(
            {"shop_id": shop_id, "id": {"$ne": user["id"]}},
            {"_id": 0, "password": 0, "settings": 0}
        ).to_list(200)
        # Latest message per thread
        threads = [{"key": "shop", "name": "#SHOP", "kind": "channel"}]
        for t in techs:
            threads.append({
                "key": thread_key_for(user["id"], t["id"]),
                "name": t["name"],
                "kind": "dm",
                "other_user_id": t["id"],
                "other_email": t["email"],
                "other_role": t.get("role", "tech"),
            })
        # Add last message + unread count per thread
        for th in threads:
            last = await db.team_chat_messages.find(
                {"shop_id": shop_id, "thread_key": th["key"]}, {"_id": 0}
            ).sort("created_at", -1).limit(1).to_list(1)
            th["last_message"] = last[0] if last else None
            unread = await db.team_chat_messages.count_documents({
                "shop_id": shop_id,
                "thread_key": th["key"],
                "from_user_id": {"$ne": user["id"]},
                "read_by": {"$ne": user["id"]},
            })
            th["unread"] = unread
        return threads

    @router.get("/team-chat/messages")
    async def list_messages(thread: str, user=Depends(get_user)):
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        # Validate access: thread is either "shop" or a key containing this user's id
        if thread != "shop" and user["id"] not in thread.split("|"):
            raise HTTPException(403, "Not your thread")
        cur = db.team_chat_messages.find(
            {"shop_id": shop_id, "thread_key": thread}, {"_id": 0}
        ).sort("created_at", 1).limit(500)
        return await cur.to_list(500)

    @router.post("/team-chat/messages")
    async def send_message(body: SendMsgReq, user=Depends(get_user)):
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        content = (body.content or "").strip()
        if not content:
            raise HTTPException(400, "Empty message")
        # Validate target tech is in the same shop (or None = #shop channel)
        if body.to_user_id:
            other = await db.users.find_one({"id": body.to_user_id, "shop_id": shop_id})
            if not other:
                raise HTTPException(404, "That tech isn't in your shop.")
        tk = thread_key_for(user["id"], body.to_user_id)
        doc = {
            "id": str(uuid.uuid4()),
            "shop_id": shop_id,
            "thread_key": tk,
            "from_user_id": user["id"],
            "from_name": user.get("name", ""),
            "to_user_id": body.to_user_id,
            "content": content,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "read_by": [user["id"]],
        }
        await db.team_chat_messages.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.post("/team-chat/mark-read")
    async def mark_read(body: MarkReadReq, user=Depends(get_user)):
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        q = {"shop_id": shop_id, "thread_key": body.thread_key}
        if body.message_ids:
            q["id"] = {"$in": body.message_ids}
        await db.team_chat_messages.update_many(q, {"$addToSet": {"read_by": user["id"]}})
        return {"ok": True}

    @router.post("/team-chat/absorb")
    async def absorb_thread(body: AbsorbReq, user=Depends(get_user)):
        """Take the last N messages from a thread and ingest into the brain as a case note
        so future Wrench answers can search them. Tech-to-tech shop knowledge captured."""
        shop_id = user.get("shop_id") or DEFAULT_SHOP_ID
        if body.thread_key != "shop" and user["id"] not in body.thread_key.split("|"):
            raise HTTPException(403, "Not your thread")
        msgs = await db.team_chat_messages.find(
            {"shop_id": shop_id, "thread_key": body.thread_key}, {"_id": 0}
        ).sort("created_at", -1).limit(max(5, min(200, body.limit))).to_list(200)
        msgs.reverse()
        if not msgs:
            raise HTTPException(400, "No messages to absorb in that thread.")
        # Build a single text blob
        blob = "\n".join(f"[{m['from_name']}] {m['content']}" for m in msgs)
        thread_label = "#shop channel" if body.thread_key == "shop" else f"DM"
        case_id = str(uuid.uuid4())
        case_doc = {
            "id": case_id,
            "shop_id": shop_id,
            "vehicle": {},
            "symptom": f"[TEAM CHAT ABSORBED — {thread_label}]",
            "dtc_codes": [],
            "root_cause": "",
            "repair_summary": blob[:4000],
            "parts": [],
            "technician_name": user.get("name", ""),
            "technician_id": user.get("id", ""),
            "outcome": "FIXED",
            "labor_hours": None,
            "photos_base64": [],
            "confidence_note": f"Absorbed {len(msgs)} messages from {thread_label} on {datetime.now(timezone.utc).date().isoformat()}",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": "team_chat_absorb",
            "absorbed_thread_key": body.thread_key,
            "absorbed_message_count": len(msgs),
            "created_by_user_id": user.get("id"),
        }
        if embed_text and case_text_blob:
            case_doc["embedding"] = await embed_text(case_text_blob(case_doc) + "\n\nTEAM CHAT:\n" + blob[:4000])
        await db.brain_cases.insert_one(case_doc)
        case_doc.pop("_id", None)
        case_doc.pop("embedding", None)
        return {"absorbed": True, "messages_absorbed": len(msgs), "case_id_in_brain": case_id}

    return router
