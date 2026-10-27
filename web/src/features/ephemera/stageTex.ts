// The page texture (StageTexture: grain multiplied in, a lamp's light in soft-light), shared by the pages and the
// flight layer: a piece in flight is drawn over with the same texture at its place on the screen, so it looks the same
// in the air as on the page (it does not go dark in flight and pale on landing). As the home app's stageTex.ts.
import { GRAIN_TILE } from "../../runtime/grain";

/** The page grain: multiplied in at this opacity. */
export const STAGE_GRAIN_OPACITY = 0.32;
/** The grain layer's CSS (a tile drawn once: runtime/grain.ts). */
export function stageGrainStyle(tile: string, opacity = STAGE_GRAIN_OPACITY): Record<string, string | number> {
  return { opacity, mixBlendMode: "multiply", backgroundImage: `url(${tile})`, backgroundSize: `${GRAIN_TILE}px ${GRAIN_TILE}px`, backgroundRepeat: "repeat" };
}

/** The two soft-light gradients of StageTexture as one CSS background (pure, tested): Skia's RadialGradient
 *  (centre, radius, stops at fractions of the radius, clamped beyond) is CSS radial-gradient(circle R at x y, …)
 *  with the stops in px; Skia drew the second rect over the first, CSS lists the top layer first. */
export function stageLightCss(w: number, h: number, sh: string): string {
  const [r, g, b] = sh.split(",").map((x) => Number(x.trim()));
  const lamp = { x: w * 0.18, y: h * 0.08, R: w * 1.1 };
  const edge = { x: w / 2, y: h * 0.45, R: Math.max(w, h) * 0.8 };
  const px = (v: number) => `${Math.round(v * 100) / 100}px`;
  return [
    `radial-gradient(circle ${px(edge.R)} at ${px(edge.x)} ${px(edge.y)}, rgba(0,0,0,0) ${px(edge.R * 0.6)}, rgba(${r},${g},${b},0.14) ${px(edge.R)})`,
    `radial-gradient(circle ${px(lamp.R)} at ${px(lamp.x)} ${px(lamp.y)}, rgba(255,250,240,0.38) 0px, rgba(255,250,240,0) ${px(lamp.R * 0.55)})`,
  ].join(", ");
}

// ── where the texture is on the screen (the flight layer draws its ghosts over with the same) ────────────────────
type Reg = { el: HTMLElement; sh: string };
const regs: Reg[] = [];
/** A page's texture box (StageTexture's sizing layer) and its skin colour; returns the unregister. */
export function registerStageTex(el: HTMLElement | null, sh: string): () => void {
  if (!el || typeof el.getBoundingClientRect !== "function") return () => {};
  const r = { el, sh };
  regs.push(r);
  return () => { const k = regs.indexOf(r); if (k >= 0) regs.splice(k, 1); };
}
/** The texture's box on the screen now (px) and the skin colour; null where no page shows one. */
export function stageTexNow(): { x: number; y: number; w: number; h: number; sh: string } | null {
  for (let k = regs.length - 1; k >= 0; k--) {
    const r = regs[k];
    if (!r.el.isConnected) continue;
    const b = r.el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) return { x: b.left, y: b.top, w: b.width, h: b.height, sh: r.sh };
  }
  return null;
}
/** Is this element under a page's texture (in the stage's content), not in an overlay (a pop, the bar)? */
export function underStageTex(el: HTMLElement | null): boolean {
  return !!el && typeof el.closest === "function" && !!el.closest('[data-testid="stage-content"]');
}
