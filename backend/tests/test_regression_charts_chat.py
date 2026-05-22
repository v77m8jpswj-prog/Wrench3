"""
Regression tests for Charts/Chat vehicle dropdown fix + copy-paste flows.
Scope: vehicles auto-cleanup, VIN decode, chart/edit table_text_out, letter HTML.
"""
import os
import re
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://dialogue-bot-9.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

OWNER_EMAIL = "doc@drunderhood.com"
OWNER_PASS = "wrench"
TAHOE_VIN = "1GNSKBKC7GR197364"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{API}/auth/login", json={"email": OWNER_EMAIL, "password": OWNER_PASS}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "access_token" in data or "token" in data, f"no token in {data}"
    return data.get("access_token") or data.get("token")


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# --- Auth ---
class TestAuth:
    def test_login_owner_returns_jwt(self, token):
        # JWT has 3 dot-sep parts
        assert token and token.count(".") == 2


# --- Vehicles list / auto-cleanup ---
class TestVehicles:
    def test_vehicles_returns_exactly_8(self, headers):
        r = requests.get(f"{API}/vehicles", headers=headers, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        # could be list or {vehicles: [...]} shape
        vehicles = data if isinstance(data, list) else data.get("vehicles", [])
        print(f"vehicles count={len(vehicles)}")
        for v in vehicles:
            print(f"  - {v.get('year')} {v.get('make')} {v.get('model')} vin={v.get('vin')}")
        assert len(vehicles) == 8, f"expected 8 vehicles after auto-cleanup, got {len(vehicles)}"

    def test_no_blank_entries(self, headers):
        r = requests.get(f"{API}/vehicles", headers=headers, timeout=15)
        data = r.json()
        vehicles = data if isinstance(data, list) else data.get("vehicles", [])
        for v in vehicles:
            year = v.get("year")
            make = v.get("make")
            model = v.get("model")
            vin = v.get("vin")
            # at least one identifier must be present
            assert any([year, make, model, vin]), f"blank vehicle entry leaked: {v}"

    def test_tahoe_present(self, headers):
        r = requests.get(f"{API}/vehicles", headers=headers, timeout=15)
        data = r.json()
        vehicles = data if isinstance(data, list) else data.get("vehicles", [])
        tahoes = [v for v in vehicles if (v.get("vin") or "").upper() == TAHOE_VIN]
        assert len(tahoes) >= 1, f"Tahoe vin {TAHOE_VIN} not found in vehicles list"
        t = tahoes[0]
        assert str(t.get("year")) == "2016"
        assert "chevrolet" in (t.get("make") or "").lower()
        assert "tahoe" in (t.get("model") or "").lower()


# --- VIN decode ---
class TestVinDecode:
    def test_decode_tahoe(self, headers):
        r = requests.get(f"{API}/vin/decode/{TAHOE_VIN}", headers=headers, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        # tolerant: look for 2016 + chevrolet + tahoe anywhere in dict values
        flat = str(data).lower()
        assert "2016" in flat
        assert "chevrolet" in flat
        assert "tahoe" in flat


# --- Chart edit ---
class TestChartEdit:
    def test_chart_edit_returns_table_text_out(self, headers):
        sample_table = "0\t1000\t2000\n100\t10\t12\n200\t11\t13\n"
        body = {
            "table_text": sample_table,
            "instruction": "add 1 degree timing",
        }
        r = requests.post(f"{API}/chart/edit", headers=headers, json=body, timeout=60)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        data = r.json()
        assert "table_text_out" in data, f"missing table_text_out key: {list(data.keys())}"
        out = data["table_text_out"]
        assert "\t" in out, "table_text_out should contain tabs"
        assert "\n" in out, "table_text_out should contain newlines"


# --- Letter HTML one-tap copy ---
class TestLetter:
    def test_letter_html_renders(self):
        r = requests.get(f"{BASE_URL}/api/letter/fan-table-tahoe-v1", timeout=15)
        assert r.status_code == 200, r.text
        html = r.text.lower()
        assert "<pre" in html and "letter" in html
        assert "tap to copy" in html or "copy entire letter" in html
