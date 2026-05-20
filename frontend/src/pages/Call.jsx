import React, { useState } from "react";
import { Phone, PhoneOff, Mic, MicOff, Volume2 } from "lucide-react";
import { useApp } from "@/AppContext";

export default function Call() {
  const {
    callState, callError, callTranscript, callMuted, callSeconds, callVolume,
    setCallVolume, startCall, endCall, sendCallText, toggleCallMute,
    activeVehicle,
  } = useApp();
  const [typed, setTyped] = useState("");

  const send = () => {
    const t = typed.trim();
    if (!t) return;
    if (sendCallText(t)) setTyped("");
  };

  const mm = String(Math.floor(callSeconds / 60)).padStart(2, "0");
  const ss = String(callSeconds % 60).padStart(2, "0");

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto" data-testid="call-page">
      <div className="mb-4 border-b border-line pb-4 flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="heading text-3xl md:text-4xl">VOICE <span className="text-rust">CALL</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">
            REAL-TIME WITH WRENCH {activeVehicle && <> · {activeVehicle.year} {activeVehicle.make} {activeVehicle.model}</>}
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-ink-3 uppercase tracking-widest">STATE</div>
          <div className={`heading text-lg ${callState==="connected"?"text-rust":callState==="connecting"?"text-amber2":callState==="error"?"text-danger":"text-ink-2"}`}>{callState.toUpperCase()}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,1.4fr] gap-4">
        <div className="panel p-6 flex flex-col items-center text-center">
          <div className="relative my-6">
            <CallOrb state={callState} />
          </div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-ink-2 mb-2">
            {callState === "idle" && "TAP TO START CALL"}
            {callState === "connecting" && "DIALING WRENCH..."}
            {callState === "connected" && `ON CALL · ${mm}:${ss}`}
            {callState === "error" && "CALL FAILED"}
          </div>

          {callState !== "connected" && (
            <button data-testid="start-call" onClick={startCall} disabled={callState === "connecting"} className="btn-rust w-full max-w-xs flex items-center justify-center gap-2 py-4 text-lg">
              <Phone size={20} /> {callState === "connecting" ? "CONNECTING..." : "START CALL"}
            </button>
          )}

          {callState === "connected" && (
            <>
              <div className="flex items-center gap-3 w-full max-w-xs">
                <button data-testid="mute-toggle" onClick={toggleCallMute} className={`flex-1 py-4 border-2 ${callMuted?"border-amber2 text-amber2":"border-line text-ink-2"} flex items-center justify-center gap-2`}>
                  {callMuted ? <MicOff size={18}/> : <Mic size={18}/>}
                  {callMuted ? "MUTED" : "MIC"}
                </button>
                <button data-testid="end-call" onClick={endCall} className="flex-1 py-4 border-2 border-danger bg-danger/15 text-danger flex items-center justify-center gap-2 hover:bg-danger hover:text-white">
                  <PhoneOff size={18}/> HANG UP
                </button>
              </div>
              <div className="w-full max-w-xs mt-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-widest text-ink-2 flex items-center gap-1"><Volume2 size={12}/> WRENCH VOLUME</span>
                  <span className="text-[11px] font-mono text-rust" data-testid="volume-label">{Math.round(callVolume*100)}%</span>
                </div>
                <input type="range" min="0" max="3" step="0.1" value={callVolume} onChange={e=>setCallVolume(parseFloat(e.target.value))} data-testid="volume-slider" className="w-full accent-rust"/>
                <div className="flex justify-between text-[9px] uppercase tracking-widest text-ink-3 mt-1">
                  <span>OFF</span><span>NORMAL</span><span>LOUD AF</span>
                </div>
              </div>
            </>
          )}

          {callError && (
            <div className="mt-4 border border-danger text-danger text-xs uppercase tracking-widest p-2 max-w-sm break-words">
              {callError}
            </div>
          )}

          <div className="mt-6 text-[10px] text-ink-3 uppercase tracking-[0.2em] leading-relaxed">
            POWERED BY OPENAI REALTIME · ~250MS · INTERRUPT-ABLE<br/>
            <span className="text-amber2">CALL STAYS LIVE WHEN YOU SWITCH TABS</span>
          </div>
        </div>

        <div className="panel flex flex-col">
          <div className="px-4 py-3 border-b border-line text-[11px] uppercase tracking-widest text-ink-3 flex justify-between">
            <span>LIVE TRANSCRIPT</span>
            <span className="text-rust animate-blink">{callState === "connected" ? "● LIVE" : ""}</span>
          </div>
          <div className="p-2 max-h-[40vh] overflow-auto flex-1" data-testid="transcript">
            {callTranscript.length === 0 ? (
              <div className="p-6 text-ink-3 text-sm text-center">
                {callState === "connected" ? "Talk to Wrench." : "Start a call to begin."}
              </div>
            ) : callTranscript.map((m, i) => (
              <div key={i} className={`px-3 py-2 border-b border-line ${i%2===0?"bg-bg-1":"bg-bg-2"}`}>
                <div className={`text-[10px] uppercase tracking-widest font-bold ${m.who==="tech"?"text-amber2":"text-rust"}`}>
                  [{m.who==="tech"?"TECH":"WRENCH"}]
                </div>
                <div className="text-sm mt-1 break-words whitespace-pre-wrap">{m.text}</div>
              </div>
            ))}
          </div>

          <div className="border-t border-line p-3 bg-bg-2">
            <div className="label-shop !mb-1">PASTE / TYPE (Wrench reads it)</div>
            <div className="flex gap-2 items-end">
              <textarea
                data-testid="call-text-input"
                value={typed}
                onChange={e=>setTyped(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                rows={3}
                disabled={callState !== "connected"}
                placeholder={callState === "connected" ? "Paste a datalog, table, VIN. Cmd/Ctrl+V then ENTER." : "Start a call to enable..."}
                className="input-shop flex-1 resize-none text-xs font-mono"
              />
              <button data-testid="call-send-text" onClick={send} disabled={callState !== "connected" || !typed.trim()} className="btn-rust h-12 px-4">SEND</button>
            </div>
          </div>
        </div>
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
      {!active && state !== "connecting" && <Phone size={22} className="absolute text-rust" />}
    </div>
  );
}
