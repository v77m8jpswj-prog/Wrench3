"""
Data Wrench — Unified Inbox feed.

Merges every channel Doc cares about into ONE chronological feed so he stops
bouncing between /sms, /leads, /email, FB, and IG to triage his day:
  - SMS (inbound + outbound from db.sms_messages, grouped per customer)
  - Facebook Messenger DMs (leads.kind=facebook_dm)
  - Instagram DMs (leads.kind=instagram_dm)
  - Voicemails (leads.kind=voicemail)
  - Web-form leads (leads with no `kind` or kind="landing")
  - Emails (db.emails, last N, unread or recent)

Returned items share a normalized shape:
  {
    id, channel, channel_label, who, who_avatar?, preview, ts, unread,
    status, deep_link, lead_id?, phone?, fb_psid?
  }

Sorted newest-first. The frontend just renders this list with a channel badge.
"""

import os
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query

log = logging.getLogger("datawrench.inbox")


def _digits(s: str) -> str:
    return "".join(c for c in (s or "") if c.isdigit())[-10:]


def _fmt_phone(s: str) -> str:
    d = _digits(s)
    if len(d) != 10:
        return s or ""
    return f"({d[0:3]}) {d[3:6]}-{d[6:]}"


def make_inbox_router(db, get_user) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["inbox"])

    @router.get("/inbox/feed")
    async def inbox_feed(
        channel: Optional[str] = Query(None, description="Filter: sms|fb|ig|voicemail|email|form|all"),
        limit: int = Query(150, ge=1, le=400),
        unread_only: bool = Query(False),
        days: int = Query(30, ge=1, le=180, description="How far back to scan"),
        user=Depends(get_user),
    ):
        """Single chronological feed across SMS, FB/IG DMs, voicemails, emails, and form leads."""
        items: list = []
        since_iso = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

        want = (channel or "all").lower()

        # ----- SMS threads (one item per customer, newest message preview) -----
        if want in ("all", "sms"):
            sms_rows = await db.sms_messages.find(
                {"created_at": {"$gte": since_iso}},
                {"_id": 0},
            ).sort("created_at", -1).limit(500).to_list(500)

            seen_keys = set()
            for r in sms_rows:
                direction = r.get("direction") or "inbound"
                other = (
                    r.get("to_number") or r.get("phone") or ""
                    if direction == "outbound"
                    else r.get("from_number") or r.get("phone") or ""
                )
                key = _digits(other)
                if not key or key in seen_keys:
                    continue
                seen_keys.add(key)
                is_unread = direction == "inbound" and not r.get("read")

                # Lead name lookup (best-effort, single-customer per key — quick)
                name = None
                lead_id = None
                lead = await db.leads.find_one(
                    {"contact": {"$regex": key + "$"}},
                    {"_id": 0, "id": 1, "name": 1},
                )
                if lead:
                    name = lead.get("name")
                    lead_id = lead.get("id")

                items.append({
                    "id": f"sms:{key}",
                    "channel": "sms",
                    "channel_label": "SMS",
                    "who": name or _fmt_phone(other),
                    "preview": (r.get("body") or "")[:140],
                    "ts": r.get("created_at"),
                    "unread": bool(is_unread),
                    "status": "new" if is_unread else "read",
                    "deep_link": f"/sms?phone={other}",
                    "lead_id": lead_id,
                    "phone": other,
                    "direction": direction,
                })

        # ----- Leads-based channels (FB, IG, voicemail, form) -----
        lead_kinds_wanted = []
        if want in ("all", "fb"):
            lead_kinds_wanted.append(("facebook_dm", "fb", "FB MESSENGER"))
        if want in ("all", "ig"):
            lead_kinds_wanted.append(("instagram_dm", "ig", "INSTAGRAM"))
        if want in ("all", "voicemail"):
            lead_kinds_wanted.append(("voicemail", "voicemail", "VOICEMAIL"))

        for kind, ch_key, ch_label in lead_kinds_wanted:
            cur = db.leads.find(
                {"kind": kind, "created_at": {"$gte": since_iso}},
                {"_id": 0},
            ).sort("created_at", -1).limit(200)
            async for lead in cur:
                deep_link = f"/leads?id={lead.get('id')}"
                if ch_key == "fb" and lead.get("fb_psid"):
                    deep_link = f"/leads?id={lead.get('id')}"
                items.append({
                    "id": f"lead:{lead.get('id')}",
                    "channel": ch_key,
                    "channel_label": ch_label,
                    "who": lead.get("name") or "(unknown)",
                    "preview": (lead.get("what_they_need") or lead.get("transcript") or "")[:140],
                    "ts": lead.get("created_at"),
                    "unread": lead.get("status") == "new",
                    "status": lead.get("status") or "new",
                    "deep_link": deep_link,
                    "lead_id": lead.get("id"),
                    "phone": lead.get("contact") if lead.get("contact") else None,
                    "fb_psid": lead.get("fb_psid"),
                    "vehicle": lead.get("vehicle"),
                })

        # ----- Web-form leads (no `kind` field or kind in ("landing", "form")) -----
        if want in ("all", "form"):
            form_cur = db.leads.find(
                {
                    "$and": [
                        {"created_at": {"$gte": since_iso}},
                        {"$or": [
                            {"kind": {"$exists": False}},
                            {"kind": None},
                            {"kind": "landing"},
                            {"kind": "form"},
                        ]},
                    ]
                },
                {"_id": 0},
            ).sort("created_at", -1).limit(200)
            async for lead in form_cur:
                items.append({
                    "id": f"lead:{lead.get('id')}",
                    "channel": "form",
                    "channel_label": "WEB FORM",
                    "who": lead.get("name") or "(unknown)",
                    "preview": (lead.get("what_they_need") or "")[:140],
                    "ts": lead.get("created_at"),
                    "unread": lead.get("status") == "new",
                    "status": lead.get("status") or "new",
                    "deep_link": f"/leads?id={lead.get('id')}",
                    "lead_id": lead.get("id"),
                    "phone": lead.get("contact") if lead.get("contact") else None,
                    "vehicle": lead.get("vehicle"),
                })

        # ----- Recent emails (only if the collection exists & is non-empty) -----
        if want in ("all", "email"):
            try:
                em_cur = db.emails.find(
                    {"received_at": {"$gte": since_iso}},
                    {"_id": 0, "id": 1, "from_email": 1, "from_name": 1, "subject": 1,
                     "preview": 1, "body_text": 1, "received_at": 1, "is_read": 1, "category": 1},
                ).sort("received_at", -1).limit(80)
                async for em in em_cur:
                    sender = em.get("from_name") or em.get("from_email") or "(unknown)"
                    body = em.get("preview") or em.get("body_text") or ""
                    items.append({
                        "id": f"email:{em.get('id')}",
                        "channel": "email",
                        "channel_label": "EMAIL",
                        "who": sender,
                        "subject": em.get("subject") or "(no subject)",
                        "preview": body[:140],
                        "ts": em.get("received_at"),
                        "unread": not em.get("is_read"),
                        "status": "new" if not em.get("is_read") else "read",
                        "deep_link": f"/email?id={em.get('id')}",
                        "email_id": em.get("id"),
                        "category": em.get("category"),
                    })
            except Exception as e:
                # emails collection may not exist in early environments — that's fine
                log.debug(f"inbox: emails fetch skipped: {e}")

        # Filter by unread_only
        if unread_only:
            items = [it for it in items if it.get("unread")]

        # Sort newest-first, missing timestamps go to the bottom
        items.sort(key=lambda it: it.get("ts") or "", reverse=True)

        return {
            "items": items[:limit],
            "total": len(items),
            "channels": ["sms", "fb", "ig", "voicemail", "email", "form"],
            "since": since_iso,
        }

    @router.get("/inbox/counts")
    async def inbox_counts(user=Depends(get_user)):
        """Per-channel unread counts for the sidebar nav badge + chip badges."""
        counts: dict = {}
        # SMS unread
        try:
            counts["sms"] = await db.sms_messages.count_documents({
                "$and": [
                    {"$or": [{"direction": "inbound"}, {"direction": {"$exists": False}}]},
                    {"$or": [{"read": {"$exists": False}}, {"read": {"$ne": True}}]},
                ],
            })
        except Exception:
            counts["sms"] = 0
        # Leads-based new counts
        for kind, key in (("facebook_dm", "fb"), ("instagram_dm", "ig"), ("voicemail", "voicemail")):
            try:
                counts[key] = await db.leads.count_documents({"kind": kind, "status": "new"})
            except Exception:
                counts[key] = 0
        # Form leads (no kind / kind in landing|form)
        try:
            counts["form"] = await db.leads.count_documents({
                "status": "new",
                "$or": [
                    {"kind": {"$exists": False}},
                    {"kind": None},
                    {"kind": "landing"},
                    {"kind": "form"},
                ],
            })
        except Exception:
            counts["form"] = 0
        # Email unread
        try:
            counts["email"] = await db.emails.count_documents({"is_read": {"$ne": True}})
        except Exception:
            counts["email"] = 0
        counts["total"] = sum(counts.values())
        return counts

    return router
