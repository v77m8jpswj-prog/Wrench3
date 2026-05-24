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
