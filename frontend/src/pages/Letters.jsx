import React, { useEffect, useState } from "react";
import { Mail, Copy, ExternalLink, Plus, X, Trash2 } from "lucide-react";
import api, { API } from "@/api";

const slugify = (s) => (s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

export default function Letters() {
  const [letters, setLetters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ slug: "", title: "", recipient: "", body: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = async () => {
    setLoading(true);
    try { const r = await api.get("/letters"); setLetters(r.data || []); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    setErr("");
    const payload = {
      slug: slugify(form.slug || form.title),
      title: form.title || form.slug,
      recipient: form.recipient,
      body: form.body,
    };
    if (!payload.slug) { setErr("Need a title or slug."); return; }
    if (!payload.body.trim()) { setErr("Body's empty — paste the letter in."); return; }
    setBusy(true);
    try {
      await api.post("/letters", payload);
      setForm({ slug: "", title: "", recipient: "", body: "" });
      setShowNew(false);
      refresh();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  const remove = async (slug) => {
    if (!window.confirm("Delete this letter?")) return;
    try { await api.delete(`/letters/${slug}`); refresh(); } catch (e) { alert(e?.response?.data?.detail || "Delete failed"); }
  };

  const apiBase = (API || "").replace(/\/api$/, "");
  const openCopyPage = (slug) => {
    const url = `${API}/letter/${slug}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };
  const copyLink = async (slug) => {
    const url = `${API}/letter/${slug}`;
    try { await navigator.clipboard.writeText(url); alert("Link copied. Paste it anywhere."); } catch { alert(url); }
  };

  return (
    <div className="px-3 md:px-6 py-4 md:py-6 max-w-3xl mx-auto" data-testid="letters-page">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="heading text-2xl md:text-3xl">LETTERS <span className="text-rust">// AGENT-TO-AGENT</span></h1>
          <p className="text-ink-3 text-xs uppercase tracking-widest mt-1">Tap any letter to open a one-tap copy page</p>
        </div>
        <button data-testid="new-letter-btn" onClick={()=>setShowNew(s=>!s)} className="btn-rust flex items-center gap-2 text-sm">
          <Plus size={16}/>{showNew ? "CANCEL" : "NEW LETTER"}
        </button>
      </div>

      {showNew && (
        <div className="border border-line bg-bg-2 p-4 mb-4 space-y-3" data-testid="new-letter-form">
          {err && <div className="text-danger text-sm border border-danger bg-danger/10 p-2">{err}</div>}
          <div>
            <label className="label-shop">TITLE</label>
            <input data-testid="letter-title" className="input-shop" placeholder="e.g. Reply to Dr. Underhood round 3" value={form.title} onChange={e=>setForm({...form, title: e.target.value, slug: form.slug || slugify(e.target.value)})}/>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label-shop">SLUG (URL part)</label>
              <input data-testid="letter-slug" className="input-shop" placeholder="brain-reply-round3" value={form.slug} onChange={e=>setForm({...form, slug: slugify(e.target.value)})}/>
            </div>
            <div>
              <label className="label-shop">TO (optional)</label>
              <input data-testid="letter-recipient" className="input-shop" placeholder="Dr. Underhood agent" value={form.recipient} onChange={e=>setForm({...form, recipient: e.target.value})}/>
            </div>
          </div>
          <div>
            <label className="label-shop">LETTER BODY (paste from anywhere)</label>
            <textarea data-testid="letter-body" rows={8} className="input-shop w-full font-mono text-xs" placeholder="Paste the letter text here..." value={form.body} onChange={e=>setForm({...form, body: e.target.value})}/>
            <div className="text-[10px] text-ink-3 mt-1">{form.body.length} chars · slug → /api/letter/{form.slug || "..."}</div>
          </div>
          <button data-testid="save-letter" onClick={save} disabled={busy} className="btn-rust w-full disabled:opacity-50">
            {busy ? "SAVING..." : "SAVE LETTER"}
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-ink-3 text-sm p-6 text-center">Loading...</div>
      ) : letters.length === 0 ? (
        <div className="border border-dashed border-line bg-bg-2 p-8 text-center">
          <Mail size={32} className="mx-auto text-rust mb-3"/>
          <div className="heading text-xl mb-2">NO LETTERS YET</div>
          <p className="text-ink-2 text-sm">Paste any agent-to-agent reply here and get a one-tap copy page for it.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {letters.map(L => (
            <div key={L.slug} className="border border-line bg-bg-2 p-3 md:p-4" data-testid={`letter-${L.slug}`}>
              <div className="flex items-start justify-between gap-2 flex-wrap mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Mail size={14} className="text-rust flex-shrink-0"/>
                    <span className="font-bold text-sm md:text-base break-words">{L.title || L.slug}</span>
                    {L.system_seed && <span className="text-[9px] text-amber2 uppercase tracking-widest border border-amber2/60 px-1">SYSTEM</span>}
                  </div>
                  {L.recipient && <div className="text-[11px] text-ink-3 mt-1">TO: <span className="text-amber2">{L.recipient}</span></div>}
                  <div className="text-[10px] text-ink-3 mt-1 font-mono">slug: {L.slug} · {(L.created_at||"").slice(0,10)}</div>
                </div>
                {!L.system_seed && (
                  <button onClick={()=>remove(L.slug)} className="text-ink-3 hover:text-danger p-1 flex-shrink-0" data-testid={`del-${L.slug}`}><Trash2 size={14}/></button>
                )}
              </div>
              <div className="flex gap-2 flex-wrap">
                <button onClick={()=>openCopyPage(L.slug)} className="btn-rust flex-1 min-w-0 flex items-center justify-center gap-2 py-3 text-sm" data-testid={`open-${L.slug}`}>
                  <Copy size={16}/>OPEN COPY PAGE
                </button>
                <button onClick={()=>copyLink(L.slug)} className="btn-ghost flex items-center justify-center gap-2 py-3 px-3 text-sm" data-testid={`link-${L.slug}`}>
                  <ExternalLink size={14}/>COPY LINK
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
