// Skia's CanvasKit (WebAssembly, ~8 MB) loads in the background while the sign-in / waiting screen is already up.
// The pages (which draw with Skia) are shown only once it is in; if it cannot load, a readable line instead.
// the loader file itself: the package's web index also pulls modules that build the Skia API at once
import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/module/web/LoadSkiaWeb";
import { useSyncExternalStore } from "react";
import { PAINTED_EVENT } from "./paintHold";

export type SkiaState = { state: "loading" | "ready" | "failed" };
let st: SkiaState = { state: "loading" };
const subs = new Set<() => void>();
const set = (s: SkiaState) => { st = s; subs.forEach((f) => f()); };
export const getSkia = () => st;
export function useSkiaReady(): SkiaState {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, getSkia, getSkia);
}

export const SKIA_TEXT = {
  loading: "正在打开…",
  failed: "页面没能打开：绘图组件没有加载成功。检查一下网络，再刷新试试",
} as const;

/** Where the page's own static files are: the export puts public/ under the base path; the dev server serves it at "/". */
export function staticBase(): string {
  const base = (process.env.EXPO_BASE_URL || "").replace(/\/+$/, "");
  return process.env.NODE_ENV === "production" ? base : "";
}

let started = false;
let warm: () => Promise<void> = async () => {};
/** What to prepare after CanvasKit is in and before the pages are shown (set by index.js: decoded paper, grain). */
export function setSkiaWarmUp(f: () => Promise<void>) { warm = f; }
export function loadSkia(load: typeof LoadSkiaWeb = LoadSkiaWeb): Promise<void> {
  if (started) return Promise.resolve();
  started = true;
  return load({ locateFile: (file: string) => `${staticBase()}/${file}` })
    .then(() => {
      // Draw every canvas in software into a 2D canvas: a page has dozens of paper canvases, and a browser keeps only
      // about 16 WebGL contexts alive (older ones go blank, e.g. the page under the current one).
      // (the 2D context is taken first, so the renderer's later getContext("webgl2") cannot claim the element)
      const ck = (globalThis as { CanvasKit?: { MakeSWCanvasSurface?: (c: HTMLCanvasElement) => unknown; MakeWebGLCanvasSurface?: unknown } }).CanvasKit;
      if (!ck) throw new Error("no CanvasKit");
      if (typeof ck.MakeSWCanvasSurface === "function") {
        const sw = ck.MakeSWCanvasSurface.bind(ck);
        ck.MakeWebGLCanvasSurface = (canvas: HTMLCanvasElement) => {
          canvas.getContext("2d");
          // a canvas not laid out yet is 0×0: give it one pixel; Skia sizes it again on the next layout
          if (!canvas.width || !canvas.height) { canvas.width = Math.max(1, canvas.width); canvas.height = Math.max(1, canvas.height); }
          const surface = sw(canvas) as { flush?: (...a: unknown[]) => unknown } | null;
          // tell the page a frame is in this canvas (pages are shown only once their canvases have drawn: paintHold.tsx)
          if (surface && typeof surface.flush === "function") {
            const flush = surface.flush.bind(surface);
            surface.flush = (...a: unknown[]) => {
              const r = flush(...a);
              canvas.dataset.painted = "1";   // read by the flight layer before it copies a page's piece
              canvas.dispatchEvent(new Event(PAINTED_EVENT, { bubbles: true }));
              return r;
            };
          }
          return surface;
        };
      }
      // what every page draws, made once now (while the loading line is still up) instead of per page
      return warm().catch((e) => { console.warn("[ephemera] drawing warm-up", e); });
    })
    .then(() => set({ state: "ready" }))
    .catch((e) => { console.error("[ephemera] CanvasKit did not load", e); set({ state: "failed" }); });
}

/** only for tests */
export function __setSkia(s: SkiaState["state"]) { started = s !== "loading"; set({ state: s }); }
