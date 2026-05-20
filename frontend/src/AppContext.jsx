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
        addArtifact({ type: "vehicle", label: `${v.year} ${v.make} ${v.model}`.trim() || vin, vehicle_id: v.id, vin });
        output = { ok: true, vehicle: v };
      } else if (name === "send_link") {
        addArtifact({ type: "link", url: args.url, label: args.label || args.url });
        output = { ok: true };
      } else if (name === "send_note") {
        addArtifact({ type: "note", title: args.title || "Note", body: args.body || "" });
        output = { ok: true };
      } else if (name === "set_active_vehicle") {
        const q = (args.query || "").toLowerCase();
        const match = vehicles.find(v => {
          const s = `${v.year} ${v.make} ${v.model} ${v.engine}`.toLowerCase();
          return s.includes(q);
        });
        if (match) { setActiveVehicleId(match.id); output = { ok: true, vehicle_id: match.id, label: `${match.year} ${match.make} ${match.model}` }; }
        else output = { ok: false, error: "No matching vehicle in garage" };
      } else if (name === "save_to_memory") {
        await api.post("/memory", { fact: args.fact || "" });
        output = { ok: true };
      }
    } catch (e) {
      output = { ok: false, error: e?.response?.data?.detail || e?.message || String(e) };
    }
    // Send result back through the data channel so Wrench can continue
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
    setCallError(""); setCallTranscript([]); setCallSeconds(0);
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
    if (t === "conversation.item.input_audio_transcription.completed") {
      const txt = (evt.transcript || "").trim();
      if (txt) setCallTranscript(arr => [...arr, { who: "tech", text: txt }]);
    }
    if (t === "response.output_text.delta" || t === "response.text.delta" || t === "response.output_audio_transcript.delta") {
      pendingAssistantRef.current += (evt.delta || "");
    }
    if (t === "response.output_text.done" || t === "response.text.done") {
      const txt = pendingAssistantRef.current.trim();
      pendingAssistantRef.current = "";
      if (txt) setCallTranscript(arr => [...arr, { who: "wrench", text: txt }]);
    }
    if (t === "response.output_audio_transcript.done") {
      const txt = (evt.transcript || pendingAssistantRef.current || "").trim();
      pendingAssistantRef.current = "";
      if (txt) setCallTranscript(arr => [...arr, { who: "wrench", text: txt }]);
    }
    // Function / tool calls from Wrench
    if (t === "response.function_call_arguments.done") {
      handleFunctionCall(evt.call_id, evt.name, evt.arguments);
    }
    if (t === "response.output_item.done" && evt.item?.type === "function_call") {
      handleFunctionCall(evt.item.call_id, evt.item.name, evt.item.arguments);
    }
    if (t === "error") setCallError(evt.error?.message || "Realtime error");
  };

  const sendCallText = (text) => {
    if (!text?.trim() || !dcRef.current || dcRef.current.readyState !== "open") return false;
    setCallTranscript(arr => [...arr, { who: "tech", text }]);
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
      setCallVolume, startCall, endCall, sendCallText, toggleCallMute,
      callArtifacts, addArtifact, markArtifactsSeen, clearArtifact, clearAllArtifacts,
    }}>
      <audio ref={audioElRef} playsInline autoPlay style={{display:"none"}} />
      {children}
    </AppCtx.Provider>
  );
}
