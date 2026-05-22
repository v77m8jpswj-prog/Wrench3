"""
TUNE workflow module — OS-aware, ordered menu walk that mirrors HP Tuners VCM Editor.

Why this exists:
- Doc's old chat-based tuning was clunky: no order, no OS awareness, easy to hunt for tabs
  that don't exist on his ECM.
- This module gives Wrench a deterministic structure: pick OS → walk the menu in HP Tuners
  order → at each tab Wrench asks for the right snip → returns the corrected paste table
  in Doc's locked format → auto-advance to next tab.
- Every edit is logged per-vehicle so Wrench learns Doc's patterns over time.

Endpoints (mounted under /api/tune/*):
  GET  /api/tune/os-list                  → list of supported OS families
  GET  /api/tune/os-tree/{os_family}      → full menu tree for an OS (HP Tuners order)
  POST /api/tune/session                  → start a tune session for a vehicle (records OS)
  GET  /api/tune/session/{vehicle_id}     → get the current session (creates one if missing)
  POST /api/tune/log                      → append a chart-edit entry to the tune log
  GET  /api/tune/log/{vehicle_id}         → recall the tune log for context/learning
"""
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import uuid

# ─── OS Menu Trees ──────────────────────────────────────────────────────────────
# Maps OS family → exact HP Tuners VCM Editor menu structure for that OS.
# Order matters: this is the order Wrench will walk Doc through.
# Only the OSes Doc tunes day-to-day are seeded. More can be added without code changes.

OS_TREES: Dict[str, Dict[str, Any]] = {
    "E80": {
        "label": "E80 — GM Gen V LT (5.3L L83 / 6.2L L86 — DI, AFM, 2014-2017)",
        "platforms": ["2014-2017 Silverado/Sierra 1500", "2015-2017 Tahoe/Yukon/Suburban", "2014-2017 Escalade"],
        "menu": [
            {"section": "Engine", "tabs": [
                {"name": "General"},
                {"name": "Idle"},
                {"name": "Airflow", "subtabs": [
                    "General", "Dynamic", "Speed Density", "Electronic Throttle",
                    "Variable Camshaft", "Pressure Control", "Turbocharger", "Supercharger"
                ]},
                {"name": "Exhaust"},
                {"name": "Fuel", "subtabs": [
                    "General", "Cranking", "Open Loop", "Closed Loop", "Cold Start",
                    "Mixture / AFR", "Catalyst Protection", "Direct Injection"
                ]},
                {"name": "Spark", "subtabs": [
                    "General", "High Octane", "Low Octane", "Borderline", "Cold Advance",
                    "Knock Retard", "Cranking"
                ]},
                {"name": "Torque Model"},
                {"name": "Torque Management"},
                {"name": "AFM / Cylinder Deactivation"},
            ]},
            {"section": "Transmission", "tabs": [
                {"name": "General"},
                {"name": "Shift Pressures", "subtabs": ["Upshift", "Downshift", "Garage Shift"]},
                {"name": "Shift Timing", "subtabs": ["Performance", "Tow/Haul", "Normal"]},
                {"name": "Torque Converter"},
                {"name": "Shift Tables"},
            ]},
            {"section": "System", "tabs": [
                {"name": "DTCs"},
                {"name": "Speedometer / Tire Size"},
                {"name": "Cooling Fans"},
                {"name": "A/C"},
                {"name": "Security / VATS"},
            ]},
        ],
    },
    "E82": {
        "label": "E82 — GM Gen V LT (6.2L L86 truck — DI, AFM)",
        "platforms": ["2014-2017 Silverado/Sierra 6.2L"],
        "menu": "ref:E80",   # alias same structure
    },
    "E78": {
        "label": "E78 — GM Gen IV Truck (5.3L L83/LMG, 6.0L L96, port injection)",
        "platforms": ["2010-2014 Silverado/Sierra/Tahoe/Yukon"],
        "menu": [
            {"section": "Engine", "tabs": [
                {"name": "General"},
                {"name": "Idle"},
                {"name": "Airflow", "subtabs": ["General", "Dynamic", "MAF", "Speed Density", "Electronic Throttle", "Variable Camshaft"]},
                {"name": "Exhaust"},
                {"name": "Fuel", "subtabs": ["General", "Cranking", "Open Loop", "Closed Loop", "Power Enrichment", "Cold Start"]},
                {"name": "Spark", "subtabs": ["General", "High Octane", "Low Octane", "Cold Advance", "Knock Retard"]},
                {"name": "Torque Management"},
            ]},
            {"section": "System", "tabs": [{"name": "DTCs"}, {"name": "Speedometer"}, {"name": "Cooling Fans"}, {"name": "A/C"}]},
        ],
    },
    "E92": {
        "label": "E92 — GM Gen V LT DFM (5.3L L84 / 6.2L L87 — 2019+ DFM, no AFM)",
        "platforms": ["2019+ Silverado/Sierra 1500", "2021+ Tahoe/Yukon/Suburban", "2019+ Escalade"],
        "menu": [
            {"section": "Engine", "tabs": [
                {"name": "General"},
                {"name": "Idle"},
                {"name": "Airflow", "subtabs": ["General", "Dynamic", "Speed Density", "Electronic Throttle", "Variable Camshaft", "Pressure Control"]},
                {"name": "Exhaust"},
                {"name": "Fuel", "subtabs": ["General", "Cranking", "Open Loop", "Closed Loop", "Cold Start", "Mixture / AFR", "Catalyst Protection", "Direct Injection"]},
                {"name": "Spark", "subtabs": ["General", "High Octane", "Low Octane", "Borderline", "Cold Advance", "Knock Retard", "Cranking"]},
                {"name": "Torque Model"},
                {"name": "Torque Management"},
                {"name": "DFM / Cylinder Deactivation"},
            ]},
            {"section": "Transmission", "tabs": [{"name": "General"}, {"name": "Shift Pressures"}, {"name": "Shift Timing"}, {"name": "Torque Converter"}, {"name": "Shift Tables"}]},
            {"section": "System", "tabs": [{"name": "DTCs"}, {"name": "Speedometer / Tire Size"}, {"name": "Cooling Fans"}, {"name": "A/C"}, {"name": "Security / VATS"}]},
        ],
    },
    "E38": {
        "label": "E38 — GM Gen IV LS (2007-2014 truck/SUV/car)",
        "platforms": ["2007-2013 Silverado/Sierra", "2007-2014 Tahoe/Yukon/Escalade", "2007-2014 Camaro/Corvette"],
        "menu": [
            {"section": "Engine", "tabs": [
                {"name": "General"},
                {"name": "Idle"},
                {"name": "Airflow", "subtabs": ["General", "Dynamic", "MAF", "Speed Density", "Electronic Throttle", "Variable Camshaft"]},
                {"name": "Exhaust"},
                {"name": "Fuel", "subtabs": ["General", "Cranking", "Open Loop", "Closed Loop", "Power Enrichment", "Cold Start"]},
                {"name": "Spark", "subtabs": ["General", "High Octane", "Low Octane", "Cold Advance", "Knock Retard"]},
                {"name": "Torque Management"},
            ]},
            {"section": "System", "tabs": [{"name": "DTCs"}, {"name": "Speedometer"}, {"name": "Cooling Fans"}, {"name": "A/C"}]},
        ],
    },
    "T87A": {
        "label": "T87A — GM 8L90 / 10L80 Transmission Controller (separate from engine ECM)",
        "platforms": ["2017+ trucks with 8-speed / 10-speed"],
        "menu": [
            {"section": "Transmission", "tabs": [
                {"name": "General"},
                {"name": "Shift Pressures", "subtabs": ["Upshift", "Downshift", "Garage Shift", "Coast"]},
                {"name": "Shift Timing", "subtabs": ["Performance", "Tow/Haul", "Normal"]},
                {"name": "Torque Converter"},
                {"name": "Adapts"},
            ]},
        ],
    },
}

# Resolve aliases (e.g. E82 → "ref:E80")
def get_os_tree(os_family: str) -> Optional[Dict[str, Any]]:
    os_family = (os_family or "").upper()
    tree = OS_TREES.get(os_family)
    if not tree:
        return None
    if isinstance(tree.get("menu"), str) and tree["menu"].startswith("ref:"):
        ref = tree["menu"][4:]
        ref_tree = OS_TREES.get(ref)
        if ref_tree:
            return {**tree, "menu": ref_tree["menu"]}
    return tree


# Flatten the menu tree into an ordered list of "tab paths" for next/prev navigation.
def flatten_menu(tree: Dict[str, Any]) -> List[Dict[str, str]]:
    out = []
    for section in tree.get("menu", []):
        sec = section["section"]
        for tab in section.get("tabs", []):
            tab_name = tab["name"]
            subtabs = tab.get("subtabs") or []
            if subtabs:
                for st in subtabs:
                    out.append({"section": sec, "tab": tab_name, "subtab": st, "path": f"{sec} > {tab_name} > {st}"})
            else:
                out.append({"section": sec, "tab": tab_name, "subtab": "", "path": f"{sec} > {tab_name}"})
    return out


# ─── Pydantic Models ────────────────────────────────────────────────────────────
class TuneSessionStart(BaseModel):
    vehicle_id: str
    os_family: str        # E80, E82, etc.
    cal_id: Optional[str] = ""    # exact OS calibration ID (e.g. "12656931")
    engine_code: Optional[str] = ""  # L83, L86, LT1, etc.
    fuel: Optional[str] = ""      # 87/91/93/E85
    goal: Optional[str] = ""      # daily / tow / strip / dyno
    notes: Optional[str] = ""

class TuneLogEntry(BaseModel):
    vehicle_id: str
    session_id: Optional[str] = ""
    section: str          # "Engine"
    tab: str              # "Fuel"
    subtab: Optional[str] = ""   # "Cranking"
    table_name: Optional[str] = ""  # "Initial Cold Cranking VE"
    before_table: Optional[str] = ""  # tab-sep
    after_table: Optional[str] = ""   # tab-sep
    instruction: str      # what Doc asked for
    reason: Optional[str] = ""     # why this change (Wrench-derived or Doc-provided)
    symptom: Optional[str] = ""    # cold stumble / knock / lean cruise / etc.
    cells_changed: Optional[List[List[int]]] = None  # [[row, col], ...]


# ─── Router ─────────────────────────────────────────────────────────────────────
def build_router(db, get_user):
    router = APIRouter(prefix="/tune", tags=["tune"])

    @router.get("/os-list")
    async def os_list(user=Depends(get_user)):
        return [
            {"os": k, "label": v["label"], "platforms": v.get("platforms", [])}
            for k, v in OS_TREES.items()
        ]

    @router.get("/os-tree/{os_family}")
    async def os_tree(os_family: str, user=Depends(get_user)):
        t = get_os_tree(os_family)
        if not t:
            raise HTTPException(404, f"OS '{os_family}' not in tree. Known: {list(OS_TREES.keys())}")
        return {"os": os_family.upper(), "label": t["label"], "menu": t["menu"], "flat": flatten_menu(t)}

    @router.post("/session")
    async def session_start(body: TuneSessionStart, user=Depends(get_user)):
        t = get_os_tree(body.os_family)
        if not t:
            raise HTTPException(400, f"Unknown OS '{body.os_family}'. Known: {list(OS_TREES.keys())}")
        sid = str(uuid.uuid4())
        doc = {
            "id": sid,
            "user_id": user["id"],
            "vehicle_id": body.vehicle_id,
            "os_family": body.os_family.upper(),
            "cal_id": body.cal_id,
            "engine_code": body.engine_code,
            "fuel": body.fuel,
            "goal": body.goal,
            "notes": body.notes,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "active": True,
        }
        await db.tune_sessions.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.get("/session/{vehicle_id}")
    async def session_get(vehicle_id: str, user=Depends(get_user)):
        s = await db.tune_sessions.find_one(
            {"user_id": user["id"], "vehicle_id": vehicle_id, "active": True},
            {"_id": 0}, sort=[("created_at", -1)]
        )
        return s or {}

    @router.post("/log")
    async def log_entry(body: TuneLogEntry, user=Depends(get_user)):
        eid = str(uuid.uuid4())
        doc = {
            "id": eid,
            "user_id": user["id"],
            "created_at": datetime.now(timezone.utc).isoformat(),
            **body.model_dump(),
        }
        await db.tune_log.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.get("/log/{vehicle_id}")
    async def log_list(vehicle_id: str, user=Depends(get_user), limit: int = 200):
        cur = db.tune_log.find(
            {"user_id": user["id"], "vehicle_id": vehicle_id},
            {"_id": 0},
        ).sort("created_at", -1).limit(limit)
        return await cur.to_list(limit)

    return router
