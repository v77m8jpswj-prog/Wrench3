import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Briefcase, Search, Pin, PinOff, CheckCircle2, RotateCcw, Trash2, Truck, Clock, MessageSquare } from "lucide-react";
import api from "@/api";
import { useApp } from "@/AppContext";

const tone = {
  open: "text-amber2 border-amber2/60",
  closed: "text-ok border-ok/60",
};

function timeAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return d.toLocaleDateString();
}

export default function Jobs() {
  const nav = useNavigate();
  const app = useApp();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open"); // open | all | closed | pinned
  const [q, setQ] = useState("");
  const [vehicleMap, setVehicleMap] = useState({});

  const refresh = async () => {
    setLoading(true);
    try {
      const [s, v] = await Promise.all([
        api.get("/chat/sessions"),
        api.get("/vehicles").catch(()=>({data: []})),
      ]);
      setSessions(s.data || []);
      const m = {};
      (v.data || []).forEach(x => { m[x.id] = x; });
      setVehicleMap(m);
    } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => {
    let arr = sessions;
    if (filter === "open") arr = arr.filter(s => (s.status || "open") === "open");
    else if (filter === "closed") arr = arr.filter(s => s.status === "closed");
    else if (filter === "pinned") arr = arr.filter(s => s.pinned);
    if (q.trim()) {
      const qq = q.toLowerCase();
      arr = arr.filter(s =>
        (s.title || "").toLowerCase().includes(qq) ||
        (s.preview || "").toLowerCase().includes(qq) ||
        (vehicleMap[s.vehicle_id]?.year || "").toString().includes(qq) ||
        (vehicleMap[s.vehicle_id]?.make || "").toLowerCase().includes(qq) ||
        (vehicleMap[s.vehicle_id]?.model || "").toLowerCase().includes(qq)
      );
    }
    // Pinned first, then by last_message_at desc
    return arr.slice().sort((a,b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.last_message_at || "").localeCompare(a.last_message_at || "");
    });
  }, [sessions, filter, q, vehicleMap]);

  const resume = (s) => {
    if (s.vehicle_id && app?.setActiveVehicleId) app.setActiveVehicleId(s.vehicle_id);
    // Set the chat session into AppContext if available, then route to /chat
    nav(`/?resume=${encodeURIComponent(s.id)}`);
  };
  const togglePin = async (s) => { await api.patch(`/chat/sessions/${s.id}`, { pinned: !s.pinned }); refresh(); };
  const close = async (s) => { await api.patch(`/chat/sessions/${s.id}`, { status: "closed" }); refresh(); };
  const reopen = async (s) => { await api.patch(`/chat/sessions/${s.id}`, { status: "open" }); refresh(); };
  const del = async (s) => {
    if (!window.confirm("Delete this job? Can't be undone.")) return;
    await api.delete(`/chat/sessions/${s.id}`); refresh();
  };

  const counts = useMemo(() => ({
    open: sessions.filter(s => (s.status || "open") === "open").length,
    closed: sessions.filter(s => s.status === "closed").length,
    pinned: sessions.filter(s => s.pinned).length,
    all: sessions.length,
  }), [sessions]);

  return (
    <div className="px-3 md:px-6 py-4 md:py-6 max-w-4xl mx-auto" data-testid="jobs-page">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="heading text-2xl md:text-3xl">JOBS <span className="text-rust">// PICK UP WHERE YOU LEFT OFF</span></h1>
          <p className="text-ink-3 text-xs uppercase tracking-widest mt-1">Tap a job to resume the chat exactly where you stopped.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3" data-testid="jobs-filters">
        {[
          {id:"open", label:`OPEN (${counts.open})`},
          {id:"pinned", label:`PINNED (${counts.pinned})`},
          {id:"closed", label:`CLOSED (${counts.closed})`},
          {id:"all", label:`ALL (${counts.all})`},
        ].map(b => (
          <button key={b.id} data-testid={`filter-${b.id}`} onClick={()=>setFilter(b.id)}
            className={`px-3 py-1.5 text-[11px] uppercase tracking-widest border ${filter===b.id?"border-rust text-rust":"border-line text-ink-2 hover:text-ink"}`}>
            {b.label}
          </button>
        ))}
      </div>

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"/>
        <input
          data-testid="jobs-search"
          value={q}
          onChange={e=>setQ(e.target.value)}
          placeholder="Search by vehicle, title, or keyword..."
          className="input-shop w-full pl-9"
        />
      </div>

      {loading ? (
        <div className="text-ink-3 text-sm p-6 text-center">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="border border-dashed border-line bg-bg-2 p-8 text-center">
          <Briefcase size={32} className="mx-auto text-rust mb-3"/>
          <div className="heading text-xl mb-2">NO JOBS HERE</div>
          <p className="text-ink-2 text-sm">Start a chat with Wrench. Each conversation becomes a job you can come back to.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(s => {
            const v = vehicleMap[s.vehicle_id];
            const veh = v ? [v.year, v.make, v.model].filter(Boolean).join(" ") : null;
            const status = s.status || "open";
            return (
              <div key={s.id} className={`border ${s.pinned?"border-rust/60":"border-line"} bg-bg-2 p-3 md:p-4`} data-testid={`job-${s.id}`}>
                <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-[10px] uppercase tracking-widest font-bold border px-1.5 py-0.5 ${tone[status] || tone.open}`}>{status}</span>
                      {s.pinned && <span className="text-[10px] uppercase tracking-widest font-bold border border-rust text-rust px-1.5 py-0.5">PINNED</span>}
                      {veh && <span className="text-amber2 text-xs uppercase tracking-widest font-bold flex items-center gap-1"><Truck size={11}/>{veh}</span>}
                    </div>
                    <div className="font-bold text-sm md:text-base break-words">{s.title || "(untitled job)"}</div>
                    {s.preview && <div className="text-xs text-ink-2 mt-1 line-clamp-2 break-words">{s.preview}</div>}
                    <div className="text-[10px] text-ink-3 mt-2 uppercase tracking-widest flex items-center gap-3 flex-wrap">
                      <span className="flex items-center gap-1"><Clock size={10}/>{timeAgo(s.last_message_at || s.created_at)}</span>
                      <span className="flex items-center gap-1"><MessageSquare size={10}/>{s.id.slice(0,6)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={()=>resume(s)} className="btn-rust flex-1 min-w-0 py-2.5 text-sm flex items-center justify-center gap-2" data-testid={`resume-${s.id}`}>
                    <RotateCcw size={14}/>RESUME
                  </button>
                  <button onClick={()=>togglePin(s)} className="btn-ghost px-3 py-2.5" data-testid={`pin-${s.id}`} title={s.pinned?"Unpin":"Pin"}>
                    {s.pinned ? <PinOff size={14}/> : <Pin size={14}/>}
                  </button>
                  {status === "open" ? (
                    <button onClick={()=>close(s)} className="btn-ghost px-3 py-2.5" data-testid={`close-${s.id}`} title="Mark closed (job done)">
                      <CheckCircle2 size={14}/>
                    </button>
                  ) : (
                    <button onClick={()=>reopen(s)} className="btn-ghost px-3 py-2.5" data-testid={`reopen-${s.id}`} title="Reopen job">
                      <RotateCcw size={14}/>
                    </button>
                  )}
                  <button onClick={()=>del(s)} className="btn-ghost px-3 py-2.5 hover:text-danger" data-testid={`del-${s.id}`} title="Delete">
                    <Trash2 size={14}/>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
