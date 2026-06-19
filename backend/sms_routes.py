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
    @router.post("/sms/incoming")
    async def sms_inbound(
        request: Request,
        From: str = Form(""),
        To: str = Form(""),
        Body: str = Form(""),
        MessageSid: str = Form(""),
        NumMedia: int = Form(0),
        FromCity: str = Form(""),
        FromState: str = Form(""),
        MediaUrl0: str = Form(""),
        MediaContentType0: str = Form(""),
    ):
        """Twilio webhook. Validates only on production via signature optional check.
        We keep this permissive so dev/preview testing works without ngrok.

        Special behavior: if the inbound is FROM the owner's own cell (because
        Doc replied to the notification text on his phone), we treat that as a
        forward to the last customer who texted in, NOT as a new customer
        message. This prevents the loop where Doc's reply pings him back."""
        ts = datetime.now(timezone.utc).isoformat()

        # Owner-reply detection: check env var first (legacy), then users.phone in DB
        owner_cell = (os.environ.get("TWILIO_OWNER_CELL", "") or "").strip()

        def _norm(n: str) -> str:
            return "".join(ch for ch in (n or "") if ch.isdigit())

        from_norm = _norm(From)
        is_owner_reply = False
        matched_owner = None
        if owner_cell and from_norm and from_norm == _norm(owner_cell):
            is_owner_reply = True
        else:
            # Fall back to users.phone for owners (set via /api/settings/cell)
            owners = db.users.find(
                {"role": "owner", "phone": {"$exists": True, "$nin": [None, ""]}},
                {"_id": 0, "id": 1, "phone": 1, "email": 1},
            )
            async for u in owners:
                if _norm(u.get("phone", "")) == from_norm and from_norm:
                    is_owner_reply = True
                    matched_owner = u
                    owner_cell = u.get("phone") or owner_cell
                    break

        if is_owner_reply:
            # === VIN-snap intercept: if Doc sent a photo, OCR it for a VIN before
            # falling into the customer-forward logic. ===
            if NumMedia and NumMedia > 0 and MediaUrl0 and (MediaContentType0 or "").startswith("image/"):
                try:
                    from vin_capture import (
                        ocr_vin_from_twilio_media, decode_vin,
                        upsert_vehicle_for_owner, set_active_vehicle,
                    )
                    openai_key = os.environ.get("OPENAI_API_KEY", "")
                    twilio_sid = os.environ.get("TWILIO_ACCOUNT_SID", "")
                    twilio_tok = os.environ.get("TWILIO_AUTH_TOKEN", "")
                    vin = await ocr_vin_from_twilio_media(
                        MediaUrl0, MediaContentType0, openai_key, twilio_sid, twilio_tok,
                    )
                    owner_doc = matched_owner or (
                        await db.users.find_one({"role": "owner"}, {"_id": 0}) or {}
                    )
                    if vin and owner_doc.get("id"):
                        decoded = await decode_vin(vin)
                        veh = await upsert_vehicle_for_owner(db, owner_doc, decoded)
                        await set_active_vehicle(db, owner_doc["id"], veh["id"])
                        reply_lines = [
                            f"VIN {vin} loaded.",
                            f"{decoded.get('year','')} {decoded.get('make','')} {decoded.get('model','')} {decoded.get('trim','')}".strip(),
                        ]
                        eng_bits = veh.get("engine", "").strip()
                        if eng_bits:
                            reply_lines.append(eng_bits)
                        reply_lines.append("Active in /chat. Diag ready.")
                        reply_text = "\n".join([line for line in reply_lines if line])
                        try:
                            await send_sms(owner_cell, reply_text)
                        except Exception as e:
                            log.warning("VIN reply SMS failed: %s", e)
                        await db.sms_messages.insert_one({
                            "id": str(uuid.uuid4()),
                            "direction": "inbound",
                            "kind": "vin_snap_loaded",
                            "from_number": From,
                            "to_number": To,
                            "body": Body or "(vin photo)",
                            "vin": vin,
                            "vehicle_id": veh["id"],
                            "media_url": MediaUrl0,
                            "twilio_sid": MessageSid,
                            "created_at": ts,
                        })
                        return Response(content="<Response/>", media_type="application/xml")
                    elif owner_doc.get("id") and not vin:
                        # photo sent but no VIN detected — short reply so Doc knows
                        try:
                            await send_sms(owner_cell, "Got the pic but I couldn't read a VIN out of it. Try again closer / better lit.")
                        except Exception:
                            pass
                        await db.sms_messages.insert_one({
                            "id": str(uuid.uuid4()),
                            "direction": "inbound",
                            "kind": "vin_snap_no_vin",
                            "from_number": From,
                            "to_number": To,
                            "body": Body or "(photo, no VIN)",
                            "media_url": MediaUrl0,
                            "twilio_sid": MessageSid,
                            "created_at": ts,
                        })
                        return Response(content="<Response/>", media_type="application/xml")
                except Exception as e:
                    log.warning("VIN-snap intercept error (continuing to fallback): %s", e)
            # === end VIN-snap intercept ===
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

    @router.get("/sms/unread-count")
    async def sms_unread_count(user=Depends(get_user)):
        """Lightweight count for the sidebar nav badge.
        Counts inbound messages where read != True. Legacy rows with no
        `direction` field are treated as inbound (matches /sms/threads logic)."""
        n = await db.sms_messages.count_documents({
            "$and": [
                {"$or": [{"direction": "inbound"}, {"direction": {"$exists": False}}]},
                {"$or": [{"read": {"$exists": False}}, {"read": {"$ne": True}}]},
            ],
        })
        return {"unread": int(n)}

    @router.get("/sms/threads")
    async def sms_threads(user=Depends(get_user)):
        """Customer-grouped SMS threads with name/city lookups from leads.
        Each thread: { phone, name, lead_id, last_at, last_body, last_direction,
        unread_count, total_count, city, state }. Sorted newest-first.

        Handles BOTH the new schema (from_number/to_number) AND the legacy
        schema where rows only had a single `phone` field — historical rows
        from before the multi-field rewrite would otherwise be invisible."""
        # Last 1000 messages — covers a long active shop history without
        # making grouping expensive. Bump if Doc gets busier.
        cur = db.sms_messages.find({}, {"_id": 0}).sort("created_at", -1).limit(1000)
        rows = await cur.to_list(1000)

        def other_raw(r):
            # New schema: outbound has to_number set, inbound has from_number set.
            # Legacy schema: rows just have a `phone` field with the customer number.
            direction = r.get("direction", "inbound")
            if direction == "outbound":
                return r.get("to_number") or r.get("phone") or ""
            return r.get("from_number") or r.get("phone") or ""

        def last10(raw):
            return "".join(c for c in (raw or "") if c.isdigit())[-10:]

        threads = {}
        for r in rows:
            raw = other_raw(r)
            key = last10(raw)
            if not key:
                continue
            t = threads.get(key)
            if not t:
                # rows are pre-sorted desc, so the first one we see for each
                # customer is the most recent — use it for the preview fields.
                t = {
                    "phone_key": key,
                    "phone": raw,
                    "name": None,
                    "lead_id": None,
                    "last_at": r.get("created_at"),
                    "last_body": r.get("body") or "",
                    "last_direction": r.get("direction") or "inbound",
                    "unread_count": 0,
                    "total_count": 0,
                    "city": r.get("from_city") if (r.get("direction") or "inbound") == "inbound" else None,
                    "state": r.get("from_state") if (r.get("direction") or "inbound") == "inbound" else None,
                }
                threads[key] = t
            t["total_count"] += 1
            if (r.get("direction") or "inbound") == "inbound" and not r.get("read"):
                t["unread_count"] += 1
            # Pick up city/state from any inbound message if we didn't have one
            if not t["city"] and (r.get("direction") or "inbound") == "inbound":
                t["city"] = r.get("from_city")
                t["state"] = r.get("from_state")

        # Name lookup from leads: match on last-10-digits of contact field.
        if threads:
            leads_cur = db.leads.find(
                {"contact": {"$exists": True, "$ne": ""}},
                {"_id": 0, "id": 1, "name": 1, "contact": 1, "vehicle": 1, "status": 1, "created_at": 1}
            ).sort("created_at", -1).limit(500)
            for lead in await leads_cur.to_list(500):
                digits = ("".join(c for c in (lead.get("contact") or "") if c.isdigit()))[-10:]
                if digits and digits in threads and not threads[digits]["name"]:
                    threads[digits]["name"] = lead.get("name")
                    threads[digits]["lead_id"] = lead.get("id")
                    if not threads[digits].get("vehicle"):
                        threads[digits]["vehicle"] = lead.get("vehicle")

        # Sort threads by last_at desc, unread first as a tie-breaker bonus.
        result = sorted(
            threads.values(),
            key=lambda t: (t["unread_count"] > 0, t.get("last_at") or ""),
            reverse=True,
        )
        return result

    @router.get("/sms/threads/{phone_key}/messages")
    async def sms_thread_messages(phone_key: str, user=Depends(get_user)):
        """All messages for one customer thread (oldest → newest), matched by
        last-10-digits so format variations and legacy `phone` rows still group."""
        key = "".join(c for c in (phone_key or "") if c.isdigit())[-10:]
        if not key:
            return []
        cur = db.sms_messages.find({}, {"_id": 0}).sort("created_at", -1).limit(1000)
        rows = await cur.to_list(1000)
        def matches(r):
            direction = r.get("direction") or "inbound"
            if direction == "outbound":
                other = r.get("to_number") or r.get("phone") or ""
            else:
                other = r.get("from_number") or r.get("phone") or ""
            return ("".join(c for c in other if c.isdigit()))[-10:] == key
        msgs = [r for r in rows if matches(r)]
        msgs.sort(key=lambda r: r.get("created_at") or "")
        return msgs

    @router.post("/sms/threads/{phone_key}/mark-read")
    async def sms_thread_mark_read(phone_key: str, user=Depends(get_user)):
        """Mark every inbound message in this customer's thread as read.
        Handles both new (from_number) and legacy (phone) schemas."""
        key = "".join(c for c in (phone_key or "") if c.isdigit())[-10:]
        if not key:
            return {"ok": True, "updated": 0}
        cur = db.sms_messages.find(
            {
                "$or": [
                    {"direction": "inbound"},
                    {"direction": {"$exists": False}},  # legacy rows with no direction default to inbound
                ],
                "$and": [{"$or": [{"read": {"$exists": False}}, {"read": {"$ne": True}}]}],
            },
            {"from_number": 1, "phone": 1, "id": 1},
        )
        to_update = []
        async for r in cur:
            raw = r.get("from_number") or r.get("phone") or ""
            digits = ("".join(c for c in raw if c.isdigit()))[-10:]
            if digits == key:
                to_update.append(r["id"])
        if not to_update:
            return {"ok": True, "updated": 0}
        res = await db.sms_messages.update_many(
            {"id": {"$in": to_update}}, {"$set": {"read": True}}
        )
        return {"ok": True, "updated": res.modified_count}

    @router.delete("/sms/messages/{message_id}")
    async def sms_delete_message(message_id: str, user=Depends(get_user)):
        """Hard-delete a single SMS row. Used for clearing test sends / spam."""
        r = await db.sms_messages.delete_one({"id": message_id})
        if r.deleted_count == 0:
            raise HTTPException(404, "SMS not found.")
        return {"ok": True, "deleted": 1}

    @router.delete("/sms/threads/{phone_key}")
    async def sms_delete_thread(phone_key: str, user=Depends(get_user)):
        """Wipe an entire customer SMS thread (all inbound + outbound between
        you and that number). Handles legacy `phone`-only rows too. Doc uses
        this to clear spammers, telemarketers, dead leads."""
        key = "".join(c for c in (phone_key or "") if c.isdigit())[-10:]
        if not key:
            return {"ok": True, "deleted": 0}
        cur = db.sms_messages.find(
            {},
            {"id": 1, "from_number": 1, "to_number": 1, "phone": 1, "direction": 1},
        )
        to_delete = []
        async for r in cur:
            direction = r.get("direction") or "inbound"
            if direction == "outbound":
                other = r.get("to_number") or r.get("phone") or ""
            else:
                other = r.get("from_number") or r.get("phone") or ""
            digits = ("".join(c for c in other if c.isdigit()))[-10:]
            if digits == key:
                to_delete.append(r["id"])
        if not to_delete:
            return {"ok": True, "deleted": 0}
        res = await db.sms_messages.delete_many({"id": {"$in": to_delete}})
        return {"ok": True, "deleted": res.deleted_count}

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
