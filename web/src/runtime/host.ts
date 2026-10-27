// The page's end of the embedding channel (docs/EMBED.md). One instance per page.
// iframe: postMessage to window.parent with the registered origin (never "*"); incoming events are accepted only
//         when event.origin is the registered origin AND event.source is window.parent.
// native: page → host through the bridge the web view exposes; host → page by calling window.ephemera.receive(msg).
import { useSyncExternalStore } from "react";
import {
  asInit, asInsets, asNavigate, type Insets, type Message, makeMessage, type NavigateTarget, parseIncoming,
  PICK_TIMEOUT_MS, type PageToHost, type Reply, REQUEST_TIMEOUT_MS, trustedIframeEvent,
} from "./protocol";
import { connect, getSession, logout, setTheme } from "./session";

type Win = typeof globalThis & {
  webkit?: { messageHandlers?: Record<string, { postMessage: (m: unknown) => void }> };
  ReactNativeWebView?: { postMessage: (m: string) => void };
  EphemeraHost?: { postMessage: (m: string) => void };
  ephemera?: { receive: (m: unknown) => void };
  addEventListener: Window["addEventListener"]; removeEventListener: Window["removeEventListener"];
  parent: Window;
};

// ── small stores the pages read ───────────────────────────────────────────────────
function store<T>(initial: T) {
  let v = initial;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set: (n: T) => { if (n === v) return; v = n; subs.forEach((f) => f()); },
    sub: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export const hostSafeArea = store<Insets | null>(null);
export const hostKeyboard = store<number | null>(null);      // null = host does not report; use visualViewport
export const lifecycle = store<"active" | "background">("active");
const resumeSubs = new Set<() => void>();
/** Called when the page comes back to the foreground: reload and fetch the events missed meanwhile. */
export function onResume(f: () => void) { resumeSubs.add(f); return () => { resumeSubs.delete(f); }; }
/** Reload what the pages show (after the demo clock moved, or when the page comes back). */
export function refreshAll() { resumeSubs.forEach((f) => { try { f(); } catch (e) { console.warn("[ephemera] refresh", e); } }); }
export function useLifecycle() { return useSyncExternalStore(lifecycle.sub, lifecycle.get, lifecycle.get); }
export function useHostSafeArea() { return useSyncExternalStore(hostSafeArea.sub, hostSafeArea.get, hostSafeArea.get); }
export function useHostKeyboard() { return useSyncExternalStore(hostKeyboard.sub, hostKeyboard.get, hostKeyboard.get); }
export function setLifecycle(s: "active" | "background") {
  const was = lifecycle.get();
  lifecycle.set(s);
  if (s === "active" && was === "background") refreshAll();
}

// ── navigation hand-off (the router lives in the root layout) ─────────────────────
type NavHandler = (t: NavigateTarget) => void;
let navHandler: NavHandler | null = null;
const navQueue: NavigateTarget[] = [];
/** The root layout registers here once it can route; queued targets (arrived before init) are replayed in order. */
export function setNavigateHandler(h: NavHandler | null) {
  navHandler = h;
  if (h && getSession().phase === "ready") flushNav();
}
function flushNav() {
  while (navHandler && navQueue.length) navHandler(navQueue.shift()!);
}
export function queueNavigate(t: NavigateTarget) {
  navQueue.push(t);
  if (getSession().phase === "ready") flushNav();
}

// ── channel ───────────────────────────────────────────────────────────────────────
type Pending = { resolve: (r: Reply) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
let installed: (() => void) | null = null;
let w: Win = globalThis as Win;

function post(m: Message | Reply) {
  const s = getSession();
  if (s.mode === "iframe") {
    if (!s.hostOrigin) return;                       // nobody registered: say nothing
    w.parent.postMessage(m, s.hostOrigin);
  } else if (s.mode === "native") {
    const json = JSON.stringify(m);
    if (w.webkit?.messageHandlers?.ephemera) w.webkit.messageHandlers.ephemera.postMessage(json);
    else if (w.ReactNativeWebView) w.ReactNativeWebView.postMessage(json);
    else if (w.EphemeraHost) w.EphemeraHost.postMessage(json);
  }
}

/** Fire-and-forget page → host message. */
export function tell(type: PageToHost, payload?: unknown) {
  if (getSession().mode !== "iframe" && getSession().mode !== "native") return;
  post(makeMessage(type, payload));
}

/** Request page → host; resolves with the reply, or {ok:false, error:"timeout"} after the deadline. */
export function ask(type: PageToHost, payload?: unknown, timeoutMs = type === "pickPhoto" ? PICK_TIMEOUT_MS : REQUEST_TIMEOUT_MS): Promise<Reply> {
  const m = makeMessage(type, payload);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(m.id); resolve({ id: m.id, ok: false, error: "timeout" }); }, timeoutMs);
    pending.set(m.id, { resolve, timer });
    post(m);
  });
}

function reply(id: string, ok: boolean, extra: { result?: unknown; error?: unknown } = {}) {
  post({ id, ok, ...extra });
}

async function handle(msg: Message) {
  const s = getSession();
  switch (msg.type) {
    case "init": {
      const init = asInit(msg.payload);
      if (!init) { reply(msg.id, false, { error: "init 需要 apiBase 与 credential" }); return; }
      if (init.safeArea) hostSafeArea.set(init.safeArea);
      if (init.theme) setTheme(init.theme);
      try {
        await connect(init.apiBase, init.credential, false);
        reply(msg.id, true, { result: { v: 1 } });
        if (init.route) navQueue.unshift(init.route);
        flushNav();
      } catch (e) {
        reply(msg.id, false, { error: (e as Error).message || "init failed" });
      }
      return;
    }
    case "navigate": {
      const t = asNavigate(msg.payload);
      if (!t) { reply(msg.id, false, { error: "navigate 需要 page" }); return; }
      reply(msg.id, true);
      queueNavigate(t);
      return;
    }
    case "lifecycle": {
      const st = (msg.payload as { state?: unknown } | undefined)?.state;
      if (st !== "active" && st !== "background") { reply(msg.id, false, { error: "state 要是 active 或 background" }); return; }
      reply(msg.id, true);
      setLifecycle(st);
      return;
    }
    case "safeArea": {
      const ins = asInsets(msg.payload);
      if (!ins) { reply(msg.id, false, { error: "safeArea 要有 top/right/bottom/left" }); return; }
      hostSafeArea.set(ins);
      reply(msg.id, true);
      return;
    }
    case "keyboard": {
      const h = (msg.payload as { height?: unknown } | undefined)?.height;
      hostKeyboard.set(typeof h === "number" && Number.isFinite(h) && h > 0 ? h : 0);
      reply(msg.id, true);
      return;
    }
    case "logout": {
      logout();
      reply(msg.id, true);
      return;
    }
  }
  void s;
}

export function receive(data: unknown) {
  const p = parseIncoming(data);
  if (!p) return;
  if (p.kind === "reply") {
    const q = pending.get(p.reply.id);
    if (q) { clearTimeout(q.timer); pending.delete(p.reply.id); q.resolve(p.reply); }
    return;
  }
  void handle(p.msg);
}

/** Wire the channel for the current mode and announce ready{v}. Returns an uninstall function (tests). */
export function installHost(win: Win = globalThis as Win): () => void {
  if (installed) installed();
  w = win;
  const s = getSession();
  const off: Array<() => void> = [];
  if (s.mode === "iframe") {
    const onMsg = (ev: MessageEvent) => { if (trustedIframeEvent(ev, getSession().hostOrigin, w.parent)) receive(ev.data); };
    w.addEventListener("message", onMsg as EventListener);
    off.push(() => w.removeEventListener("message", onMsg as EventListener));
  } else if (s.mode === "native") {
    w.ephemera = { receive };
    off.push(() => { delete w.ephemera; });
  }
  if (s.mode === "iframe" || s.mode === "native") post(makeMessage("ready", { v: 1 }));
  installed = () => { off.forEach((f) => f()); installed = null; };
  return installed;
}

/** Only for tests. */
export function __resetHost() {
  if (installed) installed();
  pending.forEach((p) => clearTimeout(p.timer));
  pending.clear();
  navQueue.length = 0;
  navHandler = null;
  hostSafeArea.set(null); hostKeyboard.set(null); lifecycle.set("active");
  resumeSubs.clear();
}
