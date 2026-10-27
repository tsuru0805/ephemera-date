// Web stand-in for the native keyboard controller the pages use (useReanimatedKeyboardAnimation, KeyboardAwareScrollView).
// Keyboard height: the browser's visualViewport when it shrinks with the keyboard (iOS WKWebView, mobile browsers:
// the browser also pans the page to the field, and visualViewport already accounts for that pan). The host's
// keyboard{height} (docs/EMBED.md) is used only where visualViewport does not shrink (an Android WebView with
// adjustNothing, a host that keeps WebKit from adjusting). The two are never added together.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ScrollView, type ScrollViewProps, View } from "react-native";
import { useSharedValue, withTiming } from "react-native-reanimated";
import { hostKeyboard } from "../runtime/host";

// ── keyboard height (px, ≥ 0) ─────────────────────────────────────────────────────
/** Below this a visualViewport shrink is browser chrome (URL bar), not a keyboard. */
export const VV_KEYBOARD_MIN = 80;
/** How long a host report waits for visualViewport to shrink before the host's number is used (ms). */
export const HOST_WAIT_MS = 600;
/**
 * Which number is the keyboard. Pure, tested.
 * host: the host's report (null = the host does not report); vv: what visualViewport shows covered (0 = not shrunk);
 * vvTracks: has visualViewport been seen to shrink with the keyboard here (null = not known yet).
 */
export function pickKeyboardHeight(host: number | null, vv: number, vvTracks: boolean | null): number {
  if (vv > 0) return vv;                     // visualViewport shrank: it is the truth, the host's number is ignored
  if (host == null || host <= 0) return 0;
  if (vvTracks === false) return host;       // visualViewport does not follow the keyboard in this web view
  return 0;                                  // tracks, or not known yet: wait for visualViewport, never apply both
}

let vvHeight = 0;
let vvTracks: boolean | null = null;
let hostWait: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
let listening = false;
function listen() {
  if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  listening = true;
  const vv = window.visualViewport;
  if (!vv) vvTracks = false;
  const read = () => {
    // pinch zoom also shrinks the visual viewport: not a keyboard, and nothing to learn from
    if (vv && vv.scale > 1.01) { if (vvHeight !== 0) { vvHeight = 0; emit(); } return; }
    // what the keyboard covers of the screen. (Not minus the visual viewport's offset: that offset is iOS scrolling the
    // document to the field for a moment — put back at once below — and counting it made the keyboard read as closed
    // for that moment, which sent the page back down and up again; measured in Mobile Safari.)
    const h = vv ? Math.max(0, Math.round(window.innerHeight - vv.height)) : 0;
    const next = h > VV_KEYBOARD_MIN ? h : 0;
    if (next > 0) vvTracks = true;
    if (next !== vvHeight) { vvHeight = next; emit(); }
  };
  const onHost = () => {
    const h = hostKeyboard.get();
    if (h != null && h > 0 && vvTracks == null && vvHeight === 0 && !hostWait) {
      // first keyboard in this page: give visualViewport the keyboard animation's time to shrink
      hostWait = setTimeout(() => {
        hostWait = null;
        read();
        if (vvTracks == null) vvTracks = vvHeight > 0;
        emit();
      }, HOST_WAIT_MS);
    }
    emit();
  };
  // While the keyboard is up for a field, iOS scrolls the document to the field — the whole page, header and all,
  // went up under the status bar (and stayed there after the keyboard closed, when the host reported the keyboard).
  // Put it back at once; the page's scroll view then brings the field above the keyboard itself, as on the phone.
  // Only then: at any other time the document is left alone (a browser with its own bars scrolls it; putting it back
  // there fought the browser).
  const unpan = () => {
    if (typeof document === "undefined") return;
    const se = document.scrollingElement as HTMLElement | null;
    const scrolled = !!(window.scrollY || window.pageYOffset || (se && se.scrollTop));
    if (!shouldUnpan(scrolled, isTextField(document.activeElement), keyboardHeight())) return;
    window.scrollTo(0, 0);
    if (se) se.scrollTop = 0;
    window.dispatchEvent(new Event(UNPANNED_EVENT));
  };
  // the keyboard's height is read first: the pan arrives with the keyboard (the first scroll may come a moment before
  // visualViewport shrinks; the resize right after it puts the document back)
  window.addEventListener("scroll", () => { read(); unpan(); }, { passive: true });
  vv?.addEventListener("resize", () => { read(); unpan(); });
  vv?.addEventListener("scroll", () => { read(); unpan(); });
  window.addEventListener("resize", read);
  hostKeyboard.sub(onHost);
  read();
}
/** A field that brings up the keyboard (text input, text area, editable text). */
export function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test((el as HTMLInputElement).type || "text");
  return (el as HTMLElement).isContentEditable === true;
}
/** Put the document back at the top only while the keyboard is up for a focused field. Pure, tested. */
export function shouldUnpan(scrolled: boolean, fieldFocused: boolean, keyboard: number): boolean {
  return scrolled && fieldFocused && keyboard > 0;
}
/** The keyboard counts as gone once it has read 0 this long (ms). */
export const KB_CLOSED_MS = 150;
/** Sent on window when the document was put back at the top (the focused field may need lifting again). */
export const UNPANNED_EVENT = "ephemera-unpanned";
/** Current keyboard height (see pickKeyboardHeight). */
export function keyboardHeight(): number {
  return pickKeyboardHeight(hostKeyboard.get(), vvHeight, vvTracks);
}
/** Test hook: forget what was learned about this web view. */
export function __resetKeyboard() {
  if (hostWait) clearTimeout(hostWait);
  hostWait = null; vvHeight = 0; vvTracks = null;
}
function subscribe(f: () => void) { listen(); subs.add(f); return () => { subs.delete(f); }; }
export const __subscribeKeyboard = subscribe;
export function useKeyboardHeight(): number { return useSyncExternalStore(subscribe, keyboardHeight, keyboardHeight); }

/** Same shape as the native hook: height is negative while the keyboard is up (pages translate by it). */
export function useReanimatedKeyboardAnimation() {
  const kb = useKeyboardHeight();
  const height = useSharedValue(-kb);
  const progress = useSharedValue(kb > 0 ? 1 : 0);
  useEffect(() => {
    height.value = withTiming(-kb, { duration: 220 });
    progress.value = withTiming(kb > 0 ? 1 : 0, { duration: 220 });
  }, [kb, height, progress]);
  return { height, progress };
}

export const KeyboardController = { dismiss: async () => { (document.activeElement as HTMLElement | null)?.blur?.(); }, setInputMode: () => {}, setDefaultMode: () => {} };
export function KeyboardProvider({ children }: { children: React.ReactNode }) { return <>{children}</>; }

// ── a ScrollView that keeps the focused field above the keyboard ───────────────────
type Props = ScrollViewProps & { bottomOffset?: number; extraKeyboardSpace?: number; disableScrollOnKeyboardHide?: boolean; enabled?: boolean; children?: React.ReactNode };
type DomScroll = HTMLElement;

function scrollNodeOf(sv: unknown): DomScroll | null {
  const s = sv as { getScrollableNode?: () => DomScroll } | null;
  const n = s?.getScrollableNode?.();
  return n && typeof (n as HTMLElement).getBoundingClientRect === "function" ? n : null;
}

/** How far (screen px) the focused field must move up so its bottom + offset sits above the keyboard. Pure, tested. */
export function liftNeeded(fieldBottom: number, viewportH: number, kb: number, offset: number): number {
  const visibleBottom = viewportH - kb;
  const d = fieldBottom + offset - visibleBottom;
  return d > 0 ? d : 0;
}

/** A drag by the user (not a scroll the page makes itself): moved this far (px) since the finger / pointer went down. */
export const DRAG_DISMISS_PX = 10;
export function isUserDrag(startY: number | null, y: number): boolean {
  return startY != null && Math.abs(y - startY) > DRAG_DISMISS_PX;
}

export const KeyboardAwareScrollView = forwardRef<ScrollView, Props>(function KeyboardAwareScrollView(
  { children, bottomOffset = 0, extraKeyboardSpace = 0, enabled = true, keyboardDismissMode, ...rest }, ref) {
  const inner = useRef<ScrollView>(null);
  useImperativeHandle(ref, () => inner.current as ScrollView);
  const kbNow = useKeyboardHeight();
  const kb = enabled ? kbNow : 0;
  const [scale, setScale] = useState(1);
  const reveal = useCallback(() => {
    const node = scrollNodeOf(inner.current);
    const el = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    if (!node || !el || !node.contains(el)) return;
    const box = node.getBoundingClientRect();
    const s = node.offsetHeight ? box.height / node.offsetHeight : 1;
    if (Math.abs(s - scale) > 0.001) setScale(s);
    const d = liftNeeded(el.getBoundingClientRect().bottom, window.innerHeight, keyboardHeight(), bottomOffset * s);
    if (d > 0) node.scrollTop += d / (s || 1);
  }, [bottomOffset, scale]);
  useEffect(() => { if (kb > 0) requestAnimationFrame(reveal); }, [kb, reveal]);
  useEffect(() => {
    const node = scrollNodeOf(inner.current);
    if (!node) return undefined;
    const onFocus = () => setTimeout(reveal, 60);
    node.addEventListener("focusin", onFocus);
    window.addEventListener(UNPANNED_EVENT, reveal);
    return () => { node.removeEventListener("focusin", onFocus); window.removeEventListener(UNPANNED_EVENT, reveal); };
  }, [reveal]);
  // keyboardDismissMode "on-drag": React Native Web dismisses on *any* scroll, including the one this view makes to
  // bring the focused field above the keyboard (the keyboard would close itself right away). Only a real drag by
  // the user closes it here.
  useEffect(() => {
    const node = scrollNodeOf(inner.current);
    if (!node || !keyboardDismissMode || keyboardDismissMode === "none") return undefined;
    let startY: number | null = null;
    const down = (y: number) => { startY = y; };
    const move = (y: number) => {
      if (!isUserDrag(startY, y)) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && node.contains(el) && /^(INPUT|TEXTAREA)$/.test(el.tagName)) el.blur();
      startY = null;
    };
    const ts = (e: TouchEvent) => down(e.touches[0]?.clientY ?? 0);
    const tm = (e: TouchEvent) => move(e.touches[0]?.clientY ?? 0);
    const pd = (e: PointerEvent) => { if (e.pointerType !== "touch") down(e.clientY); };
    const pm = (e: PointerEvent) => { if (e.pointerType !== "touch" && e.buttons) move(e.clientY); };
    const up = () => { startY = null; };
    node.addEventListener("touchstart", ts, { passive: true });
    node.addEventListener("touchmove", tm, { passive: true });
    node.addEventListener("pointerdown", pd);
    node.addEventListener("pointermove", pm);
    node.addEventListener("touchend", up);
    node.addEventListener("pointerup", up);
    return () => {
      node.removeEventListener("touchstart", ts); node.removeEventListener("touchmove", tm);
      node.removeEventListener("pointerdown", pd); node.removeEventListener("pointermove", pm);
      node.removeEventListener("touchend", up); node.removeEventListener("pointerup", up);
    };
  }, [keyboardDismissMode]);
  // Where this view stood before the keyboard moved it (as react-native-keyboard-controller's
  // scrollBeforeKeyboardMovement in the home app): taken when the keyboard starts to come up, and again when focus moves
  // to another field while it is up; when the keyboard goes down the view goes back there. Both keyboard paths (host
  // height / visualViewport) arrive here as kb.
  const before = useRef<number | null>(null);
  useEffect(() => {
    const node = scrollNodeOf(inner.current);
    if (!node) return undefined;
    const onFocus = () => { if (keyboardHeight() > 0 || before.current == null) before.current = node.scrollTop; };
    node.addEventListener("focusin", onFocus);
    return () => node.removeEventListener("focusin", onFocus);
  }, []);
  const hadKb = useRef(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const node = scrollNodeOf(inner.current);
    if (kb > 0) {
      if (closing.current) { clearTimeout(closing.current); closing.current = null; }   // it was not going down
      if (!hadKb.current && before.current == null && node) before.current = node.scrollTop;   // (no focusin seen)
      hadKb.current = true;
      return undefined;
    }
    if (!hadKb.current) { before.current = null; return undefined; }
    // the keyboard went down (and stays down a moment: not a reading in between): back to where the view stood, and
    // the document at the top (iOS may have scrolled it)
    closing.current = setTimeout(() => {
      closing.current = null;
      hadKb.current = false;
      const n = scrollNodeOf(inner.current);
      if (n && before.current != null) n.scrollTo({ top: before.current, behavior: "smooth" });
      before.current = null;
      if (typeof window === "undefined" || typeof document === "undefined") return;
      window.scrollTo(0, 0);
      const se = document.scrollingElement as HTMLElement | null;
      if (se) se.scrollTop = 0;
    }, KB_CLOSED_MS);
    return undefined;
  }, [kb]);
  useEffect(() => () => { if (closing.current) clearTimeout(closing.current); }, []);
  // room to scroll the last field above the keyboard (keyboard px are screen px; the content may be scaled)
  const pad = kb > 0 ? kb / (scale || 1) + extraKeyboardSpace : 0;
  return (
    <ScrollView ref={inner} {...rest} keyboardDismissMode="none">
      {children}
      <View testID="kb-shim-pad" pointerEvents="none" style={{ height: pad }} />
    </ScrollView>
  );
});

export const KeyboardAvoidingView = View;
export const KeyboardStickyView = View;
