// Web stand-in for the photo library picker the pages call (launchImageLibraryAsync / ImagePickerAsset).
// Embedded: the host picks (pickPhoto{max:1}, docs/EMBED.md). Otherwise: the browser's file picker.
// Both go through the same contract: image/jpeg|png|heic|heif|avif, ≤ 20 MB, original bytes and ratio, width/height known.
import { ask } from "../runtime/host";
import { PHOTO_MAX_BYTES, PHOTO_TOO_BIG_TEXT, photoProblem, readPickReply } from "../runtime/protocol";

export const PICK_FAILED_TEXT = "选图没有成功";
import { isEmbedded } from "../runtime/session";
import { rememberBlob } from "../lib/pickedBlobs";

export type ImagePickerAsset = {
  uri: string; width: number; height: number; mimeType?: string; fileName?: string | null; fileSize?: number;
  /** the bytes (uploads use this; the uri is an object URL for <img>) */
  file?: Blob; type?: "image"; assetId?: string | null;
};
export type ImagePickerResult = { canceled: true; assets: null } | { canceled: false; assets: ImagePickerAsset[] };
export type ImagePickerOptions = { allowsMultipleSelection?: boolean; selectionLimit?: number; [k: string]: unknown };


const ACCEPT = "image/jpeg,image/png,image/heic,image/heif,image/avif,.heic,.heif,.avif";

function mimeOf(f: { type: string; name: string }): string {
  const t = (f.type || "").toLowerCase();
  if (t) return t === "image/jpg" ? "image/jpeg" : t;
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", avif: "image/avif" } as Record<string, string>)[ext] ?? "";
}

/** Width/height without decoding when the browser cannot (HEIC/HEIF in most browsers): the ISO-BMFF 'ispe' box. */
export function ispeSize(buf: ArrayBuffer): { width: number; height: number } | null {
  const b = new Uint8Array(buf), n = Math.min(b.length, 1 << 20);
  let best: { width: number; height: number } | null = null;
  for (let i = 4; i + 16 <= n; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {   // "ispe"
      const dv = new DataView(buf, i + 8, 8);
      const w = dv.getUint32(0), h = dv.getUint32(4);
      if (w > 0 && h > 0 && (!best || w * h > best.width * best.height)) best = { width: w, height: h };
    }
  }
  return best;
}

async function sizeOf(blob: Blob, url: string): Promise<{ width: number; height: number } | null> {
  const viaImg = await new Promise<{ width: number; height: number } | null>((res) => {
    const img = new Image();
    img.onload = () => res(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => res(null);
    img.src = url;
  });
  if (viaImg) return viaImg;
  try { return ispeSize(await blob.slice(0, 1 << 20).arrayBuffer()); } catch { return null; }
}

async function asset(blob: Blob, name: string, mime: string, known?: { width: number; height: number }): Promise<ImagePickerAsset> {
  const uri = URL.createObjectURL(blob);
  const size = known && known.width > 0 && known.height > 0 ? known : await sizeOf(blob, uri);
  const bad = photoProblem({ mime, size: blob.size, width: size?.width, height: size?.height });
  if (bad) { URL.revokeObjectURL(uri); throw new Error(bad); }
  rememberBlob(uri, blob);
  return { uri, width: size!.width, height: size!.height, mimeType: mime, fileName: name, fileSize: blob.size, file: blob, type: "image", assetId: null };
}

/** Bytes a base64 text decodes to, without decoding it. */
export function base64Bytes(b64: string): number {
  const t = b64.replace(/\s/g, "");
  const pad = t.endsWith("==") ? 2 : t.endsWith("=") ? 1 : 0;
  return Math.floor((t.length * 3) / 4) - pad;
}

/** data (base64, or a data: URL) → Blob; refuses before decoding when it is over the limit. */
export function dataToBlob(data: string, mime: string): Blob {
  const b64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  if (base64Bytes(b64) > PHOTO_MAX_BYTES) throw new Error(PHOTO_TOO_BIG_TEXT);
  let bin: string;
  try { bin = atob(b64); } catch { throw new Error(PICK_FAILED_TEXT); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: mime });
}

/** The host may hand back an address instead of bytes: https:, blob: or data: only, read at most 20 MB. */
export async function fetchLimited(url: string, mime: string, max = PHOTO_MAX_BYTES): Promise<Blob> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(PICK_FAILED_TEXT); }
  if (u.protocol === "data:") return dataToBlob(url, mime);
  if (u.protocol !== "https:" && u.protocol !== "blob:") throw new Error(PICK_FAILED_TEXT);
  const ac = new AbortController();
  let r: Response;
  try { r = await fetch(url, { signal: ac.signal }); } catch { throw new Error(PICK_FAILED_TEXT); }
  if (!r.ok) throw new Error(PICK_FAILED_TEXT);
  const declared = Number(r.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) { ac.abort(); throw new Error(PHOTO_TOO_BIG_TEXT); }
  const reader = r.body?.getReader();
  if (!reader) {
    const b = await r.blob().catch(() => { throw new Error(PICK_FAILED_TEXT); });
    if (b.size > max) throw new Error(PHOTO_TOO_BIG_TEXT);
    return b;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { throw new Error(PICK_FAILED_TEXT); }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > max) { ac.abort(); reader.cancel().catch(() => {}); throw new Error(PHOTO_TOO_BIG_TEXT); }
    parts.push(chunk.value);
  }
  return new Blob(parts as BlobPart[], { type: mime });
}

export async function viaHost(): Promise<ImagePickerResult> {
  const r = readPickReply(await ask("pickPhoto", { max: 1 }));
  if ("cancelled" in r) return { canceled: true, assets: null };
  if ("error" in r) throw new Error(r.error === "timeout" ? "宿主没有回应选图" : r.error);
  const f = r.file;
  const blob = f.data ? dataToBlob(f.data, f.mime) : await fetchLimited(f.url!, f.mime);
  if (!blob.size) throw new Error(PICK_FAILED_TEXT);
  return { canceled: false, assets: [await asset(blob.type ? blob : new Blob([blob], { type: f.mime }), f.name, f.mime, { width: f.width, height: f.height })] };
}

function viaBrowser(multiple: boolean, limit: number): Promise<ImagePickerResult> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.multiple = multiple;
    input.style.display = "none";
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; window.removeEventListener("focus", onFocus); input.remove(); fn(); };
    // the picker closed without a file: some browsers fire "cancel", others only give the window its focus back
    const onFocus = () => setTimeout(() => { if (!input.files?.length) done(() => resolve({ canceled: true, assets: null })); }, 600);
    input.addEventListener("cancel", () => done(() => resolve({ canceled: true, assets: null })));
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []).slice(0, Math.max(1, limit));
      if (!files.length) { done(() => resolve({ canceled: true, assets: null })); return; }
      settled = true; window.removeEventListener("focus", onFocus); input.remove();
      try {
        const out: ImagePickerAsset[] = [];
        for (const f of files) out.push(await asset(f, f.name, mimeOf(f)));
        resolve({ canceled: false, assets: out });
      } catch (e) { reject(e); }
    });
    document.body.appendChild(input);
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

export async function launchImageLibraryAsync(o: ImagePickerOptions = {}): Promise<ImagePickerResult> {
  if (isEmbedded()) return viaHost();
  return viaBrowser(!!o.allowsMultipleSelection, o.selectionLimit ?? 1);
}

export async function requestMediaLibraryPermissionsAsync() { return { granted: true, status: "granted" as const, canAskAgain: true, expires: "never" as const }; }
export const MediaTypeOptions = { Images: "images" } as const;
