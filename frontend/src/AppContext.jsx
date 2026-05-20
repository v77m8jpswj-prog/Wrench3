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
    }}>
      {/* Persistent audio sink — lives at root so navigation never tears down the call */}
      <audio ref={audioElRef} playsInline autoPlay style={{display:"none"}} />
      {children}
    </AppCtx.Provider>
  );
}
