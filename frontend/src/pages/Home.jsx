import React from "react";
import { Link } from "react-router-dom";
import { useApp } from "@/AppContext";
import { MessageCircle, Phone, Wrench, BarChart3, Users, Inbox, Truck, BookOpen, Brain } from "lucide-react";

// Clean home page — first thing Doc sees after login.
// Logo prominent, big tiles routing to the daily-use sections. No marketing fluff.

const TILES = [
  { to: "/chat",    label: "CHAT",       sub: "Talk to Wrench",         icon: MessageCircle, tone: "rust" },
  { to: "/call",    label: "CALL",       sub: "Voice • hands-free",     icon: Phone,         tone: "amber2" },
  { to: "/tune",    label: "TUNE",       sub: "HP Tuners workflow",     icon: Wrench,        tone: "rust" },
  { to: "/charts",  label: "CHARTS",     sub: "Edit any table",         icon: BarChart3,     tone: "amber2" },
  { to: "/email",   label: "EMAIL",      sub: "Outlook in-app",         icon: Inbox,         tone: "rust" },
  { to: "/team",    label: "TEAM",       sub: "Shop chat",              icon: Users,         tone: "amber2" },
  { to: "/vehicles",label: "VEHICLES",   sub: "Your garage",            icon: Truck,         tone: "rust" },
  { to: "/library", label: "LIBRARY",    sub: "PDFs, scrapes, brain",   icon: BookOpen,      tone: "amber2" },
  { to: "/learn",   label: "LEARN",      sub: "Doc in a box",           icon: Brain,         tone: "rust" },
];

export default function Home() {
  const app = useApp();
  const activeVeh = app?.vehicles?.find?.(v => v.id === app?.activeVehicleId);

  return (
    <div className="min-h-full p-4 md:p-8 max-w-5xl mx-auto" data-testid="home-page">
      {/* Logo + title */}
      <div className="flex flex-col items-center text-center mb-8 md:mb-12">
        <img src="/drunderhood-logo.jpg" alt="Dr. Underhood Live Assist" className="w-40 h-40 md:w-56 md:h-56 object-contain mb-4" data-testid="home-logo"/>
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {TILES.map(t => {
          const Icon = t.icon;
          return (
            <Link key={t.to} to={t.to} data-testid={`home-tile-${t.label.toLowerCase()}`}
              className={`group border-2 border-line hover:border-${t.tone} bg-bg-1 hover:bg-bg-2 p-4 md:p-5 flex flex-col items-center justify-center text-center aspect-square transition-colors`}
            >
              <Icon size={28} className={`text-${t.tone} mb-2`}/>
              <div className="text-amber2 font-bold uppercase tracking-widest text-sm md:text-base">{t.label}</div>
              <div className="text-ink-3 text-[10px] md:text-xs uppercase tracking-widest mt-1">{t.sub}</div>
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
