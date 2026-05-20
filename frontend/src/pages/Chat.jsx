import React, { useState, useRef, useEffect } from "react";
import { Mic, Send, Volume2, VolumeX, ChevronRight, Square, History, Settings2, X, Paperclip } from "lucide-react";
import api, { API, getToken } from "@/api";
import { useApp } from "@/AppContext";

const setStatus = (label, color) => window.dispatchEvent(new CustomEvent("wrench-status", { detail: { label, color } }));

export default function Chat() {
  const app = useApp();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(() => localStorage.getItem("dw_chat_session") || null);
  const [mode, setMode] = useState("direct");
  const [voiceOn, setVoiceOn] = useState(true);
  const [vehicleId, setVehicleId] = useState(app?.activeVehicleId || "");
  const [vehicles, setVehicles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [showSessions, setShowSessions] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [copiedNoteId, setCopiedNoteId] = useState("");

  // Mark artifacts as seen when chat opens
  useEffect(() => {
    if (app?.callArtifacts?.some(a => !a.seen)) app.markArtifactsSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyNote = async (id, body) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedNoteId(id);
      setTimeout(()=>setCopiedNoteId(""), 1500);
    } catch {}
  };
  const [recording, setRecording] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [callMode, setCallMode] = useState(false);
  const callModeRef = useRef(false);
  const [micError, setMicError] = useState("");
  const [showMicHelp, setShowMicHelp] = useState(false);
  const recRef = useRef(null);
  const audioRef = useRef(null);
  const chunksRef = useRef([]);
  const endRef = useRef(null);
  const streamRef = useRef(null);
  const inputRef = useRef(null);
  const speechRecRef = useRef(null);
  const audioElRef = useRef(null);
  const audioUnlockedRef = useRef(false);

  // Unlock iOS audio playback — must be called inside a user gesture
  const unlockAudio = () => {
    if (audioUnlockedRef.current) return;
    try {
      const el = audioElRef.current;
      if (!el) return;
      el.muted = true;
      const p = el.play();
      if (p && p.then) {
        p.then(() => { el.pause(); el.currentTime = 0; el.muted = false; audioUnlockedRef.current = true; })
         .catch(() => { /* will retry on next gesture */ });
      } else {
        el.pause(); el.muted = false; audioUnlockedRef.current = true;
      }
    } catch {}
  };

  // Detect Web Speech API (Safari/Chrome both support webkit prefix on iOS)
  const SR = (typeof window !== "undefined") && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasNativeSpeech = !!SR;

  useEffect(() => {
    api.get("/vehicles").then(r => setVehicles(r.data || [])).catch(()=>{});
    refreshSessions();
    setTimeout(() => inputRef.current?.focus(), 300);
  }, []);

  // Sync vehicle with global active vehicle
  useEffect(() => {
    if (app?.activeVehicleId) setVehicleId(app.activeVehicleId);
  }, [app?.activeVehicleId]);

  // Persist session id + restore messages on mount
  useEffect(() => {
    if (sessionId) {
      localStorage.setItem("dw_chat_session", sessionId);
      // load messages if we don't have them yet
      if (messages.length === 0) {
        api.get(`/chat/sessions/${sessionId}`).then(r => {
          setMessages((r.data.messages || []).map(m => ({ role: m.role, content: m.content })));
        }).catch(()=>{ localStorage.removeItem("dw_chat_session"); setSessionId(null); });
      }
    } else {
      localStorage.removeItem("dw_chat_session");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const refreshSessions = () => api.get("/chat/sessions").then(r => setSessions(r.data || [])).catch(()=>{});

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, thinking]);

  const loadSession = async (sid) => {
    const r = await api.get(`/chat/sessions/${sid}`);
    setSessionId(sid);
    setMessages((r.data.messages || []).map(m => ({ role: m.role, content: m.content })));
    setShowSessions(false);
  };

  const newSession = () => { setSessionId(null); setMessages([]); setShowOptions(false); };

  const send = async (text, attachmentNote) => {
    unlockAudio();
    const t = (text ?? input).trim();
    const note = attachmentNote || "";
    const finalText = t + (note ? (t ? "\n\n" : "") + note : "");
    if (!finalText) return;
    setInput("");
    setMessages(m => [...m, { role: "user", content: finalText }]);
    setThinking(true); setStatus("THINKING", "#FF5722");
    try {
      const r = await api.post("/chat", { message: finalText, session_id: sessionId, mode, vehicle_id: vehicleId || null });
      setSessionId(r.data.session_id);
      const reply = r.data.reply || "";
      setMessages(m => [...m, { role: "assistant", content: reply, citations: r.data.citations, heat: r.data.heat_detected }]);
      refreshSessions();
      if (voiceOn || callModeRef.current) await speak(reply);
      else if (callModeRef.current) {
        setTimeout(() => callModeRef.current && startNativeSpeech(), 400);
      }
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", content: `[ ERROR ] ${e?.response?.data?.detail || e.message}` }]);
      if (callModeRef.current) setTimeout(() => callModeRef.current && startNativeSpeech(), 800);
    } finally { setThinking(false); if (!callModeRef.current) setStatus("IDLE", "#52525B"); }
  };

  const attachRef = useRef(null);
  const onAttach = async (file) => {
    if (!file) return;
    const isImage = (file.type || "").startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(file.name || "");
    if (isImage) {
      return onAttachImage(file);
    }
    try {
      // Upload to library which auto-extracts content for the AI to reference
      const fd = new FormData();
      fd.append("file", file);
      const r = await api.post("/library/upload", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 120000 });
      const item = r.data;
      const note = `[ATTACHED FILE → ${item.name} · ${item.kind.toUpperCase()} · ${item.chunk_count} chunks indexed. Wrench can now reference it.]`;
      // If empty input, just send a note saying it's attached. Otherwise let user keep typing.
      if (!input.trim()) send("", note);
      else setMessages(m => [...m, { role: "system", content: note }]);
    } catch (e) {
      alert("Attach failed: " + (e?.response?.data?.detail || e.message));
    }
  };

  const onAttachImage = async (file) => {
    // Show the snip immediately in the transcript so Doc sees it land
    const previewUrl = URL.createObjectURL(file);
    const userText = input.trim();
    setInput("");
    setMessages(m => [...m, { role: "user", content: userText, imageUrl: previewUrl, imageName: file.name }]);
    setThinking(true); setStatus("READING SNIP", "#FF5722");
    try {
      const fd = new FormData();
      fd.append("image", file);
      fd.append("message", userText);
      if (sessionId) fd.append("session_id", sessionId);
      fd.append("mode", mode);
      if (vehicleId) fd.append("vehicle_id", vehicleId);
      const r = await api.post("/chat/vision", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 120000 });
      setSessionId(r.data.session_id);
      const reply = r.data.reply || "";
      setMessages(m => [...m, { role: "assistant", content: reply, citations: r.data.citations, heat: r.data.heat_detected }]);
      refreshSessions();
      if (voiceOn || callModeRef.current) await speak(reply);
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", content: `[ ERROR reading snip ] ${e?.response?.data?.detail || e.message}` }]);
    } finally { setThinking(false); if (!callModeRef.current) setStatus("IDLE", "#52525B"); }
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
      const el = audioElRef.current;
      if (!el) { setSpeaking(false); setStatus("IDLE", "#52525B"); return; }
      try { el.pause(); el.currentTime = 0; } catch {}
      el.src = url;
      el.onended = () => {
        setSpeaking(false);
        setStatus(callModeRef.current ? "LISTENING" : "IDLE", callModeRef.current ? "#FF5722" : "#52525B");
        // In call mode, automatically re-open mic after Wrench finishes
        if (callModeRef.current) {
          setTimeout(() => { if (callModeRef.current) startNativeSpeech(); }, 250);
        }
      };
      el.onerror = () => {
        setSpeaking(false);
        setStatus(callModeRef.current ? "LISTENING" : "IDLE", callModeRef.current ? "#FF5722" : "#52525B");
        if (callModeRef.current) {
          setTimeout(() => { if (callModeRef.current) startNativeSpeech(); }, 250);
        }
      };
      try {
        await el.play();
      } catch (e) {
        setSpeaking(false); setStatus("TAP TO HEAR", "#FFC107");
      }
    } catch {
      setSpeaking(false); setStatus("IDLE", "#52525B");
    }
  };

  const playLast = () => {
    const el = audioElRef.current;
    if (el && el.src) {
      try { el.play(); setSpeaking(true); setStatus("SPEAKING", "#FFC107"); } catch {}
    }
  };

  const stopSpeak = () => {
    const el = audioElRef.current;
    if (el) { try { el.pause(); } catch {} }
    setSpeaking(false); setStatus("IDLE", "#52525B");
  };

  const pickMime = () => {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/mpeg"];
    if (typeof MediaRecorder === "undefined") return null;
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return ""; // let browser pick
  };

  const startRecord = () => {
    unlockAudio();
    // Reset error state
    setMicError(""); setShowMicHelp(false);

    // Primary path: native Web Speech API (Safari/Chrome on iOS, Chrome on desktop/Android)
    // This is dramatically more reliable on iOS than MediaRecorder+Whisper
    if (hasNativeSpeech) {
      return startNativeSpeech();
    }
    // Fallback: MediaRecorder + server-side Whisper
    return startMediaRecorder();
  };

  const startNativeSpeech = () => {
    try {
      const rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;

      let finalText = "";
      rec.onstart = () => {
        setRecording(true);
        setStatus("LISTENING", "#FF5722");
      };
      rec.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        // Show live interim text in the input box
        setInput((finalText + interim).trim());
      };
      rec.onerror = (e) => {
        setRecording(false);
        if (!callModeRef.current) setStatus("IDLE", "#52525B");
        const err = e?.error || "unknown";
        if (err === "not-allowed" || err === "service-not-allowed" || err === "permission-denied") {
          callModeRef.current = false; setCallMode(false);
          setMicError("Mic permission denied by browser.");
          setShowMicHelp(true);
        } else if (err === "no-speech") {
          // in call mode, just restart silently
          if (callModeRef.current) {
            setTimeout(() => { if (callModeRef.current) startNativeSpeech(); }, 300);
          } else {
            setMicError("Didn't catch anything — try again.");
          }
        } else if (err === "audio-capture") {
          callModeRef.current = false; setCallMode(false);
          setMicError("Can't capture audio. Plug in headphones or check your mic.");
        } else if (err === "aborted") {
          // user cancelled — no error
        } else {
          setMicError(`Voice error: ${err}`);
        }
      };
      rec.onend = () => {
        setRecording(false);
        const text = finalText.trim();
        if (text) {
          setInput("");
          send(text);
        } else if (callModeRef.current && !thinking && !speaking) {
          // no speech detected, restart listening if we're still on the call
          setStatus("LISTENING", "#FF5722");
          setTimeout(() => { if (callModeRef.current) startNativeSpeech(); }, 300);
        } else if (!callModeRef.current) {
          setStatus("IDLE", "#52525B");
        }
      };

      speechRecRef.current = rec;
      rec.start();
    } catch (e) {
      setMicError(`Voice failed to start: ${e?.message || e?.name || "unknown"}`);
      setShowMicHelp(true);
      setRecording(false);
    }
  };

  const startMediaRecorder = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicError("This browser can't access the mic.");
      setShowMicHelp(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const opts = mime ? { mimeType: mime } : {};
      let mr;
      try { mr = new MediaRecorder(stream, opts); }
      catch { mr = new MediaRecorder(stream); }

      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        if (blob.size < 800) { setStatus("IDLE", "#52525B"); setMicError("Too short / silent. Hold and talk longer."); return; }
        setStatus("THINKING", "#FF5722");
        const ext = (mr.mimeType || "").includes("mp4") ? "m4a" : (mr.mimeType || "").includes("mpeg") ? "mp3" : "webm";
        const fd = new FormData();
        fd.append("audio", blob, `rec.${ext}`);
        try {
          const r = await fetch(`${API}/voice/transcribe`, {
            method: "POST",
            headers: { Authorization: `Bearer ${getToken()}` },
            body: fd,
          });
          const j = await r.json();
          if (j.text && j.text.trim()) send(j.text);
          else { setStatus("IDLE", "#52525B"); setMicError("Didn't catch that — try again."); }
        } catch (e) {
          setStatus("IDLE", "#52525B"); setMicError("Transcription failed.");
        }
      };
      mr.start();
      recRef.current = mr;
      setRecording(true);
      setStatus("LISTENING", "#FF5722");
    } catch (e) {
      const msg = (e && e.name) || "";
      const detail = e?.message || msg || "unknown";
      if (msg === "NotAllowedError" || msg === "PermissionDeniedError") {
        setMicError(`Mic BLOCKED [${msg}]`);
        setShowMicHelp(true);
      } else if (msg === "NotFoundError") {
        setMicError(`No mic found [${msg}]`);
      } else {
        setMicError(`Mic error [${msg || "unknown"}]: ${detail}`);
        setShowMicHelp(true);
      }
    }
  };

  const stopRecord = () => {
    // Stop native speech recognition if active
    if (speechRecRef.current) {
      try { speechRecRef.current.stop(); } catch {}
      speechRecRef.current = null;
    }
    // Stop MediaRecorder if active
    try {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    } catch {}
    setRecording(false);
  };

  const toggleRecord = () => recording ? stopRecord() : startRecord();

  const startCall = () => {
    unlockAudio();
    callModeRef.current = true;
    setCallMode(true);
    setVoiceOn(true);
    setMicError(""); setShowMicHelp(false);
    // immediately open the mic
    if (!recording) startNativeSpeech();
  };

  const endCall = () => {
    callModeRef.current = false;
    setCallMode(false);
    // stop any active recognition
    try { speechRecRef.current && speechRecRef.current.stop(); } catch {}
    // stop any speaking
    try { const el = audioElRef.current; if (el) el.pause(); } catch {}
    setRecording(false); setSpeaking(false);
    setStatus("IDLE", "#52525B");
  };

  const toggleCall = () => callMode ? endCall() : startCall();

  const [dragOver, setDragOver] = useState(false);

  // Paste-from-clipboard support — Doc can screenshot and Cmd-V directly into chat
  useEffect(() => {
    const onPaste = (e) => {
      if (!e.clipboardData) return;
      for (const item of e.clipboardData.items) {
        if (item.kind === "file" && (item.type || "").startsWith("image/")) {
          const f = item.getAsFile();
          if (f) { e.preventDefault(); onAttachImage(f); return; }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, mode, vehicleId, input]);

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) onAttach(f);
  };

  return (
    <div
      className="flex h-full flex-col relative"
      style={{minHeight:"calc(100dvh - 90px)"}}
      onDragOver={e=>{ e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={e=>{ if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 z-40 border-4 border-dashed border-rust bg-black/70 flex items-center justify-center pointer-events-none">
          <div className="text-rust heading text-2xl md:text-3xl text-center px-6">
            DROP THE SNIP<br/><span className="text-amber2 text-base">Wrench will read it</span>
          </div>
        </div>
      )}
      {/* Hidden audio element for TTS playback — must be in DOM for iOS to allow play() */}
      <audio ref={audioElRef} playsInline preload="auto" data-testid="tts-audio" />
      {/* Desktop-only header */}
      <div className="hidden md:flex border-b border-line px-6 py-3 items-center justify-between bg-bg-2" data-testid="chat-header">
        <div className="flex items-center gap-3">
          <h1 className="heading text-2xl">CHAT // <span className="text-rust">WRENCH</span></h1>
          <span className="text-ink-3 text-xs">{sessionId ? `SID: ${sessionId.slice(0,8)}` : "NEW SESSION"}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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

      {/* Mobile chat header strip */}
      <div className="md:hidden px-3 py-2 border-b border-line bg-bg-2 flex items-center justify-between gap-2">
        <button onClick={()=>setVoiceOn(v=>!v)} data-testid="m-voice-toggle" className={`flex items-center gap-1 text-[11px] uppercase tracking-widest border px-2 py-1 ${voiceOn?"border-rust text-rust":"border-line text-ink-2"}`}>
          {voiceOn ? <Volume2 size={12}/> : <VolumeX size={12}/>} {voiceOn ? "VOICE" : "MUTE"}
        </button>
        <button onClick={()=>setMode(mode==="direct"?"dream":"direct")} data-testid="m-mode" className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-ink-2">
          <span className={mode==="direct"?"text-rust":"text-amber2"}>{mode.toUpperCase()}</span>
        </button>
        <button data-testid="m-history" onClick={()=>setShowSessions(true)} className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-ink-2 flex items-center gap-1"><History size={12}/>HX</button>
        <button data-testid="m-new" onClick={newSession} className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-ink-2">+ NEW</button>
        <button data-testid="m-options" onClick={()=>setShowOptions(true)} className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-ink-2 flex items-center gap-1"><Settings2 size={12}/></button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto" data-testid="messages-area">
        {/* Call artifacts panel — links/notes/vehicles Wrench sent during a call */}
        {app?.callArtifacts && app.callArtifacts.length > 0 && (
          <div className="border-b border-line bg-bg-3 px-3 md:px-6 py-3" data-testid="artifacts-panel">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] uppercase tracking-widest text-amber2 font-bold">
                FROM WRENCH ({app.callArtifacts.length})
              </span>
              <button onClick={()=>app.clearAllArtifacts()} className="text-[10px] text-ink-3 hover:text-rust uppercase tracking-widest">CLEAR ALL</button>
            </div>
            <div className="space-y-2 max-h-[280px] overflow-auto">
              {app.callArtifacts.map(a => (
                <div key={a.id} className="border border-line bg-bg-1 p-2 flex items-start gap-2" data-testid={`artifact-${a.id}`}>
                  {a.type === "link" && (
                    <>
                      <span className="text-rust text-xs uppercase tracking-widest font-bold w-14 flex-shrink-0 mt-0.5">LINK</span>
                      <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-amber2 underline break-all flex-1 text-sm">
                        {a.label} <span className="text-ink-3 text-[11px]">→ {a.url}</span>
                      </a>
                    </>
                  )}
                  {a.type === "note" && (
                    <>
                      <span className="text-rust text-xs uppercase tracking-widest font-bold w-14 flex-shrink-0 mt-0.5">NOTE</span>
                      <div className="flex-1 min-w-0">
                        {a.title && <div className="font-bold text-sm">{a.title}</div>}
                        <pre className="text-xs text-ink whitespace-pre-wrap font-mono break-words">{a.body}</pre>
                      </div>
                      <button onClick={()=>copyNote(a.id, a.body)} className={`btn-ghost text-xs px-2 py-1 flex-shrink-0 ${copiedNoteId===a.id?"!border-ok !text-ok":""}`}>
                        {copiedNoteId === a.id ? "COPIED" : "COPY"}
                      </button>
                    </>
                  )}
                  {a.type === "vehicle" && (
                    <>
                      <span className="text-rust text-xs uppercase tracking-widest font-bold w-14 flex-shrink-0 mt-0.5">VEHICLE</span>
                      <div className="flex-1">
                        <div className="text-sm font-bold">{a.label}</div>
                        {a.vin && <div className="text-[10px] text-ink-3 font-mono">VIN: {a.vin}</div>}
                      </div>
                      <button onClick={()=>app.setActiveVehicleId(a.vehicle_id)} className="btn-ghost text-xs px-2 py-1 flex-shrink-0">SET ACTIVE</button>
                    </>
                  )}
                  <button onClick={()=>app.clearArtifact(a.id)} className="text-ink-3 hover:text-danger ml-1 flex-shrink-0"><X size={14}/></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {messages.length === 0 ? (
          <div className="min-h-full flex flex-col items-center justify-center px-4 py-6 text-center">
            <VoiceButton callMode={callMode} recording={recording} thinking={thinking} speaking={speaking} onClick={toggleCall} />
            {micError && (
              <MicHelpPanel error={micError} expanded={showMicHelp} onToggle={()=>setShowMicHelp(s=>!s)} onRetry={startRecord} />
            )}
            <div className="mt-10 max-w-xl">
              <div className="heading text-2xl md:text-3xl mb-2">SAY THE WORD, DOC.</div>
              <p className="text-ink-2 text-xs md:text-sm leading-relaxed px-2">
                <span className="text-rust font-bold">TAP TALK</span> for a back-and-forth voice call.
                Or type below if your hands are full.
              </p>
              <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-2 text-left">
                {[
                  "Truck pings under WOT at 4000 RPM. Where do I start?",
                  "Smooth my VE table — I'll paste it next.",
                  "Knock retard on cyl 6, log incoming.",
                  "Torque spec on a GM LS rocker arm bolt?",
                ].map((s,i) => (
                  <button key={i} data-testid={`suggest-${i}`} onClick={()=>send(s)} className="text-left text-xs text-ink-2 hover:text-white border border-line p-3 hover:border-rust transition-colors">
                    <ChevronRight size={12} className="inline text-rust mr-1"/>{s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="font-mono text-sm pb-4">
            {messages.map((m, i) => <MessageRow key={i} m={m} idx={i} />)}
            {thinking && (
              <div className="px-4 md:px-6 py-3 border-b border-line bg-bg-1 text-rust text-xs" data-testid="thinking-row">
                [WRENCH] <span className="animate-blink">_</span> thinking
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* Bottom input bar */}
      <div className="border-t border-line bg-bg-2 px-3 md:px-6 py-3 md:py-4 sticky bottom-0 z-20">
        {micError && messages.length > 0 && (
          <MicHelpPanel error={micError} expanded={showMicHelp} onToggle={()=>setShowMicHelp(s=>!s)} onRetry={startRecord} compact />
        )}
        <div className="flex items-end gap-2 md:gap-3">
          <button
            data-testid="mic-button"
            onClick={toggleCall}
            aria-label={callMode ? "End call" : "Start voice call"}
            className={`w-14 h-14 border-2 ${callMode ? "border-rust bg-rust text-black animate-pulseRust" : recording ? "border-rust bg-rust/10 animate-pulseRust text-rust" : "border-rust text-rust"} active:bg-rust active:text-black flex items-center justify-center flex-shrink-0`}>
            {callMode ? <Square size={20} fill="currentColor"/> : <Mic size={22}/>}
          </button>
          <button
            data-testid="attach-button"
            onClick={()=>attachRef.current?.click()}
            aria-label="Attach file"
            className="w-14 h-14 border-2 border-line text-ink-2 hover:border-rust hover:text-rust active:bg-rust/10 flex items-center justify-center flex-shrink-0"
            title="Drop a schematic snip, photo, scope/dash pic, PDF manual, CSV log, or .hpt tune — Wrench will read it"
          >
            <Paperclip size={22}/>
          </button>
          <input ref={attachRef} type="file" hidden accept="image/*,.pdf,.txt,.md,.csv,.log,.hpt,.hpl,.bin,.tune" onChange={e=>{ const f = e.target.files?.[0]; if (f) onAttach(f); e.target.value=""; }} data-testid="attach-input"/>
          <textarea
            ref={inputRef}
            data-testid="chat-input"
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if (e.key==="Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey){ e.preventDefault(); send(); } }}
            rows={1}
            placeholder={recording ? "LISTENING..." : "TYPE HERE → HIT SEND"}
            className="input-shop flex-1 resize-none text-sm py-3"
            style={{minHeight:"56px"}}
            autoFocus
          />
          <button data-testid="send-btn" onClick={()=>send()} aria-label="Send" className="btn-rust h-14 px-3 md:px-5 flex items-center gap-1.5">
            <Send size={16}/><span className="hidden sm:inline">SEND</span>
          </button>
        </div>
        <div className="mt-1.5 text-[10px] text-ink-3 uppercase tracking-[0.15em] flex justify-between items-center">
          <span>{callMode ? "● ON CALL — TAP MIC TO END" : recording ? "● RECORDING — tap mic to stop" : speaking ? "● WRENCH IS TALKING" : "READY"}</span>
          <div className="flex items-center gap-3">
            {speaking && (
              <button
                onClick={stopSpeak}
                data-testid="halt-tts"
                className="bg-amber2 text-black uppercase tracking-widest font-bold text-[11px] px-3 py-1.5 hover:bg-rust hover:text-white"
              >
                ✋ SHUT UP
              </button>
            )}
            {audioElRef.current && audioElRef.current.src && !speaking && !callMode && (
              <button onClick={playLast} className="text-amber2 hover:text-rust" data-testid="replay-voice">▶ HEAR LAST</button>
            )}
          </div>
        </div>
      </div>

      {/* Sessions drawer (mobile/desktop full-screen) */}
      {showSessions && (
        <div className="fixed inset-0 z-40 flex" data-testid="sessions-drawer">
          <div className="flex-1 bg-black/60" onClick={()=>setShowSessions(false)} />
          <aside className="w-[85%] max-w-sm bg-bg-2 border-l border-line overflow-auto">
            <div className="px-4 py-3 border-b border-line flex items-center justify-between sticky top-0 bg-bg-2">
              <span className="heading text-lg">HISTORY</span>
              <button onClick={()=>setShowSessions(false)} data-testid="close-sessions" className="text-ink-2 p-1"><X size={20}/></button>
            </div>
            {sessions.length === 0 && <div className="p-4 text-ink-3 text-xs">No sessions yet.</div>}
            {sessions.map(s => (
              <button key={s.id} data-testid={`session-${s.id}`} onClick={()=>loadSession(s.id)} className={`w-full text-left px-4 py-3 border-b border-line ${sessionId===s.id?"bg-bg-3 border-l-2 border-l-rust":""}`}>
                <div className="text-xs font-bold truncate">{s.title || s.id.slice(0,8)}</div>
                <div className="text-[10px] text-ink-3 truncate mt-1">{s.preview}</div>
              </button>
            ))}
          </aside>
        </div>
      )}

      {/* Mobile options sheet */}
      {showOptions && (
        <div className="md:hidden fixed inset-0 z-40 flex items-end" data-testid="options-sheet">
          <div className="flex-1 bg-black/60" onClick={()=>setShowOptions(false)} />
          <div className="absolute left-0 right-0 bottom-0 bg-bg-2 border-t border-line p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="heading text-lg">OPTIONS</span>
              <button onClick={()=>setShowOptions(false)} className="text-ink-2 p-1"><X size={18}/></button>
            </div>
            <label className="label-shop">VEHICLE</label>
            <select value={vehicleId} onChange={e=>setVehicleId(e.target.value)} className="input-shop mb-4">
              <option value="">-- NO VEHICLE --</option>
              {vehicles.map(v => <option key={v.id} value={v.id}>{`${v.year} ${v.make} ${v.model}`.trim() || v.id.slice(0,6)}</option>)}
            </select>
            <button onClick={()=>setShowOptions(false)} className="btn-rust w-full">DONE</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MicHelpPanel({ error, expanded, onToggle, onRetry, compact }) {
  // detect device
  const ua = (typeof navigator !== "undefined") ? navigator.userAgent : "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);

  return (
    <div className={`border-2 border-danger bg-danger/10 ${compact ? "p-3 mb-2" : "mt-8 p-4 max-w-md w-full"}`} data-testid="mic-help-panel">
      <div className="flex items-start gap-2">
        <div className="text-danger heading text-lg flex-1">{error}</div>
        <button onClick={onToggle} className="text-danger underline text-xs uppercase tracking-widest">
          {expanded ? "HIDE" : "HOW TO FIX"}
        </button>
      </div>

      {expanded && (
        <div className="mt-4 text-sm text-ink space-y-3 text-left">
          {isIOS && (
            <div>
              <div className="heading text-rust text-base mb-1">ON YOUR iPHONE:</div>
              <ol className="list-decimal pl-5 space-y-1 text-[13px]">
                <li>Open the <b>Settings</b> app (gear icon)</li>
                <li>Scroll down and tap <b>Safari</b></li>
                <li>Tap <b>Microphone</b></li>
                <li>Choose <b>Ask</b> (or Allow)</li>
                <li>Come back here, <b>close this tab</b>, and reopen the link</li>
                <li>Tap the mic — Safari will prompt — hit <b>Allow</b></li>
              </ol>
              <div className="mt-2 text-[11px] text-ink-2">
                Don't see Microphone under Safari? Tap the <b>"AA"</b> button on the left side of Safari's address bar →
                <b> Website Settings</b> → <b>Microphone → Allow</b>.
              </div>
            </div>
          )}
          {isAndroid && (
            <div>
              <div className="heading text-rust text-base mb-1">ON YOUR ANDROID:</div>
              <ol className="list-decimal pl-5 space-y-1 text-[13px]">
                <li>Tap the <b>lock icon</b> (or three dots) left of the address bar</li>
                <li>Tap <b>Permissions</b> → <b>Microphone</b> → <b>Allow</b></li>
                <li>Refresh the page</li>
                <li>Tap the mic and allow when prompted</li>
              </ol>
              <div className="mt-2 text-[11px] text-ink-2">
                Still blocked? Phone <b>Settings → Apps → Chrome → Permissions → Microphone → Allow</b>, then refresh.
              </div>
            </div>
          )}
          {!isIOS && !isAndroid && (
            <div>
              <div className="heading text-rust text-base mb-1">DESKTOP BROWSER:</div>
              <ol className="list-decimal pl-5 space-y-1 text-[13px]">
                <li>Click the <b>lock icon</b> left of the URL</li>
                <li>Find <b>Microphone</b> → set to <b>Allow</b></li>
                <li>Reload the page</li>
              </ol>
            </div>
          )}

          <div className="border-t border-danger/40 pt-3 text-[11px] text-ink-2">
            Or just <b>type</b> in the box below — Wrench answers either way.
          </div>

          <button onClick={onRetry} className="btn-rust w-full mt-2" data-testid="retry-mic">
            I FIXED IT — TRY MIC AGAIN
          </button>
        </div>
      )}
    </div>
  );
}

function VoiceButton({ callMode, recording, thinking, speaking, onClick }) {
  const active = callMode || recording || speaking || thinking;
  let label = "TAP TO TALK";
  if (callMode) {
    if (recording) label = "LISTENING — TAP TO END CALL";
    else if (thinking) label = "WRENCH IS THINKING...";
    else if (speaking) label = "WRENCH IS TALKING...";
    else label = "IN CALL — TAP TO END";
  }
  return (
    <div className="relative">
      <button
        onClick={onClick}
        data-testid="big-voice-button"
        aria-label={callMode ? "End call" : "Start call"}
        className={`w-44 h-44 sm:w-48 sm:h-48 border-2 ${active?"border-rust":"border-rust/70"} ${(recording||callMode)?"bg-rust/15":""} ${recording?"animate-pulseRust":""} flex items-center justify-center text-rust active:bg-rust active:text-black transition-colors`}>
        {speaking ? <WaveBars/> : callMode ? (thinking ? <Square size={40} fill="currentColor"/> : <Mic size={56} strokeWidth={1.5}/>) : <Mic size={56} strokeWidth={1.5}/>}
      </button>
      <div className="absolute -bottom-7 left-0 right-0 text-center text-[10px] uppercase tracking-[0.22em] text-ink-2 whitespace-nowrap">
        {label}
      </div>
    </div>
  );
}

function WaveBars() {
  return (
    <div className="flex items-end gap-1 h-14">
      {[0,1,2,3,4,5,6].map(i => (
        <div key={i} className="w-2 bg-rust origin-bottom animate-bar" style={{ height: 48, animationDelay: `${i*70}ms` }}/>
      ))}
    </div>
  );
}

function MessageRow({ m, idx }) {
  const isUser = m.role === "user";
  return (
    <div className={`px-4 md:px-6 py-3 border-b border-line whitespace-pre-wrap break-words ${idx%2===0?"bg-bg-1":"bg-bg-2"}`} data-testid={`msg-${idx}`}>
      <div className="flex items-baseline gap-2 md:gap-3 flex-wrap">
        <span className={`font-head text-[11px] md:text-xs uppercase tracking-widest font-bold ${isUser?"text-amber2":"text-rust"}`}>
          [{isUser?"TECH":"WRENCH"}]
        </span>
        {m.heat && <span className="text-[9px] text-danger uppercase tracking-widest border border-danger px-1">HEAT</span>}
      </div>
      {m.imageUrl && (
        <div className="mt-2">
          <img src={m.imageUrl} alt={m.imageName || "snip"} className="max-h-72 border border-line bg-black/40" data-testid={`msg-img-${idx}`} />
          {m.imageName && <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-1">SNIP: {m.imageName}</div>}
        </div>
      )}
      <div className="mt-1 text-ink text-[13px] md:text-sm leading-relaxed">
        {renderWithLinks(m.content)}
      </div>
      {m.citations && m.citations.length > 0 && (
        <div className="mt-2 text-[10px] md:text-[11px] text-ink-3 border-l-2 border-line pl-3">
          <div className="uppercase tracking-widest text-amber2 mb-1">SOURCES</div>
          {m.citations.map((c,i)=>(<div key={i} className="mb-1">› {c.source}: <span className="text-ink-2">{c.snippet}</span></div>))}
        </div>
      )}
    </div>
  );
}

// Render text with URLs auto-linked as clickable <a> tags
const URL_RE = /\b(https?:\/\/[^\s<>"')]+)|(\bwww\.[^\s<>"')]+)/gi;
function renderWithLinks(text) {
  if (!text) return null;
  const parts = [];
  let last = 0;
  let m;
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    let url = m[0].replace(/[).,;!?]+$/, "");
    const href = url.startsWith("http") ? url : `https://${url}`;
    parts.push(
      <a key={m.index} href={href} target="_blank" rel="noopener noreferrer" className="text-amber2 underline break-all hover:text-rust" data-testid="msg-link">
        {url}
      </a>
    );
    last = m.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
