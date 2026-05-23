import { useEffect, useRef } from "react";

/**
 * Keep the screen on while a condition is true.
 * Uses the Screen Wake Lock API (https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).
 *
 * Supported on:
 *   - Chrome/Edge (desktop + Android) since 84
 *   - Safari iOS 16.4+
 *   - Firefox 126+
 *
 * Browser auto-releases the lock when the tab is hidden — we re-acquire on visibility return.
 *
 * Usage:
 *   useWakeLock(true);                // always on
 *   useWakeLock(callActive);          // only while a call is active
 */
export function useWakeLock(active) {
  const lockRef = useRef(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      // Silently skip on browsers without support
      return;
    }

    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          lock.release().catch(() => {});
          return;
        }
        lockRef.current = lock;
        lock.addEventListener("release", () => { lockRef.current = null; });
      } catch (e) {
        // Failures are non-fatal (permissions, fullscreen-only, etc.)
      }
    };

    const onVis = () => {
      if (document.visibilityState === "visible" && !lockRef.current) acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      if (lockRef.current) {
        lockRef.current.release().catch(() => {});
        lockRef.current = null;
      }
    };
  }, [active]);
}
