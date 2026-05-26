import React, { useEffect, useRef, useState } from "react";
import { X, ExternalLink, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

// Listen for window.dispatchEvent(new CustomEvent("wrench-lightbox", { detail: { url, alt } }))
// to open. Closes on ESC, backdrop tap, or X. Pinch/wheel zoom + drag pan.
export default function ImageLightbox() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);
  const dragRef = useRef({ active: false, sx: 0, sy: 0, otx: 0, oty: 0 });
  const pinchRef = useRef({ active: false, startDist: 0, startScale: 1 });

  useEffect(() => {
    const onOpen = (e) => {
      const d = e?.detail || {};
      if (!d.url) return;
      setUrl(d.url);
      setAlt(d.alt || "image");
      setScale(1); setTx(0); setTy(0);
      setLoaded(false); setErr(false);
      setOpen(true);
    };
    window.addEventListener("wrench-lightbox", onOpen);
    return () => window.removeEventListener("wrench-lightbox", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "+" || e.key === "=") zoom(0.2);
      if (e.key === "-" || e.key === "_") zoom(-0.2);
      if (e.key === "0") reset();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const zoom = (delta) => setScale(s => Math.max(1, Math.min(8, +(s + delta).toFixed(2))));
  const reset = () => { setScale(1); setTx(0); setTy(0); };

  const onWheel = (e) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 0.25 : -0.25);
  };

  // touch handling — single-finger pan, two-finger pinch
  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = { active: true, startDist: Math.hypot(dx, dy), startScale: scale };
    } else if (e.touches.length === 1 && scale > 1) {
      dragRef.current = { active: true, sx: e.touches[0].clientX, sy: e.touches[0].clientY, otx: tx, oty: ty };
    }
  };
  const onTouchMove = (e) => {
    if (pinchRef.current.active && e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const ns = Math.max(1, Math.min(8, pinchRef.current.startScale * (dist / pinchRef.current.startDist)));
      setScale(+ns.toFixed(2));
    } else if (dragRef.current.active && e.touches.length === 1) {
      e.preventDefault();
      const ndx = e.touches[0].clientX - dragRef.current.sx;
      const ndy = e.touches[0].clientY - dragRef.current.sy;
      setTx(dragRef.current.otx + ndx);
      setTy(dragRef.current.oty + ndy);
    }
  };
  const onTouchEnd = () => {
    pinchRef.current.active = false;
    dragRef.current.active = false;
  };

  // mouse drag when zoomed
  const onMouseDown = (e) => {
    if (scale <= 1) return;
    dragRef.current = { active: true, sx: e.clientX, sy: e.clientY, otx: tx, oty: ty };
  };
  const onMouseMove = (e) => {
    if (!dragRef.current.active) return;
    setTx(dragRef.current.otx + (e.clientX - dragRef.current.sx));
    setTy(dragRef.current.oty + (e.clientY - dragRef.current.sy));
  };
  const onMouseUp = () => { dragRef.current.active = false; };

  if (!open) return null;

  return (
    <div
      data-testid="image-lightbox"
      className="fixed inset-0 z-[9999] bg-black/95 flex flex-col"
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-line bg-black/80 select-none">
        <div className="text-[10px] uppercase tracking-[0.25em] text-ink-3 truncate max-w-[60%]">
          {alt}{natural.w ? ` — ${natural.w}×${natural.h}` : ""}
        </div>
        <div className="flex items-center gap-1">
          <button
            data-testid="lightbox-zoom-out"
            onClick={() => zoom(-0.25)}
            className="px-2 py-1.5 border border-line hover:bg-bg-2 text-ink-2"
            title="Zoom out"
          ><ZoomOut size={14} /></button>
          <button
            data-testid="lightbox-zoom-in"
            onClick={() => zoom(0.25)}
            className="px-2 py-1.5 border border-line hover:bg-bg-2 text-ink-2"
            title="Zoom in"
          ><ZoomIn size={14} /></button>
          <button
            data-testid="lightbox-reset"
            onClick={reset}
            className="px-2 py-1.5 border border-line hover:bg-bg-2 text-ink-2"
            title="Reset"
          ><RotateCcw size={14} /></button>
          <a
            data-testid="lightbox-newtab"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-1.5 border border-line hover:bg-bg-2 text-ink-2"
            title="Open original"
          ><ExternalLink size={14} /></a>
          <button
            data-testid="lightbox-close"
            onClick={() => setOpen(false)}
            className="px-2 py-1.5 border border-line hover:bg-rust hover:text-black text-ink-2"
            title="Close (Esc)"
          ><X size={14} /></button>
        </div>
      </div>

      {/* Image area */}
      <div
        className="flex-1 overflow-hidden flex items-center justify-center touch-none"
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={(e) => { if (e.target === e.currentTarget && scale === 1) setOpen(false); }}
      >
        {!err ? (
          <img
            data-testid="lightbox-img"
            src={url}
            alt={alt}
            draggable={false}
            onLoad={(e) => { setLoaded(true); setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight }); }}
            onError={() => setErr(true)}
            onMouseDown={onMouseDown}
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              transformOrigin: "center center",
              transition: dragRef.current.active || pinchRef.current.active ? "none" : "transform 80ms ease-out",
              cursor: scale > 1 ? "grab" : "zoom-in",
              maxWidth: "98vw",
              maxHeight: "calc(100vh - 56px)",
              imageRendering: "auto",
            }}
            onDoubleClick={() => (scale === 1 ? setScale(2.5) : reset())}
          />
        ) : (
          <div className="text-center text-ink-2 p-8">
            <div className="text-rust uppercase tracking-widest text-xs mb-2">Image failed to load</div>
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-amber2 underline break-all">{url}</a>
          </div>
        )}
        {!loaded && !err && (
          <div className="absolute text-ink-3 text-xs uppercase tracking-widest">Loading…</div>
        )}
      </div>

      {/* Bottom hint */}
      <div className="px-3 py-1.5 border-t border-line bg-black/80 text-[9px] uppercase tracking-[0.25em] text-ink-3 text-center select-none">
        TAP BACKGROUND OR ESC TO CLOSE · DOUBLE-TAP TO ZOOM · TWO FINGERS TO PINCH · DRAG WHEN ZOOMED
      </div>
    </div>
  );
}

// Helper: trigger the lightbox from anywhere
export const openLightbox = (url, alt = "image") => {
  window.dispatchEvent(new CustomEvent("wrench-lightbox", { detail: { url, alt } }));
};
