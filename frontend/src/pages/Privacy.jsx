import React from "react";
import { Link } from "react-router-dom";
import { Wrench, ArrowLeft } from "lucide-react";

/* eslint-disable react/no-unescaped-entities */
/* Privacy policy — required for: Google Play resubmission, Facebook App Review,
   Apple if we ever go there. Plain-English, single shop owner running an
   internal tool. NOT lawyer-grade — just enough to satisfy platform reviewers. */

export default function Privacy() {
  const lastUpdated = "March 1, 2026";

  return (
    <div className="min-h-screen bg-bg-1 text-ink">
      <div className="max-w-3xl mx-auto px-4 md:px-8 py-8">
        <Link to="/" data-testid="privacy-back-home" className="inline-flex items-center gap-2 text-ink-3 hover:text-rust text-sm uppercase tracking-widest mb-4">
          <ArrowLeft size={14}/>BACK TO FOREMAN
        </Link>

        <div className="flex items-center gap-3 mb-6 pb-4 border-b border-line">
          <Wrench size={28} className="text-rust" />
          <div>
            <h1 className="font-head text-2xl md:text-3xl uppercase tracking-widest text-white">PRIVACY POLICY</h1>
            <p className="text-xs uppercase tracking-widest text-ink-3 mt-1">DR. UNDERHOOD AUTOMOTIVE · LAST UPDATED {lastUpdated}</p>
          </div>
        </div>

        <div className="space-y-6 text-ink-2 text-sm leading-relaxed" data-testid="privacy-content">

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">WHO WE ARE</h2>
            <p>Dr. Underhood Automotive Specialist ("we", "us") is a sole-proprietor automotive repair shop located in Fort Smith, Arkansas, owned and operated by Dustin Underhood. The Foreman application available at <span className="font-mono">foreman.drunderhood.com</span> is an internal tool we built to manage incoming customer leads, repair orders, and shop operations. It is not a public service — only the shop owner and authorized employees have accounts.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">WHAT INFORMATION WE COLLECT</h2>
            <p className="mb-2">When you interact with us — by texting our shop number, calling and leaving a voicemail, sending us a Facebook or Instagram direct message, emailing the shop, or filling out the contact form on our landing page — we receive and store the following:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Your name, as provided by you or as it appears on your messaging account</li>
              <li>Your phone number (SMS / voice) or email address (email)</li>
              <li>The content of your message, voicemail recording and transcript, or web form submission</li>
              <li>Vehicle information you share with us (year/make/model, VIN if provided, symptoms or repair requests)</li>
              <li>Public profile information from Facebook or Instagram if you message our pages (name, profile photo) — provided via Meta's Graph API</li>
              <li>The timestamp and channel through which you contacted us</li>
            </ul>
            <p className="mt-2">We do <strong>not</strong> collect or store payment card data, driver's license data, social security numbers, or any government IDs.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">HOW WE USE YOUR INFORMATION</h2>
            <p className="mb-2">We use the data above solely to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Respond to your service inquiry</li>
              <li>Schedule, perform, and document the repair you requested</li>
              <li>Send you appointment reminders, repair status updates, or payment confirmations</li>
              <li>Keep an internal service history so we can reference past work on your vehicle next time you come in</li>
            </ul>
            <p className="mt-2">We do <strong>not</strong> sell, rent, lease, or otherwise commercially share your personal information with anyone.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">WHO WE SHARE DATA WITH</h2>
            <p className="mb-2">We only share data with the following service providers, and only the minimum necessary for them to deliver their service to us:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Twilio</strong> — to receive and send SMS and voice calls on our shop number, and to store voicemail recordings</li>
              <li><strong>Meta (Facebook / Instagram)</strong> — to receive direct messages sent to our pages</li>
              <li><strong>Microsoft (Outlook 365)</strong> — to read emails sent to our shop email address</li>
              <li><strong>OpenAI / Anthropic / Google</strong> — for the AI assistant that summarizes incoming messages, transcribes voicemails, and helps draft replies. Only the content of your message is sent; no name or phone number is included in the AI prompt.</li>
              <li><strong>MongoDB Atlas</strong> — the encrypted database where this data is stored</li>
              <li><strong>Emergent</strong> — the hosting platform that runs the Foreman application</li>
            </ul>
            <p className="mt-2">These providers act as data processors under our direction. They are contractually bound to use the data only to provide their service. None of them have permission to use your data for their own marketing or analytics.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">HOW LONG WE KEEP IT</h2>
            <p>We retain leads, message history, voicemails, and repair records for as long as we maintain a customer relationship with you, plus a reasonable period after (typically 7 years for tax and warranty purposes). You can ask us to delete your information at any time and we'll do it within 30 days, except where we're legally required to keep it (e.g., tax records).</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">YOUR RIGHTS</h2>
            <p className="mb-2">You can at any time ask us to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Tell you what data we have about you</li>
              <li>Correct anything that's wrong</li>
              <li>Delete your data entirely (subject to legal retention requirements)</li>
              <li>Stop messaging you (for SMS, reply STOP; for email, ask us to unsubscribe; for FB/IG, block our page)</li>
            </ul>
            <p className="mt-2">Email <a href="mailto:doc@drunderhood.com" className="text-amber2 underline" data-testid="privacy-email-link">doc@drunderhood.com</a> with the subject "PRIVACY REQUEST" and we'll respond within 14 days.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">SECURITY</h2>
            <p>Data is transmitted over HTTPS and stored in MongoDB Atlas with encryption at rest. Access to the Foreman application requires a password. We are a small operation — only authorized shop employees have access. We are not a multi-tenant SaaS; your data is not visible to any other business.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">CHILDREN</h2>
            <p>Foreman is not directed to children under 13. If you are under 13, do not message or call our shop. We don't knowingly collect data from minors. If you're a parent and discover your child contacted us, email <a href="mailto:doc@drunderhood.com" className="text-amber2 underline">doc@drunderhood.com</a> and we'll delete the record.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">CHANGES TO THIS POLICY</h2>
            <p>If we change this policy, we'll update the "Last Updated" date at the top. Material changes will be posted on our Facebook page at least 14 days before they take effect.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">CONTACT</h2>
            <p>Dr. Underhood Automotive Specialist<br/>
            Fort Smith, Arkansas<br/>
            Email: <a href="mailto:doc@drunderhood.com" className="text-amber2 underline">doc@drunderhood.com</a><br/>
            Phone: (479) 434-5852</p>
          </section>
        </div>

        <div className="mt-12 pt-6 border-t border-line text-center text-xs text-ink-3 uppercase tracking-widest">
          <Link to="/terms" data-testid="privacy-to-terms" className="hover:text-amber2 mr-4">TERMS OF SERVICE</Link>
          <Link to="/" className="hover:text-amber2">HOME</Link>
        </div>
      </div>
    </div>
  );
}
