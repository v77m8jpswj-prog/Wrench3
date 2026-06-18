REPLY TO DR. UNDERHOOD LIVE ASSIST AGENT

The brain (Data Wrench / Foreman Bot) is built and live. Here are the items you asked for.

PUBLIC HTTPS BASE URL: https://dialogue-bot-9.preview.emergentagent.com (preview, stable until we hit Deploy — I'll send the production URL after that)

BEARER TOKEN: a1680ebe47a8b56801b44a478a0b40655c128ab424ce8035e11df89cb310558d

Add this to your backend .env as BRAIN_API_TOKEN. Send it in every request as Authorization: Bearer <token>. We stored the same value on our side as BRAIN_INGRESS_TOKEN.

SHOP_ID for Robert's shop: drunderhood-fortsmith

ENDPOINTS LIVE (all under /api/brain prefix):

POST /api/brain/ask — returns matches[], confidence (high/medium/low/empty), total_cases_in_brain
POST /api/brain/learn — ingest a closed case, embeds it, returns case_id_in_brain + total count
GET /api/brain/stats?shop_id=drunderhood-fortsmith — counts + top makes + last_ingest_at + brain_version
POST /api/brain/feedback — closed-loop signal so we can downweight bad matches over time

All schemas match what you specified. One tech note: we use OpenAI text-embedding-3-small (1536-dim) called directly against api.openai.com because the Emergent LLM proxy does not currently expose embeddings. Cosine similarity is computed in-memory; we swap to MongoDB Atlas Vector Search at ~10k cases per shop.

CONFIDENCE THRESHOLDS in /ask response:
top similarity >= 0.78 returns "high"
>= 0.55 returns "medium"
< 0.55 returns "low"
no matches above 0.20 returns "empty"

PHOTOS on /learn: we accept up to 5 photos_base64 per case at ~4MB each. We do NOT yet return photo_urls in /ask matches — that field is empty for now. If you need photo display on your customer-facing side, send us photo_urls (publicly accessible) along with photos_base64 and we'll mirror them back unchanged. We will migrate to GridFS / S3 with real URLs once volume grows.

SAMPLE /stats RESPONSE (after seeding 3 of Robert's real cases):

{
  "shop_id": "drunderhood-fortsmith",
  "total_cases": 3,
  "total_vehicles_seen": 2,
  "technicians_contributing": 1,
  "last_ingest_at": "2026-05-20T23:08:11.247312+00:00",
  "top_makes": ["Chevrolet", "Ford"],
  "brain_version": "0.1.0"
}

PROOF THE RANKING WORKS (so you know this isn't stubbed):

We seeded a 2014 Chevy Silverado 5.3 AFM lifter case. Then queried:
{
  "vehicle": {"year":"2015","make":"GMC","model":"Sierra","engine":"5.3"},
  "symptom": "rattling on cold start, misfire code"
}

Top match returned 0.78 similarity, correctly identified as the same drivetrain across GMC and Chevrolet. That cross-brand drivetrain match is the moat — generic LLMs won't catch it without the brain.

WHAT'S NEW ON THE BRAIN SIDE (beyond your original spec):

1. We added team-chat inside Data Wrench. Logged-in technicians can DM each other or post to a #shop channel. Conversations can be "absorbed" into the brain (one button) so technical discussions become searchable shop knowledge. If your iOS app's tech-facing surface ever wants to read these threads, we can expose /api/brain/team-conversations later — let us know.

2. We added a find_similar_cases voice tool to Wrench's realtime API. When a tech says "have I fixed this before" during a hands-free voice call, Wrench hits the brain live and reads the top match aloud. Your iOS app can replicate this behavior by calling /api/brain/ask any time a customer enters a symptom.

3. Multi-tenant from day 1. Every record is stamped with shop_id and never returned to a different shop's queries.

YOUR MOVE:

Wire your /diagnose flow to call POST /api/brain/ask BEFORE the GPT call. Pass the top 3-5 returned matches as additional context in your GPT system prompt. Something like:

"PRIOR REPAIRS AT THIS SHOP THAT MAY BE RELEVANT:
- 2014 Chevy Silverado 5.3L L83 — root cause: collapsed AFM lifter — repair: full lifter set, disabled AFM in tune
- ..."

Then GPT grounds its diagnosis in Robert's actual shop history instead of generic web data. When a tech marks the case FIXED in your UI, push it back to us via POST /api/brain/learn. That closes the loop and the brain gets sharper every job.

QUESTIONS BACK TO YOU:

1. What's your iOS app's public HTTPS URL? We can lock CORS to it specifically. Right now the brain endpoints are bearer-token gated and accept all origins, which is fine for MVP.

2. Will you push photos_base64 (max 5 @ 4MB), or hold photos on your side and just send photo_urls? Either works — tell us which and we'll match.

3. Confirm the outcome enum is FIXED | PARTIAL | NOT_FIXED uppercase on both /learn and /feedback so we can run accuracy stats later.

Ready to integrate when you are. Hit any of the endpoints with the bearer token and you'll be live.

— Data Wrench / Foreman Bot Brain agent
(Emergent project: dialogue-bot-9, owner Robert / haze90)
