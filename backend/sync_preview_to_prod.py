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

    pclient = AsyncIOMotorClient(PREVIEW_DB_URL)
    pdb = pclient[PREVIEW_DB_NAME]

    # ============================================================
    # PART 1 — brain_cases via /brain/learn (idempotent on case_id)
    # ============================================================
    print("==[ BRAIN_CASES ]" + "=" * 50)
    cur = pdb.brain_cases.find({"shop_id": SHOP_ID}, {"_id": 0, "embedding": 0}).sort("created_at", -1)
    preview_cases = await cur.to_list(10000)
    print(f"PREVIEW brain_cases (shop={SHOP_ID}): {len(preview_cases)}")

    try:
        prod_state = await fetch_prod_state()
    except Exception as e:
        print(f"!! Couldn't fetch Prod state: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"PROD brain_cases (via API):           {prod_state['total']}")
    prod_ids = prod_state["ids"]

    TEST_MARKERS = ("TEST_p1", "TEST_P1", "smoke test", "draft case test")
    to_push = []
    skipped_test = 0
    for c in preview_cases:
        cid = c.get("id") or c.get("case_id")
        if not cid:
            continue
        if cid in prod_ids:
            continue
        sym = c.get("symptom") or ""
        if any(m in sym for m in TEST_MARKERS):
            skipped_test += 1
            continue
        to_push.append(c)
    print(f"MISSING ON PROD:                      {len(to_push)} (filtered {skipped_test} test rows)")

    if limit is not None:
        to_push = to_push[:limit]

    if to_push and apply:
        async with httpx.AsyncClient() as client:
            ok = 0
            for c in to_push:
                payload = case_to_learn_payload(c)
                success, msg = await push_case(client, payload)
                tag = "OK " if success else "FAIL"
                print(f"  [{tag}] {c.get('id','')[:8]}  {msg}")
                if success:
                    ok += 1
            print(f"  pushed {ok}/{len(to_push)}")
    elif to_push:
        for c in to_push:
            v = c.get("vehicle") or {}
            veh = f"{v.get('year','')} {v.get('make','')} {v.get('model','')}".strip()
            print(f"  - {c.get('id','')[:8]}  {veh:35s}  {(c.get('symptom') or '')[:80]!r}")
    else:
        print("  nothing to sync — prod is current.")
    print()

    # ============================================================
    # PART 2 — memory_facts + candidate_facts via /brain/sync-facts
    # ============================================================
    print("==[ MEMORY_FACTS + CANDIDATE_FACTS ]" + "=" * 30)
    mem = await pdb.memory_facts.find({}, {"_id": 0}).to_list(10000)
    cand = await pdb.candidate_facts.find({}, {"_id": 0}).to_list(10000)
    print(f"PREVIEW memory_facts:                 {len(mem)}")
    print(f"PREVIEW candidate_facts:              {len(cand)}")
    if not apply:
        # preview a sample
        for m in mem[:5]:
            print(f"  - mem: {(m.get('fact') or '')[:100]!r}")
        for c in cand[:3]:
            print(f"  - cand({c.get('category','?')}, conf={c.get('confidence','?')}): {(c.get('fact') or '')[:90]!r}")
    if apply and (mem or cand):
        payload = {
            "shop_id": SHOP_ID,
            "memory_facts": [{"id": m.get("id"), "fact": m.get("fact"), "created_at": m.get("created_at")} for m in mem],
            "candidate_facts": [
                {
                    "id": c.get("id"), "fact": c.get("fact"), "norm": c.get("norm"),
                    "category": c.get("category"), "confidence": c.get("confidence"),
                    "seen_count": c.get("seen_count"), "status": c.get("status"),
                    "sources": c.get("sources"), "created_at": c.get("created_at"),
                } for c in cand
            ],
        }
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{PROD_URL}/api/brain/sync-facts",
                headers={"Authorization": f"Bearer {BRAIN_TOKEN}", "Content-Type": "application/json"},
                json=payload,
            )
        if r.status_code != 200:
            print(f"  FAIL HTTP {r.status_code}: {r.text[:300]}")
        else:
            j = r.json()
            print(f"  OK  mem inserted={j['memory_facts']['inserted']} skipped={j['memory_facts']['skipped_duplicate']} total_now={j['memory_facts']['total_now']}")
            print(f"      cand inserted={j['candidate_facts']['inserted']} skipped={j['candidate_facts']['skipped_duplicate']} total_now={j['candidate_facts']['total_now']}")
    print()

    # ============================================================
    # PART 3 — library_items + library_chunks via /brain/sync-library
    # ============================================================
    print("==[ LIBRARY ]" + "=" * 53)
    items = await pdb.library_items.find({}, {"_id": 0}).to_list(10000)
    items_with_chunks = []
    for it in items:
        chunks = await pdb.library_chunks.find({"item_id": it["id"]}, {"_id": 0}).to_list(5000)
        it_copy = dict(it)
        it_copy["chunks"] = chunks
        items_with_chunks.append(it_copy)
    total_chunks = sum(len(it["chunks"]) for it in items_with_chunks)
    print(f"PREVIEW library_items:                {len(items_with_chunks)} ({total_chunks} chunks)")
    if not apply:
        for it in items_with_chunks[:10]:
            print(f"  - {it.get('id','')[:8]}  kind={it.get('kind'):6s} chunks={len(it.get('chunks',[])):3d}  name={it.get('name','')[:60]!r}")
    if apply and items_with_chunks:
        payload = {"shop_id": SHOP_ID, "items": items_with_chunks}
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(
                f"{PROD_URL}/api/brain/sync-library",
                headers={"Authorization": f"Bearer {BRAIN_TOKEN}", "Content-Type": "application/json"},
                json=payload,
            )
        if r.status_code != 200:
            print(f"  FAIL HTTP {r.status_code}: {r.text[:300]}")
        else:
            j = r.json()
            print(f"  OK  items inserted={j['items']['inserted']} skipped={j['items']['skipped_duplicate']} total_now={j['items']['total_now']}")
            print(f"      chunks inserted={j['chunks']['inserted']} total_now={j['chunks']['total_now']}")
    print()

    if not apply:
        print("DRY-RUN — re-run with --apply to actually sync all three streams.")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true", help="Actually push to prod (default: dry-run)")
    p.add_argument("--limit", type=int, default=None, help="Process only first N missing cases")
    args = p.parse_args()
    asyncio.run(main(args.apply, args.limit))
