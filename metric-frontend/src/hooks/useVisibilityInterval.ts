import { useEffect, useRef } from "react";

/**
 * Run `fn` on a `setInterval` of `ms` while the document is visible.
 *  - Ticks fire every `ms`, but a tick is SKIPPED when `document.hidden` is true
 *    (so we don't poll a backgrounded tab).
 *  - Pauses entirely when `enabled` is false (default true).
 *  - Fires once immediately when the tab regains visibility, so data snaps to
 *    truth on refocus instead of waiting up to `ms`.
 *  - The interval is recreated only when `ms` or `enabled` change; the latest
 *    `fn` is held in a ref so re-renders don't reset the timer.
 *  - SSR-safe: document access is guarded.
 */
export function useVisibilityInterval(
  fn: () => void,
  ms: number,
  enabled = true,
): void {
  const fnRef = useRef(fn);
  // Keep the ref pointed at the latest fn. Done in an effect (not during render)
  // so it doesn't trip the react-hooks "no refs during render" rule.
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fnRef.current();
    }, ms);

    // Snap to fresh data the instant the tab is refocused.
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) fnRef.current();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [ms, enabled]);
}
