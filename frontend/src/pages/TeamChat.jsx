import React, { useEffect, useRef, useState } from "react";
import { Send, Hash, User, Brain, Check, UserPlus, X } from "lucide-react";
import api from "@/api";

export default function TeamChat() {
  const [threads, setThreads] = useState([]);
  const [active, setActive] = useState("shop"); // thread key
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [me, setMe] = useState(null);
  const [absorbing, setAbsorbing] = useState(false);
  const [absorbedMsg, setAbsorbedMsg] = useState("");
  const [showAddTech, setShowAddTech] = useState(false);
  const [techName, setTechName] = useState("");
  const [techEmail, setTechEmail] = useState("");
  const [techPassword, setTechPassword] = useState("");
  const [techRole, setTechRole] = useState("tech");
  const [techSaving, setTechSaving] = useState(false);
  const [techErr, setTechErr] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    api.get("/auth/me").then(r => setMe(r.data));
  }, []);

  const refreshThreads = () => api.get("/team-chat/threads").then(r => setThreads(r.data || []));
  const refreshMessages = (key) => api.get(`/team-chat/messages?thread=${encodeURIComponent(key)}`).then(r => setMessages(r.data || []));

  useEffect(() => { refreshThreads(); }, []);
  useEffect(() => {
    if (!active) return;
    refreshMessages(active);
    // mark thread as read
    api.post("/team-chat/mark-read", { thread_key: active }).then(refreshThreads).catch(()=>{});
  }, [active]);

  // Auto-poll every 8s
  useEffect(() => {
    const t = setInterval(() => {
      if (active) refreshMessages(active);
      refreshThreads();
    }, 8000);
    return () => clearInterval(t);
  }, [active]);

  // Auto-scroll only the messages container (never the window) and only if Doc is
  // already near the bottom. Stops the team page from yanking when reading older msgs.
  useEffect(() => {
    const el = endRef.current?.parentElement;
    if (!el) return;
    let s = el;
    while (s && s !== document.body) {
      const oy = window.getComputedStyle(s).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      s = s.parentElement;
    }
    if (!s) return;
    const distFromBottom = s.scrollHeight - s.scrollTop - s.clientHeight;
    if (distFromBottom < 160) s.scrollTop = s.scrollHeight;
  }, [messages]);
  // Pin window to top on mount so landing on /team doesn't drop into the input
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const activeThread = threads.find(t => t.key === active);

  const send = async () => {
    const txt = input.trim();
    if (!txt) return;
    setInput("");
    const payload = active === "shop" ? { content: txt } : { content: txt, to_user_id: activeThread?.other_user_id };
    try {
      const r = await api.post("/team-chat/messages", payload);
      setMessages(m => [...m, r.data]);
      refreshThreads();
    } catch (e) {
      alert("Send failed: " + (e?.response?.data?.detail || e.message));
    }
  };

  const absorb = async () => {
    if (!window.confirm(`Absorb the last 50 messages from this thread into the BRAIN? Wrench will be able to recall this conversation.`)) return;
    setAbsorbing(true); setAbsorbedMsg("");
    try {
      const r = await api.post("/team-chat/absorb", { thread_key: active, limit: 50 });
      setAbsorbedMsg(`✓ ${r.data.messages_absorbed} messages absorbed into brain.`);
      setTimeout(() => setAbsorbedMsg(""), 4000);
    } catch (e) {
      alert("Absorb failed: " + (e?.response?.data?.detail || e.message));
    } finally { setAbsorbing(false); }
  };

  const submitNewTech = async () => {
    setTechErr("");
    const name = techName.trim();
    const email = techEmail.trim().toLowerCase();
    const password = techPassword;
    if (!name || !email || password.length < 6) {
      setTechErr("Name, email, and a 6+ char password are required.");
      return;
    }
    setTechSaving(true);
    try {
      await api.post("/techs", { name, email, password, role: techRole });
      setTechName(""); setTechEmail(""); setTechPassword(""); setTechRole("tech");
      setShowAddTech(false);
      await refreshThreads();
    } catch (e) {
      setTechErr(e?.response?.data?.detail || "Failed to add tech.");
    } finally { setTechSaving(false); }
  };

  const isOwner = (me?.role || "owner") === "owner";

  return (
    <div className="flex h-full" style={{minHeight:"calc(100dvh - 90px)"}} data-testid="team-chat-page">
      {/* Threads sidebar */}
      <aside className="w-[200px] md:w-[260px] border-r border-line bg-bg-2 flex flex-col flex-shrink-0">
        <div className="px-3 py-3 border-b border-line">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="heading text-base md:text-lg">SHOP TEAM</div>
              <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-0.5 truncate">{me?.shop_id}</div>
            </div>
            {isOwner && (
              <button
                data-testid="add-tech-btn"
                onClick={()=>{ setShowAddTech(true); setTechErr(""); }}
                title="Add a tech to this shop"
                className="border-2 border-amber2 text-amber2 hover:bg-amber2/10 px-2 py-1 flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold shrink-0"
              >
                <UserPlus size={12}/> ADD TECH
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {threads.map(t => (
            <button
              key={t.key}
              data-testid={`thread-${t.key}`}
              onClick={() => setActive(t.key)}
              className={`w-full text-left px-3 py-3 border-b border-line border-l-2 flex items-center gap-2 ${active === t.key ? "border-l-rust bg-bg-3" : "border-l-transparent hover:bg-bg-3"}`}
            >
              {t.kind === "channel" ? <Hash size={14} className="text-rust"/> : <User size={14} className="text-amber2"/>}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold truncate">{t.name}</div>
                <div className="text-[10px] text-ink-3 truncate">
                  {t.last_message ? `${t.last_message.from_name}: ${t.last_message.content.slice(0,40)}` : "no messages yet"}
                </div>
              </div>
              {t.unread > 0 && <span className="bg-rust text-black text-[10px] font-bold px-1.5 py-0.5 leading-none">{t.unread}</span>}
            </button>
          ))}
        </div>
      </aside>

      {/* Active thread */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="px-3 md:px-6 py-3 border-b border-line bg-bg-2 flex items-center justify-between gap-2 flex-wrap" data-testid="thread-header">
          <div className="flex items-center gap-2 min-w-0">
            {activeThread?.kind === "channel" ? <Hash size={16} className="text-rust"/> : <User size={16} className="text-amber2"/>}
            <span className="heading text-lg md:text-xl truncate">{activeThread?.name || "—"}</span>
            {activeThread?.kind === "channel" && <span className="text-[10px] text-ink-3 uppercase tracking-widest">everyone in the shop</span>}
          </div>
          <button onClick={absorb} disabled={absorbing} data-testid="absorb-btn" className="btn-ghost text-xs flex items-center gap-1.5 disabled:opacity-50" title="Push the recent messages from this thread into the BRAIN so Wrench can recall them later">
            <Brain size={12}/>{absorbing ? "ABSORBING..." : "ABSORB → BRAIN"}
          </button>
        </header>

        {absorbedMsg && (
          <div className="px-3 md:px-6 py-2 bg-ok/10 border-b border-ok/50 text-ok text-xs uppercase tracking-widest flex items-center gap-2" data-testid="absorbed-msg">
            <Check size={12}/>{absorbedMsg}
          </div>
        )}

        {/* Input bar — TOP under header (Doc's standard layout) */}
        <div className="border-b border-line bg-bg-2 px-3 md:px-6 py-3 flex gap-2 sticky top-0 z-10" data-testid="team-chat-input-bar">
          <textarea
            data-testid="team-chat-input"
            rows={1}
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if (e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); } }}
            placeholder={activeThread?.kind==="channel"?`Message #${activeThread.name}`:`Message ${activeThread?.name || "..."}`}
            className="input-shop flex-1 resize-none text-sm py-3"
            style={{minHeight:"48px"}}
          />
          <button data-testid="team-chat-send" onClick={send} className="btn-rust px-4 flex items-center gap-1.5">
            <Send size={16}/><span className="hidden sm:inline">SEND</span>
          </button>
        </div>

        <div className="flex-1 overflow-auto px-3 md:px-6 py-3 space-y-2" data-testid="thread-messages">
          {messages.length === 0 ? (
            <div className="text-ink-3 text-sm text-center py-8">
              {activeThread?.kind === "channel" ? "No shop messages yet. Drop the first one." : "No messages yet. Say something."}
            </div>
          ) : [...messages].reverse().map(m => {
            const isMe = me && m.from_user_id === me.id;
            return (
              <div key={m.id} className={`flex ${isMe?"justify-end":"justify-start"}`} data-testid={`msg-${m.id}`}>
                <div className={`max-w-[80%] border ${isMe?"border-rust/60 bg-rust/10":"border-line bg-bg-2"} px-3 py-2`}>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`font-head text-[10px] uppercase tracking-widest font-bold ${isMe?"text-rust":"text-amber2"}`}>{m.from_name}</span>
                    <span className="text-[9px] text-ink-3 font-mono">{(m.created_at||"").slice(11,16)}</span>
                  </div>
                  <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </main>

      {showAddTech && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4"
          onClick={()=>!techSaving && setShowAddTech(false)}
          data-testid="add-tech-modal"
        >
          <div
            className="bg-bg-1 border-2 border-amber2 max-w-md w-full p-5"
            onClick={e=>e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line pb-3 mb-4">
              <div className="flex items-center gap-2">
                <UserPlus size={18} className="text-amber2"/>
                <h2 className="heading text-xl">ADD A TECH</h2>
              </div>
              <button
                onClick={()=>!techSaving && setShowAddTech(false)}
                className="text-ink-3 hover:text-ink"
                data-testid="add-tech-close"
              >
                <X size={18}/>
              </button>
            </div>
            <p className="text-[11px] text-ink-3 uppercase tracking-widest mb-3">
              Drops them into THIS shop ({me?.shop_id}). They can log in with the password you set.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-ink-3 mb-1">Name</label>
                <input
                  data-testid="add-tech-name"
                  value={techName}
                  onChange={e=>setTechName(e.target.value)}
                  placeholder="e.g. Mike Stewart"
                  className="input-shop w-full text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-ink-3 mb-1">Email</label>
                <input
                  data-testid="add-tech-email"
                  type="email"
                  value={techEmail}
                  onChange={e=>setTechEmail(e.target.value)}
                  placeholder="mike@drunderhood.com"
                  className="input-shop w-full text-sm"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-ink-3 mb-1">Starter password (6+ chars)</label>
                <input
                  data-testid="add-tech-password"
                  type="text"
                  value={techPassword}
                  onChange={e=>setTechPassword(e.target.value)}
                  placeholder="they'll change it themselves"
                  className="input-shop w-full text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-ink-3 mb-1">Role</label>
                <select
                  data-testid="add-tech-role"
                  value={techRole}
                  onChange={e=>setTechRole(e.target.value)}
                  className="input-shop w-full text-sm"
                >
                  <option value="tech">Tech</option>
                  <option value="owner">Owner (full access)</option>
                </select>
              </div>
            </div>
            {techErr && (
              <div className="mt-3 text-danger text-xs border-l-2 border-danger pl-3" data-testid="add-tech-error">
                {techErr}
              </div>
            )}
            <div className="flex gap-2 mt-5 pt-3 border-t border-line">
              <button
                data-testid="add-tech-cancel"
                onClick={()=>setShowAddTech(false)}
                disabled={techSaving}
                className="flex-1 border-2 border-line text-ink-2 hover:bg-bg-3 px-3 py-2 text-xs uppercase tracking-widest"
              >
                Cancel
              </button>
              <button
                data-testid="add-tech-submit"
                onClick={submitNewTech}
                disabled={techSaving}
                className="flex-1 btn-rust px-3 py-2 text-xs disabled:opacity-50"
              >
                {techSaving ? "ADDING..." : "ADD TO SHOP"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
