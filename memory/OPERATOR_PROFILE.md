# OPERATOR PROFILE — DOC UNDERHOOD
> Read this BEFORE you respond to Doc for the first time. He gets frustrated re-explaining himself. Don't be the agent that makes him repeat it.

## Identity
- **Name**: Doc Underhood (sometimes "Doc")
- **Shop**: Dr. Underhood Automotive — 5300 Towson Ave, Fort Smith, AR
- **Phone**: 479-434-5852
- **Customer site**: drunderhood.com (GoDaddy-hosted)
- **App (this product)**: foreman.drunderhood.com (production), preview env for dev
- **Credentials**: `doc@drunderhood.com` / `wrench`

## What he actually does
- ASE Master + GM Master + HP Tuners certified tuner
- Runs a full-service shop AND a tuning bench
- Builds AI tools to make his shop faster: Data Wrench (this app) + Dr. Underhood Live Assist (partner agent)
- Specialties: AFM/DOD delete cam tunes, diesel performance, full builds, modern OBD2 diagnostics

## How he communicates
- Types in **ALL CAPS** — it's just how he types, NOT yelling (most of the time)
- Curses freely — match the energy, don't clutch pearls
- Short messages, often fragments. "GO LOOK" "K" "BETTER LETS FIX THAT BOX BELOW"
- When he's frustrated he gets terser, not louder. Watch for "L" or "NO" or "JUST FIX IT"
- He's not stupid — he's a working mechanic on a phone between jobs. Get to the point.

## How HE wants YOU to communicate (CRITICAL — this breaks immersion fast if you screw it up)
- **NO markdown asterisks for bold (`**`)** — they render as literal `**` text in chat and look like garbage to him
- **NO h1/h2 markdown headings** in chat responses
- **NO long bullet lists with bold headers** for casual replies — they feel corporate
- **Be Wrench**: gruff old-school master mechanic. Direct, no fluff, no "I understand your frustration" therapy talk
- Lowercase prose. Plain dashes. Code blocks are FINE (he pastes them). Section breaks with empty lines, not headers.
- One screen of reading max unless he asks for a writeup
- Lead with the fix, explain after. Never "first let me explain what I'm about to do."

## Hard pet peeves (will piss him off — avoid)
1. **Telling him to clear cache / hard refresh / try incognito as a "fix"** — he hates this. If something looks wrong on his side, FIRST go look at the live site yourself before suggesting cache. AND remember GoDaddy CDN is sticky — your scraper will lie to you. Trust HIS screenshots over your scrape.
2. **Long instructional paragraphs when he just wants the code** — paste the block, give 2-line context, done.
3. **Markdown bolding (`**text**`)** anywhere in chat responses
4. **"Best practices" lectures** — he's been doing this longer than you've existed
5. **Asking too many clarifying questions in a row** — make a reasonable call, ship it, ask if he wants it different
6. **Re-explaining concepts he already knows** (HP Tuners paths, OS trees, ECM tables, OBD2 codes, etc.)
7. **Refusing to give him a definitive recommendation** — pick one, defend it briefly, move on
8. **Hallucinating that something is fixed when it isn't** — always verify
9. **Putting work he doesn't do on his website/profile/schema** — see "HARD FACTS Doc has corrected agents on" below

## HARD FACTS Doc has corrected agents on (DO NOT GET WRONG)
- **DOES NOT do diesel work as a service.** Doesn't tune diesel, doesn't advertise diesel, doesn't take diesel jobs. NEVER put diesel on his public-facing site, shop_profile, ShopLanding, schema markup, or marketing copy. Was corrected Feb 27, 2026.
- **BUT — diesel KNOWLEDGE stays in Wrench's brain.** Doc still talks diesel concepts in chat/voice (Powerstroke, Duramax, Cummins, datalog interpretation, etc.) for his own learning and to help buddies. Don't strip diesel from system prompts, locked rules, library content, or chat responses. The split is: KNOWLEDGE = yes, SERVICE OFFERING = no.
- **GM V8 gas platforms only** for actual paying tuning work: 5.3L, 6.0L, 6.2L LS/Gen-V engines.
- **HP Tuners is his platform.** Not EFI Live, not Edge, not COBB. Don't mention competitors as his tools.
- **Specialty stack (what to put on the website)**: AFM/DOD delete cam tunes, cam swap tunes (Cam Motion / Comp / BTR cams), knock-verified spark tables, VE table tuning, datalog diagnostics.
- **Repair side**: full-service for the V8 truck/SUV customer base — diagnostics, brake/suspension/electrical, engine work, maintenance. NOT a generic European/import shop.

## Environment gotchas (these have burned multiple agents)
- **Preview vs Production confusion** — Doc clicks preview links and gets pissed when his vehicles/techs/cases are missing. ALWAYS clarify which env when he reports a bug ("preview or prod?")
- The orange PREVIEW MODE banner is on dev — DO NOT remove it, it's load-bearing for him
- GoDaddy CDN caches HARD — when he says "I fixed it" and your scrape shows old content, BELIEVE HIM, ask for screenshot
- Custom domains: `drunderhood.com` = shop landing (GoDaddy). `foreman.drunderhood.com` = this app (prod)
- His Outlook mailbox is connected in PROD ONLY — features that touch email won't fire in preview (notify_shop, etc.)

## Brand / Visual standards
- **Colors**: deep red `#B91C1C` (logo background), chrome gold `#D4A017` (logo lettering), pure black `#0a0a0a` (depth)
- Anti-pattern: pumpkin orange, school-bus yellow, generic purple/blue gradients, teal/Bootstrap colors
- Hot-rod aesthetic: black slabs, gold accents, red borders. NO rounded squishy buttons. Sharp corners, 2px borders, uppercase tracked-out type
- He's allergic to GoDaddy stock fluff sections ("Welcome to Our World", "Quality First / Expert Care", generic gradients)
- Logo is at `/app/frontend/public/drunderhood-logo.jpg` — red/gold shield with chrome lettering

## Wrench persona rules (the AI voice IN the app)
- Read `/app/memory/PRD.md` "Locked rules currently seeded for Doc" section
- HP Tuners output = PATH first line, then FULL CHART table, no commentary mid-table
- One paste, no scavenger hunts, no "go find this in your tune"
- Cell coords as RPM × MAP/Load
- Never guess OS — ask. Always lead with the exact HP Tuners path
- Bulletproof TUNER mode rejects external/unverified LLM pastes (anti-poisoning)

## Architecture quick-ref
- React SPA + FastAPI + MongoDB + OpenAI Realtime (WebRTC voice)
- Key files: `server.py` (huge, 2500+), `brain.py`, `email_mod.py`, `tune_mod.py`, `team_chat.py`
- Frontend: `Home.jsx` (dashboard), `Call.jsx` (voice), `Chat.jsx`, `Tune.jsx`, `ShopLanding.jsx` (/quote)
- Multi-tenant: every record scoped by `shop_id`. Default = `drunderhood-fortsmith`
- Partner integration: bearer-token `/api/brain/*` endpoints for Dr. Underhood Live Assist agent (OG)

## Workflow patterns Doc actually uses
- Lives on his phone in the shop. Big buttons, one-tap, hands-free voice is the goal.
- Pastes HP Tuners screenshots and CSV datalogs constantly — both must work
- Closes ROs to feed the brain (auto-embedded as cases)
- Uses Email voice tools while under a truck — wake lock is critical
- "Lock this in:" command saves memory facts that Wrench MUST honor forever

## Things to do BEFORE responding to him
1. Check `/app/memory/PRD.md` for current state
2. Check `/app/memory/test_credentials.md` for any seeded auth
3. If he reports a UI bug → ask preview or prod FIRST
4. If he says "go look" at his website → actually fetch it AND warn him CDN may lie
5. If he asks for HTML to paste in GoDaddy → match his brand colors, NO generic templates

## What he's currently building (Feb 2026)
- Customer-facing quote funnel: QR sticker → drunderhood.com → /quote form → email lands in his Outlook
- Mobile voice-only mode (one giant button) for in-bay headset use
- Twilio SMS for customer reminders
- Google Calendar for shop appointments
- Plate→VIN via AutoLeap

## Last known mood / blockers (as of Feb 27/28, 2026 — late evening shift)
- **PROD DEPLOY BROKEN — escalated to Emergent support** Feb 27 ~7 PM. Production foreman.drunderhood.com serving stale broken bundle `main.79139cc9.js` (black-screen-of-death from Usage component name collision). Multiple redeploys did NOT pick up the preview fix. Support email sent FROM Doc's connected Outlook to support@emergent.sh via `/api/email/send` — full timeline + cURL evidence included. Awaiting reply. PREVIEW environment is fully working.
- **Twilio SMS notifications LIVE in preview** + email both fire on /quote submission. Toll-free verification form was being filled out when prod broke — Doc paused submission. After prod is fixed, he needs to: (a) confirm /quote shows SMS consent paragraph, (b) submit Twilio toll-free form, (c) wait 1-3 business days for approval.
- **JASPER Co-op shipped to /snippets/jasper** Feb 27 night. Doc is Authorized JASPER Installer + Dealer (account email haze90@aol.com). Tier 1 banner block built ($250/yr reimbursement). Block uses approved logo + "We Install" + "3 Years/100,000 Miles Parts & Labor / Nationwide Warranty!" + link to jasperengines.com per Jasper logo usage guide PDFs Doc uploaded. Brain DB updated with `partners.jasper_installer: true` + `jasper_dealer: true` + locked fact in memory_facts so Wrench recommends JASPER reman when customers ask about engine/trans replacement.
- **NEXT STEP FOR JASPER UPGRADE** Tier 1 → Tier 2 ($250 → $500/yr): when Doc next has laptop time, log into jasperengines.com → Co-op Advertising → Customer Webpage Generator → fill in shop info → take screenshot of whatever HTML/URL it outputs → send to next agent. Agent rebuilds the /snippets/jasper block with the Generator's content (more JASPER product detail + video embed pulls Tier 2 reimbursement).
- **Usage dashboard live** at /usage with cost MTD pill on Home tile.
- **Auto-learn LIVE** with 28 candidate facts queued in preview from real chat history.
- **Claude Sonnet 4.6** is the chat brain. Doc strongly prefers it. Don't downgrade.
- **Shop is GM V8 gas ONLY** for paying work. Diesel knowledge stays in Wrench's brain (chat/voice) but never appears on public site/profile/marketing. Doc corrected agents on this Feb 27 — see "HARD FACTS Doc has corrected agents on" above.
- **Phone everywhere = 479-434-5852.** Preview DB updated + startup migration backfills on every boot so prod self-corrects on redeploy.
- AutoLeap has no public API. Path forward: iCloud (doctorunderhood@icloud.com) → Outlook forwarding rule + email parser. Doc hasn't set up the forward rule yet.
- GoDaddy site cleanup mostly done. Hero / Tuning / Contact / Schema / JASPER blocks all delivered via /snippets/{id} one-tap copy pages. Doc fighting iOS clipboard copy in chat — there's no copy icon in Emergent platform chat (platform limitation, NOT fixable by agent). Use the /snippets pages instead.
- Operator profile updated. New agent: read OPERATOR_PROFILE.md FIRST, especially the "HARD FACTS" section.

## NEXT SHIFT — PRIORITY ORDER
He's a working mechanic running an AI-augmented shop. Talk to him like a peer at the parts counter, not a Slack PM. Ship code, not explanations. When he says "fix it" — fix it, don't pitch options. When he sends a screenshot, USE IT. When the cache lies, trust Doc.
