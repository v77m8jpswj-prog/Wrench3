"""
Data Wrench — BACKGROUND SCHEDULER

Three always-on async loops that keep the brain training while Doc sleeps:

  1. Daily Crawler (every 24h)
     - Fires every watchlist entry across all users
     - Skips dupes via content fingerprint (existing scraper logic)
     - Records run summary in scheduled_runs collection

  2. Hourly Auto-Harvest (every 60min)
     - For each user with chat activity in the last hour, runs the
       learn_mod fact extractor
     - High-conf facts (>=0.85, seen >=2 times) auto-lock into memory
     - Lower-conf facts queue for tap-to-approve on /learn page

  3. Weekly Digest (Sunday 9pm UTC = ~3pm CST shop close)
     - Email summary to Doc's connected Outlook
     - Counts: new facts learned, new library chunks, crawl hit/miss,
       brain case growth, agent-mail activity

All three are wrapped in try/except so one crashing never kills the others.
Each writes a row into scheduled_runs so /api/scheduler/status can show
'last ran X mins ago' in the UI.

Wired from server.py via start_scheduler(db) on startup.
"""
import os
import asyncio
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any

log = logging.getLogger("datawrench.scheduler")


# Tunable intervals (seconds). Override via env for testing.
CRAWL_INTERVAL_SEC = int(os.environ.get("SCHED_CRAWL_INTERVAL_SEC", str(24 * 3600)))
HARVEST_INTERVAL_SEC = int(os.environ.get("SCHED_HARVEST_INTERVAL_SEC", str(3600)))
DIGEST_CHECK_INTERVAL_SEC = int(os.environ.get("SCHED_DIGEST_CHECK_INTERVAL_SEC", str(3600)))
AUTO_INGEST_INTERVAL_SEC = int(os.environ.get("SCHED_AUTO_INGEST_INTERVAL_SEC", str(300)))
# Weekly digest fires on Sunday at this UTC hour (21 UTC = 4pm CST winter / 3pm summer)
DIGEST_DAY_UTC = 6  # Monday=0 ... Sunday=6
DIGEST_HOUR_UTC = 21


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _record_run(db, kind: str, status: str, summary: Dict[str, Any]):
    try:
        await db.scheduled_runs.insert_one({
            "id": str(uuid.uuid4()),
            "kind": kind,
            "status": status,
            "summary": summary,
            "ran_at": _now().isoformat(),
        })
    except Exception as e:
        log.warning(f"scheduled_runs insert failed: {e}")


# ---------------- 1. Daily Crawler ----------------

async def _run_crawler_pass(db) -> Dict[str, Any]:
    """One full sweep of every user's watchlist. Uses the same _crawl_one logic
    that scraper.py uses — re-implemented here as a flat function so we don't
    import the router factory."""
    from scraper import _domain_recipe, _fetch_public, _fetch_with_login
    from ingest_safety import scrub_pii, tier_for_url, content_fingerprint
    from urllib.parse import urlparse

    summary = {"users": 0, "watchlist_entries": 0, "ok": 0, "deduped": 0, "failed": 0}

    cur = db.crawl_watchlist.find({}, {"_id": 0})
    entries = await cur.to_list(1000)
    summary["watchlist_entries"] = len(entries)

    # Group by user
    seen_users = set()
    for entry in entries:
        seen_users.add(entry.get("user_id", ""))
        user = await db.users.find_one({"id": entry.get("user_id")}, {"_id": 0})
        if not user:
            summary["failed"] += 1
            continue
        url = entry["url"]
        try:
            tier_info = tier_for_url(url)
            if tier_info.get("restricted"):
                raise Exception(f"TOS-restricted ({tier_info['label']})")
            recipe = _domain_recipe(url)
            needs_login = bool(recipe and recipe.get("login_url"))
            if needs_login:
                host = (urlparse(url).hostname or "").lower().replace("www.", "")
                creds_cur = db.credentials.find({"user_id": user["id"]}, {"_id": 0})
                creds = await creds_cur.to_list(200)
                cred = None
                for c in creds:
                    site = (c.get("site") or "").lower().replace(" ", "")
                    vurl = (c.get("url") or "").lower().replace("www.", "").replace(" ", "")
                    if host and (host in vurl or host in site):
                        cred = c
                        break
                if not cred or not cred.get("username") or not cred.get("password"):
                    raise Exception("no matching vault credential")
                content = await _fetch_with_login(url, recipe, cred["username"], cred["password"])
            else:
                content = await _fetch_public(url)
            text = content.get("text") or ""
            if len(text) < 100:
                raise Exception("scraped text too short")

            text, pii_counts = scrub_pii(text)
            fp = content_fingerprint(text)
            if fp:
                dup = await db.library_items.find_one({"user_id": user["id"], "content_fp": fp})
                if dup:
                    now = _now().isoformat()
                    await db.crawl_watchlist.update_one(
                        {"id": entry["id"]},
                        {"$set": {"last_crawled_at": now, "last_status": "ok (dedup)",
                                  "last_chunks": dup.get("chunk_count", 0)}},
                    )
                    summary["deduped"] += 1
                    continue

            title = (entry.get("title") or content.get("title") or urlparse(url).path)[:240]
            now = _now().isoformat()
            item_id = str(uuid.uuid4())
            chunk_size = 1200
            chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]
            await db.library_items.insert_one({
                "id": item_id, "user_id": user["id"], "name": title, "kind": "url",
                "size": len(text), "source_url": url, "created_at": now,
                "chunk_count": len(chunks), "status": "ready",
                "tag": entry.get("tag"), "watch_id": entry["id"],
                "source_tier": tier_info["tier"],
                "source_confidence": tier_info["confidence"],
                "source_label": tier_info["label"],
                "content_fp": fp,
                "pii_scrub_counts": pii_counts,
                "auto_crawled": True,
            })
            rows = [{"id": str(uuid.uuid4()), "user_id": user["id"], "item_id": item_id,
                     "source": title, "source_url": url, "source_label": tier_info["label"],
                     "source_tier": tier_info["tier"],
                     "source_confidence": tier_info["confidence"],
                     "text": c, "created_at": now} for c in chunks]
            if rows:
                await db.library_chunks.insert_many(rows)
            await db.crawl_watchlist.update_one(
                {"id": entry["id"]},
                {"$set": {"last_crawled_at": now, "last_status": "ok",
                          "last_chunks": len(chunks)}},
            )
            summary["ok"] += 1
        except Exception as e:
            msg = str(e)[:200]
            log.warning(f"scheduler crawl {url}: {msg}")
            await db.crawl_watchlist.update_one(
                {"id": entry["id"]},
                {"$set": {"last_crawled_at": _now().isoformat(),
                          "last_status": f"err: {msg}"}},
            )
            summary["failed"] += 1
    summary["users"] = len(seen_users)
    return summary


async def _crawler_loop(db):
    log.info(f"crawler_loop started (interval={CRAWL_INTERVAL_SEC}s)")
    # Small initial delay so we don't crawl immediately on every boot/reload
    await asyncio.sleep(120)
    while True:
        try:
            summary = await _run_crawler_pass(db)
            await _record_run(db, "crawler", "ok", summary)
            log.info(f"crawler pass complete: {summary}")
        except Exception as e:
            log.exception(f"crawler_loop iteration crashed: {e}")
            await _record_run(db, "crawler", "error", {"error": str(e)[:300]})
        await asyncio.sleep(CRAWL_INTERVAL_SEC)


# ---------------- 2. Hourly Auto-Harvest ----------------

async def _run_harvest_pass(db) -> Dict[str, Any]:
    """For each user with recent chat activity, call learn_mod's _harvest_messages
    helper. Re-implement inline to avoid coupling to the router factory."""
    from learn_mod import _extract_facts, AUTO_LOCK_MIN_CONF, AUTO_LOCK_MIN_SEEN
    import re

    summary = {"users_scanned": 0, "facts_extracted": 0, "auto_locked": 0, "queued": 0, "already_known": 0}
    since = _now() - timedelta(hours=2)  # 2h window so we catch slight drift

    # Distinct user_ids with chat activity in the window
    user_ids = await db.chat_messages.distinct("user_id", {"role": "user", "created_at": {"$gt": since.isoformat()}})
    summary["users_scanned"] = len(user_ids)

    for uid in user_ids:
        try:
            cur = db.chat_messages.find(
                {"user_id": uid, "role": "user", "created_at": {"$gt": since.isoformat()}},
                {"_id": 0, "content": 1, "session_id": 1, "created_at": 1},
            ).sort("created_at", 1).limit(80)
            msgs = await cur.to_list(80)
            if not msgs:
                continue
            from collections import defaultdict
            by_session: Dict[str, list] = defaultdict(list)
            for m in msgs:
                by_session[m.get("session_id", "no-sess")].append(m)
            for sid, batch in by_session.items():
                transcript = "\n\n".join(
                    f"[Doc, {m.get('created_at', '')[:16]}]: {(m.get('content') or '')[:1500]}"
                    for m in batch[:30]
                )
                facts = await _extract_facts(transcript)
                for f in facts:
                    summary["facts_extracted"] += 1
                    fact_text = f["fact"]
                    confidence = float(f["confidence"])
                    category = f.get("category", "general")
                    norm = " ".join(fact_text.strip().lower().split())[:300]
                    # de-dup
                    existing = await db.candidate_facts.find_one({"user_id": uid, "norm": norm})
                    snippet = re.escape(fact_text[:60])
                    already = await db.memory_facts.find_one({
                        "user_id": uid,
                        "fact": {"$regex": snippet, "$options": "i"},
                    })
                    if already:
                        summary["already_known"] += 1
                        continue
                    if existing:
                        new_seen = existing.get("seen_count", 1) + 1
                        new_conf = max(existing.get("confidence", 0.0), confidence)
                        await db.candidate_facts.update_one(
                            {"_id": existing["_id"]},
                            {"$set": {"seen_count": new_seen, "confidence": new_conf,
                                      "updated_at": _now().isoformat()}},
                        )
                        if (existing.get("status") == "pending"
                                and new_conf >= AUTO_LOCK_MIN_CONF
                                and new_seen >= AUTO_LOCK_MIN_SEEN):
                            await db.memory_facts.insert_one({
                                "id": str(uuid.uuid4()),
                                "user_id": uid,
                                "fact": f"[LOCKED] {fact_text.strip()}",
                                "is_locked": True,
                                "source": "auto-learn:scheduler",
                                "created_at": _now().isoformat(),
                            })
                            await db.candidate_facts.update_one(
                                {"id": existing["id"]},
                                {"$set": {"status": "auto_locked", "locked_at": _now().isoformat()}},
                            )
                            summary["auto_locked"] += 1
                    else:
                        await db.candidate_facts.insert_one({
                            "id": str(uuid.uuid4()),
                            "user_id": uid,
                            "fact": fact_text.strip(),
                            "norm": norm,
                            "category": category,
                            "confidence": confidence,
                            "seen_count": 1,
                            "sources": ["scheduler:chat"],
                            "status": "pending",
                            "created_at": _now().isoformat(),
                            "updated_at": _now().isoformat(),
                        })
                        summary["queued"] += 1
        except Exception as e:
            log.warning(f"harvest pass for user {uid} failed: {e}")
    return summary


async def _harvest_loop(db):
    log.info(f"harvest_loop started (interval={HARVEST_INTERVAL_SEC}s)")
    # Wait 5 min after boot so the chat seeding from a busy reload settles
    await asyncio.sleep(300)
    while True:
        try:
            summary = await _run_harvest_pass(db)
            await _record_run(db, "harvest", "ok", summary)
            log.info(f"harvest pass complete: {summary}")
        except Exception as e:
            log.exception(f"harvest_loop iteration crashed: {e}")
            await _record_run(db, "harvest", "error", {"error": str(e)[:300]})
        await asyncio.sleep(HARVEST_INTERVAL_SEC)


# ---------------- 3. Weekly Digest ----------------

async def _build_digest_html(db, shop_id: str, since: datetime) -> str:
    """Compose the weekly digest HTML body. Counts everything that grew."""
    new_facts = await db.memory_facts.count_documents({"created_at": {"$gt": since.isoformat()}})
    auto_locked = await db.candidate_facts.count_documents({
        "status": "auto_locked", "locked_at": {"$gt": since.isoformat()}
    })
    pending_facts = await db.candidate_facts.count_documents({"status": "pending"})
    new_chunks = await db.library_chunks.count_documents({"created_at": {"$gt": since.isoformat()}})
    new_items = await db.library_items.count_documents({"created_at": {"$gt": since.isoformat()}})
    new_cases = await db.brain_cases.count_documents({
        "shop_id": shop_id, "created_at": {"$gt": since.isoformat()}
    })
    crawl_runs = await db.scheduled_runs.count_documents({
        "kind": "crawler", "ran_at": {"$gt": since.isoformat()}
    })
    harvest_runs = await db.scheduled_runs.count_documents({
        "kind": "harvest", "ran_at": {"$gt": since.isoformat()}
    })
    letters_in = await db.agent_mail_inbox.count_documents({"received_at": {"$gt": since.isoformat()}})
    letters_out = await db.agent_mail_outbox.count_documents({"sent_at": {"$gt": since.isoformat()}})

    # Last 5 watchlist statuses
    watchlist = await db.crawl_watchlist.find({}, {"_id": 0}).sort("last_crawled_at", -1).to_list(20)
    wl_rows = "".join(
        f"<tr><td style='padding:4px 8px;border-bottom:1px solid #222'>{(w.get('url') or '')[:60]}</td>"
        f"<td style='padding:4px 8px;border-bottom:1px solid #222;color:{'#4CAF50' if (w.get('last_status') or '').startswith('ok') else '#FF5722'}'>{(w.get('last_status') or 'never')[:40]}</td>"
        f"<td style='padding:4px 8px;border-bottom:1px solid #222;color:#888;font-size:11px'>{(w.get('last_crawled_at') or '-')[:16]}</td></tr>"
        for w in watchlist[:10]
    )

    return f"""<!DOCTYPE html>
<html><body style="background:#0a0a0a;color:#e6e6e6;font-family:-apple-system,Helvetica,Arial,sans-serif;padding:24px;max-width:680px;margin:auto">
<h1 style="color:#FF5722;font-weight:900;letter-spacing:0.04em;margin:0 0 4px 0">DATA WRENCH — WEEKLY DIGEST</h1>
<div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.2em;margin-bottom:24px">7 days ending {_now().date().isoformat()}</div>

<div style="background:#111;border-left:4px solid #FF5722;padding:16px 20px;margin-bottom:20px">
  <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.2em">BRAIN GROWTH</div>
  <div style="font-size:32px;font-weight:900;color:#FFC107;margin-top:4px">{new_facts + auto_locked + new_chunks + new_cases}</div>
  <div style="font-size:12px;color:#aaa">total new artifacts this week</div>
</div>

<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-bottom:20px">
  <tr><td style="padding:8px 12px;background:#111;border-bottom:1px solid #222"><b style="color:#FFC107">{new_facts}</b> new locked memory facts</td></tr>
  <tr><td style="padding:8px 12px;background:#111;border-bottom:1px solid #222"><b style="color:#4CAF50">{auto_locked}</b> auto-locked from chat harvester</td></tr>
  <tr><td style="padding:8px 12px;background:#111;border-bottom:1px solid #222"><b style="color:#FF5722">{pending_facts}</b> candidate facts awaiting your tap on /learn</td></tr>
  <tr><td style="padding:8px 12px;background:#111;border-bottom:1px solid #222"><b style="color:#FFC107">{new_items}</b> new library items ({new_chunks} chunks)</td></tr>
  <tr><td style="padding:8px 12px;background:#111;border-bottom:1px solid #222"><b style="color:#FFC107">{new_cases}</b> new brain cases</td></tr>
  <tr><td style="padding:8px 12px;background:#111;border-bottom:1px solid #222"><b style="color:#FFC107">{crawl_runs}</b> crawler runs · <b>{harvest_runs}</b> harvest runs</td></tr>
  <tr><td style="padding:8px 12px;background:#111"><b style="color:#FFC107">{letters_in}</b> letters in · <b>{letters_out}</b> out</td></tr>
</table>

<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.2em;margin-bottom:8px">WATCHLIST — LAST CRAWL</div>
<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background:#111;margin-bottom:24px">
{wl_rows or '<tr><td style="padding:8px 12px;color:#666">no watchlist entries yet — go to /learn and feed some URLs</td></tr>'}
</table>

<div style="color:#666;font-size:11px;line-height:1.6">
  Auto-generated by Wrench's overnight scheduler.<br>
  Crawler runs every 24h. Harvester runs every hour. This digest fires Sunday 9pm UTC.<br>
  Adjust on /api/scheduler/status — kill switch coming in a future build.
</div>
</body></html>"""


async def _run_digest_pass(db) -> Dict[str, Any]:
    """Fire weekly digest email to every shop that has a connected mailbox."""
    from email_mod import notify_shop
    summary = {"shops_emailed": 0, "failed": 0}
    accounts = await db.email_accounts.find({"provider": "microsoft"}, {"_id": 0}).to_list(50)
    seen_shops = set()
    since = _now() - timedelta(days=7)
    for acct in accounts:
        sid = acct.get("shop_id") or os.environ.get("DEFAULT_SHOP_ID", "drunderhood-fortsmith")
        if sid in seen_shops:
            continue
        seen_shops.add(sid)
        try:
            html = await _build_digest_html(db, sid, since)
            ok = await notify_shop(db, sid,
                subject=f"WRENCH WEEKLY — {_now().date().isoformat()}",
                body_html=html)
            if ok:
                summary["shops_emailed"] += 1
            else:
                summary["failed"] += 1
        except Exception as e:
            log.warning(f"digest pass for shop {sid} failed: {e}")
            summary["failed"] += 1
    return summary


async def _digest_loop(db):
    """Check every hour; fire if it's Sunday at DIGEST_HOUR_UTC and we haven't
    fired this week yet."""
    log.info(f"digest_loop started (target: weekday={DIGEST_DAY_UTC} hour={DIGEST_HOUR_UTC} UTC)")
    while True:
        try:
            now = _now()
            if now.weekday() == DIGEST_DAY_UTC and now.hour == DIGEST_HOUR_UTC:
                # Has a digest already fired this week?
                week_start = (now - timedelta(days=7, hours=2)).isoformat()
                already = await db.scheduled_runs.find_one({
                    "kind": "digest", "status": "ok",
                    "ran_at": {"$gt": week_start},
                })
                if not already:
                    summary = await _run_digest_pass(db)
                    await _record_run(db, "digest", "ok", summary)
                    log.info(f"digest pass complete: {summary}")
        except Exception as e:
            log.exception(f"digest_loop iteration crashed: {e}")
            await _record_run(db, "digest", "error", {"error": str(e)[:300]})
        await asyncio.sleep(DIGEST_CHECK_INTERVAL_SEC)


# ---------------- Start ----------------

_started = False


def start_scheduler(db, email_router=None):
    """Call from server.py startup. Idempotent across uvicorn hot-reloads."""
    global _started
    if _started:
        log.info("scheduler already started, skipping duplicate start")
        return
    _started = True
    asyncio.create_task(_crawler_loop(db))
    asyncio.create_task(_harvest_loop(db))
    asyncio.create_task(_digest_loop(db))
    if email_router is not None and hasattr(email_router, "auto_ingest_run_once"):
        asyncio.create_task(_auto_ingest_loop(db, email_router))
        log.info("background scheduler started: crawler + harvester + digest + auto-ingest loops")
    else:
        log.info("background scheduler started: crawler + harvester + digest loops")


async def _auto_ingest_loop(db, email_router):
    log.info(f"auto_ingest_loop started (interval={AUTO_INGEST_INTERVAL_SEC}s)")
    # Wait 60s after boot so reloads settle
    await asyncio.sleep(60)
    while True:
        try:
            summary = await email_router.auto_ingest_run_once()
            if summary.get("messages_ingested", 0) > 0 or summary.get("errors", 0) > 0:
                log.info(f"auto-ingest pass: {summary}")
            await _record_run(db, "auto_ingest", "ok", summary)
        except Exception as e:
            log.exception(f"auto_ingest_loop iteration crashed: {e}")
            await _record_run(db, "auto_ingest", "error", {"error": str(e)[:300]})
        await asyncio.sleep(AUTO_INGEST_INTERVAL_SEC)
