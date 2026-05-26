"""
Data Wrench — Web Scraper / Brain Feeder
Reads webpages (public OR behind login via Vault credentials), extracts clean text,
and ingests it as a Library document so Wrench can RAG over it forever.

Supported login flows out of the box:
  - HP Tuners forum (public scrape, no login needed)
  - AllData (alldatadiy.com / alldata.com) — uses Vault creds
  - Identifix (identifix.com) — uses Vault creds
  - Generic — best-effort scrape, may need login refinement

Architecture:
  POST /api/scrape/url    body: {url, vault_credential_id?, title_hint?}
   -> auto-detect domain
   -> if public: requests + BS4
   -> if needs auth: Playwright headless w/ stored creds, dump <main>/<article>
   -> chunk + insert into library_chunks (RAG index)
   -> return ingest summary
"""
import os
import re
import logging
import asyncio
from typing import Optional, Dict, Any, List
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger("datawrench.scraper")

# Mapping: domain -> (login_url, username_selector, password_selector, submit_selector, success_wait_selector or None)
LOGIN_RECIPES: Dict[str, Dict[str, Any]] = {
    "alldatadiy.com": {
        "login_url": "https://www.alldata.com/diy-us/en/diy/login",
        "username_selector": "#edit-username",
        "password_selector": "#edit-password",
        "submit_selector": "#edit-submit",
        "success_marker": "logout",
    },
    "alldata.com": {
        # Pro / shop subscription. Login lives on my.alldata.com root.
        "login_url": "https://my.alldata.com/",
        "username_selector": "input[name=valUserName]",
        "password_selector": "input[name=valPassword]",
        "submit_selector": "#btnLogin",
        "success_marker": "logout",
    },
    "my.alldata.com": {
        "login_url": "https://my.alldata.com/",
        "username_selector": "input[name=valUserName]",
        "password_selector": "input[name=valPassword]",
        "submit_selector": "#btnLogin",
        "success_marker": "logout",
    },
    "identifix.com": {
        "login_url": "https://dh.identifix.com/Default/LogOnIdentifix",
        "username_selector": "#UserName",
        "password_selector": "#Password",
        "submit_selector": "#Login",
        "success_marker": "logout",
    },
    "dh.identifix.com": {
        "login_url": "https://dh.identifix.com/Default/LogOnIdentifix",
        "username_selector": "#UserName",
        "password_selector": "#Password",
        "submit_selector": "#Login",
        "success_marker": "logout",
    },
    "forum.hptuners.com": {
        "login_url": None,
    },
    "hptuners.com": {
        "login_url": None,
    },
}


def _domain_recipe(url: str) -> Optional[Dict[str, Any]]:
    host = (urlparse(url).hostname or "").lower()
    # Strip leading www.
    if host.startswith("www."):
        host = host[4:]
    if host in LOGIN_RECIPES:
        return LOGIN_RECIPES[host]
    # Match suffix (e.g. forum.hptuners.com matches hptuners.com if we allow)
    for d, recipe in LOGIN_RECIPES.items():
        if host.endswith("." + d) or host == d:
            return recipe
    return None


def _clean_text_from_html(html: str) -> Dict[str, str]:
    soup = BeautifulSoup(html, "lxml")
    # Yank obviously noise
    for sel in ["script", "style", "nav", "footer", "header", "aside", "noscript", "form"]:
        for t in soup.select(sel):
            t.decompose()
    title = (soup.title.string.strip() if soup.title and soup.title.string else "").strip()
    # Prefer <main>, then <article>, then <body>
    body = soup.select_one("main") or soup.select_one("article") or soup.select_one(".content") or soup.body or soup
    text = body.get_text(separator="\n", strip=True) if body else ""
    # Collapse 3+ newlines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return {"title": title, "text": text}


async def _fetch_public(url: str) -> Dict[str, str]:
    async with httpx.AsyncClient(timeout=30, follow_redirects=True,
                                 headers={"User-Agent": "Mozilla/5.0 (DataWrenchBrain/1.0)"}) as c:
        r = await c.get(url)
    if r.status_code != 200:
        raise HTTPException(r.status_code, f"Got HTTP {r.status_code} from {url}")
    return _clean_text_from_html(r.text)


async def _fetch_with_login(url: str, recipe: Dict[str, Any], username: str, password: str) -> Dict[str, str]:
    from playwright.async_api import async_playwright
    # The container ships system Chromium at /usr/bin/chromium and exposes
    # PLAYWRIGHT_CHROME_EXECUTABLE_PATH. Prefer that — installing Playwright's
    # own bundled browser into /pw-browsers is environment-specific and fragile.
    chrome_exec = os.environ.get("PLAYWRIGHT_CHROME_EXECUTABLE_PATH") or "/usr/bin/chromium"
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            executable_path=chrome_exec if os.path.exists(chrome_exec) else None,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        )
        try:
            ctx = await browser.new_context(user_agent="Mozilla/5.0 (DataWrenchBrain/1.0)")
            page = await ctx.new_page()
            await page.goto(recipe["login_url"], wait_until="load", timeout=45000)
            await asyncio.sleep(2.5)  # let JS bootstrap
            # Fill creds
            try:
                await page.fill(recipe["username_selector"], username, timeout=15000)
                await page.fill(recipe["password_selector"], password, timeout=10000)
            except Exception as e:
                raise HTTPException(502, f"Login form fields not found on {recipe['login_url']}: {e}. The site may have changed it.")
            await page.click(recipe["submit_selector"], timeout=10000)
            # Wait for navigation / login completion
            try:
                await page.wait_for_load_state("load", timeout=25000)
            except Exception:
                pass
            await asyncio.sleep(2.5)
            # Heuristic: if we land back at the login URL, login probably failed
            if page.url.rstrip("/") == recipe["login_url"].rstrip("/"):
                raise HTTPException(401, f"Login appears to have failed on {urlparse(recipe['login_url']).hostname}. Wrong username/password, captcha, or 2FA prompt.")
            # Now navigate to the target URL
            await page.goto(url, wait_until="load", timeout=45000)
            await asyncio.sleep(2)
            html = await page.content()
            return _clean_text_from_html(html)
        finally:
            await browser.close()


class ScrapeReq(BaseModel):
    url: str
    vault_credential_id: Optional[str] = None  # id from /api/credentials, used if login needed
    title_hint: Optional[str] = ""
    chunk_chars: int = Field(1800, ge=500, le=8000)


def make_scraper_router(db, get_user, embed_text):
    router = APIRouter()

    @router.post("/scrape/url")
    async def scrape_url(body: ScrapeReq, user=Depends(get_user)):
        url = body.url.strip()
        if not url.startswith("http"):
            raise HTTPException(400, "URL must start with http or https.")
        recipe = _domain_recipe(url)
        needs_login = bool(recipe and recipe.get("login_url"))
        cred = None
        if needs_login:
            # Figure out the canonical domain word ("alldata" / "identifix")
            # We use this to match the credential by site/URL — Doc isn't going to
            # paste hostnames into his Vault. He's going to write "AllData".
            host = (urlparse(url).hostname or "").lower().replace("www.", "")
            # Domain "root word" — first part before .com, e.g. "alldata", "identifix"
            domain_root = ""
            for d in LOGIN_RECIPES:
                if host == d or host.endswith("." + d) or d.split(".")[0] in host:
                    domain_root = d.split(".")[0]
                    break
            if not domain_root and host:
                # fallback: just the part before .com
                parts = host.split(".")
                if len(parts) >= 2:
                    domain_root = parts[-2]

            def _matches(c):
                """Match if any of: vault site/url contains the domain root word, or hostname.
                Also tolerates common typos in the site field (idintifix -> identifix)."""
                site = (c.get("site") or "").lower().replace(" ", "")
                vurl = (c.get("url") or "").lower().replace("www.", "").replace(" ", "")
                if domain_root and (domain_root in site or domain_root in vurl):
                    return True
                # Fuzzy: ignore vowels in match to absorb typos like "idintifix"/"identifix"
                def _devowel(s):
                    return "".join(ch for ch in s if ch not in "aeiou")
                if domain_root and (_devowel(domain_root) in _devowel(site) or _devowel(domain_root) in _devowel(vurl)):
                    return True
                if host and (host in vurl or host in site):
                    return True
                return False

            if body.vault_credential_id:
                cred = await db.credentials.find_one({"id": body.vault_credential_id, "user_id": user["id"]}, {"_id": 0})
                if not cred:
                    raise HTTPException(404, "Vault credential not found.")
            else:
                cur = db.credentials.find({"user_id": user["id"]}, {"_id": 0})
                creds = await cur.to_list(200)
                for c in creds:
                    if _matches(c):
                        cred = c
                        break
                if not cred:
                    available = ", ".join([(c.get("site") or "?") for c in creds[:10]]) or "none"
                    raise HTTPException(400, f"No Vault credential matches {host or 'this site'}. Saved sites: {available}. Make sure the SITE field in Vault contains '{domain_root or host}'.")
            if not cred.get("username") or not cred.get("password"):
                raise HTTPException(400, "Vault credential is missing username or password.")
        # Fetch
        try:
            if needs_login:
                content = await _fetch_with_login(url, recipe, cred["username"], cred["password"])
            else:
                content = await _fetch_public(url)
        except HTTPException:
            raise
        except Exception as e:
            log.exception("scrape failed")
            raise HTTPException(500, f"Couldn't read that page: {e}")
        title = (body.title_hint or content["title"] or urlparse(url).path)[:240]
        text = content["text"]
        if not text or len(text) < 100:
            raise HTTPException(422, "Scrape produced no readable text. Login may have failed, or it's a JS-heavy page we can't read.")
        # Chunk + insert into library — reuse existing library_chunks shape so RAG just works.
        chunks = []
        i = 0
        while i < len(text):
            chunks.append(text[i:i + body.chunk_chars])
            i += body.chunk_chars
        from datetime import datetime, timezone
        import uuid
        item_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        # Insert as a library_items row (same shape as PDF/text uploads) so it shows in /library list
        await db.library_items.insert_one({
            "id": item_id,
            "user_id": user["id"],
            "name": title,
            "kind": "url",
            "size": len(text),
            "source_url": url,
            "created_at": now,
            "chunk_count": len(chunks),
            "status": "ready",
        })
        rows = [{
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "item_id": item_id,
            "source": title,
            "text": c,
            "created_at": now,
        } for c in chunks]
        if rows:
            await db.library_chunks.insert_many(rows)
        return {
            "ok": True,
            "item_id": item_id,
            "title": title,
            "chunks_ingested": len(chunks),
            "chars": len(text),
            "url": url,
            "needed_login": needs_login,
        }

    @router.get("/scrape/supported")
    async def supported(_user=Depends(get_user)):
        """Return the list of sites we have login recipes for, so the UI can hint."""
        items = []
        for d, r in LOGIN_RECIPES.items():
            items.append({
                "domain": d,
                "needs_login": bool(r.get("login_url")),
                "example_url": f"https://{d}/",
            })
        return items

    # ============ Watchlist (auto re-crawl) ============
    # Doc adds URLs he wants Wrench to keep in the brain. Hit "Crawl Now"
    # to re-pull them on demand. Stored in `crawl_watchlist`. Each entry can
    # optionally have a tag (e.g. "HPT Forum", "TSB", "Parts") so Doc can
    # filter the library by source.

    class WatchAdd(BaseModel):
        url: str
        title: Optional[str] = None
        tag: Optional[str] = None
        frequency: Optional[str] = "manual"  # manual / daily / weekly / monthly

    @router.get("/scrape/watchlist")
    async def watchlist_list(user=Depends(get_user)):
        cur = db.crawl_watchlist.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1)
        return await cur.to_list(200)

    @router.post("/scrape/watchlist")
    async def watchlist_add(body: WatchAdd, user=Depends(get_user)):
        from datetime import datetime, timezone
        import uuid
        url = body.url.strip()
        if not url.startswith("http"):
            raise HTTPException(400, "URL must start with http:// or https://")
        # De-dup by exact URL per user
        exist = await db.crawl_watchlist.find_one({"user_id": user["id"], "url": url})
        if exist:
            raise HTTPException(409, "Already on watchlist.")
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "url": url,
            "title": (body.title or "").strip() or None,
            "tag": (body.tag or "").strip() or None,
            "frequency": body.frequency or "manual",
            "last_crawled_at": None,
            "last_status": None,
            "last_chunks": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.crawl_watchlist.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.delete("/scrape/watchlist/{wid}")
    async def watchlist_remove(wid: str, user=Depends(get_user)):
        r = await db.crawl_watchlist.delete_one({"id": wid, "user_id": user["id"]})
        if r.deleted_count == 0:
            raise HTTPException(404, "Watchlist entry not found.")
        return {"ok": True}

    async def _crawl_one(entry: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
        """Pull one URL, ingest into library, update watchlist row. Never raises."""
        from datetime import datetime, timezone
        import uuid
        url = entry["url"]
        try:
            recipe = _domain_recipe(url)
            needs_login = bool(recipe and recipe.get("login_url"))
            if needs_login:
                # Auto-match vault cred
                host = (urlparse(url).hostname or "").lower().replace("www.", "")
                cur = db.credentials.find({"user_id": user["id"]}, {"_id": 0})
                creds = await cur.to_list(200)
                cred = None
                for c in creds:
                    site = (c.get("site") or "").lower().replace(" ", "")
                    vurl = (c.get("url") or "").lower().replace("www.", "").replace(" ", "")
                    if host and (host in vurl or host in site):
                        cred = c
                        break
                if not cred or not cred.get("username") or not cred.get("password"):
                    raise Exception("no matching vault credential for login-required site")
                content = await _fetch_with_login(url, recipe, cred["username"], cred["password"])
            else:
                content = await _fetch_public(url)
            text = content.get("text") or ""
            if len(text) < 100:
                raise Exception("scraped text too short — page may be JS-only or blocked")
            title = (entry.get("title") or content.get("title") or urlparse(url).path)[:240]
            now = datetime.now(timezone.utc).isoformat()
            item_id = str(uuid.uuid4())
            chunk_size = 1200
            chunks = [text[i:i+chunk_size] for i in range(0, len(text), chunk_size)]
            await db.library_items.insert_one({
                "id": item_id, "user_id": user["id"], "name": title, "kind": "url",
                "size": len(text), "source_url": url, "created_at": now,
                "chunk_count": len(chunks), "status": "ready",
                "tag": entry.get("tag"), "watch_id": entry["id"],
            })
            rows = [{"id": str(uuid.uuid4()), "user_id": user["id"], "item_id": item_id,
                     "source": title, "text": c, "created_at": now} for c in chunks]
            if rows:
                await db.library_chunks.insert_many(rows)
            await db.crawl_watchlist.update_one(
                {"id": entry["id"]},
                {"$set": {"last_crawled_at": now, "last_status": "ok",
                          "last_chunks": len(chunks)}},
            )
            return {"id": entry["id"], "url": url, "ok": True, "chunks": len(chunks)}
        except Exception as e:
            msg = str(e)[:200]
            log.warning(f"crawl_one failed {url}: {msg}")
            from datetime import datetime, timezone
            await db.crawl_watchlist.update_one(
                {"id": entry["id"]},
                {"$set": {"last_crawled_at": datetime.now(timezone.utc).isoformat(),
                          "last_status": f"err: {msg}"}},
            )
            return {"id": entry["id"], "url": url, "ok": False, "error": msg}

    @router.post("/scrape/watchlist/{wid}/crawl")
    async def watchlist_crawl_one(wid: str, user=Depends(get_user)):
        entry = await db.crawl_watchlist.find_one({"id": wid, "user_id": user["id"]}, {"_id": 0})
        if not entry:
            raise HTTPException(404, "Watchlist entry not found.")
        return await _crawl_one(entry, user)

    @router.post("/scrape/watchlist/crawl-all")
    async def watchlist_crawl_all(user=Depends(get_user)):
        cur = db.crawl_watchlist.find({"user_id": user["id"]}, {"_id": 0})
        entries = await cur.to_list(200)
        results = []
        for e in entries:
            r = await _crawl_one(e, user)
            results.append(r)
        ok = sum(1 for r in results if r.get("ok"))
        return {"total": len(results), "ok": ok, "failed": len(results)-ok, "results": results}

    return router
