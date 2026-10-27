// The page's size for laying out the pages: the layout viewport (the browser window), not what the keyboard leaves.
// React Native Web's window dimensions follow window.visualViewport, which shrinks when the on-screen keyboard opens
// (iOS): the pages, sized from it, lost the part under the keyboard — the backfill page was cut at the keyboard's top
// edge and, once WebKit panned the page up to the field, showed a blank lower half. On the phone the window does not
// change size with the keyboard; the pages make room for it themselves (KeyboardAwareScrollView).
import { useSyncExternalStore } from "react";

type Size = { width: number; height: number };
let snap: Size | null = null;
function read(): Size | null {
  if (typeof document === "undefined" || !document.documentElement || typeof window === "undefined") return null;
  const d = document.documentElement;
  const width = d.clientWidth || window.innerWidth || 0, height = d.clientHeight || window.innerHeight || 0;
  if (!width || !height) return null;
  if (!snap || snap.width !== width || snap.height !== height) snap = { width, height };
  return snap;
}
const subs = new Set<() => void>();
let listening = false;
function subscribe(f: () => void) {
  if (!listening && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    listening = true;
    // window resize = the layout viewport changed (rotation, browser bars, a host that resizes the web view);
    // visualViewport resize (the keyboard, pinch zoom) is deliberately not listened to
    window.addEventListener("resize", () => { const before = snap; read(); if (snap !== before) subs.forEach((g) => g()); });
  }
  subs.add(f);
  return () => { subs.delete(f); };
}
/** The layout viewport's size, or null where there is no browser (page tests): then use React Native's window. */
export function useLayoutViewport(): Size | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
