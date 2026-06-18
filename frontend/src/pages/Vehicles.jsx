import React, { useEffect, useState } from "react";
import { Plus, Trash2, Save, ScanLine, RefreshCw, Check } from "lucide-react";
import api from "@/api";

const EMPTY = { year: "", make: "", model: "", vin: "", engine: "", mods: "", notes: "" };

export default function Vehicles() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [decoding, setDecoding] = useState(false);
  const [decodeMsg, setDecodeMsg] = useState("");
  const [decodeOk, setDecodeOk] = useState(false);

  const refresh = async () => { const r = await api.get("/vehicles"); setList(r.data || []); };
  useEffect(()=>{ refresh(); }, []);

  // Auto-decode VIN when 17 characters typed/pasted
  useEffect(() => {
    const v = (form.vin || "").trim().toUpperCase();
    if (v.length === 17) {
      decodeVin(v);
    } else {
      setDecodeMsg(""); setDecodeOk(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.vin]);

  const decodeVin = async (vin) => {
    setDecoding(true); setDecodeMsg(""); setDecodeOk(false);
    try {
      const r = await api.get(`/vin/decode/${encodeURIComponent(vin)}`);
      const d = r.data || {};
      // Build engine string
      const eng = d.engine_summary || [d.engine_displacement_l && `${d.engine_displacement_l}L`, d.engine_cyl && `${d.engine_cyl}cyl`].filter(Boolean).join(" ");
      setForm(prev => ({
        ...prev,
        year: prev.year || d.year || "",
        make: prev.make || d.make || "",
        model: prev.model || (d.model + (d.trim ? ` ${d.trim}` : "")) || "",
        engine: prev.engine || eng || "",
      }));
      if (d.year && d.make) {
        setDecodeOk(true);
        setDecodeMsg(`${d.year} ${d.make} ${d.model || ""} ${d.trim || ""} · ${eng || "engine unknown"}`.trim());
      } else {
        setDecodeMsg("NHTSA returned partial data. Fill in what's missing.");
      }
    } catch (e) {
      setDecodeMsg(e?.response?.data?.detail || "VIN decode failed");
    } finally { setDecoding(false); }
  };

  const manualDecode = () => {
    const v = (form.vin || "").trim().toUpperCase();
    if (v.length >= 11) decodeVin(v);
    else setDecodeMsg("Need at least 11 VIN characters");
  };

  const save = async () => {
    if (editing) await api.put(`/vehicles/${editing}`, form);
    else await api.post("/vehicles", form);
    setForm(EMPTY); setEditing(null); setDecodeMsg(""); setDecodeOk(false);
    refresh();
  };

  const del = async (id) => {
    if (!window.confirm("Delete this vehicle?")) return;
    await api.delete(`/vehicles/${id}`);
    refresh();
  };

  const startEdit = (v) => {
    setEditing(v.id);
    setForm({ year:v.year||"",make:v.make||"",model:v.model||"",vin:v.vin||"",engine:v.engine||"",mods:v.mods||"",notes:v.notes||""});
    setDecodeMsg(""); setDecodeOk(false);
  };

  return (
    <div className="p-4 md:p-6" data-testid="vehicles-page">
      <div className="flex items-end justify-between mb-4 border-b border-line pb-4">
        <div>
          <h1 className="heading text-3xl md:text-4xl">VEHICLES <span className="text-rust">// GARAGE</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">VIN AUTO-DECODE · MODS · HISTORY</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="panel p-4">
          <div className="heading text-xl mb-3">{editing ? "EDIT VEHICLE" : "ADD VEHICLE"}</div>

          {/* VIN with auto-decode — promoted to top */}
          <div className="mb-4 border border-rust/40 bg-rust/5 p-3">
            <label className="label-shop !text-rust">VIN (TYPE OR PASTE 17 CHARS — AUTO-DECODES)</label>
            <div className="flex gap-2">
              <input
                data-testid="v-vin"
                value={form.vin}
                onChange={e=>setForm({...form, vin:e.target.value.toUpperCase()})}
                maxLength={17}
                className="input-shop font-mono uppercase tracking-widest"
                placeholder="1GCPYBEH8MZxxxxxxxx"
              />
              <button
                data-testid="v-decode"
                onClick={manualDecode}
                disabled={decoding || (form.vin||"").length < 11}
                className="btn-ghost px-3 flex items-center gap-2"
                title="Force decode"
              >
                {decoding ? <RefreshCw size={14} className="animate-spin"/> : <ScanLine size={14}/>}
                DECODE
              </button>
            </div>
            <div className="mt-2 min-h-[18px] text-[11px] uppercase tracking-widest flex items-center gap-2">
              {decoding && <span className="text-amber2 animate-blink">CONTACTING NHTSA...</span>}
              {!decoding && decodeOk && <><Check size={12} className="text-ok"/><span className="text-ok">{decodeMsg}</span></>}
              {!decoding && !decodeOk && decodeMsg && <span className="text-amber2">{decodeMsg}</span>}
              {!decoding && !decodeMsg && (form.vin||"").length > 0 && (form.vin||"").length < 17 && (
                <span className="text-ink-3">{17 - form.vin.length} MORE CHARS TO AUTO-DECODE</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div><label className="label-shop">YEAR</label><input data-testid="v-year" value={form.year} onChange={e=>setForm({...form, year:e.target.value})} className="input-shop"/></div>
            <div><label className="label-shop">MAKE</label><input data-testid="v-make" value={form.make} onChange={e=>setForm({...form, make:e.target.value})} className="input-shop"/></div>
            <div><label className="label-shop">MODEL</label><input data-testid="v-model" value={form.model} onChange={e=>setForm({...form, model:e.target.value})} className="input-shop"/></div>
          </div>
          <div className="mt-3"><label className="label-shop">ENGINE</label><input data-testid="v-engine" value={form.engine} onChange={e=>setForm({...form, engine:e.target.value})} className="input-shop" placeholder="L83 5.3 / LS3 / 6.0L LY6..."/></div>
          <div className="mt-3"><label className="label-shop">MODS</label><textarea data-testid="v-mods" value={form.mods} onChange={e=>setForm({...form, mods:e.target.value})} rows={2} className="input-shop" placeholder="Cam, headers, 80lb injectors..."/></div>
          <div className="mt-3"><label className="label-shop">NOTES</label><textarea data-testid="v-notes" value={form.notes} onChange={e=>setForm({...form, notes:e.target.value})} rows={3} className="input-shop"/></div>
          <div className="mt-4 flex gap-2">
            <button data-testid="v-save" onClick={save} className="btn-rust flex items-center gap-2"><Save size={14}/>{editing?"UPDATE":"ADD"}</button>
            {editing && <button onClick={()=>{setEditing(null); setForm(EMPTY); setDecodeMsg(""); setDecodeOk(false);}} className="btn-ghost">CANCEL</button>}
          </div>
        </div>

        <div className="panel">
          <div className="px-4 py-2 border-b border-line text-[11px] uppercase tracking-widest text-ink-3">{list.length} VEHICLES</div>
          {list.length === 0 ? (
            <div className="p-6 text-ink-3 text-sm text-center">No vehicles in the garage yet.</div>
          ) : list.map(v => (
            <div key={v.id} className="px-4 py-3 border-b border-line hover:bg-bg-3" data-testid={`v-row-${v.id}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold">{[v.year,v.make,v.model].filter(Boolean).join(" ") || "(unnamed)"}</div>
                  <div className="text-xs text-ink-2">{v.engine}</div>
                  {v.mods && <div className="text-xs text-amber2 mt-1">MODS: {v.mods}</div>}
                  {v.notes && <div className="text-xs text-ink-3 mt-1">{v.notes}</div>}
                  {v.vin && <div className="text-[10px] text-ink-3 mt-1 font-mono">VIN: {v.vin}</div>}
                </div>
                <div className="flex gap-2">
                  <button onClick={()=>startEdit(v)} className="btn-ghost text-xs">EDIT</button>
                  <button onClick={()=>del(v.id)} className="text-ink-3 hover:text-danger"><Trash2 size={14}/></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
