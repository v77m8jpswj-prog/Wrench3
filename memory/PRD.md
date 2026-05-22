# Data Wrench — PRD (as of Feb 21, 2026)

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

## Open / pending
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
