// Made once after CanvasKit is in, before the first page is shown (skiaReady.ts runs it):
// - the paper texture (a CSS background of every paper) decoded by the browser, and the seal ribbon decoded by Skia,
//   so a page's papers and the seal have them in their first frame;
// - the page grain (StageTexture): the same Skia fractal noise as before, drawn once into a seamless tile that the
//   pages repeat as a CSS background. Before, every page drew it full-screen in software (about 1 s on a phone, per
//   page), and the page's colours changed when it landed (the title went from deep rose to its final lighter tone).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PAPER_TEX: unknown = require("../../assets/images/ephemera/paper_tex.jpg");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SEAL_BOW: unknown = require("../../assets/images/ephemera/seal_bow.png");
import { assetUri, preloadImage, realSkia } from "../shims/skia";
import { GRAIN, GRAIN_TILE, setGrainTile } from "./grain";

async function makeGrain(): Promise<void> {
  const { Skia } = realSkia();
  const pd = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const px = Math.max(1, Math.round(GRAIN_TILE * pd));
  const surface = Skia.Surface.Make(px, px);
  if (!surface) throw new Error("no surface for the grain");
  const c = surface.getCanvas();
  c.scale(px / GRAIN_TILE, px / GRAIN_TILE);
  const rect = Skia.XYWHRect(0, 0, GRAIN_TILE, GRAIN_TILE);
  const white = Skia.Paint();
  white.setColor(Skia.Color("white"));
  c.drawRect(rect, white);
  const noise = Skia.Paint();
  noise.setShader(Skia.Shader.MakeFractalNoise(GRAIN.freq, GRAIN.freq, GRAIN.octaves, GRAIN.seed, GRAIN_TILE, GRAIN_TILE));
  noise.setAlphaf(GRAIN.noiseOpacity);
  c.drawRect(rect, noise);
  surface.flush();
  const bytes = surface.makeImageSnapshot().encodeToBytes();
  surface.dispose?.();
  if (!bytes || !bytes.length) throw new Error("grain did not encode");
  setGrainTile(URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })));
}

const kept: HTMLImageElement[] = [];
async function decodeInBrowser(src: unknown): Promise<void> {
  const uri = assetUri(src);
  if (!uri || typeof Image === "undefined") return;
  const img = new Image();
  img.src = uri;
  await img.decode();
  kept.push(img);   // held, so the decoded picture stays in the browser's cache
}
export async function warmUpDrawing(): Promise<void> {
  const jobs: Array<Promise<void>> = [decodeInBrowser(PAPER_TEX), preloadImage(SEAL_BOW), Promise.resolve().then(makeGrain)];
  const r = await Promise.allSettled(jobs);
  r.forEach((x) => { if (x.status === "rejected") console.warn("[ephemera] warm-up", x.reason); });
}
