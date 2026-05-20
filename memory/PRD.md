# Data Wrench — Product Requirements Document

## Original problem statement
> "Talk to text or can you talk back?" — evolved through discussion into **Data Wrench**, an AI Foreman / personal shop assistant for Dr. Underhood Automotive.

## User persona
- **Doc** — 51yo shop owner, GM Master Tech, ASE Master Certified, 15 yrs running Dr. Underhood Automotive
- 5+ years HP Tuners experience, owner@drunderhood.com (Outlook 365)
- Wants an AI that learns *his* style, knows automotive deeply, edits HP Tuners tables, and one day gets sold as SaaS to other performance shops.

## Vision & moat
- Built **by** a Master Tech, **for** Master Techs. Personality + domain depth = product moat.
- Phase 1 = sharpen it on Doc's bench. Phase 2 = multi-tenant SaaS for performance/tuner shops nationwide.
- Pricing target: $99–$299/mo per shop.

## Personality: "Wrench"
- Gruff, old-school mechanic. Smart-ass dry humor. Mirrors user energy.
- **Heat detector**: when user cusses at it / yells / says "just answer" / "shut up" → drops attitude, gives clean answer, shuts up.
- Voice: **OpenAI Onyx** (deepest, gritty). 9 voices available to switch.

## Architecture
- **Backend**: FastAPI + MongoDB + emergentintegrations (`LlmChat` w/ openai gpt-5.2, `OpenAITextToSpeech`, `OpenAISpeechToText`) using EMERGENT_LLM_KEY universal key.
- **Frontend**: React 19 + React Router v7, Tailwind, Barlow Condensed (heads) + JetBrains Mono (data), Framer Motion, lucide-react icons.
- **Auth**: JWT 30-day + bcrypt. Single user MVP.
- **Aesthetic**: Dark gunmetal industrial; rust orange + amber accents; hazard stripes; oscilloscope-style status bar.

## Phase 1 — DONE (Jan 2026)
- [x] Auth (signup/login/me, JWT)
- [x] Voice + Text chat with GPT-5.2 + memory of session
- [x] Wrench personality + heat detection (cussing/CAPS → tightens up)
- [x] **Chart Editor** (paste HP Tuners table → instruct → modified table back, cells flagged)
- [x] **Library RAG** (PDF/TXT/CSV upload, keyword retrieval, citations in chat)
- [x] **Datalog Analyzer** (CSV → knock/AFR/trim findings w/ cell coords)
- [x] **Vehicle garage** (CRUD: year/make/model/VIN/engine/mods/notes)
- [x] **Long-term memory facts** (pinned shop knowledge)
- [x] Voice playback (OpenAI TTS Onyx) + mic recording (Whisper STT)
- [x] Conversation history (sessions list, restore session)
- [x] Settings (voice picker, voice on/off, default mode)
- [x] Direct vs Dream-out-loud response modes
- [x] **WebRTC Realtime voice calls** with tool calling (send_link, send_note, save_vehicle_from_vin, edit_chart, lookup_credentials, etc.)
- [x] **Vault** for storing shop logins/passwords (since browsers sandbox tabs/password managers — `lookup_credentials` tool pulls them on voice command)

## Phase 1.5 — DONE (Feb 2026)
- [x] **Schematic snip vision chat** — Doc drops a wiring/pinout/dash image via paperclip, drag-drop, or Cmd-V paste → Wrench reads it via GPT-5.2 Vision (`/api/chat/vision`)
- [x] **Anti-hallucination guardrails** — Wrench refuses to fabricate pinouts/wire colors/torque specs cold; asks for the snip first
- [x] **Auto-clickable links inline** in chat (URLs in Wrench's replies render as `<a>` tags, not spelled out)
- [x] Fixed duplicate `haltWrench` blocker that was preventing frontend build
- [x] **Mobile chat layout flipped** — input bar moved to top on mobile (thumb-reach), newest message at top via `flex-col-reverse`, hamburger menu always accessible from sticky top header
- [x] **PWA manifest + icons** — Wrench-branded app icon for iPhone/Android home screen install, standalone display, rust theme color, custom title "Wrench"

## Phase 2 — IN PROGRESS (Feb 2026 — "The Brain")
- [x] **Multi-tenant data model** — every record scoped by `shop_id` (default: `drunderhood-fortsmith`)
- [x] **Tech logins** — owner can add team members through Settings → SHOP TEAM. Roles: `owner` | `tech`. `require_owner` middleware guards tech mgmt.
- [x] **Cases brain (RAG over closed repairs)** — new `brain_cases` Mongo collection. Vehicle + symptom + DTC + root cause + repair + parts + outcome + photos. Embedded via OpenAI `text-embedding-3-small` (1536-dim, Doc's OpenAI key). Cosine sim in-memory.
- [x] **Cases UI** — `/cases` page with full CRUD, outcome badges. "SAVE AS CASE" button on chat sessions auto-drafts a case from the conversation.
- [x] **External brain API** (bearer-token gated, multi-tenant from day 1): `/api/brain/ask`, `/api/brain/learn`, `/api/brain/stats`, `/api/brain/feedback`
- [x] **Team Chat (intra-shop messaging)** — `/team` sidebar tab. `#SHOP` channel for everyone + DMs between any two techs. Auto-poll every 8s. Per-thread unread badges. "ABSORB → BRAIN" button ingests last 50 messages as a searchable case so future Wrench answers can recall shop conversations.
- [x] **Voice-call brain tool** — `find_similar_cases` tool registered in the OpenAI Realtime API tool list. When Doc says "have I fixed this before?" on a hands-free voice call, Wrench hits `/api/cases/search` and reads the top match aloud + drops a copy-able note with the full details (vehicle, root cause, repair, parts).
- [x] **Cross-project reply letter** drafted for Dr. Underhood Live Assist agent → `/app/memory/REPLY_TO_DR_UNDERHOOD_AGENT.md` (clean, no boxes, one-finger thumb-copy)

## Phase 2.5 — Backlog
- **P0** Outlook 365 + Gmail OAuth for shop email
- **P0** Atlas Vector Search swap (once ≥ 10k cases per shop)
- **P0** Quota-graceful error handling on /api/chat, /api/chart/edit (return 503 instead of raw 500)
- **P1** Photo storage → GridFS / S3 with real `photo_urls` in /ask responses
- **P1** Wrench chat tool: `find_similar_cases(symptom, vehicle)` — call brain from inside active voice call
- **P1** "Save chat as case" prefilled vehicle from active vehicle context
- **P1** YouTube transcript → library, pin-chat-to-memory button, `.hpt` binary R&D
- **P2** SaaS launch: tenant billing, signup flow for other shops, shared/anonymized cross-shop knowledge layer (opt-in)
- **P2** Browser extension, Electron companion

## Phase 1.5 — DONE (Feb 2026)
- iteration_1.json — 100% backend (24/24), 100% frontend.
- One transient flag: universal LLM key budget cap can occasionally throw 500 on burst usage.

## Build cost so far
- ~9 credits (Phase 1 build through testing).
- Login: doc@drunderhood.com / wrench
