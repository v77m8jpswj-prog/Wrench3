import React, { useEffect, useState } from "react";
import { Plus, Trash2, Lock, Unlock } from "lucide-react";
import api from "@/api";

export default function Memory() {
  const [facts, setFacts] = useState([]);
  const [text, setText] = useState("");
  const [lockNew, setLockNew] = useState(false);
  const refresh = async () => { const r = await api.get("/memory"); setFacts(r.data || []); };
  useEffect(()=>{ refresh(); }, []);

  const add = async () => {
    if (!text.trim()) return;
    await api.post("/memory", { fact: text.trim(), locked: lockNew });
    setText(""); setLockNew(false); refresh();
  };
  const del = async (id) => { await api.delete(`/memory/${id}`); refresh(); };
  const toggleLock = async (f) => {
    await api.patch(`/memory/${f.id}`, { locked: !f.locked });
    refresh();
  };

  const locked = facts.filter(f => f.locked);
  const soft = facts.filter(f => !f.locked);

  return (
    <div className="p-6 max-w-3xl" data-testid="memory-page">
      <div className="mb-4 border-b border-line pb-4">
        <h1 className="heading text-4xl">MEMORY <span className="text-rust">// SHOP DNA</span></h1>
        <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">PERMANENT FACTS WRENCH USES ON EVERY ANSWER</p>
      </div>

      <div className="panel p-4 mb-4">
        <label className="label-shop">ADD A FACT OR LOCK A RULE</label>
        <textarea data-testid="mem-input" value={text} onChange={e=>setText(e.target.value)} rows={2} className="input-shop" placeholder='Fact: "My customer base is mostly GM pickups."&#10;Or LOCK a rule: tap LOCK below — Wrench will never drift from it.'/>
        <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
          <button
            data-testid="mem-toggle-lock"
            type="button"
            onClick={()=>setLockNew(v=>!v)}
            className={`text-xs uppercase tracking-widest border-2 px-3 py-2 flex items-center gap-1.5 ${lockNew ? "border-amber2 text-amber2 bg-amber2/10" : "border-line text-ink-3 hover:border-ink-2"}`}
          >
            {lockNew ? <Lock size={12}/> : <Unlock size={12}/>}
            {lockNew ? "LOCKED RULE (PRIORITY)" : "FACT (NORMAL)"}
          </button>
          <button data-testid="mem-add" onClick={add} className="btn-rust flex items-center gap-2"><Plus size={14}/>{lockNew ? "LOCK IT IN" : "SAVE FACT"}</button>
        </div>
        <p className="text-[10px] text-ink-3 mt-2 uppercase tracking-widest">Tip: type "lock this in: my rule" directly in chat and Wrench will lock it from there too.</p>
      </div>

      {locked.length > 0 && (
        <div className="panel mb-4 border-2 border-amber2/40" data-testid="locked-rules-panel">
          <div className="px-4 py-2 border-b border-amber2/30 bg-amber2/5 text-[11px] uppercase tracking-widest text-amber2 font-bold flex items-center gap-1.5">
            <Lock size={12}/>{locked.length} LOCKED RULE{locked.length>1?"S":""} — WRENCH WILL NEVER DRIFT FROM THESE
          </div>
          {locked.map(f => (
            <div key={f.id} className="px-4 py-3 border-b border-line/50 flex items-start justify-between hover:bg-bg-3 gap-2" data-testid={`fact-${f.id}`}>
              <div className="text-sm flex-1">
                <span className="text-amber2 mr-2">⛓</span>{f.fact_display || f.fact}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={()=>toggleLock(f)} title="Unlock (demote to normal fact)" className="text-amber2 hover:text-ink p-1" data-testid={`unlock-${f.id}`}><Unlock size={13}/></button>
                <button onClick={()=>del(f.id)} className="text-ink-3 hover:text-danger p-1"><Trash2 size={14}/></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="px-4 py-2 border-b border-line text-[11px] uppercase tracking-widest text-ink-3">{soft.length} NORMAL FACT{soft.length!==1?"S":""}</div>
        {soft.length === 0 ? (
          <div className="p-6 text-ink-3 text-sm">No regular facts yet.</div>
        ) : soft.map(f => (
          <div key={f.id} className="px-4 py-3 border-b border-line flex items-start justify-between hover:bg-bg-3 gap-2" data-testid={`fact-${f.id}`}>
            <div className="text-sm flex-1">{f.fact_display || f.fact}</div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={()=>toggleLock(f)} title="Lock this rule" className="text-ink-3 hover:text-amber2 p-1" data-testid={`lock-${f.id}`}><Lock size={13}/></button>
              <button onClick={()=>del(f.id)} className="text-ink-3 hover:text-danger p-1"><Trash2 size={14}/></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
