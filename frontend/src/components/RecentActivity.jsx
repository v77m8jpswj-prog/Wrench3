import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Phone, MessageCircle, Mail, ChevronRight } from "lucide-react";
import api from "@/api";

function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso); const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h`;
  return `${Math.floor(diff/86400)}d`;
}

export default function RecentActivity() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let mounted = true;
    api.get("/dashboard/recent").then(r => { if (mounted) setData(r.data); }).catch(()=>{});
    const t = setInterval(() => api.get("/dashboard/recent").then(r => mounted && setData(r.data)).catch(()=>{}), 30000);
    return () => { mounted = false; clearInterval(t); };
  }, []);

  if (!data) return null;
  const totalCount = (data.leads?.length || 0) + (data.sms?.length || 0) + (data.ingested_emails?.length || 0);

  return (
    <div className="mb-6 max-w-3xl mx-auto" data-testid="recent-activity">
      <button onClick={()=>setOpen(o=>!o)} className="w-full px-4 py-3 border-2 border-line bg-bg-2 hover:border-rust flex items-center justify-between gap-3 text-left transition-colors" data-testid="recent-toggle">
        <span className="flex items-center gap-2">
          <Activity size={16} className="text-rust"/>
          <span className="text-xs uppercase tracking-widest font-bold text-rust">RECENT ACTIVITY</span>
          <span className="text-[10px] text-ink-3">— last 5 leads · 5 texts · 3 ingested emails</span>
        </span>
        <span className="text-ink-3 text-sm">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="border-2 border-t-0 border-line bg-bg-2 p-3 grid gap-3 md:grid-cols-3">
          {/* Leads column */}
          <div data-testid="recent-leads-col">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-amber2 font-bold mb-2">
              <Phone size={11}/>LEADS
            </div>
            {(data.leads || []).length === 0 ? (
              <div className="text-[11px] text-ink-3">No recent leads.</div>
            ) : (
              <div className="space-y-1.5">
                {data.leads.map((l) => (
                  <Link to="/leads" key={l.id} className="block px-2 py-1.5 hover:bg-bg-1 text-xs border-l-2 border-l-amber2/50" data-testid={`recent-lead-${l.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-bold">{l.name || "(unnamed)"}</span>
                      <span className="text-[10px] text-ink-3 shrink-0">{timeAgo(l.created_at)}</span>
                    </div>
                    <div className="text-[10px] text-ink-3 truncate">{l.vehicle || ""} · {l.status || ""}</div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* SMS column */}
          <div data-testid="recent-sms-col">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-rust font-bold mb-2">
              <MessageCircle size={11}/>TEXTS
            </div>
            {(data.sms || []).length === 0 ? (
              <div className="text-[11px] text-ink-3">No recent texts.</div>
            ) : (
              <div className="space-y-1.5">
                {data.sms.map((s) => {
                  const phone = s.phone || s.from_number || s.to_number || "";
                  const dirLabel = s.direction === "outbound" ? "→" : "←";
                  return (
                    <Link to="/sms" key={s.id} className="block px-2 py-1.5 hover:bg-bg-1 text-xs border-l-2 border-l-rust/50" data-testid={`recent-sms-${s.id}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[11px]">{dirLabel} {phone}</span>
                        <span className="text-[10px] text-ink-3 shrink-0">{timeAgo(s.created_at)}</span>
                      </div>
                      <div className="text-[10px] text-ink-3 truncate">{(s.body || "").slice(0, 60)}</div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {/* Emails column */}
          <div data-testid="recent-emails-col">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-amber2 font-bold mb-2">
              <Mail size={11}/>INGESTED EMAILS
            </div>
            {(data.ingested_emails || []).length === 0 ? (
              <div className="text-[11px] text-ink-3">Nothing ingested yet.</div>
            ) : (
              <div className="space-y-1.5">
                {data.ingested_emails.map((e) => (
                  <Link to="/library" key={e.id} className="block px-2 py-1.5 hover:bg-bg-1 text-xs border-l-2 border-l-amber2/50" data-testid={`recent-email-${e.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-bold">{(e.name || "").replace(/^\[Email\] /, "")}</span>
                      <span className="text-[10px] text-ink-3 shrink-0">{timeAgo(e.created_at)}</span>
                    </div>
                    <div className="text-[10px] text-ink-3 truncate">{e.source_label || ""}</div>
                    {e.summary && <div className="text-[10px] text-amber2/80 mt-0.5 line-clamp-2">{e.summary.split("\n")[0]}</div>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {totalCount === 0 && open && (
        <div className="border-2 border-t-0 border-line bg-bg-2 px-4 py-3 text-[11px] text-ink-3 text-center">
          Quiet shop. No recent activity yet.
        </div>
      )}
    </div>
  );
}
