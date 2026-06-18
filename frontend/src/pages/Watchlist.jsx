import React, { useEffect, useState } from "react";
import { Trash2, RefreshCw, Plus, Globe, Check, AlertCircle, BookOpen } from "lucide-react";
import api from "@/api";

// Wrench's crawl watchlist — Doc adds URLs Wrench should pull into the brain.
// Public sites are scraped instantly. Login-required sites use Vault creds.

export default function Watchlist() {
  const [items, setItems] = useState([]);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [tag, setTag] = useState("");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");
  const [busyId, setBusyId] = useState("");
  const [allBusy, setAllBusy] = useState(false);

  const load = async () => {
    const r = await api.get("/scrape/watchlist");
    setItems(r.data || []);
  };

  useEffect(() => { load(); }, []);

  const addOne = async (e) => {
    e?.preventDefault?.();
    if (!url.trim()) return;
    setAdding(true); setMsg("");
    try {
      await api.post("/scrape/watchlist", { url: url.trim(), title: title.trim() || null, tag: tag.trim() || null });
      setUrl(""); setTitle(""); setTag("");
      setMsg("Added — hit CRAWL NOW to pull it into the brain.");
      load();
    } catch (err) {
      setMsg(err?.response?.data?.detail || "Couldn't add that.");
    } finally { setAdding(false); }
  };

  const removeOne = async (id) => {
    await api.delete(`/scrape/watchlist/${id}`);
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const crawlOne = async (id) => {
    setBusyId(id); setMsg("");
    try {
      const r = await api.post(`/scrape/watchlist/${id}/crawl`);
      if (r.data?.ok) {
        setMsg(`Pulled ${r.data.chunks} chunks. Wrench knows it now.`);
      } else {
        setMsg(`Crawl failed: ${r.data?.error || "unknown error"}`);
      }
      load();
    } catch (err) {
      setMsg(err?.response?.data?.detail || "Crawl failed.");
    } finally { setBusyId(""); }
  };

  const crawlAll = async () => {
    if (!items.length) return;
    setAllBusy(true); setMsg("");
    try {
      const r = await api.post("/scrape/watchlist/crawl-all");
      setMsg(`${r.data.ok}/${r.data.total} crawled. ${r.data.failed} failed.`);
      load();
    } catch (err) {
      setMsg(err?.response?.data?.detail || "Crawl-all failed.");
    } finally { setAllBusy(false); }
  };

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto" data-testid="watchlist-page">
      <div className="mb-4 border-b border-line pb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="heading text-3xl md:text-4xl flex items-center gap-3">
            <Globe className="text-amber2" size={32}/>
            WATCHLIST <span className="text-rust">// FEED THE BRAIN</span>
          </h1>
          <p className="text-ink-3 text-xs mt-1 uppercase tracking-widest">
            Add URLs. Wrench reads them, chunks them, embeds them. Forever in the brain.
          </p>
        </div>
        <button data-testid="crawl-all-btn" onClick={crawlAll} disabled={allBusy || items.length === 0}
          className="btn-rust flex items-center gap-2 disabled:opacity-40">
          <RefreshCw size={14} className={allBusy ? "animate-spin" : ""}/>
          {allBusy ? "CRAWLING..." : "CRAWL ALL"}
        </button>
      </div>

      {/* Add form */}
      <form onSubmit={addOne} className="panel p-4 mb-4 space-y-3" data-testid="watchlist-add-form">
        <div>
          <label className="text-[11px] uppercase tracking-widest text-ink-3">URL *</label>
          <input data-testid="watchlist-url" value={url} onChange={e=>setUrl(e.target.value)}
            placeholder="https://www.hptuners.com/forum/forumdisplay.php?f=53"
            className="input-shop w-full mt-1"/>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] uppercase tracking-widest text-ink-3">Title (optional)</label>
            <input data-testid="watchlist-title" value={title} onChange={e=>setTitle(e.target.value)}
              placeholder="HPT AFM Delete Forum"
              className="input-shop w-full mt-1"/>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-widest text-ink-3">Tag (optional)</label>
            <input data-testid="watchlist-tag" value={tag} onChange={e=>setTag(e.target.value)}
              placeholder="HPT, TSB, Parts, JASPER..."
              className="input-shop w-full mt-1"/>
          </div>
        </div>
        <button type="submit" disabled={adding || !url.trim()} data-testid="watchlist-add-btn"
          className="btn-rust flex items-center gap-2 disabled:opacity-40">
          <Plus size={14}/>
          {adding ? "ADDING..." : "ADD TO WATCHLIST"}
        </button>
        {msg && <div className="text-sm text-amber2 font-mono border-l-2 border-amber2 pl-3">{msg}</div>}
      </form>

      {/* List */}
      {items.length === 0 ? (
        <div className="panel p-6 text-center text-ink-3 text-sm uppercase tracking-widest" data-testid="no-watchlist">
          Nothing yet. Add a URL above.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(it => (
            <div key={it.id} className="panel p-4" data-testid={`watch-${it.id}`}>
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-amber2 font-bold uppercase tracking-widest text-sm break-words">
                    {it.title || it.url}
                  </div>
                  <a href={it.url} target="_blank" rel="noopener noreferrer"
                    className="text-ink-3 text-[11px] hover:text-amber2 break-all">
                    {it.url}
                  </a>
                  <div className="flex flex-wrap gap-2 mt-2 text-[10px] uppercase tracking-widest text-ink-3">
                    {it.tag && <span className="text-amber2 border border-amber2/40 px-2 py-0.5">{it.tag}</span>}
                    {it.last_crawled_at ? (
                      <span className="text-ok flex items-center gap-1">
                        <Check size={10}/> Last: {new Date(it.last_crawled_at).toLocaleDateString()} · {it.last_chunks} chunks
                      </span>
                    ) : (
                      <span className="text-ink-3">Never crawled</span>
                    )}
                    {it.last_status && it.last_status.startsWith("err") && (
                      <span className="text-danger flex items-center gap-1">
                        <AlertCircle size={10}/> {it.last_status.slice(0,60)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <button data-testid={`crawl-${it.id}`} onClick={()=>crawlOne(it.id)} disabled={busyId === it.id}
                    title="Crawl now"
                    className={`w-10 h-10 border-2 ${busyId === it.id ? "bg-amber2 text-bg-1" : "border-amber2 text-amber2 hover:bg-amber2 hover:text-bg-1"} flex items-center justify-center transition-colors disabled:opacity-50`}>
                    <RefreshCw size={16} className={busyId === it.id ? "animate-spin" : ""}/>
                  </button>
                  <button data-testid={`del-${it.id}`} onClick={()=>removeOne(it.id)}
                    title="Remove"
                    className="w-10 h-10 border-2 border-danger text-danger hover:bg-danger hover:text-bg-1 flex items-center justify-center transition-colors">
                    <Trash2 size={16}/>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Starter ideas */}
      <div className="panel p-4 mt-6 bg-bg-2">
        <h3 className="text-amber2 text-sm font-black uppercase tracking-widest mb-2 flex items-center gap-2">
          <BookOpen size={14}/> STARTER IDEAS
        </h3>
        <ul className="text-ink-2 text-sm space-y-1 list-disc pl-5">
          <li>HP Tuners forum subforums (AFM delete, LS tuning, calibration writeups)</li>
          <li>JASPER product spec pages</li>
          <li>Cam Motion / Comp Cams / BTR cam grind pages</li>
          <li>NHTSA recall pages for vehicles you work on</li>
          <li>RockAuto / Summit catalog pages for parts you order weekly</li>
          <li>GM TSB pages (need AllData/Identifix login — set in Vault first)</li>
        </ul>
      </div>
    </div>
  );
}
