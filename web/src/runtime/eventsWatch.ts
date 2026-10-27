// Embedded only: tell the host about date events it may want to notify the user about (event{kind, planId}),
// once per event. The page reads the her-side event list when it starts, every minute while in front, and when it
// comes back from the background; unread events it has not reported yet go to the host.
// The "already told" record lives in localStorage (a host opens a fresh web view each time, so sessionStorage would
// forget it), one record per engine + credential (a salted hash, never the credential itself); sign-out drops it.
// The first time a record is made, the events already there are taken as known and not reported (no burst of old news).
import { ephemeraApi } from "../lib/ephemeraApi";
import { lifecycle, onResume, tell } from "./host";
import { getSession, isEmbedded, onLogout } from "./session";

const PREFIX = "ephemera.toldEvents.";

/** Short non-reversible fingerprint (FNV-1a, 2×32 bit) of engine address + credential. */
export function fingerprint(apiBase: string, credential: string | null): string {
  const s = `${apiBase}\n${credential ?? ""}`;
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x01000193) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

const SALT_KEY = "ephemera.deviceSalt";
/** A random salt kept on this device (localStorage), so the record key cannot be checked against a guessed credential. */
function deviceSalt(): string {
  try {
    const have = globalThis.localStorage?.getItem(SALT_KEY);
    if (have) return have;
    const b = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(b);
    const salt = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") || String(Math.random()).slice(2);
    globalThis.localStorage?.setItem(SALT_KEY, salt);
    return salt;
  } catch { return ""; }
}

/** Record key: SHA-256(salt, engine address, credential) when the browser has crypto.subtle (secure pages);
 *  otherwise the FNV fingerprint above. */
export async function recordKey(apiBase: string, credential: string | null): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof TextEncoder !== "undefined") {
    try {
      const data = new TextEncoder().encode(`${deviceSalt()}\n${apiBase}\n${credential ?? ""}`);
      const h = new Uint8Array(await subtle.digest("SHA-256", data));
      return PREFIX + Array.from(h.slice(0, 12), (x) => x.toString(16).padStart(2, "0")).join("");
    } catch { /* fall back */ }
  }
  return PREFIX + fingerprint(apiBase, credential);
}
const keyNow = () => { const s = getSession(); return recordKey(s.apiBase, s.credential); };
function read(key: string): Set<number> | null {
  try { const r = globalThis.localStorage?.getItem(key); return r ? new Set(JSON.parse(r) as number[]) : null; } catch { return null; }
}
function write(key: string, told: Set<number>) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify([...told].slice(-500))); } catch { /* full */ }
}

/** One pass: report unread events not reported before. Returns how many were reported. */
export async function reportNewEvents(): Promise<number> {
  if (!isEmbedded() || getSession().phase !== "ready") return 0;
  const key = await keyNow();
  let events;
  try { events = await ephemeraApi.events(); } catch { return 0; }   // the next pass tries again
  const known = read(key);
  if (!known) { write(key, new Set(events.map((e) => e.id))); return 0; }
  let n = 0;
  const changed = new Set<number>();
  for (const ev of events) {
    if (known.has(ev.id)) continue;
    known.add(ev.id);
    changed.add(ev.plan_id);   // something happened to that date (a stop skipped, moved, …): its pages read it again
    if (ev.read_at != null) continue;
    tell("event", { kind: ev.kind, planId: ev.plan_id });
    n += 1;
  }
  write(key, known);
  changed.forEach(emitPlanEvent);
  return n;
}
function emitPlanEvent(id: number) { planSubs.forEach((f) => { try { f(id); } catch (e) { console.warn("[ephemera] plan event", e); } }); }
/** only for tests */
export const __emitPlanEvent = emitPlanEvent;

const planSubs = new Set<(planId: number) => void>();
/** Called with a date's id when a new event about it has come in (the pages showing that date read it again). */
export function onPlanEvent(f: (planId: number) => void) { planSubs.add(f); return () => { planSubs.delete(f); }; }

/** Sign-out / logout: forget the record for that engine + credential. */
export function forgetToldEvents(): Promise<void> {
  // the key is computed before the session drops the credential (logout calls this first)
  return keyNow().then((k) => { try { globalThis.localStorage?.removeItem(k); } catch { /* ignore */ } });
}
onLogout(() => { void forgetToldEvents(); });

let timer: ReturnType<typeof setInterval> | null = null;
export function startEventsWatch(everyMs = 60_000) {
  if (timer) return;
  void reportNewEvents();
  timer = setInterval(() => { if (lifecycle.get() === "active") void reportNewEvents(); }, everyMs);
  onResume(() => { void reportNewEvents(); });
}
export function __resetEventsWatch() { if (timer) clearInterval(timer); timer = null; }
