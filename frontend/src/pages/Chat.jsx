import React, { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Mic, Send, Volume2, VolumeX, ChevronRight, Square, History, Settings2, X, Paperclip, FolderPlus, Truck, Plus, Check, AlertCircle, Copy } from "lucide-react";
import api, { API, getToken } from "@/api";
import { useApp } from "@/AppContext";
import { useWakeLock } from "@/hooks/useWakeLock";
import ImageLightbox, { openLightbox } from "@/components/ImageLightbox";

const setStatus = (label, color) => window.dispatchEvent(new CustomEvent("wrench-status", { detail: { label, color } }));

export default function Chat() {
  const app = useApp();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(() => localStorage.getItem("dw_chat_session") || null);
  const [mode, setMode] = useState("direct");
  const [voiceOn, setVoiceOn] = useState(true);
  const [vehicleId, setVehicleId] = useState(app?.activeVehicleId || "");
  const vehicles = app?.vehicles || [];
  const [showVinModal, setShowVinModal] = useState(false);
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
  // The REALTIME call is owned by AppContext — when it's connected, suppress chat TTS
  // so we don't get double audio (call + chat playback talking over each other).
  const realtimeCallActive = app?.callState === "connected" || app?.callState === "connecting";
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

  // Keep the screen on while Chat is open (so it doesn't sleep mid-tune under a truck)
  useWakeLock(true);

  // Pin the window scroll to the top on mount — defensive fix so landing on /chat
  // never auto-scrolls the whole page down to the input. (The message box has its
  // own scroll independent of the window.)
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Unlock iOS audio playback — must be called inside a user gesture
  const unlockAudio = () => {
    if (audioUnlockedRef.current) return;
    try {
      const el = audioElRef.current;
      if (!el) return;
      // Prime with a tiny silent MP3 data URI so iOS will accept the play() call
      // even before we have real audio loaded.
      if (!el.src) {
        el.src = "data:audio/mpeg;base64,/+MYxAAAAANIAAAAAExBTUUzLjEwMAAAAAAAAAAAABQgJAUHQQAB9AAAA0gJX/gIAAAA";
      }
      el.muted = true;
      el.volume = 1;
      const p = el.play();
      if (p && p.then) {
        p.then(() => { el.pause(); el.currentTime = 0; el.muted = false; audioUnlockedRef.current = true; })
         .catch(() => { /* will retry on next gesture */ });
      } else {
        el.pause(); el.muted = false; audioUnlockedRef.current = true;
      }
    } catch {}
  };

  // Pending TTS — if play() got blocked by autoplay policy, the next user click
  // anywhere will resume it. This way Doc never has to hunt for a "HEAR LAST" button.
  const pendingTtsRef = useRef(false);
  useEffect(() => {
    const resume = () => {
      if (!pendingTtsRef.current) return;
      const el = audioElRef.current;
      if (!el || !el.src) return;
      try {
        el.play().then(() => { pendingTtsRef.current = false; setSpeaking(true); setStatus("SPEAKING", "#FFC107"); }).catch(()=>{});
      } catch {}
    };
    document.addEventListener("click", resume, true);
    document.addEventListener("touchend", resume, true);
    return () => {
      document.removeEventListener("click", resume, true);
      document.removeEventListener("touchend", resume, true);
    };
  }, []);

  // Detect Web Speech API (Safari/Chrome both support webkit prefix on iOS)
  const SR = (typeof window !== "undefined") && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasNativeSpeech = !!SR;

  useEffect(() => {
    app?.refreshVehicles?.();
    refreshSessions();
    setTimeout(() => inputRef.current?.focus(), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          // Scroll the messages container to the TOP after history load so Doc lands
          // on the start of the conversation, not the bottom.
          setTimeout(() => {
            const scroller = endRef.current?.parentElement;
            let s = scroller;
            while (s && s !== document.body) {
              const oy = window.getComputedStyle(s).overflowY;
              if (oy === "auto" || oy === "scroll") break;
              s = s.parentElement;
            }
            if (s) s.scrollTop = 0;
            window.scrollTo(0, 0);
          }, 50);
        }).catch(()=>{ localStorage.removeItem("dw_chat_session"); setSessionId(null); });
      }
    } else {
      localStorage.removeItem("dw_chat_session");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const refreshSessions = () => api.get("/chat/sessions").then(r => setSessions(r.data || [])).catch(()=>{});

  useEffect(() => {
    // Layout flipped: newest message is at TOP of the list, just under the input.
    // No auto-scroll needed — the new message is already visible at the top.
    // Just pin the messages container to top on first render so we're showing newest first.
    const el = endRef.current?.parentElement;
    if (!el) return;
    let scroller = el;
    while (scroller && scroller !== document.body) {
      const oy = window.getComputedStyle(scroller).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      scroller = scroller.parentElement;
    }
    if (scroller) scroller.scrollTop = 0;
  }, [messages, thinking]);

  const loadSession = async (sid) => {
    const r = await api.get(`/chat/sessions/${sid}`);
    setSessionId(sid);
    setMessages((r.data.messages || []).map(m => ({ role: m.role, content: m.content })));
    setShowSessions(false);
  };

  // Handle ?resume=<sid> from the JOBS page — auto-load that session
  useEffect(() => {
    const sid = searchParams.get("resume");
    if (sid) {
      loadSession(sid).finally(() => {
        // Clear the query param so back/refresh doesn't reload
        searchParams.delete("resume");
        setSearchParams(searchParams, { replace: true });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newSession = () => { setSessionId(null); setMessages([]); setShowOptions(false); };

  const saveAsCase = async () => {
    if (!sessionId || messages.length === 0) {
      alert("Nothing to save yet — chat with Wrench first, then save the closed job.");
      return;
    }
    try {
      const r = await api.post(`/cases/from-chat/${sessionId}`);
      // Navigate to Cases page so Doc can fill in root cause + repair
      nav(`/cases`);
    } catch (e) {
      alert("Save failed: " + (e?.response?.data?.detail || e.message));
    }
  };

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
      if ((voiceOn || callModeRef.current) && !realtimeCallActive) await speak(reply);
      else if (callModeRef.current && !realtimeCallActive) {
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
    setThinking(true);

    // REALTIME CALL ACTIVE → route image into the call, NOT a parallel chat.
    // Stops the call + chat double-stream problem Doc hit.
    if (realtimeCallActive) {
      setStatus("READING SNIP (CALL)", "#FF5722");
      try {
        const fd = new FormData();
        fd.append("image", file);
        fd.append("message", userText || "Doc dropped a snip mid-call. Describe what's in it in 2-3 sentences.");
        if (sessionId) fd.append("session_id", sessionId);
        fd.append("mode", "direct");
        if (vehicleId) fd.append("vehicle_id", vehicleId);
        const r = await api.post("/chat/vision", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 120000 });
        const desc = (r.data?.reply || "").slice(0, 1500);
        const callMsg = `[Image dropped: ${file.name}] Doc says: ${userText || "see this"}\n\nWhat the image shows:\n${desc}`;
        app?.sendCallText?.(callMsg);
        setMessages(m => [...m, { role: "system", content: `→ Snip + description sent to active call. Wrench is talking about it.` }]);
      } catch (e) {
        setMessages(m => [...m, { role: "assistant", content: `[ERROR sending snip into call] ${e?.response?.data?.detail || e.message}` }]);
      } finally { setThinking(false); setStatus("ON CALL", "#FF5722"); }
      return;
    }

    setStatus("READING SNIP", "#FF5722");
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
      if ((voiceOn || callModeRef.current) && !realtimeCallActive) await speak(reply);
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
        // iOS autoplay block. Mark pending so the very next tap anywhere resumes it.
        pendingTtsRef.current = true;
        setSpeaking(false);
        setStatus("TAP ANYWHERE TO HEAR", "#FFC107");
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
      <ImageLightbox />
      {/* Hidden audio element for TTS playback — must be in DOM for iOS to allow play() */}
      <audio ref={audioElRef} playsInline preload="auto" data-testid="tts-audio" />
      {/* Desktop-only header — order-1 on desktop */}
      <div className="hidden md:flex order-1 border-b border-line px-6 py-3 items-center justify-between bg-bg-2" data-testid="chat-header">
        <div className="flex items-center gap-3">
          <h1 className="heading text-2xl">CHAT // <span className="text-rust">WRENCH</span></h1>
          <span className="text-ink-3 text-xs">{sessionId ? `SID: ${sessionId.slice(0,8)}` : "NEW SESSION"}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select data-testid="vehicle-select" value={vehicleId} onChange={e=>{setVehicleId(e.target.value); app?.setActiveVehicleId?.(e.target.value);}} className="input-shop text-xs py-1" style={{width:"auto"}}>
            <option value="">-- NO VEHICLE --</option>
            {vehicles.map(v => {
              const ymm = [v.year, v.make, v.model].filter(Boolean).join(" ").trim();
              const tail = v.vin ? `VIN ····${String(v.vin).slice(-6)}` : `ID ${v.id.slice(0,6)}`;
              return <option key={v.id} value={v.id}>{ymm || tail}</option>;
            })}
          </select>
          <button data-testid="mode-toggle" onClick={()=>setMode(mode==="direct"?"dream":"direct")} className="btn-ghost text-xs">
            MODE: <span className={mode==="direct"?"text-rust":"text-amber2"}>{mode === "direct" ? "DIRECT" : "DREAM"}</span>
          </button>
          <button data-testid="voice-toggle" onClick={()=>{ unlockAudio(); setVoiceOn(v=>!v); }} className="btn-ghost text-xs flex items-center gap-2">
            {voiceOn ? <Volume2 size={14}/> : <VolumeX size={14}/>}
            {voiceOn ? "VOICE ON" : "VOICE OFF"}
          </button>
          <button data-testid="sessions-toggle" onClick={()=>setShowSessions(s=>!s)} className="btn-ghost text-xs flex items-center gap-2"><History size={14}/>HISTORY</button>
          <button data-testid="save-as-case" onClick={saveAsCase} className="btn-ghost text-xs flex items-center gap-2" title="Drop this chat into the BRAIN as a case Wrench can recall later"><FolderPlus size={14}/>SAVE AS CASE</button>
          <button data-testid="new-session" onClick={newSession} className="btn-ghost text-xs">+ NEW</button>
        </div>
      </div>

      {/* Mobile chat header strip — order-1 on mobile */}
      <div className="md:hidden order-1 px-3 py-2 border-b border-line bg-bg-2 flex items-center justify-between gap-2">
        <button onClick={()=>{ unlockAudio(); setVoiceOn(v=>!v); }} data-testid="m-voice-toggle" className={`flex items-center gap-1 text-[11px] uppercase tracking-widest border px-2 py-1 ${voiceOn?"border-rust text-rust":"border-line text-ink-2"}`}>
          {voiceOn ? <Volume2 size={12}/> : <VolumeX size={12}/>} {voiceOn ? "VOICE" : "MUTE"}
        </button>
        <button onClick={()=>setMode(mode==="direct"?"dream":"direct")} data-testid="m-mode" className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-ink-2">
          <span className={mode==="direct"?"text-rust":"text-amber2"}>{mode.toUpperCase()}</span>
        </button>
        <button data-testid="m-history" onClick={()=>setShowSessions(true)} className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-ink-2 flex items-center gap-1"><History size={12}/>HX</button>
        <button data-testid="m-save-case" onClick={saveAsCase} className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-amber2 flex items-center gap-1" title="Save chat as case"><FolderPlus size={12}/>CASE</button>
        <button data-testid="m-new" onClick={newSession} className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-ink-2">+ NEW</button>
        <button data-testid="m-options" onClick={()=>setShowOptions(true)} className="text-[11px] uppercase tracking-widest border border-line px-2 py-1 text-ink-2 flex items-center gap-1"><Settings2 size={12}/></button>
      </div>

      {/* VEHICLE STRIP — always visible, top priority. Techs see this BEFORE anything else. */}
      <ActiveVehicleBar
        vehicleId={vehicleId}
        vehicles={vehicles}
        onPickExisting={() => setShowVinModal(true)}
        onAddVin={() => setShowVinModal(true)}
        onClear={() => { setVehicleId(""); app?.setActiveVehicleId(""); }}
      />

      {showVinModal && (
        <VinPullModal
          vehicles={vehicles}
          onClose={() => setShowVinModal(false)}
          onPicked={(v) => {
            setVehicleId(v.id);
            app?.setActiveVehicleId(v.id);
            app?.refreshVehicles?.();
            setShowVinModal(false);
          }}
        />
      )}

      {/* Messages — order-3 (always below input). Newest at TOP under the input bar. */}
      <div className="flex-1 overflow-auto order-3" data-testid="messages-area">
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
          <div className="font-mono text-sm pb-4 flex flex-col">
            {thinking && (
              <div className="px-4 md:px-6 py-3 border-b border-line bg-bg-1 text-rust text-xs" data-testid="thinking-row">
                [WRENCH] <span className="animate-blink">_</span> thinking
              </div>
            )}
            {[...messages].reverse().map((m, i) => <MessageRow key={messages.length - 1 - i} m={m} idx={messages.length - 1 - i} />)}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* Input bar — TOP of page (order-2, right under headers). Doc's preference: type at top, replies appear below. */}
      <div className="order-2 border-b border-line bg-bg-2 px-3 md:px-6 py-3 md:py-4 sticky top-0 z-20 safe-top">
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
            <select value={vehicleId} onChange={e=>{setVehicleId(e.target.value); app?.setActiveVehicleId?.(e.target.value);}} className="input-shop mb-4">
              <option value="">-- NO VEHICLE --</option>
              {vehicles.map(v => {
                const ymm = [v.year, v.make, v.model].filter(Boolean).join(" ").trim();
                const tail = v.vin ? `VIN ····${String(v.vin).slice(-6)}` : `ID ${v.id.slice(0,6)}`;
                return <option key={v.id} value={v.id}>{ymm || tail}</option>;
              })}
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
          <img
            src={m.imageUrl}
            alt={m.imageName || "snip"}
            onClick={() => openLightbox(m.imageUrl, m.imageName || "snip")}
            className="max-h-72 border border-line bg-black/40 cursor-zoom-in hover:border-rust transition-colors"
            data-testid={`msg-img-${idx}`}
          />
          {m.imageName && <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-1">SNIP: {m.imageName} — TAP TO ZOOM</div>}
        </div>
      )}
      <div className="mt-1 text-ink text-[15px] md:text-[15px] leading-[1.65]" style={{fontFamily:"'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"}}>
        {renderRichContent(m.content)}
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

// Detect a markdown ```...``` fenced block OR a multi-line tab-separated block.
// For each, render a one-tap COPY TABLE button + the raw monospaced text.
// Outside those blocks, fall back to renderWithLinks for clickable URLs / images.
function renderRichContent(text) {
  if (!text) return null;
  const blocks = [];
  let i = 0;
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > i) blocks.push({ kind: "text", text: text.slice(i, m.index) });
    blocks.push({ kind: "code", lang: (m[1] || "").trim(), text: m[2].replace(/\n+$/, "") });
    i = m.index + m[0].length;
  }
  if (i < text.length) blocks.push({ kind: "text", text: text.slice(i) });

  // Further split each "text" block: if it contains a chunk of >=3 lines with >=2 tabs each, treat that chunk as a TSV table.
  const out = [];
  blocks.forEach((b, bi) => {
    if (b.kind === "code") {
      out.push(<CopyableBlock key={`b${bi}`} text={b.text} lang={b.lang} />);
      return;
    }
    const lines = b.text.split("\n");
    let buf = [];
    let tsvBuf = [];
    const flushBuf = (label) => {
      if (buf.length) {
        out.push(<span key={`${bi}-t-${label}`}>{renderWithLinks(buf.join("\n"))}</span>);
        buf = [];
      }
    };
    const flushTsv = (label) => {
      if (tsvBuf.length >= 3) {
        out.push(<CopyableBlock key={`${bi}-tsv-${label}`} text={tsvBuf.join("\n")} lang="tsv" />);
      } else {
        buf.push(...tsvBuf);
      }
      tsvBuf = [];
    };
    lines.forEach((ln, li) => {
      const looksTsv = (ln.match(/\t/g) || []).length >= 2 || /^([-+]?\d+(\.\d+)?[\t ,]+){4,}[-+]?\d+(\.\d+)?$/.test(ln.trim());
      if (looksTsv) {
        flushBuf(li);
        tsvBuf.push(ln);
      } else {
        if (tsvBuf.length) flushTsv(li);
        buf.push(ln);
      }
    });
    flushTsv("end");
    flushBuf("end");
  });

  return out;
}

function CopyableBlock({ text, lang }) {
  const [copied, setCopied] = React.useState(false);
  const isTable = lang === "tsv" || /\t/.test(text);
  const copy = async (e) => {
    e.preventDefault(); e.stopPropagation();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(()=>setCopied(false), 1800);
    } catch {/* fall back to selection */}
  };
  return (
    <div className="my-3 relative border-2 border-amber2/40 bg-bg-1" data-testid="copy-block">
      {/* Tiny copy icon in the top-right — Doc's preference */}
      <button
        onClick={copy}
        onTouchEnd={copy}
        data-testid="copy-icon-btn"
        title={copied ? "Copied" : "Copy"}
        aria-label="Copy code to clipboard"
        className={`absolute top-1.5 right-1.5 z-10 w-9 h-9 flex items-center justify-center border ${copied ? "bg-ok/20 border-ok text-ok" : "bg-bg-2/95 border-amber2/50 text-amber2 hover:bg-amber2 hover:text-bg-1 active:bg-amber2 active:text-bg-1"} transition-colors`}
      >
        {copied ? <Check size={16}/> : <Copy size={15}/>}
      </button>
      {isTable && (
        <div className="px-2 py-1 pr-12 bg-amber2/10 border-b border-amber2/30 text-[10px] uppercase tracking-widest text-amber2 font-bold">
          TABLE · TAB-SEPARATED · USE PASTE SPECIAL IN HP TUNERS
        </div>
      )}
      <pre className="px-2 py-2 pr-12 text-[11px] md:text-xs font-mono text-ink whitespace-pre overflow-x-auto leading-snug">{text}</pre>
    </div>
  );
}

// Strip stray markdown (bold/italic asterisks, heading hashes) that the model occasionally leaks.
// Only applied OUTSIDE code blocks — code blocks are passed through untouched.
function stripMarkdown(s) {
  if (!s) return s;
  return s
    .replace(/\*\*\*([^*\n]+?)\*\*\*/g, "$1")
    .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*\n]+?)\*(?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/__([^_\n]+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "");
}

// Render text with URLs auto-linked as clickable <a> tags + image URLs as inline images
const URL_RE = /\b(https?:\/\/[^\s<>"')]+)|(\bwww\.[^\s<>"')]+)/gi;
const IMG_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s<>")]*)?$/i;
function renderWithLinks(text) {
  if (!text) return null;
  text = stripMarkdown(text);
  const parts = [];
  let last = 0;
  let m;
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    let url = m[0].replace(/[).,;!?]+$/, "");
    const href = url.startsWith("http") ? url : `https://${url}`;
    if (IMG_EXT_RE.test(url)) {
      parts.push(
        <button
          key={m.index}
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("wrench-lightbox", { detail: { url: href, alt: "diagram from web" } }))}
          className="block my-2 p-0 bg-transparent border-0 cursor-zoom-in text-left"
          data-testid="msg-img-inline"
        >
          <img src={href} alt="diagram from web" loading="lazy" className="max-h-72 border border-line bg-black/40 hover:border-rust transition-colors" />
          <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-1">TAP TO ZOOM</div>
        </button>
      );
    } else {
      parts.push(
        <a key={m.index} href={href} target="_blank" rel="noopener noreferrer" className="text-amber2 underline break-all hover:text-rust" data-testid="msg-link">
          {url}
        </a>
      );
    }
    last = m.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}


// ===================== Active Vehicle Bar (always-visible) =====================
function ActiveVehicleBar({ vehicleId, vehicles, onPickExisting, onAddVin, onClear }) {
  const v = vehicles.find(x => x.id === vehicleId);
  if (!v) {
    return (
      <div className="order-2 px-3 md:px-6 py-2 border-b border-line bg-bg-3 flex items-center justify-between gap-2" data-testid="vin-bar-empty">
        <div className="text-[11px] uppercase tracking-widest text-ink-3 flex items-center gap-2">
          <Truck size={12} className="text-rust"/> NO VEHICLE — ADD ONE SO WRENCH KNOWS THE TRUCK
        </div>
        <div className="flex gap-1.5">
          {vehicles.length > 0 && (
            <button onClick={onPickExisting} className="text-[11px] uppercase tracking-widest border border-line text-ink-2 px-2 py-1 hover:border-rust hover:text-rust" data-testid="vin-bar-pick">
              PICK
            </button>
          )}
          <button onClick={onAddVin} className="text-[11px] uppercase tracking-widest border-2 border-rust bg-rust text-black px-3 py-1 flex items-center gap-1 font-bold" data-testid="vin-bar-add">
            <Plus size={12}/>VIN
          </button>
        </div>
      </div>
    );
  }
  const label = [v.year, v.make, v.model].filter(Boolean).join(" ") || (v.vin ? v.vin.slice(-6) : "vehicle");
  return (
    <div className="order-2 px-3 md:px-6 py-2 border-b border-line bg-bg-3 flex items-center justify-between gap-2" data-testid="vin-bar-active">
      <div className="flex items-center gap-2 min-w-0">
        <Truck size={14} className="text-rust shrink-0"/>
        <div className="text-sm text-amber2 font-bold truncate" data-testid="vin-bar-label">{label}</div>
        {v.engine_summary && <span className="text-[11px] text-ink-3 hidden md:inline">· {v.engine_summary}</span>}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button onClick={onAddVin} className="text-[11px] uppercase tracking-widest border border-line text-ink-2 px-2 py-1 hover:border-rust hover:text-rust flex items-center gap-1" data-testid="vin-bar-switch">
          <Plus size={11}/>VIN
        </button>
        <button onClick={onClear} className="text-[11px] uppercase tracking-widest text-ink-3 hover:text-danger px-2 py-1" title="Clear active vehicle" data-testid="vin-bar-clear">
          <X size={12}/>
        </button>
      </div>
    </div>
  );
}

// ===================== VIN Pull Modal — paste VIN → NHTSA → save → set active =====================
function VinPullModal({ vehicles, onClose, onPicked }) {
  const [vin, setVin] = useState("");
  const [busy, setBusy] = useState(false);
  const [decoded, setDecoded] = useState(null);
  const [err, setErr] = useState("");

  const cleanVin = vin.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const ready = cleanVin.length >= 11;

  const decode = async () => {
    setErr(""); setDecoded(null);
    if (!ready) { setErr("VIN looks short — need at least 11 characters."); return; }
    setBusy(true);
    try {
      const r = await api.get(`/vin/decode/${cleanVin}`);
      const d = r.data;
      if (!d.year && !d.make && d.error_text) { setErr(`VIN decoder couldn't read that: ${d.error_text.slice(0, 120)}`); }
      setDecoded(d);
    } catch (e) {
      setErr(e?.response?.data?.detail || "VIN lookup failed");
    } finally { setBusy(false); }
  };

  const saveAndActivate = async () => {
    if (!decoded) return;
    setBusy(true); setErr("");
    try {
      const payload = {
        vin: cleanVin,
        year: decoded.year || "",
        make: decoded.make || "",
        model: decoded.model || "",
        trim: decoded.trim || "",
        engine_summary: decoded.engine_summary || "",
        notes: "",
        mods: "",
      };
      const r = await api.post("/vehicles", payload);
      onPicked(r.data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose} data-testid="vin-modal">
      <div className="bg-bg-1 border-t-2 md:border-2 border-rust w-full md:max-w-md max-h-[92vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="p-4 border-b border-line flex items-center justify-between sticky top-0 bg-bg-1">
          <h2 className="heading text-lg flex items-center gap-2"><Truck size={16} className="text-rust"/>PULL VIN</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink p-1" data-testid="vin-modal-close"><X size={18}/></button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="label-shop">VIN (17 CHARS — PASTE FROM CUSTOMER OR DOOR JAMB)</label>
            <input
              data-testid="vin-input"
              className="input-shop w-full font-mono uppercase tracking-widest text-base py-3"
              placeholder="1GCRCREC4HZ123456"
              value={vin}
              onChange={e=>setVin(e.target.value)}
              autoFocus
              maxLength={20}
              onKeyDown={(e)=>{ if (e.key === "Enter" && !decoded) decode(); }}
            />
            <div className="text-[10px] text-ink-3 mt-1 uppercase tracking-widest">
              {cleanVin.length}/17 chars · {ready ? "ready" : "keep typing"}
            </div>
          </div>

          {err && <div className="text-danger text-sm border border-danger/40 bg-danger/10 p-2 flex items-start gap-2"><AlertCircle size={14} className="shrink-0 mt-0.5"/>{err}</div>}

          {!decoded ? (
            <button data-testid="vin-decode-btn" onClick={decode} disabled={!ready || busy} className="btn-rust w-full py-3 text-base disabled:opacity-40">
              {busy ? "LOOKING IT UP..." : "DECODE VIN"}
            </button>
          ) : (
            <>
              <div className="border border-ok/40 bg-ok/5 p-3 space-y-1" data-testid="vin-decoded">
                <div className="text-[10px] text-ok uppercase tracking-widest font-bold mb-1 flex items-center gap-1"><Check size={12}/>NHTSA SAID:</div>
                <div className="text-base font-bold text-amber2">{[decoded.year, decoded.make, decoded.model].filter(Boolean).join(" ") || "—"}</div>
                {decoded.trim && <div className="text-xs text-ink-2">Trim: {decoded.trim}</div>}
                {decoded.engine_summary && <div className="text-xs text-ink-2">Engine: {decoded.engine_summary}</div>}
                {decoded.transmission && <div className="text-xs text-ink-2">Trans: {decoded.transmission}</div>}
                {decoded.drive && <div className="text-xs text-ink-2">Drive: {decoded.drive}</div>}
              </div>
              <button data-testid="vin-save-btn" onClick={saveAndActivate} disabled={busy} className="btn-rust w-full py-3 text-base disabled:opacity-40 flex items-center justify-center gap-2">
                <Check size={14}/>{busy ? "SAVING..." : "SAVE + MAKE ACTIVE"}
              </button>
              <button onClick={()=>{ setDecoded(null); setVin(""); }} className="btn-ghost w-full py-2 text-xs">CHANGE VIN</button>
            </>
          )}

          {vehicles.length > 0 && !decoded && (
            <div className="pt-3 border-t border-line">
              <div className="label-shop">OR PICK A VEHICLE YOU ALREADY HAVE</div>
              <div className="space-y-1 max-h-40 overflow-auto">
                {vehicles.map(v => (
                  <button
                    key={v.id}
                    onClick={()=>onPicked(v)}
                    data-testid={`vin-existing-${v.id}`}
                    className="w-full text-left border border-line hover:border-rust px-3 py-2 text-sm flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{[v.year, v.make, v.model].filter(Boolean).join(" ") || (v.vin || "untitled")}</span>
                    {v.vin && <span className="text-[10px] text-ink-3 font-mono shrink-0">{v.vin.slice(-6)}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
