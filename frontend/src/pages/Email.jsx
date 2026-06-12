import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Mail, Inbox, Send, Search, Archive, Reply, Bot, RefreshCw, X, AlertTriangle, CheckCircle2, Plus, Trash2, Edit3, BrainCircuit } from "lucide-react";
import api from "@/api";

function timeAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  if (s < 604800) return `${Math.floor(s/86400)}d`;
  return d.toLocaleDateString();
}

export default function Email() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [err, setErr] = useState("");
  const [composing, setComposing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [flash, setFlash] = useState("");
  const [drafts, setDrafts] = useState([]);
  const [reviewingDraft, setReviewingDraft] = useState(null);

  const refreshStatus = async () => {
    try { const r = await api.get("/email/status"); setStatus(r.data); }
    catch (e) { setErr(e?.response?.data?.detail || "Status check failed"); }
  };

  const refreshList = async () => {
    if (!status?.connected) return;
    setLoadingList(true); setErr("");
    try {
      let r;
      if (searchMode && q.trim()) {
        r = await api.get(`/email/search?q=${encodeURIComponent(q.trim())}&top=50`);
        setMsgs(r.data.messages || []);
      } else {
        r = await api.get(`/email/messages?top=50&unread_only=${unreadOnly}`);
        setMsgs(r.data.messages || []);
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to load inbox");
    } finally { setLoadingList(false); }
  };

  useEffect(() => { refreshStatus(); }, []);
  useEffect(() => { if (status?.connected) refreshList(); /* eslint-disable-next-line */ }, [status?.connected, unreadOnly]);

  const refreshDrafts = async () => {
    if (!status?.connected) return;
    try { const r = await api.get("/email/drafts"); setDrafts(r.data || []); } catch {/*ignore*/}
  };
  useEffect(() => { if (status?.connected) { refreshDrafts(); const t = setInterval(refreshDrafts, 30000); return () => clearInterval(t); } /* eslint-disable-next-line */ }, [status?.connected]);

  // Handle ?status=connected redirect from oauth/callback
  useEffect(() => {
    const s = params.get("status");
    if (s === "connected") {
      const em = params.get("email");
      setFlash(`Inbox connected: ${em || "Outlook"}`);
      setParams({}, { replace: true });
      refreshStatus();
      setTimeout(() => setFlash(""), 3500);
    } else if (s === "error") {
      setErr(`Connection failed: ${params.get("msg") || "unknown"}`);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const connect = async () => {
    setErr("");
    try {
      const r = await api.get("/email/oauth/start");
      window.location.href = r.data.authorization_url;
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't start Microsoft sign-in");
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Outlook? You'll lose access until you reconnect.")) return;
    await api.post("/email/disconnect");
    setSelected(null); setMsgs([]); refreshStatus();
  };

  const openMessage = async (m) => {
    try {
      const r = await api.get(`/email/messages/${m.id}`);
      setSelected(r.data);
      if (!m.isRead) {
        // Mark read in background; update local state
        api.post(`/email/messages/${m.id}/read`, { is_read: true }).catch(()=>{});
        setMsgs(prev => prev.map(x => x.id === m.id ? { ...x, isRead: true } : x));
      }
    } catch (e) { setErr(e?.response?.data?.detail || "Couldn't open message"); }
  };

  const archive = async (m) => {
    try {
      await api.post(`/email/messages/${m.id}/move`, { destination: "archive" });
      setMsgs(prev => prev.filter(x => x.id !== m.id));
      if (selected?.id === m.id) setSelected(null);
      setFlash("Archived"); setTimeout(()=>setFlash(""), 1500);
    } catch (e) { setErr(e?.response?.data?.detail || "Move failed"); }
  };

  const [ingesting, setIngesting] = useState(null); // message id being ingested
  const ingest = async (m) => {
    if (ingesting) return;
    setIngesting(m.id); setErr("");
    try {
      const r = await api.post(`/email/messages/${m.id}/ingest`);
      const links = r.data?.links_ingested || 0;
      const chars = r.data?.email_chars || 0;
      setFlash(`INGESTED — ${chars} chars + ${links} link${links===1?"":"s"} into brain`);
      setTimeout(()=>setFlash(""), 3000);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Ingest failed");
    } finally { setIngesting(null); }
  };

  // ---------- AUTO-INGEST RULES ----------
  const [rules, setRules] = useState([]);
  const [showRules, setShowRules] = useState(false);
  const refreshRules = async () => {
    if (!status?.connected) return;
    try { const r = await api.get("/email/ingest-rules"); setRules(r.data?.rules || []); } catch {/*ignore*/}
  };
  useEffect(() => { if (status?.connected) refreshRules(); /* eslint-disable-next-line */ }, [status?.connected]);

  const autoIngestSender = async (m) => {
    const sender = m.from?.emailAddress?.address || "";
    if (!sender) return;
    if (!window.confirm(`Auto-ingest all future emails from ${sender}?`)) return;
    try {
      await api.post("/email/ingest-rules", { sender_pattern: sender, label: `From: ${sender}` });
      setFlash(`AUTO-INGEST RULE ADDED — ${sender}`);
      setTimeout(()=>setFlash(""), 2500);
      refreshRules();
    } catch (e) { setErr(e?.response?.data?.detail || "Couldn't add rule"); }
  };

  const toggleRule = async (id) => {
    try { await api.patch(`/email/ingest-rules/${id}/toggle`); refreshRules(); }
    catch (e) { setErr(e?.response?.data?.detail || "Toggle failed"); }
  };
  const deleteRule = async (id) => {
    if (!window.confirm("Delete this auto-ingest rule?")) return;
    try { await api.delete(`/email/ingest-rules/${id}`); refreshRules(); }
    catch (e) { setErr(e?.response?.data?.detail || "Delete failed"); }
  };

  // -------------- Render --------------
  if (!status) {
    return <div className="p-6 text-ink-3 text-sm">Loading email status...</div>;
  }

  // Not configured (env vars missing)
  if (!status.configured) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto" data-testid="email-not-configured">
        <h1 className="heading text-2xl md:text-3xl mb-3">EMAIL <span className="text-rust">// NEEDS SETUP</span></h1>
        <div className="panel p-4 border-l-4 border-amber2">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="text-amber2 mt-0.5 shrink-0"/>
            <div>
              <div className="font-bold mb-2">Microsoft credentials aren't wired up yet.</div>
              <p className="text-sm text-ink-2 mb-2">
                I built the email module but it needs three values from your Microsoft 365 / Azure account before it'll work:
              </p>
              <ul className="text-sm text-ink-2 list-disc ml-5 space-y-1 mb-3">
                <li><code className="text-amber2">MS_CLIENT_ID</code></li>
                <li><code className="text-amber2">MS_CLIENT_SECRET</code></li>
                <li>(MS_REDIRECT_URI is already set)</li>
              </ul>
              <p className="text-sm text-ink-2">Get those from <a href="https://portal.azure.com" target="_blank" rel="noreferrer" className="underline text-amber2">Azure Portal → App registrations</a> (15 min, all clicks, no code). Tell Wrench in chat when you've got them and he'll walk you through pasting them in.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Configured but not connected
  if (!status.connected) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto" data-testid="email-not-connected">
        <h1 className="heading text-2xl md:text-3xl mb-1">EMAIL <span className="text-rust">// CONNECT INBOX</span></h1>
        <p className="text-ink-3 text-xs uppercase tracking-widest mb-6">Wrench reads, drafts, sends — like a shop manager who never sleeps.</p>

        {err && <div className="mb-4 border border-danger bg-danger/10 text-danger text-sm p-3" data-testid="email-err">{err}</div>}

        <div className="panel p-6 text-center">
          <Mail size={40} className="mx-auto text-rust mb-3"/>
          <div className="heading text-xl mb-2">CONNECT YOUR OUTLOOK INBOX</div>
          <p className="text-sm text-ink-2 mb-5">
            One tap. Microsoft handles the sign-in.<br/>You never type a password into this app.
          </p>
          <button onClick={connect} data-testid="email-connect-btn" className="btn-rust px-6 py-3 text-sm inline-flex items-center gap-2">
            <Mail size={14}/>SIGN IN WITH MICROSOFT
          </button>
          <div className="mt-4 text-[10px] text-ink-3 uppercase tracking-widest">
            Permissions requested: read mail · send mail · mark read · keep you signed in
          </div>
        </div>
      </div>
    );
  }

  // Connected — full inbox UI
  return (
    <div className="p-3 md:p-6 max-w-6xl mx-auto" data-testid="email-page">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="heading text-2xl md:text-3xl">EMAIL <span className="text-rust">// INBOX</span></h1>
          <div className="text-[11px] text-ink-3 uppercase tracking-widest mt-1 flex items-center gap-2 flex-wrap">
            <span>{status.account_email}</span>
            <span className="text-ink-3">·</span>
            <button onClick={disconnect} className="text-ink-3 hover:text-danger" data-testid="email-disconnect">DISCONNECT</button>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={()=>{setShowRules(s=>!s); refreshRules();}} className={`btn-ghost text-xs flex items-center gap-1 ${rules.filter(r=>r.enabled).length>0?"border-amber2 text-amber2":""}`} data-testid="email-rules-toggle">
            <BrainCircuit size={12}/>AUTO ({rules.filter(r=>r.enabled).length})
          </button>
          <button onClick={refreshList} className="btn-ghost text-xs flex items-center gap-1" data-testid="email-refresh"><RefreshCw size={12}/>REFRESH</button>
          <button onClick={()=>setComposing(true)} className="btn-rust text-sm flex items-center gap-2" data-testid="email-compose"><Plus size={14}/>COMPOSE</button>
        </div>
      </div>

      {showRules && (
        <div className="mb-3 border border-amber2/40 bg-amber2/5" data-testid="auto-ingest-panel">
          <div className="px-3 py-2 bg-amber2/10 border-b border-amber2/30 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BrainCircuit size={14} className="text-amber2"/>
              <div className="text-xs uppercase tracking-widest font-bold text-amber2">AUTO-INGEST RULES — wrench reads these on arrival</div>
            </div>
            <button onClick={()=>setShowRules(false)} className="text-ink-3 hover:text-ink p-1" data-testid="auto-ingest-close"><X size={14}/></button>
          </div>
          <div className="p-3">
            {rules.length === 0 ? (
              <div className="text-xs text-ink-3">
                No rules yet. Open an email and tap <span className="text-amber2 font-bold">AUTO</span> to auto-ingest everything from that sender. Checks inbox every 5 min.
              </div>
            ) : (
              <div className="divide-y divide-amber2/20">
                {rules.map(r => (
                  <div key={r.id} className="py-2 flex items-center gap-2" data-testid={`auto-rule-${r.id}`}>
                    <span className={`text-[10px] uppercase tracking-widest px-1.5 py-0.5 border ${r.enabled?"border-ok text-ok":"border-ink-3 text-ink-3"}`}>
                      {r.enabled?"ON":"OFF"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{r.label || (r.sender_pattern || r.subject_pattern)}</div>
                      <div className="text-[10px] text-ink-3 truncate">
                        {r.sender_pattern && <>from: <span className="text-amber2">{r.sender_pattern}</span>{r.subject_pattern && " · "}</>}
                        {r.subject_pattern && <>subj: <span className="text-amber2">{r.subject_pattern}</span></>}
                        {r.ingest_count > 0 && <span className="text-ok ml-2">{r.ingest_count} ingested</span>}
                      </div>
                    </div>
                    <button onClick={()=>toggleRule(r.id)} className="text-xs px-2 py-1 text-ink-2 hover:text-amber2" data-testid={`auto-rule-toggle-${r.id}`}>{r.enabled?"PAUSE":"RESUME"}</button>
                    <button onClick={()=>deleteRule(r.id)} className="text-ink-3 hover:text-danger p-1" data-testid={`auto-rule-del-${r.id}`}><Trash2 size={14}/></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {flash && <div className="mb-3 border border-ok bg-ok/10 text-ok text-xs uppercase tracking-widest p-2" data-testid="email-flash">{flash}</div>}
      {err && <div className="mb-3 border border-danger bg-danger/10 text-danger text-sm p-2" data-testid="email-err">{err}</div>}

      {drafts.length > 0 && (
        <div className="mb-3 border-2 border-amber2 bg-amber2/5" data-testid="brain-drafts-strip">
          <div className="px-3 py-2 bg-amber2/10 border-b border-amber2/30 flex items-center gap-2">
            <Bot size={14} className="text-amber2"/>
            <div className="text-xs uppercase tracking-widest font-bold text-amber2">{drafts.length} DRAFT{drafts.length>1?"S":""} FROM BRAIN — REVIEW BEFORE SENDING</div>
          </div>
          <div className="divide-y divide-amber2/20 max-h-60 overflow-auto">
            {drafts.map(d => (
              <button
                key={d.id}
                onClick={()=>setReviewingDraft(d)}
                data-testid={`brain-draft-${d.id}`}
                className="w-full text-left px-3 py-2 hover:bg-amber2/10 flex items-start gap-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {d.classification && <span className="text-[9px] uppercase tracking-widest font-bold border border-amber2/60 text-amber2 px-1.5 py-0.5">{d.classification}</span>}
                    <span className="text-xs text-ink-2">{timeAgo(d.created_at)}</span>
                  </div>
                  {d.notes_for_doc && <div className="text-[11px] text-ink-2 mt-1 italic">"{d.notes_for_doc}"</div>}
                  <div className="text-sm truncate mt-1">{d.subject || "(no subject)"}</div>
                </div>
                <Edit3 size={14} className="text-amber2 shrink-0 mt-1"/>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 mb-3">
        <button onClick={()=>{setSearchMode(false); setUnreadOnly(false);}} className={`px-3 py-1.5 text-[11px] uppercase tracking-widest border ${!searchMode && !unreadOnly?"border-rust text-rust":"border-line text-ink-2"}`} data-testid="email-filter-all">ALL</button>
        <button onClick={()=>{setSearchMode(false); setUnreadOnly(true);}} className={`px-3 py-1.5 text-[11px] uppercase tracking-widest border ${!searchMode && unreadOnly?"border-rust text-rust":"border-line text-ink-2"}`} data-testid="email-filter-unread">UNREAD</button>
        <form onSubmit={(e)=>{e.preventDefault(); setSearchMode(true); refreshList();}} className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"/>
          <input
            data-testid="email-search"
            value={q}
            onChange={e=>setQ(e.target.value)}
            placeholder="Search mailbox..."
            className="input-shop w-full pl-9 text-sm"
          />
        </form>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* Inbox list — hidden on mobile when an email is selected */}
        <div className={`md:col-span-5 lg:col-span-4 border border-line bg-bg-2 ${selected ? "hidden md:block" : ""}`}>
          {loadingList ? (
            <div className="p-6 text-center text-ink-3 text-sm">Loading...</div>
          ) : msgs.length === 0 ? (
            <div className="p-6 text-center text-ink-3 text-sm">No messages.</div>
          ) : (
            <div className="divide-y divide-line max-h-[70vh] overflow-auto">
              {msgs.map(m => (
                <div
                  key={m.id}
                  onClick={()=>openMessage(m)}
                  className={`px-3 py-2 cursor-pointer hover:bg-bg-1 ${selected?.id===m.id?"bg-bg-1 border-l-2 border-l-rust":""} ${!m.isRead?"font-bold":""}`}
                  data-testid={`email-msg-${m.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-amber2 truncate min-w-0 flex-1">{m.from?.emailAddress?.address || "(unknown)"}</div>
                    <div className="text-[10px] text-ink-3 shrink-0">{timeAgo(m.receivedDateTime)}</div>
                  </div>
                  <div className="text-sm truncate">{m.subject || "(no subject)"}</div>
                  <div className="text-[11px] text-ink-3 truncate">{m.bodyPreview || ""}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Reading pane — hidden on mobile when nothing is selected */}
        <div className={`md:col-span-7 lg:col-span-8 border border-line bg-bg-2 min-h-[70vh] ${!selected ? "hidden md:block" : ""}`}>
          {!selected ? (
            <div className="p-8 text-center text-ink-3 text-sm">Tap a message on the left.</div>
          ) : (
            <div className="flex flex-col h-full max-h-[80vh]">
              {/* Mobile-only back button */}
              <div className="md:hidden border-b border-line">
                <button onClick={()=>setSelected(null)} className="w-full text-left px-3 py-2 text-xs uppercase tracking-widest text-amber2 hover:bg-amber2/10 flex items-center gap-2" data-testid="email-back-to-inbox">
                  ← BACK TO INBOX
                </button>
              </div>
              <div className="p-3 md:p-4 border-b border-line">
                <div className="text-sm md:text-base font-bold mb-1 break-words">{selected.subject || "(no subject)"}</div>
                <div className="text-[11px] text-ink-3 mb-2">
                  From: <span className="text-amber2">{selected.from?.emailAddress?.address}</span> · {timeAgo(selected.receivedDateTime)}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={()=>setReplying(true)} className="btn-rust text-xs flex items-center gap-1 px-3 py-1.5" data-testid="email-reply-btn"><Reply size={12}/>REPLY</button>
                  <button onClick={()=>ingest(selected)} disabled={ingesting===selected.id} className="btn-ghost text-xs flex items-center gap-1 px-3 py-1.5 border-amber2 text-amber2 hover:bg-amber2/10 disabled:opacity-50" data-testid="email-ingest-btn">
                    <BrainCircuit size={12}/>{ingesting===selected.id ? "INGESTING..." : "INGEST"}
                  </button>
                  <button onClick={()=>autoIngestSender(selected)} className="btn-ghost text-xs flex items-center gap-1 px-3 py-1.5 border-amber2/60 text-amber2/80 hover:bg-amber2/10" data-testid="email-auto-ingest-btn" title="Always ingest from this sender">
                    <BrainCircuit size={12}/>AUTO
                  </button>
                  <button onClick={()=>archive(selected)} className="btn-ghost text-xs flex items-center gap-1 px-3 py-1.5" data-testid="email-archive-btn"><Archive size={12}/>ARCHIVE</button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-3 md:p-4">
                <div
                  className="text-sm prose prose-invert max-w-none email-body"
                  dangerouslySetInnerHTML={{__html: (selected.body?.content || "")}}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {composing && <ComposeModal onClose={()=>setComposing(false)} onSent={()=>{ setComposing(false); setFlash("Sent."); setTimeout(()=>setFlash(""), 1800); }} />}
      {replying && selected && <ReplyModal message={selected} onClose={()=>setReplying(false)} onSent={()=>{ setReplying(false); setFlash("Replied."); setTimeout(()=>setFlash(""), 1800); }} />}
      {reviewingDraft && (
        <BrainDraftReviewModal
          draft={reviewingDraft}
          onClose={()=>setReviewingDraft(null)}
          onSent={()=>{ setReviewingDraft(null); setFlash("Reply sent."); refreshDrafts(); setTimeout(()=>setFlash(""), 1800); }}
          onDiscarded={()=>{ setReviewingDraft(null); refreshDrafts(); }}
        />
      )}
    </div>
  );
}

function BrainDraftReviewModal({ draft, onClose, onSent, onDiscarded }) {
  const [body, setBody] = useState(draft.body_html || "");
  const [subject, setSubject] = useState(draft.subject || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const saveEdits = async () => {
    await api.put(`/email/drafts/${draft.id}`, { subject, body_html: body });
  };

  const send = async () => {
    setErr(""); setBusy(true);
    try {
      await saveEdits();
      await api.post(`/email/drafts/${draft.id}/send`);
      onSent();
    } catch (e) { setErr(e?.response?.data?.detail || "Send failed"); }
    finally { setBusy(false); }
  };

  const discard = async () => {
    if (!window.confirm("Discard this draft? You can't get it back.")) return;
    setBusy(true);
    try {
      await api.post(`/email/drafts/${draft.id}/discard`);
      onDiscarded();
    } catch (e) { setErr(e?.response?.data?.detail || "Discard failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose} data-testid="brain-draft-review">
      <div className="bg-bg-1 border-t-2 md:border-2 border-amber2 w-full md:max-w-xl max-h-[92vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="p-4 border-b border-line flex items-center justify-between sticky top-0 bg-bg-1">
          <div className="flex items-center gap-2">
            <Bot size={18} className="text-amber2"/>
            <div>
              <h2 className="heading text-lg">BRAIN DRAFT — REVIEW</h2>
              {draft.classification && <div className="text-[10px] text-amber2 uppercase tracking-widest mt-1">CLASSIFIED AS: {draft.classification.toUpperCase()}</div>}
            </div>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink p-1" data-testid="brain-draft-close"><X size={18}/></button>
        </div>
        <div className="p-4 space-y-3">
          {draft.notes_for_doc && (
            <div className="border border-amber2/40 bg-amber2/5 p-2 text-sm italic text-amber2">
              "{draft.notes_for_doc}"
            </div>
          )}
          {err && <div className="text-danger text-xs">{err}</div>}
          <div>
            <label className="label-shop">SUBJECT (OPTIONAL)</label>
            <input data-testid="brain-draft-subject" className="input-shop w-full" value={subject} onChange={e=>setSubject(e.target.value)}/>
          </div>
          <div>
            <label className="label-shop">REPLY BODY (EDIT BEFORE SENDING IF YOU WANT)</label>
            <textarea data-testid="brain-draft-body" rows={10} className="input-shop w-full font-mono text-sm" value={body} onChange={e=>setBody(e.target.value)}/>
          </div>
        </div>
        <div className="p-4 border-t border-line bg-bg-2 flex gap-2" style={{paddingBottom: "calc(1rem + env(safe-area-inset-bottom))"}}>
          <button data-testid="brain-draft-send" onClick={send} disabled={busy} className="btn-rust flex-1 py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
            <Send size={14}/>{busy ? "SENDING..." : "SEND REPLY"}
          </button>
          <button data-testid="brain-draft-discard" onClick={discard} disabled={busy} className="btn-ghost px-4 py-3 text-sm text-ink-3 hover:text-danger flex items-center gap-2">
            <Trash2 size={14}/>DISCARD
          </button>
        </div>
      </div>
    </div>
  );
}

function ComposeModal({ onClose, onSent }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const send = async () => {
    setErr("");
    if (!to.trim() || !subject.trim() || !body.trim()) { setErr("To, subject, and body are all required."); return; }
    setBusy(true);
    try {
      const toList = to.split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(email => ({ email }));
      const bodyHtml = body.includes("<") ? body : body.split("\n").map(l => `<p>${l || "&nbsp;"}</p>`).join("");
      await api.post("/email/send", { subject, body_html: bodyHtml, to: toList, save_to_sent: true });
      onSent();
    } catch (e) { setErr(e?.response?.data?.detail || "Send failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose} data-testid="compose-modal">
      <div className="bg-bg-1 border-t-2 md:border-2 border-rust w-full md:max-w-xl max-h-[92vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="p-4 border-b border-line flex items-center justify-between sticky top-0 bg-bg-1">
          <h2 className="heading text-lg flex items-center gap-2"><Send size={16} className="text-rust"/>NEW EMAIL</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink p-1" data-testid="compose-close"><X size={18}/></button>
        </div>
        <div className="p-4 space-y-3">
          {err && <div className="text-danger text-xs">{err}</div>}
          <div>
            <label className="label-shop">TO</label>
            <input data-testid="compose-to" className="input-shop w-full" placeholder="customer@example.com" value={to} onChange={e=>setTo(e.target.value)}/>
          </div>
          <div>
            <label className="label-shop">SUBJECT</label>
            <input data-testid="compose-subject" className="input-shop w-full" value={subject} onChange={e=>setSubject(e.target.value)}/>
          </div>
          <div>
            <label className="label-shop">BODY</label>
            <textarea data-testid="compose-body" rows={10} className="input-shop w-full font-mono text-sm" value={body} onChange={e=>setBody(e.target.value)}/>
          </div>
        </div>
        <div className="p-4 border-t border-line bg-bg-2 flex gap-2" style={{paddingBottom: "calc(1rem + env(safe-area-inset-bottom))"}}>
          <button data-testid="compose-send" onClick={send} disabled={busy} className="btn-rust flex-1 py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
            <Send size={14}/>{busy ? "SENDING..." : "SEND"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReplyModal({ message, onClose, onSent }) {
  const [body, setBody] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [instructions, setInstructions] = useState("");

  const draftWithWrench = async () => {
    setErr(""); setDrafting(true);
    try {
      const r = await api.post(`/email/draft-reply/${message.id}`, { instructions });
      setBody(r.data.draft_html || "");
    } catch (e) { setErr(e?.response?.data?.detail || "Draft failed"); }
    finally { setDrafting(false); }
  };

  const send = async () => {
    setErr("");
    if (!body.trim()) { setErr("Reply body is empty."); return; }
    setBusy(true);
    try {
      const bodyHtml = body.includes("<") ? body : body.split("\n").map(l => `<p>${l || "&nbsp;"}</p>`).join("");
      await api.post(`/email/messages/${message.id}/reply`, { body_html: bodyHtml });
      onSent();
    } catch (e) { setErr(e?.response?.data?.detail || "Reply failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose} data-testid="reply-modal">
      <div className="bg-bg-1 border-t-2 md:border-2 border-rust w-full md:max-w-xl max-h-[92vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="p-4 border-b border-line flex items-center justify-between sticky top-0 bg-bg-1">
          <div>
            <h2 className="heading text-lg flex items-center gap-2"><Reply size={16} className="text-rust"/>REPLY</h2>
            <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-1 line-clamp-1">To: {message.from?.emailAddress?.address}</div>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink p-1" data-testid="reply-close"><X size={18}/></button>
        </div>
        <div className="p-4 space-y-3">
          {err && <div className="text-danger text-xs">{err}</div>}
          <div className="border border-amber2/40 bg-amber2/5 p-3">
            <div className="label-shop !mb-2">LET WRENCH WRITE IT</div>
            <input
              data-testid="reply-instructions"
              className="input-shop w-full text-sm mb-2"
              placeholder="(Optional) Tell Wrench: 'price the head gasket job $850-1100' or just leave blank"
              value={instructions}
              onChange={e=>setInstructions(e.target.value)}
            />
            <button onClick={draftWithWrench} disabled={drafting} className="btn-ghost w-full py-2 text-xs flex items-center justify-center gap-2 border-amber2 text-amber2 hover:bg-amber2/10 disabled:opacity-50" data-testid="draft-with-wrench">
              <Bot size={14}/>{drafting ? "WRENCH IS WRITING..." : "DRAFT WITH WRENCH"}
            </button>
          </div>
          <div>
            <label className="label-shop">YOUR REPLY</label>
            <textarea data-testid="reply-body" rows={10} className="input-shop w-full font-mono text-sm" value={body} onChange={e=>setBody(e.target.value)} placeholder="Type your reply or tap DRAFT WITH WRENCH above"/>
          </div>
        </div>
        <div className="p-4 border-t border-line bg-bg-2 flex gap-2" style={{paddingBottom: "calc(1rem + env(safe-area-inset-bottom))"}}>
          <button data-testid="reply-send" onClick={send} disabled={busy} className="btn-rust flex-1 py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
            <Send size={14}/>{busy ? "SENDING..." : "SEND REPLY"}
          </button>
        </div>
      </div>
    </div>
  );
}
