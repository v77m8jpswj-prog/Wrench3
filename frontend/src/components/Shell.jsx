import React, { useEffect, useState } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { MessageSquare, Grid3x3, BookOpen, Truck, Activity, Brain, Settings as Cog, LogOut, Wrench, Menu, X } from "lucide-react";
import { clearToken } from "@/api";

const NAV = [
  { to: "/", icon: MessageSquare, label: "CHAT", id: "nav-chat" },
  { to: "/charts", icon: Grid3x3, label: "CHARTS", id: "nav-charts" },
  { to: "/library", icon: BookOpen, label: "LIBRARY", id: "nav-library" },
  { to: "/datalog", icon: Activity, label: "DATALOG", id: "nav-datalog" },
  { to: "/vehicles", icon: Truck, label: "VEHICLES", id: "nav-vehicles" },
  { to: "/memory", icon: Brain, label: "MEMORY", id: "nav-memory" },
  { to: "/settings", icon: Cog, label: "SETTINGS", id: "nav-settings" },
];

export default function Shell({ user, setUser, children }) {
  const nav = useNavigate();
  const loc = useLocation();
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

  const currentLabel = (NAV.find(n => n.to === loc.pathname) || NAV[0]).label;

  return (
    <div className="min-h-screen flex flex-col bg-bg-1 text-ink relative">
      {/* Hazard stripe top */}
      <div className="h-1 hazard" />

      {/* MOBILE top bar */}
      <header className="md:hidden bg-bg-2 border-b border-line flex items-center px-3 py-2 sticky top-0 z-30" data-testid="mobile-topbar">
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
                  <span className="font-head font-bold">{n.label}</span>
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
        <main className="flex-1 overflow-auto relative z-10 min-w-0">{children}</main>
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
