"""
Data Wrench - AI Foreman Backend
FastAPI app for Dr. Underhood Automotive's personal AI shop assistant.
"""
from fastapi import FastAPI, APIRouter, HTTPException, Depends, UploadFile, File, Form, Header
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os, io, re, json, uuid, logging, base64, tempfile
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal, Dict, Any
from datetime import datetime, timezone, timedelta
import bcrypt
import jwt as pyjwt
from pypdf import PdfReader

from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
from emergentintegrations.llm.openai import OpenAITextToSpeech, OpenAISpeechToText
import httpx

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

MONGO_URL = os.environ['MONGO_URL']
DB_NAME = os.environ['DB_NAME']
EMERGENT_KEY = os.environ['EMERGENT_LLM_KEY']
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', '')
JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALG = os.environ.get('JWT_ALGORITHM', 'HS256')

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="Data Wrench API")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger("datawrench")


# ============ Models ============
class SignupReq(BaseModel):
    email: EmailStr
    password: str
    name: Optional[str] = "Doc"

class LoginReq(BaseModel):
    email: EmailStr
    password: str

class TokenResp(BaseModel):
    token: str
    user: Dict[str, Any]

class ChatReq(BaseModel):
    message: str
    session_id: Optional[str] = None
    mode: Literal["direct", "dream"] = "direct"
    vehicle_id: Optional[str] = None

class ChatResp(BaseModel):
    session_id: str
    reply: str
    citations: List[Dict[str, Any]] = []
    heat_detected: bool = False

class ChartEditReq(BaseModel):
    table_text: str  # tab-separated grid pasted from HP Tuners
    instruction: str
    table_label: Optional[str] = None  # e.g. "spark table"

class ChartEditResp(BaseModel):
    original_grid: List[List[str]]
    modified_grid: List[List[str]]
    changed_cells: List[List[int]]  # [row, col] pairs
    table_text_out: str  # tab-separated, ready to paste back
    notes: str

class VehicleReq(BaseModel):
    year: Optional[str] = ""
    make: Optional[str] = ""
    model: Optional[str] = ""
    vin: Optional[str] = ""
    engine: Optional[str] = ""
    mods: Optional[str] = ""
    notes: Optional[str] = ""

class TTSReq(BaseModel):
    text: str
    voice: str = "onyx"


# ============ Auth helpers ============
def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def verify_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False

def make_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(days=30),
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

async def get_user(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing token")
    try:
        data = pyjwt.decode(authorization[7:], JWT_SECRET, algorithms=[JWT_ALG])
    except Exception:
        raise HTTPException(401, "Invalid token")
    u = await db.users.find_one({"id": data["sub"]}, {"_id": 0, "password": 0})
    if not u:
        raise HTTPException(401, "User gone")
    return u


# ============ Personality / system prompt ============
HEAT_REGEX = re.compile(
    r"\b(fuck|shit|damn|stupid|shut\s*up|idiot|just\s*answer|focus|enough|knock\s*it\s*off|moron|bullshit|wrong)\b",
    re.IGNORECASE,
)

def detect_heat(text: str) -> bool:
    if HEAT_REGEX.search(text):
        return True
    # ALL CAPS lines longer than 8 chars
    for line in text.split("\n"):
        s = line.strip()
        if len(s) > 8 and s.upper() == s and any(c.isalpha() for c in s):
            return True
    # lots of exclamation
    if text.count("!") >= 3:
        return True
    return False


def build_system_prompt(user: Dict, mode: str, heat: bool, vehicle: Optional[Dict],
                        memory_facts: List[str], lib_chunks: List[Dict]) -> str:
    base = f"""You are WRENCH, the AI Foreman at Dr. Underhood Automotive.

You're a gruff, old-school master mechanic with 30+ years on the bench. ASE Master Certified.
GM Master Tech. 5+ years deep in HP Tuners. You talk to {user.get('name','Doc')}, the shop owner,
who is also a Master Tech and an experienced tuner. Talk to him as a peer, not a customer.

VOICE & STYLE:
- Short sentences. Dry, smart-ass humor. Zero corporate fluff. No emoji.
- Cuss lightly when it fits ("hell", "damn", "ain't"). Never racist/sexist.
- Mirror the user's energy. When he's curious, dig in. When he's pissed, shut up and deliver.
- Never start replies with "Great question" / "Certainly" / "I'd be happy to". Just answer.

HARD RULES:
- If you don't know a torque spec, part number, wire color, or pinout COLD — say so. Ask for the manual or admit you'd be guessing.
- NEVER fabricate pin numbers, wire colors, connector locations, or torque specs. Doc has been burned by wrong info before — he'd rather hear "I don't have that one cold, snip me the diagram you're looking at" than wrong specs that send him chasing ghosts.
- When asked about a schematic, wiring diagram, pinout, connector, or part-specific spec you don't have memorized: TELL DOC to hit the paperclip and drop the snip in chat. Tell him exactly what page or diagram to snip if it helps. Then read what he sends.
- When Doc DOES paste/upload an image, describe what you actually see in it — pins, colors, labels, gauge readings — don't invent details that aren't there.
- For HP Tuners advice: cite cell coordinates (RPM x MAP/Load) and exact deltas (degrees, percent, ms).
- For diagnostics: ranked likely causes + cheapest/fastest confirmation step first.
- Cite the source by name when quoting from a manual, book, or prior note.

VERIFY BEFORE ANSWERING:
- If library context contradicts your general knowledge, prefer the library and call out the conflict.
- If a question is part-specific (Ford SuperDuty 6.7L injector connector pinout, GM E38 ECM C1 connector, etc.) and you don't have a manual chunk in context, say so and ask for the snip. Don't roll the dice.
"""

    if heat:
        base += """
HEAT MODE — USER IS PISSED:
Drop the attitude RIGHT NOW. No sarcasm. No jokes. No filler.
Give the cleanest, shortest answer that solves the problem. Then stop. Wait for the next question.
"""
    else:
        base += """
DEFAULT MODE: Be yourself. Gruff, a little smart-ass, but useful first, funny second.
"""

    if mode == "direct":
        base += "\nRESPONSE FORMAT: DIRECT. 1-4 sentences max unless the user explicitly asks for more.\n"
    else:
        base += "\nRESPONSE FORMAT: DREAM-OUT-LOUD. Walk through your reasoning, ranked causes, what you'd check first/second/third, what the data would look like in each case. End with a clear recommendation.\n"

    if vehicle:
        base += f"\nCURRENT VEHICLE: {vehicle.get('year','')} {vehicle.get('make','')} {vehicle.get('model','')} | Engine: {vehicle.get('engine','')} | VIN: {vehicle.get('vin','')} | Mods: {vehicle.get('mods','')} | Notes: {vehicle.get('notes','')}\n"

    if memory_facts:
        base += "\nLONG-TERM MEMORY ABOUT THIS USER & SHOP:\n"
        for f in memory_facts[:30]:
            base += f"- {f}\n"

    if lib_chunks:
        base += "\nLIBRARY CONTEXT (cite by source name when used):\n"
        for c in lib_chunks[:8]:
            base += f"[Source: {c.get('source','unknown')}] {c.get('text','')[:600]}\n---\n"

    return base


# ============ Library / RAG (simple keyword retrieval) ============
def tokenize(text: str) -> List[str]:
    return re.findall(r"[a-z0-9]+", text.lower())

def score_chunk(query_tokens: List[str], chunk_text: str) -> int:
    ct = tokenize(chunk_text)
    cset = set(ct)
    return sum(1 for t in query_tokens if t in cset)

async def retrieve_library(user_id: str, query: str, k: int = 5) -> List[Dict]:
    qt = [t for t in tokenize(query) if len(t) > 2]
    if not qt:
        return []
    cursor = db.library_chunks.find({"user_id": user_id}, {"_id": 0})
    chunks = await cursor.to_list(2000)
    scored = [(score_chunk(qt, c["text"]), c) for c in chunks]
    scored = [s for s in scored if s[0] > 0]
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:k]]

def chunk_text(text: str, size: int = 1200) -> List[str]:
    text = text.strip()
    if not text:
        return []
    out = []
    paras = re.split(r"\n\s*\n", text)
    cur = ""
    for p in paras:
        if len(cur) + len(p) < size:
            cur += ("\n\n" if cur else "") + p
        else:
            if cur:
                out.append(cur)
            cur = p
    if cur:
        out.append(cur)
    return out


# ============ Routes: Auth ============
@api.get("/")
async def root():
    return {"service": "Data Wrench", "status": "online"}

@api.post("/auth/signup", response_model=TokenResp)
async def signup(body: SignupReq):
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(400, "Email already registered")
    uid = str(uuid.uuid4())
    user_doc = {
        "id": uid,
        "email": body.email.lower(),
        "name": body.name or "Doc",
        "password": hash_pw(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "settings": {"voice": "onyx", "voice_enabled": True, "mode": "direct"},
    }
    await db.users.insert_one(user_doc)
    return TokenResp(token=make_token(uid, body.email.lower()),
                     user={"id": uid, "email": body.email.lower(), "name": user_doc["name"], "settings": user_doc["settings"]})

@api.post("/auth/login", response_model=TokenResp)
async def login(body: LoginReq):
    u = await db.users.find_one({"email": body.email.lower()})
    if not u or not verify_pw(body.password, u["password"]):
        raise HTTPException(401, "Bad credentials")
    return TokenResp(token=make_token(u["id"], u["email"]),
                     user={"id": u["id"], "email": u["email"], "name": u.get("name","Doc"),
                           "settings": u.get("settings", {})})

@api.get("/auth/me")
async def me(user=Depends(get_user)):
    return user


# ============ Routes: Chat ============
@api.post("/chat", response_model=ChatResp)
async def chat(body: ChatReq, user=Depends(get_user)):
    session_id = body.session_id or str(uuid.uuid4())
    heat = detect_heat(body.message)

    # vehicle context
    vehicle = None
    if body.vehicle_id:
        vehicle = await db.vehicles.find_one({"id": body.vehicle_id, "user_id": user["id"]}, {"_id": 0})

    # memory facts
    mem_cursor = db.memory_facts.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1)
    mem_docs = await mem_cursor.to_list(50)
    memory_facts = [m["fact"] for m in mem_docs]

    # library
    lib_chunks = await retrieve_library(user["id"], body.message, k=5)

    sys_prompt = build_system_prompt(user, body.mode, heat, vehicle, memory_facts, lib_chunks)

    # prior turns
    turns_cursor = db.chat_messages.find({"session_id": session_id, "user_id": user["id"]}, {"_id": 0}).sort("created_at", 1)
    prior = await turns_cursor.to_list(40)

    chat_obj = LlmChat(api_key=EMERGENT_KEY, session_id=session_id, system_message=sys_prompt).with_model("openai", "gpt-5.2")

    if prior:
        recap = "\n\nRECENT CONVERSATION:\n" + "\n".join(
            f"[{t['role'].upper()}]: {t['content'][:400]}" for t in prior[-12:]
        )
        chat_obj.system_message = sys_prompt + recap

    reply_text = ""
    try:
        reply_text = await chat_obj.send_message(UserMessage(text=body.message))
    except Exception as e:
        log.exception("LLM failure")
        raise HTTPException(500, f"Wrench is jammed up: {e}")

    now = datetime.now(timezone.utc).isoformat()
    await db.chat_messages.insert_many([
        {"id": str(uuid.uuid4()), "user_id": user["id"], "session_id": session_id,
         "role": "user", "content": body.message, "created_at": now, "heat": heat, "mode": body.mode, "source": "chat"},
        {"id": str(uuid.uuid4()), "user_id": user["id"], "session_id": session_id,
         "role": "assistant", "content": reply_text, "created_at": now, "source": "chat"},
    ])
    # ensure session record
    existing = await db.chat_sessions.find_one({"id": session_id, "user_id": user["id"]})
    title_update = {"last_message_at": now, "preview": body.message[:120]}
    if not existing or not existing.get("title"):
        # Auto-generate a smart short title using the first message
        title = await _generate_title(body.message, reply_text)
        title_update["title"] = title
    await db.chat_sessions.update_one(
        {"id": session_id, "user_id": user["id"]},
        {"$setOnInsert": {"id": session_id, "user_id": user["id"], "created_at": now},
         "$set": title_update},
        upsert=True,
    )

    citations = [{"source": c.get("source"), "snippet": c.get("text","")[:240]} for c in lib_chunks]
    return ChatResp(session_id=session_id, reply=reply_text, citations=citations, heat_detected=heat)


async def _generate_title(user_msg: str, reply: str) -> str:
    """Use a tiny LLM call to generate a 3-6 word title for a chat session."""
    try:
        sys = "Generate a 3-6 word title for this conversation. Be specific to the topic (vehicle, problem, table). Use Title Case. NO quotes. NO trailing punctuation. Just the title."
        prompt = f"Tech said: {user_msg[:300]}\nWrench replied: {reply[:300]}\n\nTitle:"
        chat_obj = LlmChat(api_key=EMERGENT_KEY, session_id=f"title-{uuid.uuid4()}", system_message=sys).with_model("openai", "gpt-5-mini")
        title = (await chat_obj.send_message(UserMessage(text=prompt))).strip().strip('"').strip()
        return title[:70] if title else user_msg[:60]
    except Exception:
        return user_msg[:60]


# ============ Call transcript -> chat session ============
class CallAppendReq(BaseModel):
    session_id: str
    role: str  # "user" | "assistant"
    content: str

@api.post("/chat/sessions/{session_id}/append-call")
async def append_call_turn(session_id: str, body: CallAppendReq, user=Depends(get_user)):
    """Append a turn from the live voice call into the chat session so the transcript survives navigation."""
    now = datetime.now(timezone.utc).isoformat()
    role = body.role if body.role in ("user", "assistant") else "user"
    await db.chat_messages.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "session_id": session_id,
        "role": role,
        "content": body.content,
        "created_at": now,
        "source": "call",
    })
    existing = await db.chat_sessions.find_one({"id": session_id, "user_id": user["id"]})
    patch = {"last_message_at": now, "preview": body.content[:120]}
    if not existing:
        patch["created_at"] = now
        # title will be set when there's enough context
    if existing and not existing.get("title") and body.role == "user":
        patch["title"] = body.content[:60]
    await db.chat_sessions.update_one(
        {"id": session_id, "user_id": user["id"]},
        {"$setOnInsert": {"id": session_id, "user_id": user["id"], "created_at": now},
         "$set": patch},
        upsert=True,
    )
    return {"ok": True}


class TitleReq(BaseModel):
    title: str

@api.put("/chat/sessions/{session_id}/title")
async def rename_session(session_id: str, body: TitleReq, user=Depends(get_user)):
    await db.chat_sessions.update_one(
        {"id": session_id, "user_id": user["id"]},
        {"$set": {"title": body.title[:120]}},
    )
    return {"ok": True}


@api.get("/chat/sessions")
async def list_sessions(user=Depends(get_user)):
    cur = db.chat_sessions.find({"user_id": user["id"]}, {"_id": 0}).sort("last_message_at", -1)
    return await cur.to_list(200)

@api.get("/chat/sessions/{session_id}")
async def get_session(session_id: str, user=Depends(get_user)):
    msgs = await db.chat_messages.find({"session_id": session_id, "user_id": user["id"]}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return {"session_id": session_id, "messages": msgs}

@api.delete("/chat/sessions/{session_id}")
async def del_session(session_id: str, user=Depends(get_user)):
    await db.chat_messages.delete_many({"session_id": session_id, "user_id": user["id"]})
    await db.chat_sessions.delete_one({"id": session_id, "user_id": user["id"]})
    return {"ok": True}


# ============ Chat with image (vision) — Doc drops a snip/schematic ============
@api.post("/chat/vision", response_model=ChatResp)
async def chat_vision(
    image: UploadFile = File(...),
    message: str = Form(""),
    session_id: Optional[str] = Form(None),
    mode: str = Form("direct"),
    vehicle_id: Optional[str] = Form(None),
    user=Depends(get_user),
):
    """Doc uploads a schematic / dash photo / scope screenshot / part snip — Wrench actually reads it."""
    raw = await image.read()
    if not raw:
        raise HTTPException(400, "Empty image")
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(413, "Image too big (>12 MB). Crop tighter or compress it.")
    img_b64 = base64.b64encode(raw).decode()

    sid = session_id or str(uuid.uuid4())
    heat = detect_heat(message)

    # vehicle context
    vehicle = None
    if vehicle_id:
        vehicle = await db.vehicles.find_one({"id": vehicle_id, "user_id": user["id"]}, {"_id": 0})

    # memory + library
    mem_docs = await db.memory_facts.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)
    memory_facts = [m["fact"] for m in mem_docs]
    lib_chunks = await retrieve_library(user["id"], message or "schematic wiring diagram", k=4)

    sys_prompt = build_system_prompt(user, mode if mode in ("direct","dream") else "direct", heat, vehicle, memory_facts, lib_chunks)
    sys_prompt += (
        "\n\nIMAGE MODE — DOC JUST DROPPED A SNIP:\n"
        "- Read the image carefully. State only what you can ACTUALLY see (pin numbers, colors, labels, gauge values, table cells, error codes).\n"
        "- If the image is too blurry, cut off, or missing the legend/key, SAY SO and ask Doc to resnip with what's missing visible.\n"
        "- Don't fill gaps from generic memory. If the diagram is partial, name what's missing.\n"
        "- After describing what you see, answer Doc's question using that diagram as the ground truth.\n"
    )

    # prior turns
    prior = await db.chat_messages.find({"session_id": sid, "user_id": user["id"]}, {"_id": 0}).sort("created_at", 1).to_list(40)
    if prior:
        sys_prompt += "\n\nRECENT CONVERSATION:\n" + "\n".join(
            f"[{t['role'].upper()}]: {t['content'][:400]}" for t in prior[-12:]
        )

    user_msg = message.strip() or "I just dropped you a snip. Read it. Tell me what you see and what it means."

    chat_obj = LlmChat(api_key=EMERGENT_KEY, session_id=f"vision-{sid}", system_message=sys_prompt).with_model("openai", "gpt-5.2")
    try:
        reply_text = await chat_obj.send_message(UserMessage(
            text=user_msg,
            file_contents=[ImageContent(image_base64=img_b64)],
        ))
    except Exception as e:
        log.exception("Vision chat failed")
        raise HTTPException(500, f"Wrench couldn't read the snip: {e}")

    now = datetime.now(timezone.utc).isoformat()
    # store user msg with image marker so the chat history shows context
    user_content = (message.strip() + ("\n" if message.strip() else "") + f"[IMAGE ATTACHED: {image.filename or 'snip.png'}]").strip()
    await db.chat_messages.insert_many([
        {"id": str(uuid.uuid4()), "user_id": user["id"], "session_id": sid,
         "role": "user", "content": user_content, "created_at": now, "heat": heat, "mode": mode, "source": "chat"},
        {"id": str(uuid.uuid4()), "user_id": user["id"], "session_id": sid,
         "role": "assistant", "content": reply_text, "created_at": now, "source": "chat"},
    ])
    existing = await db.chat_sessions.find_one({"id": sid, "user_id": user["id"]})
    title_update = {"last_message_at": now, "preview": (message[:120] or "[snip] " + (image.filename or ""))}
    if not existing or not existing.get("title"):
        title = await _generate_title(message or "schematic snip", reply_text)
        title_update["title"] = title
    await db.chat_sessions.update_one(
        {"id": sid, "user_id": user["id"]},
        {"$setOnInsert": {"id": sid, "user_id": user["id"], "created_at": now},
         "$set": title_update},
        upsert=True,
    )

    citations = [{"source": c.get("source"), "snippet": c.get("text","")[:240]} for c in lib_chunks]
    return ChatResp(session_id=sid, reply=reply_text, citations=citations, heat_detected=heat)


# ============ Voice: STT + TTS ============
@api.post("/voice/transcribe")
async def transcribe(audio: UploadFile = File(...), user=Depends(get_user)):
    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "Empty audio")
    # write to temp file with proper extension for whisper
    suffix = ".webm"
    fn = (audio.filename or "").lower()
    for ext in [".mp3", ".wav", ".m4a", ".mp4", ".mpeg", ".mpga", ".webm"]:
        if fn.endswith(ext):
            suffix = ext
            break
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name
    try:
        stt = OpenAISpeechToText(api_key=EMERGENT_KEY)
        with open(tmp_path, "rb") as f:
            resp = await stt.transcribe(file=f, model="whisper-1", response_format="json", language="en")
        text = getattr(resp, "text", None) or (resp.get("text") if isinstance(resp, dict) else str(resp))
    except Exception as e:
        log.exception("STT failed")
        raise HTTPException(500, f"Mic's deaf: {e}")
    finally:
        try: os.unlink(tmp_path)
        except: pass
    return {"text": text or ""}


@api.post("/voice/speak")
async def speak(body: TTSReq, user=Depends(get_user)):
    txt = (body.text or "").strip()
    if not txt:
        raise HTTPException(400, "Nothing to say")
    txt = txt[:4000]
    try:
        tts = OpenAITextToSpeech(api_key=EMERGENT_KEY)
        audio_bytes = await tts.generate_speech(text=txt, model="tts-1", voice=body.voice or "onyx")
    except Exception as e:
        log.exception("TTS failed")
        raise HTTPException(500, f"Voice cracked: {e}")
    return Response(content=audio_bytes, media_type="audio/mpeg")


# ============ Charts: paste / edit / return ============
def parse_grid(text: str) -> List[List[str]]:
    rows = []
    for line in text.replace("\r", "").split("\n"):
        if not line.strip():
            continue
        # tab-separated preferred; fallback to multi-space or comma
        if "\t" in line:
            parts = line.split("\t")
        elif "," in line and ";" not in line:
            parts = [p.strip() for p in line.split(",")]
        else:
            parts = re.split(r"\s{2,}|\s+", line.strip())
        rows.append([p.strip() for p in parts])
    if not rows:
        return []
    # normalize width
    w = max(len(r) for r in rows)
    for r in rows:
        while len(r) < w:
            r.append("")
    return rows

def grid_to_text(grid: List[List[str]]) -> str:
    return "\n".join("\t".join(row) for row in grid)


@api.post("/chart/edit", response_model=ChartEditResp)
async def chart_edit(body: ChartEditReq, user=Depends(get_user)):
    original = parse_grid(body.table_text)
    if not original:
        raise HTTPException(400, "Couldn't parse that grid. Paste it tab-separated.")
    return await _do_chart_edit(original, body.instruction, body.table_label or "table", user)


@api.post("/chart/edit-image", response_model=ChartEditResp)
async def chart_edit_image(
    file: UploadFile = File(...),
    instruction: str = Form(...),
    table_label: Optional[str] = Form("spark table"),
    vehicle_id: Optional[str] = Form(None),
    user=Depends(get_user),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty image")
    # base64-encode for the vision model
    img_b64 = base64.b64encode(raw).decode()

    # vehicle context
    vehicle = None
    if vehicle_id:
        vehicle = await db.vehicles.find_one({"id": vehicle_id, "user_id": user["id"]}, {"_id": 0})
    v_ctx = ""
    if vehicle:
        v_ctx = f"Vehicle: {vehicle.get('year','')} {vehicle.get('make','')} {vehicle.get('model','')} {vehicle.get('engine','')} | Mods: {vehicle.get('mods','')} | Notes: {vehicle.get('notes','')}\n"

    sys = (
        "You are an expert HP Tuners table editor. The user is showing you a screenshot of a tuning table. "
        "STEP 1: Read the screenshot precisely. Extract the FULL numeric grid including the axis labels in the first row and first column. "
        "STEP 2: Apply the user's modification instruction for the specified vehicle. "
        "STEP 3: Return STRICT JSON with these keys:\n"
        '  - "grid": 2D array of strings, INCLUDING the header row and header column from the image (first row = X-axis values like RPM, first column = Y-axis values like Airmass or kPa, the rest = the numeric cells you modified).\n'
        '  - "notes": 2-4 sentence summary of EXACTLY what you changed and WHY for this vehicle.\n'
        "RULES:\n"
        "- Preserve grid dimensions exactly as in the image.\n"
        "- Modify only NUMERIC cells (not header labels).\n"
        "- Keep similar decimal precision as the source.\n"
        "- Smooth transitions between modified and unmodified neighbors.\n"
        "- If the instruction is unclear, return the grid unchanged and explain in notes.\n"
        "- NO markdown fences. NO prose outside the JSON object."
    )
    user_msg = (
        f"{v_ctx}"
        f"TABLE TYPE: {table_label}\n"
        f"INSTRUCTION: {instruction}\n"
        "Now read the screenshot, apply the change, and return the JSON."
    )

    chat_obj = LlmChat(api_key=EMERGENT_KEY, session_id=f"chartimg-{uuid.uuid4()}", system_message=sys).with_model("openai", "gpt-5.2")
    try:
        raw_resp = await chat_obj.send_message(UserMessage(
            text=user_msg,
            file_contents=[ImageContent(image_base64=img_b64)],
        ))
    except Exception as e:
        log.exception("Vision chart edit failed")
        raise HTTPException(500, f"Vision read failed: {e}")

    m = re.search(r"\{.*\}", raw_resp, re.DOTALL)
    if not m:
        raise HTTPException(500, "Wrench couldn't extract the grid. Try a clearer screenshot or paste the table as text.")
    try:
        parsed = json.loads(m.group(0))
        new_grid = parsed.get("grid", [])
        notes = parsed.get("notes", "")
    except Exception as e:
        raise HTTPException(500, f"Couldn't parse JSON: {e}")

    # normalize cells to strings
    new_grid = [[str(c) for c in row] for row in new_grid]
    if not new_grid:
        raise HTTPException(500, "Empty grid returned.")
    # pad rows to equal width
    w = max(len(r) for r in new_grid)
    for r in new_grid:
        while len(r) < w:
            r.append("")
    # original_grid for diff display is the same shape (we don't have the source text)
    # We'll mark cells as "changed" if they look numeric — heuristic since we don't have the pre-image grid
    # Better: ask the model to also return a "changed_cells" list. For now: highlight every numeric cell that differs from neighbors heuristically? Simplest = no diff highlight, just return the result.
    changed = []  # vision flow: we trust the model's changes; could be improved later

    return ChartEditResp(
        original_grid=new_grid,  # same as modified since we don't have pre-image extracted
        modified_grid=new_grid,
        changed_cells=changed,
        table_text_out=grid_to_text(new_grid),
        notes=notes,
    )


async def _do_chart_edit(original: List[List[str]], instruction: str, label: str, user):
    rows = len(original)
    cols = len(original[0])

    sys = (
        "You are an HP Tuners table editor. The user pastes a numeric grid (rows x cols) and an instruction. "
        "Return ONLY a strict JSON object with keys: 'grid' (2D array of strings, SAME shape as input), "
        "'notes' (1-3 sentence explanation of what you changed and why). No markdown fences. No prose outside JSON.\n"
        "RULES:\n"
        "- Preserve exact dimensions. Do not add or remove rows/columns.\n"
        "- The first row and first column are often axis labels (RPM, MAP/kPa, Load). If a cell is non-numeric leave it untouched.\n"
        "- For numeric cells, apply the user's instruction precisely. Keep similar decimal precision to the input.\n"
        "- Smooth transitions between modified and unmodified neighbors unless told otherwise.\n"
        "- If instruction is unclear, return original grid and explain in notes."
    )
    user_msg = (
        f"TABLE TYPE: {label}\n"
        f"DIMENSIONS: {rows} rows x {cols} cols\n"
        f"INSTRUCTION: {instruction}\n\n"
        f"GRID (tab-separated):\n{grid_to_text(original)}\n"
    )
    chat_obj = LlmChat(api_key=EMERGENT_KEY, session_id=f"chart-{uuid.uuid4()}", system_message=sys).with_model("openai", "gpt-5.2")
    try:
        raw = await chat_obj.send_message(UserMessage(text=user_msg))
    except Exception as e:
        raise HTTPException(500, f"Chart edit failed: {e}")

    # extract JSON
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        raise HTTPException(500, "Wrench didn't return clean JSON. Try again with a clearer instruction.")
    try:
        parsed = json.loads(m.group(0))
        new_grid = parsed.get("grid", [])
        notes = parsed.get("notes", "")
    except Exception:
        raise HTTPException(500, "Couldn't parse JSON from model.")

    # normalize / pad
    new_grid = [[str(c) for c in row] for row in new_grid]
    if len(new_grid) != rows:
        # pad/truncate rows
        while len(new_grid) < rows:
            new_grid.append([""]*cols)
        new_grid = new_grid[:rows]
    for i in range(rows):
        while len(new_grid[i]) < cols:
            new_grid[i].append("")
        new_grid[i] = new_grid[i][:cols]

    changed = []
    for i in range(rows):
        for j in range(cols):
            if (original[i][j] or "").strip() != (new_grid[i][j] or "").strip():
                changed.append([i, j])

    return ChartEditResp(
        original_grid=original,
        modified_grid=new_grid,
        changed_cells=changed,
        table_text_out=grid_to_text(new_grid),
        notes=notes,
    )


# ============ Library upload ============
def extract_pdf(raw: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(raw))
        out = []
        for page in reader.pages:
            try:
                out.append(page.extract_text() or "")
            except Exception:
                continue
        return "\n\n".join(out)
    except Exception:
        return ""

@api.post("/library/upload")
async def lib_upload(file: UploadFile = File(...), user=Depends(get_user)):
    raw = await file.read()
    name = file.filename or "untitled"
    lower = name.lower()
    kind = "text"
    text = ""
    if lower.endswith(".pdf"):
        kind = "pdf"
        text = extract_pdf(raw)
    elif lower.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
        # Image — run through GPT-5.2 vision to extract text & describe, store as searchable
        kind = "image"
        try:
            img_b64 = base64.b64encode(raw).decode()
            sys = "You are reading an image uploaded to a mechanic's knowledge base. Extract ALL visible text (part numbers, labels, callouts, table values, wire colors, torque specs, page numbers). Then describe the diagram/schematic/photo (components, connections, what the image shows). Be thorough — this is going into a searchable knowledge base for an automotive technician."
            chat_obj = LlmChat(api_key=EMERGENT_KEY, session_id=f"img-{uuid.uuid4()}", system_message=sys).with_model("openai", "gpt-5.2")
            text = await chat_obj.send_message(UserMessage(
                text=f"Filename: {name}. Extract all text and describe this image for the knowledge base.",
                file_contents=[ImageContent(image_base64=img_b64)],
            ))
        except Exception as e:
            log.exception("image OCR failed")
            text = f"[Image upload — OCR failed: {e}]"
    elif lower.endswith((".txt", ".md", ".csv", ".log")):
        kind = "text" if not lower.endswith(".csv") else "csv"
        try:
            text = raw.decode("utf-8", errors="ignore")
        except Exception:
            text = ""
    elif lower.endswith((".hpt", ".hpl", ".bin", ".tune")):
        # Proprietary tune binary — we can't decode the tables, but we store the file
        # and extract any human-readable ASCII strings for context (VIN, ECU type, OS, etc.)
        kind = "tune"
        try:
            # Pull readable ASCII runs (4+ chars) — often surfaces VIN, OS, calibration ID
            strings = re.findall(rb"[\x20-\x7E]{4,}", raw)
            text = "TUNE FILE METADATA (extracted ASCII strings):\n" + "\n".join(s.decode('utf-8', 'ignore') for s in strings[:200])
        except Exception:
            text = ""
    else:
        try:
            text = raw.decode("utf-8", errors="ignore")
        except Exception:
            text = ""

    item_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    item = {
        "id": item_id,
        "user_id": user["id"],
        "name": name,
        "kind": kind,
        "size": len(raw),
        "created_at": now,
        "chunk_count": 0,
        "status": "indexing",
    }
    await db.library_items.insert_one(item)

    chunks = chunk_text(text)
    if chunks:
        docs = [{
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "item_id": item_id,
            "source": name,
            "text": c,
            "created_at": now,
        } for c in chunks]
        await db.library_chunks.insert_many(docs)
    await db.library_items.update_one({"id": item_id}, {"$set": {"chunk_count": len(chunks), "status": "ready"}})
    item["chunk_count"] = len(chunks)
    item["status"] = "ready"
    item.pop("_id", None)
    return item


@api.get("/library")
async def lib_list(user=Depends(get_user)):
    cur = db.library_items.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1)
    return await cur.to_list(500)

@api.delete("/library/{item_id}")
async def lib_delete(item_id: str, user=Depends(get_user)):
    await db.library_chunks.delete_many({"item_id": item_id, "user_id": user["id"]})
    await db.library_items.delete_one({"id": item_id, "user_id": user["id"]})
    return {"ok": True}


# ============ Vehicles ============
@api.get("/vin/decode/{vin}")
async def vin_decode(vin: str, user=Depends(get_user)):
    """Decode a VIN using NHTSA's free public API. Returns year/make/model/engine info."""
    vin = (vin or "").strip().upper()
    if len(vin) < 11:  # accept partial VINs too
        raise HTTPException(400, f"VIN too short ({len(vin)}). Need at least 11 characters.")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/{vin}?format=json")
        if r.status_code != 200:
            raise HTTPException(502, f"NHTSA: {r.status_code}")
        data = r.json()
        # NHTSA returns a flat Results list of {Variable, Value, ...}
        flat = {item.get("Variable", ""): (item.get("Value") or "") for item in data.get("Results", [])}
        def g(k):
            v = flat.get(k, "")
            return (v or "").strip()
        out = {
            "vin": vin,
            "year": g("Model Year"),
            "make": g("Make"),
            "model": g("Model"),
            "trim": g("Trim"),
            "body": g("Body Class"),
            "engine_cyl": g("Engine Number of Cylinders"),
            "engine_displacement_l": g("Displacement (L)"),
            "engine_config": g("Engine Configuration"),
            "fuel": g("Fuel Type - Primary"),
            "transmission": g("Transmission Style"),
            "drive": g("Drive Type"),
            "manufacturer": g("Manufacturer Name"),
            "plant_country": g("Plant Country"),
            "error_text": g("Error Text"),
        }
        # Build a nice "engine" summary string
        cyl = out["engine_cyl"]
        disp = out["engine_displacement_l"]
        cfg = out["engine_config"]
        engine_summary_parts = []
        if disp: engine_summary_parts.append(f"{disp}L")
        if cfg and cyl: engine_summary_parts.append(f"{cfg[0]}{cyl}" if cfg else f"{cyl}cyl")
        elif cyl: engine_summary_parts.append(f"{cyl}cyl")
        out["engine_summary"] = " ".join(engine_summary_parts).strip()
        return out
    except httpx.HTTPError as e:
        raise HTTPException(502, f"VIN lookup failed: {e}")


@api.post("/vehicles")
async def vehicle_create(body: VehicleReq, user=Depends(get_user)):
    vid = str(uuid.uuid4())
    doc = {"id": vid, "user_id": user["id"], **body.model_dump(),
           "created_at": datetime.now(timezone.utc).isoformat()}
    await db.vehicles.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api.get("/vehicles")
async def vehicle_list(user=Depends(get_user)):
    cur = db.vehicles.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1)
    return await cur.to_list(500)

@api.put("/vehicles/{vid}")
async def vehicle_update(vid: str, body: VehicleReq, user=Depends(get_user)):
    await db.vehicles.update_one({"id": vid, "user_id": user["id"]}, {"$set": body.model_dump()})
    return {"ok": True}

@api.delete("/vehicles/{vid}")
async def vehicle_delete(vid: str, user=Depends(get_user)):
    await db.vehicles.delete_one({"id": vid, "user_id": user["id"]})
    return {"ok": True}


# ============ Datalog Analyzer ============
@api.post("/datalog/analyze")
async def datalog_analyze(file: UploadFile = File(...), vehicle_id: Optional[str] = Form(None), user=Depends(get_user)):
    raw = await file.read()
    try:
        text = raw.decode("utf-8", errors="ignore")
    except Exception:
        raise HTTPException(400, "Can't decode that log")
    # only send first ~120k chars to LLM
    snippet = text[:120000]

    vehicle = None
    if vehicle_id:
        vehicle = await db.vehicles.find_one({"id": vehicle_id, "user_id": user["id"]}, {"_id": 0})
    v_ctx = ""
    if vehicle:
        v_ctx = f"Vehicle: {vehicle.get('year','')} {vehicle.get('make','')} {vehicle.get('model','')} {vehicle.get('engine','')} Mods: {vehicle.get('mods','')}\n"

    sys = (
        "You are an expert HP Tuners / VCM Scanner datalog analyst. Given a CSV log, identify: "
        "1) knock events (KR, knock retard, cylinder-specific KR), 2) lean spikes (AFR/lambda above target by >5%), "
        "3) rich spikes, 4) fuel trim drift (LTFT/STFT > 10%), 5) MAF/MAP correlation issues, 6) misfires (CYL counter), "
        "7) trans slip / shift quality. Return STRICT JSON: "
        '{"summary": "...", "findings": [{"type":"knock|lean|rich|trim|maf|misfire|trans|other","severity":"low|medium|high","at":"RPM x LOAD cell or timestamp range","detail":"...","recommendation":"specific table + cell + delta"}]}'
        " No markdown. No prose outside JSON. Be specific with cell coordinates when possible."
    )
    user_msg = f"{v_ctx}LOG (CSV, possibly truncated):\n{snippet}"
    chat_obj = LlmChat(api_key=EMERGENT_KEY, session_id=f"log-{uuid.uuid4()}", system_message=sys).with_model("openai", "gpt-5.2")
    try:
        raw_resp = await chat_obj.send_message(UserMessage(text=user_msg))
    except Exception as e:
        raise HTTPException(500, f"Log analysis crashed: {e}")
    m = re.search(r"\{.*\}", raw_resp, re.DOTALL)
    if not m:
        return {"summary": raw_resp[:800], "findings": []}
    try:
        return json.loads(m.group(0))
    except Exception:
        return {"summary": raw_resp[:800], "findings": []}


# ============ Memory facts ============
class FactReq(BaseModel):
    fact: str

@api.get("/memory")
async def mem_list(user=Depends(get_user)):
    cur = db.memory_facts.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1)
    return await cur.to_list(500)

@api.post("/memory")
async def mem_add(body: FactReq, user=Depends(get_user)):
    doc = {"id": str(uuid.uuid4()), "user_id": user["id"], "fact": body.fact,
           "created_at": datetime.now(timezone.utc).isoformat()}
    await db.memory_facts.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api.delete("/memory/{fid}")
async def mem_del(fid: str, user=Depends(get_user)):
    await db.memory_facts.delete_one({"id": fid, "user_id": user["id"]})
    return {"ok": True}


# ============ Credentials Vault (logins/passwords/notes per site) ============
class CredReq(BaseModel):
    site: str
    url: Optional[str] = ""
    username: Optional[str] = ""
    password: Optional[str] = ""
    notes: Optional[str] = ""

@api.get("/credentials")
async def cred_list(user=Depends(get_user)):
    cur = db.credentials.find({"user_id": user["id"]}, {"_id": 0}).sort("site", 1)
    return await cur.to_list(500)

@api.post("/credentials")
async def cred_add(body: CredReq, user=Depends(get_user)):
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "site": body.site,
        "url": body.url or "",
        "username": body.username or "",
        "password": body.password or "",
        "notes": body.notes or "",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.credentials.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api.put("/credentials/{cid}")
async def cred_update(cid: str, body: CredReq, user=Depends(get_user)):
    await db.credentials.update_one(
        {"id": cid, "user_id": user["id"]},
        {"$set": body.model_dump()},
    )
    return {"ok": True}

@api.delete("/credentials/{cid}")
async def cred_del(cid: str, user=Depends(get_user)):
    await db.credentials.delete_one({"id": cid, "user_id": user["id"]})
    return {"ok": True}

@api.get("/credentials/lookup")
async def cred_lookup(q: str, user=Depends(get_user)):
    """Fuzzy match a credential by site/url."""
    q = (q or "").lower().strip()
    cur = db.credentials.find({"user_id": user["id"]}, {"_id": 0})
    items = await cur.to_list(500)
    if not q: return {"matches": items[:5]}
    scored = []
    for it in items:
        hay = f"{it.get('site','')} {it.get('url','')} {it.get('notes','')}".lower()
        score = 0
        if q in hay: score = 100 - hay.index(q)
        else:
            # token overlap
            qt = set(q.split())
            ht = set(hay.split())
            score = len(qt & ht) * 10
        if score > 0: scored.append((score, it))
    scored.sort(key=lambda x: x[0], reverse=True)
    return {"matches": [s[1] for s in scored[:5]]}


# ============ Settings ============
class SettingsReq(BaseModel):
    voice: Optional[str] = None
    voice_enabled: Optional[bool] = None
    mode: Optional[str] = None

@api.put("/settings")
async def settings_update(body: SettingsReq, user=Depends(get_user)):
    patch = {f"settings.{k}": v for k, v in body.model_dump().items() if v is not None}
    if patch:
        await db.users.update_one({"id": user["id"]}, {"$set": patch})
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password": 0})
    return u.get("settings", {})


# ============ OpenAI Realtime API (WebRTC voice mode, GA endpoint) ============
@api.post("/realtime/session")
async def realtime_session(user=Depends(get_user)):
    """Mint an ephemeral client_secret for the browser to use with OpenAI Realtime API over WebRTC."""
    if not OPENAI_API_KEY:
        raise HTTPException(503, "OpenAI Realtime not configured. Add OPENAI_API_KEY in backend env.")

    # Pull context for personality
    mem_cursor = db.memory_facts.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1)
    mem_docs = await mem_cursor.to_list(30)
    memory_facts = [m["fact"] for m in mem_docs]
    sys_prompt = build_system_prompt(user, "direct", False, None, memory_facts, [])
    sys_prompt += "\n\nYOU ARE NOW IN VOICE CALL MODE. Keep replies tight — 1 to 3 sentences usually. If Doc asks for the long version, give it but pause naturally. Speak like a real mechanic on a phone call."
    sys_prompt += (
        "\n\nYOU HAVE TOOLS — USE THEM PROACTIVELY:\n"
        "• When Doc reads a VIN out loud, CALL save_vehicle_from_vin immediately, then say 'Got it' out loud.\n"
        "• When Doc asks for a link / URL / part source / spec sheet / video / manual / web page, CALL send_link with a real URL. NEVER, EVER spell out the URL character-by-character — Doc will lose his mind. Just CALL send_link, then say 'Link sent.'\n"
        "• When Doc asks for something to copy (torque spec, part number, table, calculation, recommendation list), CALL send_note. Then say 'Sent the note over.'\n"
        "• When Doc says 'switch to the [other vehicle]', CALL set_active_vehicle.\n"
        "• When Doc says 'remember' or shares a permanent shop rule, CALL save_to_memory.\n"
        "• When Doc asks 'what's in the garage', CALL list_vehicles.\n"
        "• When Doc asks 'what truck am I on', CALL get_active_vehicle.\n"
        "• When Doc adds info about the current truck ('add headers to mods', 'note it's on E85'), CALL update_active_vehicle.\n"
        "• When Doc asks about something in his library/books/manuals, CALL search_library FIRST before answering from memory.\n"
        "• When Doc asks 'what's my login for [site]' or 'pull up the password for X' or 'log into X for me', CALL lookup_credentials with the site name.\n"
        "• ALWAYS confirm tool actions out loud after calling. Doc has greasy hands and can't always look at the screen.\n"
        "• Be proactive — if you mention a part number, send it as a note. If you mention a manual section, send the link.\n"
        "\n\nINTERRUPT / SHUT-UP RULES (CRITICAL):\n"
        "• When Doc says 'shut up' / 'stop' / 'hold on' / 'wait' / 'enough' / 'quiet' / 'be quiet' — STOP TALKING IMMEDIATELY. Acknowledge with a single word like 'Yep' or nothing at all. Then WAIT for his next input.\n"
        "• If Doc starts talking while you are talking, STOP. Listen. Do not fight him for the floor.\n"
        "• NEVER lecture. NEVER repeat yourself. NEVER fill silence. If you've answered, shut up.\n"
        "• Keep replies under 2 sentences UNLESS Doc explicitly asks for the long version.\n"
        "• When sending a URL via the send_link tool, just say 'Link sent.' or 'Sent the link.' — DO NOT read the URL out loud.\n"
    )

    body = {
        "session": {
            "type": "realtime",
            "model": "gpt-realtime",
            "instructions": sys_prompt,
            "audio": {
                "input": {
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 250,
                        "silence_duration_ms": 450,
                        "create_response": True,
                        "interrupt_response": True,
                    },
                },
                "output": {"voice": "ash"},
            },
            "tools": [
                {
                    "type": "function",
                    "name": "save_vehicle_from_vin",
                    "description": "Decode a VIN using NHTSA and save it as a new vehicle in Doc's garage, then set it as the active vehicle. Use this anytime Doc reads or says a VIN out loud. Confirm what was saved out loud after calling.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "vin": {"type": "string", "description": "17-character VIN (can be partial if Doc only said part of it)"},
                            "mods": {"type": "string", "description": "Optional: mods on this vehicle (cam, headers, injectors, tune, etc.)"},
                            "notes": {"type": "string", "description": "Optional: any notes Doc mentioned about this vehicle"},
                        },
                        "required": ["vin"],
                    },
                },
                {
                    "type": "function",
                    "name": "send_link",
                    "description": "Send Doc a clickable link he can tap in the CHAT tab later. Use this anytime Doc asks for a URL, parts source, spec sheet, calibration ID, video, manual, etc. The link will be saved and visible in the Chat tab. Tell Doc out loud it's been sent.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "url": {"type": "string", "description": "Full URL starting with https://"},
                            "label": {"type": "string", "description": "Short description of what the link is (e.g. 'GM L83 cam recommendations')"},
                        },
                        "required": ["url", "label"],
                    },
                },
                {
                    "type": "function",
                    "name": "send_note",
                    "description": "Send Doc a text note (torque spec, part number, table values, recommendation, calculation) he can copy from the CHAT tab. Use for anything Doc would want to reference later or copy-paste. Tell Doc out loud you sent the note.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string", "description": "Short title for the note"},
                            "body": {"type": "string", "description": "The actual content — torque spec, part number, table, recommendation, etc. Use plain text and tab-separated grids for tables."},
                        },
                        "required": ["body"],
                    },
                },
                {
                    "type": "function",
                    "name": "set_active_vehicle",
                    "description": "Switch the active vehicle in Doc's garage by year/make/model. Use when Doc says 'switch to the Silverado' or 'work on the Camaro now' or similar.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Year, make, model, or any portion (e.g. 'silverado', '2019', 'camaro ss')"},
                        },
                        "required": ["query"],
                    },
                },
                {
                    "type": "function",
                    "name": "save_to_memory",
                    "description": "Pin a fact to long-term memory. Use when Doc says 'remember this' or shares a personal preference / shop rule / setup detail that should apply to future conversations.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "fact": {"type": "string", "description": "The fact to remember"},
                        },
                        "required": ["fact"],
                    },
                },
                {
                    "type": "function",
                    "name": "search_library",
                    "description": "Search Doc's uploaded library (PDFs, manuals, notes, datalogs) for a topic. Use when Doc asks 'what did the manual say about...' or 'check my notes on...'.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search terms"},
                        },
                        "required": ["query"],
                    },
                },
                {
                    "type": "function",
                    "name": "list_vehicles",
                    "description": "List all vehicles in Doc's garage. Use when Doc asks 'what's in the garage' / 'what trucks do I have saved'.",
                    "parameters": {"type": "object", "properties": {}},
                },
                {
                    "type": "function",
                    "name": "get_active_vehicle",
                    "description": "Get details of the currently active vehicle (year, make, model, engine, mods, notes). Useful at the start of conversation to confirm what truck Doc is working on.",
                    "parameters": {"type": "object", "properties": {}},
                },
                {
                    "type": "function",
                    "name": "update_active_vehicle",
                    "description": "Update fields on the currently active vehicle. Use when Doc says 'add a cam to its mods' or 'note that the truck has E85 in the tank'.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "mods_append": {"type": "string", "description": "Text to append to the mods field"},
                            "notes_append": {"type": "string", "description": "Text to append to the notes field"},
                            "engine": {"type": "string", "description": "Replace engine string"},
                        },
                    },
                },
                {
                    "type": "function",
                    "name": "edit_chart",
                    "description": "Apply a modification to an HP Tuners table that Doc paste-says or describes. Returns the modified grid as a note. Use when Doc says 'pull 2 degrees from 3000 to 5000 on the spark table' AFTER he pasted a table earlier in the call.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "table_text": {"type": "string", "description": "Tab-separated grid (rows x cols) Doc provided"},
                            "instruction": {"type": "string", "description": "What to change"},
                            "table_label": {"type": "string", "description": "What kind of table (spark / VE / MAF / AFR)"},
                        },
                        "required": ["table_text", "instruction"],
                    },
                },
                {
                    "type": "function",
                    "name": "lookup_credentials",
                    "description": "Look up Doc's saved login credentials for a website or service. Returns username, password, URL, and notes. Use when Doc asks 'what's my password for X', 'pull up my HP Tuners login', or 'log into X for me'. ALSO send a note to chat with the credentials so Doc can copy-paste them.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "site": {"type": "string", "description": "Site name or URL (e.g. 'HP Tuners', 'RockAuto', 'NHTSA')"},
                        },
                        "required": ["site"],
                    },
                },
            ],
            "tool_choice": "auto",
        }
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                "https://api.openai.com/v1/realtime/client_secrets",
                headers={
                    "Authorization": f"Bearer {OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
        if r.status_code != 200:
            log.error(f"Realtime client_secrets failed: {r.status_code} {r.text[:500]}")
            raise HTTPException(r.status_code, f"OpenAI: {r.text}")
        return r.json()
    except httpx.HTTPError as e:
        log.exception("Realtime session HTTP error")
        raise HTTPException(503, f"Realtime upstream error: {e}")


# ============ Register router ============
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
