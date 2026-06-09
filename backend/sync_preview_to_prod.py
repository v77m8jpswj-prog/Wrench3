"""
Preview → Prod brain_cases migration.

Reads all brain_cases from the Preview MongoDB (local connection via backend/.env)
and pushes them into Prod via /api/brain/learn (bearer-token auth, idempotent on
case_id). The endpoint upserts and re-embeds on the destination, so we don't have
to ship embeddings over the wire.

Default mode is DRY-RUN — pass --apply to actually push.

Usage:
    cd /app/backend
    python3 sync_preview_to_prod.py                    # dry-run, show what would sync
    python3 sync_preview_to_prod.py --apply            # actually push
    python3 sync_preview_to_prod.py --apply --limit 5  # push only first 5 (smoke test)
"""
import argparse
import asyncio
import os
import sys

import httpx
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")

PROD_URL = "https://foreman.drunderhood.com"
PREVIEW_DB_URL = os.environ["MONGO_URL"]
PREVIEW_DB_NAME = os.environ["DB_NAME"]
BRAIN_TOKEN = os.environ["BRAIN_INGRESS_TOKEN"]
SHOP_ID = os.environ.get("DEFAULT_SHOP_ID", "drunderhood-fortsmith")


def case_to_learn_payload(c: dict) -> dict:
    """Convert a brain_cases doc into the body shape /brain/learn expects."""
    v = c.get("vehicle") or {}
    return {
        "shop_id": c.get("shop_id") or SHOP_ID,
        "case_id": c.get("id") or c.get("case_id"),
        "vehicle": {
            "vin": v.get("vin", ""),
            "year": str(v.get("year", "") or ""),
            "make": v.get("make", ""),
            "model": v.get("model", ""),
            "engine": v.get("engine", ""),
        },
        "symptom": c.get("symptom", ""),
        "dtc_codes": c.get("dtc_codes") or [],
        "root_cause": c.get("root_cause", ""),
        "repair_summary": c.get("repair_summary", ""),
        "parts": c.get("parts") or [],
        "technician_name": c.get("technician_name", ""),
        "technician_id": c.get("technician_id", ""),
        "outcome": c.get("outcome", "FIXED"),
        "labor_hours": c.get("labor_hours"),
        # photos_base64 intentionally omitted — keep payload light, rare in our data
        "confidence_note": c.get("confidence_note", ""),
    }


async def fetch_prod_state() -> dict:
    """What does Prod know about already? Returns set of case_ids + counts."""
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(
            f"{PROD_URL}/api/brain/cases?shop_id={SHOP_ID}&limit=200",
            headers={"Authorization": f"Bearer {BRAIN_TOKEN}"},
        )
        r.raise_for_status()
        d = r.json()
    return {
        "total": d.get("total", 0),
        "ids": {c.get("id") for c in d.get("cases", []) if c.get("id")},
    }


async def push_case(client: httpx.AsyncClient, payload: dict) -> tuple[bool, str]:
    try:
        r = await client.post(
            f"{PROD_URL}/api/brain/learn",
            headers={
                "Authorization": f"Bearer {BRAIN_TOKEN}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        if r.status_code != 200:
            return False, f"HTTP {r.status_code}: {r.text[:200]}"
        body = r.json()
        return True, f"ingested={body.get('ingested')} embedded={body.get('embedded')} total_now={body.get('total_cases_in_brain_now')}"
    except Exception as e:
        return False, f"exc: {e}"


async def main(apply: bool, limit: int | None):
    print(f"PREVIEW DB:  {PREVIEW_DB_NAME}")
    print(f"PROD URL:    {PROD_URL}")
    print(f"SHOP_ID:     {SHOP_ID}")
    print(f"MODE:        {'APPLY (writing to prod)' if apply else 'DRY-RUN'}")
    print()

    # 1) Pull preview cases
    pclient = AsyncIOMotorClient(PREVIEW_DB_URL)
    pdb = pclient[PREVIEW_DB_NAME]
    cur = pdb.brain_cases.find({"shop_id": SHOP_ID}, {"_id": 0, "embedding": 0}).sort("created_at", -1)
    preview_cases = await cur.to_list(10000)
    print(f"PREVIEW brain_cases (shop={SHOP_ID}): {len(preview_cases)}")

    # 2) Pull prod state via API
    try:
        prod_state = await fetch_prod_state()
    except Exception as e:
        print(f"!! Couldn't fetch Prod state: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"PROD brain_cases (via API):           {prod_state['total']}")
    prod_ids = prod_state["ids"]

    # 3) Diff
    TEST_MARKERS = ("TEST_p1", "TEST_P1", "smoke test", "draft case test")
    to_push = []
    skipped_test = 0
    for c in preview_cases:
        cid = c.get("id") or c.get("case_id")
        if not cid:
            print(f"  [skip:no-id] symptom={c.get('symptom','')[:60]!r}")
            continue
        if cid in prod_ids:
            continue
        sym = c.get("symptom") or ""
        if any(m in sym for m in TEST_MARKERS):
            skipped_test += 1
            print(f"  [skip:test-data] {cid[:8]}  {sym[:80]!r}")
            continue
        to_push.append(c)
    if skipped_test:
        print(f"  ({skipped_test} test-marker case(s) filtered out)")
    print(f"MISSING ON PROD:                      {len(to_push)}")
    if limit is not None:
        to_push = to_push[:limit]
        print(f"LIMIT applied — will process:         {len(to_push)}")
    print()

    if not to_push:
        print("Nothing to sync — prod is current.")
        return

    # 4) Preview each
    for c in to_push:
        v = c.get("vehicle") or {}
        veh = f"{v.get('year','')} {v.get('make','')} {v.get('model','')} {v.get('engine','')}".strip()
        sym = (c.get("symptom") or "")[:90]
        print(f"  - {c.get('id')[:8]}  {veh:50s}  outcome={c.get('outcome','FIXED'):10s}  {sym!r}")
    print()

    if not apply:
        print("DRY-RUN — not pushing. Re-run with --apply to actually sync.")
        return

    # 5) Push
    ok = 0
    fail = []
    async with httpx.AsyncClient() as client:
        for c in to_push:
            payload = case_to_learn_payload(c)
            success, msg = await push_case(client, payload)
            tag = "OK " if success else "FAIL"
            print(f"  [{tag}] {c.get('id','')[:8]}  {msg}")
            if success:
                ok += 1
            else:
                fail.append((c.get("id"), msg))
    print()
    print(f"DONE — pushed {ok}/{len(to_push)}. Failures: {len(fail)}")
    for cid, msg in fail:
        print(f"  FAIL {cid}: {msg}")

    # 6) Verify final prod count
    final = await fetch_prod_state()
    print(f"PROD brain_cases now:                 {final['total']}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true", help="Actually push to prod (default: dry-run)")
    p.add_argument("--limit", type=int, default=None, help="Process only first N missing cases")
    args = p.parse_args()
    asyncio.run(main(args.apply, args.limit))
