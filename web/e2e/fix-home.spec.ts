// Screens for the fixes shared with the home app (390 wide, same changes as there): 收进纪念盒 above the strip once the
// day is over, map tickets done only when checked in, the map title clear of the postmark, the lid's BREAK THE SEAL
// above the sticker, a thicker photo dim, the day's hints in the header's date line, the box's back key on a paper chip,
// a Chinese telegram all in the serif.
import { test } from "@playwright/test";
import { expect, regionStd, RUNS, settle, tapLabel } from "./helpers";

test("home-shared fixes, 390 wide", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "the screens are 390 wide");
  const snap = (n: string) => page.screenshot({ path: `${RUNS}/fix-home-${n}.png` });
  const step = async (n = 1) => { for (let k = 0; k < n; k++) { await page.getByTestId("demo-step").click(); await page.waitForTimeout(250); } };
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1200);
  await step(3);                                            // sent → the day → 18:00
  await page.goto("/app/ephemera-day?id=1");
  await settle(page, 1500);
  // a stop he skipped (the demo's 6th): faded, 「跳过了：原因」, not counted (N / 5)
  const skipped = page.getByText("跳过了：太晚了，下次再去").filter({ visible: true }).first();
  await expect(skipped).toBeVisible();
  await expect(page.getByText(" / 5").filter({ visible: true }).first()).toBeVisible();
  await skipped.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${RUNS}/skip-day.png` });
  await page.goto("/app/ephemera-day?id=1");                                       // back to the top for the steps below
  await settle(page, 1500);
  // the strip's title keeps its size (a box that shrinks with its text used to ratchet it down 3 % a pass)
  const titleSize = () => page.getByTestId("day-strip-title").filter({ visible: true }).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  const s0 = await titleSize();
  await page.waitForTimeout(3000);
  expect(await titleSize()).toBe(s0);
  expect(s0).toBeGreaterThanOrEqual(20);
  await tapLabel(page, "第 1 站");
  await settle(page, 900);
  await tapLabel(page, "检票");
  // the day's hints are written in the header's date line (no layer over the strip), then the date comes back
  const hint = page.getByTestId("day-hint").filter({ visible: true });
  await expect(hint).toContainText("下一张", { timeout: 6000 });
  const strip = (await page.getByText(/ADMIT TWO/).filter({ visible: true }).first().boundingBox())!;
  const hb = (await hint.boundingBox())!;
  const apart = hb.y + hb.height <= strip.y || strip.y + strip.height <= hb.y || hb.x + hb.width <= strip.x || strip.x + strip.width <= hb.x;
  expect(apart, `hint ${JSON.stringify(hb)} vs strip header ${JSON.stringify(strip)}`).toBe(true);   // not over the strip's header line
  await snap("5-day-hint-next");
  await page.screenshot({ path: `${RUNS}/day-hint-1-next.png` });
  await expect(hint).toHaveCount(0, { timeout: 4000 });                          // back to the date
  await page.screenshot({ path: `${RUNS}/day-hint-3-date-back.png` });
  await tapLabel(page, "第 2 站");                                                // not open yet
  await expect(hint).toContainText("才能拆开这一格", { timeout: 4000 });
  await page.screenshot({ path: `${RUNS}/day-hint-2-locked.png` });
  await expect(hint).toHaveCount(0, { timeout: 4000 });
  await tapLabel(page, "放一张照片");
  await settle(page, 900);
  await snap("4-photo-dim");
  await tapLabel(page, "关上");
  await page.goto("/app/ephemera-telegrams");
  await settle(page, 1500);
  await snap("7-telegram-digits");
  await page.goto("/app/ephemera");
  await settle(page, 800);
  await step(5);                                            // through the day to the end
  await page.goto("/app/ephemera-day?id=1");
  await settle(page, 1500);
  const keep = page.getByLabel("收进纪念盒", { exact: true }).filter({ visible: true }).first();
  const kb = (await keep.boundingBox())!;
  expect(kb.y + kb.height).toBeLessThan(page.viewportSize()!.height - 80);    // on the first screen, above the nav bar
  await snap("1-day-done-first-screen");
  await page.goto("/app/ephemera-map?id=1");
  await settle(page, 1800);
  await expect(page.getByText("没检票").first()).toBeVisible();          // stops 2–5 were never checked in this run
  await snap("2-map-title");
  const skipTicket = page.getByText("跳过了").first();                     // the skipped stop's ticket
  await expect(skipTicket).toBeAttached();
  await skipTicket.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${RUNS}/skip-map.png` });
  await page.goto("/app/ephemera-box?id=1");
  await settle(page, 2000);
  await snap("3-box-lid");
  await tapLabel(page, "打开纪念盒");
  await settle(page, 2500);
  await snap("6-box-back-key");
  // turning the box's pages: the page number follows (it stayed at 01 on the web)
  const pageNo = page.getByTestId("box-page-no").filter({ visible: true }).first();
  await expect(pageNo).toHaveText("01");
  const turned = await page.evaluate(() => {
    // the box's pages: the horizontal scroller in the same page as the visible page number
    const no = Array.from(document.querySelectorAll('[data-testid="box-page-no"]')).find((e) => (e as HTMLElement).offsetParent);
    const scroller = (d: Element) => /(auto|scroll)/.test(getComputedStyle(d).overflowX) && d.scrollWidth > d.clientWidth + 100;
    for (let a = no?.parentElement ?? null; a; a = a.parentElement) {
      const book = Array.from(a.querySelectorAll("div")).find(scroller);
      if (book) { book.scrollLeft = book.clientWidth; return true; }
    }
    return false;
  });
  expect(turned).toBe(true);
  await expect(pageNo).toHaveText("02", { timeout: 3000 });
});

test("the backfill page's ground: the paper texture blends with the ground (no grey veil)", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough");
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1200);
  await page.goto("/app/ephemera-backfill");
  await settle(page, 1500);
  await page.screenshot({ path: `${RUNS}/backfill-ground.png` });
  // empty ground right of the title and right of the timeline: a faint grain (≈3) — the veil measured ≈9
  for (const clip of [{ x: 200, y: 100, width: 170, height: 50 }, { x: 220, y: 330, width: 150, height: 30 }]) {
    expect(await regionStd(page, clip), JSON.stringify(clip)).toBeLessThan(6);
  }
});
