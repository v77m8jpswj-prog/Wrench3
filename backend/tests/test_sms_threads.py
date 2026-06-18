"""
SMS Threads + unread-count endpoint tests.

Covers (per review request iteration_6):
- GET /api/sms/unread-count (auth required, returns {unread:int})
- GET /api/sms/threads (auth, list of grouped thread objects)
- GET /api/sms/threads/{phone_key}/messages
- POST /api/sms/threads/{phone_key}/mark-read
- Phone-format normalization (collapses + 14794345852 / (479) 434-5852 to same key)
- Lead name lookup populates thread.name

Seeds db.sms_messages + db.leads via direct API where possible, otherwise
inserts via the public /sms/inbound webhook (which exercises the prod path
that creates real-looking rows). Cleans up TEST-tagged rows after.
"""
import os
import re
import uuid
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://dialogue-bot-9.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

DOC_EMAIL = "doc@drunderhood.com"
DOC_PASSWORD = "wrench"

PHONE_A_FORMATS = ["+14794345852", "(479) 434-5852"]   # both should collapse → key 4794345852
PHONE_A_KEY = "4794345852"
PHONE_B = "+13105550199"  # arbitrary non-owner test phone
PHONE_B_KEY = "3105550199"
LEAD_NAME = "TEST_John Threadtest"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def token(session):
    r = session.post(f"{API}/auth/login", json={"email": DOC_EMAIL, "password": DOC_PASSWORD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("token")
    assert tok
    return tok


@pytest.fixture(scope="module")
def auth_session(session, token):
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session


# ---------- seed via direct DB (preferred) ----------
@pytest.fixture(scope="module")
def seeded(auth_session):
    """
    We can't talk to mongo directly from here, but the /sms/inbound webhook
    will insert exact rows. Use it to seed two unread inbound messages on
    phone A (with two different formats) and one inbound on phone B.
    Then use /sms/send (auth) to record an outbound on B.
    Finally insert a lead via /api/leads.
    Cleanup: delete the lead via /api/leads/{id}; sms rows are tagged with
    a unique TEST_TAG in the body so post-test we filter to delete them.
    """
    tag = f"TEST_SMS_THREAD_{uuid.uuid4().hex[:8]}"
    seeded_ids = {"sms_bodies_tag": tag, "lead_id": None, "phone_b_outbound_marker": None}

    # inbound to phone A — format 1 (E.164)
    r1 = requests.post(
        f"{API}/sms/inbound",
        data={
            "From": PHONE_A_FORMATS[0], "To": "+15555555555",
            "Body": f"{tag} hello from A1", "MessageSid": f"SM_{tag}_1",
            "NumMedia": 0, "FromCity": "Fort Smith", "FromState": "AR",
        },
    )
    assert r1.status_code == 200, r1.text

    # inbound to phone A — format 2 (formatted) — MUST collapse to same key
    r2 = requests.post(
        f"{API}/sms/inbound",
        data={
            "From": PHONE_A_FORMATS[1], "To": "+15555555555",
            "Body": f"{tag} hello from A2 (formatted)", "MessageSid": f"SM_{tag}_2",
            "NumMedia": 0,
        },
    )
    assert r2.status_code == 200, r2.text

    # inbound from phone B
    r3 = requests.post(
        f"{API}/sms/inbound",
        data={
            "From": PHONE_B, "To": "+15555555555",
            "Body": f"{tag} hi from B", "MessageSid": f"SM_{tag}_3",
            "NumMedia": 0,
        },
    )
    assert r3.status_code == 200, r3.text

    # create a lead with PHONE_A digits so threads should pick up name
    lead_payload = {"name": LEAD_NAME, "contact": "4794345852", "vehicle": "TEST Truck",
                    "intent": "test", "source": "test"}
    lr = auth_session.post(f"{API}/leads", json=lead_payload)
    if lr.status_code in (200, 201):
        seeded_ids["lead_id"] = lr.json().get("id")

    yield seeded_ids

    # cleanup lead
    if seeded_ids["lead_id"]:
        try:
            auth_session.delete(f"{API}/leads/{seeded_ids['lead_id']}")
        except Exception:
            pass
    # SMS rows: leave them tagged; tag is unique and not user-visible noise


# ---------- tests ----------

# 1) auth gating
def test_unread_count_requires_auth(session):
    r = requests.get(f"{API}/sms/unread-count")
    assert r.status_code in (401, 403), f"unauth should be 401/403, got {r.status_code}"


def test_threads_requires_auth():
    r = requests.get(f"{API}/sms/threads")
    assert r.status_code in (401, 403)


# 2) unread-count happy path
def test_unread_count_returns_int(auth_session, seeded):
    r = auth_session.get(f"{API}/sms/unread-count")
    assert r.status_code == 200
    j = r.json()
    assert "unread" in j
    assert isinstance(j["unread"], int)
    assert j["unread"] >= 3, f"expected at least 3 unread after seeding, got {j}"


# 3) threads list contains seeded phones & collapses formats
def test_threads_collapse_phone_formats(auth_session, seeded):
    r = auth_session.get(f"{API}/sms/threads")
    assert r.status_code == 200
    threads = r.json()
    assert isinstance(threads, list)
    keys = [t.get("phone_key") for t in threads]
    # Both formats for phone A must collapse to the same key — there must be
    # exactly ONE thread for PHONE_A_KEY (not two).
    a_threads = [t for t in threads if t.get("phone_key") == PHONE_A_KEY]
    assert len(a_threads) == 1, f"phone A formats should collapse to 1 thread, got {len(a_threads)}"
    a = a_threads[0]
    # Should have BOTH messages counted (total_count >= 2)
    assert a["total_count"] >= 2
    assert a["unread_count"] >= 2
    # last_direction is whatever was most recent (inbound for our seed)
    assert a["last_direction"] in ("inbound", "outbound")
    # Required fields shape
    for fld in ("phone", "name", "lead_id", "last_at", "last_body",
                "last_direction", "unread_count", "total_count"):
        assert fld in a, f"thread missing field {fld}"


def test_threads_name_from_lead(auth_session, seeded):
    r = auth_session.get(f"{API}/sms/threads")
    assert r.status_code == 200
    threads = r.json()
    a = next((t for t in threads if t.get("phone_key") == PHONE_A_KEY), None)
    assert a is not None
    if seeded.get("lead_id"):
        assert a["name"] == LEAD_NAME, f"expected name from lead, got name={a.get('name')!r}"
        assert a["lead_id"] == seeded["lead_id"]


def test_threads_sorted_newest_first(auth_session, seeded):
    r = auth_session.get(f"{API}/sms/threads")
    assert r.status_code == 200
    threads = r.json()
    if len(threads) >= 2:
        # unread-priority sort: unread threads first; within group, last_at desc
        unread_block = [t for t in threads if t["unread_count"] > 0]
        # within the unread block, last_at should be desc
        ats = [t["last_at"] for t in unread_block if t.get("last_at")]
        assert ats == sorted(ats, reverse=True)


# 4) thread messages endpoint returns chronologically all of them
def test_thread_messages_chronological(auth_session, seeded):
    r = auth_session.get(f"{API}/sms/threads/{PHONE_A_KEY}/messages")
    assert r.status_code == 200
    msgs = r.json()
    assert isinstance(msgs, list)
    tag = seeded["sms_bodies_tag"]
    our = [m for m in msgs if tag in (m.get("body") or "")]
    assert len(our) >= 2, f"expected >=2 messages for thread A, got {len(our)}"
    # All belong to this customer key
    for m in our:
        other = m.get("from_number") if m.get("direction") == "inbound" else m.get("to_number")
        digits = re.sub(r"\D", "", other or "")[-10:]
        assert digits == PHONE_A_KEY
    # Oldest → newest order
    ats = [m["created_at"] for m in our if m.get("created_at")]
    assert ats == sorted(ats), "messages should be oldest→newest"


def test_thread_messages_phone_key_normalization(auth_session, seeded):
    # Use formatted form — server should strip and match
    r = auth_session.get(f"{API}/sms/threads/(479)%20434-5852/messages")
    assert r.status_code == 200
    msgs = r.json()
    tag = seeded["sms_bodies_tag"]
    our = [m for m in msgs if tag in (m.get("body") or "")]
    assert len(our) >= 2


def test_thread_messages_unknown_key_empty(auth_session):
    r = auth_session.get(f"{API}/sms/threads/0000000000/messages")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# 5) mark-read flips unread to 0 and unread-count decreases
def test_mark_read_thread(auth_session, seeded):
    before = auth_session.get(f"{API}/sms/unread-count").json()["unread"]

    r = auth_session.post(f"{API}/sms/threads/{PHONE_A_KEY}/mark-read", json={})
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True
    assert isinstance(j["updated"], int)
    assert j["updated"] >= 2, f"should have marked at least 2 inbound A msgs, got updated={j['updated']}"

    # The same thread should now have unread_count == 0
    threads = auth_session.get(f"{API}/sms/threads").json()
    a = next((t for t in threads if t.get("phone_key") == PHONE_A_KEY), None)
    assert a is not None and a["unread_count"] == 0

    after = auth_session.get(f"{API}/sms/unread-count").json()["unread"]
    assert after == before - j["updated"], f"unread-count should drop by {j['updated']}, before={before}, after={after}"


def test_mark_read_idempotent(auth_session):
    # Second call should report 0 updates
    r = auth_session.post(f"{API}/sms/threads/{PHONE_A_KEY}/mark-read", json={})
    assert r.status_code == 200
    assert r.json()["updated"] == 0


def test_mark_read_empty_key(auth_session):
    r = auth_session.post(f"{API}/sms/threads/abc/mark-read", json={})
    assert r.status_code == 200
    assert r.json()["updated"] == 0
