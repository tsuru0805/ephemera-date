// Who is talking to the page and with which credential.
//   standalone — opened directly in a browser: own login page, credential in localStorage (can sign out).
//   iframe     — inside a host page: credential only from the host's init message, kept in memory.
//   native     — inside a host app's web view (WKWebView / Android WebView / react-native-webview): same, over a bridge.
//   demo       — ?demo=1 or the demo build: fake data and a fast-forward clock, no backend, no credential.
import { useSyncExternalStore } from "react";

export type Mode = "standalone" | "iframe" | "native" | "demo";
export type Phase = "booting" | "login" | "waiting-init" | "ready" | "failed";

export type EngineConfig = {
  title: string; tz: string; her: string; him: string; together_since: string | null;
  /** English forms of address for the English lines of the papers (Dear …, TO : …, signatures); default Her / Him */
  her_en?: string | null; him_en?: string | null;
  write_request_available: boolean; ai_channels: string[]; web_push: boolean; vapid_public_key: string | null;
  places: boolean; map: boolean; art: boolean;
  place_service: { available: boolean; provider: string | null; fallback: string | null; supports_autocomplete: boolean; attribution: string | null; store_policy?: string; error?: string };
  map_status: { available: boolean; ready: boolean; reason: string | null; text: string | null };
};

export const DEFAULT_CONFIG: EngineConfig = {
  title: "Ephemera", tz: "UTC", her: "她", him: "他", together_since: null,
  write_request_available: false, ai_channels: [], web_push: false, vapid_public_key: null,
  places: false, map: false, art: false,
  place_service: { available: false, provider: null, fallback: null, supports_autocomplete: false, attribution: null },
  map_status: { available: false, ready: false, reason: null, text: null },
};

type State = {
  mode: Mode; phase: Phase; apiBase: string; credential: string | null; config: EngineConfig;
  error: string | null; hostOrigin: string | null; theme: string | null;
};

const LS_BASE = "ephemera.apiBase";
const LS_TOKEN = "ephemera.credential";

let state: State = {
  mode: "standalone", phase: "booting", apiBase: "", credential: null, config: DEFAULT_CONFIG,
  error: null, hostOrigin: null, theme: null,
};
const subs = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export const getSession = () => state;
export const subscribeSession = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function useSession(): State {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

export const isEmbedded = () => state.mode === "iframe" || state.mode === "native";
export const isDemo = () => state.mode === "demo";

/** Names used in the papers (configurable on the engine: EPHEMERA_HER / EPHEMERA_HIM). */
export const herName = () => state.config.her || "她";
export const himName = () => state.config.him || "他";
/** English forms of address (EPHEMERA_HER_EN / EPHEMERA_HIM_EN → /api/config her_en / him_en; missing → Her / Him).
 *  English lines and English typesetting use these; Chinese sentences keep herName() / himName(). */
export const EN_DEFAULT = { her: "Her", him: "Him" } as const;
const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
export const herEn = () => clean(state.config.her_en) ?? EN_DEFAULT.her;
export const himEn = () => clean(state.config.him_en) ?? EN_DEFAULT.him;
export function useNames() {
  const s = useSession();
  return { her: s.config.her || "她", him: s.config.him || "他" };
}

// ── mode detection ────────────────────────────────────────────────────────────────
type Win = typeof globalThis & {
  webkit?: { messageHandlers?: Record<string, { postMessage: (m: unknown) => void }> };
  ReactNativeWebView?: { postMessage: (m: string) => void };
  EphemeraHost?: { postMessage: (m: string) => void };
  location?: Location; parent?: unknown; top?: unknown;
};

export function detectMode(w: Win = globalThis as Win, demoBuild = process.env.EXPO_PUBLIC_DEMO_BUILD === "1"): Mode {
  const q = new URLSearchParams(w.location?.search ?? "");
  // ?demo=1 sticks for this tab (a reload or a deep link inside the demo stays in the demo); ?demo=0 leaves it
  const ss = (w as { sessionStorage?: Storage }).sessionStorage;
  if (q.get("demo") === "0") ss?.removeItem("ephemera.demoMode");
  if (q.get("demo") === "1") ss?.setItem("ephemera.demoMode", "1");
  if (demoBuild || q.get("demo") === "1" || (q.get("demo") !== "0" && ss?.getItem("ephemera.demoMode") === "1")) return "demo";
  if (q.get("embed") === "native" || w.webkit?.messageHandlers?.ephemera || w.ReactNativeWebView || w.EphemeraHost) return "native";
  if (w.parent && (w.parent as unknown) !== w) return "iframe";
  return "standalone";
}

/** The host origin an iframe page will talk to: ?host=<origin>, checked against ancestorOrigins when the browser has it. */
export function registeredHostOrigin(w: Win = globalThis as Win): string | null {
  const q = new URLSearchParams(w.location?.search ?? "");
  const anc = (w.location as Location & { ancestorOrigins?: DOMStringList } | undefined)?.ancestorOrigins;
  const parentOrigin = anc && anc.length ? anc[0] : null;
  const asked = q.get("host");
  let origin: string | null = null;
  if (asked) {
    try { origin = new URL(asked).origin; } catch { return null; }
    if (parentOrigin && parentOrigin !== origin) return null;      // a page framing us cannot claim another origin
    return origin;
  }
  return parentOrigin;
}

// ── engine config ─────────────────────────────────────────────────────────────────
export function mergeConfig(raw: unknown): EngineConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<EngineConfig>;
  return {
    ...DEFAULT_CONFIG, ...o,
    place_service: { ...DEFAULT_CONFIG.place_service, ...(o.place_service ?? {}) },
    map_status: { ...DEFAULT_CONFIG.map_status, ...(o.map_status ?? {}) },
    her: (typeof o.her === "string" && o.her.trim()) || DEFAULT_CONFIG.her,
    him: (typeof o.him === "string" && o.him.trim()) || DEFAULT_CONFIG.him,
    tz: (typeof o.tz === "string" && o.tz) || DEFAULT_CONFIG.tz,
  };
}

async function fetchConfig(apiBase: string, credential: string | null, fetcher: typeof fetch): Promise<EngineConfig> {
  const r = await fetcher(`${apiBase}/api/config`, { headers: credential ? { Authorization: `Bearer ${credential}` } : {} });
  if (r.status === 401) throw new Error("口令不对");
  if (!r.ok) throw new Error(`后台没有回应（HTTP ${r.status}）`);
  return mergeConfig(await r.json());
}

// ── lifecycle of a session ────────────────────────────────────────────────────────
export function startSession(mode: Mode, w: Win = globalThis as Win) {
  if (mode === "demo") { set({ mode, phase: "ready", apiBase: "", credential: null }); return; }
  if (mode === "standalone") {
    const ls = globalThis.localStorage;
    const base = ls?.getItem(LS_BASE) ?? "";
    const token = ls?.getItem(LS_TOKEN);
    set({ mode, apiBase: base, credential: token ?? null, phase: token ? "booting" : "login" });
    if (token) void connect(base, token, false);
    return;
  }
  set({ mode, phase: "waiting-init", hostOrigin: mode === "iframe" ? registeredHostOrigin(w) : null });
}

/** Standalone login or a host's init. remember=true writes the credential to localStorage (standalone only). */
export async function connect(apiBase: string, credential: string, remember: boolean, fetcher: typeof fetch = fetch): Promise<void> {
  const base = apiBase.trim().replace(/\/+$/, "");
  // another engine or another credential without a logout in between (a host's second init): first drop what was
  // read with the old one (dates, photo addresses, told events), as a logout would
  if (state.credential && (state.credential !== credential || state.apiBase !== base)) forgetSessionData();
  set({ phase: "booting", error: null });
  try {
    const config = await fetchConfig(base, credential, fetcher);
    if (remember && state.mode === "standalone") {
      globalThis.localStorage?.setItem(LS_BASE, base);
      globalThis.localStorage?.setItem(LS_TOKEN, credential);
    }
    set({ apiBase: base, credential, config, phase: "ready" });
  } catch (e) {
    // our own sentences pass; the browser's ("Failed to fetch", JSON errors) become one readable line
    const own = e instanceof Error && /[\u3400-\u9fff]/.test(e.message);
    const msg = own ? (e as Error).message : "连不上后台";
    if (state.mode === "standalone") {
      set({ phase: "login", error: msg, credential: null });
    } else {
      set({ phase: "failed", error: msg, credential: null });
      throw e;
    }
  }
}

const logoutSubs = new Set<() => void>();
/** Called on sign-out / the host's logout: drop what was fetched with the credential (photo addresses …). */
export function onLogout(f: () => void) { logoutSubs.add(f); return () => { logoutSubs.delete(f); }; }

/** Sign out (standalone) or the host's logout (embedded): the credential is gone from memory and storage. */
function forgetSessionData() {
  logoutSubs.forEach((f) => { try { f(); } catch (e) { console.warn("[ephemera] logout", e); } });
}
export function logout() {
  forgetSessionData();
  if (state.mode === "standalone") {
    globalThis.localStorage?.removeItem(LS_TOKEN);
    set({ credential: null, phase: "login", error: null });
  } else if (state.mode !== "demo") {
    set({ credential: null, phase: "waiting-init", error: null });
  }
}

export function setDemoConfig(c: EngineConfig) { set({ config: c }); }
export function setTheme(theme: string | null) { set({ theme }); }

/** Only for tests. */
export function __resetSession() {
  state = { mode: "standalone", phase: "booting", apiBase: "", credential: null, config: DEFAULT_CONFIG, error: null, hostOrigin: null, theme: null };
  subs.forEach((f) => f());
}
export function __setSession(p: Partial<State>) { set(p); }
