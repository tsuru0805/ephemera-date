// Opened on its own: the engine's web push (/api/push/subscribe, needs VAPID on the engine). The service worker
// shows the notification; tapping it opens or focuses the page and goes where the event points (navigate).
import { useEffect, useState } from "react";
import { asNavigate } from "./protocol";
import { queueNavigate } from "./host";
import { getSession } from "./session";
import { staticBase } from "./skiaReady";

const BASE = (process.env.EXPO_BASE_URL || "").replace(/\/+$/, "");   // the page's scope
export const PUSH_TEXT = { on: "开启约会提醒", done: "约会提醒已开启", failed: "没开成" } as const;

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** On start (standalone): register the worker, follow taps on notifications, and a ?nav= the worker opened us with. */
export function startWebPush() {
  if (typeof window === "undefined") return;
  const nav = new URLSearchParams(window.location.search).get("nav");
  if (nav) { try { const t = asNavigate(JSON.parse(nav)); if (t) queueNavigate(t); } catch { /* not ours */ } }
  if (!pushSupported()) return;
  navigator.serviceWorker.register(`${staticBase()}/sw.js`, { scope: `${BASE}/` }).catch((e) => console.warn("[ephemera] service worker", e));
  navigator.serviceWorker.addEventListener("message", (e) => {
    const t = asNavigate((e.data as { ephemeraNavigate?: unknown } | null)?.ephemeraNavigate);
    if (t) queueNavigate(t);
  });
}

function keyBytes(b64: string): Uint8Array {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function subscribePush(): Promise<void> {
  const { config, apiBase, credential } = getSession();
  if (!config.vapid_public_key) throw new Error("后台没有配置网页推送");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("浏览器没有允许通知");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.vapid_public_key) as BufferSource });
  const r = await fetch(`${apiBase}/api/push/subscribe`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => null) as { detail?: { text?: string } | string } | null;
    throw new Error(pushErrorText(r.status, d?.detail));
  }
}

/** The engine's sentence when it is a readable Chinese one (string or {text}); otherwise a line by status. */
export function pushErrorText(status: number, detail: unknown): string {
  const t = typeof detail === "string" ? detail : detail && typeof detail === "object" ? (detail as { text?: unknown }).text : null;
  return typeof t === "string" && /[\u3400-\u9fff]/.test(t) ? t : `后台出错了（HTTP ${status}），等一下再试`;
}

/** Me page: whether to offer the switch, and its state. */
export function usePushState() {
  const [state, setState] = useState<"off" | "on" | "busy" | "unsupported">("unsupported");
  const [err, setErr] = useState<string | null>(null);
  const { mode, config } = getSession();
  useEffect(() => {
    if (mode !== "standalone" || !config.web_push || !config.vapid_public_key || !pushSupported()) { setState("unsupported"); return; }
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => setState(s && Notification.permission === "granted" ? "on" : "off")).catch(() => setState("off"));
  }, [mode, config.web_push, config.vapid_public_key]);
  const turnOn = async () => {
    setState("busy"); setErr(null);
    try { await subscribePush(); setState("on"); } catch (e) {
      const m = (e as Error).message;
      setErr(/[\u3400-\u9fff]/.test(m) ? m : "连不上后台"); setState("off");
    }
  };
  return { state, err, turnOn };
}
