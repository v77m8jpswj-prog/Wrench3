import React from "react";
import { Link } from "react-router-dom";
import { Wrench, ArrowLeft } from "lucide-react";

/* eslint-disable react/no-unescaped-entities */
/* Terms of Service — paired with Privacy. Required by Facebook/Meta for App
   Review and Google Play. Single-shop internal tool. Plain English. */

export default function Terms() {
  const lastUpdated = "March 1, 2026";

  return (
    <div className="min-h-screen bg-bg-1 text-ink">
      <div className="max-w-3xl mx-auto px-4 md:px-8 py-8">
        <Link to="/" data-testid="terms-back-home" className="inline-flex items-center gap-2 text-ink-3 hover:text-rust text-sm uppercase tracking-widest mb-4">
          <ArrowLeft size={14}/>BACK TO FOREMAN
        </Link>

        <div className="flex items-center gap-3 mb-6 pb-4 border-b border-line">
          <Wrench size={28} className="text-rust" />
          <div>
            <h1 className="font-head text-2xl md:text-3xl uppercase tracking-widest text-white">TERMS OF SERVICE</h1>
            <p className="text-xs uppercase tracking-widest text-ink-3 mt-1">DR. UNDERHOOD AUTOMOTIVE · LAST UPDATED {lastUpdated}</p>
          </div>
        </div>

        <div className="space-y-6 text-ink-2 text-sm leading-relaxed" data-testid="terms-content">

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">WHAT FOREMAN IS</h2>
            <p>Foreman is the internal operations and lead-management tool used by Dr. Underhood Automotive Specialist, a sole-proprietor automotive repair shop in Fort Smith, Arkansas. It is not a public-facing service. Customers do not have accounts. The only people who log in are the shop owner and authorized employees.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">WHEN YOU CONTACT US</h2>
            <p>By texting our shop number, calling us, messaging our Facebook or Instagram page, emailing our shop, or filling out the contact form at foreman.drunderhood.com, you are reaching out to us about automotive service. Your message will be received and reviewed by Doc, the shop owner. We may respond by the same channel you contacted us on, or by phone.</p>
            <p className="mt-2">We treat your inquiry as confidential, but it is processed through commercial communication providers (Twilio, Meta, Microsoft) — see our <Link to="/privacy" className="text-amber2 underline" data-testid="terms-to-privacy">Privacy Policy</Link> for the details.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">ACCEPTABLE USE</h2>
            <p>Please don't:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>Send us spam, marketing pitches, or solicitations</li>
              <li>Send threatening, harassing, or illegal content</li>
              <li>Attempt to access or interfere with the Foreman application without authorization</li>
              <li>Scrape, copy, or republish our shop's website content without permission</li>
            </ul>
            <p className="mt-2">We may block, mute, or ignore messages from anyone who does the above. We reserve the right to report unlawful activity to authorities.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">QUOTES AND ESTIMATES</h2>
            <p>Any cost estimates we provide over text, DM, email, phone, or in person are non-binding until a written repair order is signed at the shop. Final cost depends on actual parts and labor required after inspection. We will always confirm with you before exceeding an approved estimate.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">NO WARRANTY OF AI ASSISTANT</h2>
            <p>Our internal tool uses an AI assistant ("Wrench") to help triage incoming messages and surface relevant repair history. Wrench's suggestions are not professional advice and are reviewed by Doc before being acted upon. Any answer you receive from us is the shop owner's judgment, not the AI's.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">LIMITATION OF LIABILITY</h2>
            <p>To the maximum extent allowed by Arkansas law, Dr. Underhood Automotive is not liable for indirect, incidental, or consequential damages arising from your use of our messaging channels or website. Our total liability for any single matter is limited to the amount you paid us for the related repair (or $0 if no repair was done).</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">GOVERNING LAW</h2>
            <p>These terms are governed by the laws of the State of Arkansas, USA, without regard to conflict-of-law principles. Any dispute that can't be settled directly with us will be resolved in the state or federal courts located in Sebastian County, Arkansas.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">CHANGES</h2>
            <p>If we update these terms, we'll change the "Last Updated" date at the top. Material changes will be announced on our Facebook page at least 14 days in advance.</p>
          </section>

          <section>
            <h2 className="font-head text-lg uppercase tracking-widest text-amber2 mb-2">CONTACT</h2>
            <p>Dr. Underhood Automotive Specialist<br/>
            Fort Smith, Arkansas<br/>
            Email: <a href="mailto:doc@drunderhood.com" className="text-amber2 underline" data-testid="terms-email-link">doc@drunderhood.com</a><br/>
            Phone: (479) 434-5852</p>
          </section>
        </div>

        <div className="mt-12 pt-6 border-t border-line text-center text-xs text-ink-3 uppercase tracking-widest">
          <Link to="/privacy" className="hover:text-amber2 mr-4">PRIVACY POLICY</Link>
          <Link to="/" className="hover:text-amber2">HOME</Link>
        </div>
      </div>
    </div>
  );
}
