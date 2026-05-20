import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import api, { API, getToken } from "@/api";

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const setStatus = (label, color) =>
  window.dispatchEvent(new CustomEvent("wrench-status", { detail: { label, color } }));

export function AppProvider({ children }) {
  // ============ Active Vehicle (persisted) ============
  const [vehicles, setVehicles] = useState([]);
  const [activeVehicleId, setActiveVehicleIdRaw] = useState(() => localStorage.getItem("dw_active_vehicle") || "");

  const setActiveVehicleId = (id) => {
    setActiveVehicleIdRaw(id || "");
    if (id) localStorage.setItem("dw_active_vehicle", id);
    else localStorage.removeItem("dw_active_vehicle");
  };

  const refreshVehicles = useCallback(async () => {
    try {
      const r = await api.get("/vehicles");
      setVehicles(r.data || []);
    } catch {}
  }, []);

  useEffect(() => { refreshVehicles(); }, [refreshVehicles]);

  const activeVehicle = vehicles.find(v => v.id === activeVehicleId) || null;
  const activeVehicleRef = useRef(activeVehicle);
  useEffect(() => { activeVehicleRef.current = activeVehicle; }, [activeVehicle]);

  // The chat session id this call is linked to (so the call transcript appears in chat history)
  const linkedSessionRef = useRef(null);

  const appendToChatSession = async (role, content) => {
    const sid = linkedSessionRef.current;
    if (!sid || !content) return;
    try {
      await api.post(`/chat/sessions/${sid}/append-call`, { session_id: sid, role, content });
    } catch {}
  };

  // ============ Persistent Call State ============
  const [callState, setCallState] = useState("idle"); // idle | connecting | connected | error
  const [callError, setCallError] = useState("");
  const [callTranscript, setCallTranscript] = useState([]);
  const [callMuted, setCallMuted] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [callVolume, setCallVolume] = useState(1.5);

  // Call Artifacts (links/notes/vehicles Wrench sends during a call)
  const [callArtifacts, setCallArtifacts] = useState(() => {
    try { return JSON.parse(localStorage.getItem("dw_call_artifacts") || "[]"); }
    catch { return []; }
  });
  const persistArtifacts = (arr) => {
    setCallArtifacts(arr);
    try { localStorage.setItem("dw_call_artifacts", JSON.stringify(arr.slice(0, 200))); } catch {}
  };
  const addArtifact = (a) => {
    setCallArtifacts(prev => {
      const item = { id: Date.now() + "-" + Math.random().toString(36).slice(2,8), at: new Date().toISOString(), seen: false, ...a };
      const next = [item, ...prev];
      try { localStorage.setItem("dw_call_artifacts", JSON.stringify(next.slice(0, 200))); } catch {}
      return next;
    });
  };
  const markArtifactsSeen = () => setCallArtifacts(prev => {
    const next = prev.map(a => ({ ...a, seen: true }));
    try { localStorage.setItem("dw_call_artifacts", JSON.stringify(next)); } catch {}
    return next;
  });
  const clearArtifact = (id) => setCallArtifacts(prev => {
    const next = prev.filter(a => a.id !== id);
    try { localStorage.setItem("dw_call_artifacts", JSON.stringify(next)); } catch {}
    return next;
  });
  const clearAllArtifacts = () => { setCallArtifacts([]); try { localStorage.removeItem("dw_call_artifacts"); } catch {} };

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioElRef = useRef(null);     // shared <audio> sink (mounted at app level)
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const timerRef = useRef(null);
  const pendingAssistantRef = useRef("");

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = callVolume;
    else if (audioElRef.current) audioElRef.current.volume = Math.min(1, callVolume);
  }, [callVolume]);

  // ============ Tool / Function calling — execute Wrench's tool calls ============
  // Some Realtime events arrive as response.output_item.done with item.type === "function_call"
  const handleFunctionCall = async (callId, name, argsJson) => {
    let args = {};
    try { args = JSON.parse(argsJson || "{}"); } catch { args = {}; }
    let output = { ok: false, error: "unknown tool" };
    let transcriptNote = "";
    try {
      if (name === "save_vehicle_from_vin") {
        const vin = (args.vin || "").replace(/\s/g, "").toUpperCase();
        let decoded = {};
        try { decoded = (await api.get(`/vin/decode/${encodeURIComponent(vin)}`)).data || {}; } catch {}
        const payload = {
          vin,
          year: decoded.year || "",
          make: decoded.make || "",
          model: [decoded.model, decoded.trim].filter(Boolean).join(" ") || "",
          engine: decoded.engine_summary || "",
          mods: args.mods || "",
          notes: args.notes || "",
        };
        const v = (await api.post("/vehicles", payload)).data;
        await refreshVehicles();
        setActiveVehicleId(v.id);
        const lbl = `${v.year} ${v.make} ${v.model}`.trim() || vin;
        addArtifact({ type: "vehicle", label: lbl, vehicle_id: v.id, vin });
        transcriptNote = `✓ SAVED VEHICLE → ${lbl} · set ACTIVE`;
        output = { ok: true, vehicle: v };
      } else if (name === "send_link") {
        addArtifact({ type: "link", url: args.url, label: args.label || args.url });
        transcriptNote = `✓ LINK SENT → ${args.label || args.url}`;
        output = { ok: true };
      } else if (name === "send_note") {
        addArtifact({ type: "note", title: args.title || "Note", body: args.body || "" });
        transcriptNote = `✓ NOTE SENT → ${args.title || "(text)"}`;
        output = { ok: true };
      } else if (name === "set_active_vehicle") {
        const q = (args.query || "").toLowerCase();
        const match = vehicles.find(v => {
          const s = `${v.year} ${v.make} ${v.model} ${v.engine}`.toLowerCase();
          return s.includes(q);
        });
        if (match) {
          setActiveVehicleId(match.id);
          transcriptNote = `✓ ACTIVE VEHICLE → ${match.year} ${match.make} ${match.model}`;
          output = { ok: true, vehicle_id: match.id, label: `${match.year} ${match.make} ${match.model}` };
        } else {
          transcriptNote = `✗ NO VEHICLE MATCHED "${args.query}"`;
          output = { ok: false, error: "No matching vehicle in garage" };
        }
      } else if (name === "save_to_memory") {
        await api.post("/memory", { fact: args.fact || "" });
        transcriptNote = `✓ MEMORY SAVED → ${args.fact}`;
        output = { ok: true };
      } else if (name === "search_library") {
        // Simple keyword search via the same RAG endpoint: post a "fake" chat to get citations
        const r = await api.post("/chat", { message: args.query, mode: "direct", session_id: null });
        // citations include the relevant chunks
        const cites = r.data?.citations || [];
        transcriptNote = `✓ LIBRARY SEARCH → ${cites.length} matches`;
        output = { ok: true, matches: cites.map(c => ({ source: c.source, snippet: c.snippet })) };
      } else if (name === "list_vehicles") {
        const r = await api.get("/vehicles");
        const items = (r.data || []).map(v => ({
          id: v.id, year: v.year, make: v.make, model: v.model, engine: v.engine, mods: v.mods, vin: v.vin
        }));
        transcriptNote = `✓ LISTED ${items.length} VEHICLES`;
        output = { ok: true, vehicles: items };
      } else if (name === "get_active_vehicle") {
        const v = activeVehicleRef.current;
        if (v) {
          transcriptNote = `✓ ACTIVE: ${v.year} ${v.make} ${v.model}`;
          output = { ok: true, vehicle: v };
        } else {
          transcriptNote = `✗ NO ACTIVE VEHICLE`;
          output = { ok: false, error: "No active vehicle. Doc needs to pick or save one." };
        }
      } else if (name === "update_active_vehicle") {
        const v = activeVehicleRef.current;
        if (!v) {
          transcriptNote = `✗ NO ACTIVE VEHICLE TO UPDATE`;
          output = { ok: false, error: "No active vehicle" };
        } else {
          const patch = {
            year: v.year || "", make: v.make || "", model: v.model || "", vin: v.vin || "",
            engine: args.engine !== undefined ? args.engine : (v.engine || ""),
            mods: args.mods_append ? (v.mods ? v.mods + "; " + args.mods_append : args.mods_append) : (v.mods || ""),
            notes: args.notes_append ? (v.notes ? v.notes + "; " + args.notes_append : args.notes_append) : (v.notes || ""),
          };
          await api.put(`/vehicles/${v.id}`, patch);
          await refreshVehicles();
          const parts = [];
          if (args.engine !== undefined) parts.push("engine");
          if (args.mods_append) parts.push("mods");
          if (args.notes_append) parts.push("notes");
          transcriptNote = `✓ UPDATED ${v.year} ${v.make} ${v.model} → ${parts.join(", ") || "no changes"}`;
          output = { ok: true };
        }
      } else if (name === "edit_chart") {
        const r = await api.post("/chart/edit", {
          table_text: args.table_text,
          instruction: args.instruction,
          table_label: args.table_label || "table",
        }, { timeout: 60000 });
        addArtifact({
          type: "note",
          title: `Chart edit: ${args.table_label || "table"}`,
          body: `INSTRUCTION: ${args.instruction}\n\nMODIFIED TABLE (paste into HP Tuners):\n${r.data.table_text_out}\n\nNOTES: ${r.data.notes || ""}`,
        });
        transcriptNote = `✓ CHART EDITED → ${r.data.changed_cells?.length || 0} cells changed · note sent`;
        output = { ok: true, changed_cells: r.data.changed_cells?.length || 0, notes: r.data.notes };
      }
    } catch (e) {
      output = { ok: false, error: e?.response?.data?.detail || e?.message || String(e) };
      transcriptNote = `✗ TOOL FAILED → ${name}: ${output.error}`;
    }
    if (transcriptNote) {
      setCallTranscript(arr => [...arr, { who: "tool", text: transcriptNote }]);
      appendToChatSession("system", `[TOOL] ${transcriptNote}`);
    }
    try {
      dcRef.current.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
      }));
      dcRef.current.send(JSON.stringify({ type: "response.create" }));
    } catch {}
  };

  const stopTick = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  const tick = () => { timerRef.current = setInterval(() => setCallSeconds(s => s + 1), 1000); };

  const startCall = async () => {
    if (callState === "connected" || callState === "connecting") return;
    setCallError(""); setCallSeconds(0);
    // Link to active chat session (or create a new one). Calls and chats share history.
    let linkedSession = localStorage.getItem("dw_chat_session");
    if (!linkedSession) {
      linkedSession = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(36).slice(2));
      localStorage.setItem("dw_chat_session", linkedSession);
    }
    linkedSessionRef.current = linkedSession;
    // Preload existing session transcript into the call view
    try {
      const r = await api.get(`/chat/sessions/${linkedSession}`);
      const prior = (r.data?.messages || []).map(m => ({
        who: m.role === "user" ? "tech" : m.role === "assistant" ? "wrench" : "tool",
        text: m.content,
      }));
      setCallTranscript(prior);
    } catch { setCallTranscript([]); }

    setCallState("connecting"); setStatus("CONNECTING", "#FFC107");
    try {
      const tokenRes = await api.post("/realtime/session", {});
      const ephemeralKey = tokenRes.data?.value;
      const model = tokenRes.data?.session?.model || "gpt-realtime";
      if (!ephemeralKey) throw new Error("No ephemeral key from backend");

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.ontrack = (e) => {
        const stream = e.streams[0];
        try {
          if (audioElRef.current) {
            audioElRef.current.srcObject = stream;
            audioElRef.current.muted = true;
            audioElRef.current.play().catch(()=>{});
          }
          const ctx = audioCtxRef.current || new (window.AudioContext || window.webkitAudioContext)();
          audioCtxRef.current = ctx;
          if (ctx.state === "suspended") ctx.resume().catch(()=>{});
          const src = ctx.createMediaStreamSource(stream);
          const gain = ctx.createGain();
          gain.gain.value = callVolume;
          gainRef.current = gain;
          src.connect(gain);
          gain.connect(ctx.destination);
        } catch {
          if (audioElRef.current) {
            audioElRef.current.srcObject = stream;
            audioElRef.current.muted = false;
            audioElRef.current.play().catch(()=>{});
          }
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (evt) => { try { handleEvent(JSON.parse(evt.data)); } catch {} };
      dc.onopen = () => {
        setCallState("connected"); setStatus("ON CALL", "#FF5722"); tick();
        try {
          dc.send(JSON.stringify({
            type: "session.update",
            session: { input_audio_transcription: { model: "whisper-1" } }
          }));
        } catch {}
      };
      dc.onclose = () => { setCallState("idle"); stopTick(); setStatus("IDLE", "#52525B"); };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
      });
      let sdpText = "";
      try { sdpText = await sdpResp.clone().text(); }
      catch { try { sdpText = await sdpResp.text(); } catch {} }
      if (!sdpResp.ok) throw new Error(`SDP failed: ${sdpResp.status} ${sdpText}`);
      if (!sdpText) throw new Error("Empty SDP response from OpenAI");
      await pc.setRemoteDescription({ type: "answer", sdp: sdpText });
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || String(e);
      setCallError(msg);
      setCallState("error"); setStatus("CALL FAILED", "#D32F2F");
      cleanupCall();
    }
  };

  const handleEvent = (evt) => {
    const t = evt.type;
    // When Doc starts speaking, immediately stop Wrench's audio playback (barge-in)
    if (t === "input_audio_buffer.speech_started") {
      try {
        if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.currentTime = 0; }
      } catch {}
      try { dcRef.current?.send(JSON.stringify({ type: "response.cancel" })); } catch {}
    }
    if (t === "conversation.item.input_audio_transcription.completed") {
      const txt = (evt.transcript || "").trim();
      if (txt) {
        setCallTranscript(arr => [...arr, { who: "tech", text: txt }]);
        appendToChatSession("user", txt);
      }
    }
    if (t === "response.output_text.delta" || t === "response.text.delta" || t === "response.output_audio_transcript.delta") {
      pendingAssistantRef.current += (evt.delta || "");
    }
    if (t === "response.output_text.done" || t === "response.text.done") {
      const txt = pendingAssistantRef.current.trim();
      pendingAssistantRef.current = "";
      if (txt) {
        setCallTranscript(arr => [...arr, { who: "wrench", text: txt }]);
        appendToChatSession("assistant", txt);
      }
    }
    if (t === "response.output_audio_transcript.done") {
      const txt = (evt.transcript || pendingAssistantRef.current || "").trim();
      pendingAssistantRef.current = "";
      if (txt) {
        setCallTranscript(arr => [...arr, { who: "wrench", text: txt }]);
        appendToChatSession("assistant", txt);
      }
    }
    if (t === "response.function_call_arguments.done") {
      handleFunctionCall(evt.call_id, evt.name, evt.arguments);
    }
    if (t === "response.output_item.done" && evt.item?.type === "function_call") {
      handleFunctionCall(evt.item.call_id, evt.item.name, evt.item.arguments);
    }
    if (t === "error") setCallError(evt.error?.message || "Realtime error");
  };

  // Manually halt Wrench's voice (Doc taps a button)
  const haltWrench = () => {
    try { if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.currentTime = 0; } } catch {}
    try { dcRef.current?.send(JSON.stringify({ type: "response.cancel" })); } catch {}
  };

  const sendCallText = (text) => {
    if (!text?.trim() || !dcRef.current || dcRef.current.readyState !== "open") return false;
    setCallTranscript(arr => [...arr, { who: "tech", text }]);
    appendToChatSession("user", text);
    try {
      dcRef.current.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }));
      dcRef.current.send(JSON.stringify({ type: "response.create" }));
      return true;
    } catch (e) { setCallError("Send failed: " + (e?.message || e)); return false; }
  };

  const toggleCallMute = () => {
    const s = localStreamRef.current;
    if (!s) return;
    const next = !callMuted;
    s.getAudioTracks().forEach(t => t.enabled = !next);
    setCallMuted(next);
  };

  const cleanupCall = () => {
    try { dcRef.current && dcRef.current.close(); } catch {}
    try { pcRef.current && pcRef.current.close(); } catch {}
    try { localStreamRef.current && localStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
    try { audioCtxRef.current && audioCtxRef.current.close(); } catch {}
    dcRef.current = null; pcRef.current = null; localStreamRef.current = null;
    audioCtxRef.current = null; gainRef.current = null;
    stopTick();
    setCallMuted(false);
  };

  const endCall = () => {
    cleanupCall();
    setCallState("idle"); setStatus("IDLE", "#52525B");
  };

  return (
    <AppCtx.Provider value={{
      vehicles, refreshVehicles,
      activeVehicleId, setActiveVehicleId, activeVehicle,
      callState, callError, callTranscript, callMuted, callSeconds, callVolume,
      setCallVolume, startCall, endCall, sendCallText, toggleCallMute, haltWrench,
      callArtifacts, addArtifact, markArtifactsSeen, clearArtifact, clearAllArtifacts,
    }}>
      <audio ref={audioElRef} playsInline autoPlay style={{display:"none"}} />
      {children}
    </AppCtx.Provider>
  );
}
