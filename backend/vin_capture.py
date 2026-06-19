"""
VIN snap-and-load: Doc texts a VIN sticker pic to his Twilio number,
we OCR the VIN, decode it via NHTSA, upsert the vehicle, set it as
his active vehicle, and reply with a confirmation SMS.
"""
import os
import re
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any

import httpx

log = logging.getLogger("vin_capture")

VIN_RE = re.compile(r"\b[A-HJ-NPR-Z0-9]{17}\b")  # VINs exclude I, O, Q


async def ocr_vin_from_image(image_url: str, openai_key: str) -> Optional[str]:
    """Send image to OpenAI gpt-4o vision, ask for 17-char VIN. Returns VIN or None."""
    if not openai_key or not image_url:
        return None
    payload = {
        "model": "gpt-4o-mini",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": (
                    "Extract the 17-character VIN from this image. "
                    "VINs use only letters A-H, J-N, P, R-Z and digits 0-9 (no I, O, Q). "
                    "Return ONLY the VIN as a single uppercase string with no spaces, no punctuation, no commentary. "
                    "If you can't see a clear 17-char VIN, return the single word: NONE"
                )},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        }],
        "max_tokens": 30,
        "temperature": 0,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
            json=payload,
        )
        if r.status_code != 200:
            log.warning("OCR failed HTTP %s: %s", r.status_code, r.text[:200])
            return None
        text = (r.json().get("choices", [{}])[0].get("message", {}).get("content") or "").strip().upper()
    if text == "NONE" or not text:
        return None
    m = VIN_RE.search(text)
    return m.group(0) if m else None


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
