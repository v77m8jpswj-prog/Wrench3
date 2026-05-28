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

  useEffect(() => {
    refreshVehicles();
    // Re-fetch whenever the tab regains focus — catches vehicles added in another tab
    const onFocus = () => refreshVehicles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshVehicles]);

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
  const [callInterim, setCallInterim] = useState(""); // live STT of user's mid-utterance speech
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
  const responseInFlightRef = useRef(false);  // true while a response.create is mid-stream
  const pendingTurnsRef = useRef([]);          // queued user turns to fire after current response.done
  const userHangupRef = useRef(false);         // true while a user-initiated hangup is in progress so close events don't surface as errors

  // Helper: send a response.create only when no response is in-flight; queue otherwise.
  const safeRequestResponse = () => {
    if (!dcRef.current || dcRef.current.readyState !== "open") return;
    if (responseInFlightRef.current) {
      // A response is currently streaming. Mark that we owe one more.
      pendingTurnsRef.current.push("respond");
      return;
    }
    try {
      responseInFlightRef.current = true;
      dcRef.current.send(JSON.stringify({ type: "response.create" }));
    } catch {/* ignore */}
  };

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = callVolume;
    else if (audioElRef.current) audioElRef.current.volume = Math.min(1, callVolume);
  }, [callVolume]);

  // SAFETY: when the tab/window goes hidden (computer sleeps, Doc Cmd-Tabs away),
  // hard-stop the call so Wrench can't chatter into a room he can't see. Also
  // catches the "two voices going" symptom from a stale background call.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden" && (pcRef.current || dcRef.current)) {
        try { dcRef.current?.send(JSON.stringify({ type: "response.cancel" })); } catch {}
        cleanupCall();
        setCallState("idle");
      }
    };
    const onUnload = () => { if (pcRef.current || dcRef.current) cleanupCall(); };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("beforeunload", onUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      } else if (name === "find_diagram" || name === "web_search") {
        const r = await api.post("/search/web", {
          query: args.query || "",
          vehicle_context: args.vehicle_context || "",
          mode: name === "find_diagram" ? "diagram" : "web",
        });
        const imgs = (r.data?.image_urls || []).slice(0, 5);
        const cits = (r.data?.citations || []).slice(0, 5);
        const ansShort = (r.data?.answer || "").slice(0, 800);
        // Send a note artifact with the full thing so Doc can read
        const noteBody = ansShort
          + (cits.length ? "\n\nSOURCES:\n" + cits.map(c => `• ${c.title || ""}: ${c.url}`).join("\n") : "")
          + (imgs.length ? "\n\nIMAGES:\n" + imgs.join("\n") : "");
        addArtifact({ type: name === "find_diagram" ? "diagram" : "note", title: args.query || "Search result", body: noteBody, images: imgs });
        transcriptNote = `✓ ${name === "find_diagram" ? "DIAGRAMS" : "WEB"} → ${imgs.length} image${imgs.length===1?"":"s"} · ${cits.length} source${cits.length===1?"":"s"}`;
        output = {
          ok: true,
          answer: ansShort.slice(0, 400),
          image_urls: imgs,
          citation_urls: cits.map(c => c.url),
          summary_for_voice: imgs.length > 0
            ? `Found ${imgs.length} ${name==='find_diagram'?'diagrams':'pages'}. Check the screen — pictures are up.`
            : "Got it. No images for that one, but I pulled some source pages — they're in the chat panel.",
        };
      } else if (name === "find_similar_cases") {
        const r = await api.post("/cases/search", {
          symptom: args.symptom || "",
          year: args.year || "", make: args.make || "", model: args.model || "", engine: args.engine || "",
          dtc_codes: args.dtc_codes || [],
          k: 3,
        });
        const matches = r.data?.matches || [];
        const conf = r.data?.confidence || "empty";
        if (matches.length === 0) {
          transcriptNote = `✗ NO SIMILAR CASES IN BRAIN (${r.data?.total_cases_in_brain || 0} total)`;
          output = { ok: true, matches: [], confidence: "empty", message: "Brain has no similar cases yet. This is a new one for the shop." };
        } else {
          // Send a note so Doc can read details
          const body = matches.map((m, i) =>
            `${i+1}. ${m.vehicle_summary} (${(m.similarity*100).toFixed(0)}% match, outcome: ${m.outcome})\n` +
            `   SYMPTOM: ${m.symptom}\n` +
            `   CAUSE: ${m.root_cause}\n` +
            `   REPAIR: ${m.repair_summary}\n` +
            (m.parts?.length ? `   PARTS: ${m.parts.join(", ")}\n` : "") +
            (m.technician ? `   BY: ${m.technician}\n` : "")
          ).join("\n");
          addArtifact({ type: "note", title: `Brain match (${conf})`, body });
          transcriptNote = `✓ BRAIN → ${matches.length} match${matches.length>1?"es":""} · top: ${(matches[0].similarity*100).toFixed(0)}% · ${matches[0].root_cause.slice(0,60)}`;
          output = { ok: true, confidence: conf, matches: matches.slice(0, 3).map(m => ({
            vehicle: m.vehicle_summary, similarity: m.similarity, symptom: m.symptom,
            root_cause: m.root_cause, repair: m.repair_summary, parts: m.parts, outcome: m.outcome,
          })) };
        }
      } else if (name === "lookup_credentials") {
        const r = await api.get(`/credentials/lookup?q=${encodeURIComponent(args.site || "")}`);
        const matches = r.data?.matches || [];
        if (matches.length === 0) {
          transcriptNote = `✗ NO CREDENTIALS FOUND FOR "${args.site}"`;
          output = { ok: false, error: `No saved credentials matching "${args.site}". Tell Doc to add it in the VAULT tab.` };
        } else {
          const top = matches[0];
          // Send note with credentials so Doc can copy-paste
          addArtifact({
            type: "note",
            title: `Login: ${top.site}`,
            body: `URL: ${top.url || "—"}\nUsername: ${top.username || "—"}\nPassword: ${top.password || "—"}${top.notes ? "\nNotes: " + top.notes : ""}`,
          });
          transcriptNote = `✓ CREDENTIALS PULLED → ${top.site} · sent to chat`;
          // Return to Wrench but redact the password in the model's view so he doesn't say it out loud
          output = { ok: true, site: top.site, url: top.url, username: top.username, password_visible_in_chat_only: true };
        }
      } else if (name === "inbox_recent") {
        const limit = Math.min(args.limit || 10, 25);
        const r = await api.get(`/email/messages?limit=${limit}${args.unread_only ? "&unread_only=true" : ""}`);
        const raw = r.data;
        const items = Array.isArray(raw) ? raw.slice(0, limit) : (Array.isArray(raw?.value) ? raw.value.slice(0, limit) : []);
        if (items.length === 0) {
          transcriptNote = `✓ INBOX EMPTY`;
          output = { ok: true, count: 0, messages: [], summary_for_voice: "Inbox is clean. No new emails." };
        } else {
          const lines = items.map(m => `${m.is_read?"":"●"} ${m.from || ""} — ${m.subject || "(no subject)"}`).join("\n");
          addArtifact({ type: "note", title: `Inbox (${items.length})`, body: lines });
          transcriptNote = `✓ INBOX → ${items.length} message${items.length===1?"":"s"}`;
          output = { ok: true, count: items.length, messages: items.map(m => ({
            id: m.id, from: m.from, subject: m.subject, preview: (m.preview || "").slice(0, 200), is_read: m.is_read, received: m.received,
          })), summary_for_voice: `You have ${items.length} ${items.length===1?"email":"emails"}. ${items[0].from} sent about ${items[0].subject || "no subject"}.` };
        }
      } else if (name === "email_search") {
        const r = await api.get(`/email/search?q=${encodeURIComponent(args.query || "")}&top=15`);
        const raw = r.data;
        const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
        if (items.length === 0) {
          transcriptNote = `✗ NO EMAIL MATCH FOR "${args.query}"`;
          output = { ok: true, count: 0, messages: [], summary_for_voice: `Nothing in the inbox matching "${args.query}".` };
        } else {
          const lines = items.slice(0,10).map(m => `${m.from || ""} — ${m.subject || "(no subject)"}`).join("\n");
          addArtifact({ type: "note", title: `Email search: ${args.query}`, body: lines });
          transcriptNote = `✓ EMAIL SEARCH → ${items.length} hit${items.length===1?"":"s"}`;
          output = { ok: true, count: items.length, messages: items.slice(0,10).map(m => ({
            id: m.id, from: m.from, subject: m.subject, preview: (m.preview || "").slice(0,200), received: m.received,
          })), summary_for_voice: `Found ${items.length}. Top hit: ${items[0].from} about ${items[0].subject || "no subject"}.` };
        }
      } else if (name === "draft_email_reply") {
        const r = await api.post(`/email/draft-reply/${args.message_id}`, { instruction: args.instruction || "" });
        const d = r.data || {};
        addArtifact({ type: "note", title: `Draft reply: ${d.subject || ""}`, body: `TO: ${(d.to_recipients || []).join(", ")}\nSUBJECT: ${d.subject || ""}\n\n${d.body || ""}\n\n(Draft saved to Outlook Drafts. Say "send it" to fire, or open Drafts to edit.)` });
        transcriptNote = `✓ DRAFT SAVED → ${(d.to_recipients||[]).join(", ").slice(0,40)}`;
        output = { ok: true, draft_id: d.id, subject: d.subject, to: d.to_recipients, body_preview: (d.body || "").slice(0, 400), summary_for_voice: `Draft saved. Recipient ${(d.to_recipients||[])[0] || "the customer"}. Want me to send it?` };
      } else if (name === "send_draft") {
        const r = await api.post(`/email/drafts/${args.draft_id}/send`);
        transcriptNote = `✓ EMAIL SENT`;
        output = { ok: true, sent: true, summary_for_voice: "Sent. Anything else?" };
      } else if (name === "send_email") {
        const r = await api.post("/email/send", {
          to: args.to || [], subject: args.subject || "", body: args.body || "", cc: args.cc || [],
        });
        transcriptNote = `✓ EMAIL SENT → ${(args.to||[]).join(", ").slice(0,40)}`;
        output = { ok: true, sent: true, summary_for_voice: `Sent to ${(args.to||[])[0] || "the recipient"}. Anything else?` };
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
      safeRequestResponse();
    } catch {}
  };

  // Manually halt Wrench's voice (Doc taps a button)
  const haltWrench = () => {
    try { if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.currentTime = 0; } } catch {}
    try { dcRef.current?.send(JSON.stringify({ type: "response.cancel" })); } catch {}
    responseInFlightRef.current = false;
    pendingTurnsRef.current = [];
  };

  // Auto-extract URLs from Wrench's transcript so links never get spelled out without a clickable link backup
  const URL_RE = /\bhttps?:\/\/[^\s)"'<>]+/gi;
  const autoExtractUrls = (txt) => {
    const seen = new Set();
    let m;
    while ((m = URL_RE.exec(txt)) !== null) {
      const url = m[0].replace(/[).,;!?]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      addArtifact({ type: "link", url, label: url.replace(/^https?:\/\//, "").slice(0, 50) });
    }
  };

  const stopTick = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  const tick = () => { timerRef.current = setInterval(() => setCallSeconds(s => s + 1), 1000); };

  const startCall = async () => {
    if (callState === "connected" || callState === "connecting") return;
    // Reset hangup flag for the new session
    userHangupRef.current = false;
    // Reset interim transcript so the chat input box isn't stuck readOnly from a prior call
    setCallInterim("");
    // DEFENSIVE: if there's a lingering peer connection or data channel from a half-dead
    // call (e.g. computer woke from sleep, tab returned from background), tear it down
    // before opening a new one. This kills the "two voices at once" bug.
    if (pcRef.current || dcRef.current || localStreamRef.current) {
      cleanupCall();
    }
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

      // Browser-level audio constraints for noisy shop environments.
      // echoCancellation kills speaker bleed-through (when Wrench is talking),
      // noiseSuppression kills compressor/air-tool/engine drone,
      // autoGainControl evens out Doc's voice when he leans in/out of the phone.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 24000,
        },
      });
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
      dc.onclose = () => {
        setCallState("idle"); stopTick(); setStatus("IDLE", "#52525B");
      };
      dc.onerror = (e) => {
        try { console.warn("realtime dc error", e); } catch {}
        if (!userHangupRef.current) {
          setCallError("Call channel dropped — tap mic to restart");
        }
        setCallState("idle"); stopTick(); setStatus("IDLE", "#52525B");
      };
      // If the peer connection itself disconnects, tear down cleanly. Only surface
      // an error banner if the disconnect was NOT user-initiated.
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "disconnected" || st === "failed" || st === "closed") {
          if (!userHangupRef.current && st === "failed") {
            setCallError("Call dropped — network or server. Tap mic to reconnect.");
          }
          setCallState("idle"); stopTick(); setStatus("IDLE", "#52525B");
        }
      };

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
    // Track response lifecycle so we don't fire two response.create's in parallel
    if (t === "response.created") {
      responseInFlightRef.current = true;
    }
    if (t === "response.done" || t === "response.completed" || t === "response.cancelled" || t === "response.canceled") {
      responseInFlightRef.current = false;
      // If a user turn arrived mid-response, fire it now
      if (pendingTurnsRef.current.length > 0) {
        pendingTurnsRef.current = [];
        setTimeout(() => safeRequestResponse(), 50);
      }
    }
    // When Doc starts speaking, immediately stop Wrench's audio playback (barge-in)
    if (t === "input_audio_buffer.speech_started") {
      try {
        if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.currentTime = 0; }
      } catch {}
      // ONLY send response.cancel if there's actually a response in flight to cancel.
      // Sending it when nothing is running makes OpenAI Realtime emit an "active response not found"
      // error which can lock the session into a bad state for the next turn.
      if (responseInFlightRef.current) {
        try { dcRef.current?.send(JSON.stringify({ type: "response.cancel" })); } catch {}
        responseInFlightRef.current = false;
      }
      // Reset interim transcript for the new utterance so prior partials don't bleed in
      setCallInterim("");
    }
    if (t === "error") {
      // If we hit "active response in progress", clear the flag so the next turn can fire
      const msg = evt.error?.message || "";
      try { console.warn("[wrench-realtime] error event:", evt.error); } catch {}
      if (msg.toLowerCase().includes("active response")) {
        responseInFlightRef.current = false;
      }
      // Surface other unexpected errors so we know what's killing the call
      if (!msg.toLowerCase().includes("active response") && msg) {
        setCallError(`Call error: ${msg.slice(0, 120)}`);
      }
    }
    if (t === "conversation.item.input_audio_transcription.delta") {
      // Live partial transcript as Doc is speaking. Surfaces in the chat input box
      // so he sees what the mic is hearing in real time instead of a stale "LISTENING...".
      setCallInterim(prev => prev + (evt.delta || ""));
    }
    if (t === "conversation.item.input_audio_transcription.completed") {
      const txt = (evt.transcript || "").trim();
      setCallInterim("");
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
        autoExtractUrls(txt);
      }
    }
    if (t === "response.output_audio_transcript.done") {
      const txt = (evt.transcript || pendingAssistantRef.current || "").trim();
      pendingAssistantRef.current = "";
      if (txt) {
        setCallTranscript(arr => [...arr, { who: "wrench", text: txt }]);
        appendToChatSession("assistant", txt);
        autoExtractUrls(txt);
      }
    }
    if (t === "response.function_call_arguments.done") {
      handleFunctionCall(evt.call_id, evt.name, evt.arguments);
    }
    if (t === "response.output_item.done" && evt.item?.type === "function_call") {
      handleFunctionCall(evt.item.call_id, evt.item.name, evt.item.arguments);
    }
    if (t === "error") {
      const msg = evt.error?.message || "Realtime error";
      // Swallow the "active response in progress" error — we already handle the race
      // condition upstream by gating response.create. Showing it scares Doc.
      if (!msg.toLowerCase().includes("active response")) {
        setCallError(msg);
      }
    }
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
      safeRequestResponse();
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
    responseInFlightRef.current = false;
    pendingTurnsRef.current = [];
    stopTick();
    setCallMuted(false);
    // CRITICAL: reset interim transcript so the textarea doesn't stay locked in readOnly mode
    setCallInterim("");
  };

  const endCall = () => {
    userHangupRef.current = true;
    cleanupCall();
    setCallState("idle"); setStatus("IDLE", "#52525B");
    // Reset the user-hangup flag after teardown so the NEXT call's events fire normally
    setTimeout(() => { userHangupRef.current = false; }, 800);
  };

  return (
    <AppCtx.Provider value={{
      vehicles, refreshVehicles,
      activeVehicleId, setActiveVehicleId, activeVehicle,
      callState, callError, callTranscript, callInterim, setCallInterim, callMuted, callSeconds, callVolume,
      setCallVolume, startCall, endCall, sendCallText, toggleCallMute, haltWrench,
      callArtifacts, addArtifact, markArtifactsSeen, clearArtifact, clearAllArtifacts,
    }}>
      <audio ref={audioElRef} playsInline autoPlay style={{display:"none"}} />
      {children}
    </AppCtx.Provider>
  );
}
