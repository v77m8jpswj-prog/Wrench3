import React, { useState, useEffect, useMemo, useRef } from "react";
import { useApp } from "@/AppContext";
import api from "@/api";
import {
  ChevronRight, ChevronDown, RefreshCw, Wand2, Copy, ImagePlus, Type,
  ArrowRight, BookOpen, Truck, AlertTriangle, Check, Camera
} from "lucide-react";

// ───────────────────────────────────────────────────────────────────────────────
// TUNE — OS-aware ordered tuning workflow.
// Left rail: HP Tuners menu structure for the active OS.
// Center: current tab — paste/snip the actual chart, give instruction, get clean
//         paste-ready table back in Doc's locked format.
// Right: tune log for this vehicle (Wrench's memory of past edits).
// ───────────────────────────────────────────────────────────────────────────────

export default function Tune() {
  const app = useApp();
  const vehicles = app?.vehicles || [];
  const activeVehicleId = app?.activeVehicleId || "";
  const activeVehicle = vehicles.find(v => v.id === activeVehicleId);

  // OS state
  const [osList, setOsList] = useState([]);
  const [session, setSession] = useState(null); // current tune session for this vehicle
  const [showSessionSetup, setShowSessionSetup] = useState(false);

  // OS tree + selection
  const [osTree, setOsTree] = useState(null);
  const [selectedPath, setSelectedPath] = useState(null); // {section, tab, subtab, path}
  const [collapsed, setCollapsed] = useState({});         // section → collapsed?

  // Chart edit state
  const [tableText, setTableText] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [symptom, setSymptom] = useState("");
  const [tableName, setTableName] = useState("");
  const [mode, setMode] = useState("text");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  // Tune log
  const [tuneLog, setTuneLog] = useState([]);
  const fileRef = useRef(null);

  // Load OS list once
  useEffect(() => { api.get("/tune/os-list").then(r => setOsList(r.data || [])).catch(()=>{}); }, []);

  // Whenever active vehicle changes — load session + log
  useEffect(() => {
    if (!activeVehicleId) { setSession(null); setOsTree(null); setTuneLog([]); return; }
    (async () => {
      try {
        const r = await api.get(`/tune/session/${activeVehicleId}`);
        const s = r.data && Object.keys(r.data).length ? r.data : null;
        setSession(s);
        if (s?.os_family) {
          const t = await api.get(`/tune/os-tree/${s.os_family}`);
          setOsTree(t.data);
        } else {
          setShowSessionSetup(true);
        }
      } catch {/* ignore */}
      try {
        const r = await api.get(`/tune/log/${activeVehicleId}?limit=50`);
        setTuneLog(r.data || []);
      } catch {/* ignore */}
    })();
  }, [activeVehicleId]);

  const flat = osTree?.flat || [];
  const currentIdx = flat.findIndex(p => p.path === selectedPath?.path);
  const nextPath = currentIdx >= 0 && currentIdx < flat.length - 1 ? flat[currentIdx + 1] : null;

  const handleFile = (file) => {
    setImageFile(file);
    const url = URL.createObjectURL(file);
    setImagePreview(url);
  };

  const runEdit = async () => {
    if (!selectedPath) { setErr("Pick a tab on the left first."); return; }
    if (!instruction.trim()) { setErr("Write what you want changed."); return; }
    setBusy(true); setErr(""); setResult(null);
    try {
      const contextHeader = `OS: ${session?.os_family}${session?.cal_id ? ` (cal ${session.cal_id})` : ""} | Engine: ${session?.engine_code || activeVehicle?.engine || "unknown"} | Fuel: ${session?.fuel || "?"} | Goal: ${session?.goal || "daily"}\nHP Tuners path: ${selectedPath.path}\nTable name: ${tableName || "(unspecified)"}\nSymptom: ${symptom || "(none stated)"}\n\n${instruction}`;
      let r;
      if (mode === "image" && imageFile) {
        const fd = new FormData();
        fd.append("file", imageFile);
        fd.append("instruction", contextHeader);
        fd.append("table_label", tableName || selectedPath.tab);
        if (activeVehicleId) fd.append("vehicle_id", activeVehicleId);
        r = await api.post("/chart/edit-image", fd, { timeout: 90000, headers: { "Content-Type": "multipart/form-data" }});
      } else {
        r = await api.post("/chart/edit", {
          table_text: tableText, instruction: contextHeader, table_label: tableName || selectedPath.tab,
          vehicle_id: activeVehicleId || undefined
        }, { timeout: 90000 });
      }
      setResult(r.data);

      // Log to tune log automatically (learning)
      try {
        await api.post("/tune/log", {
          vehicle_id: activeVehicleId,
          session_id: session?.id || "",
          section: selectedPath.section,
          tab: selectedPath.tab,
          subtab: selectedPath.subtab || "",
          table_name: tableName || "",
          before_table: r.data?.table_text_in || tableText || "",
          after_table: r.data?.table_text_out || "",
          instruction: instruction,
          symptom: symptom || "",
        });
        const log = await api.get(`/tune/log/${activeVehicleId}?limit=50`);
        setTuneLog(log.data || []);
      } catch (e) {/* non-blocking */}
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  };

  const copyOut = async () => {
    if (!result?.table_text_out) return;
    try { await navigator.clipboard.writeText(result.table_text_out); setCopied(true); setTimeout(()=>setCopied(false), 1500); } catch {}
  };

  const goNext = () => {
    if (!nextPath) return;
    setSelectedPath(nextPath);
    setResult(null); setTableText(""); setInstruction(""); setSymptom(""); setTableName(""); setImageFile(null); setImagePreview(null); setMode("text"); setErr("");
  };

  // ─── No active vehicle gate ────────────────────────────────────────────────────
  if (!activeVehicleId) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="heading text-2xl mb-3">TUNE <span className="text-rust">// WORKFLOW</span></h1>
        <div className="panel p-6 text-center">
          <Truck size={32} className="mx-auto mb-3 text-rust"/>
          <div className="text-ink-2 mb-2">Pick an active vehicle first.</div>
          <div className="text-ink-3 text-xs uppercase tracking-widest">Top of any page → Active Vehicle dropdown.</div>
        </div>
      </div>
    );
  }

  // ─── Session setup modal ──────────────────────────────────────────────────────
  if (showSessionSetup || !session) {
    return <SessionSetup
      vehicle={activeVehicle}
      osList={osList}
      onClose={() => setShowSessionSetup(false)}
      onStart={async (payload) => {
        const r = await api.post("/tune/session", { vehicle_id: activeVehicleId, ...payload });
        setSession(r.data);
        setShowSessionSetup(false);
        const t = await api.get(`/tune/os-tree/${r.data.os_family}`);
        setOsTree(t.data);
      }}
    />;
  }

  // ─── Main 3-column layout ────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col">
      {/* Top context bar */}
      <div className="border-b border-line bg-bg-2 px-4 py-3 flex items-center justify-between gap-3 flex-wrap" data-testid="tune-context-bar">
        <div className="flex items-center gap-3 min-w-0">
          <Truck size={16} className="text-rust shrink-0"/>
          <div className="text-sm text-amber2 font-bold truncate">
            {activeVehicle?.year} {activeVehicle?.make} {activeVehicle?.model}
          </div>
          <div className="text-[11px] text-ink-3 uppercase tracking-widest">
            OS: <span className="text-amber2 font-bold">{session.os_family}</span>
            {session.cal_id && <> · CAL {session.cal_id}</>}
            {session.engine_code && <> · {session.engine_code}</>}
            {session.fuel && <> · {session.fuel}</>}
            {session.goal && <> · {session.goal}</>}
          </div>
        </div>
        <button onClick={()=>setShowSessionSetup(true)} className="btn-ghost text-xs" data-testid="edit-session">EDIT SESSION</button>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[260px_1fr_300px] min-h-0">
        {/* LEFT: HP Tuners menu rail */}
        <aside className="border-r border-line bg-bg-1 overflow-auto" data-testid="tune-menu-rail">
          <div className="px-3 py-3 border-b border-line">
            <div className="text-[10px] uppercase tracking-widest text-ink-3">HP TUNERS ORDER</div>
            <div className="text-xs text-ink-2 mt-1">Walk top → bottom. Click a tab to start.</div>
          </div>
          {osTree?.menu?.map((section, si) => (
            <div key={si} className="border-b border-line">
              <button
                onClick={() => setCollapsed(c => ({...c, [section.section]: !c[section.section]}))}
                className="w-full px-3 py-2 flex items-center justify-between text-left bg-bg-2/40 hover:bg-bg-2"
                data-testid={`section-${section.section}`}
              >
                <span className="text-xs uppercase tracking-widest font-bold text-rust">{section.section}</span>
                {collapsed[section.section] ? <ChevronRight size={12} className="text-ink-3"/> : <ChevronDown size={12} className="text-ink-3"/>}
              </button>
              {!collapsed[section.section] && (
                <div>
                  {section.tabs.map((tab, ti) => (
                    <TabRow key={ti} section={section.section} tab={tab}
                      selectedPath={selectedPath}
                      onPick={(p) => { setSelectedPath(p); setResult(null); setTableText(""); setInstruction(""); setSymptom(""); setTableName(""); setErr(""); }}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </aside>

        {/* CENTER: chart edit area */}
        <main className="overflow-auto p-4" data-testid="tune-editor">
          {!selectedPath ? (
            <div className="panel p-6 text-center text-ink-3 mt-12">
              <BookOpen size={32} className="mx-auto mb-3 text-rust"/>
              <div className="text-ink-2 mb-2">Pick a tab on the left.</div>
              <div className="text-xs uppercase tracking-widest">Start at top — Engine &gt; General.</div>
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-2 mb-4 flex-wrap">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-ink-3">CURRENT TAB</div>
                  <div className="heading text-xl">{selectedPath.path}</div>
                </div>
                {nextPath && (
                  <button onClick={goNext} className="btn-ghost text-xs flex items-center gap-1" data-testid="next-tab">
                    NEXT: {nextPath.subtab || nextPath.tab} <ArrowRight size={12}/>
                  </button>
                )}
              </div>

              <div className="panel p-4">
                <div className="flex gap-2 mb-3">
                  <button onClick={()=>setMode("text")} className={`btn-ghost text-xs ${mode==="text"?"!border-rust !text-rust":""}`} data-testid="mode-text">
                    <Type size={12} className="inline mr-1"/>PASTE TEXT
                  </button>
                  <button onClick={()=>setMode("image")} className={`btn-ghost text-xs ${mode==="image"?"!border-rust !text-rust":""}`} data-testid="mode-image">
                    <Camera size={12} className="inline mr-1"/>SNIP / IMAGE
                  </button>
                </div>

                <label className="label-shop">TABLE NAME (OPTIONAL — HELPS WRENCH RECALL LATER)</label>
                <input data-testid="table-name" value={tableName} onChange={e=>setTableName(e.target.value)} className="input-shop" placeholder='e.g. "Initial Cold Cranking VE", "High Octane Spark", "MAF Calibration"'/>

                <label className="label-shop mt-3">SYMPTOM (OPTIONAL — WHAT IS THE TRUCK DOING?)</label>
                <input data-testid="symptom" value={symptom} onChange={e=>setSymptom(e.target.value)} className="input-shop" placeholder='e.g. "cold stumble — fire/die/restart", "lean cruise codes", "knock at 4k WOT"'/>

                {mode === "text" ? (
                  <>
                    <label className="label-shop mt-3">CURRENT TABLE (TAB-SEPARATED — PASTE FROM HP TUNERS)</label>
                    <textarea data-testid="tune-table-input" value={tableText} onChange={e=>setTableText(e.target.value)} rows={6} className="input-shop font-mono text-xs" placeholder="Paste cells here from HP Tuners. Include row/column headers if visible."/>
                  </>
                ) : (
                  <>
                    <label className="label-shop mt-3">SNIP / SCREENSHOT</label>
                    <input ref={fileRef} type="file" accept="image/*" hidden onChange={e=>e.target.files?.[0] && handleFile(e.target.files[0])} data-testid="tune-file-input"/>
                    <div className="flex gap-2">
                      <button onClick={()=>fileRef.current?.click()} className="btn-ghost text-xs flex items-center gap-1" data-testid="tune-upload">
                        <ImagePlus size={12}/>UPLOAD
                      </button>
                      {imagePreview && <span className="text-[10px] text-ok uppercase tracking-widest self-center">✓ READY</span>}
                    </div>
                    {imagePreview && <img src={imagePreview} alt="snip" className="mt-2 max-h-48 border border-line"/>}
                  </>
                )}

                <label className="label-shop mt-3">INSTRUCTION — WHAT WRENCH SHOULD DO</label>
                <textarea data-testid="tune-instruction" value={instruction} onChange={e=>setInstruction(e.target.value)} rows={3} className="input-shop" placeholder='e.g. "Bump initial cold cranking VE +2-3% only in the -4F to 50F + 65-75 kPa cells. Keep rest unchanged."'/>

                <button data-testid="run-tune-edit" onClick={runEdit} disabled={busy} className="btn-rust mt-4 w-full flex items-center justify-center gap-2">
                  {busy ? <><RefreshCw size={16} className="animate-spin"/>WORKING...</> : <><Wand2 size={16}/>APPLY CHANGE</>}
                </button>
                {err && <div className="mt-3 text-danger text-xs uppercase border border-danger p-2 break-words" data-testid="tune-err">ERR: {err}</div>}
              </div>

              {result && (
                <div className="panel p-4 mt-4" data-testid="tune-result">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-ink-3">MODIFIED TABLE</div>
                      <div className="text-xs text-amber2">Tab-separated · paste in HP Tuners</div>
                    </div>
                    <button onClick={copyOut} className={`btn-rust !py-1.5 !px-3 text-xs flex items-center gap-1 ${copied?"!bg-ok":""}`} data-testid="copy-tune-result">
                      {copied ? <><Check size={12}/>COPIED</> : <><Copy size={12}/>COPY</>}
                    </button>
                  </div>
                  <pre className="bg-bg-1 border border-line p-3 text-[11px] md:text-xs font-mono whitespace-pre overflow-x-auto leading-snug">{result.table_text_out}</pre>
                  {result.notes && (
                    <div className="mt-3 text-xs text-ink-2 leading-relaxed">
                      <div className="text-[10px] uppercase tracking-widest text-amber2 mb-1">WRENCH NOTES</div>
                      {result.notes}
                    </div>
                  )}
                  {nextPath && (
                    <button onClick={goNext} className="btn-ghost text-xs mt-3 w-full flex items-center justify-center gap-1" data-testid="next-tab-after-apply">
                      NEXT TAB: {nextPath.path} <ArrowRight size={12}/>
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </main>

        {/* RIGHT: tune log (Wrench's memory of this vehicle) */}
        <aside className="border-l border-line bg-bg-1 overflow-auto p-3 hidden lg:block" data-testid="tune-log-panel">
          <div className="text-[10px] uppercase tracking-widest text-ink-3 mb-2">TUNE LOG · {tuneLog.length} entries</div>
          {tuneLog.length === 0 ? (
            <div className="text-xs text-ink-3 italic">No edits yet. As you tune, Wrench learns from each change.</div>
          ) : (
            <div className="space-y-2">
              {tuneLog.map((e) => (
                <div key={e.id} className="border border-line p-2 bg-bg-2/40">
                  <div className="text-[10px] text-amber2 uppercase tracking-widest truncate">{e.section} &gt; {e.tab}{e.subtab ? ` > ${e.subtab}` : ""}</div>
                  {e.table_name && <div className="text-[11px] text-ink-2 mt-0.5">{e.table_name}</div>}
                  {e.symptom && <div className="text-[10px] text-ink-3 mt-0.5 italic">"{e.symptom}"</div>}
                  <div className="text-[10px] text-ink-2 mt-1 line-clamp-2">{e.instruction}</div>
                  <div className="text-[9px] text-ink-3 uppercase mt-1">{new Date(e.created_at).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ── Sidebar tab row (with subtabs) ───────────────────────────────────────────────
function TabRow({ section, tab, selectedPath, onPick }) {
  const [open, setOpen] = useState(false);
  const subtabs = tab.subtabs || [];
  const hasSub = subtabs.length > 0;
  const isSelected = selectedPath?.section === section && selectedPath?.tab === tab.name && !selectedPath?.subtab;
  return (
    <div>
      <button
        onClick={() => hasSub ? setOpen(o => !o) : onPick({ section, tab: tab.name, subtab: "", path: `${section} > ${tab.name}` })}
        className={`w-full px-3 py-1.5 flex items-center justify-between text-left text-xs hover:bg-bg-2 ${isSelected?"bg-bg-2 border-l-2 border-rust pl-[10px] text-amber2":"text-ink-2"}`}
        data-testid={`tab-${tab.name}`}
      >
        <span className="truncate">{tab.name}</span>
        {hasSub && (open ? <ChevronDown size={10} className="text-ink-3"/> : <ChevronRight size={10} className="text-ink-3"/>)}
      </button>
      {hasSub && open && (
        <div className="bg-bg-1">
          {subtabs.map((st, i) => {
            const path = { section, tab: tab.name, subtab: st, path: `${section} > ${tab.name} > ${st}` };
            const sel = selectedPath?.path === path.path;
            return (
              <button key={i} onClick={()=>onPick(path)}
                className={`w-full px-3 py-1 text-left text-[11px] hover:bg-bg-2 pl-7 ${sel?"text-amber2 border-l-2 border-rust pl-[26px]":"text-ink-3"}`}
                data-testid={`subtab-${tab.name}-${st}`}
              >
                {st}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Session setup modal ───────────────────────────────────────────────────────
function SessionSetup({ vehicle, osList, onClose, onStart }) {
  const [os, setOs] = useState("E80");
  const [cal, setCal] = useState("");
  const [engine, setEngine] = useState(vehicle?.engine_summary || vehicle?.engine || "");
  const [fuel, setFuel] = useState("");
  const [goal, setGoal] = useState("daily");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await onStart({ os_family: os, cal_id: cal, engine_code: engine, fuel, goal }); }
    finally { setBusy(false); }
  };
  return (
    <div className="p-6 max-w-2xl mx-auto" data-testid="tune-session-setup">
      <h1 className="heading text-2xl mb-1">TUNE <span className="text-rust">// SESSION SETUP</span></h1>
      <div className="text-xs text-ink-3 uppercase tracking-widest mb-4">
        {vehicle ? `${vehicle.year || ""} ${vehicle.make || ""} ${vehicle.model || ""}`.trim() : "VEHICLE"}
      </div>
      <div className="panel p-5 space-y-4">
        <div>
          <label className="label-shop">OS FAMILY (PICK YOUR ECM)</label>
          <select value={os} onChange={e=>setOs(e.target.value)} className="input-shop" data-testid="setup-os">
            {osList.map(o => <option key={o.os} value={o.os}>{o.os} — {o.label.split("—")[1]?.trim()}</option>)}
          </select>
          <div className="text-[10px] text-ink-3 uppercase tracking-widest mt-1">
            Wrench will only show tabs/charts that exist on this OS.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label-shop">CAL ID (OPTIONAL)</label>
            <input value={cal} onChange={e=>setCal(e.target.value)} className="input-shop" placeholder="12656931" data-testid="setup-cal"/>
          </div>
          <div>
            <label className="label-shop">ENGINE CODE</label>
            <input value={engine} onChange={e=>setEngine(e.target.value)} className="input-shop" placeholder="L83, L86, LT1..." data-testid="setup-engine"/>
          </div>
          <div>
            <label className="label-shop">FUEL</label>
            <select value={fuel} onChange={e=>setFuel(e.target.value)} className="input-shop" data-testid="setup-fuel">
              <option value="">--</option>
              <option value="87">87</option>
              <option value="91">91</option>
              <option value="93">93</option>
              <option value="E85">E85</option>
              <option value="race">RACE GAS</option>
            </select>
          </div>
          <div>
            <label className="label-shop">GOAL</label>
            <select value={goal} onChange={e=>setGoal(e.target.value)} className="input-shop" data-testid="setup-goal">
              <option value="daily">DAILY DRIVER</option>
              <option value="tow">TOW</option>
              <option value="street">STREET</option>
              <option value="strip">STRIP / DYNO HUNT</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={submit} disabled={busy} className="btn-rust flex-1" data-testid="setup-start">
            {busy ? "STARTING..." : "START TUNE"}
          </button>
          <button onClick={onClose} className="btn-ghost" data-testid="setup-cancel">CANCEL</button>
        </div>
        <div className="border-t border-line pt-3 flex items-start gap-2 text-xs text-ink-3">
          <AlertTriangle size={14} className="text-amber2 shrink-0 mt-0.5"/>
          <div>If you're not sure of the OS, open VCM Editor → bottom-left status bar shows it (e.g. "E80-A001"). Or snip that area into chat and Wrench will tell you.</div>
        </div>
      </div>
    </div>
  );
}
