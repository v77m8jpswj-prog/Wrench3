import React, { useEffect, useRef, useState } from "react";
import { Upload, RefreshCw, AlertTriangle } from "lucide-react";
import api from "@/api";

const SEV_COLOR = { high: "#D32F2F", medium: "#FFC107", low: "#A1A1AA" };

export default function Datalog() {
  const [vehicles, setVehicles] = useState([]);
  const [vehicleId, setVehicleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  useEffect(()=>{ api.get("/vehicles").then(r=>setVehicles(r.data||[])); }, []);

  const upload = async (file) => {
    setBusy(true); setErr(""); setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (vehicleId) fd.append("vehicle_id", vehicleId);
      const r = await api.post("/datalog/analyze", fd, { headers: { "Content-Type": "multipart/form-data" }});
      setResult(r.data);
    } catch (e) { setErr(e?.response?.data?.detail || e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-6" data-testid="datalog-page">
      <div className="flex items-end justify-between mb-4 border-b border-line pb-4">
        <div>
          <h1 className="heading text-4xl">DATALOG <span className="text-rust">ANALYZER</span></h1>
          <p className="text-ink-2 text-xs mt-1 uppercase tracking-widest">DROP A VCM SCANNER CSV — GET KNOCK/AFR/TRIM FINDINGS</p>
        </div>
      </div>

      <div className="panel p-4 mb-4 flex items-end gap-3">
        <div className="flex-1">
          <label className="label-shop">VEHICLE (OPTIONAL)</label>
          <select data-testid="dl-vehicle" value={vehicleId} onChange={e=>setVehicleId(e.target.value)} className="input-shop">
            <option value="">-- NO VEHICLE --</option>
            {vehicles.map(v => <option key={v.id} value={v.id}>{`${v.year} ${v.make} ${v.model}`.trim() || v.id.slice(0,6)}</option>)}
          </select>
        </div>
        <button data-testid="dl-upload" onClick={()=>fileRef.current?.click()} className="btn-rust flex items-center gap-2"><Upload size={16}/>UPLOAD CSV</button>
        <input ref={fileRef} type="file" accept=".csv,.log,.txt" hidden onChange={e=>e.target.files?.[0]&&upload(e.target.files[0])} data-testid="dl-file"/>
      </div>

      {busy && <div className="text-rust animate-blink uppercase tracking-widest">ANALYZING LOG...</div>}
      {err && <div className="text-danger text-xs uppercase border border-danger p-2">ERR: {err}</div>}

      {result && (
        <div className="panel p-4" data-testid="dl-result">
          <div className="heading text-xl mb-2">SUMMARY</div>
          <div className="text-sm text-ink-2 mb-4 leading-relaxed">{result.summary}</div>

          <div className="heading text-xl mb-2">FINDINGS ({(result.findings||[]).length})</div>
          {(result.findings||[]).length === 0 ? (
            <div className="text-ink-3 text-sm">No issues flagged.</div>
          ) : (
            <div className="space-y-2">
              {result.findings.map((f, i) => (
                <div key={i} className="border border-line bg-bg-1 p-3" data-testid={`finding-${i}`}>
                  <div className="flex items-center gap-3">
                    <AlertTriangle size={14} style={{color: SEV_COLOR[f.severity]||"#FFC107"}}/>
                    <span className="heading text-sm" style={{color: SEV_COLOR[f.severity]||"#FFC107"}}>{f.type?.toUpperCase()}</span>
                    <span className="text-[10px] uppercase tracking-widest text-ink-3">{f.severity}</span>
                    {f.at && <span className="text-[11px] text-ink-2 ml-auto font-mono">@ {f.at}</span>}
                  </div>
                  <div className="text-sm mt-2">{f.detail}</div>
                  {f.recommendation && <div className="text-xs text-amber2 mt-2 border-l-2 border-amber2 pl-2">FIX: {f.recommendation}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
