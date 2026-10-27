// Script titles that have to fit, as in the home app (design-base 3f2defc): the box lid (a long name in one line folds
// at the middle space into two below 0.7; two lines shrink to 0.5 at most) and the envelope on the seal page (every letter
// whole: sides, heads, tails). Against a real engine: the AI
// writes dates with these names. Pictures go to $EPHEMERA_RUNS/box-lid-*.png and seal-title-*.png.
import { test, type Page } from "@playwright/test";
import { ai, clearActive, close, HER_TOKEN, writeAndSend } from "./engine";
import { expect, RUNS, settle } from "./helpers";

test.skip(!process.env.EPHEMERA_ENGINE, "needs a running engine (EPHEMERA_ENGINE)");

/** Each line: where its letters' ink falls inside the element's box (one-line text clips at its box). */
async function linesFit(page: Page, ids: string[]) {
  return page.evaluate((testIds) => testIds.map((id) => {
    const el = Array.from(document.querySelectorAll(`[data-testid="${id}"]`)).find((e) => (e as HTMLElement).offsetParent) as HTMLElement | undefined;
    if (!el) return null;
    const cs = getComputedStyle(el);
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const t = el.textContent ?? "";
    const m = c.measureText(t);
    const pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight), pt = parseFloat(cs.paddingTop);
    const cw = el.clientWidth - pl - pr;
    const start = pl + (cs.textAlign === "center" ? (cw - m.width) / 2 : 0);
    const lh = parseFloat(cs.lineHeight) || m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    const baseline = pt + (lh - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
    const r = (v: number) => Math.round(v * 10) / 10;
    return { id, text: t, px: parseFloat(cs.fontSize), fits: m.width <= cw + 0.5,
      inkLeft: r(start - m.actualBoundingBoxLeft), inkRight: r(start + m.actualBoundingBoxRight), width: el.clientWidth,
      inkTop: r(baseline - m.actualBoundingBoxAscent), inkBottom: r(baseline + m.actualBoundingBoxDescent), height: el.clientHeight };
  }), ids);
}
type Line = { id: string; text: string; px: number; fits: boolean; inkLeft: number; inkRight: number; width: number; inkTop: number; inkBottom: number; height: number };
function whole(l: Line) {
  expect(l.inkLeft, `${l.text}: left`).toBeGreaterThanOrEqual(0);
  expect(l.inkRight, `${l.text}: right`).toBeLessThanOrEqual(l.width);
  expect(l.inkTop, `${l.text}: top`).toBeGreaterThanOrEqual(0);
  expect(l.inkBottom, `${l.text}: bottom`).toBeLessThanOrEqual(l.height);
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");

test("box lid: a long name folds into two lines and shrinks only so far", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "the pictures are 390 wide");
  const m = await ai();
  await clearActive(m);
  const names = ["Riverside Snack Crawl", "A Quiet\nRiver Walk", "Wonderland Wandering Way"];
  const ids: number[] = [];
  for (const n of names) { const id = await writeAndSend(m, n); await close(m, id); ids.push(id); }
  await page.goto("/app/?demo=0");
  await page.getByTestId("login-token").fill(HER_TOKEN);
  await page.getByTestId("login-enter").click();
  await settle(page, 1200);
  for (let k = 0; k < names.length; k++) {
    await page.goto(`/app/ephemera-box?id=${ids[k]}`);
    await settle(page, 1500);
    await page.screenshot({ path: `${RUNS}/box-lid-${slug(names[k])}.png` });
    const fit = (await linesFit(page, ["lid-t1", "lid-t2"])).filter(Boolean) as Line[];
    console.log(`[lid] ${JSON.stringify(fit)}`);
    // one line while it fits at 0.7 of 118; else folded at the space nearest the middle; two lines: each down to 0.5
    expect(fit.length, names[k]).toBe(2);
    for (const l of fit) expect(l.px, `${l.text} not below 0.5 of 118`).toBeGreaterThanOrEqual(118 * 0.5 - 0.5);
    expect(fit.map((l) => l.text).join(" ")).toBe(names[k].replace("\n", " "));
    // whole at ≥ 0.5; past that "…" (her rule). "Wandering Way" would need ≈ 0.42 in the narrower second slot
    for (const l of fit) {
      if (k < 2) expect(l.fits, `${l.text}: whole, no "…"`).toBe(true);
      if (l.fits) whole(l);
    }
  }
  await clearActive(m);
});

test("seal page: the name on the envelope shows every letter whole (sides, top, bottom)", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "the pictures are 390 wide");
  const m = await ai();
  await clearActive(m);
  const names = ["EMPTY STOMACH\nFULL MOON", "Riverside Snack Crawl", "Wonderland Wandering Way"];
  const ids: number[] = [];
  for (const n of names) ids.push(await writeAndSend(m, n));
  await page.goto("/app/?demo=0");
  await page.getByTestId("login-token").fill(HER_TOKEN);
  await page.getByTestId("login-enter").click();
  await settle(page, 1200);
  for (let k = 0; k < names.length; k++) {
    await page.goto(`/app/ephemera-seal?id=${ids[k]}`);
    await settle(page, 1500);
    await page.screenshot({ path: `${RUNS}/seal-title-${slug(names[k])}.png` });
    const fit = (await linesFit(page, ["seal-t1", "seal-t2"])).filter(Boolean) as Line[];
    console.log(`[seal] ${JSON.stringify(fit)}`);
    if (names[k].includes("\n")) expect(fit.length, names[k]).toBe(2);
    for (const l of fit) { expect(l.fits, `${l.text}: no "…"`).toBe(true); whole(l); }
    expect(fit.map((l) => l.text.trim()).join(" ")).toBe(names[k].replace("\n", " "));
  }
  // the same names elsewhere: the invite card and the home page (screens only, for the eye)
  await page.goto(`/app/ephemera-invite?id=${ids[0]}`);
  await settle(page, 1500);
  await page.screenshot({ path: `${RUNS}/seal-title-check-invite.png` });
  await page.goto("/app/ephemera");
  await settle(page, 1500);
  await page.screenshot({ path: `${RUNS}/seal-title-check-home.png` });
  await clearActive(m);
});
