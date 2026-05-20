import React, { useState, useEffect, useRef } from "react";
import { Copy, Wand2, ClipboardPaste, RefreshCw, ImagePlus, Type, Camera } from "lucide-react";
import api from "@/api";

const EXAMPLE = `\tRPM 800\tRPM 1600\tRPM 2400\tRPM 3200\tRPM 4000\tRPM 4800\tRPM 5600\tRPM 6400
kPa 20\t8.0\t10.5\t14.0\t18.5\t22.0\t24.5\t25.0\t25.5
kPa 40\t10.0\t14.0\t18.0\t22.0\t25.5\t27.0\t27.5\t28.0
kPa 60\t12.0\t16.5\t20.5\t24.5\t27.0\t28.0\t28.5\t29.0
kPa 80\t13.5\t18.0\t22.0\t25.5\t27.5\t28.0\t28.0\t27.5
kPa 100\t14.0\t19.0\t22.5\t25.0\t26.5\t26.5\t26.0\t25.0`;

export default function Charts() {
  const [mode, setMode] = useState("text"); // "text" or "image"
  const [tableText, setTableText] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [label, setLabel] = useState("spark table");
  const [vehicleId, setVehicleId] = useState("");
  const [vehicles, setVehicles] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef(null);
  const pasteAreaRef = useRef(null);

  useEffect(() => { api.get("/vehicles").then(r => setVehicles(r.data || [])).catch(()=>{}); }, []);

  // Listen for image paste anywhere on this page (Cmd+V with image in clipboard)
  useEffect(() => {
    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) {
            setMode("image");
            handleFile(blob);
            e.preventDefault();
            break;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const handleFile = (f) => {
    if (!f) return;
    setImageFile(f);
    const url = URL.createObjectURL(f);
    setImagePreview(url);
  };

  const clearImage = () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null); setImagePreview(null);
  };

  const run = async () => {
    setErr(""); setBusy(true); setResult(null);
    try {
      let r;
      if (mode === "image" && imageFile) {
        const fd = new FormData();
        fd.append("file", imageFile);
        fd.append("instruction", instruction);
        fd.append("table_label", label);
        if (vehicleId) fd.append("vehicle_id", vehicleId);
        r = await api.post("/chart/edit-image", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 90000 });
      } else if (mode === "text" && tableText.trim()) {
        r = await api.post("/chart/edit", { table_text: tableText, instruction, table_label: label }, { timeout: 90000 });
      } else {
        throw new Error(mode === "image" ? "Upload or paste an image first." : "Paste a table first.");
      }
      if (!r?.data?.modified_grid) throw new Error("Empty response from server.");
      setResult(r.data);
    } catch (e) {
      console.error("Chart edit failed:", e);
      const detail = e?.response?.data?.detail || e?.message || "Unknown error — check browser console.";
      setErr(typeof detail === "string" ? detail : JSON.stringify(detail));
    } finally { setBusy(false); }
  };

  const copyOut = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.table_text_out);
    setCopied(true);
    setTimeout(()=>setCopied(false), 1800);
  };

  const isChanged = (i, j) => result?.changed_cells?.some(([r,c]) => r===i && c===j);

  const canRun = (mode === "text" ? tableText.trim() : !!imageFile) && instruction.trim();

  return (
    <div className="p-4 md:p-6 max-w-[1800px]" data-testid="charts-page">
      <div className="flex items-end justify-between mb-4 border-b border-line pb-4 flex-wrap gap-3">
        <div>
          <h1 className="heading text-3xl md:text-4xl">CHART <span className="text-rust">EDITOR</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">PASTE TABLE OR SCREENSHOT → INSTRUCT → COPY BACK INTO HP TUNERS</p>
        </div>
        <div className="flex items-center gap-2">
          <button data-testid="mode-text" onClick={()=>setMode("text")} className={`btn-ghost text-xs flex items-center gap-1 ${mode==="text"?"!border-rust !text-rust":""}`}>
            <Type size={12}/> PASTE TEXT
          </button>
          <button data-testid="mode-image" onClick={()=>setMode("image")} className={`btn-ghost text-xs flex items-center gap-1 ${mode==="image"?"!border-rust !text-rust":""}`}>
            <Camera size={12}/> SCREENSHOT
          </button>
          {mode === "text" && (
            <button data-testid="load-example" onClick={()=>setTableText(EXAMPLE)} className="btn-ghost text-xs">LOAD EXAMPLE</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="panel p-4">
          {mode === "text" ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <label className="label-shop !mb-0">INPUT TABLE (TAB-SEPARATED)</label>
                <button onClick={async()=>{ try { const t = await navigator.clipboard.readText(); setTableText(t);} catch{} }} className="btn-ghost text-xs flex items-center gap-1"><ClipboardPaste size={12}/>PASTE</button>
              </div>
              <textarea data-testid="table-input" value={tableText} onChange={e=>setTableText(e.target.value)} rows={12} className="input-shop font-mono text-xs" placeholder="Paste your HP Tuners table here, or copy table cells from HP Tuners and Cmd+V..."/>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <label className="label-shop !mb-0">SCREENSHOT OF HP TUNERS TABLE</label>
                <div className="flex gap-1">
                  <button onClick={()=>fileInputRef.current?.click()} className="btn-ghost text-xs flex items-center gap-1"><ImagePlus size={12}/>UPLOAD</button>
                  {imageFile && <button onClick={clearImage} className="btn-ghost text-xs">CLEAR</button>}
                </div>
                <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e=>handleFile(e.target.files?.[0])} data-testid="image-file"/>
              </div>
              <div
                onDragOver={e=>e.preventDefault()}
                onDrop={e=>{ e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
                data-testid="image-drop"
                className="border-2 border-dashed border-line hover:border-rust transition-colors p-2 min-h-[280px] flex items-center justify-center overflow-auto"
              >
                {imagePreview ? (
                  <img src={imagePreview} alt="HP Tuners table" className="max-w-full max-h-[420px]" data-testid="image-preview"/>
                ) : (
                  <div className="text-ink-3 text-xs text-center uppercase tracking-widest leading-relaxed py-8">
                    DROP / UPLOAD / OR PASTE (Cmd+V)<br/>A SCREENSHOT OF YOUR HP TUNERS TABLE<br/>
                    <span className="text-ink-2 normal-case tracking-normal text-[11px] mt-2 block">PNG · JPG · WEBP</span>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="mt-4">
            <label className="label-shop">TABLE TYPE</label>
            <input data-testid="table-label" value={label} onChange={e=>setLabel(e.target.value)} className="input-shop" placeholder="spark, VE, MAF, AFR target..."/>
          </div>

          <div className="mt-3">
            <label className="label-shop">VEHICLE (for context-aware tuning)</label>
            <select data-testid="chart-vehicle" value={vehicleId} onChange={e=>setVehicleId(e.target.value)} className="input-shop">
              <option value="">-- NO VEHICLE --</option>
              {vehicles.map(v => <option key={v.id} value={v.id}>{`${v.year} ${v.make} ${v.model} ${v.engine||""}`.trim() || v.id.slice(0,6)}</option>)}
            </select>
          </div>

          <div className="mt-3">
            <label className="label-shop">INSTRUCTION</label>
            <textarea data-testid="instruction-input" value={instruction} onChange={e=>setInstruction(e.target.value)} rows={3} className="input-shop" placeholder='e.g. "Pull 2° from 3000-5000 RPM above 0.40 g airmass, smooth transitions"'/>
          </div>

          <button data-testid="run-chart" onClick={run} disabled={busy || !canRun} className="btn-rust mt-4 w-full flex items-center justify-center gap-2">
            {busy ? <><RefreshCw size={16} className="animate-spin"/>WORKING...</> : <><Wand2 size={16}/>APPLY CHANGES</>}
          </button>
          {err && <div className="mt-3 text-danger text-xs uppercase border border-danger p-2 break-words">ERR: {err}</div>}
        </div>

        <div className="panel p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="label-shop !mb-0">MODIFIED TABLE — COPY TO HP TUNERS</label>
            {result && (
              <button data-testid="copy-result" onClick={copyOut} className={`btn-rust !py-1.5 !px-3 text-xs flex items-center gap-1 ${copied?"!bg-ok":""}`}>
                <Copy size={14}/>{copied ? "COPIED — PASTE INTO HP TUNERS" : "COPY TABLE"}
              </button>
            )}
          </div>

          {!result && (
            <div className="border border-line p-6 text-ink-3 text-xs text-center min-h-[280px] flex items-center justify-center">
              {busy ? <span className="animate-blink text-rust">WRENCHING ON YOUR TABLE...</span> : "No result yet. Provide a table + instruction, hit APPLY."}
            </div>
          )}

          {result && (
            <>
              {result.changed_cells.length > 0 && (
                <div className="text-[11px] text-amber2 uppercase tracking-widest mb-2">CHANGED: {result.changed_cells.length} CELLS</div>
              )}
              <div className="overflow-auto border border-line max-h-[520px]" data-testid="result-grid">
                <table className="border-collapse w-full">
                  <tbody>
                    {result.modified_grid.map((row, i) => (
                      <tr key={i}>
                        {row.map((c, j) => {
                          const headerLike = (i === 0 || j === 0) && isNaN(parseFloat(c));
                          return (
                            <td key={j} className={`grid-cell ${headerLike?"header":""} ${isChanged(i,j)?"changed":""}`}>{c}</td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.notes && (
                <div className="mt-3 text-xs text-ink-2 border-l-2 border-rust pl-3 leading-relaxed" data-testid="result-notes">
                  <div className="text-amber2 uppercase tracking-widest text-[10px] mb-1">WRENCH NOTES</div>
                  {result.notes}
                </div>
              )}
              <button onClick={copyOut} className={`btn-rust w-full mt-4 flex items-center justify-center gap-2 ${copied?"!bg-ok":""}`} data-testid="copy-result-big">
                <Copy size={16}/>{copied ? "COPIED — NOW PASTE INTO HP TUNERS" : "COPY TABLE TO CLIPBOARD"}
              </button>
              <details className="mt-3">
                <summary className="text-xs text-ink-3 cursor-pointer uppercase tracking-widest hover:text-rust">RAW TAB-SEPARATED OUTPUT</summary>
                <pre className="mt-2 text-[11px] bg-bg-1 border border-line p-2 max-h-40 overflow-auto whitespace-pre">{result.table_text_out}</pre>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
