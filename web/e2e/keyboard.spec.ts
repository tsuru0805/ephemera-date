// The on-screen keyboard as iOS gives it to a page: window.visualViewport shrinks (a stand-in here, since a desktop
// browser has no keyboard), the layout viewport does not. The backfill page must keep its height (it was sized from
// the visual viewport and lost everything under the keyboard: a blank lower half once the page panned), and the
// focused field must sit above the keyboard, not off the top.
import { test, type Page } from "@playwright/test";
import { expect, RUNS, settle } from "./helpers";

const KB = 336;
async function scrollBox(page: Page) {
  return page.evaluate(() => {
    const spacer = Array.from(document.querySelectorAll('[data-testid="abs-kb-spacer"]')).find((e) => (e as HTMLElement).offsetParent) as HTMLElement;
    let n: HTMLElement | null = spacer;
    while (n && !/(auto|scroll)/.test(getComputedStyle(n).overflowY)) n = n.parentElement;
    const r = n!.getBoundingClientRect();
    return { top: r.top, height: r.height, clientHeight: n!.clientHeight, scrollTop: n!.scrollTop };
  });
}

test("keyboard (visual viewport shrinks): the backfill page keeps its height, the field stays in view", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough");
  await page.addInitScript(() => {
    const vv = new EventTarget() as EventTarget & Record<string, number>;
    Object.assign(vv, { width: innerWidth, height: innerHeight, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0 });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    (window as unknown as { __kb: (h: number) => void }).__kb = (h: number) => { vv.height = innerHeight - h; vv.dispatchEvent(new Event("resize")); };
  });
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1200);
  await page.goto("/app/ephemera-backfill");
  await settle(page, 1500);
  const before = await scrollBox(page);
  const field = page.getByTestId("bf-line-0").filter({ visible: true }).first();
  await field.click();
  await page.evaluate((h) => (window as unknown as { __kb: (h: number) => void }).__kb(h), KB);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${RUNS}/keyboard-open.png` });
  const after = await scrollBox(page);
  console.log(`[kb] before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  expect(after.height, "the page is not cut at the keyboard").toBeCloseTo(before.height, 0);
  const fb = (await field.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(fb.y, "the field is not pushed off the top").toBeGreaterThanOrEqual(0);
  expect(fb.y + fb.height, "the field sits above the keyboard").toBeLessThanOrEqual(vh - KB + 1);
  expect(after.scrollTop, "the scroll view lifted the field").toBeGreaterThan(before.scrollTop);
  await page.evaluate(() => (window as unknown as { __kb: (h: number) => void }).__kb(0));
  await page.waitForTimeout(900);
  const closed = await scrollBox(page);
  expect(closed.height).toBeCloseTo(before.height, 0);
  // as the home app: the keyboard goes down, the view goes back to where it stood before the keyboard moved it
  expect(closed.scrollTop, "back where it was").toBeCloseTo(before.scrollTop, 0);
});

test("keyboard: when the browser scrolls the whole document to the field (iOS), the page goes back; header below the top", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough");
  await page.addInitScript(() => {
    const vv = new EventTarget() as EventTarget & Record<string, number>;
    Object.assign(vv, { width: innerWidth, height: innerHeight, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0 });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    (window as unknown as { __kb: (h: number) => void }).__kb = (h: number) => { vv.height = innerHeight - h; vv.dispatchEvent(new Event("resize")); };
  });
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1200);
  await page.goto("/app/ephemera-backfill");
  await settle(page, 1500);
  const scrollY = () => page.evaluate(() => Math.max(window.scrollY, document.scrollingElement?.scrollTop ?? 0));
  const header = () => page.getByText("The Way", { exact: false }).filter({ visible: true }).first().boundingBox();
  const h0 = (await header())!;
  const field = page.getByTestId("bf-line-0").filter({ visible: true }).first();
  await field.click();
  // what iOS does: the keyboard comes up and the browser scrolls the document itself so the field shows
  // (the root is one screen tall; let this document scroll for the moment, as WebKit's does)
  await page.evaluate((h) => {
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "visible";
    document.body.style.minHeight = "200%";
    (window as unknown as { __kb: (h: number) => void }).__kb(h);
    window.scrollTo(0, 237);
  }, KB);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${RUNS}/keyboard-unpanned.png` });
  expect(await scrollY(), "the document is back at the top").toBe(0);
  // the page's own scroll view may lift its content (as on the phone), but nothing goes above the page's top edge
  const box = await scrollBox(page);
  expect(box.top, "the scroll view stays where it was (not pushed up by the document)").toBeGreaterThanOrEqual(0);
  const h1 = (await header())!;
  expect(h1.y, "the header is not under the top edge").toBeGreaterThanOrEqual(0);
  expect(h0.y - h1.y, "moved only by the scroll view's own lift").toBeLessThan(120);
  const fb = (await field.boundingBox())!;
  expect(fb.y).toBeGreaterThanOrEqual(0);
  expect(fb.y + fb.height, "the field sits above the keyboard").toBeLessThanOrEqual(page.viewportSize()!.height - KB + 1);
  // the keyboard goes down: still at the top
  await page.evaluate(() => { (window as unknown as { __kb: (h: number) => void }).__kb(0); window.scrollTo(0, 120); });
  await page.waitForTimeout(600);
  expect(await scrollY()).toBe(0);
  // no keyboard (and nothing being typed): a scroll of the document is the browser's own (its bars) and left alone
  await field.evaluate((e) => (e as HTMLElement).blur());
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForTimeout(600);
  expect(await scrollY(), "not put back without a keyboard").toBe(120);
});
