import React, { useEffect, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApp } from "@/AppContext";
import {
  MessageCircle, Phone, Wrench, BarChart3, Users, Inbox, Truck, BookOpen, Brain, DollarSign, Globe,
  Search, FileText, Mail, X,
} from "lucide-react";
import api from "@/api";
import PeerTokens from "@/components/PeerTokens";

// Clean home page — first thing Doc sees after login.
// Logo prominent, big tiles routing to the daily-use sections. No marketing fluff.

const TILES = [
  { to: "/chat",     label: "CHAT",      sub: "Talk to Wrench",       icon: MessageCircle, accent: "rust",   ring: "rust" },
  { to: "/call",     label: "CALL",      sub: "Voice · hands-free",   icon: Phone,         accent: "amber2", ring: "amber2" },
  { to: "/tune",     label: "TUNE",      sub: "HP Tuners workflow",   icon: Wrench,        accent: "rust",   ring: "rust" },
  { to: "/charts",   label: "CHARTS",    sub: "Edit any table",       icon: BarChart3,     accent: "amber2", ring: "amber2" },
  { to: "/email",    label: "EMAIL",     sub: "Outlook in-app",       icon: Inbox,         accent: "rust",   ring: "rust" },
  { to: "/team",     label: "TEAM",      sub: "Shop chat",            icon: Users,         accent: "amber2", ring: "amber2" },
  { to: "/vehicles", label: "VEHICLES",  sub: "Your garage",          icon: Truck,         accent: "rust",   ring: "rust" },
  { to: "/library",  label: "LIBRARY",   sub: "PDFs · scrapes",       icon: BookOpen,      accent: "amber2", ring: "amber2" },
  { to: "/watchlist",label: "WATCHLIST", sub: "Feed the brain",       icon: Globe,         accent: "rust",   ring: "rust" },
  { to: "/learn",    label: "LEARN",     sub: "Doc in a box",         icon: Brain,         accent: "rust",   ring: "rust", badgeKey: "pending" },
];

export default function Home() {
  const app = useApp();
  const navigate = useNavigate();
  const activeVeh = app?.vehicles?.find?.(v => v.id === app?.activeVehicleId);
  const [learnPending, setLearnPending] = useState(null);
  const [usage, setUsage] = useState(null);

  // ---------- Brain search ----------
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef(null);
  const onQueryChange = (val) => {
    setQ(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!val || val.trim().length < 2) { setResults(null); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get("/brain/search", { params: { q: val.trim(), limit: 12 }});
        setResults(r.data);
      } catch { setResults({ results: [], counts: { total: 0 } }); }
      finally { setSearching(false); }
    }, 300);
  };
  const clearSearch = () => { setQ(""); setResults(null); };
  const goResult = (r) => {
    if (r.type === "case" && r.case_id) navigate(`/cases?id=${r.case_id}`);
    else navigate(r.link || "/");
  };
  const resultIcon = (t) => t === "case" ? FileText : t === "email" ? Mail : BookOpen;
  const resultColor = (t) => t === "case" ? "text-rust" : t === "email" ? "text-amber2" : "text-amber2";

  useEffect(() => {
    api.get("/learn/stats").then(r => setLearnPending(r.data?.pending || 0)).catch(() => {});
    api.get("/usage/summary").then(r => setUsage(r.data)).catch(() => {});
  }, []);

  const tileBadge = (t) => {
    if (t.badgeKey === "pending" && learnPending && learnPending > 0) return learnPending;
    return null;
  };

  return (
    <div className="min-h-full p-4 md:p-8 max-w-5xl mx-auto" data-testid="home-page">
      {/* Logo + title */}
      <div className="flex flex-col items-center text-center mb-8 md:mb-10">
        <img src="/drunderhood-logo.jpg" alt="Dr. Underhood Live Assist" className="w-40 h-40 md:w-52 md:h-52 object-contain mb-4 drop-shadow-[0_8px_24px_rgba(185,28,28,0.45)]" data-testid="home-logo"/>
        <h1 className="heading text-3xl md:text-5xl tracking-widest text-amber2">
          DR. UNDERHOOD<sup className="text-base align-top">™</sup>
        </h1>
        <div className="text-rust text-sm md:text-base uppercase tracking-[0.3em] font-bold mt-1">LIVE ASSIST</div>
        <div className="text-ink-3 text-xs uppercase tracking-widest mt-3">
          Welcome back, Doc.
          {activeVeh && <> · Active vehicle: <span className="text-amber2">{activeVeh.year} {activeVeh.make} {activeVeh.model}</span></>}
        </div>
        {usage && (
          <Link to="/usage" data-testid="home-cost-pill"
            className="mt-3 inline-flex items-center gap-2 text-[11px] uppercase tracking-widest border border-amber2/40 text-amber2 px-3 py-1 hover:bg-amber2/10">
            <DollarSign size={12}/>
            ${usage.estimated_total_usd?.toFixed(2)} this month · {usage.month?.chats || 0} chats · {usage.month?.voice_sessions || 0} calls
          </Link>
        )}
      </div>

      {/* ---------- Peer Agent Tokens (Bud / OG) ---------- */}
      <PeerTokens />

      {/* ---------- Brain Search Bar ---------- */}
      <div className="mb-6 max-w-3xl mx-auto" data-testid="brain-search-wrap">
        <div className="relative">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"/>
          <input
            type="text"
            value={q}
            onChange={(e)=>onQueryChange(e.target.value)}
            placeholder="ASK THE BRAIN — search cases, library, ingested emails"
            className="w-full bg-bg-2 border-2 border-line focus:border-amber2 hover:border-amber2/60 pl-10 pr-10 py-3 text-base uppercase tracking-wider placeholder:text-ink-3 placeholder:normal-case placeholder:tracking-normal placeholder:text-sm focus:outline-none"
            data-testid="brain-search-input"
          />
          {q && (
            <button onClick={clearSearch} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-amber2 p-1" data-testid="brain-search-clear">
              <X size={16}/>
            </button>
          )}
        </div>
        {(searching || results) && (
          <div className="mt-2 border-2 border-line bg-bg-2 max-h-[60vh] overflow-y-auto" data-testid="brain-search-results">
            {searching && (
              <div className="px-4 py-3 text-xs text-ink-3 uppercase tracking-widest">searching…</div>
            )}
            {!searching && results && results.results?.length === 0 && (
              <div className="px-4 py-4 text-sm text-ink-3">No matches yet. Try a different word — vehicle, symptom, customer name, part #.</div>
            )}
            {!searching && results && results.results?.length > 0 && (
              <>
                <div className="px-4 py-2 bg-bg-1/50 border-b border-line text-[10px] uppercase tracking-widest text-ink-3 flex items-center gap-3">
                  <span>{results.counts.total} match{results.counts.total===1?"":"es"}</span>
                  {results.counts.cases > 0 && <span className="text-rust">{results.counts.cases} cases</span>}
                  {results.counts.library > 0 && <span className="text-amber2">{results.counts.library} library</span>}
                  {results.counts.email > 0 && <span className="text-amber2">{results.counts.email} email</span>}
                </div>
                <div className="divide-y divide-line">
                  {results.results.map((r, i) => {
                    const Icon = resultIcon(r.type);
                    return (
                      <button
                        key={i}
                        onClick={()=>goResult(r)}
                        className="w-full text-left px-4 py-3 hover:bg-bg-1 flex items-start gap-3 group"
                        data-testid={`brain-search-result-${i}`}
                      >
                        <div className={`shrink-0 mt-0.5 ${resultColor(r.type)}`}>
                          <Icon size={16}/>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] uppercase tracking-widest font-bold px-1.5 py-0.5 border ${r.type==="case"?"border-rust/50 text-rust":"border-amber2/50 text-amber2"}`}>{r.type}</span>
                            <span className="text-sm text-ink truncate group-hover:text-amber2">{r.title}</span>
                          </div>
                          <div className="text-xs text-ink-2 mt-1 line-clamp-2">{r.snippet}</div>
                          {r.source && <div className="text-[10px] text-ink-3 mt-1 truncate">{r.source}</div>}
                        </div>
                        <div className="shrink-0 text-[10px] text-ink-3 self-center opacity-50 group-hover:opacity-100">→</div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Quick-action grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
        {TILES.map(t => {
          const Icon = t.icon;
          const badge = tileBadge(t);
          // Static class strings so Tailwind JIT picks them up
          const iconBgClass = t.accent === "rust" ? "bg-rust/15 border-rust/40" : "bg-amber2/15 border-amber2/40";
          const iconTextClass = t.accent === "rust" ? "text-rust" : "text-amber2";
          const hoverBorderClass = t.ring === "rust" ? "hover:border-rust" : "hover:border-amber2";
          const hoverShadowClass = t.ring === "rust" ? "hover:shadow-[0_0_24px_rgba(185,28,28,0.25)]" : "hover:shadow-[0_0_24px_rgba(212,160,23,0.25)]";
          return (
            <Link key={t.to} to={t.to} data-testid={`home-tile-${t.label.toLowerCase()}`}
              className={`group relative border-2 border-line ${hoverBorderClass} ${hoverShadowClass} bg-bg-2 hover:bg-bg-1 p-5 md:p-6 flex items-center gap-4 transition-all duration-200`}
            >
              {/* Icon block */}
              <div className={`relative shrink-0 w-14 h-14 md:w-16 md:h-16 border-2 ${iconBgClass} flex items-center justify-center transition-transform group-hover:scale-105`}>
                <Icon size={28} strokeWidth={2.25} className={iconTextClass}/>
                {badge !== null && (
                  <span data-testid={`tile-badge-${t.label.toLowerCase()}`} className="absolute -top-2 -right-2 min-w-[22px] h-[22px] px-1 rounded-full bg-rust text-white text-[11px] font-black flex items-center justify-center border-2 border-bg-1">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </div>

              {/* Label + sub */}
              <div className="flex-1 min-w-0 text-left">
                <div className="text-amber2 font-black uppercase tracking-widest text-base md:text-lg leading-tight">{t.label}</div>
                <div className="text-ink-3 text-[11px] md:text-xs uppercase tracking-widest mt-1">{t.sub}</div>
              </div>

              {/* Arrow indicator */}
              <div className={`shrink-0 text-2xl font-black ${iconTextClass} opacity-30 group-hover:opacity-100 group-hover:translate-x-1 transition-all`}>→</div>
            </Link>
          );
        })}
      </div>

      <div className="text-center mt-8 text-[10px] text-ink-3 uppercase tracking-[0.2em]">
        Foreman · Built for Dr. Underhood Automotive Specialist
      </div>
    </div>
  );
}
