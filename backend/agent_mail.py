"""
Data Wrench — Agent-to-agent mail (Wrench ↔ OG).

End-to-end letter pipe between Wrench (Data Wrench / Foreman) and OG
(Dr. Underhood Live Assist). No copy-paste, no deploy gates.

Endpoints (mounted at /api/agent-mail/*):
  POST /inbox        Receive a letter (auth: X-Agent-Token == AGENT_MAIL_INBOUND_TOKEN)
  POST /send         Send a letter to a configured peer (auth: user JWT)
  POST /configure    Configure peer URL + token (auth: user JWT)
  GET  /peers        List configured peers (auth: user JWT)
  GET  /letters      List received letters (auth: user JWT)
  GET  /letters/{id} Read one received letter (auth: user JWT)

Mongo collections:
  agent_mail_inbox   Received letters from peers
  agent_mail_peers   Configured peer agents (URL + outbound token + name)
"""
import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any

import httpx
from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel, Field

log = logging.getLogger("datawrench.agentmail")


def _now() -> datetime:
    return datetime.now(timezone.utc)


class InboundLetter(BaseModel):
    from_agent: str
    subject: str
    body: str
    body_format: Optional[str] = "markdown"
    round: Optional[int] = None
    in_reply_to: Optional[str] = None  # peer's letter id if threading


class SendReq(BaseModel):
    peer: str = Field(..., description="Peer name (e.g. 'og'). Must be configured first.")
    subject: str
    body: str
    body_format: Optional[str] = "markdown"
    round: Optional[int] = None
    in_reply_to: Optional[str] = None


class ConfigureReq(BaseModel):
    peer: str
    name: str
    inbox_url: str  # peer's POST inbox endpoint
    outbound_token: str  # token peer requires when WE post to them
    inbound_token: Optional[str] = None  # token WE require when they post to us


def make_agentmail_router(db, get_user):
    router = APIRouter()

    # ----- INBOUND: peer agents POST letters here -----
    @router.post("/agent-mail/inbox")
    async def receive_letter(
        body: InboundLetter,
        x_agent_token: str = Header(default=""),
    ):
        expected = os.environ.get("AGENT_MAIL_INBOUND_TOKEN", "").strip()
        if not expected:
            raise HTTPException(503, "Agent mail inbox not configured on this side")
        if not x_agent_token or x_agent_token.strip() != expected:
            raise HTTPException(401, "Invalid or missing X-Agent-Token")

        letter = {
            "id": str(uuid.uuid4()),
            "from_agent": body.from_agent.strip()[:80] or "unknown",
            "subject": body.subject.strip()[:300] or "(no subject)",
            "body": body.body[:200000],  # cap at 200KB
            "body_format": (body.body_format or "markdown").lower(),
            "round": body.round,
            "in_reply_to": body.in_reply_to,
            "received_at": _now().isoformat(),
            "read": False,
        }
        await db.agent_mail_inbox.insert_one(letter)
        letter.pop("_id", None)
        log.info(f"agent-mail received from={letter['from_agent']} subj={letter['subject'][:60]}")
        return {"ok": True, "letter_id": letter["id"], "received_at": letter["received_at"]}

    # ----- OUTBOUND: Doc or Wrench send to a configured peer -----
    @router.post("/agent-mail/send")
    async def send_letter(body: SendReq, user=Depends(get_user)):
        peer = await db.agent_mail_peers.find_one({"peer": body.peer.lower().strip()})
        if not peer:
            raise HTTPException(404, f"Peer '{body.peer}' not configured. Use /agent-mail/configure first.")
        payload = {
            "from_agent": "nine",
            "subject": body.subject,
            "body": body.body,
            "body_format": body.body_format or "markdown",
        }
        if body.round is not None:
            payload["round"] = body.round
        if body.in_reply_to:
            payload["in_reply_to"] = body.in_reply_to

        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(
                    peer["inbox_url"],
                    headers={"X-Agent-Token": peer["outbound_token"],
                             "Content-Type": "application/json"},
                    json=payload,
                )
            if r.status_code >= 400:
                log.warning(f"agent-mail send failed: {r.status_code} {r.text[:200]}")
                raise HTTPException(502, f"Peer returned {r.status_code}: {r.text[:200]}")
            data = r.json() if r.text else {}
            # Persist a copy in our outbox for audit
            await db.agent_mail_outbox.insert_one({
                "id": str(uuid.uuid4()),
                "to_peer": peer["peer"],
                "subject": payload["subject"],
                "body": payload["body"],
                "round": payload.get("round"),
                "sent_at": _now().isoformat(),
                "peer_ack": data,
                "user_id": user["id"],
            })
            return {"ok": True, "peer_ack": data}
        except httpx.HTTPError as e:
            raise HTTPException(503, f"Couldn't reach peer: {e}")

    # ----- CONFIGURE: Doc tells us about a peer agent -----
    @router.post("/agent-mail/configure")
    async def configure_peer(body: ConfigureReq, user=Depends(get_user)):
        if not body.inbox_url.startswith("http"):
            raise HTTPException(400, "inbox_url must be http(s)")
        doc = {
            "peer": body.peer.lower().strip(),
            "name": body.name.strip(),
            "inbox_url": body.inbox_url.strip(),
            "outbound_token": body.outbound_token.strip(),
            "configured_by": user["id"],
            "updated_at": _now().isoformat(),
        }
        await db.agent_mail_peers.update_one(
            {"peer": doc["peer"]},
            {"$set": doc, "$setOnInsert": {"created_at": _now().isoformat()}},
            upsert=True,
        )
        return {"ok": True, "peer": doc["peer"]}

    @router.get("/agent-mail/peers")
    async def list_peers(user=Depends(get_user)):
        cur = db.agent_mail_peers.find({}, {"_id": 0, "outbound_token": 0})
        return await cur.to_list(20)

    # ----- View received letters -----
    @router.get("/agent-mail/letters")
    async def list_letters(user=Depends(get_user), limit: int = 50):
        cur = db.agent_mail_inbox.find({}, {"_id": 0}).sort("received_at", -1).limit(limit)
        return await cur.to_list(limit)

    @router.get("/agent-mail/letters/{lid}")
    async def get_letter(lid: str, user=Depends(get_user)):
        doc = await db.agent_mail_inbox.find_one({"id": lid}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Letter not found")
        # mark as read
        await db.agent_mail_inbox.update_one({"id": lid}, {"$set": {"read": True}})
        return doc

    return router
