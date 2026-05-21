import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Phone, MapPin, Clock, Wrench as WrenchIcon, Truck, Send, CheckCircle2, AlertCircle } from "lucide-react";
import api from "@/api";

export default function ShopLanding() {
  const { shopId } = useParams();
  const [shop, setShop] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get(`/public/shop/${shopId}`)
      .then(r => setShop(r.data))
      .catch(e => setErr(e?.response?.data?.detail || "Couldn't load shop info"));
  }, [shopId]);

  if (err) return <div className="min-h-screen bg-bg-1 flex items-center justify-center text-danger p-6">{err}</div>;
  if (!shop) return <div className="min-h-screen bg-bg-1 flex items-center justify-center text-ink-3 p-6">Loading...</div>;

  return (
    <div className="min-h-screen bg-bg-1 text-ink" data-testid="shop-landing">
      {/* Hero */}
      <div className="relative border-b-2 border-rust bg-bg-2 py-10 md:py-16 px-4 md:px-8 overflow-hidden">
        <div className="absolute inset-0 grain opacity-30"/>
        <div className="relative max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <WrenchIcon size={28} className="text-rust"/>
            <div className="text-[11px] text-ink-3 uppercase tracking-widest">PERFORMANCE · DIAGNOSTICS · TUNING</div>
          </div>
          <h1 className="heading text-4xl md:text-6xl lg:text-7xl leading-none mb-3">
            {shop.name?.toUpperCase() || "DR. UNDERHOOD"}
          </h1>
          {shop.service_areas?.length > 0 && (
            <div className="text-sm text-amber2 uppercase tracking-widest mb-4">
              SERVING: {shop.service_areas.join(" · ")}
            </div>
          )}
          <div className="flex flex-wrap gap-4 text-sm text-ink-2 mt-6">
            {shop.phone && <a href={`tel:${shop.phone}`} className="flex items-center gap-2 hover:text-rust"><Phone size={16}/>{shop.phone}</a>}
            {shop.address && <span className="flex items-center gap-2"><MapPin size={16}/>{shop.address}</span>}
            {shop.hours && <span className="flex items-center gap-2"><Clock size={16}/>{shop.hours}</span>}
          </div>
        </div>
      </div>

      {/* Capabilities */}
      {shop.capabilities?.length > 0 && (
        <div className="py-10 md:py-14 px-4 md:px-8 border-b border-line">
          <div className="max-w-5xl mx-auto">
            <h2 className="heading text-2xl md:text-3xl mb-6">WHAT WE DO <span className="text-rust">//</span></h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {shop.capabilities.map((c,i) => (
                <div key={i} className="border-l-2 border-rust pl-3 py-2 bg-bg-2">
                  <div className="text-sm uppercase tracking-widest text-amber2 font-bold">{c}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Specialties — what we're known for */}
      {shop.specialties?.length > 0 && (
        <div className="py-10 md:py-14 px-4 md:px-8 bg-bg-2 border-b border-line">
          <div className="max-w-5xl mx-auto">
            <h2 className="heading text-2xl md:text-3xl mb-2">SPECIALTIES <span className="text-rust">//</span></h2>
            <p className="text-xs text-ink-3 uppercase tracking-widest mb-6">WHAT WE'RE KNOWN FOR</p>
            <div className="flex flex-wrap gap-2">
              {shop.specialties.map((s,i) => (
                <span key={i} className="px-3 py-2 border-2 border-amber2/40 text-amber2 uppercase tracking-widest text-xs font-bold bg-amber2/5">
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Why us — the brain pitch */}
      <div className="py-10 md:py-14 px-4 md:px-8 border-b border-line">
        <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-6">
          <div>
            <h2 className="heading text-2xl md:text-3xl mb-3">EVERY FIX REMEMBERED <span className="text-rust">//</span></h2>
            <p className="text-sm text-ink-2 mb-3">
              We log every job into our shop's AI brain. Next time something similar rolls in, we already know what fixed it.
            </p>
            <p className="text-sm text-ink-2">
              That's how you stop paying for "let's try this" diagnostics. Doc Underhood gets your truck right the first time.
            </p>
          </div>
          <div>
            <h2 className="heading text-2xl md:text-3xl mb-3">REAL TUNING <span className="text-rust">//</span></h2>
            <p className="text-sm text-ink-2 mb-3">
              HP Tuners. Datalog-backed. Verified on the dyno. Not a flash-and-pray operation.
            </p>
            <p className="text-sm text-ink-2">
              AFM/DOD delete, cam tunes, diesel performance — done with knock data, AFR traces, and a write-up of exactly what changed.
            </p>
          </div>
        </div>
      </div>

      {/* Quote form */}
      <QuoteForm shopId={shopId}/>

      {/* Footer */}
      <div className="py-6 px-4 md:px-8 border-t border-line bg-bg-2 text-center text-[11px] text-ink-3 uppercase tracking-widest">
        {shop.name} · Powered by Data Wrench
      </div>
    </div>
  );
}

function QuoteForm({ shopId }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [what, setWhat] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (!name.trim() || !contact.trim() || !what.trim()) {
      setErr("Need at least your name, phone or email, and what you're after."); return;
    }
    setBusy(true);
    try {
      await api.post("/public/leads", {
        shop_id: shopId,
        name: name.trim(),
        contact: contact.trim(),
        vehicle: vehicle.trim(),
        what_they_need: what.trim(),
        source: "landing",
      });
      setSent(true);
    } catch (ex) {
      setErr(ex?.response?.data?.detail || "Couldn't send that — call us instead.");
    } finally { setBusy(false); }
  };

  if (sent) {
    return (
      <div className="py-12 px-4 md:px-8 bg-bg-2" data-testid="quote-sent">
        <div className="max-w-2xl mx-auto text-center">
          <CheckCircle2 size={48} className="text-ok mx-auto mb-3"/>
          <h2 className="heading text-2xl md:text-3xl mb-2">GOT IT.</h2>
          <p className="text-sm text-ink-2">Doc'll get back to you. If it's urgent, call us direct.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="py-10 md:py-14 px-4 md:px-8 bg-bg-2 border-b border-line">
      <div className="max-w-2xl mx-auto">
        <h2 className="heading text-2xl md:text-3xl mb-2">GET A QUOTE <span className="text-rust">//</span></h2>
        <p className="text-xs text-ink-3 uppercase tracking-widest mb-6">SHOOT US YOUR VIN OR WHAT'S GOING WRONG. NO BOTS. NO ROBOCALLS.</p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label-shop">YOUR NAME</label>
            <input data-testid="lead-name" value={name} onChange={e=>setName(e.target.value)} className="input-shop w-full"/>
          </div>
          <div>
            <label className="label-shop">PHONE OR EMAIL</label>
            <input data-testid="lead-contact" value={contact} onChange={e=>setContact(e.target.value)} className="input-shop w-full" placeholder="479-555-0100 or you@example.com"/>
          </div>
          <div>
            <label className="label-shop">VEHICLE (OPTIONAL)</label>
            <input data-testid="lead-vehicle" value={vehicle} onChange={e=>setVehicle(e.target.value)} className="input-shop w-full" placeholder="2017 GMC Sierra 5.3 OR full VIN"/>
          </div>
          <div>
            <label className="label-shop">WHAT'S GOING ON / WHAT YOU NEED</label>
            <textarea data-testid="lead-what" value={what} onChange={e=>setWhat(e.target.value)} rows={5} className="input-shop w-full" placeholder="e.g. Truck has a misfire on cold start, P0301. Or: looking for a cam tune quote on a 5.3 with a Cam Motion stage 2."/>
          </div>
          {err && (
            <div className="flex items-start gap-2 text-danger text-sm border border-danger/40 bg-danger/10 p-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0"/>{err}
            </div>
          )}
          <button type="submit" disabled={busy} data-testid="lead-submit" className="btn-rust w-full py-3 text-base flex items-center justify-center gap-2 disabled:opacity-50">
            <Send size={14}/>{busy ? "SENDING..." : "SEND IT"}
          </button>
        </form>
      </div>
    </div>
  );
}
