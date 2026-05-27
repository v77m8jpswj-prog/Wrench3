import React, { useState, useEffect, useCallback } from "react";
import api from "@/api";
import { MessageSquare, Send, RefreshCw, CheckCheck } from "lucide-react";

export default function SmsInbox() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState({ to: "", body: "" });
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/sms/messages?limit=50");
      setRows(r.data || []);
    } catch (e) {
      setToast("Couldn't load SMS inbox.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fireTest = async () => {
    setTesting(true);
    try {
      await api.post("/sms/test", {});
      setToast("Test SMS fired to your cell.");
      setTimeout(() => setToast(""), 4000);
      load();
    } catch (e) {
      setToast(e?.response?.data?.detail || "Test failed.");
    } finally { setTesting(false); }
  };

  const send = async () => {
    if (!composing.to || !composing.body) return;
    setSending(true);
    try {
      await api.post("/sms/send", composing);
      setToast("Sent.");
      setComposing({ to: "", body: "" });
      setTimeout(() => setToast(""), 3000);
      load();
    } catch (e) {
      setToast(e?.response?.data?.detail || "Send failed (toll-free verification may still be pending).");
    } finally { setSending(false); }
  };

  const markRead = async () => {
    const ids = rows.filter(r => r.direction === "inbound" && !r.read).map(r => r.id);
    if (!ids.length) return;
    await api.post("/sms/mark-read", { ids });
    load();
  };

  return (
    <div className="min-h-screen text-ink p-4 md:p-6 max-w-4xl mx-auto" data-testid="sms-page">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <MessageSquare size={18} className="text-rust" />
          <h1 className="font-head text-lg md:text-xl uppercase tracking-widest">SMS Inbox</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fireTest} disabled={testing} data-testid="sms-test-btn" className="text-[11px] uppercase tracking-widest border border-amber2 text-amber2 px-2 py-1 hover:bg-amber2 hover:text-black disabled:opacity-50">
            {testing ? "..." : "TEST SMS"}
          </button>
          <button onClick={markRead} data-testid="sms-mark-read-btn" className="text-[11px] uppercase tracking-widest border border-line text-ink-2 px-2 py-1 flex items-center gap-1">
            <CheckCheck size={12} /> MARK READ
          </button>
          <button onClick={load} data-testid="sms-refresh-btn" className="text-[11px] uppercase tracking-widest border border-line text-ink-2 px-2 py-1 flex items-center gap-1">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""}/> REFRESH
          </button>
        </div>
      </div>

      <div className="border border-line bg-bg-1 p-3 mb-4">
        <div className="text-[10px] uppercase tracking-widest text-amber2 mb-2">COMPOSE</div>
        <div className="flex flex-col gap-2">
          <input
            data-testid="sms-to"
            type="tel"
            placeholder="+1 555-555-5555"
            value={composing.to}
            onChange={e=>setComposing(c=>({...c, to:e.target.value}))}
            className="input-shop text-sm"
          />
          <textarea
            data-testid="sms-body"
            rows={3}
            placeholder="Hi {Name}, this is Doc..."
            value={composing.body}
            onChange={e=>setComposing(c=>({...c, body:e.target.value}))}
            className="input-shop text-sm resize-none"
          />
          <button
            onClick={send}
            disabled={!composing.to || !composing.body || sending}
            data-testid="sms-send-btn"
            className="self-end text-[11px] uppercase tracking-widest border border-rust text-rust px-3 py-1.5 flex items-center gap-1 hover:bg-rust hover:text-black disabled:opacity-50"
          >
            <Send size={12} /> {sending ? "SENDING..." : "SEND"}
          </button>
          <div className="text-[10px] text-ink-3">
            Note: outbound SMS to non-verified numbers requires toll-free verification approval.
          </div>
        </div>
      </div>

      {toast && <div className="mb-3 border border-amber2 text-amber2 px-3 py-2 text-xs uppercase tracking-widest" data-testid="sms-toast">{toast}</div>}

      <div className="border border-line bg-bg-1">
        <div className="px-3 py-2 border-b border-line text-[10px] uppercase tracking-widest text-ink-3">RECENT MESSAGES ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="p-6 text-center text-ink-3 text-sm">No SMS yet. When a customer texts your toll-free, it'll land here.</div>
        ) : rows.map(r => (
          <div key={r.id} className={`px-3 py-2 border-b border-line ${r.direction==='inbound' && !r.read ? 'bg-bg-2' : ''}`} data-testid={`sms-row-${r.id}`}>
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <div className="text-[10px] uppercase tracking-widest">
                <span className={r.direction==='inbound' ? 'text-rust' : 'text-amber2'}>
                  [{r.direction==='inbound' ? 'IN' : 'OUT'}]
                </span>
                {' '}
                <span className="text-ink-2">{r.direction==='inbound' ? `from ${r.from_number}` : `to ${r.to_number}`}</span>
                {r.from_city && <span className="text-ink-3"> · {r.from_city}{r.from_state ? `, ${r.from_state}` : ''}</span>}
              </div>
              <div className="text-[9px] text-ink-3">{r.created_at ? new Date(r.created_at).toLocaleString() : ''}</div>
            </div>
            <div className="text-sm mt-1 whitespace-pre-wrap break-words">{r.body}</div>
            {r.direction === 'inbound' && (
              <button
                onClick={() => setComposing({ to: r.from_number, body: '' })}
                className="text-[10px] uppercase tracking-widest text-ink-3 hover:text-rust mt-1"
                data-testid={`sms-reply-${r.id}`}
              >
                → REPLY
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
