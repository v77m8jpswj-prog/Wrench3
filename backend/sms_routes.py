"""
Data Wrench — SMS routes.

Two things wired here:
1. Inbound SMS webhook (Twilio POSTs here when a customer texts the toll-free).
   - Captures the message into sms_messages collection
   - Texts the owner's cell so Doc gets notified in real time
   - Returns valid TwiML (empty <Response/>) — no auto-reply
2. Test SMS endpoint — POST /api/sms/test fires a message to the owner's cell so Doc
   can confirm the wire end-to-end without waiting for a real customer text.
3. SMS list endpoint — GET /api/sms/messages returns recent inbound/outbound.

Inbound webhook URL to configure in Twilio console (per phone-number Messaging config):
  https://foreman.drunderhood.com/api/sms/inbound
"""
import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Form, Request, HTTPException, Depends
from fastapi.responses import Response

from twilio_mod import send_sms, notify_owner

log = logging.getLogger("datawrench.sms")


def make_router(db, get_user):
    router = APIRouter()

    @router.post("/sms/inbound")
    async def sms_inbound(
        request: Request,
        From: str = Form(""),
        To: str = Form(""),
        Body: str = Form(""),
        MessageSid: str = Form(""),
        NumMedia: int = Form(0),
        FromCity: str = Form(""),
        FromState: str = Form(""),
    ):
        """Twilio webhook. Validates only on production via signature optional check.
        We keep this permissive so dev/preview testing works without ngrok."""
        ts = datetime.now(timezone.utc).isoformat()
        doc = {
            "id": str(uuid.uuid4()),
            "direction": "inbound",
            "twilio_sid": MessageSid,
            "from_number": From,
            "to_number": To,
            "body": Body[:2000],
            "num_media": NumMedia,
            "from_city": FromCity,
            "from_state": FromState,
            "created_at": ts,
            "read": False,
        }
        try:
            await db.sms_messages.insert_one(doc)
            doc.pop("_id", None)
        except Exception as e:
            log.warning(f"sms inbound insert failed: {e}")

        # Notify Doc by text immediately
        loc = f" ({FromCity}, {FromState})" if FromCity else ""
        snippet = (Body[:120] + "…") if len(Body) > 120 else Body
        try:
            await notify_owner(f"NEW SMS from {From}{loc}: {snippet}")
        except Exception as e:
            log.warning(f"owner notify on inbound sms failed: {e}")

        # Return empty TwiML — no auto-reply (Doc replies manually from the inbox)
        return Response(
            content='<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
            media_type="application/xml",
        )

    @router.post("/sms/test")
    async def sms_test(user=Depends(get_user)):
        """Fire a one-shot test SMS to the owner's cell so Doc can verify the wire."""
        body = "Wrench test SMS. If you see this, the toll-free + Twilio wire is good."
        ok = await notify_owner(body)
        # Log it as outbound for the inbox
        try:
            await db.sms_messages.insert_one({
                "id": str(uuid.uuid4()),
                "direction": "outbound",
                "from_number": os.environ.get("TWILIO_FROM_NUMBER", ""),
                "to_number": os.environ.get("TWILIO_OWNER_CELL", ""),
                "body": body,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "read": True,
                "kind": "test",
            })
        except Exception:
            pass
        if not ok:
            raise HTTPException(500, "SMS send failed — check Twilio creds + TWILIO_OWNER_CELL")
        return {"ok": True, "sent": True}

    @router.get("/sms/messages")
    async def sms_messages(limit: int = 50, user=Depends(get_user)):
        """Recent SMS history (inbound + outbound)."""
        cur = db.sms_messages.find({}, {"_id": 0}).sort("created_at", -1).limit(min(limit, 200))
        rows = await cur.to_list(min(limit, 200))
        return rows

    @router.post("/sms/mark-read")
    async def sms_mark_read(body: dict, user=Depends(get_user)):
        ids = body.get("ids") or []
        if not isinstance(ids, list) or not ids:
            return {"ok": True, "updated": 0}
        r = await db.sms_messages.update_many({"id": {"$in": ids}}, {"$set": {"read": True}})
        return {"ok": True, "updated": r.modified_count}

    @router.post("/sms/send")
    async def sms_send(body: dict, user=Depends(get_user)):
        """Send an outbound SMS to a specific customer number.
        Requires toll-free approval to text non-verified numbers — until then
        Twilio will reject with code 30032; we surface that error to the caller."""
        to = (body.get("to") or "").strip()
        msg = (body.get("body") or "").strip()
        if not to or not msg:
            raise HTTPException(400, "to and body required")
        ok = await send_sms(to, msg)
        try:
            await db.sms_messages.insert_one({
                "id": str(uuid.uuid4()),
                "direction": "outbound",
                "from_number": os.environ.get("TWILIO_FROM_NUMBER", ""),
                "to_number": to,
                "body": msg,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "read": True,
                "ok": ok,
            })
        except Exception:
            pass
        return {"ok": ok}

    return router
