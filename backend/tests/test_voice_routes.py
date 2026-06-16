"""
Backend tests for Twilio voice webhook routes — verifying the fax-sound bug fix.

Key scenarios:
- /api/voice/incoming returns valid TwiML (NOT empty <Response></Response>) when
  Twilio signature validation fails (the prod fax-sound bug)
- Callback URLs in TwiML point to PUBLIC_BASE_URL (foreman.drunderhood.com)
- /voice/voicemail/done still creates DB rows on signature failure
- /voice/voicemail/transcription still creates lead on signature failure
- /voice/status returns 204 on signature failure (no DB write — left as-is)
- GET /api/voicemails returns list

Note: TWILIO_AUTH_TOKEN IS set in backend/.env, so signature check WILL fail
when we POST without X-Twilio-Signature — that's the exact scenario being fixed.
"""
import os
import re
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
# Frontend env isn't auto-loaded by pytest; fall back to reading file.
if not BASE_URL:
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                    break
    except FileNotFoundError:
        pass

assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

PUBLIC_BASE = "https://foreman.drunderhood.com"


# -------- helpers --------
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    return s


def _post_form(session, path, data):
    return session.post(f"{BASE_URL}{path}", data=data, timeout=20)


# -------- /api/voice/incoming --------
class TestVoiceIncoming:
    """The fax-sound bug: must return full greeting TwiML even without signature."""

    def test_returns_200_with_valid_twiml_no_signature(self, session):
        call_sid = f"CA_TEST_{uuid.uuid4().hex}"
        r = _post_form(session, "/api/voice/incoming", {
            "CallSid": call_sid,
            "From": "+14155550001",
            "To": "+18557711264",
        })
        assert r.status_code == 200, f"got {r.status_code}, body={r.text[:300]}"
        body = r.text
        # NOT the empty response that caused fax sound
        assert "<Response></Response>" not in body, "EMPTY_XML returned — fax-sound bug!"
        # Must contain Say greeting and Record
        assert "<Say" in body, f"missing <Say> tag: {body[:300]}"
        assert "Dr. Underhood Automotive" in body, "missing greeting text"
        assert "<Record" in body, f"missing <Record> tag: {body[:300]}"

    def test_content_type_is_application_xml(self, session):
        r = _post_form(session, "/api/voice/incoming", {
            "CallSid": f"CA_TEST_{uuid.uuid4().hex}",
            "From": "+14155550002",
            "To": "+18557711264",
        })
        ct = r.headers.get("content-type", "")
        assert "application/xml" in ct.lower(), f"content-type={ct}"

    def test_record_callback_urls_use_public_base(self, session):
        r = _post_form(session, "/api/voice/incoming", {
            "CallSid": f"CA_TEST_{uuid.uuid4().hex}",
            "From": "+14155550003",
            "To": "+18557711264",
        })
        body = r.text
        # Extract action and transcribeCallback URLs from <Record>
        action_match = re.search(r'action="([^"]+)"', body)
        transcribe_match = re.search(r'transcribeCallback="([^"]+)"', body)
        assert action_match, f"no action attr: {body[:400]}"
        assert transcribe_match, f"no transcribeCallback attr: {body[:400]}"
        action_url = action_match.group(1)
        transcribe_url = transcribe_match.group(1)
        assert action_url == f"{PUBLIC_BASE}/api/voice/voicemail/done", \
            f"action_url={action_url}"
        assert transcribe_url == f"{PUBLIC_BASE}/api/voice/voicemail/transcription", \
            f"transcribe_url={transcribe_url}"

    def test_does_not_contain_internal_k8s_url(self, session):
        """Twilio must POST back to public host, not internal cluster URL."""
        r = _post_form(session, "/api/voice/incoming", {
            "CallSid": f"CA_TEST_{uuid.uuid4().hex}",
            "From": "+14155550004",
            "To": "+18557711264",
        })
        body = r.text.lower()
        # No internal hosts leaked into TwiML
        assert "localhost" not in body
        assert "127.0.0.1" not in body
        assert ".svc.cluster.local" not in body
        assert ":8001" not in body


# -------- /api/voice/voicemail/done --------
class TestVoicemailDone:
    def test_creates_voicemail_row_and_returns_after_record_xml(self, session):
        call_sid = f"CA_TEST_VM_{uuid.uuid4().hex}"
        rec_sid = f"RE_TEST_{uuid.uuid4().hex}"
        # First trigger /incoming so a calls row exists for this sid
        _post_form(session, "/api/voice/incoming", {
            "CallSid": call_sid, "From": "+14155550010", "To": "+18557711264",
        })
        r = _post_form(session, "/api/voice/voicemail/done", {
            "CallSid": call_sid,
            "RecordingSid": rec_sid,
            "RecordingUrl": f"https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/{rec_sid}",
            "RecordingDuration": "12",
            "From": "+14155550010",
        })
        assert r.status_code == 200, f"got {r.status_code}, body={r.text[:300]}"
        body = r.text
        assert "<Say" in body and "<Hangup" in body, f"missing AFTER_RECORD_XML markers: {body[:300]}"
        assert "Got it" in body or "Doc will text" in body

        # Verify persistence via /api/voicemails list
        lr = session.get(f"{BASE_URL}/api/voicemails?limit=200", timeout=20)
        assert lr.status_code == 200, f"voicemails list status {lr.status_code}"
        rows = lr.json()
        matched = [v for v in rows if v.get("call_sid") == call_sid]
        assert matched, f"no voicemail row created for call_sid={call_sid}"
        vm = matched[0]
        assert vm.get("recording_sid") == rec_sid
        assert vm.get("duration") == 12
        # recording_url should have .mp3 appended
        assert vm.get("recording_url", "").endswith(".mp3"), \
            f"recording_url={vm.get('recording_url')}"


# -------- /api/voice/voicemail/transcription --------
class TestVoicemailTranscription:
    def test_creates_lead_with_kind_voicemail(self, session):
        call_sid = f"CA_TEST_TR_{uuid.uuid4().hex}"
        rec_sid = f"RE_TEST_TR_{uuid.uuid4().hex}"
        transcript = f"TEST transcript please call back about brakes {uuid.uuid4().hex[:8]}"

        # Create the chain: incoming -> done -> transcription
        _post_form(session, "/api/voice/incoming", {
            "CallSid": call_sid, "From": "+14155550020", "To": "+18557711264",
        })
        _post_form(session, "/api/voice/voicemail/done", {
            "CallSid": call_sid,
            "RecordingSid": rec_sid,
            "RecordingUrl": f"https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/{rec_sid}",
            "RecordingDuration": "20",
            "From": "+14155550020",
        })

        r = _post_form(session, "/api/voice/voicemail/transcription", {
            "CallSid": call_sid,
            "TranscriptionText": transcript,
            "TranscriptionStatus": "completed",
            "From": "+14155550020",
        })
        assert r.status_code == 200, f"got {r.status_code}, body={r.text[:300]}"

        # Verify lead persisted via /api/voicemails (has lead_id linked) — and
        # ideally check leads if there's a list endpoint; but lead_id linkage is
        # enough to prove the lead insert path ran.
        lr = session.get(f"{BASE_URL}/api/voicemails?limit=200", timeout=20)
        assert lr.status_code == 200
        rows = lr.json()
        matched = [v for v in rows if v.get("call_sid") == call_sid]
        assert matched, "voicemail row missing after transcription"
        vm = matched[0]
        assert vm.get("transcript") == transcript, f"transcript mismatch: {vm.get('transcript')}"
        assert vm.get("transcription_status") == "completed"
        assert vm.get("lead_id"), "lead_id not linked — lead row not created"


# -------- /api/voice/status --------
class TestVoiceStatus:
    def test_returns_204_when_signature_invalid(self, session):
        r = _post_form(session, "/api/voice/status", {
            "CallSid": f"CA_TEST_ST_{uuid.uuid4().hex}",
            "CallStatus": "completed",
        })
        assert r.status_code == 204, f"got {r.status_code}, body={r.text[:200]}"
        assert r.text == "" or r.text is None, f"expected empty body, got {r.text[:200]}"


# -------- /api/voicemails list --------
class TestVoicemailsList:
    def test_list_returns_200_and_list(self, session):
        r = session.get(f"{BASE_URL}/api/voicemails", timeout=20)
        assert r.status_code == 200, f"got {r.status_code}, body={r.text[:300]}"
        data = r.json()
        assert isinstance(data, list), f"expected list, got {type(data).__name__}"

    def test_list_respects_limit(self, session):
        r = session.get(f"{BASE_URL}/api/voicemails?limit=1", timeout=20)
        assert r.status_code == 200
        assert len(r.json()) <= 1

    def test_list_no_mongo_objectid_leaked(self, session):
        r = session.get(f"{BASE_URL}/api/voicemails?limit=5", timeout=20)
        assert r.status_code == 200
        for row in r.json():
            assert "_id" not in row, f"mongo _id leaked: {row}"
