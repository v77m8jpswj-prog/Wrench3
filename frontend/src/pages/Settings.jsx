import React, { useEffect, useRef, useState } from "react";
import { Play, Save } from "lucide-react";
import api, { API, getToken } from "@/api";

const VOICES = ["onyx","ash","echo","fable","alloy","nova","sage","coral","shimmer"];

export default function Settings() {
  const [voice, setVoice] = useState("onyx");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [mode, setMode] = useState("direct");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(()=>{
    api.get("/auth/me").then(r => {
      const s = r.data.settings || {};
      setVoice(s.voice || "onyx");
      setVoiceEnabled(s.voice_enabled !== false);
      setMode(s.mode || "direct");
    });
  }, []);

  const save = async () => {
    setBusy(true);
    await api.put("/settings", { voice, voice_enabled: voiceEnabled, mode });
    setMsg("SETTINGS LOCKED IN");
    setBusy(false);
    setTimeout(()=>setMsg(""), 1500);
  };

  const test = async () => {
    try {
      const res = await fetch(`${API}/voice/speak`, {
        method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:`Bearer ${getToken()}` },
        body: JSON.stringify({ text: "Yeah, Doc. Wrench here. Let's get to work.", voice }),
      });
      const blob = await res.blob();
      new Audio(URL.createObjectURL(blob)).play();
    } catch {}
  };

  return (
    <div className="p-6 max-w-2xl" data-testid="settings-page">
      <div className="mb-4 border-b border-line pb-4">
        <h1 className="heading text-4xl">SETTINGS</h1>
      </div>

      <div className="panel p-4 mb-4">
        <label className="label-shop">VOICE</label>
        <div className="flex items-center gap-2">
          <select data-testid="voice-select" value={voice} onChange={e=>setVoice(e.target.value)} className="input-shop">
            {VOICES.map(v => <option key={v} value={v}>{v.toUpperCase()}</option>)}
          </select>
          <button data-testid="voice-test" onClick={test} className="btn-ghost flex items-center gap-2"><Play size={14}/>TEST</button>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <input data-testid="voice-enabled" id="ve" type="checkbox" checked={voiceEnabled} onChange={e=>setVoiceEnabled(e.target.checked)} className="accent-rust"/>
          <label htmlFor="ve" className="text-sm">SPEAK REPLIES OUT LOUD</label>
        </div>
      </div>

      <div className="panel p-4 mb-4">
        <label className="label-shop">DEFAULT RESPONSE MODE</label>
        <div className="flex gap-2">
          {["direct","dream"].map(m => (
            <button key={m} onClick={()=>setMode(m)} className={`btn-ghost ${mode===m?"!border-rust !text-rust":""}`} data-testid={`mode-${m}`}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="text-xs text-ink-3 mt-2">DIRECT = short answers. DREAM = walk through reasoning.</div>
      </div>

      <button data-testid="save-settings" onClick={save} disabled={busy} className="btn-rust flex items-center gap-2"><Save size={14}/>SAVE</button>
      {msg && <div className="mt-3 text-ok text-xs uppercase tracking-widest">{msg}</div>}
    </div>
  );
}
