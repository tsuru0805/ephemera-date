// A card flying to a bigger place (a kept date's stamp on the home → the box's lid): the copy of where it lands, laid
// out at its own size, takes over early (by 0.3 of the flight), so the letters are not a stretched copy for long;
// and the landing frames are as sharp as the page after it (no soft text left).
import { test } from "@playwright/test";
import { expect, RUNS, regionSharpness, settle, tapLabel } from "./helpers";

test("flight: the sharp copy takes over early; text near the landing is as sharp as after it", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough");
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1200);
  // through the whole date: the home then shows it as a small stamp under Past Collections
  for (let k = 0; k < 12 && (await page.getByTestId("demo-step").textContent())?.includes("快进"); k++) { await page.getByTestId("demo-step").click(); await page.waitForTimeout(250); }
  await page.goto("/app/ephemera");
  await settle(page, 1500);
  // watch every frame of the flight: when the landing copy is fully in, the starting copy must be gone
  await page.evaluate(() => {
    type FL = { full: number; fromAtFull: number; sxFull: number; sxLast: number; done: boolean };
    const w = window as unknown as { __fl: FL };
    w.__fl = { full: 0, fromAtFull: -1, sxFull: 0, sxLast: 0, done: false };
    const op = (e: Element | null) => (e ? parseFloat(getComputedStyle(e).opacity) : -1);
    // the card's size on the way, by area (it can grow in height and shrink a little in width)
    const sx = (e: Element) => { const m = new DOMMatrix(getComputedStyle(e).transform); return Math.abs(m.a * m.d - m.b * m.c); };
    let seen = false;
    const tick = () => {
      const from = document.querySelector('[data-testid="flight-from"]'), to = document.querySelector('[data-testid="flight-to"]');
      if (from) { seen = true; w.__fl.sxLast = sx(from); }
      if (to && op(to) >= 0.99 && !w.__fl.full) { w.__fl.full = 1; w.__fl.fromAtFull = op(from); w.__fl.sxFull = from ? sx(from) : 0; }
      if (seen && !from) { w.__fl.done = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await tapLabel(page, "An Evening in Bloom");               // the stamp flies up into the box's lid (×8 in area)
  await page.waitForURL(/ephemera-box/);
  // a frame near the landing (the flight runs ~0.8 s), then the page after it
  await page.waitForTimeout(560);
  const clip = { x: 30, y: 140, width: 330, height: 120 };    // the lid's script name
  const near = await regionSharpness(page, clip);
  await page.screenshot({ path: `${RUNS}/flight-near-landing.png` });
  await settle(page, 1500);
  const after = await regionSharpness(page, clip);
  await page.screenshot({ path: `${RUNS}/flight-landed.png` });
  const fl = await page.evaluate(() => (window as unknown as { __fl: { full: number; fromAtFull: number; sxFull: number; sxLast: number; done: boolean } }).__fl);
  // how far along the way (by the card's growth) the landing copy was fully in: early = little stretched text
  const along = (fl.sxFull - 1) / (fl.sxLast - 1);
  console.log(`[flight] area ×${fl.sxFull.toFixed(2)} of ×${fl.sxLast.toFixed(2)}: landing copy fully in at ${(along * 100).toFixed(0)} % of the growth (start copy then ${fl.fromAtFull}); sharpness near ${near.toFixed(2)} after ${after.toFixed(2)}`);
  expect(fl.full).toBe(1);
  expect(fl.fromAtFull, "the starting copy is gone once the landing copy is fully in").toBeLessThan(0.05);
  // (measured: 22 % now; 45 % with the old crossfade, 0.2 → 0.55)
  expect(along, "the landing copy takes over early").toBeLessThan(0.33);
  expect(near / after, "near the landing the text is about as sharp as after it").toBeGreaterThan(0.75);
});
