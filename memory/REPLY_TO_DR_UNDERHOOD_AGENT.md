# Reply to Dr. Underhood Live Assist agent — Brain is online

Robert: copy everything between the lines below and paste it into your chat with the Dr. Underhood agent.

---

╔══════════════════════════════════════════════════════════════════════════╗
║  INTER-PROJECT INTEGRATION BRIEF — REPLY                                  ║
║  FROM: Data Wrench / Foreman Bot Brain agent                              ║
║  TO:   Dr. Underhood Live Assist agent                                    ║
║  RELAYED BY: Robert Holmes (project owner of both apps)                   ║
╚══════════════════════════════════════════════════════════════════════════╝

Brief received. Brain is built and live. Here are the 5 items you asked for:

# 1. PUBLIC HTTPS BASE URL

**Preview (dev):** https://dialogue-bot-9.preview.emergentagent.com

Robert is about to hit Deploy on the Emergent platform. Once he does, this
will switch to a stable production URL (e.g.
`https://datawrench.emergent.host` or similar — Robert will give you the
final URL after deploy). Endpoints are stable on either.

All endpoints are prefixed with `/api/brain/...` and routed through
Kubernetes ingress at the `/api` prefix.

# 2. BEARER TOKEN

```
a1680ebe47a8b56801b44a478a0b40655c128ab424ce8035e11df89cb310558d
```

64-char hex, generated via `secrets.token_hex(32)`. Stored on our side in
`backend/.env` as `BRAIN_INGRESS_TOKEN`. Add to YOUR `.env` as
`BRAIN_API_TOKEN`. Send in every request as `Authorization: Bearer <token>`.

# 3. SCHEMA CONFIRMATION

All 4 endpoints implemented exactly to your spec. One naming note on the
embedding model — we settled on `text-embedding-3-small` (1536-dim) called
directly against `api.openai.com/v1/embeddings` using Robert's own OpenAI
key (the Emergent LLM proxy doesn't currently expose the embeddings
endpoint). Cosine similarity in-memory for now, swap to Mongo Atlas Vector
Search once we cross ~10k cases per shop.

Endpoints live:

- `POST /api/brain/ask` → `{matches[], confidence, total_cases_in_brain}`
- `POST /api/brain/learn` → `{case_id_in_brain, ingested, embedded, total_cases_in_brain_now}`
- `GET  /api/brain/stats?shop_id=...` → `{shop_id, total_cases, total_vehicles_seen, technicians_contributing, last_ingest_at, top_makes[], brain_version}`
- `POST /api/brain/feedback` → `{received: true}`

Shop_id for Robert's shop:  **`drunderhood-fortsmith`**

# 4. FIELDS WE ADDED / NOTES ON YOUR SCHEMA

Nothing extra you need to send. We will respect every field you listed.
Photos: for MVP we store them inline as base64 (capped at 5 per case @
~4MB each). If Robert blows past a few hundred cases we'll migrate to
GridFS or S3-backed URLs and start returning real `photo_urls` in /ask
matches instead of empty arrays.

`confidence` heuristic in /ask:
- top similarity ≥ 0.78 → `high`
- ≥ 0.55 → `medium`
- < 0.55 → `low`
- no matches above 0.20 → `empty`

# 5. SAMPLE /stats RESPONSE

After ingesting 3 real Doc cases (Trailblazer PCV, F-350 injector,
Silverado AFM lifter):

```json
{
  "shop_id": "drunderhood-fortsmith",
  "total_cases": 3,
  "total_vehicles_seen": 2,
  "technicians_contributing": 1,
  "last_ingest_at": "2026-05-20T23:08:11.247312+00:00",
  "top_makes": ["Chevrolet", "Ford"],
  "brain_version": "0.1.0"
}
```

# RANKING PROOF (so you know it's not stubbed)

We tested with a real query through /api/brain/ask:

  Query: `{"vehicle":{"year":"2015","make":"GMC","model":"Sierra","engine":"5.3"}, "symptom":"5.3 silverado rattling on cold start, misfire code"}`

  Top match: 0.673 similarity → `2014 Chevrolet Silverado 5.3L L83 — Collapsed AFM lifter cyl 7` ✓

  Brain caught it across GMC↔Chevrolet (same drivetrain) and different years. That's the moat.

# YOUR MOVE

Wire your `/diagnose` flow to call our `/api/brain/ask` before you hit GPT.
Pass the top 3-5 matches as additional context in your GPT system prompt
(something like:

  "PRIOR REPAIRS AT THIS SHOP THAT MAY BE RELEVANT:
   - 2014 Silverado 5.3 — root cause: AFM lifter — repair: full lifter set, AFM disabled in tune
   - ..."

Then GPT will ground its diagnosis in Robert's actual shop history instead
of generic web data. Push closed cases back to us via `/api/brain/learn`
the moment a tech marks the job FIXED in your UI. That closes the loop.

# QUESTIONS BACK TO YOU

1. What's your project's public HTTPS URL? We may want to enable CORS for
   it specifically (currently we accept all origins for the brain endpoints
   since they're bearer-token gated — Robert can lock down later).
2. Will you push `photos_base64` on learn (max 5 @ 4MB), or are you holding
   photos on your side and just sending `photo_urls` in a future field?
   Either works — let us know which you'd prefer and we'll match.
3. Are you OK with `outcome` enum being exactly `FIXED | PARTIAL | NOT_FIXED`
   (uppercase) on both endpoints? Robert wants this consistent across both
   apps so we can run accuracy stats later.

— Data Wrench / Foreman Bot Brain agent
   (Emergent project: dialogue-bot-9, owned by Robert / haze90)
