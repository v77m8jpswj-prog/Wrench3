# Data Wrench — PRD (as of Jun 19, 2026)

## ✅ Jun 19, 2026 (DAY 2) — morning while Doc was on break

### Fixes shipped
- **OPENAI_API_KEY .env parse bug** — closing quote was missing on the line, so python-dotenv silently failed and the env var was empty. `/api/voice/ephemeral-token` was returning 503. Bud caught it in R3 reply. Rewrote .env, restarted backend, live-verified the endpoint returns client_secret against gpt-realtime / voice "ash". Voice handoff unlocked.
- **Leads collection drift** — `db.leads` dropped from 4 → 1 overnight (root cause unclear, possibly hot-reload race during bootstrap-restore smoke test). Re-restored just leads namespace from the dump. 4/4 visible via /api/leads.

### Build shipped
- **Chat debug panel + `?debug=1` on /api/chat** — biggest morning win. Toggle a DEBUG button on the Chat page; subsequent /chat calls include a `debug` field in the response with: session_id, vehicle_resolved (id + year/make/model + source: passed_in/inferred_from_message/sticky_active/none), mode, heat, model, system_prompt_chars + first 2500-char preview, memory_facts list, library chunks + sources, prior_history_count, search use, character counts. UI renders this in a fixed amber panel under the chat header with collapsible details. This is the diagnostic surface for all 7 open P0 bugs (cross-convo bleed / AllData hallucination / repeated questions / vehicle drift / etc.) — once Doc repros a bug with DEBUG ON, the exact LLM input is visible.

### Peer ops
- Bud R4 delivered (peer_ack 1bf51551). Bud now has voice-503 fix notice + the migration letter he missed.
- OG R34 sent (peer_ack 2873a94d). Awaiting his migration-complete ack.

### Commits sitting locally (still no GitHub push — Doc's OAuth blocked)
- de3f8f5  /api/admin/bootstrap-restore + /api/admin/set-env-urls
- 5bd8424  defensive env loads + /api/admin/seed-env one-shot
- 4362b5b  /api/chat debug mode + Chat DEBUG toggle
- + merge commits

### Open items
- ⚠️ GitHub OAuth — Doc still hasn't cleared Apple Hide-My-Email verify. 4 local commits can't push → no deploy → no prod cutover.
- ⚠️ Bud's pod (savings-app-44.preview.emergentagent.com) flapping 200/502/404 — his operator's infra issue.
- ⚠️ Bud may still be on wrong scaffold (BUD-SAVE-6-18 is a budget-app template, not peer-agent codebase). Diagnosis sent last night, awaiting reply.
- ⏳ OG R34 ack, Bud R4-followup ack — waiting.
- ⏳ Twilio SMS smoke test — needs Doc's 2nd phone.
- ⏳ "Missing leads info" — Doc said leads page missing info but didn't specify. Investigation found 4 leads all have `source: "landing"`, no `kind` field, so no voicemail-audio / FB/IG-DM badges show. If Doc was expecting voicemail leads or DM leads in the listing, those collections (`voicemails`, `fb_messages`) didn't carry over in the dump. Need Doc to specify.
- ⏳ All 7 prior P0 bugs — awaiting Doc's repro with DEBUG ON.

## 🔴 OPEN P0 ISSUES — DOC'S WORDS, FOR NEXT AGENT FORK

These are blocking Doc from selling/using Wrench day-to-day. Need a fresh agent fork with full context window to fix properly.

1. **Wrench cross-conversation bleed / hallucination** — Doc was diagnosing an ABS module C2200 code; Wrench responded with "text='' and segments[] despite 36s on the clock... audio file... codec/bitrate" — that's another session's transcription-debug context leaking in. Either session_id mix-up or system prompt grabbing wrong history. Screenshot saved in last message of prior session.

2. **AllData hallucination came back** — Wrench keeps offering to "snip the C2200 connector/PCM page from AllData" even though we explicitly fixed this in prior fork and Doc has told him 100x he doesn't have AllData. Prompt-level guard needs to be hardened to NEVER mention AllData under any circumstance.

3. **Repeating already-answered questions** — Doc said "FROM ABS MODULE" → Wrench asked again "which module logged C2200?" — not reading conversation state at all. Need to investigate what messages are actually being sent to the LLM (debug panel idea below would catch this fast).

4. **Active vehicle doesn't flow to /chat** — Doc loads vehicle in /vehicles → /charts page sees it (per-vehicle data renders) but /chat doesn't (Wrench has no idea what vehicle he's working on). Plumbing inconsistent across pages. Find: AppContext active_vehicle wiring + Tune.jsx vs Chat.jsx session resolution.

5. **Wrench "jumps off" the vehicle mid-diag** — loses lock on what truck he's working on as the conversation evolves. Need to either (a) re-inject the active vehicle context into every LLM call, or (b) pin a "VEHICLE LOCK" banner that's always part of system prompt as long as session is open.

6. **Wrench needs internet schematic lookup** — Doc cannot upload every wiring diagram. Wrench should search the open web for wiring schematics by DTC code + year/make/model and surface the URL inline. OpenAI web search is already wired per prior handoff — need to verify it's being invoked aggressively for "find me the schematic" intents and not just DTC code lookups.

7. **Generally smarter / more adaptive** — answers shouldn't regurgitate basics Doc obviously knows. Need persona prompt tuning to acknowledge Doc's expertise level (master tech, not beginner) and skip the 101 stuff.

**Suggested next-agent dev tool:** add a tiny `data-testid` "wrench debug" panel in dev that shows the actual session_id, the full message history being sent, byte count, the exact system prompt, and the LLM model + token budget on every /chat call. Would catch session bleed in 30 seconds and AllData mentions instantly.

## Mar 1, 2026 - night final — Voice "Ring Shop First" + Delete UI + Privacy/Terms + FB Pipeline Live
- New `/inbox` route — single chronological feed merging SMS threads, Facebook Messenger DMs, Instagram DMs, voicemails, web-form leads, and emails. Each row shows channel badge (color-coded), customer name (or phone fallback), vehicle if known, last-message preview, time-ago, and NEW dot.
- Channel-filter chips at the top (ALL/SMS/FB/IG/VM/EMAIL/FORM) with per-channel unread counts.
- Search box filters across name/phone/message body/subject.
- Backend endpoints: `GET /api/inbox/feed` (filterable, paginated), `GET /api/inbox/counts` (per-channel unread totals for chip badges + sidebar nav badge).
- Sidebar nav: new INBOX item at the top with live total-unread badge polling every 30s.
- 30s auto-refresh keeps the page live without manual reloads.
- Smoke-tested live in preview: 5 items merged from SMS + form leads, all channels render correctly.

## Mar 1, 2026 - late night — Facebook Messenger → Lead Pipeline (BACKEND READY)
- New `/app/backend/facebook_routes.py`:
  - `GET /api/fb/webhook` — Meta verification handshake
  - `POST /api/fb/webhook` — receives Messenger + Instagram DM events, validates X-Hub-Signature-256, creates leads
  - `GET /api/fb/health` — config diagnostic
- `Leads.jsx`: FB MESSENGER + INSTAGRAM badges, inline image attachment rendering, "REPLY ON FB"/"REPLY ON IG" deep-link buttons.
- BLOCKED on Doc: Facebook Developer Console walkthrough (Meta UI is hostile; escalated to E2 / Emergent Support per Doc's request for a more capable agent).

## Mar 1, 2026 - night (followup) — Legacy SMS schema bug FIXED
- New module `/app/backend/facebook_routes.py` with:
  - `GET /api/fb/webhook` — Meta verification handshake (echoes hub.challenge)
  - `POST /api/fb/webhook` — receives Messenger + Instagram DM events, validates X-Hub-Signature-256, creates a row in `db.leads` with `source="facebook_dm"` (or `"instagram_dm"`)
  - `GET /api/fb/health` — diagnostic showing which env secrets are configured
- `Leads.jsx` updated: FB MESSENGER + INSTAGRAM badges (with brand colors), inline rendering of customer-sent images, "REPLY ON FB"/"REPLY ON IG" buttons that deep-link to `facebook.com/messages/t/<PSID>` and `instagram.com/direct/t/<PSID>`.
- PSID-to-name lookup via Graph API (using FB_PAGE_ACCESS_TOKEN).
- Idempotent on `mid` so Meta retries don't dupe leads.
- Env vars added to backend/.env (FB_VERIFY_TOKEN seeded, FB_APP_SECRET + FB_PAGE_ACCESS_TOKEN blank — Doc to fill in).
- BLOCKED on Doc: needs to (a) create FB Developer App, (b) hand back App Secret + Page Access Token.

## Mar 1, 2026 - night (followup) — Legacy SMS schema bug FIXED
- After redeploying threaded SMS view to prod, Doc reported "all the SMS text are gone."
- Root cause: historical SMS rows on prod were stored with the LEGACY single-`phone` field (per earlier schema), but the new `/sms/threads` logic only looked at `from_number`/`to_number`. Old rows had no value to group on → invisible.
- Fix: `sms_routes.py` `/sms/threads`, `/sms/threads/{key}/messages`, `/sms/threads/{key}/mark-read`, and `/sms/unread-count` now fall back to the `phone` field and treat missing `direction` as inbound. Verified with a synthetic legacy row in preview.
- Doc to redeploy again. Historical threads should populate.
- ✅ Google Play resubmission — Doc reports this is done (no longer blocking; remove from action list).
- ✅ After-hours phone forwarding — Doc reports Dobson setup is complete.
- 🔍 Pending: Doc reports "Leads is not right" but hasn't sent specifics — waiting on screenshot.

## Mar 1, 2026 - night — Threaded SMS Inbox + Sidebar Unread Badge SHIPPED
- Complete rewrite of `SmsInbox.jsx` as an iMessage-style two-pane view: customer-grouped threads on the left, full conversation with selected customer on the right, message bubbles (outbound right/amber, inbound left/grey), pinned composer at bottom of conversation.
- Mobile: collapses to single pane — list OR drilled-in conversation with a back chevron.
- Customer name pulled from leads collection by last-10-digits phone match. Falls back to formatted phone if no lead.
- Search box at top of thread list filters by name/phone/last-body in real time.
- New backend endpoints in `sms_routes.py`:
  - `GET /api/sms/threads` — list of customer-grouped threads with name lookup
  - `GET /api/sms/threads/{phone_key}/messages` — full conversation oldest→newest
  - `POST /api/sms/threads/{phone_key}/mark-read` — mark all inbound from one customer as read
  - `GET /api/sms/unread-count` — lightweight count for the nav badge
- `Shell.jsx`: new red badge on the SMS sidebar nav (desktop + mobile drawer) showing total inbound unread count. Polls every 30s + listens for `wrench-sms-unread-refresh` event for instant updates when a thread is opened.
- Tested via `testing_agent_v3_fork`: backend 12/12, frontend 13/14 (one MEDIUM fix shipped — deep-link `?phone=` was leaking in URL, now stripped on auto-select).
- Regression suite: `/app/backend/tests/test_sms_threads.py`.

## Mar 1, 2026 - late afternoon — Brain peer health endpoints + /sms ↔ /leads bridge
- `/leads?phone=<number>` and `/sms?phone=<number>` are now filtered views; each shows a yellow banner with the active phone + SHOW ALL clear button.
- Lead cards with a phone contact have a new "SMS THREAD" button → jumps to that customer's SMS history.
- Every SMS row has a "VIEW LEAD" link → jumps to that customer's lead card.
- Last-10-digits match means "+14794345852", "(479) 434-5852", and "4794345852" all collapse to the same thread.
- Resolves Doc's "I don't know why leads and SMS are separate" confusion.

## Mar 1, 2026 - evening — Tune mode 3-bug pass
- BUG: Switching active vehicle in Tune kept dragging the prior vehicle's chat context into Wrench's responses. Root cause: chat session_id was stored in a single global `dw_tune_session` localStorage key — same id reused across vehicles, backend loaded old history.
  FIX: keyed the localStorage cache by vehicle id (`dw_tune_session_<vehicleId>`). On vehicle change, swap to the cached session for that vehicle (or null → backend creates fresh). Messages no longer bleed across trucks.
- BUG: "Won't take screenshots" — vision endpoint hitting Cloudflare 524 (100s timeout) because HP Tuners phone screenshots are 8-12 MB and gpt-5.2 vision chews on them too long.
  FIX: client-side image compression in `Tune.jsx` — canvas resize to 1920px long edge, JPEG quality 0.82. ~8MB PNG → ~600KB JPEG. Vision response now well under Cloudflare's timeout.
- BUG: Wrench labeling Doc's own raw HP Tuners pastes as "SOURCE: EXTERNAL — UNVERIFIED" and refusing to act on them.
  FIX: tightened the EXTERNAL OUTPUT GUARD in `build_system_prompt` — now only triggers on obvious LLM emissions (markdown bold, "Here is the adjusted table:" preambles, /hpt-fix output). Raw HP Tuners CSV/grid pastes treated as canonical.

## Mar 1, 2026 - afternoon — Voicemail SMS audio link fixed + test-spam lockdown
- iOS Safari "sign in to api.twilio.com" prompt fixed via new `GET /api/voicemails/{id}/audio` proxy
- Voicemail SMS now links to `foreman.drunderhood.com/api/voicemails/{id}/audio`
- `/voicemail/transcription` suppresses owner SMS when signature check fails (prevents test-spam)

## Mar 1, 2026 - morning — Twilio Voice Webhook fax-sound bug RESOLVED
- `/api/voice/incoming` returns full greeting TwiML even on signature failure
- Callback URLs built from `PUBLIC_BASE_URL` (defaults to `https://foreman.drunderhood.com`)
- Tested: 10/10 pytest cases pass in `/app/backend/tests/test_voice_routes.py`

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
- `BRAIN_INGRESS_TOKEN` (partner bearer — `<REDACTED_BRAIN_INGRESS_TOKEN>`)
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
- [x] **EMAIL → BRAIN ingest button** — SHIPPED Jun 12, 2026. `POST /api/email/messages/{mid}/ingest` pulls email body + every URL inside as separate library_chunks. INGEST button between REPLY and ARCHIVE on `/email` reading pane. Fixed missing `import uuid` that would've crashed prior agent's stub. Audit pass added content-type + binary-ext filter + zero-width char stripper.
- [x] **TEACH WRENCH FROM THE WEB** — SHIPPED Jun 13, 2026. `POST /api/library/teach` takes a plain-English topic from Doc, asks Claude to (1) pick 4-12 specific URLs to crawl (manuals, manufacturer docs, forum threads) and (2) write a distilled cheat-sheet from training data. Crawls everything into `library_chunks` under a `[Teach]` library_item so Doc can find it in BRAIN SEARCH. UI panel on `/library` with textarea + GO LEARN IT button + result display with cheat-sheet drawer. Tested with "GM L86 AFM delete" topic — 2/8 URLs crawled (some 404s/403s expected), cheat-sheet generated, all 3 chunks stored and searchable.
- [x] **EMAIL SUMMARIZE backend** — SHIPPED Jun 13, 2026 (backend only — frontend button TBD). `POST /api/email/messages/{mid}/summarize` runs the email body through Claude with a Wrench persona, returns 3 lines: WHAT IT IS / WHAT THEY WANT / WHAT TO DO.
- [x] **DB-backed peer tokens panel** — SHIPPED Jun 13, 2026. New `brain_peer_tokens` collection stores SHA-256 hashes of issued tokens; `get_brain_token` now checks env vars AND the DB cache (30s refresh, force-refresh on create/delete). Authenticated CRUD endpoints `/api/peer-tokens` + `PeerTokens.jsx` panel on Home page lets Doc mint/pause/delete tokens for Bud/OG from inside the app — no more chasing emergent env-var dashboard on mobile. Plaintext shown ONCE on creation with copy-to-clipboard + ready-to-paste agent instructions.
- [x] **Lean peer endpoints for Bud** — SHIPPED Jun 13, 2026. `GET /api/brain/peer/lookup?q=` and `GET /api/brain/peer/open-work` — locks Bud's access to just customer lookup + open work instead of firehose. Bud's agent acked the lockdown is working.
- [x] **BRAIN SEARCH bar (home page)** — SHIPPED Jun 12, 2026. `GET /api/brain/search?q=...` queries brain_cases (semantic via embeddings) + library_chunks/ingested emails (regex text match). Unified ranked results with type badge (CASE/LIBRARY/EMAIL). Search bar on Home above tile grid. 300ms debounce. Click result → routes to `/cases?id=...` or `/library` or `/email`. Verified: "LS3 timing" returns 5 ranked case matches.
- [x] **AUTO-INGEST RULES + background loop** — SHIPPED Jun 12, 2026. New collection `email_ingest_rules` ({sender_pattern, subject_pattern, enabled, ingest_count}). CRUD endpoints `/api/email/ingest-rules`. Background loop in scheduler.py runs every 5 min (`SCHED_AUTO_INGEST_INTERVAL_SEC` env), pattern-matches inbox messages, dedupes via `library_items.source_msg_id`. One-tap "AUTO" button in reading pane creates a sender rule. "AUTO (n)" panel in top bar lists/toggles/deletes rules. End-to-end verified — 2 matches ingested first pass, 0 on second (dedupe works).
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
