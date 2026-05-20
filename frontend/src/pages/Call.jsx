import React, { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff, Volume2 } from "lucide-react";
import api, { API, getToken } from "@/api";

const setStatus = (label, color) => window.dispatchEvent(new CustomEvent("wrench-status", { detail: { label, color } }));

export default function Call() {
  const [state, setState] = useState("idle"); // idle | connecting | connected | error
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState([]); // {who, text}
  const [seconds, setSeconds] = useState(0);
  const [volume, setVolume] = useState(1.5); // 0-3.0 (0%-300%)
  const [typed, setTyped] = useState("");
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioElRef = useRef(null);
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const timerRef = useRef(null);
  const pendingUserRef = useRef("");
  const pendingAssistantRef = useRef("");

  useEffect(() => () => endCall(), []); // cleanup on unmount

  const tick = () => {
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
  };

  const stopTick = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const startCall = async () => {
    setError(""); setTranscript([]); setSeconds(0);
    setState("connecting"); setStatus("CONNECTING", "#FFC107");
    try {
      // 1) Get ephemeral key from our backend
      const tokenRes = await api.post("/realtime/session", {});
      const ephemeralKey = tokenRes.data?.value;
      const model = tokenRes.data?.session?.model || "gpt-realtime";
      if (!ephemeralKey) throw new Error("No ephemeral key from backend");

      // 2) Set up WebRTC peer connection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Remote audio track from OpenAI — route through Web Audio for volume boost
      pc.ontrack = (e) => {
        const stream = e.streams[0];
        try {
          // Some browsers need a sink <audio> element to actually play remote audio
          if (audioElRef.current) {
            audioElRef.current.srcObject = stream;
            audioElRef.current.muted = true; // we'll play through Web Audio gain
            audioElRef.current.play().catch(()=>{});
          }
          const ctx = audioCtxRef.current || new (window.AudioContext || window.webkitAudioContext)();
          audioCtxRef.current = ctx;
          if (ctx.state === "suspended") ctx.resume().catch(()=>{});
          const src = ctx.createMediaStreamSource(stream);
          const gain = ctx.createGain();
          gain.gain.value = volume;
          gainRef.current = gain;
          src.connect(gain);
          gain.connect(ctx.destination);
        } catch (err) {
          // Fallback: just play through audio element
          if (audioElRef.current) {
            audioElRef.current.srcObject = stream;
            audioElRef.current.muted = false;
            audioElRef.current.play().catch(()=>{});
          }
        }
      };

      // 3) Get mic audio and add it to the peer
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      // 4) Data channel for events (transcripts, function calls, etc.)
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (evt) => {
        try { handleEvent(JSON.parse(evt.data)); } catch {}
      };
      dc.onopen = () => {
        setState("connected"); setStatus("ON CALL", "#FF5722"); tick();
        // Ask AI to transcribe user audio too (optional)
        try {
          dc.send(JSON.stringify({
            type: "session.update",
            session: { input_audio_transcription: { model: "whisper-1" } }
          }));
        } catch {}
      };
      dc.onclose = () => { setState("idle"); stopTick(); setStatus("IDLE", "#52525B"); };

      // 5) Create SDP offer and POST to OpenAI's /v1/realtime/calls
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
      });
      // Clone defensively — some browsers/extensions/analytics read the body stream early
      let sdpText = "";
      try { sdpText = await sdpResp.clone().text(); }
      catch { try { sdpText = await sdpResp.text(); } catch {} }
      if (!sdpResp.ok) throw new Error(`SDP failed: ${sdpResp.status} ${sdpText}`);
      if (!sdpText) throw new Error("Empty SDP response from OpenAI");
      const answer = { type: "answer", sdp: sdpText };
      await pc.setRemoteDescription(answer);
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || String(e);
      setError(msg);
      setState("error"); setStatus("CALL FAILED", "#D32F2F");
      endCall(true);
    }
  };

  const handleEvent = (evt) => {
    const t = evt.type;
    // user speech transcription
    if (t === "conversation.item.input_audio_transcription.completed") {
      const txt = (evt.transcript || "").trim();
      if (txt) setTranscript(arr => [...arr, { who: "tech", text: txt }]);
    }
    // assistant text streaming (delta)
    if (t === "response.output_text.delta" || t === "response.text.delta") {
      pendingAssistantRef.current += (evt.delta || "");
    }
    if (t === "response.output_audio_transcript.delta") {
      pendingAssistantRef.current += (evt.delta || "");
    }
    if (t === "response.output_text.done" || t === "response.text.done") {
      const txt = pendingAssistantRef.current.trim();
      pendingAssistantRef.current = "";
      if (txt) setTranscript(arr => [...arr, { who: "wrench", text: txt }]);
    }
    if (t === "response.output_audio_transcript.done") {
      const txt = (evt.transcript || pendingAssistantRef.current || "").trim();
      pendingAssistantRef.current = "";
      if (txt) setTranscript(arr => [...arr, { who: "wrench", text: txt }]);
    }
    if (t === "error") {
      setError(evt.error?.message || "Realtime error");
    }
  };

  // Update gain live as the slider moves
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume;
    // Also sync the fallback <audio> element (cannot go above 1.0 there)
    if (audioElRef.current && !gainRef.current) audioElRef.current.volume = Math.min(1, volume);
  }, [volume]);

  const sendText = (text) => {
    const t = (text ?? typed).trim();
    if (!t || !dcRef.current || dcRef.current.readyState !== "open") return;
    setTranscript(arr => [...arr, { who: "tech", text: t }]);
    try {
      dcRef.current.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] },
      }));
      dcRef.current.send(JSON.stringify({ type: "response.create" }));
    } catch (e) {
      setError("Failed to send text: " + (e?.message || e));
    }
    setTyped("");
  };

  const endCall = (keepError) => {
    try { dcRef.current && dcRef.current.close(); } catch {}
    try { pcRef.current && pcRef.current.close(); } catch {}
    try { localStreamRef.current && localStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
    try { audioCtxRef.current && audioCtxRef.current.close(); } catch {}
    dcRef.current = null; pcRef.current = null; localStreamRef.current = null;
    audioCtxRef.current = null; gainRef.current = null;
    stopTick();
    setMuted(false);
    if (!keepError) { setState("idle"); setStatus("IDLE", "#52525B"); }
  };

  const toggleMute = () => {
    const s = localStreamRef.current;
    if (!s) return;
    const next = !muted;
    s.getAudioTracks().forEach(t => t.enabled = !next);
    setMuted(next);
  };

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto" data-testid="call-page">
      <audio ref={audioElRef} playsInline autoPlay />

      <div className="mb-4 border-b border-line pb-4 flex items-end justify-between">
        <div>
          <h1 className="heading text-3xl md:text-4xl">VOICE <span className="text-rust">CALL</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">REAL-TIME BACK-AND-FORTH WITH WRENCH</p>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-ink-3 uppercase tracking-widest">STATE</div>
          <div className={`heading text-lg ${state==="connected"?"text-rust":state==="connecting"?"text-amber2":state==="error"?"text-danger":"text-ink-2"}`}>{state.toUpperCase()}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,1.4fr] gap-4">
        {/* Call control panel */}
        <div className="panel p-6 flex flex-col items-center text-center">
          {/* Animated orb */}
          <div className="relative my-6">
            <CallOrb state={state} />
          </div>

          <div className="text-[10px] uppercase tracking-[0.25em] text-ink-2 mb-2">
            {state === "idle" && "TAP TO START CALL"}
            {state === "connecting" && "DIALING WRENCH..."}
            {state === "connected" && `ON CALL · ${mm}:${ss}`}
            {state === "error" && "CALL FAILED"}
          </div>

          {state !== "connected" && (
            <button
              data-testid="start-call"
              onClick={startCall}
              disabled={state === "connecting"}
              className="btn-rust w-full max-w-xs flex items-center justify-center gap-2 py-4 text-lg"
            >
              <Phone size={20} />
              {state === "connecting" ? "CONNECTING..." : "START CALL"}
            </button>
          )}

          {state === "connected" && (
            <>
              <div className="flex items-center gap-3 w-full max-w-xs">
                <button data-testid="mute-toggle" onClick={toggleMute} className={`flex-1 py-4 border-2 ${muted?"border-amber2 text-amber2":"border-line text-ink-2"} flex items-center justify-center gap-2`}>
                  {muted ? <MicOff size={18}/> : <Mic size={18}/>}
                  {muted ? "MUTED" : "MIC"}
                </button>
                <button data-testid="end-call" onClick={()=>endCall()} className="flex-1 py-4 border-2 border-danger bg-danger/15 text-danger flex items-center justify-center gap-2 hover:bg-danger hover:text-white">
                  <PhoneOff size={18}/> HANG UP
                </button>
              </div>

              {/* Volume control */}
              <div className="w-full max-w-xs mt-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-widest text-ink-2 flex items-center gap-1">
                    <Volume2 size={12}/> WRENCH VOLUME
                  </span>
                  <span className="text-[11px] font-mono text-rust" data-testid="volume-label">{Math.round(volume*100)}%</span>
                </div>
                <input
                  type="range" min="0" max="3" step="0.1" value={volume}
                  onChange={e=>setVolume(parseFloat(e.target.value))}
                  data-testid="volume-slider"
                  className="w-full accent-rust"
                />
                <div className="flex justify-between text-[9px] uppercase tracking-widest text-ink-3 mt-1">
                  <span>OFF</span><span>NORMAL</span><span>LOUD AF</span>
                </div>
              </div>
            </>
          )}

          {error && (
            <div className="mt-4 border border-danger text-danger text-xs uppercase tracking-widest p-2 max-w-sm break-words">
              {error}
            </div>
          )}

          <div className="mt-6 text-[10px] text-ink-3 uppercase tracking-[0.2em] leading-relaxed">
            POWERED BY OPENAI REALTIME · ASH VOICE<br/>
            ~250ms RESPONSE · INTERRUPT-ABLE · NATURAL CONVERSATION
          </div>
        </div>

        {/* Live transcript */}
        <div className="panel flex flex-col">
          <div className="px-4 py-3 border-b border-line text-[11px] uppercase tracking-widest text-ink-3 flex justify-between">
            <span>LIVE TRANSCRIPT</span>
            <span className="text-rust animate-blink">{state === "connected" ? "● LIVE" : ""}</span>
          </div>
          <div className="p-2 max-h-[40vh] overflow-auto flex-1" data-testid="transcript">
            {transcript.length === 0 ? (
              <div className="p-6 text-ink-3 text-sm text-center">
                {state === "connected"
                  ? "Talk to Wrench. Transcripts will show here as you both speak."
                  : "Start a call to begin."}
              </div>
            ) : transcript.map((m, i) => (
              <div key={i} className={`px-3 py-2 border-b border-line ${i%2===0?"bg-bg-1":"bg-bg-2"}`}>
                <div className={`text-[10px] uppercase tracking-widest font-bold ${m.who==="tech"?"text-amber2":"text-rust"}`}>
                  [{m.who==="tech"?"TECH":"WRENCH"}]
                </div>
                <div className="text-sm mt-1 break-words whitespace-pre-wrap">{m.text}</div>
              </div>
            ))}
          </div>

          {/* Text input — paste tables, datalogs, notes during the call */}
          <div className="border-t border-line p-3 bg-bg-2">
            <div className="label-shop !mb-1">PASTE / TYPE (Wrench reads it)</div>
            <div className="flex gap-2 items-end">
              <textarea
                data-testid="call-text-input"
                value={typed}
                onChange={e=>setTyped(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } }}
                rows={3}
                disabled={state !== "connected"}
                placeholder={state === "connected" ? "Paste a datalog, table, or VIN. Cmd/Ctrl+V then ENTER." : "Start a call to enable..."}
                className="input-shop flex-1 resize-none text-xs font-mono"
              />
              <button
                data-testid="call-send-text"
                onClick={()=>sendText()}
                disabled={state !== "connected" || !typed.trim()}
                className="btn-rust h-12 px-4"
              >SEND</button>
            </div>
            <div className="text-[9px] text-ink-3 uppercase tracking-widest mt-1">
              Wrench will see it AND speak about it. Enter = send · Shift+Enter = new line
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 panel p-4 text-xs text-ink-2 leading-relaxed">
        <div className="heading text-rust text-sm mb-2">HOW IT WORKS</div>
        Tap <b className="text-white">START CALL</b>. Allow your microphone if asked. Just talk — Wrench
        hears the natural pause and responds. You can interrupt him mid-sentence by talking. Tap
        <b className="text-danger"> HANG UP</b> to end. Uses your OpenAI key (Realtime API, ~$0.06/min input · $0.24/min output).
      </div>
    </div>
  );
}

function CallOrb({ state }) {
  const active = state === "connected";
  return (
    <div className="relative w-40 h-40 flex items-center justify-center">
      <div className={`absolute inset-0 border-2 ${active ? "border-rust" : "border-line"}`} />
      <div className={`absolute inset-4 border ${active ? "border-rust/60 animate-pulseRust" : "border-line"}`} />
      <div className={`absolute inset-8 border ${active ? "border-rust/40" : "border-line/60"}`} />
      <div className={`w-12 h-12 ${active ? "bg-rust animate-pulseRust" : state==="connecting" ? "bg-amber2 animate-blink" : "bg-line"}`} />
      {!active && state !== "connecting" && (
        <Phone size={22} className="absolute text-rust" />
      )}
    </div>
  );
}
