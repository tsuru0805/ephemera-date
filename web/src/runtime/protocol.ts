// Embedding protocol v1 (docs/EMBED.md): message shapes, validation and the page side of the channel.
// Pure helpers live here so they can be unit-tested without a browser.

export const PROTOCOL_VERSION = 1;
export const REQUEST_TIMEOUT_MS = 10_000;
/** Picking a photo waits for a person, not a machine: the host has this long to answer pickPhoto. */
export const PICK_TIMEOUT_MS = 5 * 60_000;

export type HostToPage = "init" | "navigate" | "lifecycle" | "safeArea" | "keyboard" | "logout";
export type PageToHost = "ready" | "close" | "pickPhoto" | "event" | "openExternal";

export type Message = { v: 1; id: string; type: string; payload?: unknown };
export type Reply = { id: string; ok: boolean; result?: unknown; error?: unknown; cancelled?: boolean; file?: unknown };

export type Insets = { top: number; right: number; bottom: number; left: number };
export type NavigateTarget = { page: string; planId?: number | null; stopId?: number | null; key?: string | null };
export type InitPayload = {
  apiBase: string;
  credential: string;
  theme?: string | null;
  fonts?: unknown;
  route?: NavigateTarget | null;
  safeArea?: Insets | null;
};

const HOST_TYPES: ReadonlySet<string> = new Set<HostToPage>(["init", "navigate", "lifecycle", "safeArea", "keyboard", "logout"]);

/** Parse whatever arrived on the channel: a JSON string (native bridges) or a structured-clone object (iframe). */
export function parseIncoming(data: unknown): { kind: "message"; msg: Message } | { kind: "reply"; reply: Reply } | null {
  let d = data;
  if (typeof d === "string") {
    try { d = JSON.parse(d); } catch { return null; }
  }
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.type === "string") {
    if (o.v !== PROTOCOL_VERSION || !HOST_TYPES.has(o.type)) return null;
    return { kind: "message", msg: { v: 1, id: o.id, type: o.type, payload: o.payload } };
  }
  if (typeof o.ok === "boolean") return { kind: "reply", reply: o as unknown as Reply };
  return null;
}

/** iframe: the event must come from the registered host origin AND from our direct parent window. */
export function trustedIframeEvent(ev: { origin: string; source: unknown }, hostOrigin: string | null, parent: unknown): boolean {
  return !!hostOrigin && ev.origin === hostOrigin && ev.source === parent && ev.source != null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
export function asInsets(v: unknown): Insets | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { top: num(o.top), right: num(o.right), bottom: num(o.bottom), left: num(o.left) };
}

export function asInit(v: unknown): InitPayload | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.apiBase !== "string" || typeof o.credential !== "string") return null;
  let base = o.apiBase.trim().replace(/\/+$/, "");
  if (base && !/^https?:\/\//i.test(base)) return null;
  if (!base) base = "";
  return {
    apiBase: base, credential: o.credential,
    theme: typeof o.theme === "string" ? o.theme : null,
    fonts: o.fonts,
    route: asNavigate(o.route),
    safeArea: asInsets(o.safeArea),
  };
}

export function asNavigate(v: unknown): NavigateTarget | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.page !== "string" || !o.page) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : null);
  return { page: o.page, planId: n(o.planId), stopId: n(o.stopId), key: typeof o.key === "string" ? o.key : null };
}

let seq = 0;
export function newId(prefix = "p"): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function makeMessage(type: PageToHost, payload?: unknown): Message {
  return { v: 1, id: newId(), type, payload: payload ?? {} };
}

// ── photo contract (same rules as the engine: header-checked there, mime/size checked here) ─────────────
export const PHOTO_MIMES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/avif"] as const;
export const PHOTO_MAX_BYTES = 20 * 1024 * 1024;
export const PHOTO_TOO_BIG_TEXT = "这张照片超过 20MB，换一张小一点的";
export const PHOTO_BAD_TYPE_TEXT = "只能放 JPEG、PNG、HEIC、HEIF 或 AVIF 照片";
export const PHOTO_NO_SIZE_TEXT = "这张照片读不出宽高，换一张试试";

export type PickedFile = { name: string; mime: string; size: number; width: number; height: number; data?: string; url?: string };

/** Validate one file against the contract. → null = fine, otherwise the sentence to show. */
export function photoProblem(f: { mime?: string | null; size?: number | null; width?: number | null; height?: number | null }): string | null {
  const mime = (f.mime || "").toLowerCase();
  if (!(PHOTO_MIMES as readonly string[]).includes(mime)) return PHOTO_BAD_TYPE_TEXT;
  if (typeof f.size === "number" && f.size > PHOTO_MAX_BYTES) return PHOTO_TOO_BIG_TEXT;
  if (!(typeof f.width === "number" && f.width > 0 && typeof f.height === "number" && f.height > 0)) return PHOTO_NO_SIZE_TEXT;
  return null;
}

/** The host's pickPhoto answer → picked file / cancelled / error. Accepts {result:{file}} or a top-level file. */
export function readPickReply(r: Reply): { file: PickedFile } | { cancelled: true } | { error: string } {
  if (!r.ok) {
    if (r.cancelled || (r.result && typeof r.result === "object" && (r.result as { cancelled?: boolean }).cancelled)) return { cancelled: true };
    return { error: typeof r.error === "string" && r.error ? r.error : "选图没有成功" };
  }
  const res = (r.result && typeof r.result === "object" ? r.result : {}) as Record<string, unknown>;
  const f = (r.file ?? res.file ?? null) as Record<string, unknown> | null;
  if (!f || typeof f !== "object") return { error: "选图没有成功" };
  const file: PickedFile = {
    name: typeof f.name === "string" && f.name ? f.name : "photo",
    mime: typeof f.mime === "string" ? f.mime.toLowerCase() : "",
    size: typeof f.size === "number" ? f.size : NaN,
    width: typeof f.width === "number" ? f.width : NaN,
    height: typeof f.height === "number" ? f.height : NaN,
    data: typeof f.data === "string" ? f.data : undefined,
    url: typeof f.url === "string" ? f.url : undefined,
  };
  if (!file.data && !file.url) return { error: "选图没有成功" };
  const bad = photoProblem(file);
  return bad ? { error: bad } : { file };
}
