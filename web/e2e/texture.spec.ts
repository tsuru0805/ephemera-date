// The page texture (grain multiplied in, a lamp's light in soft-light) darkens a page's own colours slightly
// (~×0.96); it must never turn into a grey veil over the page (it did: its blending layers sat in a View of their own
// and blended with nothing — screen = colour × 0.68 + grey × 0.32, "the whole thing in a fog"). And a piece in flight
// carries the same texture, so it does not go dark in the air and pale on landing.
import { type Page, test } from "@playwright/test";
import { expect, settle } from "./helpers";

type Clip = { x: number; y: number; width: number; height: number };
/** Mean colour of a region (css px), decoded in the page. */
async function meanRgb(page: Page, clip: Clip): Promise<number[]> {
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const s = [0, 0, 0]; let n = 0;
    for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
    return s.map((v) => v / n);
  }, png);
}
const ratio = (a: number[], b: number[]) => a.map((v, i) => v / b[i]);

test("the page texture darkens the page's own colours a little, never a grey veil", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one size is enough");
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1500);
  await page.getByTestId("demo-step").click();
  await settle(page, 900);
  await page.getByLabel("打开邀请", { exact: true }).click();
  await page.waitForURL(/ephemera-seal/);
  await settle(page, 2500);
  // the blending layers sit on the stage's outer layer, the one with the ground colour (not in an empty View)
  const parents = await page.evaluate(() => [...document.querySelectorAll('[data-testid="stage-grain"],[data-testid="stage-light"]')]
    .filter((e) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === "absolute")
    .map((e) => getComputedStyle(e.parentElement!).backgroundColor));
  expect(parents.length).toBeGreaterThan(0);
  for (const bg of parents) expect(bg, "the texture's parent has the page's ground colour").not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  // pixels: the pink envelope and the plain ground, with the texture and without
  const regions: Record<string, Clip> = { envelope: { x: 150, y: 200, width: 60, height: 40 }, ground: { x: 8, y: 800, width: 40, height: 30 } };
  const now: Record<string, number[]> = {};
  for (const [k, c] of Object.entries(regions)) now[k] = await meanRgb(page, c);
  await page.evaluate(() => document.querySelectorAll<HTMLElement>('[data-testid="stage-grain"],[data-testid="stage-light"]').forEach((e) => { e.style.visibility = "hidden"; }));
  await page.waitForTimeout(300);
  for (const [k, c] of Object.entries(regions)) {
    const r = ratio(now[k], await meanRgb(page, c));
    console.log(`[texture] ${k}: ×${r.map((v) => v.toFixed(3)).join(" ×")}`);
    // each channel a little darker (a veil lifts the dark channels towards grey: the envelope's green went ×1.07)
    for (const v of r) { expect(v, `${k}: not lighter than its own colour`).toBeLessThanOrEqual(1.0); expect(v, `${k}: only a little darker`).toBeGreaterThan(0.92); }
    expect(Math.max(...r) - Math.min(...r), `${k}: the same on every channel (no shift towards grey)`).toBeLessThan(0.03);
  }
});

test("a piece in flight carries the page's texture: the same colour in the air as on the page", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one size is enough");
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1500);
  await page.getByTestId("demo-step").click();
  await settle(page, 900);
  await page.getByLabel("打开邀请", { exact: true }).click();
  await page.waitForURL(/ephemera-seal/);
  await settle(page, 2500);
  await page.getByLabel("拆开", { exact: true }).click();
  await page.waitForURL(/ephemera-invite/);
  await settle(page, 2500);
  await page.getByTestId("demo-step").click();
  await settle(page, 1500);
  const card: Clip = { x: 60, y: 420, width: 120, height: 60 };   // plain paper on the invitation, between its rows
  const onPage = await meanRgb(page, card);
  await page.getByLabel("开始今天", { exact: true }).click();
  await page.waitForSelector('[data-testid="flight-from"]', { timeout: 3000 });   // lifted, still over its place
  const layer = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="flight-from"]')!.parentElement!).zIndex);
  expect(layer, "the flight layer is no stacking context of its own (the texture blends with what is under it)").toBe("auto");
  await expect(page.getByTestId("flight-grain")).toHaveCount(1);
  // the ghost takes no touches (a copied Pressable keeps its own pointer-events:auto): a tap goes to the page under it
  const hitGhost = await page.evaluate(() => {
    const g = document.querySelector('[data-testid="flight-from"]')!, r = g.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && g.contains(hit);
  });
  expect(hitGhost, "the ghost is out of hit testing").toBe(false);
  const inAir = await meanRgb(page, card);
  const r = ratio(inAir, onPage);
  console.log(`[texture] in the air ×${r.map((v) => v.toFixed(3)).join(" ×")}`);
  for (const v of r) expect(Math.abs(v - 1), "the ghost's colour = the piece's on the page").toBeLessThan(0.015);
});

test("after a change of skin the texture over a piece in flight takes the new skin's colour (as the page's)", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one size is enough");
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1500);
  await page.getByTestId("demo-step").click();
  await settle(page, 900);
  // home → Me: change to 粉蓝撞色 (shadow colour 40,70,100), back home without reloading
  await page.getByLabel("Me", { exact: true }).filter({ visible: true }).first().click();
  await settle(page, 1200);
  await page.getByLabel("粉蓝撞色", { exact: true }).click();
  await settle(page, 800);
  await page.getByLabel("Home", { exact: true }).filter({ visible: true }).first().click();
  await settle(page, 1500);
  const pageLight = await page.getByTestId("stage-light").last().evaluate((e) => (e as HTMLElement).style.backgroundImage);
  expect(pageLight).toContain("rgba(40, 70, 100, 0.14)");
  await page.getByLabel("打开邀请", { exact: true }).click();
  await page.waitForSelector('[data-testid="flight-light"]', { state: "attached", timeout: 3000 });
  const ghostLight = await page.getByTestId("flight-light").first().evaluate((e) => (e as HTMLElement).style.backgroundImage);
  expect(ghostLight, "the ghost's corners in the new skin").toContain("rgba(40, 70, 100, 0.14)");
});
