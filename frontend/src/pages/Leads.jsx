import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Phone, Mail, Truck, Clock, MessageSquare, Check, X as XIcon, RefreshCw, Send, Loader2, Copy, Voicemail, Facebook, Instagram, Trash2 } from "lucide-react";
import api from "@/api";

const STATUS_COLORS = {
  new: "text-rust border-rust bg-rust/10",
  contacted: "text-amber2 border-amber2 bg-amber2/10",
  won: "text-ok border-ok bg-ok/10",
  lost: "text-ink-3 border-line bg-bg-3",
};

function timeAgo(iso) {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}d`;
}

function TextComposer({ lead, onClose, onSent }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const segments = body.length === 0 ? 0 : body.length <= 160 ? 1 : Math.ceil(body.length / 153);

  const send = async () => {
    if (!body.trim()) { setErr("Type the text first."); return; }
    setSending(true); setErr("");
    try {
      const r = await api.post(`/leads/${lead.id}/text`, { body });
      if (r.data?.ok) {
        onSent(r.data);
        onClose();
      } else {
        setErr(r.data?.note || "Twilio rejected the send.");
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Send failed.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3" data-testid={`lead-text-composer-${lead.id}`}>
      <div className="text-[10px] uppercase tracking-widest text-ink-3 mb-1">
        Texting <span className="text-amber2">{lead.contact}</span> · {lead.name}
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Type your reply. Plain English. They'll see it as a text from your shop number."
        rows={3}
        maxLength={1600}
        className="w-full bg-bg-3 border border-line text-ink text-sm p-2 focus:outline-none focus:border-rust"
        data-testid={`lead-text-input-${lead.id}`}
        autoFocus
      />
      <div className="flex items-center justify-between mt-2 gap-2">
        <div className="text-[10px] text-ink-3 uppercase tracking-widest">
          {body.length} chars · {segments} segment{segments !== 1 ? "s" : ""}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={sending}
            className="btn-ghost text-xs"
            data-testid={`lead-text-cancel-${lead.id}`}
          >
            CANCEL
          </button>
          <button
            onClick={send}
            disabled={sending || !body.trim()}
            className="btn-ghost text-xs flex items-center gap-1 border-rust text-rust"
            data-testid={`lead-text-send-${lead.id}`}
          >
            {sending ? <Loader2 size={11} className="animate-spin"/> : <Send size={11}/>}
            {sending ? "SENDING..." : "SEND TEXT"}
          </button>
        </div>
      </div>
      {err && (
        <div className="mt-2 text-xs text-rust" data-testid={`lead-text-err-${lead.id}`}>{err}</div>
      )}
    </div>
  );
}

function EmailComposer({ lead, onClose, onSent }) {
  const [subject, setSubject] = useState(
    lead.vehicle ? `Re: your ${lead.vehicle}` : `Re: your inquiry`
  );
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgKind, setMsgKind] = useState("err");

  const send = async () => {
    if (!subject.trim() || !text.trim()) { setMsg("Subject and body required."); setMsgKind("err"); return; }
    setSending(true); setMsg("");
    try {
      const r = await api.post(`/leads/${lead.id}/email`, { subject, text });
      if (r.data?.ok) {
        onSent(r.data);
        onClose();
      } else {
        setMsgKind("warn");
        setMsg(r.data?.note || r.data?.provider_error || "Email send pipe not live yet — message saved as draft.");
      }
    } catch (e) {
      setMsgKind("err");
      setMsg(e?.response?.data?.detail || "Send failed.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3" data-testid={`lead-email-composer-${lead.id}`}>
      <div className="text-[10px] uppercase tracking-widest text-ink-3 mb-2">
        Emailing <span className="text-amber2">{lead.contact}</span> · {lead.name} · from doc@drunderhood.com
      </div>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        maxLength={200}
        className="w-full bg-bg-3 border border-line text-ink text-sm p-2 mb-2 focus:outline-none focus:border-rust"
        data-testid={`lead-email-subject-${lead.id}`}
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Write your reply. Plain English. They'll see it as a real email from your shop address."
        rows={6}
        maxLength={20000}
        className="w-full bg-bg-3 border border-line text-ink text-sm p-2 focus:outline-none focus:border-rust"
        data-testid={`lead-email-input-${lead.id}`}
        autoFocus
      />
      <div className="flex items-center justify-between mt-2 gap-2">
        <div className="text-[10px] text-ink-3 uppercase tracking-widest">
          {text.length} chars
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={sending}
            className="btn-ghost text-xs"
            data-testid={`lead-email-cancel-${lead.id}`}
          >
            CANCEL
          </button>
          <button
            onClick={send}
            disabled={sending || !text.trim() || !subject.trim()}
            className="btn-ghost text-xs flex items-center gap-1 border-rust text-rust"
            data-testid={`lead-email-send-${lead.id}`}
          >
            {sending ? <Loader2 size={11} className="animate-spin"/> : <Send size={11}/>}
            {sending ? "SENDING..." : "SEND EMAIL"}
          </button>
        </div>
      </div>
      {msg && (
        <div className={`mt-2 text-xs ${msgKind === "err" ? "text-rust" : "text-amber2"}`} data-testid={`lead-email-msg-${lead.id}`}>
          {msg}
        </div>
      )}
    </div>
  );
}

function ContactDisplay({ contact, isPhone }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    try { await navigator.clipboard.writeText(contact); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch {/*ignore*/}
  };
  return (
    <div className="flex items-center gap-2 mt-1 flex-wrap">
      {isPhone ? (
        <a href={`tel:${contact}`} className="text-base font-mono text-ink hover:text-rust flex items-center gap-1.5" data-testid="lead-contact-phone">
          <Phone size={14} className="text-rust"/>{contact}
        </a>
      ) : (
        <span className="text-base font-mono text-ink flex items-center gap-1.5 break-all" data-testid="lead-contact-email">
          <Mail size={14} className="text-amber2"/>{contact}
        </span>
      )}
      <button
        onClick={copy}
        className={`text-[11px] uppercase tracking-widest font-bold px-2 py-1 border ${copied ? "border-ok text-ok" : "border-amber2 text-amber2 hover:bg-amber2 hover:text-black"}`}
        data-testid="lead-contact-copy"
      >
        {copied ? "COPIED" : (<><Copy size={11} className="inline mr-1"/>COPY</>)}
      </button>
    </div>
  );
}

export default function Leads() {
  const [leads, setLeads] = useState([]);
  const [busy, setBusy] = useState(false);
  const [textingId, setTextingId] = useState(null);
  const [emailingId, setEmailingId] = useState(null);
  const [search, setSearch] = useSearchParams();
  const [showArchived, setShowArchived] = useState(false);
  // /leads?phone=+14794345852 narrows to one customer (clicked from SMS Inbox)
  const phoneFilter = (search.get("phone") || "").trim();

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.get("/leads");
      setLeads(r.data || []);
    } catch {/*ignore*/}
    finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const t0 = setTimeout(refresh, 0);
    const t = setInterval(refresh, 30000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, [refresh]);

  const setStatus = useCallback(async (id, status) => {
    try {
      await api.patch(`/leads/${id}`, { status });
    } catch {/*ignore*/}
    refresh();
  }, [refresh]);

  const deleteLead = useCallback(async (id, name) => {
    const label = name ? `lead "${name}"` : "this lead";
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    try {
      await api.delete(`/leads/${id}`);
    } catch (e) {
      alert(`Couldn't delete: ${e?.response?.data?.detail || e.message || "unknown error"}`);
      return;
    }
    refresh();
  }, [refresh]);

  const newCount = leads.filter(l => l.status === "new").length;
  // Phone if 7+ digits and no '@' (handles "(479)221-0417", "479-221-0417", "4792210417", "+1 479 221 0417")
  const isPhone = (c) => {
    const s = (c || "").trim();
    if (!s || s.includes("@")) return false;
    const digits = s.replace(/\D/g, "");
    return digits.length >= 7;
  };
  // Last-10 digits match — handles "+14794345852" vs "4794345852" vs "(479) 434-5852"
  const digitsOnly = (s) => (s || "").replace(/\D/g, "").slice(-10);
  const filterDigits = phoneFilter ? digitsOnly(phoneFilter) : "";
  const visibleLeads = useMemo(() => {
    let v = leads;
    // Hide WON/LOST/DISMISSED by default — Doc wants them archived, not deleted,
    // so they're still searchable when he flips the toggle.
    if (!showArchived) v = v.filter(l => !["won", "lost", "dismissed"].includes((l.status || "").toLowerCase()));
    if (filterDigits) v = v.filter(l => isPhone(l.contact) && digitsOnly(l.contact) === filterDigits);
    return v;
  }, [leads, filterDigits, showArchived]);
  const archivedCount = leads.filter(l => ["won","lost","dismissed"].includes((l.status||"").toLowerCase())).length;
  const clearPhoneFilter = () => { const ns = new URLSearchParams(search); ns.delete("phone"); setSearch(ns, { replace: true }); };

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto" data-testid="leads-page">
      <div className="mb-4 border-b border-line pb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="heading text-3xl md:text-4xl">LEADS <span className="text-rust">// {newCount} NEW</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">PEOPLE FROM YOUR LANDING PAGE WHO ASKED FOR A QUOTE</p>
        </div>
        <div className="flex items-center gap-2">
          {archivedCount > 0 && (
            <button
              onClick={()=>setShowArchived(v=>!v)}
              data-testid="leads-toggle-archived"
              className={`text-[11px] uppercase tracking-widest px-2 py-1 border ${showArchived ? "border-amber2 text-amber2 bg-amber2/10" : "border-line text-ink-2 hover:text-white"}`}
            >
              {showArchived ? "HIDE" : "SHOW"} ARCHIVED ({archivedCount})
            </button>
          )}
          <button onClick={refresh} disabled={busy} className="btn-ghost flex items-center gap-1 text-xs"><RefreshCw size={12} className={busy?"animate-spin":""}/>REFRESH</button>
        </div>
      </div>

      {phoneFilter && (
        <div className="mb-3 border border-amber2 bg-amber2/10 text-amber2 px-3 py-2 text-[11px] uppercase tracking-widest flex items-center justify-between gap-2" data-testid="leads-phone-filter-banner">
          <span>FILTERED TO {phoneFilter} ({visibleLeads.length} {visibleLeads.length === 1 ? "LEAD" : "LEADS"})</span>
          <button onClick={clearPhoneFilter} className="border border-amber2 px-2 py-0.5 hover:bg-amber2 hover:text-black" data-testid="leads-phone-filter-clear">SHOW ALL</button>
        </div>
      )}

      {visibleLeads.length === 0 ? (
        <div className="panel p-6 text-center text-ink-3 text-sm">
          {phoneFilter ? (<>No leads from <span className="font-mono text-amber2">{phoneFilter}</span> yet.</>) : (<>No leads yet.</>)}<br/>
          <span className="text-[11px] uppercase tracking-widest">Share your landing page URL to get the phone ringing.</span>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleLeads.map(l => (
            <div key={l.id} className="panel p-3 md:p-4" data-testid={`lead-${l.id}`}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] uppercase tracking-widest font-bold border px-2 py-0.5 ${STATUS_COLORS[l.status] || STATUS_COLORS.new}`}>
                      {l.status?.toUpperCase() || "NEW"}
                    </span>
                    {l.kind === "voicemail" && (
                      <span className="text-[10px] uppercase tracking-widest font-bold border px-2 py-0.5 border-amber2 text-amber2 bg-amber2/10 flex items-center gap-1" data-testid={`lead-vm-badge-${l.id}`}>
                        <Voicemail size={10}/>VOICEMAIL
                      </span>
                    )}
                    {l.kind === "facebook_dm" && (
                      <span className="text-[10px] uppercase tracking-widest font-bold border px-2 py-0.5 border-[#1877F2] text-[#1877F2] bg-[#1877F2]/10 flex items-center gap-1" data-testid={`lead-fb-badge-${l.id}`}>
                        <Facebook size={10}/>FB MESSENGER
                      </span>
                    )}
                    {l.kind === "instagram_dm" && (
                      <span className="text-[10px] uppercase tracking-widest font-bold border px-2 py-0.5 border-pink-500 text-pink-500 bg-pink-500/10 flex items-center gap-1" data-testid={`lead-ig-badge-${l.id}`}>
                        <Instagram size={10}/>INSTAGRAM
                      </span>
                    )}
                    <span className="text-[10px] text-ink-3 uppercase tracking-widest flex items-center gap-1"><Clock size={10}/>{timeAgo(l.created_at)}</span>
                  </div>
                  <div className="text-base font-bold text-amber2 mt-1">{l.name}</div>
                  <ContactDisplay contact={l.contact} isPhone={isPhone(l.contact)} />
                  {l.vehicle && (
                    <div className="text-xs text-ink-2 mt-0.5 flex items-center gap-1"><Truck size={11}/>{l.vehicle}</div>
                  )}
                </div>
              </div>
              {l.recording_url && (
                <div className="mb-2" data-testid={`lead-vm-audio-${l.id}`}>
                  <audio controls src={l.recording_url} className="w-full h-8" preload="none">
                    Your browser does not support audio playback.
                  </audio>
                </div>
              )}
              {l.fb_attachment_url && (l.kind === "facebook_dm" || l.kind === "instagram_dm") && (
                <div className="mb-2" data-testid={`lead-fb-attach-${l.id}`}>
                  {(l.fb_attachments_full?.[0]?.type === "image") ? (
                    <a href={l.fb_attachment_url} target="_blank" rel="noopener noreferrer">
                      <img src={l.fb_attachment_url} alt="customer attachment" className="max-h-48 border border-line" />
                    </a>
                  ) : (
                    <a href={l.fb_attachment_url} target="_blank" rel="noopener noreferrer" className="text-xs text-amber2 underline">View attachment ↗</a>
                  )}
                </div>
              )}
              <div className="text-sm text-ink-2 whitespace-pre-wrap border-l-2 border-line pl-3 ml-1">
                {l.what_they_need}
              </div>
              {l.status !== "won" && l.status !== "lost" && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  {isPhone(l.contact) && textingId !== l.id && (
                    <button
                      onClick={() => { setTextingId(l.id); setEmailingId(null); }}
                      className="btn-ghost text-xs flex items-center gap-1 border-rust text-rust"
                      data-testid={`lead-text-${l.id}`}
                    >
                      <Send size={11}/>TEXT
                    </button>
                  )}
                  {isPhone(l.contact) && (
                    <Link
                      to={`/sms?phone=${encodeURIComponent(l.contact)}`}
                      className="btn-ghost text-xs flex items-center gap-1 border-amber2 text-amber2 hover:bg-amber2 hover:text-black"
                      data-testid={`lead-view-sms-${l.id}`}
                    >
                      <MessageSquare size={11}/>SMS THREAD
                    </Link>
                  )}
                  {l.kind === "facebook_dm" && l.fb_psid && (
                    <a
                      href={`https://www.facebook.com/messages/t/${l.fb_psid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost text-xs flex items-center gap-1 border-[#1877F2] text-[#1877F2] hover:bg-[#1877F2] hover:text-white"
                      data-testid={`lead-fb-reply-${l.id}`}
                    >
                      <Facebook size={11}/>REPLY ON FB
                    </a>
                  )}
                  {l.kind === "instagram_dm" && l.fb_psid && (
                    <a
                      href={`https://www.instagram.com/direct/t/${l.fb_psid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost text-xs flex items-center gap-1 border-pink-500 text-pink-500 hover:bg-pink-500 hover:text-white"
                      data-testid={`lead-ig-reply-${l.id}`}
                    >
                      <Instagram size={11}/>REPLY ON IG
                    </a>
                  )}
                  {!isPhone(l.contact) && emailingId !== l.id && (
                    <button
                      onClick={() => { setEmailingId(l.id); setTextingId(null); }}
                      className="btn-ghost text-xs flex items-center gap-1 border-rust text-rust"
                      data-testid={`lead-email-${l.id}`}
                    >
                      <Mail size={11}/>EMAIL
                    </button>
                  )}
                  {l.status === "new" && (
                    <button onClick={()=>setStatus(l.id, "contacted")} className="btn-ghost text-xs flex items-center gap-1 border-amber2 text-amber2" data-testid={`lead-contacted-${l.id}`}>
                      <MessageSquare size={11}/>MARK CONTACTED
                    </button>
                  )}
                  <button onClick={()=>setStatus(l.id, "won")} className="btn-ghost text-xs flex items-center gap-1 border-ok text-ok" data-testid={`lead-won-${l.id}`}>
                    <Check size={11}/>WON
                  </button>
                  <button onClick={()=>setStatus(l.id, "lost")} className="btn-ghost text-xs flex items-center gap-1 text-ink-3" data-testid={`lead-lost-${l.id}`}>
                    <XIcon size={11}/>LOST
                  </button>
                  <button onClick={()=>deleteLead(l.id, l.name)} className="btn-ghost text-xs flex items-center gap-1 border-rust text-rust hover:bg-rust hover:text-black ml-auto" title="Delete lead permanently" data-testid={`lead-delete-${l.id}`}>
                    <Trash2 size={11}/>DELETE
                  </button>
                </div>
              )}
              {textingId === l.id && (
                <TextComposer
                  lead={l}
                  onClose={() => setTextingId(null)}
                  onSent={refresh}
                />
              )}
              {emailingId === l.id && (
                <EmailComposer
                  lead={l}
                  onClose={() => setEmailingId(null)}
                  onSent={refresh}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
