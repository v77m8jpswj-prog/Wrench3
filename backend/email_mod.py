"""
Data Wrench — EMAIL module (Microsoft 365 / Outlook via Microsoft Graph)

Lets Doc connect his GoDaddy-hosted Outlook mailbox (doc@drunderhood.com) and
have Wrench read, write, send, and triage emails.

Auth: OAuth 2.0 authorization code flow with PKCE. Tokens stored server-side
in db.email_accounts, scoped per (user_id, shop_id, provider).

Endpoints:
  GET  /api/email/oauth/start          -> returns Microsoft consent URL
  GET  /api/email/oauth/callback       -> Microsoft redirects here w/ ?code=
  GET  /api/email/status               -> is the inbox connected?
  GET  /api/email/messages             -> list inbox (top=N, unread_only)
  GET  /api/email/messages/{id}        -> get full message body
  POST /api/email/messages/{id}/read   -> mark read/unread
  POST /api/email/messages/{id}/reply  -> reply (body_html or comment)
  POST /api/email/messages/{id}/move   -> move to folder (default Archive)
  POST /api/email/send                 -> compose + send new email
  GET  /api/email/search?q=...         -> $search the mailbox
  POST /api/email/draft-reply/{id}     -> Wrench drafts a reply using the
                                          message body + shop persona (no send)
  POST /api/email/disconnect           -> kill the stored tokens
"""
import os
import base64
import hashlib
import secrets
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, List
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Depends, Request, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr

log = logging.getLogger("datawrench.email")

BRAIN_TOKEN = os.environ.get("BRAIN_INGRESS_TOKEN", "")
MS_AUTHORITY = os.environ.get("MS_AUTHORITY", "https://login.microsoftonline.com/common")
MS_CLIENT_ID = os.environ.get("MS_CLIENT_ID", "")
MS_CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET", "")
MS_REDIRECT_URI = os.environ.get("MS_REDIRECT_URI", "")
FRONTEND_BASE_URL = os.environ.get("FRONTEND_BASE_URL", "")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
DEFAULT_SHOP_ID = os.environ.get("DEFAULT_SHOP_ID", "drunderhood-fortsmith")
GRAPH = "https://graph.microsoft.com/v1.0"

MS_SCOPES = (
    "openid email profile offline_access "
    "Mail.Read Mail.Send Mail.ReadWrite User.Read"
)


# ============ Models ============
class Recipient(BaseModel):
    email: EmailStr
    name: Optional[str] = ""


class SendReq(BaseModel):
    subject: str
    body_html: str
    to: List[Recipient]
    cc: Optional[List[Recipient]] = []
    save_to_sent: bool = True


class ReplyReq(BaseModel):
    body_html: Optional[str] = None
    comment: Optional[str] = None  # plain-text quick reply
    reply_all: bool = False


class MoveReq(BaseModel):
    destination: str = "archive"  # "archive" | "deleteditems" | folder id


class ReadReq(BaseModel):
    is_read: bool = True


class DraftReplyReq(BaseModel):
    instructions: Optional[str] = ""  # extra steering for Wrench (optional)


# ============ Helpers ============
def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _gen_verifier(n: int = 64) -> str:
    return _b64url(secrets.token_bytes(n))


def _challenge(verifier: str) -> str:
    return _b64url(hashlib.sha256(verifier.encode()).digest())


def _derive_base_url(request: Request) -> str:
    """Build the public base URL from the inbound request, honoring proxy headers.
    Works for both preview and prod without depending on a fragile env var.
    """
    # k8s ingress / cloudflare style forwarding
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    # take only the first host if multiple
    host = host.split(",")[0].strip()
    return f"{proto}://{host}".rstrip("/")


def _derive_redirect_uri(request: Request) -> str:
    base = _derive_base_url(request)
    return f"{base}/api/email/oauth/callback"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _well_known_folder(name: str) -> str:
    """Microsoft Graph well-known folder names. Pass these in place of an id."""
    mapping = {
        "archive": "archive",
        "deleteditems": "deleteditems",
        "deleted": "deleteditems",
        "trash": "deleteditems",
        "inbox": "inbox",
        "junkemail": "junkemail",
        "spam": "junkemail",
        "drafts": "drafts",
        "sentitems": "sentitems",
    }
    return mapping.get(name.lower(), name)


async def notify_shop(db, shop_id: str, subject: str, body_html: str,
                      to_override: Optional[str] = None) -> bool:
    """Module-level helper: send a notification email FROM the shop's connected
    Outlook mailbox TO itself (or to a different address if to_override given).
    Used for lead-form pings, alerts, etc. Fire-and-forget; never raises.
    Returns True on success, False on any failure."""
    try:
        acct = await db.email_accounts.find_one({"shop_id": shop_id, "provider": "microsoft"})
        if not acct:
            log.info(f"notify_shop({shop_id}): no mailbox connected, skipping")
            return False
        if not MS_CLIENT_ID or not MS_CLIENT_SECRET:
            log.warning("notify_shop: MS creds missing")
            return False
        # Refresh token if needed
        exp = acct.get("expires_at")
        if isinstance(exp, str):
            try:
                exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            except Exception:
                exp = None
        if not (exp and _now() + timedelta(minutes=5) < exp):
            rt = acct.get("refresh_token")
            if not rt:
                log.warning(f"notify_shop({shop_id}): no refresh token")
                return False
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(f"{MS_AUTHORITY}/oauth2/v2.0/token", data={
                    "client_id": MS_CLIENT_ID, "client_secret": MS_CLIENT_SECRET,
                    "grant_type": "refresh_token", "refresh_token": rt, "scope": MS_SCOPES,
                })
            if r.status_code != 200:
                log.warning(f"notify_shop refresh failed: {r.status_code} {r.text[:200]}")
                return False
            tk = r.json()
            new_exp = _now() + timedelta(seconds=int(tk.get("expires_in", 3600)))
            patch = {"access_token": tk["access_token"], "refresh_token": tk.get("refresh_token", rt),
                     "expires_at": new_exp.isoformat(), "updated_at": _now().isoformat()}
            await db.email_accounts.update_one({"_id": acct["_id"]}, {"$set": patch})
            acct.update(patch)

        to_addr = (to_override or acct.get("account_email") or "").strip()
        if not to_addr:
            log.warning(f"notify_shop({shop_id}): no destination address")
            return False
        msg = {
            "subject": subject,
            "body": {"contentType": "HTML", "content": body_html},
            "toRecipients": [{"emailAddress": {"address": to_addr}}],
        }
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                f"{GRAPH}/me/sendMail",
                headers={"Authorization": f"Bearer {acct['access_token']}",
                         "Content-Type": "application/json"},
                json={"message": msg, "saveToSentItems": False},
            )
        if r.status_code in (200, 201, 202, 204):
            return True
        log.warning(f"notify_shop send failed: {r.status_code} {r.text[:200]}")
        return False
    except Exception as e:
        log.exception(f"notify_shop({shop_id}) crashed: {e}")
        return False



# ============ Router factory ============
def make_email_router(db, get_user):
    router = APIRouter()

    async def _refresh_if_needed(acct: Dict[str, Any]) -> Dict[str, Any]:
        """Ensure acct has a valid access_token. Refreshes if within 5 min of expiry."""
        if not MS_CLIENT_ID or not MS_CLIENT_SECRET:
            raise HTTPException(503, "Email integration not configured. Set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI in backend env.")
        exp = acct.get("expires_at")
        if isinstance(exp, str):
            try:
                exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            except Exception:
                exp = None
        if exp and _now() + timedelta(minutes=5) < exp:
            return acct
        rt = acct.get("refresh_token")
        if not rt:
            raise HTTPException(401, "Email account needs to be reconnected (no refresh token).")
        data = {
            "client_id": MS_CLIENT_ID,
            "client_secret": MS_CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "scope": MS_SCOPES,
        }
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{MS_AUTHORITY}/oauth2/v2.0/token", data=data)
        if r.status_code != 200:
            log.warning(f"refresh failed {r.status_code} {r.text[:300]}")
            raise HTTPException(401, "Microsoft rejected the refresh token. Reconnect the inbox.")
        tk = r.json()
        new_exp = _now() + timedelta(seconds=int(tk.get("expires_in", 3600)))
        patch = {
            "access_token": tk["access_token"],
            "refresh_token": tk.get("refresh_token", rt),
            "expires_at": new_exp.isoformat(),
            "scope": tk.get("scope", acct.get("scope", MS_SCOPES)),
            "updated_at": _now().isoformat(),
        }
        await db.email_accounts.update_one({"_id": acct["_id"]}, {"$set": patch})
        acct.update(patch)
        return acct

    async def _get_account(user) -> Dict[str, Any]:
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        acct = await db.email_accounts.find_one({"user_id": user["id"], "shop_id": sid, "provider": "microsoft"})
        if not acct:
            raise HTTPException(404, "No inbox connected yet. Hit CONNECT INBOX on the Email page.")
        return await _refresh_if_needed(acct)

    async def _graph(method: str, path: str, token: str, *, params=None, json=None) -> Any:
        headers = {"Authorization": f"Bearer {token}"}
        if json is not None:
            headers["Content-Type"] = "application/json"
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.request(method, f"{GRAPH}{path}", headers=headers, params=params, json=json)
        if r.status_code in (200, 201):
            return r.json()
        if r.status_code == 202 or r.status_code == 204:
            return {"ok": True}
        log.warning(f"graph {method} {path} -> {r.status_code} {r.text[:300]}")
        raise HTTPException(r.status_code, f"Outlook said: {r.text[:200]}")

    # ----- Status -----
    @router.get("/email/status")
    async def email_status(request: Request, user=Depends(get_user)):
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        acct = await db.email_accounts.find_one({"user_id": user["id"], "shop_id": sid, "provider": "microsoft"})
        return {
            "connected": bool(acct),
            "account_email": (acct or {}).get("account_email", ""),
            "connected_at": (acct or {}).get("created_at", ""),
            "configured": bool(MS_CLIENT_ID and MS_CLIENT_SECRET),
            "redirect_uri": _derive_redirect_uri(request),
        }

    # ----- OAuth start -----
    @router.get("/email/oauth/start")
    async def oauth_start(request: Request, user=Depends(get_user)):
        if not MS_CLIENT_ID:
            raise HTTPException(503, "Email integration not configured yet. Tell Doc to set MS_CLIENT_ID in backend env.")
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        state = secrets.token_urlsafe(32)
        verifier = _gen_verifier()
        redirect_uri = _derive_redirect_uri(request)
        base_url = _derive_base_url(request)
        await db.email_oauth_states.insert_one({
            "state": state,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
            "base_url": base_url,
            "user_id": user["id"],
            "shop_id": sid,
            "created_at": _now().isoformat(),
            "expires_at": (_now() + timedelta(minutes=15)).isoformat(),
        })
        params = {
            "client_id": MS_CLIENT_ID,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "response_mode": "query",
            "scope": MS_SCOPES,
            "state": state,
            "code_challenge": _challenge(verifier),
            "code_challenge_method": "S256",
            "prompt": "select_account",
        }
        return {"authorization_url": f"{MS_AUTHORITY}/oauth2/v2.0/authorize?{urlencode(params)}"}

    # ----- OAuth callback (Microsoft redirects here) -----
    @router.get("/email/oauth/callback")
    async def oauth_callback(request: Request, code: Optional[str] = None, state: Optional[str] = None,
                             error: Optional[str] = None, error_description: Optional[str] = None):
        # Best-effort: figure out where to redirect Doc when this is done.
        # Prefer the base url stashed at oauth_start so we land on the SAME env (prod/preview).
        st = None
        if state:
            st = await db.email_oauth_states.find_one_and_delete({"state": state})
        front = (st or {}).get("base_url") or _derive_base_url(request) or FRONTEND_BASE_URL or "/"
        if error:
            return RedirectResponse(url=f"{front}/email?status=error&msg={error}")
        if not code or not state:
            return RedirectResponse(url=f"{front}/email?status=error&msg=missing_code")
        if not st:
            return RedirectResponse(url=f"{front}/email?status=error&msg=bad_state")
        redirect_uri = st.get("redirect_uri") or _derive_redirect_uri(request)
        data = {
            "client_id": MS_CLIENT_ID,
            "client_secret": MS_CLIENT_SECRET,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": st["code_verifier"],
            "scope": MS_SCOPES,
        }
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{MS_AUTHORITY}/oauth2/v2.0/token", data=data)
        if r.status_code != 200:
            log.warning(f"token exchange failed {r.status_code} {r.text[:400]}")
            return RedirectResponse(url=f"{front}/email?status=error&msg=token_exchange")
        tk = r.json()
        access_token = tk["access_token"]
        # Pull /me to get the actual mailbox
        async with httpx.AsyncClient(timeout=20) as c:
            me = await c.get(f"{GRAPH}/me",
                             headers={"Authorization": f"Bearer {access_token}"})
        me_json = me.json() if me.status_code == 200 else {}
        account_email = me_json.get("mail") or me_json.get("userPrincipalName") or ""
        expires_at = _now() + timedelta(seconds=int(tk.get("expires_in", 3600)))
        doc = {
            "user_id": st["user_id"],
            "shop_id": st["shop_id"],
            "provider": "microsoft",
            "tenant_id": me_json.get("tenantId", ""),
            "account_email": account_email,
            "display_name": me_json.get("displayName", ""),
            "access_token": access_token,
            "refresh_token": tk.get("refresh_token", ""),
            "expires_at": expires_at.isoformat(),
            "scope": tk.get("scope", MS_SCOPES),
            "created_at": _now().isoformat(),
            "updated_at": _now().isoformat(),
        }
        await db.email_accounts.update_one(
            {"user_id": st["user_id"], "shop_id": st["shop_id"], "provider": "microsoft"},
            {"$set": doc},
            upsert=True,
        )
        return RedirectResponse(url=f"{front}/email?status=connected&email={account_email}")

    # ----- Disconnect -----
    @router.post("/email/disconnect")
    async def disconnect(user=Depends(get_user)):
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        r = await db.email_accounts.delete_one({"user_id": user["id"], "shop_id": sid, "provider": "microsoft"})
        return {"disconnected": r.deleted_count > 0}

    # ----- List messages -----
    @router.get("/email/messages")
    async def list_messages(
        top: int = Query(25, ge=1, le=100),
        unread_only: bool = False,
        folder: str = Query("inbox", description="Folder well-known name or id"),
        user=Depends(get_user),
    ):
        acct = await _get_account(user)
        params = {
            "$top": top,
            "$orderby": "receivedDateTime desc",
            "$select": "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,importance",
        }
        if unread_only:
            params["$filter"] = "isRead eq false"
        path = f"/me/mailFolders/{_well_known_folder(folder)}/messages"
        data = await _graph("GET", path, acct["access_token"], params=params)
        return {
            "account_email": acct.get("account_email", ""),
            "folder": folder,
            "count": len(data.get("value", [])),
            "messages": data.get("value", []),
        }

    @router.get("/email/messages/{message_id}")
    async def get_message(message_id: str, user=Depends(get_user)):
        acct = await _get_account(user)
        data = await _graph("GET", f"/me/messages/{message_id}", acct["access_token"],
                            params={"$select": "id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,body,hasAttachments,conversationId,importance"})
        return data

    @router.post("/email/messages/{message_id}/read")
    async def mark_read(message_id: str, body: ReadReq, user=Depends(get_user)):
        acct = await _get_account(user)
        await _graph("PATCH", f"/me/messages/{message_id}", acct["access_token"],
                     json={"isRead": body.is_read})
        return {"ok": True, "is_read": body.is_read}

    @router.post("/email/messages/{message_id}/reply")
    async def reply(message_id: str, body: ReplyReq, user=Depends(get_user)):
        acct = await _get_account(user)
        payload: Dict[str, Any] = {}
        if body.body_html:
            payload["message"] = {"body": {"contentType": "HTML", "content": body.body_html}}
        elif body.comment:
            payload["comment"] = body.comment
        else:
            raise HTTPException(400, "Need either body_html or comment.")
        endpoint = "replyAll" if body.reply_all else "reply"
        await _graph("POST", f"/me/messages/{message_id}/{endpoint}", acct["access_token"], json=payload)
        return {"ok": True, "sent": True}

    @router.post("/email/messages/{message_id}/move")
    async def move(message_id: str, body: MoveReq, user=Depends(get_user)):
        acct = await _get_account(user)
        dest = _well_known_folder(body.destination)
        data = await _graph("POST", f"/me/messages/{message_id}/move",
                            acct["access_token"], json={"destinationId": dest})
        return {"ok": True, "moved_to": dest, "new_id": data.get("id")}

    @router.delete("/email/messages/{message_id}")
    async def delete_email(message_id: str, user=Depends(get_user)):
        """Move the email to Deleted Items via Microsoft Graph. Doc uses this
        to clear spam/yelp/junk. Not a permanent purge — recoverable from the
        Outlook Deleted Items folder for 30 days."""
        acct = await _get_account(user)
        try:
            await _graph("DELETE", f"/me/messages/{message_id}", acct["access_token"])
        except Exception as e:
            # Common failure: token expired/revoked, or message already deleted.
            # Reraise with a clearer message so the UI can surface it.
            raise HTTPException(502, f"outlook delete failed: {e}")
        # Also remove the cached row in our DB if we have one, so it disappears
        # from /email and the unified inbox immediately.
        try:
            await db.emails.delete_one({"id": message_id})
        except Exception:
            pass
        return {"ok": True, "deleted": 1}

    # ----- Compose + send -----
    @router.post("/email/send")
    async def send(body: SendReq, user=Depends(get_user)):
        acct = await _get_account(user)
        msg = {
            "subject": body.subject,
            "body": {"contentType": "HTML", "content": body.body_html},
            "toRecipients": [{"emailAddress": {"address": r.email, "name": r.name or ""}} for r in body.to],
        }
        if body.cc:
            msg["ccRecipients"] = [{"emailAddress": {"address": r.email, "name": r.name or ""}} for r in body.cc]
        await _graph("POST", "/me/sendMail", acct["access_token"],
                     json={"message": msg, "saveToSentItems": body.save_to_sent})
        return {"ok": True, "sent": True}

    async def _ingest_message_for_account(user_id: str, acct: Dict[str, Any], mid: str) -> Dict[str, Any]:
        """Pull a single message (by Graph id) into library_chunks. Used by both
        the manual INGEST endpoint and the background AUTO-INGEST loop.
        Dedupe by source_msg_id — skip if we've already ingested this message."""
        import re as _re
        import httpx as _httpx
        from bs4 import BeautifulSoup as _BS

        # Dedupe — already ingested?
        existing = await db.library_items.find_one(
            {"user_id": user_id, "source_msg_id": mid},
            {"id": 1}
        )
        if existing:
            return {"ok": True, "skipped": "already_ingested", "item_id": existing.get("id"), "subject": "", "email_chars": 0, "links_found": 0, "links_ingested": 0, "links": []}

        msg = await _graph("GET", f"/me/messages/{mid}", acct["access_token"])
        subject = msg.get("subject", "(no subject)")
        sender = (msg.get("from", {}) or {}).get("emailAddress", {}).get("address", "")
        body_obj = msg.get("body", {}) or {}
        body_html = body_obj.get("content", "")
        try:
            text = _BS(body_html, "html.parser").get_text(" ", strip=True)
        except Exception:
            text = body_html
        text = _re.sub(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff\xa0]+", " ", text)
        text = _re.sub(r"\s+", " ", text).strip()

        item_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        await db.library_items.insert_one({
            "id": item_id, "user_id": user_id, "name": f"[Email] {subject}",
            "kind": "email", "size": len(text), "status": "ready",
            "chunk_count": 1, "source": "outlook-ingest",
            "source_label": sender, "source_msg_id": mid, "created_at": now,
        })
        await db.library_chunks.insert_one({
            "id": str(uuid.uuid4()), "user_id": user_id, "item_id": item_id,
            "source": f"Email from {sender}: {subject}", "text": text[:50000],
            "created_at": now,
        })

        urls = list(set(_re.findall(r"https?://[^\s<>\"']+", body_html)))
        bad_substr = ["unsubscribe","mailto:","tracking","click.","beacon","pixel"]
        bad_ext = (".png",".jpg",".jpeg",".gif",".webp",".svg",".ico",".bmp",
                   ".pdf",".zip",".dmg",".exe",".mp4",".mp3",".css",".js",".woff",".ttf")
        def _ok(u):
            ul = u.lower().split("?")[0].split("#")[0]
            if any(b in u.lower() for b in bad_substr):
                return False
            if ul.endswith(bad_ext):
                return False
            return True
        urls = [u for u in urls if _ok(u)][:10]
        fetched = []
        async with _httpx.AsyncClient(timeout=15, follow_redirects=True) as c:
            for u in urls:
                try:
                    r = await c.get(u, headers={"User-Agent": "WrenchBot/1.0"})
                    if r.status_code != 200:
                        continue
                    ctype = (r.headers.get("content-type") or "").lower()
                    if not ("text/html" in ctype or "text/plain" in ctype or "application/xhtml" in ctype):
                        continue
                    ptext = _BS(r.text, "html.parser").get_text(" ", strip=True)
                    ptext = _re.sub(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff\xa0]+", " ", ptext)
                    ptext = _re.sub(r"\s+", " ", ptext).strip()[:50000]
                    if not ptext or len(ptext) < 100:
                        continue
                    await db.library_chunks.insert_one({
                        "id": str(uuid.uuid4()), "user_id": user_id, "item_id": item_id,
                        "source": f"Link from email '{subject}': {u}",
                        "text": ptext, "created_at": now,
                    })
                    fetched.append(u)
                except Exception:
                    pass
        await db.library_items.update_one({"id": item_id}, {"$set": {"chunk_count": 1 + len(fetched)}})

        # ---- URGENT detector + business-hours ping ----
        urgent_rx = _re.compile(r"\b(won'?t start|wont start|stuck|stranded|towed|emergency|urgent|asap|right away|broke down|broken down|breakdown|critical|smoking|on fire|leaking (fuel|gas|coolant)|flatbed)\b", _re.I)
        is_urgent = bool(urgent_rx.search(subject) or urgent_rx.search(text[:4000]))
        if is_urgent:
            try:
                urgent_id = str(uuid.uuid4())
                from datetime import datetime as _dt
                hour_utc = _dt.utcnow().hour
                in_window = (hour_utc >= 11) or (hour_utc < 3)  # 6am-10pm Central
                delivered = False
                if in_window:
                    owner = await db.users.find_one({"role": "owner", "phone": {"$exists": True, "$nin": [None, ""]}})
                    if owner and owner.get("phone"):
                        try:
                            from sms_routes import twilio_send_sms
                            await twilio_send_sms(
                                owner["phone"],
                                f"URGENT EMAIL - {sender[:30]} - {subject[:80]} - foreman.drunderhood.com/email"
                            )
                            delivered = True
                        except Exception:
                            log.exception("urgent SMS ping failed")
                await db.urgent_emails.insert_one({
                    "id": urgent_id, "user_id": user_id, "item_id": item_id,
                    "subject": subject, "sender": sender,
                    "detected_at": now, "delivered": delivered,
                    "delivered_at": now if delivered else None,
                })
            except Exception:
                log.exception("urgent detection failed")

        # ---- Auto-summarize: Claude writes a 3-line gist + stashes it as its own chunk ----
        # Pinned at the top of search results because the source line starts with "GIST:"
        summary_text = ""
        if text and len(text) > 200 and EMERGENT_LLM_KEY:
            try:
                from emergentintegrations.llm.chat import LlmChat, UserMessage
                sys_prompt = (
                    "You are Wrench, a gruff old-school mechanic giving Doc a quick read on an email. "
                    "Return exactly 3 short lines, no markdown, no asterisks, no preamble:\n"
                    "Line 1: WHAT IT IS - one sentence.\n"
                    "Line 2: WHAT THEY WANT - one sentence.\n"
                    "Line 3: WHAT TO DO - one short verb-led suggestion or 'nothing - junk/info only.'\n"
                    "Plain text only. Be terse."
                )
                chat = LlmChat(
                    api_key=EMERGENT_LLM_KEY,
                    session_id=f"ingest-summary-{item_id[:8]}",
                    system_message=sys_prompt,
                ).with_model("anthropic", "claude-sonnet-4-5-20250929")
                summary_text = await chat.send_message(UserMessage(
                    text=f"From: {sender}\nSubject: {subject}\n\n{text[:8000]}"
                ))
                summary_text = _re.sub(r"\*+", "", (summary_text or "")).strip()
                if summary_text:
                    await db.library_chunks.insert_one({
                        "id": str(uuid.uuid4()),
                        "user_id": user_id,
                        "item_id": item_id,
                        "source": f"GIST: {subject}",
                        "text": f"Wrench's 3-line gist of email from {sender} — subject: {subject}\n\n{summary_text}",
                        "created_at": now,
                    })
                    await db.library_items.update_one(
                        {"id": item_id},
                        {"$set": {"summary": summary_text, "chunk_count": 1 + len(fetched) + 1}}
                    )
            except Exception:
                log.exception(f"auto-summarize on ingest failed for item {item_id}")

        return {
            "ok": True, "item_id": item_id, "subject": subject, "sender": sender,
            "email_chars": len(text), "links_found": len(urls),
            "links_ingested": len(fetched), "links": fetched,
            "summary": summary_text,
        }

    @router.post("/email/messages/{mid}/ingest")
    async def ingest_email(mid: str, user=Depends(get_user)):
        """Pull email body + any links inside into Wrench's brain (library)."""
        acct = await _get_account(user)
        return await _ingest_message_for_account(user["id"], acct, mid)

    @router.post("/email/messages/{mid}/summarize")
    async def summarize_email(mid: str, user=Depends(get_user)):
        """Wrench reads the email and spits back a 3-line gist. No corporate
        fluff — what it is, what they want, what to do."""
        import re as _re
        from bs4 import BeautifulSoup as _BS
        acct = await _get_account(user)
        msg = await _graph("GET", f"/me/messages/{mid}", acct["access_token"])
        subject = msg.get("subject", "(no subject)")
        sender = (msg.get("from", {}) or {}).get("emailAddress", {}).get("address", "")
        body_html = (msg.get("body", {}) or {}).get("content", "")
        try:
            text = _BS(body_html, "html.parser").get_text(" ", strip=True)
        except Exception:
            text = body_html
        text = _re.sub(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff\xa0]+", " ", text)
        text = _re.sub(r"\s+", " ", text).strip()[:8000]
        if not text:
            return {"summary": "(empty email body — nothing to summarize)"}

        sys_prompt = (
            "You are Wrench, a gruff old-school mechanic giving Doc a quick read on an email. "
            "Return exactly 3 short lines, no markdown, no asterisks, no preamble:\n"
            "Line 1: WHAT IT IS - one sentence, what kind of email this is.\n"
            "Line 2: WHAT THEY WANT - what action they are asking for.\n"
            "Line 3: WHAT TO DO - one short verb-led suggestion for Doc. "
            "If nothing needs doing, say 'nothing - junk/info only.'\n"
            "Plain text only. No greetings, no signoffs, no apologies. Be terse."
        )
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"summary-{mid[:8]}",
            system_message=sys_prompt,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        try:
            summary = await chat.send_message(UserMessage(
                text=f"From: {sender}\nSubject: {subject}\n\n{text}"
            ))
        except Exception as e:
            raise HTTPException(500, f"Wrench couldn't read that one: {e}")
        summary = _re.sub(r"\*+", "", summary or "").strip()
        return {"message_id": mid, "subject": subject, "sender": sender, "summary": summary}

    # ----- Auto-ingest rules (pattern-matched background ingest) -----
    class IngestRuleReq(BaseModel):
        sender_pattern: Optional[str] = ""   # substring on from.emailAddress.address (case-insensitive)
        subject_pattern: Optional[str] = ""  # substring on subject (case-insensitive)
        label: Optional[str] = ""            # human label like "AutoLeap ROs"

    @router.get("/email/ingest-rules")
    async def list_ingest_rules(user=Depends(get_user)):
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        cur = db.email_ingest_rules.find({"user_id": user["id"], "shop_id": sid}, {"_id": 0}).sort("created_at", -1)
        rules = await cur.to_list(200)
        return {"rules": rules}

    @router.post("/email/ingest-rules")
    async def create_ingest_rule(body: IngestRuleReq, user=Depends(get_user)):
        sender = (body.sender_pattern or "").strip().lower()
        subject = (body.subject_pattern or "").strip().lower()
        if not sender and not subject:
            raise HTTPException(400, "Need at least a sender_pattern or subject_pattern.")
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        rule_id = uuid.uuid4().hex
        doc = {
            "id": rule_id,
            "user_id": user["id"],
            "shop_id": sid,
            "sender_pattern": sender,
            "subject_pattern": subject,
            "label": (body.label or "").strip() or (f"From: {sender}" if sender else f"Subject: {subject}"),
            "enabled": True,
            "created_at": _now().isoformat(),
            "last_run_at": None,
            "ingest_count": 0,
        }
        await db.email_ingest_rules.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/email/ingest-rules/{rule_id}/toggle")
    async def toggle_ingest_rule(rule_id: str, user=Depends(get_user)):
        rule = await db.email_ingest_rules.find_one({"id": rule_id, "user_id": user["id"]})
        if not rule:
            raise HTTPException(404, "Rule not found.")
        new_state = not bool(rule.get("enabled", True))
        await db.email_ingest_rules.update_one({"id": rule_id}, {"$set": {"enabled": new_state}})
        return {"ok": True, "enabled": new_state}

    @router.delete("/email/ingest-rules/{rule_id}")
    async def delete_ingest_rule(rule_id: str, user=Depends(get_user)):
        r = await db.email_ingest_rules.delete_one({"id": rule_id, "user_id": user["id"]})
        if r.deleted_count == 0:
            raise HTTPException(404, "Rule not found.")
        return {"ok": True, "deleted": True}

    async def auto_ingest_run_once() -> Dict[str, Any]:
        """One pass across ALL users' enabled rules. Called by scheduler loop."""
        report = {"rules_checked": 0, "messages_ingested": 0, "errors": 0}
        rules_cur = db.email_ingest_rules.find({"enabled": True}, {"_id": 0})
        rules = await rules_cur.to_list(1000)
        # Group by user to avoid hitting Graph multiple times per user
        by_user: Dict[str, list] = {}
        for r in rules:
            by_user.setdefault(r["user_id"], []).append(r)
        for user_id, user_rules in by_user.items():
            try:
                acct = await db.email_accounts.find_one({"user_id": user_id, "provider": "microsoft"})
                if not acct:
                    continue
                acct = await _refresh_if_needed(acct)
                # Pull 50 most recent messages from inbox
                data = await _graph("GET", "/me/mailFolders/inbox/messages", acct["access_token"],
                                    params={"$top": 50, "$orderby": "receivedDateTime DESC",
                                            "$select": "id,subject,from,receivedDateTime"})
                msgs = data.get("value", [])
                for rule in user_rules:
                    sp = (rule.get("sender_pattern") or "").lower()
                    sup = (rule.get("subject_pattern") or "").lower()
                    matched = 0
                    for m in msgs:
                        sender = ((m.get("from") or {}).get("emailAddress") or {}).get("address", "").lower()
                        subj = (m.get("subject") or "").lower()
                        if sp and sp not in sender:
                            continue
                        if sup and sup not in subj:
                            continue
                        # Match — try to ingest (will dedupe internally via source_msg_id)
                        try:
                            res = await _ingest_message_for_account(user_id, acct, m["id"])
                            if not res.get("skipped"):
                                matched += 1
                                report["messages_ingested"] += 1
                        except Exception:
                            report["errors"] += 1
                            log.exception(f"auto-ingest message {m.get('id')} failed")
                    await db.email_ingest_rules.update_one(
                        {"id": rule["id"]},
                        {"$set": {"last_run_at": _now().isoformat()},
                         "$inc": {"ingest_count": matched}}
                    )
                    report["rules_checked"] += 1
            except Exception:
                report["errors"] += 1
                log.exception(f"auto-ingest user {user_id} failed")
        return report

    # Expose the runner so the scheduler can call it
    router.auto_ingest_run_once = auto_ingest_run_once  # type: ignore[attr-defined]


    # ----- Search -----
    @router.get("/email/search")
    async def search_messages(q: str = Query(..., min_length=1), top: int = 25, user=Depends(get_user)):
        acct = await _get_account(user)
        # Graph $search requires the ConsistencyLevel header in v1.0 in some scenarios
        params = {
            "$search": f'"{q}"',
            "$top": top,
            "$select": "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview",
        }
        headers = {"Authorization": f"Bearer {acct['access_token']}", "ConsistencyLevel": "eventual"}
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.get(f"{GRAPH}/me/messages", headers=headers, params=params)
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"Outlook search failed: {r.text[:200]}")
        data = r.json()
        return {"q": q, "count": len(data.get("value", [])), "messages": data.get("value", [])}

    # ----- Wrench drafts a reply (does NOT send) -----
    @router.post("/email/draft-reply/{message_id}")
    async def draft_reply(message_id: str, body: DraftReplyReq, user=Depends(get_user)):
        """Read the email, hand it to Wrench, ask for a professional shop-owner reply.
        Returns the draft HTML — Doc still has to hit SEND on the frontend."""
        acct = await _get_account(user)
        msg = await _graph("GET", f"/me/messages/{message_id}", acct["access_token"],
                           params={"$select": "subject,from,body"})
        sender = (msg.get("from") or {}).get("emailAddress", {}).get("address", "the customer")
        subj = msg.get("subject", "")
        # Strip HTML to plain text for the LLM
        raw = (msg.get("body") or {}).get("content", "")
        import re as _re
        plain = _re.sub(r"<[^>]+>", " ", raw)
        plain = _re.sub(r"\s+", " ", plain).strip()[:4000]
        # Pull shop profile for tone
        profile = await db.shop_profiles.find_one({"shop_id": acct["shop_id"]}, {"_id": 0}) or {}
        shop_name = profile.get("name", "Dr. Underhood")
        sys_prompt = (
            f"You are drafting an email reply on behalf of {shop_name}, an automotive shop. "
            "Doc Underhood is the owner — sign the email 'Doc' (no last name). "
            "Tone: professional, friendly, brief. No filler. No 'Hope this finds you well.' "
            "If the customer asked for an estimate, give a price range only if the original email "
            "named a specific repair we can quote — otherwise ask them to bring it in or send VIN + symptoms. "
            "Return HTML suitable for an email body (use <p> and <br>). No subject line. No greeting from you. "
            "If Doc gave extra instructions below, prioritize them."
        )
        from emergentintegrations.llm.chat import LlmChat, UserMessage  # local import
        chat = LlmChat(api_key=EMERGENT_LLM_KEY, session_id=f"draft-{message_id[:8]}", system_message=sys_prompt).with_model("openai", "gpt-5.2")
        user_text = (
            f"INCOMING EMAIL\nFrom: {sender}\nSubject: {subj}\n\n{plain}\n\n"
            f"DOC'S EXTRA INSTRUCTIONS:\n{body.instructions or '(none — just write the reply)'}"
        )
        try:
            reply_html = await chat.send_message(UserMessage(text=user_text))
        except Exception as e:
            raise HTTPException(500, f"Wrench couldn't draft that one: {e}")
        return {
            "message_id": message_id,
            "to": sender,
            "subject_in_reply": f"Re: {subj}" if not subj.lower().startswith("re:") else subj,
            "draft_html": reply_html,
        }

    # ----- Drafts staged by the partner brain (Foreman Mail bridge) -----
    @router.get("/email/drafts")
    async def list_drafts(user=Depends(get_user)):
        """List pending drafts the partner brain has staged for this user/shop."""
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        cur = db.email_drafts.find(
            {"user_id": user["id"], "shop_id": sid, "status": "pending_review"},
            {"_id": 0},
        ).sort("created_at", -1).limit(50)
        return await cur.to_list(50)

    class DraftEditReq(BaseModel):
        subject: Optional[str] = None
        body_html: Optional[str] = None

    @router.put("/email/drafts/{draft_id}")
    async def edit_draft(draft_id: str, body: DraftEditReq, user=Depends(get_user)):
        patch: Dict[str, Any] = {"updated_at": _now().isoformat()}
        if body.subject is not None:
            patch["subject"] = body.subject
        if body.body_html is not None:
            patch["body_html"] = body.body_html[:50000]
        r = await db.email_drafts.update_one(
            {"id": draft_id, "user_id": user["id"], "status": "pending_review"},
            {"$set": patch},
        )
        if r.matched_count == 0:
            raise HTTPException(404, "Draft not found or already actioned.")
        return {"ok": True}

    @router.post("/email/drafts/{draft_id}/send")
    async def send_draft(draft_id: str, user=Depends(get_user)):
        """Doc tapped SEND. Fire the reply via Graph, then mark the draft sent."""
        draft = await db.email_drafts.find_one({"id": draft_id, "user_id": user["id"], "status": "pending_review"})
        if not draft:
            raise HTTPException(404, "Draft not found.")
        acct = await _get_account(user)
        payload = {"message": {"body": {"contentType": "HTML", "content": draft["body_html"]}}}
        await _graph("POST", f"/me/messages/{draft['message_id']}/reply", acct["access_token"], json=payload)
        await db.email_drafts.update_one(
            {"id": draft_id},
            {"$set": {"status": "sent", "sent_at": _now().isoformat()}},
        )
        return {"ok": True, "sent": True}

    @router.post("/email/drafts/{draft_id}/discard")
    async def discard_draft(draft_id: str, user=Depends(get_user)):
        r = await db.email_drafts.update_one(
            {"id": draft_id, "user_id": user["id"], "status": "pending_review"},
            {"$set": {"status": "discarded", "discarded_at": _now().isoformat()}},
        )
        if r.matched_count == 0:
            raise HTTPException(404, "Draft not found.")
        return {"ok": True, "discarded": True}

    return router


# ============ Brain Bridge Router (bearer-token, partner-facing "Foreman Mail") ============
def make_email_brain_router(db):
    """Mounts /api/brain/inbox/* — read-only firehose + draft-staging for OG
    (Dr. Underhood Live Assist). Strict separation of duties:
      WE drafts (here, via POST /draft) → DOC reviews (in his Email UI)
      → DOC sends (frontend hits the existing user-JWT /email/.../reply or /send).
    Nothing auto-sends. Doc's tap is the trigger."""
    from fastapi import Header
    bbrain = APIRouter()

    def _check_brain_token(authorization: Optional[str] = Header(None)):
        if not BRAIN_TOKEN:
            raise HTTPException(503, "Brain not configured.")
        if not authorization or not authorization.startswith("Bearer ") or authorization[7:] != BRAIN_TOKEN:
            raise HTTPException(401, "Invalid brain bearer token.")
        return True

    async def _acct_for_shop(shop_id: str) -> Dict[str, Any]:
        acct = await db.email_accounts.find_one({"shop_id": shop_id, "provider": "microsoft"})
        if not acct:
            raise HTTPException(404, f"No mailbox connected for shop_id={shop_id}.")
        # Refresh if needed (re-using the same logic)
        if not MS_CLIENT_ID or not MS_CLIENT_SECRET:
            raise HTTPException(503, "Email integration not configured (MS_CLIENT_ID/SECRET missing).")
        exp = acct.get("expires_at")
        if isinstance(exp, str):
            try:
                exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            except Exception:
                exp = None
        if exp and _now() + timedelta(minutes=5) < exp:
            return acct
        rt = acct.get("refresh_token")
        if not rt:
            raise HTTPException(401, "Mailbox needs reconnect (no refresh token).")
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{MS_AUTHORITY}/oauth2/v2.0/token", data={
                "client_id": MS_CLIENT_ID, "client_secret": MS_CLIENT_SECRET,
                "grant_type": "refresh_token", "refresh_token": rt, "scope": MS_SCOPES,
            })
        if r.status_code != 200:
            raise HTTPException(401, "Microsoft refresh rejected. Reconnect mailbox.")
        tk = r.json()
        new_exp = _now() + timedelta(seconds=int(tk.get("expires_in", 3600)))
        patch = {"access_token": tk["access_token"], "refresh_token": tk.get("refresh_token", rt),
                 "expires_at": new_exp.isoformat(), "scope": tk.get("scope", acct.get("scope", MS_SCOPES)),
                 "updated_at": _now().isoformat()}
        await db.email_accounts.update_one({"_id": acct["_id"]}, {"$set": patch})
        acct.update(patch)
        return acct

    @bbrain.get("/brain/inbox/recent")
    async def inbox_recent(
        shop_id: str = Query(...),
        limit: int = Query(20, ge=1, le=100),
        unread_only: bool = Query(False),
        _t: bool = Depends(_check_brain_token),
    ):
        """Firehose of recent inbox messages for the partner's classifier.
        Lightweight payload (no full body) — just enough to classify."""
        acct = await _acct_for_shop(shop_id)
        params = {
            "$top": limit,
            "$orderby": "receivedDateTime desc",
            "$select": "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,importance,conversationId",
        }
        if unread_only:
            params["$filter"] = "isRead eq false"
        headers = {"Authorization": f"Bearer {acct['access_token']}"}
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.get(f"{GRAPH}/me/mailFolders/inbox/messages", headers=headers, params=params)
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"Outlook said: {r.text[:200]}")
        data = r.json()
        return {
            "shop_id": shop_id,
            "account_email": acct.get("account_email", ""),
            "count": len(data.get("value", [])),
            "messages": data.get("value", []),
        }

    @bbrain.get("/brain/inbox/message/{message_id}")
    async def inbox_message(
        message_id: str,
        shop_id: str = Query(...),
        _t: bool = Depends(_check_brain_token),
    ):
        """Full body of one message (so the partner can RAG / classify the whole thing)."""
        acct = await _acct_for_shop(shop_id)
        headers = {"Authorization": f"Bearer {acct['access_token']}"}
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(f"{GRAPH}/me/messages/{message_id}", headers=headers,
                            params={"$select": "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,body,conversationId"})
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"Outlook said: {r.text[:200]}")
        return r.json()

    class BrainDraftReq(BaseModel):
        shop_id: str
        message_id: str  # the inbound message this draft is replying to
        subject: str = ""  # optional override; default is Re: original
        body_html: str
        classification: Optional[str] = ""  # "estimate" | "status" | "complaint" | "spam" | "other"
        confidence: Optional[float] = None
        notes_for_doc: Optional[str] = ""  # one-liner the partner wants Doc to see

    @bbrain.post("/brain/inbox/draft")
    async def inbox_draft(body: BrainDraftReq, _t: bool = Depends(_check_brain_token)):
        """Partner posts a draft reply. We persist it for Doc's review.
        Doc sees it in his Email page → REVIEW → tap SEND (which fires the existing
        user-JWT reply endpoint) or DISCARD. Never auto-sent."""
        # Validate the inbound message exists (gives us nice error early)
        acct = await _acct_for_shop(body.shop_id)
        import uuid as _uuid
        draft_id = _uuid.uuid4().hex
        doc = {
            "id": draft_id,
            "shop_id": body.shop_id,
            "user_id": acct["user_id"],  # the owner of the mailbox
            "message_id": body.message_id,
            "subject": body.subject or "",
            "body_html": body.body_html[:50000],
            "classification": (body.classification or "").lower(),
            "confidence": body.confidence,
            "notes_for_doc": (body.notes_for_doc or "")[:500],
            "status": "pending_review",
            "source": "brain_partner",
            "created_at": _now().isoformat(),
        }
        await db.email_drafts.insert_one(doc)
        doc.pop("_id", None)
        return {"draft_id": draft_id, "status": "pending_review", "doc_will_review_in": acct.get("account_email", "")}

    return bbrain
