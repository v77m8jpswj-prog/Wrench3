# Data Wrench — PRD (as of Feb 26, 2026)

> **NEW AGENTS: READ `/app/memory/OPERATOR_PROFILE.md` FIRST** before responding to Doc. It captures his communication style, pet peeves, brand standards, and recurring environment gotchas. Cuts re-learning to zero.

## Identity
- Product: Data Wrench (formerly AI Foreman)
- User: Doc Underhood — owner Dr. Underhood Automotive, Fort Smith AR
- Stack: React SPA + FastAPI + MongoDB (Motor). OpenAI GPT-5.2 / Vision / Realtime / Embeddings.
- Persona: WRENCH — gruff old-school master mechanic. ASE Master + GM Master + HP Tuners. Talks to Doc as a peer.
- Multi-tenant: every record scoped by `shop_id` (default `drunderhood-fortsmith`). Partner integration with "Dr. Underhood Live Assist agent" (OG) via bearer-token `/api/brain/*` endpoints.

## What's in production today
Phases 1, 2, 2.5 shipped. See CHANGELOG section below.

## Active dependencies / env vars
**Backend (`/app/backend/.env`)**:
- `MONGO_URL`, `DB_NAME` (protected)
- `OPENAI_API_KEY` (Doc's — needed for embeddings + WebRTC realtime + vision OCR fallback)
- `EMERGENT_LLM_KEY` (auto, for chat + Wrench draft)
- `BRAIN_INGRESS_TOKEN` (partner bearer — `a1680ebe47a8b56801b44a478a0b40655c128ab424ce8035e11df89cb310558d`)
- `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REDIRECT_URI`, `MS_AUTHORITY`, `FRONTEND_BASE_URL` (Outlook OAuth)
- `PLAYWRIGHT_CHROME_EXECUTABLE_PATH=/usr/bin/chromium` (for the scraper)

**Frontend (`/app/frontend/.env`)**: `REACT_APP_BACKEND_URL` (protected)

## Phase 2.5/3 — IN PROGRESS (Feb 21, 2026)
Already covered in this session:
- [x] Search-cache layer + telemetry
- [x] Close Job → Brain Case automation
- [x] `/api/brain/team-conversations` for partner Phase 2
- [x] Shop Profile in DB, `/api/brain/stats` enriched
- [x] `/api/brain/recent-outcomes` pull-not-push outcome feed
- [x] PDF bulk ingest endpoint `/api/cases/learn-pdf` with Vision-OCR fallback for scans
- [x] VIN bar on Chat page (active vehicle tracking)
- [x] Microsoft 365 / Outlook OAuth integration (`/api/email/*` + brain bridge `/api/brain/inbox/*`)
- [x] `case_ids_already_seen` filter on `/brain/ask` (for partner's re-diagnose loop)
- [x] LOCKED memory facts (anti-drift). 6 of Doc's rules seeded. `lock this in:` chat command, MEMORY UI toggle.
- [x] Bulletproof TUNER specialty mode (pre-flight enforcement, full-chart paste only, hard refusals)
- [x] DIFF TUNE — `/api/chart/diff` + frontend page. Two HP Tuners screenshots in → cell-by-cell delta + safety warnings out.
- [x] Public shop landing page `/shop/{shop_id}` with quote form → LEADS inbox.
- [x] GBP setup guide letter (`gbp-setup-guide`)
- [x] Library URL scraper `/api/scrape/url` with Playwright + Vault credentials (HP Tuners public, AllData, Identifix logins working)
- [x] Library paste endpoint `/api/library/paste` for raw text ingest (GM SI, behind-2FA sites)
- [x] **Email notification on quote lead** (Feb 26, 2026) — `notify_shop()` helper in `email_mod.py` fires from `POST /api/public/leads` via `asyncio.create_task` so the customer response isn't blocked. Sends HTML email FROM the shop's connected Outlook mailbox TO itself with name/contact/vehicle/source/what-they-need. Silently no-ops if no mailbox connected (preview env).
- [x] **Main chat brain swapped to Claude Sonnet 4.6** (Feb 26, 2026) — `/api/chat` now uses `anthropic:claude-sonnet-4-6` via emergentintegrations + Emergent LLM Key. Title-gen, web-search, vision, and chart-JSON endpoints stay on GPT-5.2 for now. Doc strongly prefers Claude's directness; matches Wrench persona better.
- [x] **Auto-learn harvester (LEARN module)** (Feb 26, 2026) — new `learn_mod.py` + `/learn` page. Claude scans Doc's chat history, extracts candidate facts ("Doc tunes on OS E80 calibrations for GM applications" etc.) with confidence + category. Auto-locks high-confidence repeated facts (≥0.85 + seen ≥2x); queues ambiguous ones for tap-to-approve review. Endpoints: `/learn/candidates`, `/learn/harvest`, `/learn/log`, `/learn/stats`. **ChatGPT export importer** (`POST /learn/import/chatgpt`) parses uploaded zip's `conversations.json`, runs full retroactive sweep. Frontend Home tile + dedicated review queue at `/learn`.
- [x] **Operator profile handoff doc** (Feb 26, 2026) — `/app/memory/OPERATOR_PROFILE.md` captures Doc's communication style, pet peeves, brand standards, env gotchas. Next agent reads this BEFORE first reply to skip re-learning.

## Last known mood / blockers (as of Feb 26, 2026 — late shift)
- Doc spent the night polishing drunderhood.com via GoDaddy Custom HTML. Hero/services/quote sections are CLEAN. Old stock Contact Us still pending replacement (block already in his hand). Hero CALL NOW button is still broken — he's doing it in the morning.
- Main `/api/chat` brain swapped from GPT-5.2 → Claude Sonnet 4.6. Doc explicitly prefers Claude's tone. Persona is tighter, less padding.
- New LEARN module shipped — auto-extracts Doc-isms from chat history. 28 candidates queued in preview from real Doc chats. He'll tap-review them on the dashboard.
- Home page rebuilt with chunky icon-block tiles, badge on LEARN tile showing pending count.
- PWA icons regenerated from real Dr. Underhood logo (1024px source). When Doc re-saves the app to his iPhone home screen via Safari, it'll show the proper red shield, not a generic W.
- AutoLeap has NO public API (confirmed). His AutoLeap emails come to doctorunderhood@icloud.com. Recommended path: iCloud auto-forwarding rule → AutoLeap mails land in his Outlook → Wrench reads them. He's expected to set up the forwarding rule himself.
- Doc said "after this build I'll basically stay with Wrench" — he wants Wrench to become his daily-driver AI. Confirmed that's possible for shop ops; for app-level changes Emergent still recommended.

## NEXT SHIFT — PRIORITY ORDER (do these together when Doc surfaces)
0. **Doc may upload ChatGPT export zip** to /learn for retroactive sweep. Could take 5-20 min. Verify stats after.
1. **REDEPLOY TRIGGER** — Doc may have redeployed by next session. After redeploy, verify on PROD that:
   - shop_profiles.phone = "479-434-5852" (startup migration handles this)
   - SMS notifications fire (test by submitting /quote on prod, watching for SMS to +14798064398)
2. **Weekly digest email** — build `POST /api/learn/digest`: pulls 7 days of chats/cases/tunes/locked facts, asks Claude for a Wrench-voice Sunday recap, fires via `notify_shop()`. APScheduler or simple cron at Sundays 9 AM CT.
3. **AutoLeap email parser** — once Doc sets up iCloud→Outlook forward rule: add `_parse_autoleap_email()` to email_mod.py to extract RO#/customer/vehicle/parts/labor, auto-insert into brain_cases. Silent ingest, no auto-reply.
4. **Wrench Builds prototype** — /builds page where Doc describes feature in plain English, Claude writes diff to `/app/builds/queued/{id}.diff`, Emergent agent picks up on next session. No auto-deploy.
5. **Daily auto-harvest cron** — schedule learn_mod harvest to run nightly (currently manual via /learn page button)
6. **(Future) Outbound customer SMS** — once Doc adds $20+ paid balance to Twilio, the trial restriction lifts and we can text customers (reminders, follow-ups, "your truck is ready"). Today's wire is owner-only.
7. **Refresh COST dict in server.py ~L2462** when LLM provider pricing shifts. Add `twilio_sms` line item (~$0.0083/msg) to usage_summary.

## Open / pending (existing, still valid)
- [ ] Microsoft creds need to be added to PRODUCTION env vars after redeploy + 2nd redirect URI on Azure
- [ ] Optional: migration script to copy preview library/cases/credentials → prod DB
- [ ] (P1) Persist vehicle_id onto chat_sessions on every /chat call
- [ ] (P1) `GET /api/chat/sessions/{id}` should return full session doc (currently only messages)
- [ ] (P2) AllData/Identifix 2FA handling (TOTP seed in vault)
- [ ] (P2) GM SI scraper (waiting on 2FA decision — TOTP vs paste-only)
- [ ] (P2) Atlas Vector Search swap once >10k cases per shop
- [ ] (P2) Refactor: split brain.py (~1100 lines) into routers/brain_partner.py + routers/cases.py + routers/shop_profile.py + routers/leads.py
- [ ] (P2) App icon refresh
- [ ] (P2) `.hpt` binary native editing
- [ ] (P2) YouTube transcript ingest
- [ ] (P2) Daily auto-scrape (re-read saved URLs weekly)

## Shipped Feb 28, 2026
- [x] **Library ZIP bulk upload** — `POST /api/library/upload-zip` accepts a .zip, kicks off a background worker (concurrency=4) that ingests every supported file (PDF, images via GPT-5.2 OCR, TXT/MD/CSV/LOG, .hpt/.hpl). Each file becomes its own `library_items` row tagged with `batch_id`. Status polled via `GET /api/library/batch/{id}`. Frontend Library page now has `UPLOAD ZIP` button + live progress bar. Drag-and-dropping a `.zip` on the dropzone triggers the bulk path automatically.

## Shipped Feb 29, 2026 (overnight session)
- [x] **Brain ingest: 2017 Tahoe RO #19344** — Tier 1 case for AFM cam+lifter pattern failure, ingested with corrected $7,500 OTD pricing per OG R31 (parts subtotal $1,710.55 explicitly flagged DO NOT surface to consumers). Brain corpus → 26 cases.
- [x] **ADD TECH on TeamChat (P1 backlog item)** — Owner-only `ADD TECH` button in TeamChat sidebar opens modal (name/email/password/role) that POSTs to `/api/techs`, refreshes thread list. Same shop_id auto-scope. Tested end-to-end (create → DM thread appears → delete → DM gone).
- [x] **Shared Voice Service for peer agents (Bud/OG)** — Three new endpoints on `/api/voice/*`, `X-Agent-Token` gated (reuses `AGENT_MAIL_INBOUND_TOKEN`):
   - `POST /voice/ephemeral-token` mints OpenAI Realtime client_secret with per-caller persona/voice/eagerness. Auto-injects up to 15 LOCKED memory_facts so peer-side voice stays consistent with Wrench-side voice. Returns `session_id`, `client_secret`, `expires_at`, `model`. Persists session row in `voice_sessions` for audit.
   - `POST /voice/turn-log/{session_id}` peer-client fire-and-forget turn logging into `voice_turns` (shared cross-device-continuity store).
   - `GET /voice/turn-log/{session_id}` read-back for resume / hand-off.
- [x] **Morning briefing receiver** — `POST /api/brain/morning-briefing` accepts Bud's structured 7am digest (`sections: { inbox_top, ro_board, shop_status, flags }` + summary), upserts on `(shop_id, date, source_agent)`. `GET` returns latest. New `morning_briefings` collection.
- [x] **Agent-mail triangle CLOSED (4th leg)** — Original "9 → Bud" pending state was not a token typo (token was correct from R32 the whole time) — we just never sent anything to Bud's inbox. Six letters delivered overnight: R34/R36 to OG, R2/R3/R4/R5/R6 to Bud. Full backlog cleared.

## Shipped Feb 29, 2026 (overnight session, part 2)
- [x] **Background scheduler — TRAINING ALWAYS ON** (`/app/backend/scheduler.py`):
  - **Daily crawler loop** — every 24h sweeps every user's `crawl_watchlist`, ingests fresh chunks, dedupes via content fingerprint, writes run summary to `scheduled_runs`. Survives uvicorn hot-reload via `_started` guard.
  - **Hourly auto-harvest loop** — every 60min runs Claude-Sonnet fact extraction over the last 2h of every user's chat turns. High-conf (>=0.85, seen >=2x) auto-locks into `memory_facts`. Lower-conf queues for tap-approve on `/learn`.
  - **Weekly digest loop** — checks every hour; fires Sunday 9pm UTC once per week. Builds an HTML digest (new facts, locked, library chunks, brain cases, crawl/harvest run counts, watchlist status table) and ships it to Doc's connected Outlook via `notify_shop()`.
  - Wired into `server.py` startup via `start_scheduler(db)`.
  - **New endpoints**:
    - `GET /api/scheduler/status` — last_run summary + 24h success counts for each loop
    - `POST /api/scheduler/run/{crawler|harvest|digest}` (owner-only) — manual force-trigger
  - **New collections**: `scheduled_runs` (run audit log)
  - Tunable via env vars: `SCHED_CRAWL_INTERVAL_SEC`, `SCHED_HARVEST_INTERVAL_SEC`, `SCHED_DIGEST_CHECK_INTERVAL_SEC`

## P0 Bug discovered & fixed Jun 9, 2026 — owner-reply orphan loop
**The bug:** Doc's owner-cell replies to lead-notification SMS were being marked `kind=owner_reply_orphan` and going nowhere. Customer never got the reply. Doc had no idea. Confirmed pattern: 3 recent replies all orphaned (6/5 14:47, 6/9 20:16, 6/9 22:36 Grand Canyon reply to Darin Jamison).

**Why:** `/app/backend/sms_routes.py` echo-forward logic only handled SMS-to-SMS threads. Most leads come via the landing-page form (email contact only) — there's never an SMS thread to forward to.

**Fix shipped to Preview (awaiting Prod redeploy):**
- Patched `sms_routes.py` echo-forward fallback chain:
  - SMS thread → forward as before
  - No thread, phone-bearing lead in last 4h → SMS the customer + mark lead `doc_replied`
  - No thread, email-only lead → alert Doc back with full context
  - No thread, no recent lead → alert Doc back
  - All alerts logged with `kind=owner_reply_alert` for SMS log visibility
- NEW UI: `/leads` page now has a TEXT button on every phone-bearing lead → inline composer → `POST /api/leads/{id}/text` → Twilio send → auto-marks lead `contacted`. Button correctly hidden on email-only leads.
- Smoke-tested both paths end-to-end on Preview.
- OG R41 (id `bc82cad8`) — bug report + Darin rescue request, OG R42 (id `458a1971`) — fix shipped notice

**Action items:**
- [ ] OG to email Darin Jamison directly (darin.jamison08@gmail.com) with Doc's reply text
- [ ] Doc redeploying — fix lands then
- [ ] Optional follow-up: link Doc's Outlook to Prod so Wrench can email customers directly when phone is unavailable

## Shipped Jun 11, 2026
- [x] **Twilio Voice / Voicemail backend complete** — `/app/backend/voice_routes.py` shipped. Webhooks: `/api/voice/incoming` (TwiML greeting), `/api/voice/voicemail/done`, `/api/voice/voicemail/transcription`, `/api/voice/status`. Each validates X-Twilio-Signature against multiple URL variants (handles K8s ingress host rewrites). Tested end-to-end on Preview — voicemail row + lead created + transcript saved + Doc gets SMS alert + audio player renders in /leads UI. New collections: `calls`, `voicemails`. Leads gain `kind=voicemail` + `recording_url` + `transcript` + audio player tag. Brain audit endpoint `GET /api/brain/voicemails?last=10` (bearer-protected, mirror of sms-status pattern).
- [x] **R55 to OG** (id `21274613`) with full spec + Twilio console steps for Doc to paste Monday.

## Shipped Mar 1, 2026
- [x] **`/api/brain/operator-profile` endpoint LIVE** — One-shot operator profile dump for peer agents (Bud, OG). Returns shop_profile + operator_style + locked_memory_facts + candidate_facts + recent_chat_turns + voice_turn_highlights + recent_cases + window/counts. Time-windowed (default 7d, no count cap, max_messages safety ceiling 5000). Accepts master ingress token OR Bud's revocable peer token (`BRAIN_PEER_TOKEN_BUD`). Deployed to PROD (verified — 525 chat turns in 30d window, 9 locked facts on prod corpus).
- [x] **Bud access letter shipped via pre-flight credential pipe** — Verify against live preview endpoint passed HTTP 200, letter delivered to Bud's inbox (id `aedf7398-4377-4aa9-8d5f-df1147afcc7e`).
- [x] **PROD brain_cases sync (8 → 22)** — `/app/backend/sync_preview_to_prod.py` migration script. Pushes Preview cases through the existing `/api/brain/learn` endpoint (idempotent on case_id, re-embeds server-side, no Prod DB creds needed). Filters TEST_p1 noise. Pushed Tahoe RO 19344 + 13 other real cases — all 14/14 succeeded. `/brain/ask` on Prod returns confidence=high for Tahoe-symptom query.
- [x] **NEW: `/api/brain/sync-facts` endpoint (bearer)** — Upserts memory_facts + candidate_facts for a shop's owner. Idempotent on normalized fact text. Resolves owner user_id from shop_id internally so script doesn't need to know prod's user mapping.
- [x] **NEW: `/api/brain/sync-library` endpoint (bearer)** — Upserts library_items + library_chunks for a shop's owner. Idempotent on item.id. No embeddings required (library RAG is keyword-scored). Both endpoints smoke-tested on Preview (insert + dedup verified, smoke data cleaned up).
- [x] **Twilio creds shipped to Bud** — Pre-flight verified against Twilio's account-info endpoint (HTTP 200, account active). Letter id `076455f9-e5a8-4e51-b891-8bc3f2742d11`. Includes SID/FROM/OWNER metadata + Basic auth credential + wire format + usage rules + TFV pending status.
- [x] **Customer-SMS pipeline LIVE** — Bud-driven draft → confirm → send. Three new bearer endpoints in `brain.py`:
   - `POST /api/brain/sms-draft` (Wrench composes via Claude Sonnet 4.5 with shop persona, returns draft_id + body + char/segment counts, 15-min TTL)
   - `POST /api/brain/sms-send` (requires confirmed:true exactly, supports override_body, idempotent on draft_id, mirrors outbound into sms_messages for Doc's SMS log)
   - `POST /api/brain/sms-cancel` (Doc said "DROP IT")
   Smoke-tested end-to-end: draft passes, bad-confirm 400, cancel 200, post-cancel-send 409, bad-E.164 400. Drafted SMS body was clean ("Mrs. Jenkins, your 2018 Camry is ready..." 198 chars / 2 segments).
- [x] **Bud SMS playbook letter** delivered (id `978cb586-9b39-4768-af16-88d5aab612e0`) — endpoint contracts, voice-flow rules, TTL/idempotency/TFV gotchas.
- [x] **Tone-match upgrade** — `/brain/sms-draft` now pulls the last 3 outbound SMS Doc has sent to the same number (where ok=true) and feeds them to the composer as voice samples. System prompt explicitly tells the LLM to mirror the voice/length of those samples. Returns `tone_matched` + `prior_sample_count` in the response. Smoke-tested: same intent → 175 chars / 2 segments with no prior history, 103 chars / 1 segment when 2 terse priors were seeded. Bud notified (letter `5f300a60-b8f2-4925-b73b-8f034e304136`, threaded as reply to playbook letter).
- [x] **Inbound-context upgrade to `/brain/sms-draft`** — Now also pulls the last 2 inbound SMS from the same customer and feeds them as context. System prompt tells the LLM to answer/acknowledge what the customer asked if relevant. Smoke-tested: customer said "is my truck done? running late from work today" → draft naturally addressed it with "We're open till 6, so no worries if you're running late." Response gained `inbound_context_used` + `inbound_sample_count` fields.
- [x] **R38 reply to OG** (id `b5e041b5-41a6-4f3b-a45a-dddcf3741fd9`) — TFV state acknowledged, plan locked, mirror declined (foreman already has SEO live).
- [x] **R39 to OG** (id `dc77a1c9-3b98-443c-ac7c-b4734b2f1aa9`) — Decision: `drunderhood.com/sms-terms` is the canonical opt-in page. Plan to retire the loser after approval-letter lands.

## Pending PROD redeploy (Mar 1)
- [ ] PROD redeploy needed to expose `/api/brain/sync-facts` + `/api/brain/sync-library`. After deploy, run `cd /app/backend && python3 sync_preview_to_prod.py --apply` to push:
   - memory_facts: 27 (re-run is dedup-safe)
   - candidate_facts: 21
   - library: 11 items / 30 chunks
   (brain_cases already in sync — 22/22.)

## Pending / open items after overnight session
- [x] **Outlook OAuth redirect_uri drift between preview/prod** — FIXED Jun 12, 2026. `email_mod.py` now derives redirect URI from inbound request host (via `x-forwarded-host`) at runtime instead of reading `MS_REDIRECT_URI` env var. State row stashes the chosen URI so token exchange matches. Works on prod + preview with zero env config.
- [x] **EMAIL → BRAIN ingest button** — SHIPPED Jun 12, 2026. `POST /api/email/messages/{mid}/ingest` pulls email body + every URL inside as separate library_chunks. INGEST button between REPLY and ARCHIVE on `/email` reading pane. Fixed missing `import uuid` that would've crashed prior agent's stub.
- [ ] Twilio toll-free TFV — pending review (Twilio side, ETA 1-3 days from 5/27 submission)
- [ ] AutoLeap Email Parser (Outlook RO emails → brain cases) — needs Doc to set iCloud → Outlook forward rule
- [ ] Wrench BUILDS mode (self-serve feature deploy)
- [ ] DB Preview→Prod migration script (library_chunks, cases, vault)
- [ ] Outlook 365 token refresh / re-login bug (silent auth drops)
- [ ] `/api/brain/urgent-event` endpoint (Bud P0 push, lower priority than morning briefing)
- [ ] `/api/voice/session/{id}/inject` (mid-session prompt patch — defer until peer agent requests it)
- [ ] Add `agent_voice_tokens` per-peer collection (revocable individual tokens instead of shared `AGENT_MAIL_INBOUND_TOKEN`)
- [ ] Surface morning briefing in WRENCH chat retrieval pass (wire after Bud starts posting real briefings)
- [ ] Push prod deploy to expose `UPLOAD ZIP` button + ADD TECH button on `foreman.drunderhood.com`
- [ ] Refactor `/app/backend/server.py` (>3500 lines) into `/app/backend/routes/` modules

## Partner agent (OG / Dr. Underhood Live Assist)
- Letters round 4, 6, 8 acknowledged. Round 8 documents: case_ids_already_seen + Foreman Mail contract.
- Their poller hits `/api/brain/recent-outcomes` every 60s with cursor.
- Their bridge will use `/api/brain/inbox/*` once prod gets the redeploy.

## Locked rules currently seeded for Doc
1. HP Tuners chart output = full visible table, every cell, copy-paste ready
2. Never guess HP Tuners OS — ask
3. No scavenger hunt / "go find this"
4. One paste, full chart, no commentary mid-table
5. Once a rule is given, stays locked — never drift
6. Cite cell coordinates as RPM × MAP/Load

## Test credentials
See `/app/memory/test_credentials.md`.
