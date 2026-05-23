import React, { useEffect, useRef, useState } from "react";
import { Play, Save, UserPlus, Trash2, Shield, Wrench, Plus } from "lucide-react";
import api, { API, getToken } from "@/api";

const VOICES = ["onyx","ash","echo","fable","alloy","nova","sage","coral","shimmer"];

export default function Settings() {
  const [voice, setVoice] = useState("onyx");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [mode, setMode] = useState("direct");
  const [specialty, setSpecialty] = useState("general");
  const [skillLevel, setSkillLevel] = useState("master");
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
      setSpecialty(s.specialty || "general");
      setSkillLevel(s.skill_level || "master");
    });
  }, []);

  const save = async () => {
    setBusy(true);
    await api.put("/settings", { voice, voice_enabled: voiceEnabled, mode, specialty, skill_level: skillLevel });
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

      <div className="panel p-4 mb-4">
        <label className="label-shop">SPECIALTY MODE</label>
        <div className="flex gap-2 flex-wrap">
          {[
            {k:"general", label:"GENERAL"},
            {k:"tuner",   label:"TUNER (BULLETPROOF)"},
            {k:"diesel",  label:"DIESEL"},
            {k:"electrical", label:"ELECTRICAL"},
            {k:"service_writer", label:"SERVICE WRITER"},
          ].map(s => (
            <button key={s.k} onClick={()=>setSpecialty(s.k)} className={`btn-ghost text-xs ${specialty===s.k?"!border-rust !text-rust":""}`} data-testid={`spec-${s.k}`}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-ink-3 mt-2">
          {specialty==="tuner" && <span className="text-amber2">⛓ Tuner Mode forces pre-flight (OS / engine / fuel / goal) before any chart. Full-chart paste only. Hard refuses guesses.</span>}
          {specialty==="diesel" && "Diesel-bias diagnostics (CP4/CP3, DPF, EGR, VGT, regen)."}
          {specialty==="electrical" && "Circuit-first thinking (voltage drops, ground, CAN)."}
          {specialty==="service_writer" && "Customer-facing language with parts/labor ballparks."}
          {specialty==="general" && "Default mechanic — no specialty bias."}
        </div>
      </div>

      <div className="panel p-4 mb-4">
        <label className="label-shop">WHO'S ASKING (DEFAULT SKILL LEVEL)</label>
        <div className="flex gap-2 flex-wrap">
          {[{k:"master",label:"MASTER (DOC)"},{k:"journey",label:"JOURNEY (3-5YR)"},{k:"rookie",label:"ROOKIE (TRAINEE)"}].map(s => (
            <button key={s.k} onClick={()=>setSkillLevel(s.k)} className={`btn-ghost text-xs ${skillLevel===s.k?"!border-rust !text-rust":""}`} data-testid={`skill-${s.k}`}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-ink-3 mt-2">Wrench changes tone + how much hand-holding he provides.</div>
      </div>

      <button data-testid="save-settings" onClick={save} disabled={busy} className="btn-rust flex items-center gap-2"><Save size={14}/>SAVE</button>
      {msg && <div className="mt-3 text-ok text-xs uppercase tracking-widest">{msg}</div>}

      {me?.role === "owner" && <ShopProfileEditor />}
      {me?.role === "owner" && <TechManager />}
    </div>
  );
}

function ShopProfileEditor() {
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get("/shop/profile").then(r => setProfile(r.data)).catch(()=>{});
  }, []);

  if (!profile) return null;

  const update = (k, v) => setProfile(p => ({ ...p, [k]: v }));
  const updateListAt = (k, i, v) => setProfile(p => ({ ...p, [k]: p[k].map((x, idx) => idx === i ? v : x) }));
  const addItem = (k) => setProfile(p => ({ ...p, [k]: [...(p[k] || []), ""] }));
  const removeItem = (k, i) => setProfile(p => ({ ...p, [k]: p[k].filter((_, idx) => idx !== i) }));

  const save = async () => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api.put("/shop/profile", {
        name: profile.name,
        capabilities: profile.capabilities || [],
        specialties: profile.specialties || [],
        service_areas: profile.service_areas || [],
        hours: profile.hours || "",
        phone: profile.phone || "",
        address: profile.address || "",
        notes: profile.notes || "",
      });
      setProfile(r.data);
      setMsg("SHOP PROFILE SAVED");
      setTimeout(() => setMsg(""), 1800);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  const ListEditor = ({ field, label, placeholder }) => (
    <div className="mb-3">
      <label className="label-shop">{label}</label>
      <div className="space-y-1">
        {(profile[field] || []).map((val, i) => (
          <div key={i} className="flex gap-1">
            <input
              data-testid={`profile-${field}-${i}`}
              className="input-shop flex-1"
              placeholder={placeholder}
              value={val}
              onChange={e => updateListAt(field, i, e.target.value)}
            />
            <button onClick={() => removeItem(field, i)} className="btn-ghost px-2" data-testid={`profile-${field}-remove-${i}`}>
              <Trash2 size={12}/>
            </button>
          </div>
        ))}
        <button onClick={() => addItem(field)} className="btn-ghost text-xs flex items-center gap-1 mt-1" data-testid={`profile-${field}-add`}>
          <Plus size={12}/>ADD
        </button>
      </div>
    </div>
  );

  return (
    <div className="panel p-4 mt-6" data-testid="shop-profile-editor">
      <div className="flex items-center justify-between mb-3">
        <label className="label-shop !mb-0 flex items-center gap-2"><Wrench size={14} className="text-rust"/>SHOP PROFILE</label>
      </div>
      <p className="text-[11px] text-ink-3 uppercase tracking-widest mb-3">
        What this shop does. The brain shares this with the customer-facing app so it can tell people exactly what services you offer.
      </p>

      <div className="mb-3">
        <label className="label-shop">SHOP NAME</label>
        <input data-testid="profile-name" className="input-shop w-full" value={profile.name || ""} onChange={e => update("name", e.target.value)} />
      </div>

      <ListEditor field="capabilities" label="CAPABILITIES (WHAT YOU CAN DO)" placeholder="e.g. AFM/DOD delete tuning" />
      <ListEditor field="specialties" label="SPECIALTIES (WHAT YOU'RE KNOWN FOR)" placeholder="e.g. GM 5.3 V8, Duramax diesels" />
      <ListEditor field="service_areas" label="SERVICE AREAS" placeholder="e.g. Fort Smith AR" />

      <div className="mb-3">
        <label className="label-shop">PHONE</label>
        <input data-testid="profile-phone" className="input-shop w-full" value={profile.phone || ""} onChange={e => update("phone", e.target.value)} />
      </div>
      <div className="mb-3">
        <label className="label-shop">ADDRESS</label>
        <input data-testid="profile-address" className="input-shop w-full" value={profile.address || ""} onChange={e => update("address", e.target.value)} />
      </div>
      <div className="mb-3">
        <label className="label-shop">HOURS</label>
        <input data-testid="profile-hours" className="input-shop w-full" value={profile.hours || ""} onChange={e => update("hours", e.target.value)} placeholder="e.g. Mon-Fri 8-5"/>
      </div>
      <div className="mb-3">
        <label className="label-shop">SHOP NOTES (FOR THE BRAIN)</label>
        <textarea data-testid="profile-notes" className="input-shop w-full min-h-[60px]" value={profile.notes || ""} onChange={e => update("notes", e.target.value)} placeholder="Anything else the partner app should know..."/>
      </div>

      {err && <div className="text-danger text-xs mb-2">{err}</div>}
      <button data-testid="save-shop-profile" onClick={save} disabled={busy} className="btn-rust flex items-center gap-2 disabled:opacity-50">
        <Save size={14}/>{busy ? "SAVING..." : "SAVE SHOP PROFILE"}
      </button>
      {msg && <span className="ml-3 text-ok text-xs uppercase tracking-widest">{msg}</span>}
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
        {techs.length === 0 && (
          <div className="border-2 border-amber2/40 bg-amber2/5 px-3 py-3 text-xs text-amber2 uppercase tracking-widest" data-testid="techs-empty-warning">
            {typeof window !== "undefined" && /preview\.emergentagent\.com/.test(window.location.hostname)
              ? "⚠ YOU'RE ON PREVIEW. YOUR REAL TECHS LIVE ON FOREMAN.DRUNDERHOOD.COM — THEY ARE NOT GONE."
              : "No techs yet. Add the first one above."}
          </div>
        )}
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
