import React, { useState, useRef } from "react";
import { GitCompare, Upload, AlertTriangle, CheckCircle2, X, Truck } from "lucide-react";
import api, { API, getToken } from "@/api";

export default function DiffTune() {
  const [beforeFile, setBeforeFile] = useState(null);
  const [afterFile, setAfterFile] = useState(null);
  const [tableLabel, setTableLabel] = useState("HIGH OCTANE SPARK");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const beforeRef = useRef(null);
  const afterRef = useRef(null);

  const beforeUrl = beforeFile ? URL.createObjectURL(beforeFile) : null;
  const afterUrl = afterFile ? URL.createObjectURL(afterFile) : null;

  const run = async () => {
    setErr(""); setResult(null);
    if (!beforeFile || !afterFile) { setErr("Need both before AND after screenshots."); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("before", beforeFile);
      fd.append("after", afterFile);
      fd.append("table_label", tableLabel);
      const res = await fetch(`${API}/chart/diff`, {
        method: "POST", headers: { Authorization: `Bearer ${getToken()}` }, body: fd,
      });
      if (!res.ok) { const j = await res.json().catch(()=>({detail:"diff failed"})); throw new Error(j.detail); }
      setResult(await res.json());
    } catch (e) { setErr(e.message || "Diff failed"); }
    finally { setBusy(false); }
  };

  const reset = () => { setBeforeFile(null); setAfterFile(null); setResult(null); setErr(""); };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto" data-testid="diff-tune-page">
      <div className="mb-4 border-b border-line pb-4">
        <h1 className="heading text-3xl md:text-4xl flex items-center gap-3">
          <GitCompare size={28} className="text-rust"/>DIFF TUNE
        </h1>
        <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">
          DROP TWO HP TUNERS SCREENSHOTS — WRENCH FINDS EVERY CHANGED CELL AND FLAGS WHAT LOOKS DANGEROUS
        </p>
      </div>

      <div className="panel p-3 mb-3">
        <label className="label-shop">TABLE NAME (HELPS WRENCH KNOW WHAT HE'S LOOKING AT)</label>
        <input
          data-testid="diff-table-label"
          className="input-shop w-full text-sm"
          value={tableLabel}
          onChange={e=>setTableLabel(e.target.value)}
          placeholder="e.g. High Octane Spark, MAF VE, Knock Retard Allowed, Torque Mgmt"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <DropBox label="BEFORE" file={beforeFile} url={beforeUrl} inputRef={beforeRef} onPick={setBeforeFile} testid="diff-before"/>
        <DropBox label="AFTER"  file={afterFile}  url={afterUrl}  inputRef={afterRef}  onPick={setAfterFile}  testid="diff-after"/>
      </div>

      {err && <div className="mb-3 border border-danger bg-danger/10 text-danger text-sm p-3 flex items-start gap-2"><AlertTriangle size={14} className="shrink-0 mt-0.5"/>{err}</div>}

      <div className="flex gap-2 mb-4">
        <button onClick={run} disabled={busy || !beforeFile || !afterFile} className="btn-rust px-5 py-3 text-sm flex items-center gap-2 disabled:opacity-40" data-testid="diff-run">
          <GitCompare size={14}/>{busy ? "READING TABLES..." : "RUN DIFF"}
        </button>
        {(beforeFile || afterFile || result) && (
          <button onClick={reset} className="btn-ghost text-xs flex items-center gap-1" data-testid="diff-reset"><X size={12}/>RESET</button>
        )}
      </div>

      {result && <DiffResult r={result}/>}
    </div>
  );
}

function DropBox({ label, file, url, inputRef, onPick, testid }) {
  return (
    <div className="border-2 border-dashed border-line bg-bg-2 p-3 text-center">
      <div className="label-shop !mb-2">{label}</div>
      {url ? (
        <div>
          <img src={url} alt={label} className="w-full max-h-72 object-contain mb-2 border border-line"/>
          <div className="text-[10px] text-ink-3 uppercase tracking-widest truncate">{file?.name}</div>
        </div>
      ) : (
        <div className="py-8 text-ink-3 text-sm">No image yet</div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`${testid}-input`}
        onChange={e => onPick(e.target.files?.[0] || null)}
      />
      <button onClick={()=>inputRef.current?.click()} className="btn-rust text-xs mt-2 px-4 py-2 inline-flex items-center gap-2" data-testid={`${testid}-pick`}>
        <Upload size={12}/>{url ? "REPLACE" : "PICK IMAGE"}
      </button>
    </div>
  );
}

function DiffResult({ r }) {
  const hasWarnings = (r.warnings || []).length > 0;
  return (
    <div className="space-y-4" data-testid="diff-result">
      <div className={`panel p-4 border-2 ${hasWarnings ? "border-amber2" : "border-ok"}`}>
        <div className="flex items-start gap-3">
          {hasWarnings
            ? <AlertTriangle size={20} className="text-amber2 shrink-0 mt-0.5"/>
            : <CheckCircle2 size={20} className="text-ok shrink-0 mt-0.5"/>}
          <div>
            <div className="heading text-lg mb-1">
              {r.changed_cell_count} CELL{r.changed_cell_count !== 1 ? "S" : ""} CHANGED
              {hasWarnings && <span className="text-amber2"> · {r.warnings.length} WARNING{r.warnings.length>1?"S":""}</span>}
            </div>
            <p className="text-sm text-ink whitespace-pre-wrap">{r.summary}</p>
          </div>
        </div>
        {hasWarnings && (
          <ul className="mt-3 ml-7 list-disc space-y-1">
            {r.warnings.map((w,i) => <li key={i} className="text-amber2 text-sm">{w}</li>)}
          </ul>
        )}
      </div>

      {r.diff_grid && r.diff_grid.length > 0 && (
        <div>
          <div className="label-shop">DIFF — RED = DECREASE, GREEN = INCREASE</div>
          <div className="overflow-auto border border-line">
            <table className="text-[10px] md:text-xs font-mono">
              <tbody>
                {r.after_grid.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => {
                      const delta = r.diff_grid?.[ri]?.[ci] || "";
                      const isChanged = delta && delta.trim() !== "";
                      const isHeader = ri === 0 || ci === 0;
                      const isPos = isChanged && !delta.startsWith("-");
                      return (
                        <td
                          key={ci}
                          className={`px-2 py-1 border border-line/40 text-center whitespace-nowrap ${
                            isHeader ? "bg-bg-3 text-amber2 font-bold" :
                            isChanged ? (isPos ? "bg-ok/20 text-ok font-bold" : "bg-danger/20 text-danger font-bold") :
                            "text-ink-2"
                          }`}
                          title={isChanged ? `was ${r.before_grid?.[ri]?.[ci] || ""} → now ${cell} (${delta})` : ""}
                        >
                          {cell}
                          {isChanged && <div className="text-[8px] opacity-80">{delta}</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-ink-3 mt-2 uppercase tracking-widest">
            Hover any cell to see "before → now"
          </div>
        </div>
      )}
    </div>
  );
}
