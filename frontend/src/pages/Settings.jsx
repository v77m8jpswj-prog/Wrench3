import React, { useEffect, useRef, useState } from "react";
import { Play, Save, UserPlus, Trash2, Shield } from "lucide-react";
import api, { API, getToken } from "@/api";

const VOICES = ["onyx","ash","echo","fable","alloy","nova","sage","coral","shimmer"];

export default function Settings() {
  const [voice, setVoice] = useState("onyx");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [mode, setMode] = useState("direct");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [me, setMe] = useState(null);

  useEffect(()=>{
    api.get("/auth/me").then(r => {
      setMe(r.data);
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
    <div className="p-4 md:p-6 max-w-2xl" data-testid="settings-page">
      <div className="mb-4 border-b border-line pb-4">
        <h1 className="heading text-3xl md:text-4xl">SETTINGS</h1>
        {me?.shop_id && (
          <div className="text-[11px] text-ink-3 uppercase tracking-widest mt-1 flex items-center gap-2">
            <Shield size={12} className="text-rust"/> SHOP: <span className="text-amber2">{me.shop_id}</span>
            <span className="ml-2">ROLE: <span className="text-amber2">{(me.role || "owner").toUpperCase()}</span></span>
          </div>
        )}
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

      {me?.role === "owner" && <TechManager />}
    </div>
  );
}

function TechManager() {
  const [techs, setTechs] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "tech" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => api.get("/techs").then(r => setTechs(r.data || []));
  useEffect(() => { refresh(); }, []);

  const add = async () => {
    setErr("");
    if (!form.email || !form.password || !form.name) { setErr("Name, email, and password are all required."); return; }
    setBusy(true);
    try {
      await api.post("/techs", form);
      setForm({ name: "", email: "", password: "", role: "tech" });
      setShowAdd(false);
      refresh();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Add failed");
    } finally { setBusy(false); }
  };

  const remove = async (id, name) => {
    if (!window.confirm(`Remove ${name} from the shop? Their login stops working immediately.`)) return;
    try { await api.delete(`/techs/${id}`); refresh(); } catch (e) { alert(e?.response?.data?.detail || "Delete failed"); }
  };

  return (
    <div className="panel p-4 mt-6" data-testid="tech-manager">
      <div className="flex items-center justify-between mb-3">
        <label className="label-shop !mb-0">SHOP TEAM ({techs.length})</label>
        <button onClick={()=>setShowAdd(s=>!s)} className="btn-ghost text-xs flex items-center gap-1" data-testid="toggle-add-tech">
          <UserPlus size={12}/>{showAdd ? "CANCEL" : "ADD TECH"}
        </button>
      </div>

      {showAdd && (
        <div className="border border-line bg-bg-1 p-3 mb-3 space-y-2" data-testid="add-tech-form">
          {err && <div className="text-danger text-xs">{err}</div>}
          <input data-testid="new-tech-name" className="input-shop" placeholder="Name (e.g. Jim)" value={form.name} onChange={e=>setForm({...form, name: e.target.value})}/>
          <input data-testid="new-tech-email" className="input-shop" placeholder="Email (login)" type="email" value={form.email} onChange={e=>setForm({...form, email: e.target.value})}/>
          <input data-testid="new-tech-password" className="input-shop" placeholder="Temp password (they can change later)" type="text" value={form.password} onChange={e=>setForm({...form, password: e.target.value})}/>
          <select data-testid="new-tech-role" className="input-shop" value={form.role} onChange={e=>setForm({...form, role: e.target.value})}>
            <option value="tech">TECH (can log cases, use Wrench)</option>
            <option value="owner">CO-OWNER (also can add/remove techs)</option>
          </select>
          <button data-testid="save-tech" onClick={add} disabled={busy} className="btn-rust w-full disabled:opacity-50">{busy ? "ADDING..." : "ADD TO SHOP"}</button>
        </div>
      )}

      <div className="space-y-1">
        {techs.map(t => (
          <div key={t.id} className="flex items-center justify-between border border-line bg-bg-1 px-3 py-2" data-testid={`tech-row-${t.id}`}>
            <div className="min-w-0">
              <div className="text-sm font-bold truncate">{t.name} <span className="text-[10px] uppercase tracking-widest text-amber2 ml-1">{t.role}</span></div>
              <div className="text-[11px] text-ink-3 truncate">{t.email}</div>
            </div>
            {t.role !== "owner" && (
              <button onClick={()=>remove(t.id, t.name)} className="text-ink-3 hover:text-danger p-1" data-testid={`remove-tech-${t.id}`}><Trash2 size={14}/></button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
