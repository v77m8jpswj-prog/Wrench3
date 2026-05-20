import React, { useEffect, useState } from "react";
import { Plus, Trash2, Save } from "lucide-react";
import api from "@/api";

const EMPTY = { year: "", make: "", model: "", vin: "", engine: "", mods: "", notes: "" };

export default function Vehicles() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  const refresh = async () => { const r = await api.get("/vehicles"); setList(r.data || []); };
  useEffect(()=>{ refresh(); }, []);

  const save = async () => {
    if (editing) {
      await api.put(`/vehicles/${editing}`, form);
    } else {
      await api.post("/vehicles", form);
    }
    setForm(EMPTY); setEditing(null);
    refresh();
  };

  const del = async (id) => {
    if (!window.confirm("Delete this vehicle?")) return;
    await api.delete(`/vehicles/${id}`);
    refresh();
  };

  const startEdit = (v) => { setEditing(v.id); setForm({ year:v.year||"",make:v.make||"",model:v.model||"",vin:v.vin||"",engine:v.engine||"",mods:v.mods||"",notes:v.notes||""}); };

  return (
    <div className="p-6" data-testid="vehicles-page">
      <div className="flex items-end justify-between mb-4 border-b border-line pb-4">
        <div>
          <h1 className="heading text-4xl">VEHICLES <span className="text-rust">// GARAGE</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">EVERY TRUCK, EVERY MOD, EVERY NOTE</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="panel p-4">
          <div className="heading text-xl mb-3">{editing ? "EDIT VEHICLE" : "ADD VEHICLE"}</div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="label-shop">YEAR</label><input data-testid="v-year" value={form.year} onChange={e=>setForm({...form, year:e.target.value})} className="input-shop"/></div>
            <div><label className="label-shop">MAKE</label><input data-testid="v-make" value={form.make} onChange={e=>setForm({...form, make:e.target.value})} className="input-shop"/></div>
            <div><label className="label-shop">MODEL</label><input data-testid="v-model" value={form.model} onChange={e=>setForm({...form, model:e.target.value})} className="input-shop"/></div>
          </div>
          <div className="mt-3"><label className="label-shop">VIN</label><input data-testid="v-vin" value={form.vin} onChange={e=>setForm({...form, vin:e.target.value})} className="input-shop"/></div>
          <div className="mt-3"><label className="label-shop">ENGINE</label><input data-testid="v-engine" value={form.engine} onChange={e=>setForm({...form, engine:e.target.value})} className="input-shop" placeholder="L83 5.3 / LS3 / 6.0L LY6..."/></div>
          <div className="mt-3"><label className="label-shop">MODS</label><textarea data-testid="v-mods" value={form.mods} onChange={e=>setForm({...form, mods:e.target.value})} rows={2} className="input-shop" placeholder="Cam, headers, 80lb injectors..."/></div>
          <div className="mt-3"><label className="label-shop">NOTES</label><textarea data-testid="v-notes" value={form.notes} onChange={e=>setForm({...form, notes:e.target.value})} rows={3} className="input-shop"/></div>
          <div className="mt-4 flex gap-2">
            <button data-testid="v-save" onClick={save} className="btn-rust flex items-center gap-2"><Save size={14}/>{editing?"UPDATE":"ADD"}</button>
            {editing && <button onClick={()=>{setEditing(null); setForm(EMPTY);}} className="btn-ghost">CANCEL</button>}
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
                  {v.vin && <div className="text-[10px] text-ink-3 mt-1">VIN: {v.vin}</div>}
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
