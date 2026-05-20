import React, { useState, useRef, useEffect } from "react";
import { Mic, Send, Volume2, VolumeX, ChevronRight, Square, History } from "lucide-react";
import api, { API, getToken } from "@/api";

const setStatus = (label, color) => window.dispatchEvent(new CustomEvent("wrench-status", { detail: { label, color } }));

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [mode, setMode] = useState("direct");
  const [voiceOn, setVoiceOn] = useState(true);
  const [vehicleId, setVehicleId] = useState("");
  const [vehicles, setVehicles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [showSessions, setShowSessions] = useState(false);
  const [recording, setRecording] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recRef = useRef(null);
  const audioRef = useRef(null);
  const chunksRef = useRef([]);
  const endRef = useRef(null);

  useEffect(() => {
    api.get("/vehicles").then(r => setVehicles(r.data || [])).catch(()=>{});
    refreshSessions();
  }, []);

  const refreshSessions = () => api.get("/chat/sessions").then(r => setSessions(r.data || [])).catch(()=>{});

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, thinking]);

  const loadSession = async (sid) => {
    const r = await api.get(`/chat/sessions/${sid}`);
    setSessionId(sid);
    setMessages((r.data.messages || []).map(m => ({ role: m.role, content: m.content })));
    setShowSessions(false);
  };

  const newSession = () => { setSessionId(null); setMessages([]); };

  const send = async (text) => {
    const t = (text ?? input).trim();
    if (!t) return;
    setInput("");
    setMessages(m => [...m, { role: "user", content: t }]);
    setThinking(true); setStatus("THINKING", "#FF5722");
    try {
      const r = await api.post("/chat", { message: t, session_id: sessionId, mode, vehicle_id: vehicleId || null });
      setSessionId(r.data.session_id);
      const reply = r.data.reply || "";
      setMessages(m => [...m, { role: "assistant", content: reply, citations: r.data.citations, heat: r.data.heat_detected }]);
      refreshSessions();
      if (voiceOn) await speak(reply);
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", content: `[ ERROR ] ${e?.response?.data?.detail || e.message}` }]);
    } finally { setThinking(false); setStatus("IDLE", "#52525B"); }
  };

  const speak = async (text) => {
    try {
      setSpeaking(true); setStatus("SPEAKING", "#FFC107");
      const res = await fetch(`${API}/voice/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ text, voice: "onyx" }),
      });
      if (!res.ok) throw new Error("tts failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) { audioRef.current.pause(); }
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => { setSpeaking(false); setStatus("IDLE", "#52525B"); };
      a.onerror = () => { setSpeaking(false); setStatus("IDLE", "#52525B"); };
      await a.play();
    } catch {
      setSpeaking(false); setStatus("IDLE", "#52525B");
    }
  };

  const stopSpeak = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setSpeaking(false); setStatus("IDLE", "#52525B");
  };

  const startRecord = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setStatus("THINKING", "#FF5722");
        const fd = new FormData();
        fd.append("audio", blob, "rec.webm");
        try {
          const r = await fetch(`${API}/voice/transcribe`, {
            method: "POST",
            headers: { Authorization: `Bearer ${getToken()}` },
            body: fd,
          });
          const j = await r.json();
          if (j.text) send(j.text);
          else setStatus("IDLE", "#52525B");
        } catch {
          setStatus("IDLE", "#52525B");
        }
      };
      mr.start();
      recRef.current = mr;
      setRecording(true);
      setStatus("LISTENING", "#FF5722");
    } catch (e) {
      alert("Mic blocked: " + e.message);
    }
  };

  const stopRecord = () => {
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    setRecording(false);
  };

  const toggleRecord = () => recording ? stopRecord() : startRecord();

  return (
    <div className="flex h-full" style={{height:"calc(100vh - 36px)"}}>
      {/* main column */}
      <div className="flex-1 flex flex-col">
        {/* header */}
        <div className="border-b border-line px-6 py-3 flex items-center justify-between bg-bg-2" data-testid="chat-header">
          <div className="flex items-center gap-3">
            <h1 className="heading text-2xl">CHAT // <span className="text-rust">WRENCH</span></h1>
            <span className="text-ink-3 text-xs">{sessionId ? `SID: ${sessionId.slice(0,8)}` : "NEW SESSION"}</span>
          </div>
          <div className="flex items-center gap-2">
            <select data-testid="vehicle-select" value={vehicleId} onChange={e=>setVehicleId(e.target.value)} className="input-shop text-xs py-1" style={{width:"auto"}}>
              <option value="">-- NO VEHICLE --</option>
              {vehicles.map(v => <option key={v.id} value={v.id}>{`${v.year} ${v.make} ${v.model}`.trim() || v.id.slice(0,6)}</option>)}
            </select>
            <button data-testid="mode-toggle" onClick={()=>setMode(mode==="direct"?"dream":"direct")} className="btn-ghost text-xs">
              MODE: <span className={mode==="direct"?"text-rust":"text-amber2"}>{mode === "direct" ? "DIRECT" : "DREAM"}</span>
            </button>
            <button data-testid="voice-toggle" onClick={()=>setVoiceOn(v=>!v)} className="btn-ghost text-xs flex items-center gap-2">
              {voiceOn ? <Volume2 size={14}/> : <VolumeX size={14}/>}
              {voiceOn ? "VOICE ON" : "VOICE OFF"}
            </button>
            <button data-testid="sessions-toggle" onClick={()=>setShowSessions(s=>!s)} className="btn-ghost text-xs flex items-center gap-2"><History size={14}/>HISTORY</button>
            <button data-testid="new-session" onClick={newSession} className="btn-ghost text-xs">+ NEW</button>
          </div>
        </div>

        {/* messages */}
        <div className="flex-1 overflow-auto" data-testid="messages-area">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center px-6 text-center">
              <VoiceButton recording={recording} thinking={thinking} speaking={speaking} onClick={toggleRecord} onStopSpeak={stopSpeak} />
              <div className="mt-8 max-w-xl">
                <div className="heading text-3xl mb-2">SAY THE WORD, DOC.</div>
                <p className="text-ink-2 text-sm leading-relaxed">
                  Hit the mic and talk, or type below. Ask about a tune, drop a datalog,
                  paste a table. I'll cite my sources when I'm pulling from your library.
                </p>
                <div className="mt-6 grid grid-cols-2 gap-2 text-left">
                  {[
                    "Truck pings under WOT at 4000 RPM. Where do I start?",
                    "Smooth my VE table — I'll paste it next.",
                    "Knock retard on cyl 6, log incoming.",
                    "What's the torque spec on a GM LS rocker arm bolt?",
                  ].map((s,i) => (
                    <button key={i} data-testid={`suggest-${i}`} onClick={()=>send(s)} className="text-left text-xs text-ink-2 hover:text-white border border-line p-3 hover:border-rust transition-colors">
                      <ChevronRight size={12} className="inline text-rust mr-1"/>{s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {messages.length > 0 && (
            <div className="font-mono text-sm">
              {messages.map((m, i) => (
                <MessageRow key={i} m={m} idx={i} />
              ))}
              {thinking && (
                <div className="px-6 py-3 border-b border-line bg-bg-1 text-rust" data-testid="thinking-row">
                  [WRENCH] <span className="animate-blink">_</span> thinking
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* input bar */}
        <div className="border-t border-line bg-bg-2 px-6 py-4">
          <div className="flex items-end gap-3">
            <button
              data-testid="mic-button"
              onClick={toggleRecord}
              className={`w-14 h-14 border-2 ${recording ? "border-rust bg-rust/10 animate-pulseRust" : "border-rust"} text-rust hover:bg-rust hover:text-black transition-colors flex items-center justify-center flex-shrink-0`}>
              {recording ? <Square size={20} fill="currentColor"/> : <Mic size={22}/>}
            </button>
            <textarea
              data-testid="chat-input"
              value={input}
              onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>{ if (e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); } }}
              rows={2}
              placeholder={recording ? "LISTENING..." : "TYPE OR HIT MIC. ENTER TO SEND."}
              className="input-shop flex-1 resize-none"
            />
            <button data-testid="send-btn" onClick={()=>send()} className="btn-rust h-14 flex items-center gap-2"><Send size={16}/>SEND</button>
          </div>
          <div className="mt-2 text-[10px] text-ink-3 uppercase tracking-[0.2em] flex justify-between">
            <span>{recording ? "● RECORDING — click mic to stop" : speaking ? "● SPEAKING — click to halt" : "READY"}</span>
            {speaking && <button onClick={stopSpeak} className="text-rust hover:text-white">HALT VOICE</button>}
          </div>
        </div>
      </div>

      {/* sessions drawer */}
      {showSessions && (
        <aside className="w-72 border-l border-line bg-bg-2 overflow-auto" data-testid="sessions-drawer">
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <span className="heading text-sm">HISTORY</span>
            <button onClick={()=>setShowSessions(false)} className="text-ink-3 hover:text-rust">×</button>
          </div>
          {sessions.length === 0 && <div className="p-4 text-ink-3 text-xs">No sessions yet.</div>}
          {sessions.map(s => (
            <button key={s.id} data-testid={`session-${s.id}`} onClick={()=>loadSession(s.id)} className={`w-full text-left px-4 py-3 border-b border-line hover:bg-bg-3 ${sessionId===s.id?"bg-bg-3 border-l-2 border-l-rust":""}`}>
              <div className="text-xs font-bold truncate">{s.title || s.id.slice(0,8)}</div>
              <div className="text-[10px] text-ink-3 truncate mt-1">{s.preview}</div>
            </button>
          ))}
        </aside>
      )}
    </div>
  );
}

function VoiceButton({ recording, thinking, speaking, onClick, onStopSpeak }) {
  const active = recording || speaking;
  return (
    <div className="relative">
      <button
        onClick={recording ? onClick : speaking ? onStopSpeak : onClick}
        data-testid="big-voice-button"
        className={`w-40 h-40 border-2 ${active?"border-rust":"border-rust/60"} ${recording?"bg-rust/10 animate-pulseRust":""} flex items-center justify-center text-rust hover:bg-rust hover:text-black transition-colors`}>
        {speaking ? <WaveBars/> : recording ? <Square size={36} fill="currentColor"/> : <Mic size={48} strokeWidth={1.5}/>}
      </button>
      <div className="absolute -bottom-6 left-0 right-0 text-center text-[10px] uppercase tracking-[0.3em] text-ink-2">
        {recording ? "LISTENING" : speaking ? "SPEAKING (CLICK TO HALT)" : "PUSH TO TALK"}
      </div>
    </div>
  );
}

function WaveBars() {
  return (
    <div className="flex items-end gap-1 h-12">
      {[0,1,2,3,4,5,6].map(i => (
        <div key={i} className="w-2 bg-rust origin-bottom animate-bar" style={{ height: 40, animationDelay: `${i*70}ms` }}/>
      ))}
    </div>
  );
}

function MessageRow({ m, idx }) {
  const isUser = m.role === "user";
  return (
    <div className={`px-6 py-3 border-b border-line whitespace-pre-wrap break-words ${idx%2===0?"bg-bg-1":"bg-bg-2"}`} data-testid={`msg-${idx}`}>
      <div className="flex items-baseline gap-3">
        <span className={`font-head text-xs uppercase tracking-widest font-bold ${isUser?"text-amber2":"text-rust"}`}>
          [{isUser?"TECH":"WRENCH"}]
        </span>
        {m.heat && <span className="text-[10px] text-danger uppercase tracking-widest border border-danger px-1">HEAT</span>}
        <span className="flex-1 text-ink leading-relaxed">{m.content}</span>
      </div>
      {m.citations && m.citations.length > 0 && (
        <div className="mt-2 ml-16 text-[11px] text-ink-3 border-l-2 border-line pl-3">
          <div className="uppercase tracking-widest text-amber2 mb-1">SOURCES</div>
          {m.citations.map((c,i)=>(<div key={i} className="mb-1">› {c.source}: <span className="text-ink-2">{c.snippet}</span></div>))}
        </div>
      )}
    </div>
  );
}
