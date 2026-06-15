"""
Data Wrench — Twilio SMS module.

Single-purpose helper: text Doc when a new lead arrives.
Module-level `send_sms` is fire-and-forget safe — never raises, never blocks.
Silently no-ops if creds missing (so preview env doesn't break when env vars absent).
"""
import os
import logging

log = logging.getLogger("datawrench.twilio")


def _truthy(s):
    return bool(s and s.strip())


def _send_sms_sync(to: str, body: str) -> bool:
    """Synchronous Twilio call. Wrapped in to_thread by callers."""
    sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
    token = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
    from_num = os.environ.get("TWILIO_FROM_NUMBER", "").strip()

    if not (_truthy(sid) and _truthy(token) and _truthy(from_num) and _truthy(to)):
        log.info("twilio creds or to-number missing — skipping SMS")
        return False

    try:
        from twilio.rest import Client  # local import so missing pkg doesn't crash startup
        client = Client(sid, token)
        msg = client.messages.create(
            from_=from_num,
            to=to,
            body=body[:1500],  # SMS-safe truncation
        )
        log.info(f"twilio SMS queued sid={msg.sid} to={to}")
        return True
    except Exception as e:
        log.warning(f"twilio SMS failed to={to}: {e}")
        return False


async def send_sms(to: str, body: str) -> bool:
    """Async wrapper — uses asyncio.to_thread so the blocking Twilio HTTP
    call doesn't block the FastAPI event loop. Never raises."""
    import asyncio
    try:
        return await asyncio.to_thread(_send_sms_sync, to, body)
    except Exception as e:
        log.warning(f"twilio send_sms wrapper crash: {e}")
        return False


async def notify_owner(body: str) -> bool:
    """Convenience: text the shop owner's cell.

    Resolution order:
      1. TWILIO_OWNER_CELL env (legacy)
      2. users.phone field on the first owner-role user (set via /api/settings/cell)
    """
    cell = os.environ.get("TWILIO_OWNER_CELL", "").strip()
    if not _truthy(cell):
        # Fall back to DB user record so Doc doesn't need to fight env vars
        try:
            from motor.motor_asyncio import AsyncIOMotorClient
            mongo_url = os.environ.get("MONGO_URL", "")
            db_name = os.environ.get("DB_NAME", "")
            if mongo_url and db_name:
                cli = AsyncIOMotorClient(mongo_url)
                _db = cli[db_name]
                owner = await _db.users.find_one({"role": "owner", "phone": {"$exists": True, "$nin": [None, ""]}}, {"phone": 1})
                cli.close()
                if owner and owner.get("phone"):
                    cell = owner["phone"].strip()
        except Exception as e:
            log.warning(f"notify_owner db fallback failed: {e}")
    if not _truthy(cell):
        log.info("notify_owner: no owner cell available (env or db) — skipping SMS")
        return False
    return await send_sms(cell, body)
