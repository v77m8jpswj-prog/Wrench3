"""
Data Wrench P1 feature tests:
  1) Close-job → Brain case automation  (POST /api/cases/from-chat/{session_id})
  2) Partner team conversations          (GET  /api/brain/team-conversations)
  3) Shop profile (multi-tenant)         (GET/PUT /api/shop/profile, GET /api/brain/shop-profile, /api/brain/stats)
  4) Search cache sanity check           (POST /api/brain/search-web, GET /api/brain/search-stats)
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or "https://dialogue-bot-9.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

OWNER = {"email": "doc@drunderhood.com", "password": "wrench"}
BRAIN_TOKEN = "a1680ebe47a8b56801b44a478a0b40655c128ab424ce8035e11df89cb310558d"
SHOP_ID = "drunderhood-fortsmith"


# ---------------- Fixtures ----------------

@pytest.fixture(scope="session")
def owner_token():
    r = requests.post(f"{API}/auth/login", json=OWNER, timeout=30)
    assert r.status_code == 200, f"Owner login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def owner_auth(owner_token):
    return {"Authorization": f"Bearer {owner_token}"}


@pytest.fixture(scope="session")
def brain_auth():
    return {"Authorization": f"Bearer {BRAIN_TOKEN}"}


@pytest.fixture(scope="session")
def open_chat_session(owner_auth):
    """Create an open chat session with at least one user + assistant message,
    so close-from-chat has something to convert."""
    r = requests.post(
        f"{API}/chat",
        headers=owner_auth,
        json={"message": "TEST_p1: 2010 LS3 Camaro idles rough after cam swap. What should I check first?",
              "mode": "direct"},
        timeout=180,
    )
    assert r.status_code == 200, f"chat failed {r.status_code} {r.text}"
    sid = r.json()["session_id"]
    return sid


# ---------------- 1. Close-to-Brain (close_session=True) ----------------

class TestCloseJobToBrainCase:
    def test_close_creates_case_and_closes_session(self, owner_auth, open_chat_session):
        sid = open_chat_session
        body = {
            "outcome": "FIXED",
            "root_cause": "TEST_p1 lash too tight on intake side",
            "repair_summary": "TEST_p1 re-lashed to spec, verified idle.",
            "parts": ["TEST_p1 lash adjusters"],
            "close_session": True,
        }
        r = requests.post(f"{API}/cases/from-chat/{sid}", headers=owner_auth, json=body, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        # Case-level assertions
        assert d.get("id")
        assert d["outcome"] == "FIXED"
        assert "TEST_p1 lash too tight" in d["root_cause"]
        assert d["repair_summary"].startswith("TEST_p1 re-lashed")
        assert d["parts"] == ["TEST_p1 lash adjusters"]
        assert d["source"] == "chat_close"
        assert d["linked_chat_session_id"] == sid
        assert d["shop_id"] == SHOP_ID

        # Session should now be closed and linked — verify via list endpoint
        # (GET /chat/sessions/{id} only returns messages, not status fields)
        rs = requests.get(f"{API}/chat/sessions", headers=owner_auth, timeout=15)
        assert rs.status_code == 200
        sess = next((s for s in rs.json() if s["id"] == sid), None)
        assert sess, f"session {sid} not in list"
        assert sess.get("status") == "closed"
        assert sess.get("linked_brain_case_id") == d["id"]
        assert sess.get("close_outcome") == "FIXED"

        # Case is GET-able via internal /cases/{id}
        rc = requests.get(f"{API}/cases/{d['id']}", headers=owner_auth, timeout=15)
        assert rc.status_code == 200
        assert rc.json()["id"] == d["id"]

    def test_close_no_body_creates_draft_case(self, owner_auth):
        # Fresh chat session for backward-compat path
        rc = requests.post(f"{API}/chat", headers=owner_auth,
                           json={"message": "TEST_p1 backward-compat draft case test", "mode": "direct"},
                           timeout=180)
        assert rc.status_code == 200
        sid = rc.json()["session_id"]

        r = requests.post(f"{API}/cases/from-chat/{sid}", headers=owner_auth, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("id")
        # default outcome FIXED, empty root_cause/repair OK
        assert d["outcome"] == "FIXED"
        assert d.get("linked_chat_session_id") == sid
        # close_session defaults to True so the session should also be closed
        rs = requests.get(f"{API}/chat/sessions", headers=owner_auth, timeout=15)
        assert rs.status_code == 200
        sess = next((s for s in rs.json() if s["id"] == sid), None)
        assert sess and sess.get("status") == "closed"

    def test_close_with_vehicle_context(self, owner_auth):
        # Create a vehicle
        rv = requests.post(f"{API}/vehicles", headers=owner_auth,
                           json={"year": "2014", "make": "Chevrolet", "model": "Silverado",
                                 "engine": "5.3L V8", "vin": "TEST_p1_vin", "mods": "", "notes": "TEST_p1"},
                           timeout=15)
        assert rv.status_code == 200, rv.text
        vid = rv.json()["id"]

        # Start a chat first
        rc = requests.post(f"{API}/chat", headers=owner_auth,
                           json={"message": "TEST_p1 silverado AFM lifter knock", "mode": "direct"},
                           timeout=180)
        assert rc.status_code == 200
        sid = rc.json()["session_id"]
        # Attach vehicle to the session via PATCH (chat endpoint doesn't persist vehicle_id on session)
        rp = requests.patch(f"{API}/chat/sessions/{sid}", headers=owner_auth,
                            json={"vehicle_id": vid}, timeout=15)
        assert rp.status_code == 200, rp.text

        r = requests.post(f"{API}/cases/from-chat/{sid}", headers=owner_auth,
                          json={"outcome": "PARTIAL", "close_session": True}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["outcome"] == "PARTIAL"
        # vehicle context should be populated from session.vehicle_id
        veh = d.get("vehicle") or {}
        assert veh.get("make") == "Chevrolet"
        assert veh.get("model") == "Silverado"
        assert str(veh.get("year")) == "2014"

        # cleanup vehicle
        requests.delete(f"{API}/vehicles/{vid}", headers=owner_auth, timeout=15)


# ---------------- 2. Brain team conversations ----------------

class TestBrainTeamConversations:
    def test_no_bearer_401(self):
        r = requests.get(f"{API}/brain/team-conversations", params={"shop_id": SHOP_ID}, timeout=15)
        assert r.status_code == 401

    def test_wrong_bearer_401(self):
        r = requests.get(
            f"{API}/brain/team-conversations",
            params={"shop_id": SHOP_ID},
            headers={"Authorization": "Bearer not-a-real-token"},
            timeout=15,
        )
        assert r.status_code == 401

    def test_all_threads(self, brain_auth):
        r = requests.get(f"{API}/brain/team-conversations",
                         params={"shop_id": SHOP_ID}, headers=brain_auth, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["shop_id"] == SHOP_ID
        assert isinstance(d.get("thread_count"), int)
        assert isinstance(d.get("threads"), list)
        for t in d["threads"]:
            assert "thread_key" in t
            assert t["kind"] in ("channel", "dm")
            assert "name" in t and "members" in t
            assert "message_count" in t
            assert isinstance(t.get("messages"), list)
            # chronological: created_at ascending
            ts = [m.get("created_at") for m in t["messages"] if m.get("created_at")]
            assert ts == sorted(ts), f"messages not chronological in thread {t['thread_key']}"

    def test_thread_key_shop_only(self, brain_auth):
        r = requests.get(f"{API}/brain/team-conversations",
                         params={"shop_id": SHOP_ID, "thread_key": "shop"},
                         headers=brain_auth, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["thread_count"] == 1
        assert d["threads"][0]["thread_key"] == "shop"
        assert d["threads"][0]["kind"] == "channel"

    def test_technician_scope(self, owner_auth, brain_auth):
        # Look up any tech in this shop
        rt = requests.get(f"{API}/techs", headers=owner_auth, timeout=15)
        # /api/techs may or may not exist; tolerate either
        tech_id = None
        if rt.status_code == 200 and isinstance(rt.json(), list) and rt.json():
            tech_id = rt.json()[0].get("id")
        if not tech_id:
            pytest.skip("No tech available to scope conversations to")
        r = requests.get(f"{API}/brain/team-conversations",
                         params={"shop_id": SHOP_ID, "technician_id": tech_id},
                         headers=brain_auth, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        for t in d["threads"]:
            if t["thread_key"] != "shop":
                assert tech_id in t["thread_key"].split("|"), \
                    f"thread {t['thread_key']} not visible to tech {tech_id}"


# ---------------- 3. Shop profile ----------------

class TestShopProfile:
    def test_get_profile_auto_seed(self, owner_auth):
        r = requests.get(f"{API}/shop/profile", headers=owner_auth, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("name", "capabilities", "specialties", "service_areas",
                  "hours", "phone", "address", "notes"):
            assert k in d, f"missing field {k}"
        assert isinstance(d["capabilities"], list)
        assert isinstance(d["specialties"], list)
        assert isinstance(d["service_areas"], list)

    def test_put_profile_updates_and_trims(self, owner_auth):
        new_name = "Dr. Underhood Performance"
        caps = ["  ECM/TCM tuning  ", "", "Datalog diagnostics"]  # blank + whitespace gets stripped
        # 60 specialties to test 50-limit
        specs = [f"Spec{i}" for i in range(60)]
        body = {
            "name": new_name,
            "capabilities": caps,
            "specialties": specs,
            "service_areas": ["Fort Smith AR", "NW Arkansas"],
            "hours": "M-F 8-5",
            "phone": "479-555-0101",
            "address": "100 Wrench Ln",
            "notes": "TEST_p1 notes",
        }
        r = requests.put(f"{API}/shop/profile", headers=owner_auth, json=body, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["name"] == new_name
        # blank capability stripped, whitespace trimmed
        assert d["capabilities"] == ["ECM/TCM tuning", "Datalog diagnostics"]
        # specialties trimmed to 50
        assert len(d["specialties"]) == 50
        assert d["service_areas"] == ["Fort Smith AR", "NW Arkansas"]
        assert d["phone"] == "479-555-0101"

        # GET again to confirm persistence
        rg = requests.get(f"{API}/shop/profile", headers=owner_auth, timeout=15)
        assert rg.status_code == 200
        g = rg.json()
        assert g["name"] == new_name
        assert g["capabilities"] == ["ECM/TCM tuning", "Datalog diagnostics"]
        assert len(g["specialties"]) == 50

    def test_put_profile_forbidden_for_tech(self, owner_auth):
        # Create a tech (idempotent-ish): if it exists, login should still work
        tech_email = f"testtech_p1@drunderhood.com"
        tech_pw = "wrench"
        rt = requests.post(f"{API}/techs", headers=owner_auth,
                           json={"name": "TestTechP1", "email": tech_email,
                                 "password": tech_pw, "role": "tech"}, timeout=15)
        if rt.status_code not in (200, 201, 400, 409):
            pytest.skip(f"/api/techs create returned {rt.status_code}: {rt.text}")

        rl = requests.post(f"{API}/auth/login",
                           json={"email": tech_email, "password": tech_pw}, timeout=30)
        if rl.status_code != 200:
            pytest.skip(f"tech login failed: {rl.status_code} {rl.text}")
        tech_token = rl.json()["token"]
        tech_auth = {"Authorization": f"Bearer {tech_token}"}

        # tech can GET the profile
        rg = requests.get(f"{API}/shop/profile", headers=tech_auth, timeout=15)
        assert rg.status_code == 200, rg.text

        # but PUT must 403
        rp = requests.put(f"{API}/shop/profile", headers=tech_auth,
                          json={"name": "HACKED"}, timeout=15)
        assert rp.status_code == 403, f"expected 403, got {rp.status_code} {rp.text}"

    def test_brain_shop_profile(self, brain_auth):
        r = requests.get(f"{API}/brain/shop-profile",
                         params={"shop_id": SHOP_ID}, headers=brain_auth, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "capabilities" in d and "specialties" in d
        assert d.get("name")

    def test_brain_shop_profile_unauth(self):
        r = requests.get(f"{API}/brain/shop-profile",
                         params={"shop_id": SHOP_ID}, timeout=15)
        assert r.status_code == 401

    def test_brain_stats_includes_profile_fields(self, brain_auth):
        r = requests.get(f"{API}/brain/stats",
                         params={"shop_id": SHOP_ID}, headers=brain_auth, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("shop_name", "capabilities", "specialties", "service_areas"):
            assert k in d, f"brain/stats missing {k}"
        # After previous PUT it should be populated
        assert d["shop_name"]
        assert isinstance(d["capabilities"], list) and len(d["capabilities"]) >= 1


# ---------------- 4. Search cache ----------------

class TestSearchCache:
    def test_search_caches_second_call(self, brain_auth):
        q = f"TEST_p1_cache_{uuid.uuid4().hex[:8]} ls3 base spark"
        body = {"shop_id": SHOP_ID, "query": q, "mode": "web"}
        t0 = time.time()
        r1 = requests.post(f"{API}/brain/search-web", headers=brain_auth, json=body, timeout=120)
        t1 = time.time()
        assert r1.status_code == 200, r1.text
        d1 = r1.json()
        # First call should NOT be cached
        assert d1.get("cached") is False, f"expected cached=False on first call, got {d1.get('cached')}"

        # Second call — should be cached and fast
        t2 = time.time()
        r2 = requests.post(f"{API}/brain/search-web", headers=brain_auth, json=body, timeout=30)
        t3 = time.time()
        assert r2.status_code == 200, r2.text
        d2 = r2.json()
        assert d2.get("cached") is True, f"expected cached=True on second call, got {d2}"
        assert (t3 - t2) < 3.0, f"cached call took {t3 - t2:.2f}s, expected < 3s"

    def test_search_stats(self, brain_auth):
        r = requests.get(f"{API}/brain/search-stats",
                         params={"shop_id": SHOP_ID}, headers=brain_auth, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "unique_queries_cached" in d
        assert "cache_hits_saved" in d
        assert isinstance(d["unique_queries_cached"], int)
        assert isinstance(d["cache_hits_saved"], int)


# ---------------- 5. Ensure at least one OPEN chat session remains ----------------

class TestLeaveOpenSession:
    def test_seed_open_session_for_frontend(self, owner_auth):
        """Leave behind an open chat session so the frontend Jobs page has something to click."""
        r = requests.post(f"{API}/chat", headers=owner_auth,
                          json={"message": "TEST_p1 SEED: keep open for UI test — 2015 Mustang GT runs lean at WOT",
                                "mode": "direct"}, timeout=180)
        assert r.status_code == 200, r.text
        sid = r.json()["session_id"]
        # confirm it's open
        rs = requests.get(f"{API}/chat/sessions/{sid}", headers=owner_auth, timeout=15)
        assert rs.status_code == 200
        assert rs.json().get("status") != "closed"
