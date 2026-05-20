import React, { useEffect, useRef, useState } from "react";
import { Send, Hash, User, Brain, Check } from "lucide-react";
import api from "@/api";

export default function TeamChat() {
  const [threads, setThreads] = useState([]);
  const [active, setActive] = useState("shop"); // thread key
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [me, setMe] = useState(null);
  const [absorbing, setAbsorbing] = useState(false);
  const [absorbedMsg, setAbsorbedMsg] = useState("");
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

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

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

  return (
    <div className="flex h-full" style={{minHeight:"calc(100dvh - 90px)"}} data-testid="team-chat-page">
      {/* Threads sidebar */}
      <aside className="w-[200px] md:w-[260px] border-r border-line bg-bg-2 flex flex-col flex-shrink-0">
        <div className="px-3 py-3 border-b border-line">
          <div className="heading text-base md:text-lg">SHOP TEAM</div>
          <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-0.5">{me?.shop_id}</div>
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

        <div className="flex-1 overflow-auto px-3 md:px-6 py-3 space-y-2" data-testid="thread-messages">
          {messages.length === 0 ? (
            <div className="text-ink-3 text-sm text-center py-8">
              {activeThread?.kind === "channel" ? "No shop messages yet. Drop the first one." : "No messages yet. Say something."}
            </div>
          ) : messages.map(m => {
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

        <div className="border-t border-line bg-bg-2 px-3 md:px-6 py-3 flex gap-2" data-testid="team-chat-input-bar">
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
      </main>
    </div>
  );
}
