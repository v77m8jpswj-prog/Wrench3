#!/usr/bin/env python3
"""
Migrate Data Wrench data from PREVIEW MongoDB → PRODUCTION MongoDB.

Copies (per-user, idempotent — upsert by `id`):
  - users (skipped by default to avoid clobbering prod passwords; use --include-users to force)
  - vehicles
  - library_items, library_chunks      (RAG brain)
  - brain_cases                        (multi-tenant brain)
  - memory_facts                       (locked rules + memory)
  - credentials                        (vault — scraper logins)
  - chat_sessions                      (history)
  - search_cache                       (web-search cache)

Usage:
  PROD_MONGO_URL="mongodb+srv://..."  PROD_DB_NAME="data_wrench" \
  python3 /app/scripts/migrate_preview_to_prod.py [--dry-run] [--include-users] [--owner-email doc@drunderhood.com]

Source connection comes from the existing /app/backend/.env (MONGO_URL / DB_NAME).
"""
import argparse, asyncio, os, sys
from datetime import datetime, timezone
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")

SRC_URL = os.environ.get("MONGO_URL")
SRC_DB  = os.environ.get("DB_NAME")
DST_URL = os.environ.get("PROD_MONGO_URL")
DST_DB  = os.environ.get("PROD_DB_NAME")

COLLECTIONS_DEFAULT = [
    "vehicles",
    "library_items", "library_chunks",
    "brain_cases",
    "memory_facts",
    "credentials",
    "chat_sessions",
    "search_cache",
]

async def copy_collection(src_db, dst_db, coll: str, owner_id: str | None, dry: bool) -> dict:
    src = src_db[coll]
    dst = dst_db[coll]
    q = {}
    # Scope to owner where the schema has user_id (most do); search_cache/brain_cases scope by shop
    if owner_id and coll in {"vehicles", "library_items", "library_chunks", "memory_facts", "credentials", "chat_sessions"}:
        q["user_id"] = owner_id
    docs = await src.find(q, {"_id": 0}).to_list(100000)
    if not docs:
        return {"coll": coll, "src_count": 0, "upserted": 0, "modified": 0}
    if dry:
        return {"coll": coll, "src_count": len(docs), "upserted": "DRY", "modified": "DRY"}
    upserted = 0; modified = 0
    for d in docs:
        # Pick a stable key
        key = None
        for kf in ("id", "case_id", "session_id", "query_hash"):
            if kf in d and d[kf]:
                key = {kf: d[kf]}; break
        if not key:
            # Insert blindly (rare — search_cache may use composite key)
            await dst.insert_one(d)
            upserted += 1
            continue
        d["_migrated_at"] = datetime.now(timezone.utc).isoformat()
        res = await dst.update_one(key, {"$set": d}, upsert=True)
        if res.upserted_id:
            upserted += 1
        elif res.modified_count:
            modified += 1
    return {"coll": coll, "src_count": len(docs), "upserted": upserted, "modified": modified}

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-users", action="store_true", help="Also copy users (will overwrite prod passwords)")
    parser.add_argument("--owner-email", default=None, help="Limit migration to one owner's data (recommended)")
    parser.add_argument("--collections", nargs="*", default=None, help="Override which collections to copy")
    args = parser.parse_args()

    if not all([SRC_URL, SRC_DB, DST_URL, DST_DB]):
        print("ERROR: need MONGO_URL/DB_NAME (preview, from /app/backend/.env) and PROD_MONGO_URL/PROD_DB_NAME (env vars).")
        sys.exit(1)

    print(f"SOURCE → {SRC_DB}")
    print(f"TARGET → {DST_DB}  (host={DST_URL.split('@')[-1].split('/')[0]})")
    print(f"DRY-RUN={args.dry_run}  INCLUDE-USERS={args.include_users}  OWNER={args.owner_email or '*all*'}")
    print("-" * 70)

    src_client = AsyncIOMotorClient(SRC_URL)
    dst_client = AsyncIOMotorClient(DST_URL)
    src_db = src_client[SRC_DB]
    dst_db = dst_client[DST_DB]

    owner_id = None
    if args.owner_email:
        u = await src_db.users.find_one({"email": args.owner_email}, {"_id": 0})
        if not u:
            print(f"ERROR: owner email {args.owner_email} not found in source DB.")
            sys.exit(1)
        owner_id = u["id"]
        print(f"Owner ID = {owner_id}")

        # Also try to ensure same user_id exists on prod (else their data won't show on login)
        prod_user = await dst_db.users.find_one({"email": args.owner_email}, {"_id": 0})
        if not prod_user:
            print(f"WARNING: {args.owner_email} doesn't exist on prod yet. Their data will be migrated but they'll need to log in / register on prod first.")
        elif prod_user["id"] != owner_id:
            print(f"WARNING: prod user_id ({prod_user['id']}) != preview user_id ({owner_id}).")
            print("         Data will be inserted with PREVIEW user_id and won't show under prod login.")
            print(f"         Fix: on prod DB run db.users.updateOne({{email:'{args.owner_email}'}}, {{$set:{{id:'{owner_id}'}}}})")
            ans = input("Proceed anyway? [y/N] ").strip().lower()
            if ans != "y":
                sys.exit(0)

    colls = args.collections or COLLECTIONS_DEFAULT[:]
    if args.include_users:
        colls = ["users"] + colls

    results = []
    for c in colls:
        try:
            r = await copy_collection(src_db, dst_db, c, owner_id, args.dry_run)
        except Exception as e:
            r = {"coll": c, "ERROR": str(e)}
        print(f"  {c:<22}  {r}")
        results.append(r)

    print("-" * 70)
    print("DONE.")

if __name__ == "__main__":
    asyncio.run(main())
