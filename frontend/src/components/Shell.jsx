import React, { useEffect, useState } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { MessageSquare, Grid3x3, BookOpen, Truck, Activity, Brain, Settings as Cog, LogOut, Wrench } from "lucide-react";
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
  const [started] = useState(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

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

  const logout = () => { clearToken(); nav("/login"); };

  const elapsed = Math.floor((now - started) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="min-h-screen flex flex-col bg-bg-1 text-ink relative">
      {/* Hazard stripe top */}
      <div className="h-1 hazard" />

      <div className="flex-1 flex" style={{minHeight:"calc(100vh - 32px - 4px)"}}>
        {/* Left rail */}
        <aside className="w-[200px] border-r border-line bg-bg-2 flex flex-col" data-testid="left-rail">
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

        {/* Main */}
        <main className="flex-1 overflow-auto relative z-10">{children}</main>
      </div>

      {/* Status bar */}
      <footer className="h-8 bg-bg-3 border-t border-line flex items-center px-4 justify-between text-[11px] font-mono text-ink-2 uppercase tracking-[0.18em]" data-testid="status-bar">
        <div className="flex items-center gap-6">
          <span className="flex items-center" data-testid="status-indicator">
            <span className="dot" style={{ background: status.color }} />
            WRENCH: {status.label}
          </span>
          <span>SESSION {mm}:{ss}</span>
          <span>LIB: {libCount}</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-ink-3">PATH: {loc.pathname.toUpperCase()}</span>
          <span className="text-rust animate-blink">●</span>
        </div>
      </footer>
    </div>
  );
}
