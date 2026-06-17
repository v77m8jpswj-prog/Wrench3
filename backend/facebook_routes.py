"""
Data Wrench — Facebook Messenger webhook.

When a customer DMs the "DR. Underhood" Facebook Page (or Instagram-linked
@docunderhood), Meta hits this endpoint with the message. We turn each
inbound message into a lead in db.leads so it shows up alongside Doc's
voicemail/web-form/SMS leads. No auto-reply — Doc responds manually in
FB Messenger like he already does.

Routes (mounted under /api/fb):
  GET  /api/fb/webhook   verification handshake (hub.challenge echo)
  POST /api/fb/webhook   event delivery (validates X-Hub-Signature-256)

Required env in backend/.env:
  FB_APP_SECRET          — Facebook App Secret, used to verify HMAC sig
  FB_VERIFY_TOKEN        — any random string you also set in the FB console
  FB_PAGE_ACCESS_TOKEN   — Page Access Token for /me/messages + profile lookup
"""

import os
import hmac
import hashlib
import json
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response

log = logging.getLogger("datawrench.facebook")

GRAPH_VERSION = "v21.0"
GRAPH_BASE = f"https://graph.facebook.com/{GRAPH_VERSION}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _verify_signature(app_secret: str, signature_header: Optional[str], raw_body: bytes) -> bool:
    """Validate Meta's X-Hub-Signature-256 header. Returns True if the HMAC
    matches, False otherwise. Constant-time comparison."""
    if not signature_header or not app_secret:
        return False
    try:
        algo, received = signature_header.split("=", 1)
    except ValueError:
        return False
    if algo != "sha256":
        return False
    expected = hmac.new(
        key=app_secret.encode("utf-8"),
        msg=raw_body,
        digestmod=hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, received)


async def _fetch_sender_profile(psid: str, page_token: str) -> dict:
    """Look up the sender's name via Graph API. Returns {} on any failure
    (network, permissions, rate-limit) so lead creation never blocks."""
    if not psid or not page_token:
        return {}
    try:
        async with httpx.AsyncClient(timeout=6.0) as cli:
            r = await cli.get(
                f"{GRAPH_BASE}/{psid}",
                params={"fields": "first_name,last_name,name,profile_pic", "access_token": page_token},
            )
        if r.status_code == 200:
            return r.json() or {}
        log.warning(f"fb profile lookup {r.status_code} for PSID={psid[:6]}...: {r.text[:200]}")
    except Exception as e:
        log.warning(f"fb profile lookup failed for PSID={psid[:6]}...: {e}")
    return {}


def get_facebook_router(db, get_user=None) -> APIRouter:
    """Factory. `get_user` is optional — the webhook routes are intentionally
    unauthenticated (Meta posts unsigned-by-our-JWT) but signature-verified."""
    router = APIRouter(prefix="/api", tags=["facebook"])

    verify_token = os.environ.get("FB_VERIFY_TOKEN", "")
    app_secret = os.environ.get("FB_APP_SECRET", "")
    page_token = os.environ.get("FB_PAGE_ACCESS_TOKEN", "")
    default_shop = os.environ.get("DEFAULT_SHOP_ID", "drunderhood-fortsmith")

    # --------------------------------------------------------------
    # 1) VERIFICATION HANDSHAKE
    # --------------------------------------------------------------
    @router.get("/fb/webhook")
    async def fb_verify(request: Request):
        mode = request.query_params.get("hub.mode")
        token = request.query_params.get("hub.verify_token")
        challenge = request.query_params.get("hub.challenge")
        if not verify_token:
            log.error("fb_verify: FB_VERIFY_TOKEN not configured in env")
            raise HTTPException(500, "fb verify token not configured")
        if mode == "subscribe" and token == verify_token:
            # Meta requires the raw challenge string back, not JSON.
            return PlainTextResponse(content=challenge or "")
        log.warning(f"fb_verify rejected: mode={mode} token_match={token == verify_token}")
        raise HTTPException(403, "verify_token mismatch")

    # --------------------------------------------------------------
    # 2) EVENT DELIVERY
    # --------------------------------------------------------------
    @router.post("/fb/webhook")
    async def fb_event(
        request: Request,
        x_hub_signature_256: Optional[str] = Header(None, alias="X-Hub-Signature-256"),
    ):
        raw = await request.body()

        # Verify HMAC. In dev (no FB_APP_SECRET set) we log a loud warning
        # and accept — this lets us curl-test the route, but production
        # MUST have the secret configured or every event will be rejected.
        if app_secret:
            if not _verify_signature(app_secret, x_hub_signature_256, raw):
                log.warning("fb_event rejected: invalid X-Hub-Signature-256")
                raise HTTPException(401, "invalid signature")
        else:
            log.warning("fb_event: FB_APP_SECRET not configured — accepting unsigned event (DEV ONLY)")

        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            raise HTTPException(400, "invalid json")

        obj = payload.get("object")
        # 'page' = Messenger; 'instagram' = IG DMs (same webhook can receive both).
        if obj not in ("page", "instagram"):
            return {"status": "ignored", "object": obj}

        created = 0
        for entry in payload.get("entry", []) or []:
            for ev in (entry.get("messaging") or []):
                msg = ev.get("message") or {}
                # Skip non-message events (delivery receipts, postbacks, read,
                # message_echo from our own outgoing replies).
                if not msg or msg.get("is_echo"):
                    continue
                psid = (ev.get("sender") or {}).get("id") or ""
                page_id = (ev.get("recipient") or {}).get("id") or entry.get("id") or ""
                mid = msg.get("mid") or ""
                text = (msg.get("text") or "").strip()
                attachments = msg.get("attachments") or []
                if not psid:
                    continue

                # Idempotency: don't create dupe leads if Meta retries delivery.
                if mid:
                    existing = await db.leads.find_one({"source": ("instagram_dm" if obj == "instagram" else "facebook_dm"), "fb_mid": mid}, {"id": 1})
                    if existing:
                        continue

                profile = await _fetch_sender_profile(psid, page_token)
                full_name = profile.get("name") or " ".join(filter(None, [profile.get("first_name"), profile.get("last_name")])).strip()
                display_name = full_name or f"FB user {psid[:8]}"

                # Pull the first image/file attachment URL into recording_url-equiv
                # so the leads UI can render it inline if it wants to.
                attachment_url = None
                for a in attachments:
                    p = (a or {}).get("payload") or {}
                    if p.get("url"):
                        attachment_url = p["url"]
                        break

                what_they_need = text or (f"[{attachments[0].get('type','attachment')} attachment]" if attachments else "(empty message)")

                lead = {
                    "id": str(uuid.uuid4()),
                    "shop_id": default_shop,
                    "name": display_name,
                    "contact": "",  # FB doesn't expose email/phone; Doc gets it via Messenger conversation
                    "vehicle": "",
                    "what_they_need": what_they_need,
                    "source": "instagram_dm" if obj == "instagram" else "facebook_dm",
                    "kind": "facebook_dm" if obj == "page" else "instagram_dm",
                    "fb_psid": psid,
                    "fb_page_id": page_id,
                    "fb_mid": mid or None,
                    "fb_profile_pic": profile.get("profile_pic") or None,
                    "fb_attachment_url": attachment_url,
                    "fb_attachments_full": attachments or None,
                    "ip": "facebook",
                    "status": "new",
                    "created_at": _now(),
                }
                try:
                    await db.leads.insert_one(lead)
                    created += 1
                    log.info(f"fb lead created from PSID={psid[:8]}... obj={obj} text_len={len(text)}")
                except Exception as e:
                    log.warning(f"fb lead insert failed: {e}")

        # Meta requires a fast 200. Returning 204 also works — we use 200 with
        # a small JSON body so debugging via curl is friendlier.
        return {"status": "ok", "created": created}

    # --------------------------------------------------------------
    # 3) DEBUG PING — handy for Doc to verify env is wired correctly.
    #    Returns whether secrets are present, never echoes them.
    # --------------------------------------------------------------
    @router.get("/fb/health")
    async def fb_health():
        return {
            "ok": True,
            "has_verify_token": bool(verify_token),
            "has_app_secret": bool(app_secret),
            "has_page_access_token": bool(page_token),
            "graph_version": GRAPH_VERSION,
            "webhook_url_path": "/api/fb/webhook",
        }

    return router
