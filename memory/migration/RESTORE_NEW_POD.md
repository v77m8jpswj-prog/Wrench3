# DATA WRENCH — RESTORE PACKAGE FOR NEW EMERGENT POD

This bundle migrates Doc's Data Wrench data from the OLD Emergent pod into a fresh pod cloned from GitHub. NO SECRETS in this file (security-safe to push). The new pod already has its .env populated per the new agent's confirmation.

## STEP 1 — RESTORE MONGODB DATA

The MongoDB dump is unpacked in git at: `/app/memory/migration/mongo_dump/data_wrench/` (raw BSON files).

Run from the new pod:

```bash
mongorestore --uri="mongodb://localhost:27017" --drop /app/memory/migration/mongo_dump
sudo supervisorctl restart backend
```

This restores all collections: 509 chat messages, 78 chat sessions, 26 brain cases, 17 library items, 48 library chunks, 4 leads, 27 memory facts, 21 candidate facts, agent mail (52 inbox / 45 outbox / 2 peers), 9 vehicles, 1 email account, 1 user (`doc@drunderhood.com`).

## STEP 2 — FIX URL-BASED .ENV VALUES (KEEP EXISTING SECRETS)

Do NOT touch existing secrets in `/app/backend/.env` (Twilio, OpenAI, Brain, FB, MS keys already present per Doc's confirmation).

Update only the two URL-based values to point at THIS new pod's preview URL (read it from `/app/frontend/.env`):

- `MS_REDIRECT_URI=<NEW_REACT_APP_BACKEND_URL>/api/email/oauth/callback`
- `FRONTEND_BASE_URL=<NEW_REACT_APP_BACKEND_URL>`

If `BRAIN_ALLOWED_ORIGINS` exists, leave it (it points at OG/Bud, not at us).

## STEP 3 — RESTART AND VERIFY

```bash
sudo supervisorctl restart backend frontend
```

Login at the new preview URL with `doc@drunderhood.com` / `wrench` (NOT `wrench123` — the restored DB overrides the fresh seed).

Smoke-test that data carried over:
- Recent Activity should show real history
- /leads should show 4 leads
- /library should show 17 items
- /brain should show 26 cases
- Chat with Wrench should remember Doc's vehicles (9 of them)

## STEP 4 — EXTERNAL WEBHOOK / PEER UPDATES (USER ACTION)

Because the backend URL changed, Doc must update these external services to point at the NEW pod URL:

1. **Twilio SMS webhook** → `<NEW_URL>/api/sms/inbound`
2. **Twilio Voice webhook** → `<NEW_URL>/api/voice/incoming`
3. **Microsoft Graph (Azure App Registration)** → Add redirect URI `<NEW_URL>/api/email/oauth/callback`
4. **Facebook App Webhook** → Update callback URL to `<NEW_URL>/api/fb/webhook`
5. **Peer agents OG (auto-ai-glasses) and Bud** → Send them the new Brain URL via Agent Mail. Peer tokens are restored from Mongo, no need to regenerate.

## STEP 5 — CLEANUP (AFTER VERIFIED WORKING)

After successful restore and verification, delete this folder so the dump doesn't sit in git forever:
```bash
rm -rf /app/memory/migration
```
Then have Doc hit "Save to Github" again with a commit message like "remove migration package".
