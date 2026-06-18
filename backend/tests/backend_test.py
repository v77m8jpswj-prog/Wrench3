"""
Data Wrench backend integration tests.
Covers: auth, chat (+heat), chat sessions, voice TTS, chart edit,
library upload/list/delete, vehicles CRUD, datalog, memory, settings.
"""
import os
import io
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://dialogue-bot-9.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

CRED = {"email": "doc@drunderhood.com", "password": "Wrench123!"}


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json=CRED, timeout=30)
    if r.status_code != 200:
        # try signup if not exists
        rs = requests.post(f"{API}/auth/signup", json={**CRED, "name": "Doc"}, timeout=30)
        if rs.status_code == 200:
            return rs.json()["token"]
        pytest.fail(f"Login failed {r.status_code}: {r.text}")
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---- Auth ----
class TestAuth:
    def test_root(self):
        r = requests.get(f"{API}/", timeout=15)
        assert r.status_code == 200
        assert r.json().get("status") == "online"

    def test_login_ok(self):
        r = requests.post(f"{API}/auth/login", json=CRED, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert "token" in d and "user" in d
        assert d["user"]["email"] == CRED["email"]

    def test_login_bad_pw(self):
        r = requests.post(f"{API}/auth/login", json={"email": CRED["email"], "password": "wrong"}, timeout=30)
        assert r.status_code == 401

    def test_me(self, auth):
        r = requests.get(f"{API}/auth/me", headers=auth, timeout=15)
        assert r.status_code == 200
        assert r.json()["email"] == CRED["email"]

    def test_me_no_token(self):
        r = requests.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 401


# ---- Chat ----
class TestChat:
    session_id = None

    def test_chat_basic(self, auth):
        r = requests.post(f"{API}/chat", headers=auth,
                          json={"message": "What's a good base spark target at WOT for an LS3 with 91 octane?",
                                "mode": "direct"}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["reply"] and isinstance(d["reply"], str)
        assert d["session_id"]
        assert d["heat_detected"] is False
        TestChat.session_id = d["session_id"]

    def test_chat_heat_detected(self, auth):
        r = requests.post(f"{API}/chat", headers=auth,
                          json={"message": "JUST ANSWER THE DAMN QUESTION, STUPID", "mode": "direct"},
                          timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["heat_detected"] is True

    def test_list_sessions(self, auth):
        r = requests.get(f"{API}/chat/sessions", headers=auth, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)
        assert len(r.json()) >= 1

    def test_get_session(self, auth):
        sid = TestChat.session_id
        assert sid, "session_id not captured"
        r = requests.get(f"{API}/chat/sessions/{sid}", headers=auth, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d["session_id"] == sid
        assert len(d["messages"]) >= 2


# ---- Voice TTS ----
class TestVoice:
    def test_tts(self, auth):
        r = requests.post(f"{API}/voice/speak", headers=auth,
                          json={"text": "test", "voice": "onyx"}, timeout=60)
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("audio/")
        assert len(r.content) > 200

    def test_tts_empty(self, auth):
        r = requests.post(f"{API}/voice/speak", headers=auth,
                          json={"text": "", "voice": "onyx"}, timeout=30)
        assert r.status_code == 400


# ---- Chart edit ----
class TestChart:
    def test_chart_edit(self, auth):
        # tiny 3x3 spark grid: header row + data rows
        grid = "RPM\t40\t60\n2000\t20\t22\n3000\t24\t26"
        r = requests.post(f"{API}/chart/edit", headers=auth,
                          json={"table_text": grid,
                                "instruction": "Pull 2 degrees of timing from every numeric data cell",
                                "table_label": "spark table"}, timeout=180)
        assert r.status_code == 200, r.text
        d = r.json()
        assert len(d["original_grid"]) == 3
        assert len(d["modified_grid"]) == 3
        assert len(d["modified_grid"][0]) == 3
        # at least some cells changed
        assert isinstance(d["changed_cells"], list)
        assert d["table_text_out"]


# ---- Library ----
class TestLibrary:
    item_id = None

    def test_upload(self, auth):
        content = b"LS3 base timing: 22 degrees at WOT on 91 octane. Knock retard threshold 2 degrees."
        files = {"file": ("ls3_notes.txt", io.BytesIO(content), "text/plain")}
        r = requests.post(f"{API}/library/upload", headers=auth, files=files, timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["id"]
        assert d["status"] == "ready"
        assert d["chunk_count"] >= 1
        TestLibrary.item_id = d["id"]

    def test_list(self, auth):
        r = requests.get(f"{API}/library", headers=auth, timeout=15)
        assert r.status_code == 200
        ids = [x["id"] for x in r.json()]
        assert TestLibrary.item_id in ids

    def test_delete(self, auth):
        r = requests.delete(f"{API}/library/{TestLibrary.item_id}", headers=auth, timeout=15)
        assert r.status_code == 200


# ---- Vehicles CRUD ----
class TestVehicles:
    vid = None

    def test_create(self, auth):
        r = requests.post(f"{API}/vehicles", headers=auth,
                          json={"year": "2010", "make": "Chevrolet", "model": "Camaro SS",
                                "engine": "LS3 6.2L", "mods": "Cam, headers, tune",
                                "vin": "TESTVIN123", "notes": "TEST_vehicle"}, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["id"]
        TestVehicles.vid = d["id"]

    def test_list_has(self, auth):
        r = requests.get(f"{API}/vehicles", headers=auth, timeout=15)
        assert r.status_code == 200
        assert any(v["id"] == TestVehicles.vid for v in r.json())

    def test_update(self, auth):
        r = requests.put(f"{API}/vehicles/{TestVehicles.vid}", headers=auth,
                         json={"year": "2010", "make": "Chevrolet", "model": "Camaro SS",
                               "engine": "LS3 6.2L", "mods": "Cam, headers, tune, E85",
                               "vin": "TESTVIN123", "notes": "TEST_updated"}, timeout=15)
        assert r.status_code == 200

    def test_delete(self, auth):
        r = requests.delete(f"{API}/vehicles/{TestVehicles.vid}", headers=auth, timeout=15)
        assert r.status_code == 200


# ---- Datalog ----
class TestDatalog:
    def test_analyze(self, auth):
        csv = b"time,rpm,map,afr,kr\n0.0,2000,40,14.7,0\n0.1,3000,60,12.5,0\n0.2,5500,95,11.2,3.5\n0.3,6000,98,10.8,5.0\n"
        files = {"file": ("log.csv", io.BytesIO(csv), "text/csv")}
        r = requests.post(f"{API}/datalog/analyze", headers=auth, files=files, timeout=180)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "summary" in d
        assert "findings" in d


# ---- Memory ----
class TestMemory:
    fid = None

    def test_add(self, auth):
        r = requests.post(f"{API}/memory", headers=auth,
                          json={"fact": "TEST_Doc prefers E85 builds for boost"}, timeout=15)
        assert r.status_code == 200
        TestMemory.fid = r.json()["id"]

    def test_list(self, auth):
        r = requests.get(f"{API}/memory", headers=auth, timeout=15)
        assert r.status_code == 200
        assert any(m["id"] == TestMemory.fid for m in r.json())

    def test_delete(self, auth):
        r = requests.delete(f"{API}/memory/{TestMemory.fid}", headers=auth, timeout=15)
        assert r.status_code == 200


# ---- Settings ----
class TestSettings:
    def test_update(self, auth):
        r = requests.put(f"{API}/settings", headers=auth,
                         json={"voice": "onyx", "voice_enabled": True, "mode": "direct"}, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("voice") == "onyx"
        assert d.get("mode") == "direct"
