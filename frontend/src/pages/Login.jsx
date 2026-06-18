import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Wrench } from "lucide-react";
import api, { setToken } from "@/api";

const BG_IMG = "https://images.pexels.com/photos/4489765/pexels-photo-4489765.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940";

export default function Login() {
  const nav = useNavigate();
  const [mode, setMode] = useState("login"); // or "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("Doc");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const r = await api.post(`/auth/${mode}`, mode === "signup"
        ? { email, password, name }
        : { email, password });
      setToken(r.data.token);
      nav("/");
    } catch (e) {
      setErr(e?.response?.data?.detail || "Login jammed up");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex relative overflow-hidden">
      <div className="absolute inset-0">
        <img src={BG_IMG} alt="" className="w-full h-full object-cover opacity-30" />
        <div className="absolute inset-0 bg-bg-1/85" />
      </div>
      <div className="absolute inset-x-0 top-0 h-1 hazard" />
      <div className="absolute inset-x-0 bottom-0 h-1 hazard" />

      {/* Left brand */}
      <div className="hidden md:flex w-1/2 relative z-10 flex-col justify-between p-12">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-rust flex items-center justify-center">
            <Wrench size={28} color="#000" strokeWidth={3} />
          </div>
          <div>
            <div className="heading text-3xl leading-none">DATA WRENCH</div>
            <div className="text-[11px] text-ink-2 uppercase tracking-[0.3em] mt-1">AI FOREMAN // V1.0</div>
          </div>
        </div>
        <div>
          <h1 className="heading text-5xl lg:text-6xl leading-[0.95]">
            THE SHOP FOREMAN<br/>
            THAT NEVER<br/>
            <span className="text-rust">CLOCKS OUT.</span>
          </h1>
          <p className="mt-6 text-ink-2 max-w-md text-sm leading-relaxed">
            Reads your logs. Knows your shop. Edits your tuning tables.
            Talks like a mechanic, not a chatbot.
          </p>
          <div className="mt-8 text-[10px] uppercase tracking-[0.3em] text-ink-3">
            DR. UNDERHOOD™ AUTOMOTIVE SPECIALIST // PRIVATE BUILD
          </div>
        </div>
        <div className="text-[10px] text-ink-3 uppercase tracking-[0.25em]">
          [ SYSTEM READY ]&nbsp;<span className="animate-blink text-rust">_</span>
        </div>
      </div>

      {/* Right form */}
      <div className="flex-1 relative z-10 flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-md panel p-8" data-testid="auth-form">
          <div className="text-[10px] uppercase tracking-[0.3em] text-ink-3 mb-2">
            {mode === "login" ? ">> AUTHENTICATE" : ">> NEW OPERATOR"}
          </div>
          <h2 className="heading text-4xl mb-6">
            {mode === "login" ? <>BACK IN<br/><span className="text-rust">THE BAY</span></> : <>FIRE IT<br/><span className="text-rust">UP</span></>}
          </h2>

          {mode === "signup" && (
            <div className="mb-4">
              <label className="label-shop">Name / Handle</label>
              <input data-testid="signup-name" value={name} onChange={e=>setName(e.target.value)} className="input-shop" placeholder="Doc" />
            </div>
          )}
          <div className="mb-4">
            <label className="label-shop">Email</label>
            <input data-testid="auth-email" type="email" required value={email} onChange={e=>setEmail(e.target.value)} className="input-shop" placeholder="doc@drunderhood.com" />
          </div>
          <div className="mb-2">
            <label className="label-shop">Password</label>
            <input data-testid="auth-password" type="password" required value={password} onChange={e=>setPassword(e.target.value)} className="input-shop" placeholder="••••••••" />
          </div>

          {err && <div className="my-3 text-danger text-xs uppercase tracking-widest border border-danger px-3 py-2" data-testid="auth-error">ERR: {err}</div>}

          <button type="submit" disabled={busy} data-testid="auth-submit" className="btn-rust w-full mt-6">
            {busy ? "WORKING..." : (mode === "login" ? "ENGAGE" : "BUILD PROFILE")}
          </button>

          <div className="mt-6 text-center">
            <button type="button" data-testid="auth-toggle" onClick={()=>{setMode(mode==="login"?"signup":"login"); setErr("")}} className="text-ink-2 hover:text-rust text-xs uppercase tracking-[0.25em]">
              {mode === "login" ? "First time? CREATE PROFILE" : "Already onboarded? LOG IN"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
