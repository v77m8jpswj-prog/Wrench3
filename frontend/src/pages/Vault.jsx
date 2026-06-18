import React, { useEffect, useState } from "react";
import { Plus, Trash2, Save, Eye, EyeOff, Copy, ExternalLink, KeyRound } from "lucide-react";
import api from "@/api";

const EMPTY = { site: "", url: "", username: "", password: "", notes: "" };

export default function Vault() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [reveal, setReveal] = useState({});
  const [filter, setFilter] = useState("");
  const [copiedField, setCopiedField] = useState("");

  const refresh = async () => { const r = await api.get("/credentials"); setList(r.data || []); };
  useEffect(()=>{ refresh(); }, []);

  const save = async () => {
    if (!form.site.trim()) return;
    if (editing) await api.put(`/credentials/${editing}`, form);
    else await api.post("/credentials", form);
    setForm(EMPTY); setEditing(null);
    refresh();
  };

  const del = async (id) => {
    if (!window.confirm("Delete this credential?")) return;
    await api.delete(`/credentials/${id}`);
    refresh();
  };

  const startEdit = (c) => {
    setEditing(c.id);
    setForm({ site:c.site||"", url:c.url||"", username:c.username||"", password:c.password||"", notes:c.notes||""});
  };

  const copy = async (key, text) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedField(key);
    setTimeout(()=>setCopiedField(""), 1500);
  };

  const filtered = filter.trim()
    ? list.filter(c => (c.site + " " + c.url + " " + c.notes).toLowerCase().includes(filter.toLowerCase()))
    : list;

  return (
    <div className="p-4 md:p-6" data-testid="vault-page">
      <div className="flex items-end justify-between mb-4 border-b border-line pb-4">
        <div>
          <h1 className="heading text-3xl md:text-4xl"><KeyRound size={28} className="inline mb-1 mr-2 text-rust"/>VAULT</h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">SAVED LOGINS · WRENCH CAN LOOK THESE UP DURING A CALL</p>
        </div>
      </div>

      <div className="border border-amber2/40 bg-amber2/5 p-3 mb-4 text-xs text-amber2 uppercase tracking-widest">
        ⚠ STORED LOCALLY IN YOUR MONGODB — NOT ENCRYPTED. SINGLE-USER MVP. DON'T STORE BANKING / SSN.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,1.4fr] gap-4">
        <div className="panel p-4">
          <div className="heading text-xl mb-3">{editing ? "EDIT CREDENTIAL" : "ADD CREDENTIAL"}</div>
          <div className="space-y-3">
            <div><label className="label-shop">SITE / SERVICE NAME *</label><input data-testid="c-site" value={form.site} onChange={e=>setForm({...form,site:e.target.value})} className="input-shop" placeholder="HP Tuners / RockAuto / GM SI"/></div>
            <div><label className="label-shop">URL</label><input data-testid="c-url" value={form.url} onChange={e=>setForm({...form,url:e.target.value})} className="input-shop" placeholder="https://www.hptuners.com/login"/></div>
            <div><label className="label-shop">USERNAME / EMAIL</label><input data-testid="c-user" value={form.username} onChange={e=>setForm({...form,username:e.target.value})} className="input-shop"/></div>
            <div><label className="label-shop">PASSWORD</label><input data-testid="c-pass" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} className="input-shop font-mono"/></div>
            <div><label className="label-shop">NOTES</label><textarea data-testid="c-notes" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} rows={2} className="input-shop"/></div>
          </div>
          <div className="mt-4 flex gap-2">
            <button data-testid="c-save" onClick={save} className="btn-rust flex items-center gap-2"><Save size={14}/>{editing?"UPDATE":"ADD"}</button>
            {editing && <button onClick={()=>{setEditing(null); setForm(EMPTY);}} className="btn-ghost">CANCEL</button>}
          </div>
        </div>

        <div className="panel">
          <div className="px-4 py-2 border-b border-line flex items-center gap-3">
            <span className="text-[11px] uppercase tracking-widest text-ink-3">{filtered.length} OF {list.length}</span>
            <input data-testid="c-filter" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="filter..." className="input-shop !py-1 text-xs flex-1"/>
          </div>
          {filtered.length === 0 ? (
            <div className="p-6 text-ink-3 text-sm text-center">No credentials yet.</div>
          ) : filtered.map(c => (
            <div key={c.id} className="px-4 py-3 border-b border-line hover:bg-bg-3" data-testid={`c-row-${c.id}`}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold">{c.site}</span>
                  {c.url && (
                    <a href={c.url.startsWith("http")?c.url:`https://${c.url}`} target="_blank" rel="noopener noreferrer" className="text-amber2 hover:text-rust"><ExternalLink size={12}/></a>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={()=>startEdit(c)} className="btn-ghost text-xs">EDIT</button>
                  <button onClick={()=>del(c.id)} className="text-ink-3 hover:text-danger"><Trash2 size={14}/></button>
                </div>
              </div>
              {c.username && (
                <div className="flex items-center gap-2 text-xs mb-1">
                  <span className="text-ink-3 uppercase w-16">USER</span>
                  <span className="font-mono flex-1 truncate">{c.username}</span>
                  <button onClick={()=>copy(`${c.id}-u`, c.username)} className={`text-[10px] uppercase tracking-widest hover:text-rust ${copiedField===`${c.id}-u`?"text-ok":"text-ink-3"}`}>{copiedField===`${c.id}-u`?"COPIED":"COPY"}</button>
                </div>
              )}
              {c.password && (
                <div className="flex items-center gap-2 text-xs mb-1">
                  <span className="text-ink-3 uppercase w-16">PASS</span>
                  <span className="font-mono flex-1 truncate">{reveal[c.id] ? c.password : "•".repeat(Math.min(c.password.length, 10))}</span>
                  <button onClick={()=>setReveal({...reveal, [c.id]: !reveal[c.id]})} className="text-ink-3 hover:text-rust">{reveal[c.id]?<EyeOff size={12}/>:<Eye size={12}/>}</button>
                  <button onClick={()=>copy(`${c.id}-p`, c.password)} className={`text-[10px] uppercase tracking-widest hover:text-rust ${copiedField===`${c.id}-p`?"text-ok":"text-ink-3"}`}>{copiedField===`${c.id}-p`?"COPIED":"COPY"}</button>
                </div>
              )}
              {c.notes && <div className="text-[11px] text-ink-3 mt-1">{c.notes}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
