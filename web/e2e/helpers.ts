import { expect, type Page } from "@playwright/test";

export const RUNS = process.env.EPHEMERA_RUNS ?? "/tmp/ephemera-web-runs";

/** Click the element with this accessibility label (aria-label). */
export async function tapLabel(page: Page, label: string | RegExp, opts: { nth?: number; timeout?: number } = {}) {
  const el = page.getByLabel(label, { exact: typeof label === "string" }).filter({ visible: true }).nth(opts.nth ?? 0);
  await el.waitFor({ state: "visible", timeout: opts.timeout ?? 15_000 });
  await el.click();
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${RUNS}/shots/${test_name(page)}-${name}.png` });
}
function test_name(page: Page) { return (page as unknown as { __name?: string }).__name ?? "run"; }
export function nameRun(page: Page, n: string) { (page as unknown as { __name?: string }).__name = n; }

/** Fonts in, nothing still flying. */
export async function settle(page: Page, ms = 900, fontTimeout = 20_000) {
  try {
    await page.waitForFunction(() => document.fonts.status === "loaded", undefined, { timeout: fontTimeout });
  } catch {
    // say what the fonts were doing, then go on: the step after this one fails (or passes) on what it checks
    const state = await page.evaluate(() => ({
      status: document.fonts.status,
      faces: Array.from(document.fonts).filter((f) => f.status !== "loaded").slice(0, 8).map((f) => `${f.family}:${f.status}`),
    })).catch(() => null);
    console.warn(`[settle] fonts not loaded after ${fontTimeout} ms: ${JSON.stringify(state)}`);
  }
  await page.waitForTimeout(ms);
}

/** Drag with the mouse (pointer events: gesture handler reads these on the web). */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 14) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

export { expect };

/** A real JPEG made in the page (no binary fixture in the repository): w×h, a few colour bands. */
export async function makeJpeg(page: Page, w = 1200, h = 800): Promise<Buffer> {
  const b64 = await page.evaluate(([W, H]) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d")!;
    ["#E9789F", "#3FA1C6", "#F9C4D3", "#FBF6EF"].forEach((col, k) => { g.fillStyle = col; g.fillRect(0, (H / 4) * k, W, H / 4); });
    g.fillStyle = "#3B2F3B"; g.beginPath(); g.arc(W / 2, H / 2, Math.min(W, H) / 5, 0, Math.PI * 2); g.fill();
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  }, [w, h]);
  return Buffer.from(b64, "base64");
}

/** Pick a photo through the browser's file chooser (standalone / demo). */
export async function pickPhotoInBrowser(page: Page, trigger: () => Promise<void>, w = 1200, h = 800) {
  const buf = await makeJpeg(page, w, h);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), trigger()]);
  await chooser.setFiles({ name: "evening.jpg", mimeType: "image/jpeg", buffer: buf });
}

/** Standard deviation of the brightness in a region of the page (css px): a texture blending as it should is a
 *  faint grain (low), one blending with nothing is a grey coarse veil (high). Decoded in the page, no extra package. */
export async function regionStd(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sq = 0;
    for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += y; sq += y * y; n++; }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sq / n - mean * mean));
  }, png);
}

/** Sharpness of a region (css px): mean absolute Laplacian of the brightness — soft (stretched) letters score low. */
export async function regionSharpness(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
    const y = (i: number) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let sum = 0, n = 0;
    for (let r = 1; r < H - 1; r++) for (let q = 1; q < W - 1; q++) {
      const i = r * W + q;
      sum += Math.abs(4 * y(i) - y(i - 1) - y(i + 1) - y(i - W) - y(i + W)); n++;
    }
    return n ? sum / n : 0;
  }, png);
}
