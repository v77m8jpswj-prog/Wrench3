import React, { useEffect, useState } from "react";
import { Key, Copy, Trash2, Plus, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import api from "@/api";

// Self-contained panel for managing peer-agent tokens (Bud, OG, etc.).
// Solves: Doc can't reach prod env vars on mobile. He can mint/revoke tokens
// from inside the app instead.
export default function PeerTokens() {
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [justCreated, setJustCreated] = useState(null); // { token, peer_name } shown once
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const refresh = async () => {
    setLoading(true); setErr("");
    try { const r = await api.get("/peer-tokens"); setTokens(r.data?.tokens || []); }
    catch (e) { setErr(e?.response?.data?.detail || "Couldn't load tokens"); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (open) refresh(); }, [open]);

  const create = async () => {
    const name = newName.trim();
    if (!name) { setErr("Give it a name (like 'bud')"); return; }
    setCreating(true); setErr("");
    try {
      const r = await api.post("/peer-tokens", { peer_name: name, label: name.toUpperCase() });
      setJustCreated(r.data);
      setNewName("");
      refresh();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't create token");
    } finally { setCreating(false); }
  };

  const copyToken = async () => {
    if (!justCreated?.token) return;
    try {
      await navigator.clipboard.writeText(justCreated.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for older browsers — select the input
      const el = document.getElementById("peer-token-value");
      if (el) { el.select(); document.execCommand("copy"); setCopied(true); setTimeout(()=>setCopied(false), 2500); }
    }
  };

  const dismissNewToken = () => {
    if (justCreated?.token && !copied) {
      if (!window.confirm("You haven't copied the token yet. Once you close this, you can't see it again. Continue?")) return;
    }
    setJustCreated(null); setCopied(false);
  };

  const toggle = async (id) => {
    try { await api.patch(`/peer-tokens/${id}/toggle`); refresh(); }
    catch (e) { setErr(e?.response?.data?.detail || "Toggle failed"); }
  };
  const remove = async (id, label) => {
    if (!window.confirm(`Delete the token for "${label}"? Whatever's using it will stop working.`)) return;
    try { await api.delete(`/peer-tokens/${id}`); refresh(); }
    catch (e) { setErr(e?.response?.data?.detail || "Delete failed"); }
  };

  return (
    <div className="mb-4 max-w-3xl mx-auto" data-testid="peer-tokens-wrap">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-3 border-2 border-line bg-bg-2 hover:border-amber2 flex items-center justify-between gap-3 text-left transition-colors"
        data-testid="peer-tokens-toggle"
      >
        <span className="flex items-center gap-2">
          <Key size={16} className="text-amber2"/>
          <span className="text-xs uppercase tracking-widest font-bold text-amber2">PEER AGENT TOKENS</span>
          <span className="text-[10px] text-ink-3">— give Bud / OG access to your brain</span>
        </span>
        <span className="text-ink-3 text-sm">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="border-2 border-t-0 border-line bg-bg-2 p-4">
          {/* JUST-CREATED TOKEN — show ONCE */}
          {justCreated && (
            <div className="mb-4 border-2 border-amber2 bg-amber2/10 p-3" data-testid="new-token-display">
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle size={18} className="text-amber2 shrink-0 mt-0.5"/>
                <div className="flex-1">
                  <div className="text-xs uppercase tracking-widest text-amber2 font-bold">SAVE THIS NOW — YOU WON'T SEE IT AGAIN</div>
                  <div className="text-[11px] text-ink-3 mt-1">Token for <span className="text-amber2 font-bold">{justCreated.peer_name}</span>. Paste it into that agent's config.</div>
                </div>
                <button onClick={dismissNewToken} className="text-ink-3 hover:text-ink p-1" data-testid="new-token-close"><X size={14}/></button>
              </div>
              <div className="flex gap-2 items-stretch">
                <input
                  id="peer-token-value"
                  readOnly
                  value={justCreated.token}
                  onClick={(e)=>e.target.select()}
                  className="flex-1 bg-bg-1 border border-amber2/50 px-2 py-2 text-xs font-mono break-all"
                  data-testid="new-token-input"
                />
                <button onClick={copyToken} className="btn-rust text-xs px-3 flex items-center gap-1 shrink-0" data-testid="new-token-copy">
                  {copied ? <><CheckCircle2 size={12}/>COPIED</> : <><Copy size={12}/>COPY</>}
                </button>
              </div>
              <div className="text-[10px] text-ink-3 mt-2">
                Give Bud's agent this message: <br/>
                <span className="text-ink-2">"Set <span className="text-amber2 font-mono">SHOP_BRAIN_BASE_URL=https://foreman.drunderhood.com</span> and <span className="text-amber2 font-mono">SHOP_BRAIN_TOKEN=</span>&lt;paste this token&gt;. Only use /api/brain/peer/lookup and /api/brain/peer/open-work endpoints."</span>
              </div>
            </div>
          )}

          {/* CREATE NEW */}
          {!justCreated && (
            <div className="mb-3 flex gap-2">
              <input
                value={newName}
                onChange={(e)=>setNewName(e.target.value)}
                onKeyDown={(e)=>{if(e.key==="Enter") create();}}
                placeholder="Agent name — like 'bud' or 'og'"
                className="flex-1 bg-bg-1 border border-line focus:border-amber2 px-3 py-2 text-sm placeholder:text-ink-3 focus:outline-none"
                data-testid="new-token-name"
              />
              <button onClick={create} disabled={creating || !newName.trim()} className="btn-rust text-xs px-4 flex items-center gap-1 disabled:opacity-50" data-testid="new-token-create">
                <Plus size={12}/>{creating ? "..." : "CREATE TOKEN"}
              </button>
            </div>
          )}

          {err && <div className="mb-3 text-xs text-rust">{err}</div>}

          {/* EXISTING TOKENS */}
          {loading ? (
            <div className="text-xs text-ink-3 uppercase tracking-widest">loading…</div>
          ) : tokens.length === 0 ? (
            <div className="text-xs text-ink-3">
              No tokens yet. Create one above and give it to Bud / OG / whoever needs read access to your shop brain.
            </div>
          ) : (
            <div className="divide-y divide-line border border-line">
              {tokens.map(t => (
                <div key={t.id} className="px-3 py-2 flex items-center gap-2" data-testid={`token-row-${t.id}`}>
                  <Key size={14} className={t.enabled ? "text-amber2" : "text-ink-3"}/>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{t.label || t.peer_name}</div>
                    <div className="text-[10px] text-ink-3 font-mono">{t.token_preview} · created {(t.created_at || "").slice(0,10)}</div>
                  </div>
                  <span className={`text-[10px] uppercase tracking-widest px-1.5 py-0.5 border ${t.enabled?"border-ok text-ok":"border-ink-3 text-ink-3"}`}>{t.enabled?"ON":"OFF"}</span>
                  <button onClick={()=>toggle(t.id)} className="text-xs px-2 py-1 text-ink-2 hover:text-amber2" data-testid={`token-toggle-${t.id}`}>{t.enabled?"PAUSE":"RESUME"}</button>
                  <button onClick={()=>remove(t.id, t.label || t.peer_name)} className="text-ink-3 hover:text-rust p-1" data-testid={`token-del-${t.id}`}><Trash2 size={14}/></button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 text-[10px] text-ink-3 leading-relaxed">
            Tokens are stored encrypted (SHA-256 hash). Plaintext is shown ONCE on creation. To rotate: delete + create new.
          </div>
        </div>
      )}
    </div>
  );
}
