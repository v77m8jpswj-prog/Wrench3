import React, { useEffect, useState, useRef } from "react";
import { Check, X, Brain, Upload, RefreshCw, Sparkles, Clock } from "lucide-react";
import api from "@/api";

export default function Learn() {
  const [candidates, setCandidates] = useState([]);
  const [stats, setStats] = useState({});
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  const load = async () => {
    const [c, s, l] = await Promise.all([
      api.get("/learn/candidates"),
      api.get("/learn/stats"),
      api.get("/learn/log?limit=20"),
    ]);
    setCandidates(c.data || []);
    setStats(s.data || {});
    setLog(l.data || []);
  };

  useEffect(() => { load(); }, []);

  const act = async (id, action) => {
    await api.post(`/learn/candidates/${id}`, { action });
    setCandidates(prev => prev.filter(c => c.id !== id));
    load();
  };

  const harvest = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api.post("/learn/harvest", { since_hours: 168, limit_messages: 200 });
      setMsg(`Scanned ${r.data.processed} messages. Auto-locked ${r.data.auto_locked}, queued ${r.data.candidates}.`);
      load();
    } catch (e) {
      setMsg(e?.response?.data?.detail || "Harvest failed.");
    } finally { setBusy(false); }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setImporting(true); setMsg("");
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api.post("/learn/import/chatgpt", fd, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 600000,
      });
      setMsg(`Scanned ${r.data.conversations_scanned} convos, ${r.data.user_messages} Doc messages. Auto-locked ${r.data.auto_locked}, queued ${r.data.queued_for_review}, skipped ${r.data.already_known} already-known.`);
      load();
    } catch (e) {
      setMsg(e?.response?.data?.detail || "Import failed.");
    } finally { setImporting(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const sorted = [...candidates].sort((a,b) => (b.confidence||0) - (a.confidence||0));

  return (
    <div className="p-6 max-w-4xl" data-testid="learn-page">
      <div className="mb-4 border-b border-line pb-4">
        <h1 className="heading text-4xl flex items-center gap-3">
          <Brain className="text-amber2" size={36}/>
          LEARN <span className="text-rust">// DOC IN A BOX</span>
        </h1>
        <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">
          Wrench auto-extracts facts from your chats. Tap ✓ to lock, ✗ to skip.
        </p>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
        <StatTile label="Locked" value={stats.locked_total || 0} color="amber2"/>
        <StatTile label="Auto-Locked" value={stats.auto_locked || 0} color="ok"/>
        <StatTile label="Pending" value={stats.pending || 0} color="rust"/>
        <StatTile label="Approved" value={stats.approved || 0} color="ink-2"/>
        <StatTile label="Rejected" value={stats.rejected || 0} color="ink-3"/>
      </div>

      {/* Actions */}
      <div className="panel p-4 mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <button data-testid="harvest-btn" onClick={harvest} disabled={busy}
            className="btn-rust flex items-center gap-2 disabled:opacity-50">
            <RefreshCw size={14} className={busy ? "animate-spin" : ""}/>
            {busy ? "HARVESTING..." : "HARVEST LAST 7 DAYS"}
          </button>
          <button data-testid="import-btn" onClick={()=>fileRef.current?.click()} disabled={importing}
            className="text-xs uppercase tracking-widest border-2 border-amber2 text-amber2 px-3 py-2 flex items-center gap-1.5 hover:bg-amber2/10 disabled:opacity-50">
            <Upload size={12}/>
            {importing ? "IMPORTING..." : "IMPORT CHATGPT EXPORT (.ZIP)"}
          </button>
          <input ref={fileRef} type="file" accept=".zip" onChange={onFile} className="hidden"/>
        </div>
        {msg && <div className="mt-3 text-sm text-amber2 font-mono border-l-2 border-amber2 pl-3">{msg}</div>}
      </div>

      {/* Candidates queue */}
      <div className="mb-4">
        <h2 className="heading text-2xl mb-2">REVIEW QUEUE <span className="text-rust">//</span></h2>
        {sorted.length === 0 ? (
          <div className="panel p-6 text-center text-ink-3 text-sm uppercase tracking-widest" data-testid="no-candidates">
            Nothing pending. Wrench is caught up.
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map(c => (
              <div key={c.id} className="panel p-4 flex items-start gap-3" data-testid={`candidate-${c.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink leading-relaxed mb-2">{c.fact}</div>
                  <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-widest">
                    <span className="text-amber2 font-bold">conf {(c.confidence*100).toFixed(0)}%</span>
                    <span className="text-ink-3">seen ×{c.seen_count || 1}</span>
                    <span className="text-ink-3">[{c.category || "general"}]</span>
                    <span className="text-ink-3">{(c.sources||[]).join(", ")}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <button data-testid={`approve-${c.id}`} onClick={()=>act(c.id, "approve")}
                    className="w-10 h-10 border-2 border-ok text-ok hover:bg-ok hover:text-bg-1 flex items-center justify-center transition-colors">
                    <Check size={18}/>
                  </button>
                  <button data-testid={`reject-${c.id}`} onClick={()=>act(c.id, "reject")}
                    className="w-10 h-10 border-2 border-danger text-danger hover:bg-danger hover:text-bg-1 flex items-center justify-center transition-colors">
                    <X size={18}/>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Just Learned log */}
      {log.length > 0 && (
        <div>
          <h2 className="heading text-2xl mb-2 flex items-center gap-2">
            <Sparkles className="text-ok" size={20}/> JUST LEARNED <span className="text-rust">//</span>
          </h2>
          <div className="space-y-1">
            {log.slice(0, 15).map(l => (
              <div key={l.id} className="bg-bg-2 border-l-2 border-ok px-3 py-2 text-sm text-ink-2">
                <div className="flex items-start gap-2">
                  <Clock size={12} className="text-ink-3 mt-1 shrink-0"/>
                  <div className="flex-1">
                    <div>{l.fact}</div>
                    <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-1">
                      {l.status === "auto_locked" ? "auto-locked" : "approved"} · {(l.sources||[]).join(", ")}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, color }) {
  return (
    <div className="bg-bg-2 border border-line px-3 py-2">
      <div className={`text-2xl font-black text-${color}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-widest text-ink-3">{label}</div>
    </div>
  );
}
