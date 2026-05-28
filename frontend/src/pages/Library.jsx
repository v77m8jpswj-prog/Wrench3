import React, { useEffect, useState, useRef } from "react";
import { Upload, Trash2, FileText, FileSpreadsheet, BookOpen, RefreshCw, Link as LinkIcon, ExternalLink, Loader, ClipboardPaste, FileArchive } from "lucide-react";
import api from "@/api";

export default function Library() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlMsg, setUrlMsg] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteMsg, setPasteMsg] = useState("");
  const [zipBusy, setZipBusy] = useState(false);
  const [zipBatch, setZipBatch] = useState(null); // { batch_id, total, done, failed, skipped, status }
  const fileRef = useRef(null);
  const zipRef = useRef(null);

  const refresh = async () => {
    const r = await api.get("/library");
    setItems(r.data || []);
    window.dispatchEvent(new CustomEvent("wrench-libcount", { detail: r.data.length }));
  };

  useEffect(()=>{ refresh(); }, []);

  const upload = async (file) => {
    setBusy(true); setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.post("/library/upload", fd, { headers: { "Content-Type": "multipart/form-data" }});
      await refresh();
    } catch (e) { setErr(e?.response?.data?.detail || e.message); }
    finally { setBusy(false); }
  };

  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if ((f.name || "").toLowerCase().endsWith(".zip")) {
      onZip({ target: { files: [f] } });
    } else {
      upload(f);
    }
  };

  const del = async (id) => {
    if (!window.confirm("Wipe this from the library?")) return;
    await api.delete(`/library/${id}`);
    refresh();
  };

  const iconFor = (k) => k === "url" ? LinkIcon : k === "pdf" ? FileText : k === "csv" ? FileSpreadsheet : k === "paste" ? ClipboardPaste : BookOpen;

  const feedUrl = async () => {
    setErr(""); setUrlMsg("");
    if (!url.trim()) return;
    setUrlBusy(true);
    try {
      const r = await api.post("/scrape/url", { url: url.trim() }, { timeout: 240000 });
      setUrlMsg(`✓ Ingested "${r.data.title?.slice(0,60) || "page"}" — ${r.data.chunks_ingested} chunks, ${r.data.chars} chars${r.data.needed_login ? " (used Vault login)" : ""}.`);
      setUrl("");
      refresh();
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Scrape failed");
    } finally { setUrlBusy(false); }
  };

  const feedPaste = async () => {
    setErr(""); setPasteMsg("");
    if (!pasteText.trim()) { setErr("Paste some text first."); return; }
    setPasteBusy(true);
    try {
      const r = await api.post("/library/paste", { title: pasteTitle || "Pasted text", text: pasteText });
      setPasteMsg(`✓ "${r.data.title?.slice(0,60)}" — ${r.data.chunks_ingested} chunks, ${r.data.chars} chars.`);
      setPasteText(""); setPasteTitle("");
      refresh();
      setTimeout(() => setPasteMsg(""), 4000);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Paste failed");
    } finally { setPasteBusy(false); }
  };

  const onZip = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(""); setZipBusy(true); setZipBatch(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await api.post("/library/upload-zip", fd, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 600000,
      });
      // Start polling batch status
      const initial = { batch_id: r.data.batch_id, total: r.data.queued, done: 0, failed: 0, skipped: r.data.skipped, status: "running" };
      setZipBatch(initial);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Zip upload failed");
    } finally {
      setZipBusy(false);
      if (zipRef.current) zipRef.current.value = "";
    }
  };

  // Poll the active zip batch and refresh the library list as files finish
  useEffect(() => {
    if (!zipBatch || zipBatch.status === "done") return;
    const interval = setInterval(async () => {
      try {
        const r = await api.get(`/library/batch/${zipBatch.batch_id}`);
        setZipBatch(r.data);
        refresh();
        if (r.data.status === "done") clearInterval(interval);
      } catch {
        // batch row may not exist yet on first tick — keep polling
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [zipBatch?.batch_id, zipBatch?.status]);

  return (
    <div className="p-6" data-testid="library-page">
      <div className="flex items-end justify-between mb-4 border-b border-line pb-4">
        <div>
          <h1 className="heading text-4xl">LIBRARY <span className="text-rust">// RAG</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">DROP MANUALS, NOTES, LOGS — WRENCH CITES THEM</p>
        </div>
        <div className="flex items-center gap-2">
          <button data-testid="upload-zip-btn" onClick={()=>zipRef.current?.click()} disabled={zipBusy}
            className="text-xs uppercase tracking-widest border-2 border-amber2 text-amber2 px-3 py-2 flex items-center gap-1.5 hover:bg-amber2/10 disabled:opacity-50">
            <FileArchive size={14}/>
            {zipBusy ? "UPLOADING..." : "UPLOAD ZIP"}
          </button>
          <button data-testid="upload-btn" onClick={()=>fileRef.current?.click()} className="btn-rust flex items-center gap-2"><Upload size={16}/>UPLOAD</button>
        </div>
        <input ref={fileRef} type="file" hidden accept=".pdf,.txt,.md,.csv,.log,.png,.jpg,.jpeg,.webp,.gif,.hpt,.hpl,.bin,.tune" onChange={e=>e.target.files?.[0]&&upload(e.target.files[0])} data-testid="file-input"/>
        <input ref={zipRef} type="file" hidden accept=".zip" onChange={onZip} data-testid="zip-input"/>
      </div>

      {zipBatch && (
        <div className="panel p-3 mb-4 border-l-4 border-amber2" data-testid="zip-batch-status">
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest">
            <FileArchive size={14} className="text-amber2"/>
            <span className="text-amber2 font-bold">ZIP INGEST</span>
            <span className="text-ink-2">
              {zipBatch.done}/{zipBatch.total} done
              {zipBatch.failed ? ` · ${zipBatch.failed} failed` : ""}
              {zipBatch.skipped ? ` · ${zipBatch.skipped} skipped` : ""}
            </span>
            <span className={`ml-auto ${zipBatch.status === "done" ? "text-ok" : "text-rust animate-pulse"}`}>
              {zipBatch.status === "done" ? "✓ COMPLETE" : "WORKING..."}
            </span>
          </div>
          <div className="mt-2 h-1.5 bg-bg-3 overflow-hidden">
            <div
              className={`h-full ${zipBatch.status === "done" ? "bg-ok" : "bg-amber2"} transition-all`}
              style={{ width: `${Math.min(100, Math.round(((zipBatch.done + zipBatch.failed) / Math.max(1, zipBatch.total)) * 100))}%` }}
            />
          </div>
          {zipBatch.status === "done" && (
            <button onClick={()=>setZipBatch(null)} className="text-[10px] text-ink-3 hover:text-ink mt-2 uppercase tracking-widest">dismiss</button>
          )}
        </div>
      )}

      <div
        onDragOver={e=>e.preventDefault()}
        onDrop={onDrop}
        data-testid="dropzone"
        className="border-2 border-dashed border-line p-8 text-center mb-4 hover:border-rust transition-colors">
        <Upload size={28} className="mx-auto text-ink-3 mb-2"/>
        <div className="heading text-xl">DROP FILES HERE</div>
        <div className="text-ink-3 text-xs uppercase tracking-widest mt-1">PDF · IMAGES · TXT · MD · CSV · LOG · <span className="text-rust">.HPT / .HPL TUNE FILES</span></div>
        <div className="text-[10px] text-amber2 uppercase tracking-widest mt-1">GOT A WHOLE BOOK OF PAGES? ZIP IT UP — HIT <span className="font-bold">UPLOAD ZIP</span> ABOVE</div>
        {busy && <div className="text-rust mt-2 animate-blink text-xs">PROCESSING...</div>}
        {err && <div className="text-danger mt-2 text-xs">ERR: {err}</div>}
        <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-3 max-w-xl mx-auto">
          NOTE ON .HPT: HP TUNERS' BINARY FORMAT IS PROPRIETARY · WRENCH STORES THE FILE + EXTRACTS METADATA (VIN, OS, CALIBRATION ID).<br/>
          FOR TABLE EDITS, USE THE <span className="text-rust">CHARTS</span> TAB — SCREENSHOT OR PASTE THE SPECIFIC TABLE.
        </div>
      </div>

      <div className="panel mb-6 p-4 border-l-4 border-amber2" data-testid="url-feeder">
        <div className="flex items-center gap-2 mb-2">
          <LinkIcon size={16} className="text-amber2"/>
          <div className="heading text-base">FEED FROM URL</div>
        </div>
        <p className="text-xs text-ink-2 mb-3">
          Paste any URL. Wrench reads the page and adds it to the brain. Works on public sites (HP Tuners forum, manufacturer service bulletins, YouTube transcripts) and paywalled sites like <span className="text-amber2">AllData</span> and <span className="text-amber2">Identifix</span> — for those, save your login in the <span className="text-amber2">Vault</span> first and Wrench will use it.
        </p>
        <div className="flex gap-2 flex-col sm:flex-row">
          <input
            data-testid="url-input"
            value={url}
            onChange={e=>setUrl(e.target.value)}
            placeholder="https://forum.hptuners.com/showthread.php?..."
            className="input-shop flex-1 text-sm"
            onKeyDown={e=>{ if (e.key === "Enter") feedUrl(); }}
          />
          <button onClick={feedUrl} disabled={urlBusy || !url.trim()} className="btn-rust px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50" data-testid="url-feed-btn">
            {urlBusy ? <Loader size={14} className="animate-spin"/> : <ExternalLink size={14}/>}{urlBusy ? "READING..." : "FEED IT"}
          </button>
        </div>
        {urlMsg && <div className="mt-2 text-xs text-ok" data-testid="url-feed-msg">{urlMsg}</div>}
      </div>

      <div className="panel mb-6 p-4 border-l-4 border-amber2" data-testid="paste-feeder">
        <button onClick={()=>setPasteOpen(o=>!o)} className="flex items-center gap-2 w-full text-left" data-testid="paste-toggle">
          <ClipboardPaste size={16} className="text-amber2"/>
          <div className="heading text-base flex-1">PASTE TEXT INTO BRAIN</div>
          <div className="text-[10px] text-ink-3 uppercase tracking-widest">{pasteOpen ? "HIDE" : "OPEN"}</div>
        </button>
        {pasteOpen && (
          <div className="mt-3">
            <p className="text-xs text-ink-2 mb-3">
              Copy text from anywhere (GM SI, behind 2FA sites, PDFs you can't upload, your own notes) and paste it here. Wrench learns it instantly.
            </p>
            <input
              data-testid="paste-title"
              value={pasteTitle}
              onChange={e=>setPasteTitle(e.target.value)}
              placeholder="Title — e.g. '2014 Silverado P0011 TSB' or 'My cam swap notes'"
              className="input-shop w-full text-sm mb-2"
            />
            <textarea
              data-testid="paste-textarea"
              value={pasteText}
              onChange={e=>setPasteText(e.target.value)}
              placeholder="Paste the text here..."
              rows={8}
              className="input-shop w-full text-sm font-mono"
            />
            <div className="flex items-center justify-between mt-2">
              <div className="text-[10px] text-ink-3 uppercase tracking-widest">{pasteText.length} chars</div>
              <button onClick={feedPaste} disabled={pasteBusy || pasteText.length < 30} className="btn-rust px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-40" data-testid="paste-submit">
                {pasteBusy ? <Loader size={14} className="animate-spin"/> : <ClipboardPaste size={14}/>}{pasteBusy ? "LEARNING..." : "FEED TO BRAIN"}
              </button>
            </div>
            {pasteMsg && <div className="mt-2 text-xs text-ok" data-testid="paste-msg">{pasteMsg}</div>}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="px-4 py-2 border-b border-line text-[11px] uppercase tracking-widest text-ink-3 flex justify-between">
          <span>{items.length} ITEMS</span>
          <button onClick={refresh} className="hover:text-rust flex items-center gap-1"><RefreshCw size={12}/>REFRESH</button>
        </div>
        {items.length === 0 ? (
          <div className="p-6 text-ink-3 text-sm text-center">No files yet. Drop some manuals.</div>
        ) : items.map(it => {
          const Icon = iconFor(it.kind);
          return (
            <div key={it.id} className="px-4 py-3 border-b border-line flex items-center justify-between hover:bg-bg-3" data-testid={`lib-item-${it.id}`}>
              <div className="flex items-center gap-3">
                <Icon size={18} className="text-rust"/>
                <div>
                  <div className="text-sm">{it.name}</div>
                  <div className="text-[10px] text-ink-3 uppercase tracking-widest">{it.kind} · {Math.round(it.size/1024)} KB · {it.chunk_count} CHUNKS · {it.status}</div>
                </div>
              </div>
              <button onClick={()=>del(it.id)} data-testid={`del-${it.id}`} className="text-ink-3 hover:text-danger"><Trash2 size={16}/></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
