import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "@/api";
import {
  MessageSquare, Send, RefreshCw, ChevronLeft, User, Phone as PhoneIcon,
  Truck, Search, X,
} from "lucide-react";

/* ============================================================================
 * SMS INBOX — threaded, customer-grouped, iMessage-style two-pane view.
 *
 * Left pane: list of customers (one row per phone). Shows customer name (looked
 *            up from leads), city, last-message preview, unread badge.
 * Right pane: full conversation with the selected customer, oldest → newest,
 *            in/out bubbles, with the composer pinned to the bottom.
 *
 * On mobile (<md) only one pane is visible at a time: the list, OR — if a
 * thread is selected — the conversation with a "← BACK" button.
 *
 * Deep-link: /sms?phone=+14794345852 auto-selects that customer's thread.
 * ============================================================================ */

const digitsOnly = (s) => (s || "").replace(/\D/g, "").slice(-10);
const fmtPhone = (s) => {
  const d = digitsOnly(s);
  if (d.length !== 10) return s || "";
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
};
const timeAgo = (iso) => {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  if (s < 604800) return `${Math.floor(s/86400)}d`;
  return `${Math.floor(s/604800)}w`;
};
const initials = (name, phone) => {
  if (name) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
  }
  const d = digitsOnly(phone);
  return d.slice(-2) || "?";
};

export default function SmsInbox() {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState(null);  // last-10 digits
  const [messages, setMessages] = useState([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [search, setSearch] = useSearchParams();
  const [composeBody, setComposeBody] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [testing, setTesting] = useState(false);
  const [filter, setFilter] = useState("");
  const convoEndRef = useRef(null);

  const phoneFromUrl = search.get("phone") || "";

  const loadThreads = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/sms/threads");
      setThreads(r.data || []);
    } catch {
      setToast("Couldn't load threads.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (phoneKey) => {
    if (!phoneKey) return;
    setMsgLoading(true);
    try {
      const r = await api.get(`/sms/threads/${encodeURIComponent(phoneKey)}/messages`);
      setMessages(r.data || []);
      // Mark this thread read on the server, then refresh thread list (drops unread badge)
      await api.post(`/sms/threads/${encodeURIComponent(phoneKey)}/mark-read`, {}).catch(()=>{});
      loadThreads();
      window.dispatchEvent(new CustomEvent("wrench-sms-unread-refresh"));
    } catch {
      setToast("Couldn't load conversation.");
    } finally {
      setMsgLoading(false);
    }
  }, [loadThreads]);

  // Initial load + 20s polling for incoming messages
  useEffect(() => {
    loadThreads();
    const t = setInterval(loadThreads, 20000);
    return () => clearInterval(t);
  }, [loadThreads]);

  // Auto-select from ?phone= URL param OR first thread
  useEffect(() => {
    if (!threads.length) return;
    const want = phoneFromUrl ? digitsOnly(phoneFromUrl) : null;
    if (want) {
      const match = threads.find(t => digitsOnly(t.phone) === want);
      if (match && match.phone_key !== selectedKey) selectThread(match.phone_key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, phoneFromUrl]);

  // Load conversation when selection changes
  useEffect(() => {
    if (selectedKey) loadMessages(selectedKey);
    else setMessages([]);
  }, [selectedKey, loadMessages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (convoEndRef.current) convoEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const selectedThread = useMemo(
    () => threads.find(t => t.phone_key === selectedKey) || null,
    [threads, selectedKey]
  );

  const visibleThreads = useMemo(() => {
    if (!filter.trim()) return threads;
    const q = filter.trim().toLowerCase();
    return threads.filter(t =>
      (t.name || "").toLowerCase().includes(q) ||
      (t.phone || "").toLowerCase().includes(q) ||
      (t.last_body || "").toLowerCase().includes(q)
    );
  }, [threads, filter]);

  const selectThread = (phoneKey) => {
    setSelectedKey(phoneKey);
    // Strip the phone= URL param once a thread is selected — keeps the URL clean
    if (search.get("phone")) {
      const ns = new URLSearchParams(search);
      ns.delete("phone");
      setSearch(ns, { replace: true });
    }
  };

  const send = async () => {
    if (!selectedThread || !composeBody.trim()) return;
    setSending(true);
    try {
      await api.post("/sms/send", { to: selectedThread.phone, body: composeBody.trim() });
      setComposeBody("");
      loadMessages(selectedKey);
    } catch (e) {
      setToast(e?.response?.data?.detail || "Send failed (toll-free verification may still be pending).");
      setTimeout(() => setToast(""), 4500);
    } finally {
      setSending(false);
    }
  };

  const fireTest = async () => {
    setTesting(true);
    try {
      await api.post("/sms/test", {});
      setToast("Test SMS fired to your cell.");
      setTimeout(() => setToast(""), 3500);
      loadThreads();
    } catch (e) {
      setToast(e?.response?.data?.detail || "Test failed.");
    } finally { setTesting(false); }
  };

  return (
    <div className="h-[calc(100vh-7rem)] flex flex-col text-ink" data-testid="sms-page">
      {/* Header */}
      <div className="px-3 md:px-4 py-2 border-b border-line flex items-center gap-2 flex-shrink-0">
        <MessageSquare size={16} className="text-rust" />
        <h1 className="font-head text-base md:text-lg uppercase tracking-widest flex-1">SMS</h1>
        <button onClick={fireTest} disabled={testing} data-testid="sms-test-btn"
                className="text-[10px] uppercase tracking-widest border border-amber2 text-amber2 px-2 py-1 hover:bg-amber2 hover:text-black disabled:opacity-50">
          {testing ? "..." : "TEST"}
        </button>
        <button onClick={loadThreads} data-testid="sms-refresh-btn"
                className="text-[10px] uppercase tracking-widest border border-line text-ink-2 px-2 py-1 flex items-center gap-1">
          <RefreshCw size={11} className={loading ? "animate-spin" : ""}/>
        </button>
      </div>

      {toast && (
        <div className="mx-3 md:mx-4 mt-2 border border-amber2 text-amber2 px-3 py-1.5 text-[11px] uppercase tracking-widest" data-testid="sms-toast">{toast}</div>
      )}

      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* LEFT PANE — thread list */}
        <aside
          className={`w-full md:w-[340px] md:min-w-[280px] md:max-w-[380px] border-r border-line bg-bg-2 flex flex-col ${selectedKey ? "hidden md:flex" : "flex"}`}
          data-testid="sms-thread-list"
        >
          <div className="p-2 border-b border-line flex items-center gap-2 bg-bg-1">
            <Search size={12} className="text-ink-3 ml-1 flex-shrink-0"/>
            <input
              type="text"
              value={filter}
              onChange={e=>setFilter(e.target.value)}
              placeholder="SEARCH NAME, NUMBER, MESSAGE..."
              className="flex-1 bg-transparent text-xs text-ink placeholder:text-ink-3 outline-none uppercase tracking-widest"
              data-testid="sms-thread-search"
            />
            {filter && (
              <button onClick={()=>setFilter("")} className="text-ink-3 hover:text-rust" data-testid="sms-thread-search-clear">
                <X size={12}/>
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {visibleThreads.length === 0 ? (
              <div className="p-6 text-center text-ink-3 text-sm">
                {filter ? "No threads match." : "No SMS yet. When a customer texts your toll-free, they'll show up here, one thread per customer."}
              </div>
            ) : visibleThreads.map(t => {
              const isActive = t.phone_key === selectedKey;
              const isUnread = t.unread_count > 0;
              return (
                <button
                  key={t.phone_key}
                  onClick={()=>selectThread(t.phone_key)}
                  data-testid={`sms-thread-${t.phone_key}`}
                  className={`w-full text-left px-3 py-3 border-b border-line flex gap-3 items-start transition-colors ${isActive ? "bg-rust/15 border-l-2 border-l-rust" : isUnread ? "bg-bg-3 hover:bg-bg-3/80" : "hover:bg-bg-3/50"}`}
                >
                  <div className={`w-10 h-10 flex-shrink-0 flex items-center justify-center font-bold text-xs uppercase border ${isUnread ? "bg-rust text-black border-rust" : "bg-bg-1 text-amber2 border-line"}`}>
                    {initials(t.name, t.phone)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className={`text-sm truncate ${isUnread ? "font-bold text-white" : "text-ink"}`}>
                        {t.name || fmtPhone(t.phone)}
                      </div>
                      <div className="text-[10px] text-ink-3 flex-shrink-0">{timeAgo(t.last_at)}</div>
                    </div>
                    <div className="text-[11px] text-ink-3 truncate font-mono">
                      {t.name ? fmtPhone(t.phone) : (t.city ? `${t.city}${t.state ? ", " + t.state : ""}` : "")}
                    </div>
                    <div className={`text-xs truncate mt-0.5 ${isUnread ? "text-ink" : "text-ink-2"}`}>
                      {t.last_direction === "outbound" && <span className="text-amber2">↗ </span>}
                      {t.last_body}
                    </div>
                  </div>
                  {isUnread && (
                    <div className="bg-rust text-black text-[10px] font-bold px-1.5 py-0.5 leading-none flex-shrink-0" data-testid={`sms-thread-unread-${t.phone_key}`}>
                      {t.unread_count}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* RIGHT PANE — conversation */}
        <section
          className={`flex-1 flex-col bg-bg-1 ${selectedKey ? "flex" : "hidden md:flex"}`}
          data-testid="sms-conversation"
        >
          {!selectedThread ? (
            <div className="flex-1 flex items-center justify-center text-ink-3 text-sm p-6 text-center">
              <div>
                <MessageSquare size={32} className="mx-auto mb-3 text-ink-3 opacity-40"/>
                <div className="uppercase tracking-widest text-[11px]">PICK A CUSTOMER ON THE LEFT</div>
                <div className="text-[10px] mt-1">Each customer's messages live in their own thread.</div>
              </div>
            </div>
          ) : (
            <>
              {/* Convo header */}
              <div className="border-b border-line px-3 md:px-4 py-2 flex items-center gap-2 bg-bg-2 flex-shrink-0">
                <button
                  onClick={()=>setSelectedKey(null)}
                  className="md:hidden p-1 -ml-1 text-ink-2 hover:text-rust"
                  data-testid="sms-convo-back"
                >
                  <ChevronLeft size={18}/>
                </button>
                <div className={`w-8 h-8 flex-shrink-0 flex items-center justify-center font-bold text-[10px] uppercase border ${selectedThread.unread_count > 0 ? "bg-rust text-black border-rust" : "bg-bg-1 text-amber2 border-line"}`}>
                  {initials(selectedThread.name, selectedThread.phone)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-white truncate">{selectedThread.name || fmtPhone(selectedThread.phone)}</div>
                  <div className="text-[10px] text-ink-3 font-mono flex items-center gap-2">
                    <a href={`tel:${selectedThread.phone}`} className="hover:text-rust flex items-center gap-1" data-testid="sms-convo-call">
                      <PhoneIcon size={9}/>{fmtPhone(selectedThread.phone)}
                    </a>
                    {selectedThread.city && <span>· {selectedThread.city}{selectedThread.state ? `, ${selectedThread.state}` : ""}</span>}
                    {selectedThread.vehicle && <span className="text-amber2 flex items-center gap-1"><Truck size={9}/>{selectedThread.vehicle}</span>}
                  </div>
                </div>
                {selectedThread.lead_id ? (
                  <Link
                    to={`/leads?phone=${encodeURIComponent(selectedThread.phone)}`}
                    className="text-[10px] uppercase tracking-widest border border-amber2 text-amber2 px-2 py-1 hover:bg-amber2 hover:text-black flex items-center gap-1"
                    data-testid="sms-convo-view-lead"
                  >
                    <User size={10}/>LEAD
                  </Link>
                ) : (
                  <span className="text-[10px] uppercase tracking-widest text-ink-3 px-2 py-1 border border-line">NO LEAD</span>
                )}
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-3 md:px-6 py-4 space-y-2" data-testid="sms-convo-messages">
                {msgLoading && messages.length === 0 ? (
                  <div className="text-center text-ink-3 text-sm py-6">Loading...</div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-ink-3 text-sm py-6">No messages yet — type one below.</div>
                ) : messages.map(m => {
                  const out = m.direction === "outbound";
                  return (
                    <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`} data-testid={`sms-msg-${m.id}`}>
                      <div className={`max-w-[78%] px-3 py-2 ${out ? "bg-amber2/15 border border-amber2/40 text-ink" : "bg-bg-2 border border-line text-ink"}`}>
                        <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
                        <div className={`text-[9px] uppercase tracking-widest mt-1 ${out ? "text-amber2/70" : "text-ink-3"}`}>
                          {m.created_at ? new Date(m.created_at).toLocaleString() : ""}
                          {out && m.ok === false && <span className="text-rust ml-1">· FAILED</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={convoEndRef} />
              </div>

              {/* Composer */}
              <div className="border-t border-line p-2 md:p-3 bg-bg-2 flex-shrink-0">
                <div className="flex gap-2">
                  <textarea
                    rows={2}
                    value={composeBody}
                    onChange={e=>setComposeBody(e.target.value)}
                    onKeyDown={e=>{
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
                    }}
                    placeholder={`Reply to ${selectedThread.name || fmtPhone(selectedThread.phone)}...`}
                    className="flex-1 input-shop text-sm resize-none"
                    data-testid="sms-convo-input"
                  />
                  <button
                    onClick={send}
                    disabled={!composeBody.trim() || sending}
                    data-testid="sms-convo-send"
                    className="text-[11px] uppercase tracking-widest border border-rust text-rust px-3 hover:bg-rust hover:text-black disabled:opacity-50 flex items-center gap-1 self-stretch"
                  >
                    <Send size={12}/>{sending ? "..." : "SEND"}
                  </button>
                </div>
                <div className="text-[9px] text-ink-3 mt-1 uppercase tracking-widest">CTRL/⌘+ENTER TO SEND · TOLL-FREE VERIFICATION REQUIRED FOR UNVERIFIED NUMBERS</div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
