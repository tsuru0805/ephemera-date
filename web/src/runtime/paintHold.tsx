// A page is shown only once what it draws is drawn: on the web the paper (Skia canvases) and the tinted pictures
// arrive a few frames after the text, and showing the text first gave a half-made page (white letters on nothing,
// pictures as flat colour blocks). A page (Stage) keeps its content hidden until every canvas and picture in it has
// drawn once, and until the page's first data read is back (a page shown before its data is a half page too) —
// at most HOLD_MAX_MS, then it is shown anyway (never a page that stays empty).
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";

export const HOLD_MAX_MS = 2500;
/** Event a canvas element receives each time Skia has put a frame into it (sent by skiaReady.ts). */
export const PAINTED_EVENT = "ephemera-painted";

type Scope = { add: () => number; done: (id: number) => void };
const Ctx = createContext<Scope | null>(null);
export const PaintHoldProvider = Ctx.Provider;

/** Keeps the page hidden while `active` and until the returned release() is called (or the piece unmounts). */
export function usePaintHold(active = true): () => void {
  const scope = useContext(Ctx);
  const id = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!scope || !active) return undefined;
    const k = scope.add();
    id.current = k;
    return () => { scope.done(k); id.current = null; };
  }, [scope, active]);
  return useCallback(() => { if (scope && id.current != null) { scope.done(id.current); id.current = null; } }, [scope]);
}

// ── first data reads in flight (store.ts: a page's first read, while it has nothing cached to show) ──────────
let loads = 0;
const loadSubs = new Set<() => void>();
/** A page's first read starts (call it while the page mounts: a layout effect, before the page arms); call the
 *  returned function when the read is back (or failed). */
export function beginFirstLoad(): () => void {
  loads += 1;
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    clearTimeout(t);
    loads -= 1;
    if (loads === 0) loadSubs.forEach((f) => f());
  };
  const t = setTimeout(end, HOLD_MAX_MS);
  return end;
}
export function firstLoadsInFlight(): number { return loads; }

/** Only in a browser (the page tests render without one: shown at once there). */
export const canHold = () => typeof document !== "undefined" && typeof window !== "undefined" && typeof window.addEventListener === "function" && typeof requestAnimationFrame === "function";
type ScopeOpts = { maxMs?: number; enabled?: boolean; ready?: boolean; page?: boolean };
/**
 * The holding side: pieces register while they mount; `shown` turns true (once, never back) when none is pending after
 * the first layout passes (and, for a page, when no first data read is out), or after maxMs.
 * page: a whole page (Stage) — also waits for the first reads and lifts the loading line of the visit's first page.
 */
export function usePaintScope({ maxMs = HOLD_MAX_MS, enabled = canHold(), ready = true, page = true }: ScopeOpts = {}): { scope: Scope; shown: boolean } {
  const [shown, setShown] = useState(!enabled);
  const st = useRef({ next: 1, pending: new Set<number>(), armed: false, shown: !enabled });
  const reveal = useCallback(() => {
    if (st.current.shown) return;
    st.current.shown = true;
    setShown(true);
    if (page) markFirstPageShown();
  }, [page]);
  const check = useCallback(() => { if (st.current.armed && st.current.pending.size === 0 && (!page || loads === 0)) reveal(); }, [reveal, page]);
  const scope = useMemo<Scope>(() => ({
    add: () => { const k = st.current.next++; if (!st.current.shown) st.current.pending.add(k); return k; },
    done: (k) => { if (st.current.pending.delete(k)) check(); },
  }), [check]);
  useEffect(() => {
    if (st.current.shown) { if (page) markFirstPageShown(); return undefined; }
    const t = setTimeout(reveal, maxMs);
    return () => clearTimeout(t);
  }, [reveal, maxMs, page]);
  useEffect(() => {
    // not before the page lays out its content (the Stage waits for the fonts): nothing has registered yet
    if (st.current.shown || !ready) return undefined;
    // pieces that mount after a layout pass (a canvas waits for its box) register in the next frames: wait two.
    // The same after the data is back: what it brings (papers, pictures) mounts and registers first.
    let r1 = 0, r2 = 0;
    const arm = () => {
      st.current.armed = false;
      cancelAnimationFrame(r1); cancelAnimationFrame(r2);
      r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => { st.current.armed = true; check(); }); });
    };
    arm();
    if (page) loadSubs.add(arm);
    return () => { loadSubs.delete(arm); cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [check, ready, page]);
  return { scope, shown };
}

/**
 * One piece of a page (a ticket, a card, a strip — every flight spot): hidden until what it draws is drawn, so a
 * piece that appears on a page already shown (the invitation that just arrived) does not show its letters over an
 * empty canvas for a frame. Inside a page not shown yet it simply counts as one more thing that page waits for.
 * While held it carries data-paint-held (the flight layer waits for that to go before copying the piece).
 */
export function PaintPiece({ children, bg }: { children?: React.ReactNode; bg?: string }) {
  const { scope, shown } = usePaintScope({ page: false });
  usePaintHold(!shown);
  const held = shown ? null : ({ opacity: 0 } as const);
  // bg: the piece's ground sits on this layer, under its children. Every React Native Web view is its own stacking
  // context, so a soft-light texture inside blends only with what is in this same layer: with the ground one layer
  // up it blended with nothing (a grey veil over the backfill page).
  return (
    <Ctx.Provider value={scope}>
      <View style={[StyleSheet.absoluteFill, bg ? { backgroundColor: bg } : null, held]} pointerEvents={shown ? "box-none" : "none"}
        {...(shown ? {} : { dataSet: { paintHeld: "1" } })}>{children}</View>
    </Ctx.Provider>
  );
}

// ── the first page of this visit: the loading line stays up until it is shown ─────────────────
let firstShown = false;
const subs = new Set<() => void>();
function markFirstPageShown() { if (!firstShown) { firstShown = true; subs.forEach((f) => f()); } }
export function useFirstPageShown(): boolean {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => firstShown, () => firstShown);
}
/** only for tests */
export function __resetFirstPage() { firstShown = false; loads = 0; }
