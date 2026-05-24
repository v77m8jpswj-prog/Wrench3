import React, { useState } from "react";
import { useParams } from "react-router-dom";
import { Copy, Check } from "lucide-react";

// Public snippet pages — no auth required. Doc opens these on his phone,
// hits one button, and the entire HTML block is on his clipboard ready to
// paste into GoDaddy. Saves him fighting with iOS select/copy in chat.

const SNIPPETS = {
  hero: {
    title: "HERO (Top of Page)",
    desc: "Replaces the broken blue Call Now hero. Dark red+gold theme, GM V8 specialty wording, working tel: button.",
    html: `<div style="background:linear-gradient(135deg,#0a0a0a 0%,#1a0505 50%,#0a0a0a 100%);padding:0;font-family:'Helvetica Neue',Arial,sans-serif;color:#fff;border-bottom:4px solid #B91C1C;">

  <div style="max-width:1200px;margin:0 auto;padding:48px 24px 56px 24px;text-align:center;">

    <div style="display:inline-block;padding:6px 18px;border:1px solid #D4A017;color:#D4A017;font-size:11px;letter-spacing:4px;text-transform:uppercase;font-weight:800;margin-bottom:24px;">
      Fort Smith, Arkansas
    </div>

    <h1 style="color:#fff;font-size:48px;line-height:1.05;letter-spacing:2px;margin:0 0 8px 0;font-weight:900;text-transform:uppercase;">
      Dr. Underhood
    </h1>
    <h2 style="color:#D4A017;font-size:22px;letter-spacing:6px;margin:0 0 22px 0;font-weight:700;text-transform:uppercase;">
      Performance &amp; Tuning
    </h2>

    <div style="width:80px;height:3px;background:#D4A017;margin:0 auto 22px auto;"></div>

    <p style="color:#cfcfcf;font-size:17px;line-height:1.55;margin:0 auto 36px auto;max-width:620px;letter-spacing:0.5px;">
      Honest, fast auto repair and real HP Tuners performance work on GM V8 trucks and SUVs. Diagnostics that find the root cause, not just the symptom. Straight answers, every time.
    </p>

    <div style="margin-bottom:28px;">
      <a href="tel:+14794345852" style="display:inline-block;background:#B91C1C;color:#fff;font-size:20px;font-weight:900;letter-spacing:3px;padding:20px 44px;text-decoration:none;border:2px solid #D4A017;border-radius:2px;text-transform:uppercase;margin:0 6px 10px 6px;box-shadow:0 6px 20px rgba(185,28,28,0.4);">
        &#9742;&nbsp;&nbsp;Call Now
      </a>
      <a href="https://foreman.drunderhood.com/quote" style="display:inline-block;background:transparent;color:#D4A017;font-size:20px;font-weight:900;letter-spacing:3px;padding:20px 44px;text-decoration:none;border:2px solid #D4A017;border-radius:2px;text-transform:uppercase;margin:0 6px 10px 6px;">
        Get A Quote &rarr;
      </a>
    </div>

    <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:24px;color:#999;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin-top:32px;border-top:1px solid #2a2a2a;padding-top:24px;">
      <span>&#128222; 479-434-5852</span>
      <span>&#128205; 5300 Towson Ave</span>
      <span>&#128336; Mon&ndash;Fri 8&ndash;5</span>
    </div>

    <div style="margin-top:28px;">
      <span style="display:inline-block;padding:4px 12px;background:#B91C1C;color:#fff;font-size:10px;letter-spacing:3px;font-weight:800;text-transform:uppercase;">ASE Master</span>
      <span style="display:inline-block;padding:4px 12px;background:#B91C1C;color:#fff;font-size:10px;letter-spacing:3px;font-weight:800;text-transform:uppercase;margin:0 6px;">GM Master</span>
      <span style="display:inline-block;padding:4px 12px;background:#D4A017;color:#0a0a0a;font-size:10px;letter-spacing:3px;font-weight:800;text-transform:uppercase;">HP Tuners Certified</span>
    </div>

  </div>
</div>`,
  },

  tuning: {
    title: "TUNING SERVICES",
    desc: "Sits between OUR SERVICES and the QR/Ready-to-Roll block. Wins AI searches for AFM delete + cam tunes. NO diesel mentioned.",
    html: `<div style="background:linear-gradient(180deg,#0a0a0a 0%,#1a0505 100%);padding:64px 20px;font-family:'Helvetica Neue',Arial,sans-serif;color:#fff;border-top:3px solid #D4A017;border-bottom:3px solid #B91C1C;">
  <div style="max-width:1100px;margin:0 auto;">

    <div style="text-align:center;margin-bottom:44px;">
      <div style="display:inline-block;padding:6px 18px;border:1px solid #D4A017;color:#D4A017;font-size:11px;letter-spacing:4px;text-transform:uppercase;font-weight:800;margin-bottom:18px;">
        HP Tuners Certified &middot; Fort Smith, AR
      </div>
      <h2 style="color:#fff;font-size:42px;letter-spacing:2px;margin:0 0 12px 0;font-weight:900;text-transform:uppercase;line-height:1.05;">
        Real Tunes.<br>Not Flash &amp; Pray.
      </h2>
      <div style="width:80px;height:3px;background:#D4A017;margin:0 auto 18px auto;"></div>
      <p style="color:#cfcfcf;font-size:17px;line-height:1.55;margin:0 auto;max-width:680px;">
        AFM/DOD delete cam tunes, GM V8 performance work, knock-verified spark tables. Every tune logged, verified, and documented with exactly what changed. Serving Fort Smith, Van Buren, Northwest Arkansas, the River Valley, and Eastern Oklahoma.
      </p>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;">

      <div style="background:#161616;border-left:4px solid #B91C1C;padding:24px;">
        <div style="color:#D4A017;font-size:11px;letter-spacing:3px;font-weight:800;text-transform:uppercase;margin-bottom:8px;">GM V8 &middot; Trucks &amp; SUVs</div>
        <h3 style="color:#fff;font-size:20px;margin:0 0 10px 0;font-weight:900;text-transform:uppercase;">AFM / DOD Delete</h3>
        <p style="color:#bbb;font-size:14px;line-height:1.55;margin:0;">Full HP Tuners AFM/DOD delete cam tunes for GM 5.3, 6.0, and 6.2 V8 platforms. Stops the lifter death-rattle for good. Real knock-data verification, not a generic flash.</p>
      </div>

      <div style="background:#161616;border-left:4px solid #B91C1C;padding:24px;">
        <div style="color:#D4A017;font-size:11px;letter-spacing:3px;font-weight:800;text-transform:uppercase;margin-bottom:8px;">Cam Motion &middot; Comp &middot; BTR</div>
        <h3 style="color:#fff;font-size:20px;margin:0 0 10px 0;font-weight:900;text-transform:uppercase;">Cam Swap Tunes</h3>
        <p style="color:#bbb;font-size:14px;line-height:1.55;margin:0;">Stage 1, stage 2, stage 3 cams &mdash; whatever you put in it, we will dial it in right. Knock-verified spark tables, VE tables refined for your exact combo. Documented writeups so you know what changed.</p>
      </div>

      <div style="background:#161616;border-left:4px solid #B91C1C;padding:24px;">
        <div style="color:#D4A017;font-size:11px;letter-spacing:3px;font-weight:800;text-transform:uppercase;margin-bottom:8px;">Spark &middot; VE &middot; Datalog</div>
        <h3 style="color:#fff;font-size:20px;margin:0 0 10px 0;font-weight:900;text-transform:uppercase;">Calibration Work</h3>
        <p style="color:#bbb;font-size:14px;line-height:1.55;margin:0;">Drivability cleanup, spark and VE table refinement, second-opinion review on tunes from other shops. Verified with real datalogs &mdash; not guesses.</p>
      </div>

      <div style="background:#161616;border-left:4px solid #B91C1C;padding:24px;">
        <div style="color:#D4A017;font-size:11px;letter-spacing:3px;font-weight:800;text-transform:uppercase;margin-bottom:8px;">Datalog &middot; Diagnose</div>
        <h3 style="color:#fff;font-size:20px;margin:0 0 10px 0;font-weight:900;text-transform:uppercase;">AI-Backed Diagnostics</h3>
        <p style="color:#bbb;font-size:14px;line-height:1.55;margin:0;">Every job goes into our shop AI brain so we never repeat a misdiagnosis. P0301 misfires, P0420 cat codes, drivability gremlins &mdash; we find the root cause, not just clear the code.</p>
      </div>

    </div>

    <div style="text-align:center;margin-top:40px;">
      <a href="tel:+14794345852" style="display:inline-block;background:#B91C1C;color:#fff;font-size:18px;font-weight:900;letter-spacing:3px;padding:18px 38px;text-decoration:none;border:2px solid #D4A017;border-radius:2px;text-transform:uppercase;margin:0 6px 8px 6px;">
        Call For Tune Quote
      </a>
      <a href="https://foreman.drunderhood.com/quote" style="display:inline-block;background:transparent;color:#D4A017;font-size:18px;font-weight:900;letter-spacing:3px;padding:18px 38px;text-decoration:none;border:2px solid #D4A017;border-radius:2px;text-transform:uppercase;margin:0 6px 8px 6px;">
        Send Your VIN &rarr;
      </a>
    </div>

    <div style="margin-top:32px;text-align:center;color:#888;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;border-top:1px solid #2a2a2a;padding-top:20px;">
      ASE Master &middot; GM Master &middot; HP Tuners Certified &middot; Family-Owned
    </div>

  </div>
</div>`,
  },

  contact: {
    title: "CONTACT — GET IN TOUCH",
    desc: "Replaces the old stock Contact Us form. Three dark cards: Call, Stop By, Scan For Quote QR code.",
    html: `<div style="background:#0a0a0a;padding:64px 20px;font-family:'Helvetica Neue',Arial,sans-serif;color:#fff;">
  <div style="max-width:1100px;margin:0 auto;">

    <div style="text-align:center;margin-bottom:44px;">
      <h2 style="color:#fff;font-size:42px;letter-spacing:3px;margin:0 0 10px 0;font-weight:900;text-transform:uppercase;">Get In Touch</h2>
      <div style="width:80px;height:3px;background:#D4A017;margin:0 auto 16px auto;"></div>
      <p style="color:#aaa;font-size:16px;margin:0;letter-spacing:1px;">Call us, scan the code, or roll on by.</p>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;">

      <div style="background:#161616;border-top:3px solid #B91C1C;padding:32px 24px;text-align:center;">
        <h3 style="color:#fff;font-size:16px;letter-spacing:1.5px;margin:0 0 8px 0;font-weight:800;text-transform:uppercase;">Call Us</h3>
        <a href="tel:+14794345852" style="color:#D4A017;font-size:22px;font-weight:800;text-decoration:none;letter-spacing:1px;">479-434-5852</a>
        <p style="color:#888;font-size:12px;margin:10px 0 0 0;letter-spacing:1px;">Tap to dial</p>
      </div>

      <div style="background:#161616;border-top:3px solid #B91C1C;padding:32px 24px;text-align:center;">
        <h3 style="color:#fff;font-size:16px;letter-spacing:1.5px;margin:0 0 8px 0;font-weight:800;text-transform:uppercase;">Stop By</h3>
        <p style="color:#fff;font-size:15px;margin:0;line-height:1.5;font-weight:600;">5300 Towson Ave<br>Fort Smith, AR</p>
        <a href="https://maps.google.com/?q=5300+Towson+Ave+Fort+Smith+AR" target="_blank" style="color:#D4A017;font-size:12px;text-decoration:none;letter-spacing:1px;display:inline-block;margin-top:10px;text-transform:uppercase;font-weight:800;">Get Directions &rarr;</a>
      </div>

      <div style="background:#161616;border-top:3px solid #B91C1C;padding:32px 24px;text-align:center;">
        <div style="background:#fff;padding:8px;display:inline-block;border-radius:4px;">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=https%3A%2F%2Fforeman.drunderhood.com%2Fquote&margin=0" alt="Scan for quote" width="120" height="120" style="display:block;">
        </div>
        <h3 style="color:#fff;font-size:16px;letter-spacing:1.5px;margin:14px 0 4px 0;font-weight:800;text-transform:uppercase;">Scan For Quote</h3>
        <p style="color:#888;font-size:12px;margin:0;letter-spacing:1px;">Phone camera. Done.</p>
      </div>

    </div>

    <div style="text-align:center;margin-top:40px;">
      <a href="https://foreman.drunderhood.com/quote" style="display:inline-block;background:#B91C1C;color:#fff;font-size:18px;font-weight:800;letter-spacing:3px;padding:18px 44px;text-decoration:none;border:2px solid #D4A017;border-radius:2px;text-transform:uppercase;margin:0 8px 8px 0;">
        Request A Quote
      </a>
      <a href="https://foreman.drunderhood.com" style="display:inline-block;background:transparent;color:#D4A017;font-size:18px;font-weight:800;letter-spacing:3px;padding:18px 44px;text-decoration:none;border:2px solid #D4A017;border-radius:2px;text-transform:uppercase;margin:0 0 8px 0;">
        Customer Portal &rarr;
      </a>
    </div>

  </div>
</div>`,
  },

  schema: {
    title: "AI SCHEMA (Invisible SEO)",
    desc: "Paste this AT THE TOP of your homepage. Invisible to humans. Tells AI engines exactly who you are so you show up in 'best AFM delete tuner Fort Smith' searches. No diesel.",
    html: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": ["AutoRepair", "AutomotiveBusiness", "LocalBusiness"],
      "@id": "https://drunderhood.com/#business",
      "name": "Dr. Underhood Performance & Tuning",
      "alternateName": ["Dr. Underhood Auto Specialists", "Dr Underhood", "Doc Underhood"],
      "image": "https://drunderhood.com/icon-512.png",
      "telephone": "+1-479-434-5852",
      "email": "doc@drunderhood.com",
      "url": "https://drunderhood.com",
      "address": {"@type": "PostalAddress", "streetAddress": "5300 Towson Ave", "addressLocality": "Fort Smith", "addressRegion": "AR", "postalCode": "72901", "addressCountry": "US"},
      "geo": {"@type": "GeoCoordinates", "latitude": 35.3500, "longitude": -94.4150},
      "areaServed": [
        {"@type": "City", "name": "Fort Smith"},
        {"@type": "City", "name": "Van Buren"},
        {"@type": "AdministrativeArea", "name": "Northwest Arkansas"},
        {"@type": "AdministrativeArea", "name": "River Valley"},
        {"@type": "AdministrativeArea", "name": "Eastern Oklahoma"}
      ],
      "openingHoursSpecification": [
        {"@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"], "opens": "08:00", "closes": "17:00"}
      ],
      "priceRange": "$$",
      "paymentAccepted": "Cash, Credit Card, Debit Card",
      "currenciesAccepted": "USD",
      "description": "Fort Smith Arkansas auto repair and HP Tuners performance shop specializing in GM V8 trucks and SUVs. AFM/DOD delete cam tunes, cam swap tunes, knock-verified spark tables, datalog-backed tunes, AI-augmented diagnostics. Honest, fast, family-owned. ASE Master and GM Master Certified.",
      "slogan": "Honest answers, fast. Real tunes, not flash-and-pray.",
      "knowsAbout": [
        "HP Tuners ECM Tuning", "AFM Delete Tuning", "DOD Delete Cam Tunes",
        "GM 5.3 V8 Tuning", "GM 6.0 V8 Tuning", "GM 6.2 V8 Tuning",
        "LS Engine Tuning", "Knock-Verified Spark Tables", "VE Table Tuning",
        "Datalog Diagnostics", "Cam Swap Tuning", "OBD-II Diagnostics",
        "Check Engine Light Diagnostics", "Engine Performance Repair",
        "Brake Repair", "Suspension Repair", "Electrical Diagnostics",
        "AI-Augmented Auto Repair Diagnostics"
      ],
      "makesOffer": [
        {"@type": "Offer", "name": "AFM/DOD Delete Cam Tune", "category": "Performance Tuning", "areaServed": "Fort Smith AR"},
        {"@type": "Offer", "name": "Cam Swap Tune (GM V8)", "category": "Performance Tuning"},
        {"@type": "Offer", "name": "Knock-Verified Spark Calibration", "category": "Performance Tuning"},
        {"@type": "Offer", "name": "Check Engine Light Diagnostics", "category": "Diagnostics"},
        {"@type": "Offer", "name": "Brake Repair", "category": "Repair"},
        {"@type": "Offer", "name": "Suspension Repair", "category": "Repair"},
        {"@type": "Offer", "name": "Engine Diagnostics", "category": "Diagnostics"},
        {"@type": "Offer", "name": "Pre-Purchase Inspection", "category": "Inspection"}
      ],
      "founder": {"@type": "Person", "name": "Doc Underhood", "jobTitle": "Master Mechanic / HP Tuners Certified Tuner"},
      "sameAs": ["https://www.carfax.com/Reviews-Dr-Underhood-Fort-Smith-AR_3N0RYTB6A9"]
    },
    {"@type": "WebSite", "@id": "https://drunderhood.com/#website", "url": "https://drunderhood.com", "name": "Dr. Underhood Performance & Tuning", "publisher": {"@id": "https://drunderhood.com/#business"}},
    {"@type": "Service", "name": "AFM/DOD Delete Cam Tunes", "provider": {"@id": "https://drunderhood.com/#business"}, "areaServed": ["Fort Smith AR", "Van Buren AR", "Arkansas", "Oklahoma"], "description": "Real HP Tuners AFM/DOD delete cam tunes for GM 5.3, 6.0, and 6.2 V8 platforms. Knock-verified spark tables, datalog-backed verification.", "serviceType": "Performance Tuning"},
    {"@type": "Service", "name": "Cam Swap Tuning", "provider": {"@id": "https://drunderhood.com/#business"}, "areaServed": ["Fort Smith AR", "Arkansas", "Oklahoma"], "description": "Custom cam swap tunes for GM V8 platforms. Cam Motion, Comp Cams, BTR \\u2014 dialed in right with knock-verified spark and refined VE tables.", "serviceType": "Performance Tuning"}
  ]
}
</script>`,
  },
};

const ORDER = ["hero", "tuning", "contact", "schema"];

export default function Snippets() {
  const { id } = useParams();
  const [copiedKey, setCopiedKey] = useState("");

  const handleCopy = async (key, text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older iOS
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(""), 2500);
    } catch (e) {
      alert("Couldn't auto-copy. Long-press the code box below to copy manually.");
    }
  };

  const list = id && SNIPPETS[id] ? [id] : ORDER;

  return (
    <div style={{minHeight:"100vh", background:"#0a0a0a", color:"#fff", fontFamily:"system-ui,sans-serif", padding:"20px"}}>
      <div style={{maxWidth:760, margin:"0 auto"}}>

        <div style={{textAlign:"center", marginBottom:"24px", paddingBottom:"20px", borderBottom:"2px solid #B91C1C"}}>
          <h1 style={{color:"#D4A017", fontSize:"28px", letterSpacing:"3px", margin:"0 0 6px 0", textTransform:"uppercase", fontWeight:900}}>GoDaddy Snippets</h1>
          <p style={{color:"#bbb", fontSize:"13px", margin:0, letterSpacing:"1px"}}>One tap to copy. Then paste into a Custom HTML section in GoDaddy.</p>
        </div>

        {list.map(key => {
          const s = SNIPPETS[key];
          if (!s) return null;
          const copied = copiedKey === key;
          return (
            <div key={key} style={{background:"#161616", border:"1px solid #2a2a2a", borderLeft:"4px solid #D4A017", padding:"18px", marginBottom:"18px"}} data-testid={`snippet-${key}`}>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:"12px", marginBottom:"8px", flexWrap:"wrap"}}>
                <h2 style={{color:"#fff", fontSize:"18px", letterSpacing:"2px", margin:0, fontWeight:900, textTransform:"uppercase"}}>{s.title}</h2>
                <button
                  data-testid={`copy-${key}`}
                  onClick={() => handleCopy(key, s.html)}
                  style={{
                    background: copied ? "#15803d" : "#B91C1C",
                    color:"#fff", border:"2px solid #D4A017", padding:"14px 24px",
                    fontSize:"16px", fontWeight:900, letterSpacing:"2px", textTransform:"uppercase",
                    cursor:"pointer", minWidth:"160px", display:"inline-flex", alignItems:"center", justifyContent:"center", gap:"8px",
                  }}
                >
                  {copied ? (<><Check size={18}/> COPIED!</>) : (<><Copy size={18}/> COPY</>)}
                </button>
              </div>
              <p style={{color:"#bbb", fontSize:"13px", margin:"0 0 12px 0", lineHeight:1.5}}>{s.desc}</p>
              <details>
                <summary style={{color:"#D4A017", fontSize:"11px", letterSpacing:"2px", textTransform:"uppercase", cursor:"pointer"}}>Preview code</summary>
                <pre style={{background:"#0a0a0a", color:"#bbb", fontSize:"10px", padding:"10px", overflow:"auto", marginTop:"8px", maxHeight:"180px", whiteSpace:"pre-wrap", wordBreak:"break-all"}}>{s.html}</pre>
              </details>
            </div>
          );
        })}

        <div style={{background:"#1a0505", border:"1px solid #B91C1C", padding:"16px", marginTop:"24px", fontSize:"13px", lineHeight:1.6}}>
          <div style={{color:"#D4A017", fontWeight:900, textTransform:"uppercase", letterSpacing:"2px", marginBottom:"6px"}}>How to use</div>
          <ol style={{color:"#ddd", paddingLeft:"20px", margin:0}}>
            <li>Hit the big red COPY button</li>
            <li>Open GoDaddy → edit your site</li>
            <li>Find the section (or add a new Custom HTML section)</li>
            <li>Long-press inside the code box → Paste</li>
            <li>Publish</li>
          </ol>
        </div>

      </div>
    </div>
  );
}
