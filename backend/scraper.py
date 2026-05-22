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
        # alldatadiy.com redirects to alldata.com/diy-us/en — use that login form
        "login_url": "https://www.alldata.com/diy-us/en/diy/login",
        "username_selector": "#edit-username",
        "password_selector": "#edit-password",
        "submit_selector": "#edit-submit",
        "success_marker": "logout",
    },
    "alldata.com": {
        "login_url": "https://www.alldata.com/diy-us/en/diy/login",
        "username_selector": "#edit-username",
        "password_selector": "#edit-password",
        "submit_selector": "#edit-submit",
        "success_marker": "logout",
    },
    "identifix.com": {
        "login_url": "https://identifix.com/login",
        "username_selector": "input[name=username], input[type=email]",
        "password_selector": "input[name=password], input[type=password]",
        "submit_selector": "button[type=submit], input[type=submit]",
        "success_marker": "logout",
    },
    "forum.hptuners.com": {
        # Forum is public for reading; login only needed for posting.
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
            if not body.vault_credential_id:
                # Try to auto-pick a credential whose 'site' or 'url' matches the domain
                host = urlparse(url).hostname or ""
                cur = db.credentials.find({"user_id": user["id"]}, {"_id": 0})
                creds = await cur.to_list(200)
                for c in creds:
                    if host and (host in (c.get("url") or "") or host in (c.get("site") or "").lower().replace(" ", "")):
                        cred = c
                        break
                if not cred:
                    raise HTTPException(400, f"This site requires login. Save credentials in your Vault for {host}, then try again.")
            else:
                cred = await db.credentials.find_one({"id": body.vault_credential_id, "user_id": user["id"]}, {"_id": 0})
                if not cred:
                    raise HTTPException(404, "Vault credential not found.")
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

    return router
