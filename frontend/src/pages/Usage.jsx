import React, { useEffect, useState } from "react";
import { DollarSign, MessageCircle, Phone, Search, Brain, TrendingDown, RefreshCw } from "lucide-react";
import api from "@/api";

export default function UsageDashboard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const r = await api.get("/usage/summary");
      setData(r.data);
      setErr("");
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't load usage.");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (err) return <div className="p-6 text-danger">{err}</div>;
  if (!data) return <div className="p-6 text-ink-3 uppercase tracking-widest">Loading...</div>;

  const period = new Date(data.period_start).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const m = data.month || {};
  const t = data.today || {};
  const c = data.cost_breakdown_usd || {};

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto" data-testid="usage-page">
      <div className="mb-4 border-b border-line pb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="heading text-3xl md:text-4xl flex items-center gap-3">
            <DollarSign className="text-amber2" size={32}/>
            USAGE <span className="text-rust">// {period}</span>
          </h1>
          <p className="text-ink-3 text-xs mt-1 uppercase tracking-widest">
            What Wrench has cost you this month. Estimates — see Profile → Universal Key for exact.
          </p>
        </div>
        <button data-testid="usage-refresh" onClick={load} disabled={refreshing}
          className="text-xs uppercase tracking-widest border-2 border-line hover:border-amber2 text-ink-2 hover:text-amber2 px-3 py-2 flex items-center gap-1.5 disabled:opacity-50">
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""}/> Refresh
        </button>
      </div>

      {/* HEADLINE — big total */}
      <div className="panel p-6 md:p-8 mb-4 border-l-4 border-amber2 bg-bg-2" data-testid="usage-total">
        <div className="text-xs uppercase tracking-widest text-ink-3 mb-2">ESTIMATED MONTH-TO-DATE</div>
        <div className="text-5xl md:text-7xl font-black text-amber2 mb-2">
          ${data.estimated_total_usd?.toFixed(2)}
        </div>
        <div className="flex items-center gap-2 text-sm text-ok">
          <TrendingDown size={14}/>
          Saved ${data.estimated_saved_usd?.toFixed(2)} from web-search cache hits
        </div>
      </div>

      {/* TODAY strip */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-bg-2 border border-line p-3" data-testid="usage-today-chats">
          <div className="text-[10px] uppercase tracking-widest text-ink-3 mb-1">Today · Chats</div>
          <div className="text-3xl font-black text-rust">{t.chats || 0}</div>
        </div>
        <div className="bg-bg-2 border border-line p-3" data-testid="usage-today-voice">
          <div className="text-[10px] uppercase tracking-widest text-ink-3 mb-1">Today · Voice Calls</div>
          <div className="text-3xl font-black text-amber2">{t.voice_sessions || 0}</div>
        </div>
      </div>

      {/* MONTH detail grid */}
      <h2 className="heading text-xl mb-2">THIS MONTH <span className="text-rust">//</span></h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <UsageRow
          icon={MessageCircle} accent="rust"
          label="Chats with Wrench"
          count={m.chats || 0}
          cost={c.chat}
          rate="~$0.015/msg"
          testid="usage-row-chats"
        />
        <UsageRow
          icon={Phone} accent="amber2"
          label="Voice Calls"
          count={m.voice_sessions || 0}
          extra={`~${m.voice_minutes_est || 0} min est`}
          cost={c.voice}
          rate="~$0.18/min"
          testid="usage-row-voice"
        />
        <UsageRow
          icon={Search} accent="rust"
          label="Web Searches"
          count={m.web_searches || 0}
          cost={c.search}
          rate="~$0.03/query"
          extra={`${m.cache_hits || 0} cache hits saved`}
          testid="usage-row-search"
        />
        <UsageRow
          icon={Brain} accent="amber2"
          label="Learn Harvests"
          count={m.harvests || 0}
          cost={c.harvest}
          rate="~$0.02/batch"
          extra="facts auto-extracted"
          testid="usage-row-harvest"
        />
      </div>

      {/* Tips */}
      <div className="panel p-4 bg-bg-2">
        <h3 className="text-amber2 text-sm font-black uppercase tracking-widest mb-2">KEEP COSTS DOWN</h3>
        <ul className="text-ink-2 text-sm space-y-1.5 list-disc pl-5">
          <li>Default to chat for routine stuff. Voice costs ~12x more per turn.</li>
          <li>Web-search cache is already saving you money — don't ask the same thing twice within 30 days.</li>
          <li>Hit Profile → Universal Key → Add Balance (or enable auto top-up) so Wrench never stops mid-job.</li>
        </ul>
        <p className="text-[11px] text-ink-3 mt-3 uppercase tracking-widest">
          {data.assumptions?.note}
        </p>
      </div>
    </div>
  );
}

function UsageRow({ icon: Icon, accent, label, count, cost, rate, extra, testid }) {
  const iconBg = accent === "rust" ? "bg-rust/15 border-rust/40 text-rust" : "bg-amber2/15 border-amber2/40 text-amber2";
  return (
    <div className="panel p-4 flex items-center gap-4" data-testid={testid}>
      <div className={`shrink-0 w-12 h-12 border-2 ${iconBg} flex items-center justify-center`}>
        <Icon size={22}/>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-amber2 font-bold uppercase tracking-widest text-sm">{label}</div>
        <div className="text-ink-3 text-[11px] uppercase tracking-widest mt-0.5">
          {rate}{extra ? ` · ${extra}` : ""}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-2xl font-black text-ink leading-none">{count}</div>
        <div className="text-amber2 text-xs font-bold mt-1">${(cost ?? 0).toFixed(2)}</div>
      </div>
    </div>
  );
}
