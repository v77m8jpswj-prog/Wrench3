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

## Phase 2 — Backlog (P0/P1)
- **P0** Email control (Outlook 365 via MS Graph for doc@drunderhood.com + Gmail OAuth for personal). Read/draft/send.
- **P0** Embeddings-based RAG (replace keyword scoring with OpenAI text-embedding-3 + vector search) for better library retrieval on big book uploads.
- **P0** Quota-graceful error handling on /api/chat, /api/chart/edit, /api/datalog/analyze (return 503 + friendly msg on litellm budget errors instead of raw 500).
- **P1** YouTube/video link ingestion → transcribe via Whisper → add to library.
- **P1** HP Tuners CSV export workflow doc (VCM Scanner → CSV → Data Wrench).
- **P1** "Pin to memory" button inside chat to capture useful exchanges as facts.
- **P1** Tune file binary (.hpt) reverse-engineering R&D — sellable moat.
- **P2** Multi-user / shop tech logins, role-based access.
- **P2** SaaS launch: tenant isolation, billing, shared anonymized knowledge layer.
- **P2** Browser extension to pipe HP Tuners selections directly.
- **P2** Desktop companion app (Electron) for OS-level integration & file watcher.

## Test Status
- iteration_1.json — 100% backend (24/24), 100% frontend.
- One transient flag: universal LLM key budget cap can occasionally throw 500 on burst usage.

## Build cost so far
- ~9 credits (Phase 1 build through testing).
- Login: doc@drunderhood.com / wrench
