import React, { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import api from "@/api";

export default function Memory() {
  const [facts, setFacts] = useState([]);
  const [text, setText] = useState("");
  const refresh = async () => { const r = await api.get("/memory"); setFacts(r.data || []); };
  useEffect(()=>{ refresh(); }, []);

  const add = async () => {
    if (!text.trim()) return;
    await api.post("/memory", { fact: text.trim() });
    setText(""); refresh();
  };
  const del = async (id) => { await api.delete(`/memory/${id}`); refresh(); };

  return (
    <div className="p-6 max-w-3xl" data-testid="memory-page">
      <div className="mb-4 border-b border-line pb-4">
        <h1 className="heading text-4xl">MEMORY <span className="text-rust">// SHOP DNA</span></h1>
        <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">PERMANENT FACTS WRENCH USES ON EVERY ANSWER</p>
      </div>

      <div className="panel p-4 mb-4">
        <label className="label-shop">ADD A FACT</label>
        <textarea data-testid="mem-input" value={text} onChange={e=>setText(e.target.value)} rows={2} className="input-shop" placeholder='e.g. "I always set idle spark to 18° on cammed LS trucks." or "My customer base is mostly 1500-2500 GM pickups."'/>
        <button data-testid="mem-add" onClick={add} className="btn-rust mt-3 flex items-center gap-2"><Plus size={14}/>SAVE FACT</button>
      </div>

      <div className="panel">
        <div className="px-4 py-2 border-b border-line text-[11px] uppercase tracking-widest text-ink-3">{facts.length} FACTS STORED</div>
        {facts.length === 0 ? (
          <div className="p-6 text-ink-3 text-sm">Nothing pinned to memory yet.</div>
        ) : facts.map(f => (
          <div key={f.id} className="px-4 py-3 border-b border-line flex items-start justify-between hover:bg-bg-3" data-testid={`fact-${f.id}`}>
            <div className="text-sm">{f.fact}</div>
            <button onClick={()=>del(f.id)} className="text-ink-3 hover:text-danger ml-3"><Trash2 size={14}/></button>
          </div>
        ))}
      </div>
    </div>
  );
}
