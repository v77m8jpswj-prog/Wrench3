import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "@/AppContext";
import {
  MessageCircle, Phone, Wrench, BarChart3, Users, Inbox, Truck, BookOpen, Brain,
} from "lucide-react";
import api from "@/api";

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
  { to: "/learn",    label: "LEARN",     sub: "Doc in a box",         icon: Brain,         accent: "rust",   ring: "rust", badgeKey: "pending" },
];

export default function Home() {
  const app = useApp();
  const activeVeh = app?.vehicles?.find?.(v => v.id === app?.activeVehicleId);
  const [learnPending, setLearnPending] = useState(null);

  useEffect(() => {
    api.get("/learn/stats").then(r => setLearnPending(r.data?.pending || 0)).catch(() => {});
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
