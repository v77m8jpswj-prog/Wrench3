import React, { useState } from "react";
import { Copy, Wand2, ClipboardPaste, RefreshCw } from "lucide-react";
import api from "@/api";

const EXAMPLE = `\tRPM 800\tRPM 1600\tRPM 2400\tRPM 3200\tRPM 4000\tRPM 4800\tRPM 5600\tRPM 6400
kPa 20\t8.0\t10.5\t14.0\t18.5\t22.0\t24.5\t25.0\t25.5
kPa 40\t10.0\t14.0\t18.0\t22.0\t25.5\t27.0\t27.5\t28.0
kPa 60\t12.0\t16.5\t20.5\t24.5\t27.0\t28.0\t28.5\t29.0
kPa 80\t13.5\t18.0\t22.0\t25.5\t27.5\t28.0\t28.0\t27.5
kPa 100\t14.0\t19.0\t22.5\t25.0\t26.5\t26.5\t26.0\t25.0`;

export default function Charts() {
  const [tableText, setTableText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [label, setLabel] = useState("spark table");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setErr(""); setBusy(true); setResult(null);
    try {
      const r = await api.post("/chart/edit", { table_text: tableText, instruction, table_label: label });
      setResult(r.data);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
    } finally { setBusy(false); }
  };

  const copyOut = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.table_text_out);
    setCopied(true);
    setTimeout(()=>setCopied(false), 1800);
  };

  const isChanged = (i, j) => result?.changed_cells?.some(([r,c]) => r===i && c===j);

  return (
    <div className="p-6 max-w-[1800px]" data-testid="charts-page">
      <div className="flex items-end justify-between mb-4 border-b border-line pb-4">
        <div>
          <h1 className="heading text-4xl">CHART <span className="text-rust">EDITOR</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">PASTE TABLE → INSTRUCT → PASTE BACK INTO HP TUNERS</p>
        </div>
        <button data-testid="load-example" onClick={()=>setTableText(EXAMPLE)} className="btn-ghost text-xs">LOAD EXAMPLE</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="panel p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="label-shop !mb-0">INPUT TABLE (TAB-SEPARATED)</label>
            <button onClick={async()=>{ try { const t = await navigator.clipboard.readText(); setTableText(t);} catch{} }} className="btn-ghost text-xs flex items-center gap-1"><ClipboardPaste size={12}/>PASTE</button>
          </div>
          <textarea data-testid="table-input" value={tableText} onChange={e=>setTableText(e.target.value)} rows={12} className="input-shop font-mono text-xs" placeholder="Paste your HP Tuners table here..."/>

          <div className="mt-4">
            <label className="label-shop">TABLE TYPE</label>
            <input data-testid="table-label" value={label} onChange={e=>setLabel(e.target.value)} className="input-shop" placeholder="spark, VE, MAF, AFR target..."/>
          </div>

          <div className="mt-3">
            <label className="label-shop">INSTRUCTION</label>
            <textarea data-testid="instruction-input" value={instruction} onChange={e=>setInstruction(e.target.value)} rows={3} className="input-shop" placeholder='e.g. "Pull 2° from 3000-5000 RPM above 60 kPa, smooth transitions"'/>
          </div>

          <button data-testid="run-chart" onClick={run} disabled={busy || !tableText.trim() || !instruction.trim()} className="btn-rust mt-4 w-full flex items-center justify-center gap-2">
            {busy ? <><RefreshCw size={16} className="animate-spin"/>WORKING...</> : <><Wand2 size={16}/>APPLY CHANGES</>}
          </button>
          {err && <div className="mt-3 text-danger text-xs uppercase border border-danger p-2">ERR: {err}</div>}
        </div>

        <div className="panel p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="label-shop !mb-0">MODIFIED TABLE</label>
            {result && (
              <button data-testid="copy-result" onClick={copyOut} className="btn-ghost text-xs flex items-center gap-1">
                <Copy size={12}/>{copied ? "COPIED" : "COPY"}
              </button>
            )}
          </div>

          {!result && (
            <div className="border border-line p-6 text-ink-3 text-xs text-center min-h-[280px] flex items-center justify-center">
              {busy ? <span className="animate-blink text-rust">WRENCHING ON YOUR TABLE...</span> : "No result yet. Paste a table, give an instruction, hit APPLY."}
            </div>
          )}

          {result && (
            <>
              <div className="text-[11px] text-amber2 uppercase tracking-widest mb-2">CHANGED: {result.changed_cells.length} CELLS</div>
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
