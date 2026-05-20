import React, { useEffect, useState, useRef } from "react";
import { Upload, Trash2, FileText, FileSpreadsheet, BookOpen, RefreshCw } from "lucide-react";
import api from "@/api";

export default function Library() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);

  const refresh = async () => {
    const r = await api.get("/library");
    setItems(r.data || []);
    window.dispatchEvent(new CustomEvent("wrench-libcount", { detail: r.data.length }));
  };

  useEffect(()=>{ refresh(); }, []);

  const upload = async (file) => {
    setBusy(true); setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.post("/library/upload", fd, { headers: { "Content-Type": "multipart/form-data" }});
      await refresh();
    } catch (e) { setErr(e?.response?.data?.detail || e.message); }
    finally { setBusy(false); }
  };

  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) upload(f);
  };

  const del = async (id) => {
    if (!window.confirm("Wipe this from the library?")) return;
    await api.delete(`/library/${id}`);
    refresh();
  };

  const iconFor = (k) => k === "pdf" ? FileText : k === "csv" ? FileSpreadsheet : BookOpen;

  return (
    <div className="p-6" data-testid="library-page">
      <div className="flex items-end justify-between mb-4 border-b border-line pb-4">
        <div>
          <h1 className="heading text-4xl">LIBRARY <span className="text-rust">// RAG</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">DROP MANUALS, NOTES, LOGS — WRENCH CITES THEM</p>
        </div>
        <button data-testid="upload-btn" onClick={()=>fileRef.current?.click()} className="btn-rust flex items-center gap-2"><Upload size={16}/>UPLOAD</button>
        <input ref={fileRef} type="file" hidden accept=".pdf,.txt,.md,.csv,.log" onChange={e=>e.target.files?.[0]&&upload(e.target.files[0])} data-testid="file-input"/>
      </div>

      <div
        onDragOver={e=>e.preventDefault()}
        onDrop={onDrop}
        data-testid="dropzone"
        className="border-2 border-dashed border-line p-8 text-center mb-6 hover:border-rust transition-colors">
        <Upload size={28} className="mx-auto text-ink-3 mb-2"/>
        <div className="heading text-xl">DROP FILES HERE</div>
        <div className="text-ink-3 text-xs uppercase tracking-widest mt-1">PDF · TXT · MD · CSV · LOG</div>
        {busy && <div className="text-rust mt-2 animate-blink text-xs">PROCESSING...</div>}
        {err && <div className="text-danger mt-2 text-xs">ERR: {err}</div>}
      </div>

      <div className="panel">
        <div className="px-4 py-2 border-b border-line text-[11px] uppercase tracking-widest text-ink-3 flex justify-between">
          <span>{items.length} ITEMS</span>
          <button onClick={refresh} className="hover:text-rust flex items-center gap-1"><RefreshCw size={12}/>REFRESH</button>
        </div>
        {items.length === 0 ? (
          <div className="p-6 text-ink-3 text-sm text-center">No files yet. Drop some manuals.</div>
        ) : items.map(it => {
          const Icon = iconFor(it.kind);
          return (
            <div key={it.id} className="px-4 py-3 border-b border-line flex items-center justify-between hover:bg-bg-3" data-testid={`lib-item-${it.id}`}>
              <div className="flex items-center gap-3">
                <Icon size={18} className="text-rust"/>
                <div>
                  <div className="text-sm">{it.name}</div>
                  <div className="text-[10px] text-ink-3 uppercase tracking-widest">{it.kind} · {Math.round(it.size/1024)} KB · {it.chunk_count} CHUNKS · {it.status}</div>
                </div>
              </div>
              <button onClick={()=>del(it.id)} data-testid={`del-${it.id}`} className="text-ink-3 hover:text-danger"><Trash2 size={16}/></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
