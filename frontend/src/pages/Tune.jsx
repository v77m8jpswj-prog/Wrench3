import React, { useState, useRef, useEffect } from "react";
import { useApp } from "@/AppContext";
import api from "@/api";
import { useWakeLock } from "@/hooks/useWakeLock";
import { Send, Paperclip, Truck, Copy, Check, RefreshCw, ClipboardPaste, AlertTriangle } from "lucide-react";

// ───────────────────────────────────────────────────────────────────────────────
// TUNE — focused chat for Doc to do HP Tuners work.
// No forms. Just: vehicle context, message history, input box.
// Paste cells or snip anywhere → goes to Wrench → he returns locked-format
// tables with one-tap COPY back into HP Tuners.
// ───────────────────────────────────────────────────────────────────────────────

const TUNE_SESSION_KEY_PREFIX = "dw_tune_session_";

// Resize/compress an image File before upload so it doesn't hit Cloudflare's
// 100s timeout on the vision endpoint. HP Tuners screenshots come off Doc's
// phone at 8-12 MB — gpt vision takes forever on that. Resized to 1920px long
// edge / JPEG 0.82 they're usually <800 KB and the text is still readable.
async function compressImage(file) {
  // Skip if it's already small or not a still image
  if (!file || !file.type?.startsWith("image/") || file.size < 800 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const MAX = 1920;
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > MAX ? MAX / longEdge : 1;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.82));
    if (!blob) return file;
    return new File([blob], (file.name || "snip").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (e) {
    console.warn("[tune] image compress failed, sending original:", e);
    return file;
  }
}

export default function Tune() {
  const app = useApp();
  const vehicles = app?.vehicles || [];
  const activeVehicleId = app?.activeVehicleId || "";
  const activeVehicle = vehicles.find(v => v.id === activeVehicleId);

  const [session, setSession] = useState(null);
  const [showSessionSetup, setShowSessionSetup] = useState(false);
  const [osList, setOsList] = useState([]);

  const [messages, setMessages] = useState([]);
  // Session is scoped to the active vehicle so switching trucks doesn't drag
  // the prior vehicle's conversation into Wrench's context window.
  const [sessionId, setSessionId] = useState(() => {
    const vid = (typeof window !== "undefined" && window.localStorage)
      ? localStorage.getItem("dw_active_vehicle") || ""
      : "";
    return vid ? localStorage.getItem(TUNE_SESSION_KEY_PREFIX + vid) : null;
  });
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null); // {file, preview}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const fileRef = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  // Keep the screen on while Tune page is open
  useWakeLock(true);

  // Load OS list once
  useEffect(() => { api.get("/tune/os-list").then(r => setOsList(r.data || [])).catch(()=>{}); }, []);

  // Load tune session for the active vehicle AND swap the chat session_id
  // to the one cached for THIS vehicle (or null → backend creates a fresh one).
  // This is what fixes "switched vehicles and Wrench was still answering
  // from the last truck" — every vehicle now has its own chat thread.
  useEffect(() => {
    if (!activeVehicleId) { setSession(null); setMessages([]); setSessionId(null); return; }
    const cached = localStorage.getItem(TUNE_SESSION_KEY_PREFIX + activeVehicleId);
    setSessionId(cached || null);
    if (!cached) setMessages([]);
    (async () => {
      try {
        const r = await api.get(`/tune/session/${activeVehicleId}`);
        const s = r.data && Object.keys(r.data).length ? r.data : null;
        setSession(s);
        if (!s) setShowSessionSetup(true);
      } catch {/* ignore */}
    })();
  }, [activeVehicleId]);

  // Persist + restore tune chat session, keyed by the active vehicle so
  // switching trucks never bleeds prior context into Wrench.
  useEffect(() => {
    if (!activeVehicleId) return;
    const key = TUNE_SESSION_KEY_PREFIX + activeVehicleId;
    if (sessionId) {
      localStorage.setItem(key, sessionId);
      // Restore messages for this session
      api.get(`/chat/sessions/${sessionId}`).then(r => {
        const msgs = r.data?.messages || [];
        if (msgs.length) setMessages(msgs);
      }).catch(()=>{});
    } else {
      localStorage.removeItem(key);
    }
  }, [sessionId, activeVehicleId]);

  // Auto-scroll only when user is already near the bottom — and ONLY the message
  // container, not the window (scrollIntoView would yank the whole page).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 160) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, busy]);

  // Pin window to top on mount so landing on /tune doesn't auto-scroll the page
  useEffect(() => { window.scrollTo(0, 0); }, []);

  // Page-level paste: text → input, image → pending attachment (compressed)
  useEffect(() => {
    const onPaste = (e) => {
      // If user is in the textarea typing, let text paste behave normally
      const inTextarea = document.activeElement?.tagName === "TEXTAREA";
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) {
            e.preventDefault();
            compressImage(blob).then(file => {
              setPendingImage({ file, preview: URL.createObjectURL(file) });
            });
            return;
          }
        }
      }
      if (!inTextarea) {
        let text = e.clipboardData.getData("text");
        if (text) {
          // Hard cap so a runaway clipboard can't blow up the renderer
          if (text.length > 50000) text = text.slice(0, 50000) + "\n[truncated, paste was huge]";
          setInput(prev => prev ? prev + "\n" + text : text);
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const handleFile = async (file) => {
    const compressed = await compressImage(file);
    setPendingImage({ file: compressed, preview: URL.createObjectURL(compressed) });
  };

  const send = async () => {
    if (busy) return;
    if (!input.trim() && !pendingImage) return;
    if (!session?.os_family) { setShowSessionSetup(true); return; }

    setBusy(true); setErr("");
    const text = input.trim();
    const userMsgContent = text || "(snip attached)";
    const newUserMsg = { role: "user", content: userMsgContent, imagePreview: pendingImage?.preview };
    setMessages(prev => [...prev, newUserMsg]);
    setInput("");
    const imgToSend = pendingImage;
    setPendingImage(null);

    try {
      // Build the tagged tune message — backend sees [TUNE] and switches Wrench into tune mode
      const tunePrefix = `[TUNE] OS=${session.os_family} | Engine=${session.engine_code || activeVehicle?.engine || "?"} | Fuel=${session.fuel || "?"} | Goal=${session.goal || "daily"}\n`;
      const finalText = tunePrefix + (text || "Read the attached snip and walk me through what to change.");

      let resp;
      if (imgToSend?.file) {
        const fd = new FormData();
        fd.append("file", imgToSend.file);
        fd.append("message", finalText);
        fd.append("mode", "direct");
        if (sessionId) fd.append("session_id", sessionId);
        if (activeVehicleId) fd.append("vehicle_id", activeVehicleId);
        resp = await api.post("/chat/vision", fd, { timeout: 120000, headers: { "Content-Type": "multipart/form-data" }});
      } else {
        resp = await api.post("/chat", {
          message: finalText,
          mode: "direct",
          session_id: sessionId || undefined,
          vehicle_id: activeVehicleId || undefined,
        }, { timeout: 120000 });
      }

      if (resp.data?.session_id && !sessionId) setSessionId(resp.data.session_id);
      const reply = resp.data?.reply || "";
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
      setMessages(prev => [...prev, { role: "assistant", content: "Hit a snag: " + (e?.response?.data?.detail || e.message) }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const newSession = () => {
    setMessages([]); setSessionId(null); setInput(""); setPendingImage(null);
    if (activeVehicleId) localStorage.removeItem(TUNE_SESSION_KEY_PREFIX + activeVehicleId);
  };

  // ─── No active vehicle gate ────────────────────────────────────────────────────
  if (!activeVehicleId) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="heading text-2xl mb-3">TUNE <span className="text-rust">// CHAT</span></h1>
        <div className="panel p-6 text-center">
          <Truck size={32} className="mx-auto mb-3 text-rust"/>
          <div className="text-ink-2 mb-2">Pick an active vehicle first.</div>
          <div className="text-ink-3 text-xs uppercase tracking-widest">Top of any page → Active Vehicle dropdown.</div>
        </div>
      </div>
    );
  }

  // ─── Session setup (OS gate) ──────────────────────────────────────────────────
  if (showSessionSetup || !session) {
    return <SessionSetup
      vehicle={activeVehicle}
      osList={osList}
      existing={session}
      onClose={() => setShowSessionSetup(false)}
      onStart={async (payload) => {
        const r = await api.post("/tune/session", { vehicle_id: activeVehicleId, ...payload });
        setSession(r.data);
        setShowSessionSetup(false);
      }}
    />;
  }

  // ─── Main chat view ────────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col">
      {/* Top context bar — vehicle + OS, edit-session button */}
      <div className="border-b border-line bg-bg-2 px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap" data-testid="tune-context-bar">
        <div className="flex items-center gap-3 min-w-0">
          <Truck size={16} className="text-rust shrink-0"/>
          <div className="text-sm text-amber2 font-bold truncate">
            {activeVehicle?.year} {activeVehicle?.make} {activeVehicle?.model}
          </div>
          <div className="text-[11px] text-ink-3 uppercase tracking-widest">
            OS <span className="text-amber2 font-bold">{session.os_family}</span>
            {session.cal_id && <> · CAL {session.cal_id}</>}
            {session.engine_code && <> · {session.engine_code}</>}
            {session.fuel && <> · {session.fuel}</>}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={()=>setShowSessionSetup(true)} className="btn-ghost text-xs" data-testid="edit-session">EDIT</button>
          <button onClick={newSession} className="btn-ghost text-xs" data-testid="tune-new-session">+ NEW</button>
        </div>
      </div>

      {/* Pending image preview strip */}
      {pendingImage && (
        <div className="border-b border-line bg-bg-2 px-3 py-2 flex items-center gap-3" data-testid="pending-image">
          <img src={pendingImage.preview} alt="snip" className="h-14 border border-line"/>
          <div className="text-[11px] text-amber2 uppercase tracking-widest">SNIP READY — TYPE INSTRUCTION & SEND</div>
          <button onClick={()=>setPendingImage(null)} className="ml-auto btn-ghost text-[10px] !py-1 !px-2" data-testid="clear-pending-image">✕ CLEAR</button>
        </div>
      )}

      {/* Input bar — TOP (replies appear below it) */}
      <div className="border-b border-line bg-bg-2 p-3 flex items-end gap-2 sticky top-0 z-20">
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e=>e.target.files?.[0] && handleFile(e.target.files[0])} data-testid="tune-file-input"/>
        <button onClick={()=>fileRef.current?.click()} className="btn-ghost !p-3" title="Attach snip" data-testid="tune-attach">
          <Paperclip size={16}/>
        </button>
        <textarea
          ref={inputRef}
          data-testid="tune-input"
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{ if (e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); } }}
          placeholder='Type or paste a table (Ctrl+V) · attach a snip · Wrench answers in HP Tuners path + paste-ready table'
          rows={2}
          className="input-shop flex-1 resize-none text-sm py-3"
        />
        <button onClick={send} disabled={busy || (!input.trim() && !pendingImage)} className="btn-rust h-14 px-4 flex items-center gap-2" data-testid="tune-send">
          <Send size={16}/>SEND
        </button>
      </div>

      {err && <div className="px-4 py-2 border-b border-danger bg-danger/10 text-danger text-xs uppercase tracking-widest">ERR: {err}</div>}

      {/* Messages — newest first under the input */}
      <div ref={scrollRef} className="flex-1 overflow-auto" data-testid="tune-messages">
        {busy && (
          <div className="px-6 py-3 text-ink-3 text-xs uppercase tracking-widest flex items-center gap-2 border-b border-line">
            <RefreshCw size={12} className="animate-spin"/> WRENCH WORKING...
          </div>
        )}
        {messages.length === 0 ? (
          <div className="p-8 text-center text-ink-3 max-w-xl mx-auto">
            <ClipboardPaste size={28} className="mx-auto mb-3 text-rust"/>
            <div className="text-amber2 uppercase tracking-widest text-sm mb-2">SAY THE WORD, DOC.</div>
            <div className="text-sm leading-relaxed">
              Paste cells (Ctrl+V), drop a snip (Win+Shift+S), or just type what the truck is doing.
              I'll lead you through HP Tuners top → bottom and hand back paste-ready tables with a copy button.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-6 text-left">
              {[
                "Cold start stumble — fire / die / restart. Where do I start?",
                "Pinging at 4000 RPM WOT. Walk me through it.",
                "Here is my high octane spark table — bump it for 93 carefully.",
                "Want to add cooling fans on earlier. Send me the new table.",
              ].map((p,i) => (
                <button key={i} onClick={()=>{ setInput(p); inputRef.current?.focus(); }} className="border border-line p-2 hover:border-rust hover:bg-bg-2 text-xs text-ink-2 text-left" data-testid={`tune-suggest-${i}`}>
                  › {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          [...messages].reverse().map((m, i) => <Msg key={messages.length - 1 - i} m={m} idx={messages.length - 1 - i}/>)
        )}
      </div>
    </div>
  );
}

// ── Stripped markdown leak + URL render helpers (mirrors Chat.jsx) ─────────────
// Strip markdown noise — defensive against catastrophic regex backtracking on
// large tables / pastes by short-circuiting for long inputs and using non-greedy
// patterns that bail fast on overflow.
function stripMarkdown(s) {
  if (!s) return s;
  // For very long strings, skip the * cleanup entirely — VE tables and big pastes
  // contain enough numbers/symbols to trigger catastrophic backtracking. The leak
  // we're protecting against (** bolding) won't be in a 30KB paste anyway.
  if (s.length > 8000) {
    try {
      return s.replace(/^#{1,6}\s+/gm, "");
    } catch { return s; }
  }
  try {
    return s
      .replace(/\*\*\*([^*\n]+?)\*\*\*/g, "$1")
      .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
      .replace(/(^|\s)\*([^*\n]+?)\*(?=\s|[.,!?;:]|$)/g, "$1$2")
      .replace(/__([^_\n]+?)__/g, "$1")
      .replace(/^#{1,6}\s+/gm, "");
  } catch {
    return s;
  }
}

// ── Message row ────────────────────────────────────────────────────────────────
function Msg({ m, idx }) {
  const isUser = m.role === "user";
  return (
    <div className={`px-4 md:px-6 py-3 border-b border-line whitespace-pre-wrap break-words ${idx%2===0?"bg-bg-1":"bg-bg-2"}`} data-testid={`tune-msg-${idx}`}>
      <div className="text-[11px] uppercase tracking-widest font-bold mb-1">
        <span className={isUser ? "text-amber2" : "text-rust"}>[{isUser?"DOC":"WRENCH"}]</span>
      </div>
      {m.imagePreview && (
        <img src={m.imagePreview} alt="snip" className="max-h-56 border border-line bg-black/40 mb-2"/>
      )}
      <div className="text-ink text-[15px] leading-[1.65]" style={{fontFamily:"'Inter', system-ui, -apple-system, sans-serif"}}>
        {renderTuneContent(m.content)}
      </div>
    </div>
  );
}

// Render assistant text — extract fenced code blocks as one-tap COPY blocks
function renderTuneContent(text) {
  if (!text) return null;
  try {
    // Strip the leading [TUNE] tag from user messages
    text = text.replace(/^\[TUNE\][^\n]*\n?/, "");
    const out = [];
    const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g;
    let last = 0;
    let m;
    let safety = 0;
    while ((m = fenceRe.exec(text)) !== null) {
      if (++safety > 200) break; // guard against any malformed input that could loop
      if (m.index > last) out.push(<span key={`t${last}`}>{stripMarkdown(text.slice(last, m.index))}</span>);
      out.push(<CopyBlock key={`c${m.index}`} text={m[2].replace(/\n+$/, "")} lang={(m[1]||"").trim()}/>);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(<span key={`t${last}`}>{stripMarkdown(text.slice(last))}</span>);
    return out;
  } catch (e) {
    // Last-ditch: render raw text so the page never blanks
    // eslint-disable-next-line no-console
    console.warn("[Tune] renderTuneContent failed, falling back to raw text", e);
    return <span>{String(text)}</span>;
  }
}

function CopyBlock({ text, lang }) {
  const [copied, setCopied] = useState(false);
  const isTable = lang === "tsv" || /\t/.test(text);
  const copy = async (e) => {
    e.preventDefault(); e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(()=>setCopied(false), 2000);
    } catch {}
  };
  return (
    <div className="my-3 border-2 border-amber2/40 bg-bg-1" data-testid="tune-copy-block">
      <div className="flex items-center justify-between px-2 py-1 bg-amber2/10 border-b border-amber2/30 gap-2">
        <div className="text-[10px] uppercase tracking-widest text-amber2 font-bold truncate">
          {isTable ? "PASTE INTO HP TUNERS · TAB-SEPARATED" : (lang || "TEXT")}
        </div>
        <button
          onClick={copy}
          data-testid="tune-copy-table-btn"
          className={`text-[10px] uppercase tracking-widest font-bold px-3 py-1.5 flex items-center gap-1 shrink-0 ${copied ? "bg-ok text-black" : "bg-rust text-white hover:bg-rust/80"}`}
        >
          {copied ? <><Check size={11}/>COPIED</> : <><Copy size={11}/>COPY</>}
        </button>
      </div>
      <pre className="px-3 py-2 text-[12px] md:text-sm font-mono text-ink whitespace-pre overflow-x-auto leading-snug">{text}</pre>
    </div>
  );
}

// ── Session setup (OS + cal + engine + fuel + goal) ────────────────────────────
function SessionSetup({ vehicle, osList, existing, onClose, onStart }) {
  const [os, setOs] = useState(existing?.os_family || "E80");
  const [cal, setCal] = useState(existing?.cal_id || "");
  const [engine, setEngine] = useState(existing?.engine_code || vehicle?.engine_summary || vehicle?.engine || "");
  const [fuel, setFuel] = useState(existing?.fuel || "");
  const [goal, setGoal] = useState(existing?.goal || "daily");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try { await onStart({ os_family: os, cal_id: cal, engine_code: engine, fuel, goal }); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto" data-testid="tune-session-setup">
      <h1 className="heading text-2xl mb-1">TUNE <span className="text-rust">// {existing ? "EDIT SESSION" : "START SESSION"}</span></h1>
      <div className="text-xs text-ink-3 uppercase tracking-widest mb-4">
        {vehicle ? `${vehicle.year || ""} ${vehicle.make || ""} ${vehicle.model || ""}`.trim() : "VEHICLE"}
      </div>
      <div className="panel p-5 space-y-4">
        <div>
          <label className="label-shop">OS / ECM</label>
          <select value={os} onChange={e=>setOs(e.target.value)} className="input-shop" data-testid="setup-os">
            {osList.map(o => <option key={o.os} value={o.os}>{o.os} — {o.label.split("—")[1]?.trim() || o.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label-shop">CAL ID (OPTIONAL)</label>
            <input value={cal} onChange={e=>setCal(e.target.value)} className="input-shop" placeholder="12656931" data-testid="setup-cal"/>
          </div>
          <div>
            <label className="label-shop">ENGINE</label>
            <input value={engine} onChange={e=>setEngine(e.target.value)} className="input-shop" placeholder="L83, L86, LT1..." data-testid="setup-engine"/>
          </div>
          <div>
            <label className="label-shop">FUEL</label>
            <select value={fuel} onChange={e=>setFuel(e.target.value)} className="input-shop" data-testid="setup-fuel">
              <option value="">--</option>
              <option value="87">87</option>
              <option value="91">91</option>
              <option value="93">93</option>
              <option value="E85">E85</option>
              <option value="race">RACE GAS</option>
            </select>
          </div>
          <div>
            <label className="label-shop">GOAL</label>
            <select value={goal} onChange={e=>setGoal(e.target.value)} className="input-shop" data-testid="setup-goal">
              <option value="daily">DAILY</option>
              <option value="tow">TOW</option>
              <option value="street">STREET</option>
              <option value="strip">STRIP / DYNO</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={submit} disabled={busy} className="btn-rust flex-1" data-testid="setup-start">
            {busy ? "STARTING..." : (existing ? "UPDATE" : "START")}
          </button>
          {existing && <button onClick={onClose} className="btn-ghost" data-testid="setup-cancel">CANCEL</button>}
        </div>
        <div className="border-t border-line pt-3 flex items-start gap-2 text-xs text-ink-3">
          <AlertTriangle size={14} className="text-amber2 shrink-0 mt-0.5"/>
          <div>Wrench keeps the HP Tuners menu order in his head and only suggests tabs that exist on your OS. Tells you the exact path before every change.</div>
        </div>
      </div>
    </div>
  );
}
