import React, { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, X, Trash2, Edit3, Brain, AlertCircle, CheckCircle2, Circle, Zap, ClipboardPaste, FileText, Upload } from "lucide-react";
import api from "@/api";

const blank = {
  vehicle: { vin: "", year: "", make: "", model: "", engine: "" },
  symptom: "", dtc_codes: [], root_cause: "", repair_summary: "",
  parts: [], technician_name: "", outcome: "FIXED", labor_hours: "",
  confidence_note: "",
};

export default function Cases() {
  const nav = useNavigate();
  const [cases, setCases] = useState([]);
  const [editing, setEditing] = useState(null); // case object or "new"
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bulkOpen, setBulkOpen] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.get("/cases");
      setCases(r.data || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

  const remove = async (id) => {
    if (!window.confirm("Delete this case from the brain?")) return;
    await api.delete(`/cases/${id}`);
    refresh();
  };

  return (
    <div className="px-3 md:px-6 py-4 md:py-6 max-w-5xl mx-auto" data-testid="cases-page">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="heading text-2xl md:text-3xl">CASES <span className="text-rust">// BRAIN</span></h1>
          <p className="text-ink-3 text-xs uppercase tracking-widest mt-1">
            Every closed repair makes Wrench smarter for the next one
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button data-testid="bulk-paste-btn" onClick={()=>setBulkOpen(true)} className="btn-ghost flex items-center gap-2 text-sm">
            <ClipboardPaste size={16}/> PASTE RO
          </button>
          <button data-testid="new-case-btn" onClick={()=>setEditing({...blank, id:"new"})} className="btn-rust flex items-center gap-2 text-sm">
            <Plus size={16}/> NEW CASE
          </button>
        </div>
      </div>

      <div className="border border-line bg-bg-2 p-3 md:p-4 mb-4 flex items-center gap-3 flex-wrap text-sm" data-testid="brain-stats">
        <Brain size={20} className="text-rust"/>
        <span className="text-ink-2">Brain holds</span>
        <span className="text-amber2 font-bold heading text-xl">{cases.length}</span>
        <span className="text-ink-2">case{cases.length===1?"":"s"} for your shop.</span>
        <span className="text-ink-3 text-xs ml-auto">More you log, smarter he gets.</span>
      </div>

      {loading ? (
        <div className="text-ink-3 text-sm p-6 text-center">Loading cases...</div>
      ) : cases.length === 0 ? (
        <div className="border border-dashed border-line bg-bg-2 p-8 text-center" data-testid="empty-cases">
          <Brain size={32} className="mx-auto text-rust mb-3"/>
          <div className="heading text-xl mb-2">NO CASES YET</div>
          <p className="text-ink-2 text-sm mb-4 max-w-md mx-auto">
            Close a job? Log it here. Every case you save becomes searchable shop knowledge — symptom in,
            past fix out. This is how Wrench beats generic AI.
          </p>
          <button onClick={()=>setEditing({...blank, id:"new"})} className="btn-rust">+ LOG YOUR FIRST CASE</button>
        </div>
      ) : (
        <div className="space-y-2">
          {cases.map(c => <CaseCard key={c.id} c={c} onEdit={()=>setEditing(c)} onDelete={()=>remove(c.id)}/>)}
        </div>
      )}

      {editing && (
        <CaseEditor
          initial={editing}
          onClose={()=>setEditing(null)}
          onSaved={()=>{ setEditing(null); refresh(); }}
        />
      )}

      {bulkOpen && (
        <BulkPaste
          onClose={()=>setBulkOpen(false)}
          onIngested={()=>refresh()}
        />
      )}
    </div>
  );
}

function CaseCard({ c, onEdit, onDelete }) {
  const v = c.vehicle || {};
  const veh = [v.year, v.make, v.model, v.engine].filter(Boolean).join(" ");
  const outcomeColor = c.outcome === "FIXED" ? "text-ok" : c.outcome === "PARTIAL" ? "text-amber2" : "text-danger";
  const OutcomeIcon = c.outcome === "FIXED" ? CheckCircle2 : c.outcome === "NOT_FIXED" ? AlertCircle : Circle;
  return (
    <div className="border border-line bg-bg-2 p-3 md:p-4 hover:border-rust/60 transition-colors" data-testid={`case-${c.id}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`font-head text-xs uppercase tracking-widest font-bold flex items-center gap-1 ${outcomeColor}`}>
              <OutcomeIcon size={12}/> {c.outcome}
            </span>
            {veh && <span className="text-amber2 text-xs uppercase tracking-widest font-bold">{veh}</span>}
            {c.dtc_codes?.length>0 && <span className="text-[10px] text-ink-3 font-mono">{c.dtc_codes.join(", ")}</span>}
          </div>
          <div className="text-sm font-bold mb-1 break-words">{c.symptom}</div>
          {c.root_cause && <div className="text-xs text-ink-2 mb-1"><span className="text-rust">CAUSE:</span> {c.root_cause}</div>}
          {c.repair_summary && <div className="text-xs text-ink-2 break-words"><span className="text-rust">REPAIR:</span> {c.repair_summary}</div>}
          {c.parts?.length>0 && (
            <div className="text-[10px] text-ink-3 mt-1 font-mono break-words">PARTS: {c.parts.join(" · ")}</div>
          )}
          <div className="text-[10px] text-ink-3 mt-2 uppercase tracking-widest flex items-center gap-3 flex-wrap">
            {c.technician_name && <span>BY {c.technician_name}</span>}
            <span>{(c.created_at||"").slice(0,10)}</span>
            {c.labor_hours != null && <span>{c.labor_hours}hr</span>}
            {c.source==="chat_draft" && <span className="text-amber2">FROM CHAT DRAFT</span>}
          </div>
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button onClick={onEdit} data-testid={`case-edit-${c.id}`} className="text-ink-2 hover:text-rust p-2" title="Edit"><Edit3 size={16}/></button>
          <button onClick={onDelete} data-testid={`case-delete-${c.id}`} className="text-ink-2 hover:text-danger p-2" title="Delete"><Trash2 size={16}/></button>
        </div>
      </div>
    </div>
  );
}

function CaseEditor({ initial, onClose, onSaved }) {
  const isNew = !initial.id || initial.id === "new";
  const [form, setForm] = useState(() => ({
    ...blank,
    ...initial,
    vehicle: { ...blank.vehicle, ...(initial.vehicle || {}) },
    dtc_codes: initial.dtc_codes || [],
    parts: initial.parts || [],
    labor_hours: initial.labor_hours ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const upd = (k, v) => setForm(f => ({...f, [k]: v}));
  const updv = (k, v) => setForm(f => ({...f, vehicle: {...f.vehicle, [k]: v}}));

  const save = async () => {
    setErr(""); setSaving(true);
    try {
      const payload = {
        ...form,
        labor_hours: form.labor_hours === "" ? null : parseFloat(form.labor_hours),
        dtc_codes: typeof form.dtc_codes === "string" ? form.dtc_codes.split(",").map(s=>s.trim()).filter(Boolean) : form.dtc_codes,
        parts: typeof form.parts === "string" ? form.parts.split("\n").map(s=>s.trim()).filter(Boolean) : form.parts,
      };
      if (!payload.symptom?.trim()) throw new Error("Symptom is required");
      if (!payload.shop_id) payload.shop_id = ""; // backend fills from user
      if (isNew) await api.post("/cases", payload);
      else await api.put(`/cases/${form.id}`, payload);
      onSaved();
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex" data-testid="case-editor">
      <div className="flex-1 bg-black/70" onClick={onClose}/>
      <div className="w-full md:w-[640px] bg-bg-2 border-l border-line overflow-auto">
        <div className="sticky top-0 bg-bg-2 border-b border-line px-4 py-3 flex items-center justify-between">
          <span className="heading text-lg">{isNew ? "NEW CASE" : "EDIT CASE"}</span>
          <button onClick={onClose} className="text-ink-2 p-1" data-testid="close-editor"><X size={20}/></button>
        </div>
        <div className="p-4 space-y-4">
          {err && <div className="border border-danger bg-danger/10 text-danger text-sm p-3" data-testid="form-error">{err}</div>}

          <div>
            <label className="label-shop">VEHICLE</label>
            <div className="grid grid-cols-2 gap-2">
              <input data-testid="case-year" className="input-shop" placeholder="Year" value={form.vehicle.year} onChange={e=>updv("year", e.target.value)} />
              <input data-testid="case-make" className="input-shop" placeholder="Make" value={form.vehicle.make} onChange={e=>updv("make", e.target.value)} />
              <input data-testid="case-model" className="input-shop" placeholder="Model" value={form.vehicle.model} onChange={e=>updv("model", e.target.value)} />
              <input data-testid="case-engine" className="input-shop" placeholder="Engine (e.g. 6.7L Powerstroke)" value={form.vehicle.engine} onChange={e=>updv("engine", e.target.value)} />
              <input data-testid="case-vin" className="input-shop col-span-2" placeholder="VIN (optional)" value={form.vehicle.vin} onChange={e=>updv("vin", e.target.value.toUpperCase())} />
            </div>
          </div>

          <div>
            <label className="label-shop">SYMPTOM (what the customer / log said)</label>
            <textarea data-testid="case-symptom" className="input-shop w-full" rows={2} placeholder="rough idle when cold, smells like gas" value={form.symptom} onChange={e=>upd("symptom", e.target.value)} required />
          </div>

          <div>
            <label className="label-shop">DTC CODES (comma separated)</label>
            <input data-testid="case-dtc" className="input-shop" placeholder="P0300, P0171"
              value={Array.isArray(form.dtc_codes) ? form.dtc_codes.join(", ") : form.dtc_codes}
              onChange={e=>upd("dtc_codes", e.target.value)} />
          </div>

          <div>
            <label className="label-shop">ROOT CAUSE</label>
            <textarea data-testid="case-cause" className="input-shop w-full" rows={2} placeholder="Stuck PCV valve flooding intake on cold start" value={form.root_cause} onChange={e=>upd("root_cause", e.target.value)} />
          </div>

          <div>
            <label className="label-shop">REPAIR (what you actually did)</label>
            <textarea data-testid="case-repair" className="input-shop w-full" rows={3} placeholder="Replaced PCV valve, cleaned throttle body and upper intake. Verified no codes after 50 mile drive." value={form.repair_summary} onChange={e=>upd("repair_summary", e.target.value)} />
          </div>

          <div>
            <label className="label-shop">PARTS (one per line — SKU or description)</label>
            <textarea data-testid="case-parts" className="input-shop w-full" rows={3} placeholder={"GM 12568576 PCV valve\nMOTORCRAFT FA-1883 air filter"}
              value={Array.isArray(form.parts) ? form.parts.join("\n") : form.parts}
              onChange={e=>upd("parts", e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label-shop">OUTCOME</label>
              <select data-testid="case-outcome" className="input-shop" value={form.outcome} onChange={e=>upd("outcome", e.target.value)}>
                <option value="FIXED">FIXED</option>
                <option value="PARTIAL">PARTIAL</option>
                <option value="NOT_FIXED">NOT FIXED</option>
              </select>
            </div>
            <div>
              <label className="label-shop">LABOR HOURS</label>
              <input data-testid="case-hours" className="input-shop" type="number" step="0.25" placeholder="1.5" value={form.labor_hours} onChange={e=>upd("labor_hours", e.target.value)} />
            </div>
          </div>

          <div>
            <label className="label-shop">TECH (who closed it)</label>
            <input data-testid="case-tech" className="input-shop" placeholder="Doc" value={form.technician_name} onChange={e=>upd("technician_name", e.target.value)} />
          </div>

          <div>
            <label className="label-shop">NOTES (any extra context for the brain)</label>
            <textarea data-testid="case-notes" className="input-shop w-full" rows={2} placeholder="customer mentioned it only does this below 40°F"
              value={form.confidence_note} onChange={e=>upd("confidence_note", e.target.value)} />
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={save} disabled={saving} data-testid="save-case" className="btn-rust flex-1 disabled:opacity-50">
              {saving ? "SAVING..." : isNew ? "ADD TO BRAIN" : "UPDATE"}
            </button>
            <button onClick={onClose} className="btn-ghost px-6">CANCEL</button>
          </div>
        </div>
      </div>
    </div>
  );
}


function BulkPaste({ onClose, onIngested }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]); // [{ok, parsed_summary, parsed_case, error}]
  const [totalInBrain, setTotalInBrain] = useState(null);
  const [err, setErr] = useState("");
  const [pdfInfo, setPdfInfo] = useState(null); // {filename, pages, chunks}
  const fileRef = useRef(null);

  const ingest = async () => {
    setErr("");
    if (!text.trim()) { setErr("Paste at least one repair order first."); return; }
    setBusy(true);
    try {
      // Split on common RO delimiters so user can paste multiple at once
      const blobs = text.split(/\n\s*(?:---|===|###|##)+\s*\n/g).map(s => s.trim()).filter(Boolean);
      const items = blobs.map(raw_text => ({ raw_text }));
      const r = await api.post("/cases/learn-bulk", { items });
      setResults(prev => [...r.data.results, ...prev]);
      setTotalInBrain(r.data.total_cases_in_brain);
      setText(""); // clear textarea for next paste
      onIngested?.();
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Ingest failed");
    } finally { setBusy(false); }
  };

  const ingestPdf = async (file) => {
    if (!file) return;
    setErr(""); setPdfInfo(null);
    if (file.size > 20 * 1024 * 1024) { setErr("PDF too big (20MB max). Split it."); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api.post("/cases/learn-pdf", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 240000 });
      setResults(prev => [...(r.data.results || []), ...prev]);
      setTotalInBrain(r.data.total_cases_in_brain);
      setPdfInfo({ filename: r.data.source_filename, pages: r.data.pdf_pages, chunks: r.data.chunks_sent_to_gpt, ingested: r.data.ingested, failed: r.data.failed, ocr_used: r.data.ocr_used, ocr_pages: r.data.ocr_pages, preview: r.data.extracted_text_preview });
      onIngested?.();
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "PDF ingest failed");
    } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  return (
    <div className="fixed inset-0 z-50 flex" data-testid="bulk-paste-modal">
      <div className="flex-1 bg-black/70" onClick={onClose}/>
      <div className="w-full md:w-[640px] bg-bg-2 border-l border-line overflow-auto flex flex-col">
        <div className="sticky top-0 bg-bg-2 border-b border-line px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-amber2"/>
            <span className="heading text-lg">BULK INGEST</span>
            {totalInBrain != null && (
              <span className="text-xs text-ink-3 ml-2 uppercase tracking-widest">BRAIN: <span className="text-amber2 font-bold">{totalInBrain}</span></span>
            )}
          </div>
          <button onClick={onClose} className="text-ink-2 p-1" data-testid="close-bulk"><X size={20}/></button>
        </div>

        <div className="p-4 space-y-3 flex-1">
          <div className="border-2 border-dashed border-rust/40 bg-rust/5 p-4 text-center">
            <FileText size={28} className="mx-auto text-rust mb-2"/>
            <div className="heading text-base mb-1">DROP AUTOLEAP PDF HERE</div>
            <div className="text-[11px] text-ink-3 uppercase tracking-widest mb-3">
              Export an RO (or 50) from AutoLeap as PDF → tap below → done
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              data-testid="bulk-pdf-input"
              className="hidden"
              onChange={e => ingestPdf(e.target.files?.[0])}
              disabled={busy}
            />
            <button
              data-testid="bulk-pdf-btn"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="btn-rust px-5 py-3 text-sm inline-flex items-center gap-2 disabled:opacity-50"
            >
              <Upload size={14}/>{busy ? "READING PDF..." : "PICK PDF"}
            </button>
            {pdfInfo && (
              <div className="mt-3 text-[11px] uppercase tracking-widest space-y-1" data-testid="pdf-info">
                <div className={pdfInfo.ingested > 0 ? "text-ok" : "text-amber2"}>
                  {pdfInfo.filename}: {pdfInfo.pages} page{pdfInfo.pages !== 1 && "s"} → <span className="font-bold">{pdfInfo.ingested}</span> case{pdfInfo.ingested !== 1 && "s"} ingested
                  {pdfInfo.failed > 0 && <span className="text-danger"> · {pdfInfo.failed} skipped</span>}
                </div>
                {pdfInfo.ocr_used && (
                  <div className="text-amber2 normal-case tracking-normal text-[10px]">
                    PDF was scanned (no text layer). Used Vision OCR on {pdfInfo.ocr_pages} page{pdfInfo.ocr_pages !== 1 && "s"}.
                  </div>
                )}
                {pdfInfo.ingested === 0 && pdfInfo.preview && (
                  <div className="border border-amber2/40 bg-amber2/5 p-2 mt-2 text-left normal-case tracking-normal">
                    <div className="text-[10px] text-amber2 uppercase tracking-widest mb-1">WHAT WE READ FROM THE PDF (paste this if it looks right):</div>
                    <div className="text-[11px] text-ink-2 font-mono whitespace-pre-wrap line-clamp-6 max-h-32 overflow-auto">{pdfInfo.preview}</div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="text-center text-[10px] text-ink-3 uppercase tracking-widest">— OR PASTE TEXT BELOW —</div>

          <p className="text-xs text-ink-2">
            Paste any old repair order — messy is fine. Wrench reads it and pulls out vehicle, symptom, root cause, repair, parts.
            Separate multiple ROs with a blank line and <code className="text-amber2">---</code> or <code className="text-amber2">===</code>.
          </p>
          {err && <div className="border border-danger bg-danger/10 text-danger text-sm p-2" data-testid="bulk-err">{err}</div>}
          <textarea
            data-testid="bulk-text"
            rows={10}
            className="input-shop w-full font-mono text-xs"
            placeholder={`2014 Silverado 5.3 — customer says lifter tick on cyl 7, runs rough cold start. Found AFM lifter collapsed. Replaced full lifter set, disabled AFM in tune. Verified clean after road test. — Doc, 4.5hr\n\n---\n\n2018 F-150 3.5L EB. Misfire cyl 4, P0304. Replaced coil and plug. Still misfiring. Compression test cyl 4 = 85psi (others 165). Bad valve. Pulled head, found burned exhaust valve. Reman head, new valves...`}
            value={text}
            onChange={e=>setText(e.target.value)}
          />
          <button data-testid="ingest-btn" onClick={ingest} disabled={busy || !text.trim()} className="btn-rust w-full py-4 text-base disabled:opacity-50 flex items-center justify-center gap-2">
            {busy ? "READING..." : <><Zap size={16}/>INGEST INTO BRAIN</>}
          </button>

          {results.length > 0 && (
            <div className="pt-3 mt-2 border-t border-line">
              <div className="text-[10px] uppercase tracking-widest text-amber2 mb-2">RECENT INGESTS ({results.length})</div>
              <div className="space-y-2">
                {results.map((r, i) => (
                  <div key={i} className={`border ${r.ok?"border-ok/40 bg-ok/5":"border-danger/40 bg-danger/5"} px-3 py-2 text-xs`} data-testid={`ingest-result-${i}`}>
                    {r.ok ? (
                      <>
                        <div className="text-ok font-bold mb-1 flex items-center gap-1.5"><CheckCircle2 size={12}/> {r.parsed_summary}</div>
                        {r.parsed_case && (
                          <div className="text-ink-2 text-[11px] space-y-0.5">
                            {r.parsed_case.dtc_codes?.length>0 && <div>DTC: <span className="text-amber2 font-mono">{r.parsed_case.dtc_codes.join(", ")}</span></div>}
                            {r.parsed_case.parts?.length>0 && <div>Parts: {r.parsed_case.parts.slice(0,5).join(" · ")}{r.parsed_case.parts.length>5 && ` +${r.parsed_case.parts.length-5} more`}</div>}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-danger flex items-center gap-1.5"><AlertCircle size={12}/> {r.error || "Failed"}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
