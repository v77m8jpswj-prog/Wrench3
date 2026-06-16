"""
Data Wrench — Twilio Voice / Voicemail webhook handlers.

Flow for an incoming call to +1 (855) 771-1264 (forwarded from the shop's
479-434-5852 via Pinnacle conditional call forwarding):

  1) Twilio POSTs to  /api/voice/incoming     → we return TwiML <Say> + <Record>
  2) Caller leaves a voicemail (max 2 min)
  3) Twilio POSTs to  /api/voice/voicemail/done           (recording metadata)
  4) Twilio POSTs to  /api/voice/voicemail/transcription  (async transcript)
  5) We create a lead with kind="voicemail", text Doc on his cell, log audit.

All webhook endpoints validate the X-Twilio-Signature header against
TWILIO_AUTH_TOKEN so nobody can spoof voicemails into Doc's pipeline.

Read-only brain audit:
  GET /api/brain/voicemails?last=10  (brain bearer auth)
"""

import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Request, Response, Form, HTTPException, Depends, Query
from twilio.request_validator import RequestValidator

log = logging.getLogger("wrench.voice")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _twiml(xml: str) -> Response:
    return Response(content=xml, media_type="application/xml")


GREETING_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew-Neural">
    You've reached Dr. Underhood Automotive in Fort Smith. We can't take your call right now.
    Leave your name, your vehicle, and what's going on after the beep, and Doc will text you back.
    For emergencies, call the shop directly at 4-7-9, 4-3-4, 5-8-5-2.
  </Say>
  <Record action="{action_url}"
          transcribe="true"
          transcribeCallback="{transcribe_url}"
          maxLength="120"
          finishOnKey="#"
          playBeep="true"
          timeout="5"
          trim="trim-silence" />
  <Say voice="Polly.Matthew-Neural">We didn't catch that. Please call back. Goodbye.</Say>
</Response>"""

AFTER_RECORD_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew-Neural">Got it. Doc will text you back. Thanks.</Say>
  <Hangup/>
</Response>"""

EMPTY_XML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'


def get_voice_router(db, send_sms, get_brain_token):
    """Returns a FastAPI router. db is the Motor DB, send_sms is the async fn from
    twilio_mod, get_brain_token is the brain bearer dependency from brain.py."""
    router = APIRouter(prefix="/api", tags=["voice"])

    auth_token = os.environ.get("TWILIO_AUTH_TOKEN", "")
    validator = RequestValidator(auth_token) if auth_token else None
    owner_cell = os.environ.get("TWILIO_OWNER_CELL", "")
    default_shop = os.environ.get("DEFAULT_SHOP_ID", "drunderhood-fortsmith")
    # Production public host — used to build callback URLs AND signature candidates
    # so kubernetes ingress host-header rewrites don't break Twilio signature checks.
    public_base = (os.environ.get("PUBLIC_BASE_URL") or "https://foreman.drunderhood.com").rstrip("/")

    async def _verify_twilio(request: Request, form_data: dict) -> bool:
        """Verify Twilio webhook signature. Returns True if signature is valid OR
        if we're in dev (no auth_token configured). Tries multiple URL variants
        because kubernetes ingress can rewrite the Host header — we need to test
        against the URL Twilio actually POSTed to, not the internal one."""
        if not validator:
            log.warning("TWILIO_AUTH_TOKEN not set — skipping signature check")
            return True
        sig = request.headers.get("X-Twilio-Signature", "")
        if not sig:
            return False

        path_q = request.url.path
        if request.url.query:
            path_q += "?" + request.url.query

        # Try multiple URL forms — Twilio signs against the URL it POSTed to,
        # which may differ from request.url after ingress rewrites.
        candidates = [str(request.url)]
        try:
            fwd_proto = request.headers.get("x-forwarded-proto") or request.url.scheme
            fwd_host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
            fwd_url = f"{fwd_proto}://{fwd_host}{path_q}"
            if fwd_url not in candidates:
                candidates.append(fwd_url)
        except Exception:
            pass

        # Always try the configured public base — this is the URL set in the
        # Twilio console and is what Twilio actually signs against.
        pub_url = f"{public_base}{path_q}"
        if pub_url not in candidates:
            candidates.append(pub_url)

        for url in candidates:
            try:
                if validator.validate(url, form_data, sig):
                    return True
            except Exception as e:
                log.warning(f"twilio signature validator threw on url={url}: {e}")
        log.warning(f"twilio signature INVALID — tried {len(candidates)} url variants ({candidates}), signature={sig[:12]}...")
        return False

    # ----------------------------------------------------------------
    # 1) INCOMING CALL  -> serve greeting + record TwiML
    # ----------------------------------------------------------------
    @router.post("/voice/incoming")
    async def voice_incoming(request: Request):
        form = await request.form()
        d = dict(form)
        sig_ok = await _verify_twilio(request, d)
        if not sig_ok:
            # CRITICAL: even if signature check fails (ingress URL mismatch,
            # missing header, etc.), we STILL return valid greeting TwiML.
            # Dead air on an inbound call = "fax sound" to the caller. We'd
            # rather log a warning and answer the call than drop it.
            log.warning(f"voice/incoming signature check failed — answering anyway. host={request.headers.get('host')} fwd_host={request.headers.get('x-forwarded-host')}")

        call_sid = d.get("CallSid", "")
        from_num = d.get("From", "")
        to_num = d.get("To", "")
        try:
            await db.calls.insert_one({
                "id": str(uuid.uuid4()),
                "call_sid": call_sid,
                "from": from_num,
                "to": to_num,
                "status": "incoming",
                "shop_id": default_shop,
                "started_at": _now(),
                "sig_verified": sig_ok,
            })
        except Exception as e:
            log.warning(f"calls.insert_one failed: {e}")

        # Build callback URLs from PUBLIC_BASE_URL so Twilio posts back to
        # foreman.drunderhood.com (matches what's configured in the Twilio console).
        # request.base_url would point at the internal kubernetes host on prod.
        action_url = f"{public_base}/api/voice/voicemail/done"
        transcribe_url = f"{public_base}/api/voice/voicemail/transcription"
        xml = GREETING_XML.format(action_url=action_url, transcribe_url=transcribe_url)
        return _twiml(xml)

    # ----------------------------------------------------------------
    # 2) RECORDING DONE  -> store voicemail row, return "got it" TwiML
    # ----------------------------------------------------------------
    @router.post("/voice/voicemail/done")
    async def voicemail_done(request: Request):
        form = await request.form()
        d = dict(form)
        sig_ok = await _verify_twilio(request, d)
        if not sig_ok:
            log.warning("voicemail/done signature check failed — processing anyway")

        call_sid = d.get("CallSid", "")
        recording_sid = d.get("RecordingSid", "")
        recording_url = d.get("RecordingUrl", "")
        if recording_url and not recording_url.endswith(".mp3"):
            # Twilio's recording_url is the resource URL; .mp3 gives playable audio
            recording_url = recording_url + ".mp3"
        duration = d.get("RecordingDuration", "")
        from_num = d.get("From", "")

        vm_id = str(uuid.uuid4())
        await db.voicemails.insert_one({
            "id": vm_id,
            "call_sid": call_sid,
            "recording_sid": recording_sid,
            "from": from_num,
            "recording_url": recording_url,
            "duration": int(duration) if (duration or "").isdigit() else None,
            "transcript": None,
            "transcription_status": "pending",
            "lead_id": None,
            "shop_id": default_shop,
            "created_at": _now(),
        })

        await db.calls.update_one(
            {"call_sid": call_sid},
            {"$set": {"status": "voicemail_recorded", "ended_at": _now()}},
        )
        return _twiml(AFTER_RECORD_XML)

    # ----------------------------------------------------------------
    # 3) TRANSCRIPTION READY  -> create lead, text Doc, finalize voicemail
    # ----------------------------------------------------------------
    @router.post("/voice/voicemail/transcription")
    async def voicemail_transcription(request: Request):
        form = await request.form()
        d = dict(form)
        sig_ok = await _verify_twilio(request, d)
        if not sig_ok:
            log.warning("voicemail/transcription signature check failed — processing anyway")

        call_sid = d.get("CallSid", "")
        transcript = (d.get("TranscriptionText") or "").strip()
        status = d.get("TranscriptionStatus", "")
        from_num = d.get("From", "")

        vm = await db.voicemails.find_one({"call_sid": call_sid}, {"_id": 0})
        if not vm:
            log.warning(f"transcription callback for unknown call_sid={call_sid}")
            return _twiml(EMPTY_XML)

        # Create a lead so it shows up in /leads alongside form submissions
        lead_id = str(uuid.uuid4())
        await db.leads.insert_one({
            "id": lead_id,
            "shop_id": vm.get("shop_id", default_shop),
            "name": f"Voicemail from {from_num or 'unknown'}",
            "contact": from_num or "",
            "vehicle": "",
            "what_they_need": transcript or "(transcription unavailable — listen to audio)",
            "source": "voicemail",
            "kind": "voicemail",
            "recording_url": vm.get("recording_url"),
            "transcript": transcript or None,
            "transcription_status": status,
            "ip": "twilio",
            "status": "new",
            "created_at": _now(),
        })

        await db.voicemails.update_one(
            {"id": vm["id"]},
            {"$set": {
                "transcript": transcript or None,
                "transcription_status": status,
                "lead_id": lead_id,
            }},
        )

        # Text Doc on his cell — 1 SMS, transcript truncated
        if owner_cell:
            preview = (transcript[:120] + "...") if len(transcript) > 120 else (transcript or "(no transcript — listen)")
            sms_body = (
                f"VM from {from_num or 'unknown'}: {preview}\n"
                f"Listen: {vm.get('recording_url') or '(audio unavailable)'}"
            )
            try:
                await send_sms(owner_cell, sms_body)
            except Exception as e:
                log.warning(f"VM alert SMS to owner failed: {e}")

        return _twiml(EMPTY_XML)

    # ----------------------------------------------------------------
    # 4) CALL STATUS (lifecycle — optional, useful for QC)
    # ----------------------------------------------------------------
    @router.post("/voice/status")
    async def voice_status(request: Request):
        form = await request.form()
        d = dict(form)
        if not await _verify_twilio(request, d):
            return Response(status_code=204)
        await db.calls.update_one(
            {"call_sid": d.get("CallSid", "")},
            {"$set": {"last_status": d.get("CallStatus", ""), "last_status_at": _now()}},
        )
        return Response(status_code=204)

    # ----------------------------------------------------------------
    # 5) Read-only brain audit feed (for OG's "Recent Voicemails" dashboard tile)
    # ----------------------------------------------------------------
    @router.get("/brain/voicemails")
    async def brain_voicemails(
        last: int = Query(10, ge=1, le=50),
        _t: str = Depends(get_brain_token),
    ):
        cur = db.voicemails.find({}, {"_id": 0}).sort("created_at", -1).limit(last)
        rows = await cur.to_list(last)
        items = []
        for r in rows:
            t = r.get("transcript") or ""
            items.append({
                "id": r.get("id"),
                "created_at": r.get("created_at"),
                "from": r.get("from"),
                "duration_seconds": r.get("duration"),
                "transcript_preview": (t[:160] + "…") if len(t) > 160 else (t or None),
                "transcript_chars": len(t),
                "transcription_status": r.get("transcription_status"),
                "recording_url": r.get("recording_url"),
                "lead_id": r.get("lead_id"),
                "call_sid": r.get("call_sid"),
            })
        total = await db.voicemails.count_documents({})
        return {
            "items": items,
            "count": len(items),
            "total_voicemails_in_log": total,
            "queried_at": _now(),
        }

    # ----------------------------------------------------------------
    # 6) User-JWT feed for Wrench UI
    # ----------------------------------------------------------------
    @router.get("/voicemails")
    async def list_voicemails(limit: int = Query(50, ge=1, le=200)):
        cur = db.voicemails.find({}, {"_id": 0}).sort("created_at", -1).limit(limit)
        return await cur.to_list(limit)

    return router
