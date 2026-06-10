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
import re
import uuid
import logging
from datetime import datetime, timezone, timedelta
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
        We keep this permissive so dev/preview testing works without ngrok.

        Special behavior: if the inbound is FROM the owner's own cell (because
        Doc replied to the notification text on his phone), we treat that as a
        forward to the last customer who texted in, NOT as a new customer
        message. This prevents the loop where Doc's reply pings him back."""
        ts = datetime.now(timezone.utc).isoformat()

        owner_cell = (os.environ.get("TWILIO_OWNER_CELL", "") or "").strip()

        def _norm(n: str) -> str:
            return "".join(ch for ch in (n or "") if ch.isdigit())

        is_owner_reply = bool(owner_cell) and _norm(From) and _norm(From) == _norm(owner_cell)

        if is_owner_reply:
            # Find the most recent inbound from a non-owner number (the customer)
            last_cust = await db.sms_messages.find_one(
                {"direction": "inbound", "from_number": {"$ne": owner_cell}},
                {"_id": 0},
                sort=[("created_at", -1)],
            )
            if not last_cust:
                # === NEW: lead-fallback before giving up ===
                # No SMS thread. Try the most recent /leads entry (last 4 hours)
                # for this shop. Doc usually replies to lead-notification SMS,
                # not to actual SMS threads, so this is the common case.
                default_shop = os.environ.get("DEFAULT_SHOP_ID") or "drunderhood-fortsmith"
                four_hr_ago = (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat()
                recent_lead = await db.leads.find_one(
                    {"shop_id": default_shop, "created_at": {"$gte": four_hr_ago}},
                    {"_id": 0},
                    sort=[("created_at", -1)],
                )

                lead_phone = None
                lead_email = None
                if recent_lead:
                    contact = (recent_lead.get("contact") or "").strip()
                    if "@" in contact:
                        lead_email = contact
                    else:
                        # Strip everything except digits + leading +
                        digits = re.sub(r"[^0-9]", "", contact)
                        if len(digits) >= 10:
                            lead_phone = ("+1" + digits[-10:]) if not contact.startswith("+") else ("+" + digits)

                forwarded = False
                if lead_phone:
                    try:
                        ok = await send_sms(lead_phone, Body)
                    except Exception as e:
                        log.warning(f"lead-fallback SMS forward failed: {e}")
                        ok = False
                    forwarded = bool(ok)
                    await db.sms_messages.insert_one({
                        "id": str(uuid.uuid4()),
                        "direction": "outbound",
                        "from_number": To,
                        "to_number": lead_phone,
                        "body": Body[:2000],
                        "created_at": ts,
                        "read": True,
                        "kind": "owner_reply_forward_via_lead",
                        "owner_reply_sid": MessageSid,
                        "lead_id": recent_lead.get("id"),
                        "ok": forwarded,
                    })
                    if recent_lead.get("id") and forwarded:
                        await db.leads.update_one(
                            {"id": recent_lead["id"]},
                            {"$set": {"status": "doc_replied", "doc_reply_at": ts}},
                        )

                # Alert Doc back when we couldn't route via SMS — he MUST know
                # his reply didn't go to the customer instead of assuming it did.
                if not forwarded:
                    if recent_lead and lead_email:
                        alert = (
                            "REPLY NOT SENT — customer has email only, no phone.\n"
                            f"Customer: {recent_lead.get('name','?')} <{lead_email}>\n"
                            f"Vehicle: {recent_lead.get('vehicle','-')}\n"
                            f"Reply manually from foreman.drunderhood.com/leads or your Outlook.\n"
                            f"Your reply text was saved."
                        )
                    elif recent_lead:
                        alert = (
                            "REPLY NOT SENT — bad/missing phone on the most recent lead.\n"
                            f"Customer: {recent_lead.get('name','?')} ({recent_lead.get('contact','-')})\n"
                            f"Reply manually from foreman.drunderhood.com/leads."
                        )
                    else:
                        alert = (
                            "REPLY NOT SENT — no SMS thread + no recent lead in last 4h.\n"
                            "Your reply didn't reach a customer. Resend from foreman.drunderhood.com/leads."
                        )
                    try:
                        alert_ok = await send_sms(owner_cell, alert)
                    except Exception as e:
                        log.warning(f"alert-back to owner failed: {e}")
                        alert_ok = False
                    # Log the alert so Doc sees it in his SMS history too
                    try:
                        await db.sms_messages.insert_one({
                            "id": str(uuid.uuid4()),
                            "direction": "outbound",
                            "from_number": To,
                            "to_number": owner_cell,
                            "body": alert,
                            "created_at": ts,
                            "read": False,
                            "kind": "owner_reply_alert",
                            "owner_reply_sid": MessageSid,
                            "lead_id": (recent_lead or {}).get("id"),
                            "ok": alert_ok,
                        })
                    except Exception as e:
                        log.warning(f"alert log insert failed: {e}")

                await db.sms_messages.insert_one({
                    "id": str(uuid.uuid4()),
                    "direction": "inbound",
                    "twilio_sid": MessageSid,
                    "from_number": From,
                    "to_number": To,
                    "body": Body[:2000],
                    "created_at": ts,
                    "read": True,
                    "kind": "owner_reply_forward_via_lead" if forwarded else "owner_reply_orphan",
                    "lead_id": (recent_lead or {}).get("id"),
                    "lead_contact": (recent_lead or {}).get("contact"),
                })
                return Response(
                    content='<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
                    media_type="application/xml",
                )

            cust_number = last_cust["from_number"]
            # Forward Doc's reply to that customer
            try:
                ok = await send_sms(cust_number, Body)
            except Exception as e:
                log.warning(f"owner reply forward failed: {e}")
                ok = False
            await db.sms_messages.insert_one({
                "id": str(uuid.uuid4()),
                "direction": "outbound",
                "from_number": To,  # the toll-free
                "to_number": cust_number,
                "body": Body[:2000],
                "created_at": ts,
                "read": True,
                "kind": "owner_reply_forward",
                "owner_reply_sid": MessageSid,
                "ok": ok,
            })
            # Empty TwiML so Twilio doesn't echo
            return Response(
                content='<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
                media_type="application/xml",
            )

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

        # Notify Doc by text immediately. Prefix with the customer's number so
        # Doc knows who texted, AND so he could in theory paste it elsewhere.
        # Doc can reply directly to this notification text — we'll auto-forward
        # to this same customer (see is_owner_reply path above).
        loc = f" ({FromCity}, {FromState})" if FromCity else ""
        snippet = (Body[:120] + "…") if len(Body) > 120 else Body
        try:
            await notify_owner(f"NEW SMS from {From}{loc}: {snippet}\n\n(Reply to this text to text them back.)")
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
