"""
Data Wrench — content ingestion safety pipeline.

Two responsibilities:
  1. PII scrub — strip VINs, plates, emails, phone numbers, credit cards
     from text before it gets embedded into library_chunks. We're ingesting
     public forums where users casually paste their own (and customers')
     personal info. We do not want that liability inside our vector store.
  2. Source tiering — every ingested chunk gets a tier (1-4) and confidence
     score so Wrench can weight forum noise differently than OEM TSBs.

Tier rubric (locked with OG / consumer-side agent Feb 28, 2026):
  1.0  Doc's own shop fix / closed RO
  0.95 OEM TSB / official manufacturer doc
  0.85 Pro-tech forum (iATN, Identifix when manually pasted by Doc)
  0.70 HP Tuners / EFI Live / model-specific tuning forum
  0.65 Named YouTube channel transcript (Pine Hollow, ScannerDanner, etc.)
  0.60 Reddit verified-fix / accepted-answer
  0.40 Generic forum thread (unverified)
  0.35 Parts review (RockAuto, AutoZone) — symptom→part causal chain
  0.30 Unknown / fallback
"""
import re
import hashlib
from urllib.parse import urlparse
from typing import Tuple, Dict, Any


# ============ PII patterns (compiled once) ============
# VIN: 17 chars, no I/O/Q to avoid confusion with 1/0/Q. Conservative match.
_VIN_RE = re.compile(r"\b[A-HJ-NPR-Z0-9]{11}[0-9]{6}\b")
# US plate: 6-8 chars alphanumeric — too broad to auto-replace safely.
# We only scrub when explicitly framed as "plate" / "tag" / "license".
_PLATE_CTX_RE = re.compile(r"\b(?:plate|tag|license)[\s:#]*([A-Z0-9]{5,8})\b", re.IGNORECASE)
# Email
_EMAIL_RE = re.compile(r"\b[\w\.-]+@[\w\.-]+\.\w{2,}\b")
# US phone — 10 digits with optional formatting
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})(?!\d)")
# Credit card-ish — 13-19 digits, optionally separated. Conservative.
_CC_RE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
# SSN
_SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")


def scrub_pii(text: str) -> Tuple[str, Dict[str, int]]:
    """Strip PII from text. Returns (clean_text, counts_dict).
    Replacement style preserves length-ish so chunk boundaries don't shift wildly.
    """
    counts = {"vin": 0, "plate": 0, "email": 0, "phone": 0, "cc": 0, "ssn": 0}
    if not text:
        return text or "", counts

    def _r_vin(m):
        counts["vin"] += 1
        return "[VIN]"

    def _r_plate(m):
        counts["plate"] += 1
        return f"{m.group(0).split(m.group(1))[0]}[PLATE]"

    def _r_email(m):
        counts["email"] += 1
        return "[EMAIL]"

    def _r_phone(m):
        counts["phone"] += 1
        return "[PHONE]"

    def _r_cc(m):
        # Don't strip if it's clearly a part number, year list, etc.
        s = re.sub(r"\D", "", m.group(0))
        if len(s) < 13 or len(s) > 19:
            return m.group(0)
        counts["cc"] += 1
        return "[CC]"

    def _r_ssn(m):
        counts["ssn"] += 1
        return "[SSN]"

    text = _VIN_RE.sub(_r_vin, text)
    text = _PLATE_CTX_RE.sub(_r_plate, text)
    text = _EMAIL_RE.sub(_r_email, text)
    text = _PHONE_RE.sub(_r_phone, text)
    text = _SSN_RE.sub(_r_ssn, text)
    text = _CC_RE.sub(_r_cc, text)
    return text, counts


# ============ Source tier inference ============
# Map domain → (tier_number, confidence_score, label). Lowercase hostnames.
_TIER_MAP = {
    # Tier 1 (highest signal, OEM/official)
    "nhtsa.gov": (1, 0.95, "NHTSA Recall/Complaint"),
    "iatn.net": (1, 0.85, "iATN Pro Tech Forum"),
    # Tier 2 (strong signal, free, indie/pro)
    "hptuners.com": (2, 0.70, "HP Tuners Forum"),
    "efilive.com": (2, 0.70, "EFI Live Forum"),
    "ls1tech.com": (2, 0.65, "LS1Tech Forum"),
    "dsmtuners.com": (2, 0.65, "DSMTuners Forum"),
    "clublexus.com": (2, 0.60, "Model Forum (ClubLexus)"),
    "f150forum.com": (2, 0.60, "Model Forum (F150)"),
    "jeepforum.com": (2, 0.60, "Model Forum (Jeep)"),
    "bimmerforums.com": (2, 0.60, "Model Forum (Bimmer)"),
    "mercedesshop.com": (2, 0.60, "Model Forum (Mercedes)"),
    "automotiveforums.com": (2, 0.55, "AutomotiveForums"),
    "bobistheoilguy.com": (2, 0.55, "Bob Is The Oil Guy"),
    "garagejournal.com": (2, 0.55, "Garage Journal"),
    "trouble-codes.com": (2, 0.65, "OBD Code DB"),
    "obd-codes.com": (2, 0.65, "OBD Code DB"),
    "repairpal.com": (2, 0.55, "RepairPal"),
    "youtube.com": (2, 0.65, "YouTube Transcript"),
    "youtu.be": (2, 0.65, "YouTube Transcript"),
    "reddit.com": (2, 0.55, "Reddit"),
    "motormagazine.com": (2, 0.70, "Motor Magazine"),
    "underhoodservice.com": (2, 0.70, "Underhood Service"),
    "brakeandfrontend.com": (2, 0.70, "Brake & Front End"),
    "importcar.com": (2, 0.70, "ImportCar"),
    "tomorrowstechnician.com": (2, 0.70, "Tomorrow's Technician"),
    "counterman.com": (2, 0.65, "Counterman"),
    "autozone.com": (2, 0.50, "AutoZone Guide"),
    "advanceautoparts.com": (2, 0.50, "Advance Guide"),
    "oreillyauto.com": (2, 0.50, "O'Reilly Guide"),
    "rockauto.com": (2, 0.40, "RockAuto Reviews"),
    "summitracing.com": (2, 0.40, "Summit Catalog"),
    # Tier 3 (paid / TOS-restricted — HARD STOP, only via manual paste with consent)
    "alldatadiy.com": (3, 0.90, "ALLDATA (manual paste)"),
    "alldata.com": (3, 0.90, "ALLDATA (manual paste)"),
    "identifix.com": (3, 0.90, "Identifix (manual paste)"),
    "prodemand.com": (3, 0.90, "Mitchell1 ProDemand (manual paste)"),
    "mitchell1.com": (3, 0.90, "Mitchell1 (manual paste)"),
    "jasperengines.com": (3, 0.75, "JASPER Engines"),
    "nastf.org": (3, 0.85, "NASTF"),
    "sae.org": (3, 0.85, "SAE"),
}

# Domain root → tier_3 paid set (HARD STOP for auto-crawl)
PAID_TOS_RESTRICTED = {"alldata", "alldatadiy", "identifix", "prodemand", "mitchell1"}


def tier_for_url(url: str) -> Dict[str, Any]:
    """Return {'tier': 1-4, 'confidence': 0.30-0.95, 'label': str, 'restricted': bool}"""
    host = (urlparse(url).hostname or "").lower().replace("www.", "")
    if not host:
        return {"tier": 4, "confidence": 0.30, "label": "Unknown source", "restricted": False}
    # Direct match
    if host in _TIER_MAP:
        t, c, lbl = _TIER_MAP[host]
        restricted = any(p in host for p in PAID_TOS_RESTRICTED)
        return {"tier": t, "confidence": c, "label": lbl, "restricted": restricted, "host": host}
    # Endswith match (subdomains)
    for dom, (t, c, lbl) in _TIER_MAP.items():
        if host == dom or host.endswith("." + dom):
            restricted = any(p in host for p in PAID_TOS_RESTRICTED)
            return {"tier": t, "confidence": c, "label": lbl, "restricted": restricted, "host": host}
    # Forum / wiki heuristic
    if "forum" in host:
        return {"tier": 2, "confidence": 0.40, "label": "Unknown forum", "restricted": False, "host": host}
    if "wiki" in host:
        return {"tier": 2, "confidence": 0.55, "label": "Wiki source", "restricted": False, "host": host}
    return {"tier": 4, "confidence": 0.30, "label": host, "restricted": False, "host": host}


# ============ Dedup hashing ============
def content_fingerprint(text: str, min_len: int = 200) -> str:
    """Hash for fuzzy near-duplicate detection. Normalizes whitespace + lowercase
    + strips numbers (so two TSB pages with different RO IDs hash the same)."""
    if not text or len(text) < min_len:
        return ""
    norm = text.lower()
    norm = re.sub(r"\d+", "0", norm)            # collapse all numbers
    norm = re.sub(r"\s+", " ", norm).strip()
    # Take first + middle + last chunk for fingerprint (cheap simhash-ish)
    sample = (norm[:400] + norm[len(norm)//2 - 200: len(norm)//2 + 200] + norm[-400:])
    return hashlib.sha256(sample.encode("utf-8")).hexdigest()[:24]
