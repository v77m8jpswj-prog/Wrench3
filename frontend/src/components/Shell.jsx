import React, { useEffect, useState } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { MessageSquare, Grid3x3, BookOpen, Truck, Activity, Brain, Settings as Cog, LogOut, Wrench, Menu, X, Phone, PhoneOff, KeyRound, FolderArchive, Users, Mail, MicOff, Mic, Briefcase, Inbox, GitCompare, UserPlus } from "lucide-react";
import { clearToken } from "@/api";
import { useApp } from "@/AppContext";

const NAV = [
  { to: "/call", icon: Phone, label: "CALL", id: "nav-call" },
  { to: "/", icon: MessageSquare, label: "CHAT", id: "nav-chat" },
  { to: "/jobs", icon: Briefcase, label: "JOBS", id: "nav-jobs" },
  { to: "/email", icon: Inbox, label: "EMAIL", id: "nav-email" },
  { to: "/leads", icon: UserPlus, label: "LEADS", id: "nav-leads" },
  { to: "/team", icon: Users, label: "TEAM", id: "nav-team" },
  { to: "/cases", icon: FolderArchive, label: "CASES", id: "nav-cases" },
  { to: "/letters", icon: Mail, label: "LETTERS", id: "nav-letters" },
  { to: "/charts", icon: Grid3x3, label: "CHARTS", id: "nav-charts" },
  { to: "/tune", icon: Wrench, label: "TUNE", id: "nav-tune" },
  { to: "/library", icon: BookOpen, label: "LIBRARY", id: "nav-library" },
  { to: "/datalog", icon: Activity, label: "DATALOG", id: "nav-datalog" },
  { to: "/vehicles", icon: Truck, label: "VEHICLES", id: "nav-vehicles" },
  { to: "/memory", icon: Brain, label: "MEMORY", id: "nav-memory" },
  { to: "/vault", icon: KeyRound, label: "VAULT", id: "nav-vault" },
  { to: "/settings", icon: Cog, label: "SETTINGS", id: "nav-settings" },
];

export default function Shell({ user, setUser, children }) {
  const nav = useNavigate();
  const loc = useLocation();
  const app = useApp();
  const [status, setStatus] = useState({ label: "IDLE", color: "#52525B" });
  const [libCount, setLibCount] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const handler = (e) => setStatus(e.detail || { label: "IDLE", color: "#52525B" });
    window.addEventListener("wrench-status", handler);
    return () => window.removeEventListener("wrench-status", handler);
  }, []);

  useEffect(() => {
    const h = (e) => setLibCount(e.detail || 0);
    window.addEventListener("wrench-libcount", h);
    return () => window.removeEventListener("wrench-libcount", h);
  }, []);

  // close drawer on route change
  useEffect(() => { setDrawerOpen(false); }, [loc.pathname]);

  const logout = () => { clearToken(); nav("/login"); };

  const currentLabel = (NAV.find(n => n.to === loc.pathname) || NAV[1]).label;
  const onCallGlobal = app?.callState === "connected" || app?.callState === "connecting";
  const fmtSec = (s) => `${Math.floor((s||0)/60)}:${String((s||0)%60).padStart(2,"0")}`;

  return (
    <div className="min-h-screen flex flex-col bg-bg-1 text-ink relative">
      {/* iOS notch / Dynamic Island safe-area padding (mobile only) */}
      <div className={`md:hidden ${onCallGlobal?"bg-rust":"bg-bg-2"}`} style={{ height: "env(safe-area-inset-top)" }} />

      {/* PREVIEW-MODE banner — only shows on preview environments (never on prod foreman.*) */}
      {typeof window !== "undefined" && /preview\.emergentagent\.com|emergent\.host\/preview/.test(window.location.hostname) && (
        <div
          className="bg-amber-500 text-black px-4 py-2 text-center text-xs uppercase tracking-widest font-bold sticky top-0 z-50 border-b-2 border-black"
          data-testid="preview-banner"
        >
          ⚠ PREVIEW MODE — THIS IS NOT YOUR LIVE APP. TECHS/DATA HERE ARE SEPARATE.
          Go to <a href="https://foreman.drunderhood.com" className="underline">foreman.drunderhood.com</a> for production.
        </div>
      )}

      {/* ON CALL banner — sticky on every page when a realtime call is active */}
      {onCallGlobal && (
        <div className="bg-rust text-black flex items-center justify-between px-3 md:px-6 py-2 sticky z-40 border-b-2 border-black"
             style={{ top: "env(safe-area-inset-top)" }}
             data-testid="oncall-banner">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full bg-black animate-pulse"/>
            <span className="font-black tracking-widest text-xs uppercase">ON CALL · WRENCH</span>
            <span className="font-mono text-xs">{fmtSec(app.callSeconds)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={()=>app?.toggleCallMute?.()}
              className="bg-black/30 hover:bg-black/50 text-black px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest flex items-center gap-1"
              data-testid="banner-mute"
            >
              {app?.callMuted ? <><MicOff size={12}/> MIC OFF</> : <><Mic size={12}/> MIC ON</>}
            </button>
            <button
              onClick={()=>app?.haltWrench?.()}
              className="bg-black/30 hover:bg-black/50 text-black px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest"
              data-testid="banner-shutup"
              title="Stop Wrench from talking but keep the call open"
            >
              SHUT UP
            </button>
            <button
              onClick={()=>app?.endCall?.()}
              className="bg-black text-rust hover:bg-bg-1 px-2.5 py-1 text-[11px] font-black uppercase tracking-widest flex items-center gap-1"
              data-testid="banner-endcall"
            >
              <PhoneOff size={12}/> END
            </button>
          </div>
        </div>
      )}

      {/* Hazard stripe top */}
      <div className="h-1 hazard" />

      {/* MOBILE top bar */}
      <header
        className="md:hidden bg-bg-2 border-b border-line flex items-center px-3 py-2 sticky z-30"
        style={{ top: "env(safe-area-inset-top)" }}
        data-testid="mobile-topbar"
      >
        <button onClick={()=>setDrawerOpen(true)} data-testid="open-drawer" className="p-2 -ml-2 mr-2 text-white">
          <Menu size={22} />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-7 h-7 bg-rust flex items-center justify-center flex-shrink-0">
            <Wrench size={16} color="#000" strokeWidth={3} />
          </div>
          <div className="min-w-0">
            <div className="heading text-base leading-none tracking-tight truncate">DATA WRENCH</div>
            <div className="text-[9px] text-rust uppercase tracking-[0.18em] mt-0.5">{currentLabel}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ink-2 font-mono">
          <span className="dot" style={{ background: status.color }} />
          {status.label}
        </div>
      </header>

      <div className="flex-1 flex" style={{minHeight:"calc(100vh - 28px - 4px)"}}>
        {/* Desktop left rail */}
        <aside className="hidden md:flex w-[200px] border-r border-line bg-bg-2 flex-col" data-testid="left-rail">
          <div className="px-4 py-5 border-b border-line">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 bg-rust flex items-center justify-center" data-testid="brand-mark">
                <Wrench size={20} color="#000" strokeWidth={3} />
              </div>
              <div>
                <div className="heading text-xl leading-none tracking-tight">DATA WRENCH</div>
                <div className="text-[10px] text-ink-2 uppercase tracking-[0.2em] mt-1">AI FOREMAN</div>
              </div>
            </div>
          </div>

          <nav className="flex-1 py-3">
            {NAV.map(n => {
              const Icon = n.icon;
              const unread = (n.to === "/" && app?.callArtifacts) ? app.callArtifacts.filter(a => !a.seen).length : 0;
              return (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === "/"}
                  data-testid={n.id}
                  className={({isActive}) =>
                    `flex items-center gap-3 px-4 py-3 border-l-2 transition-colors uppercase tracking-[0.15em] text-sm
                     ${isActive ? "border-rust bg-bg-3 text-white" : "border-transparent text-ink-2 hover:text-white hover:bg-bg-3"}`}
                >
                  <Icon size={16} strokeWidth={2} />
                  <span className="font-head font-bold flex-1">{n.label}</span>
                  {unread > 0 && (
                    <span className="bg-rust text-black text-[10px] font-bold px-1.5 py-0.5 leading-none">{unread}</span>
                  )}
                </NavLink>
              );
            })}
          </nav>

          <div className="border-t border-line px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 mb-1">SIGNED IN</div>
            <div className="text-sm truncate">{user?.name || "Doc"}</div>
            <div className="text-[11px] text-ink-2 truncate">{user?.email}</div>
            <button onClick={logout} data-testid="logout-btn" className="mt-3 flex items-center gap-2 text-ink-2 hover:text-rust uppercase text-xs tracking-[0.2em]">
              <LogOut size={14} /> LOGOUT
            </button>
          </div>
        </aside>

        {/* Mobile drawer */}
        {drawerOpen && (
          <div className="md:hidden fixed inset-0 z-50 flex" data-testid="mobile-drawer">
            <aside className="w-[80%] max-w-[260px] bg-bg-2 border-r border-line flex flex-col">
              <div className="px-4 py-4 border-b border-line flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 bg-rust flex items-center justify-center">
                    <Wrench size={20} color="#000" strokeWidth={3} />
                  </div>
                  <div>
                    <div className="heading text-lg leading-none">DATA WRENCH</div>
                    <div className="text-[10px] text-ink-2 uppercase tracking-[0.2em] mt-0.5">AI FOREMAN</div>
                  </div>
                </div>
                <button data-testid="close-drawer" onClick={()=>setDrawerOpen(false)} className="text-ink-2 p-2 -mr-2"><X size={20}/></button>
              </div>
              <nav className="flex-1 py-2 overflow-auto">
                {NAV.map(n => {
                  const Icon = n.icon;
                  return (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      end={n.to === "/"}
                      data-testid={`m-${n.id}`}
                      className={({isActive}) =>
                        `flex items-center gap-3 px-4 py-4 border-l-2 uppercase tracking-[0.15em] text-base
                         ${isActive ? "border-rust bg-bg-3 text-white" : "border-transparent text-ink-2"}`}
                    >
                      <Icon size={18} strokeWidth={2} />
                      <span className="font-head font-bold">{n.label}</span>
                    </NavLink>
                  );
                })}
              </nav>
              <div className="border-t border-line px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 mb-1">SIGNED IN</div>
                <div className="text-sm truncate">{user?.name || "Doc"}</div>
                <div className="text-[11px] text-ink-2 truncate">{user?.email}</div>
                <button onClick={logout} className="mt-3 flex items-center gap-2 text-ink-2 uppercase text-xs tracking-[0.2em]">
                  <LogOut size={14} /> LOGOUT
                </button>
              </div>
            </aside>
            <div className="flex-1 bg-black/60" onClick={()=>setDrawerOpen(false)} />
          </div>
        )}

        {/* Main */}
        <main className="flex-1 overflow-auto relative z-10 min-w-0">
          {/* Persistent context bar — active vehicle + active call */}
          <ContextBar app={app} />
          {children}
        </main>
      </div>

      {/* Status bar */}
      <footer className="h-7 bg-bg-3 border-t border-line flex items-center px-3 justify-between text-[10px] font-mono text-ink-2 uppercase tracking-[0.15em]" data-testid="status-bar">
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex items-center" data-testid="status-indicator">
            <span className="dot" style={{ background: status.color }} />
            <span className="hidden xs:inline">WRENCH:&nbsp;</span>{status.label}
          </span>
          <span className="hidden sm:inline">LIB: {libCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-rust animate-blink">●</span>
        </div>
      </footer>
    </div>
  );
}

function ContextBar({ app }) {
  const nav = useNavigate();
  if (!app) return null;
  const { vehicles, activeVehicleId, setActiveVehicleId, activeVehicle, callState, callSeconds } = app;
  const onCall = callState === "connected" || callState === "connecting";
  if (vehicles.length === 0 && !onCall) return null;
  const mm = String(Math.floor(callSeconds / 60)).padStart(2, "0");
  const ss = String(callSeconds % 60).padStart(2, "0");
  return (
    <div className="border-b border-line bg-bg-2 px-3 md:px-4 py-2 flex items-center justify-between flex-wrap gap-2" data-testid="context-bar">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest text-ink-3">ACTIVE VEHICLE:</span>
        {vehicles.length === 0 ? (
          <button onClick={()=>nav("/vehicles")} className="text-[11px] text-rust uppercase tracking-widest underline">ADD ONE →</button>
        ) : (
          <>
            <select
              data-testid="active-vehicle-select"
              value={activeVehicleId}
              onChange={e=>setActiveVehicleId(e.target.value)}
              className="bg-bg-1 border border-line text-white text-xs px-2 py-1 font-mono focus:border-rust outline-none"
            >
              <option value="">— NONE —</option>
              {vehicles.map(v => (
                <option key={v.id} value={v.id}>
                  {[v.year, v.make, v.model].filter(Boolean).join(" ") || v.id.slice(0,8)}
                </option>
              ))}
            </select>
            {activeVehicle && activeVehicle.engine && (
              <span className="text-[10px] text-amber2 uppercase tracking-widest hidden md:inline">{activeVehicle.engine}</span>
            )}
            {activeVehicle && activeVehicle.mods && (
              <span className="text-[10px] text-ink-3 uppercase tracking-widest truncate max-w-[300px] hidden lg:inline">MODS: {activeVehicle.mods}</span>
            )}
            <button onClick={()=>nav("/vehicles")} className="text-[10px] text-ink-3 uppercase tracking-widest underline hover:text-rust">EDIT</button>
          </>
        )}
      </div>
      {onCall && (
        <button
          onClick={()=>nav("/call")}
          data-testid="active-call-pill"
          className="flex items-center gap-2 bg-rust text-black px-3 py-1 text-[11px] uppercase tracking-widest font-bold animate-pulseRust"
        >
          <Phone size={12}/> ON CALL · {mm}:{ss}
        </button>
      )}
    </div>
  );
}
