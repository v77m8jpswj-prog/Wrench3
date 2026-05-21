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
    async def email_status(user=Depends(get_user)):
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        acct = await db.email_accounts.find_one({"user_id": user["id"], "shop_id": sid, "provider": "microsoft"})
        return {
            "connected": bool(acct),
            "account_email": (acct or {}).get("account_email", ""),
            "connected_at": (acct or {}).get("created_at", ""),
            "configured": bool(MS_CLIENT_ID and MS_CLIENT_SECRET and MS_REDIRECT_URI),
        }

    # ----- OAuth start -----
    @router.get("/email/oauth/start")
    async def oauth_start(user=Depends(get_user)):
        if not (MS_CLIENT_ID and MS_REDIRECT_URI):
            raise HTTPException(503, "Email integration not configured yet. Tell Doc to set MS_CLIENT_ID and MS_REDIRECT_URI in backend env.")
        sid = user.get("shop_id") or DEFAULT_SHOP_ID
        state = secrets.token_urlsafe(32)
        verifier = _gen_verifier()
        await db.email_oauth_states.insert_one({
            "state": state,
            "code_verifier": verifier,
            "user_id": user["id"],
            "shop_id": sid,
            "created_at": _now().isoformat(),
            "expires_at": (_now() + timedelta(minutes=15)).isoformat(),
        })
        params = {
            "client_id": MS_CLIENT_ID,
            "response_type": "code",
            "redirect_uri": MS_REDIRECT_URI,
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
    async def oauth_callback(code: Optional[str] = None, state: Optional[str] = None,
                             error: Optional[str] = None, error_description: Optional[str] = None):
        # Best-effort: figure out where to redirect Doc when this is done
        front = FRONTEND_BASE_URL or "/"
        if error:
            return RedirectResponse(url=f"{front}/email?status=error&msg={error}")
        if not code or not state:
            return RedirectResponse(url=f"{front}/email?status=error&msg=missing_code")
        st = await db.email_oauth_states.find_one_and_delete({"state": state})
        if not st:
            return RedirectResponse(url=f"{front}/email?status=error&msg=bad_state")
        data = {
            "client_id": MS_CLIENT_ID,
            "client_secret": MS_CLIENT_SECRET,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": MS_REDIRECT_URI,
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
