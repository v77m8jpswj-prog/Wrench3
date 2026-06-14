import React, { useCallback, useEffect, useState } from "react";
import { Phone, Mail, Truck, Clock, MessageSquare, Check, X as XIcon, RefreshCw, Send, Loader2, Copy, Voicemail } from "lucide-react";
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

  const newCount = leads.filter(l => l.status === "new").length;
  // Phone if 7+ digits and no '@' (handles "(479)221-0417", "479-221-0417", "4792210417", "+1 479 221 0417")
  const isPhone = (c) => {
    const s = (c || "").trim();
    if (!s || s.includes("@")) return false;
    const digits = s.replace(/\D/g, "");
    return digits.length >= 7;
  };

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto" data-testid="leads-page">
      <div className="mb-4 border-b border-line pb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="heading text-3xl md:text-4xl">LEADS <span className="text-rust">// {newCount} NEW</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">PEOPLE FROM YOUR LANDING PAGE WHO ASKED FOR A QUOTE</p>
        </div>
        <button onClick={refresh} disabled={busy} className="btn-ghost flex items-center gap-1 text-xs"><RefreshCw size={12} className={busy?"animate-spin":""}/>REFRESH</button>
      </div>

      {leads.length === 0 ? (
        <div className="panel p-6 text-center text-ink-3 text-sm">
          No leads yet.<br/>
          <span className="text-[11px] uppercase tracking-widest">Share your landing page URL to get the phone ringing.</span>
        </div>
      ) : (
        <div className="space-y-2">
          {leads.map(l => (
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
