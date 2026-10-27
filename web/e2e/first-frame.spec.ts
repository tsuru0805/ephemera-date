// No half-drawn frames (host run: the home's papers came seconds after its text, the title changed colour when the
// grain landed, the invite card was blank after breaking the seal). The browser is slowed down 4× (as a phone).
// A watcher in the page looks at every frame: no visible canvas may be shown before Skia has drawn into it, and
// once the first page is up it has its grain. No request may go to ".../undefined" (a picture resolved wrongly).
import { test } from "@playwright/test";
import { expect, RUNS, tapLabel } from "./helpers";

test("first frames: nothing shown half-drawn; no request to /undefined", async ({ page, context }, info) => {
  test.skip(info.project.name !== "phone-390", "one size is enough for the timing");
  const undef: string[] = [];
  page.on("request", (r) => { if (/\/undefined(\?|$)/.test(new URL(r.url()).pathname)) undef.push(r.url()); });
  await page.addInitScript(() => {
    const w = window as unknown as { __ff: { frames: number; bad: string[]; firstShown: number; grainAtFirst: boolean | null } };
    w.__ff = { frames: 0, bad: [], firstShown: 0, grainAtFirst: null };
    const t0 = performance.now();
    const shown = (el: Element) => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.opacity === "0" || cs.visibility === "hidden" || cs.display === "none") return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const tick = () => {
      w.__ff.frames++;
      const waiting = !!document.querySelector('[data-testid="skia-wait"]');
      if (!waiting && document.querySelector("canvas")) {
        if (!w.__ff.firstShown) {
          w.__ff.firstShown = Math.round(performance.now() - t0);
          w.__ff.grainAtFirst = Array.from(document.querySelectorAll("div")).some((d) => /^url\("?blob:/.test(getComputedStyle(d).backgroundImage) && shown(d));
        }
        const raw = Array.from(document.querySelectorAll("canvas")).filter((c) => c.dataset.painted !== "1" && shown(c));
        if (raw.length && w.__ff.bad.length < 20) w.__ff.bad.push(`${Math.round(performance.now() - t0)}ms ${location.pathname} ${raw.length} canvas(es): ${raw.map((c) => { const r = c.getBoundingClientRect(); const l = c.closest("[aria-label],[data-testid]"); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} ${l?.getAttribute("aria-label") ?? l?.getAttribute("data-testid") ?? ""}`; }).join(" | ")}`);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const cdp = await context.newCDPSession(page);
  await page.goto("/app/?demo=0");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("/app/?demo=1");
  await page.waitForFunction(() => (window as unknown as { __ff: { firstShown: number } }).__ff.firstShown > 0, undefined, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${RUNS}/shots/first-frame-01-home.png` });
  // the seal, broken: the invite lands drawn
  await page.getByTestId("demo-step").click();
  await page.waitForTimeout(1500);
  await tapLabel(page, "打开邀请", { timeout: 30_000 });
  await page.waitForURL(/ephemera-seal/, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await tapLabel(page, "拆开信封(按住往上拉,或点一下)", { timeout: 30_000 });
  await page.waitForURL(/ephemera-invite/, { timeout: 30_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${RUNS}/shots/first-frame-02-invite.png` });
  // the day page (its own papers, the strip)
  await page.getByTestId("demo-step").click();
  await page.waitForTimeout(800);
  await tapLabel(page, "开始今天", { timeout: 30_000 });
  await page.waitForURL(/ephemera-day/, { timeout: 30_000 });
  await page.waitForTimeout(3000);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const ff = await page.evaluate(() => (window as unknown as { __ff: unknown }).__ff) as { frames: number; bad: string[]; firstShown: number; grainAtFirst: boolean };
  console.log(`[first-frame] first page at ${ff.firstShown} ms (4× slower CPU), ${ff.frames} frames watched`);
  expect(ff.frames).toBeGreaterThan(30);
  expect(ff.grainAtFirst, "the page grain is in the first frame").toBe(true);
  expect(ff.bad, "frames that showed a canvas before it was drawn").toEqual([]);
  expect(undef).toEqual([]);
});
