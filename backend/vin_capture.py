"""
VIN snap-and-load: Doc texts a VIN sticker pic to his Twilio number,
we OCR the VIN, decode it via NHTSA, upsert the vehicle, set it as
his active vehicle, and reply with a confirmation SMS.
"""
import os
import re
import uuid
import base64
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Tuple

import httpx

log = logging.getLogger("vin_capture")

VIN_RE = re.compile(r"\b[A-HJ-NPR-Z0-9]{17}\b")  # VINs exclude I, O, Q


async def _fetch_image_bytes(
    image_url: str, twilio_sid: str = "", twilio_tok: str = ""
) -> Tuple[Optional[bytes], Optional[str]]:
    """Fetch an image URL, using Twilio basic auth if the host is Twilio's.
    Returns (bytes, content_type) or (None, None) on failure. Follows redirects
    because Twilio media URLs 302 to S3 — but the S3 URL is presigned and must
    NOT have the basic-auth header re-sent, so we handle redirect manually."""
    if not image_url:
        return None, None
    is_twilio = "api.twilio.com" in image_url
    auth = (twilio_sid, twilio_tok) if (is_twilio and twilio_sid and twilio_tok) else None
    try:
        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=False,
            headers={"User-Agent": "DataWrench-VINSnap/1.0 (+https://drunderhood.com)"},
        ) as client:
            r = await client.get(image_url, auth=auth)
            # Twilio returns a 302 to a signed S3 URL; follow once WITHOUT auth.
            if r.status_code in (301, 302, 303, 307, 308):
                loc = r.headers.get("location")
                if loc:
                    r = await client.get(loc)
            if r.status_code != 200:
                log.warning("image fetch failed HTTP %s: %s", r.status_code, r.text[:200])
                return None, None
            ctype = (r.headers.get("content-type") or "").split(";")[0].strip() or "image/jpeg"
            return r.content, ctype
    except Exception as e:
        log.warning("image fetch error: %s", e)
        return None, None


async def ocr_vin_from_twilio_media(
    image_url: str,
    media_content_type: str,
    openai_key: str,
    twilio_sid: str = "",
    twilio_tok: str = "",
) -> Optional[str]:
    """Download the Twilio media (auth'd) then send to OpenAI as base64 data URL.
    Returns the 17-char VIN string, or None."""
    if not openai_key or not image_url:
        return None
    img_bytes, ctype = await _fetch_image_bytes(image_url, twilio_sid, twilio_tok)
    if not img_bytes:
        return None
    # Prefer the content-type Twilio told us up front (more reliable than S3's)
    ctype = (media_content_type or ctype or "image/jpeg").split(";")[0].strip()
    if not ctype.startswith("image/"):
        ctype = "image/jpeg"
    b64 = base64.b64encode(img_bytes).decode("ascii")
    data_url = f"data:{ctype};base64,{b64}"
    return await _ocr_vin_from_data_url(data_url, openai_key)


async def _ocr_vin_from_data_url(data_url: str, openai_key: str) -> Optional[str]:
    """Inner: ship a data URL (base64) or public URL to OpenAI vision, get VIN.
    Uses gpt-4o (full, not mini) for stronger OCR accuracy on real-world VIN
    stickers which can be small, angled, low-light, or partially obscured."""
    payload = {
        "model": "gpt-4o",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": (
                    "Read the Vehicle Identification Number (VIN) from this image. "
                    "A VIN is exactly 17 characters: uppercase letters and digits. "
                    "Return ONLY the 17-character VIN. No spaces, no punctuation, no commentary. "
                    "If no clear 17-character VIN is visible, return exactly: NONE"
                )},
                {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
            ],
        }],
        "max_tokens": 40,
        "temperature": 0,
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
                json=payload,
            )
            if r.status_code != 200:
                log.warning("OCR failed HTTP %s: %s", r.status_code, r.text[:300])
                return None
            text = (r.json().get("choices", [{}])[0].get("message", {}).get("content") or "").strip().upper()
    except Exception as e:
        log.warning("OCR request error: %s", e)
        return None
    log.info("OCR raw response: %r", text)
    if text == "NONE" or not text:
        return None
    # Strip whitespace/punctuation from the response before regex
    clean = re.sub(r"[^A-Z0-9]", "", text)
    m = VIN_RE.search(clean)
    if m:
        return m.group(0)
    # Fallback: if model returned exactly 17 chars but contains I/O/Q (which it
    # shouldn't, but happens), accept it as a best-effort hit.
    if len(clean) == 17 and re.fullmatch(r"[A-Z0-9]{17}", clean):
        return clean
    return None


async def ocr_vin_from_image(image_url: str, openai_key: str) -> Optional[str]:
    """Back-compat shim: public image URL → OpenAI vision → VIN."""
    if not openai_key or not image_url:
        return None
    return await _ocr_vin_from_data_url(image_url, openai_key)


async def decode_vin(vin: str) -> Dict[str, Any]:
    """NHTSA vPIC decode. Returns dict with year/make/model/engine/trim/plant/etc."""
    url = f"https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/{vin}?format=json"
    out: Dict[str, Any] = {"vin": vin}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(url)
            if r.status_code != 200:
                return out
            results = r.json().get("Results") or []
            wanted = {
                "Model Year": "year",
                "Make": "make",
                "Model": "model",
                "Trim": "trim",
                "Engine Number of Cylinders": "cylinders",
                "Displacement (L)": "displacement_l",
                "Fuel Type - Primary": "fuel",
                "Drive Type": "drive",
                "Plant Country": "plant_country",
                "Plant City": "plant_city",
                "Body Class": "body",
            }
            for row in results:
                k = row.get("Variable")
                v = row.get("Value")
                if k in wanted and v and v not in ("Not Applicable", "0"):
                    out[wanted[k]] = v
    except Exception as e:
        log.warning("VIN decode error: %s", e)
    return out


async def upsert_vehicle_for_owner(db, owner_user: Dict[str, Any], decoded: Dict[str, Any]) -> Dict[str, Any]:
    """Find or create vehicle by VIN for this owner. Returns vehicle doc."""
    vin = decoded["vin"]
    existing = await db.vehicles.find_one({"user_id": owner_user["id"], "vin": vin}, {"_id": 0})
    if existing:
        return existing
    now = datetime.now(timezone.utc).isoformat()
    year_str = decoded.get("year") or ""
    try:
        year_int = int(year_str) if year_str else None
    except Exception:
        year_int = None
    veh = {
        "id": str(uuid.uuid4()),
        "user_id": owner_user["id"],
        "shop_id": owner_user.get("shop_id") or os.environ.get("DEFAULT_SHOP_ID") or "drunderhood-fortsmith",
        "vin": vin,
        "year": year_int,
        "make": decoded.get("make") or "",
        "model": decoded.get("model") or "",
        "trim": decoded.get("trim") or "",
        "engine": (f"{decoded.get('displacement_l','')}L {decoded.get('cylinders','')}cyl {decoded.get('fuel','')}").strip(),
        "drive": decoded.get("drive") or "",
        "body": decoded.get("body") or "",
        "source": "vin_sms_snap",
        "created_at": now,
        "updated_at": now,
    }
    await db.vehicles.insert_one(veh)
    veh.pop("_id", None)
    return veh


async def set_active_vehicle(db, user_id: str, vehicle_id: str) -> None:
    """Persist as the user's active vehicle so /chat opens with it loaded."""
    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "active_vehicle_id": vehicle_id,
            "active_vehicle_set_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
