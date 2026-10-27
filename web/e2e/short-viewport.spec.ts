// A phone browser with its own bars (iOS Chrome / Safari: an address bar on top, a toolbar below) leaves the page
// less height than a full-screen phone. The whole demo, at three such heights: every page's lowest controls are
// reached the way a person reaches them — scrolling with the wheel or a finger, never a scroll made by the test — and
// tapped where they are on the screen.
import { type Page, test } from "@playwright/test";
import { drag, expect, pickPhotoInBrowser, RUNS, settle } from "./helpers";

const SIZES = [
  { width: 390, height: 600 },
  { width: 390, height: 650 },
  { width: 360, height: 640 },
];

/** The element with this label that shows (or the test id). */
function el(page: Page, label: string) {
  return label.startsWith("#") ? page.getByTestId(label.slice(1)).filter({ visible: true }).first()
    : page.getByLabel(label, { exact: true }).filter({ visible: true }).first();
}

/** Where it is now, once it has stopped moving (an entrance animation); null when it has no box. */
async function rect(page: Page, label: string) {
  let b = await el(page, label).boundingBox();
  for (let k = 0; k < 20; k++) {
    await page.waitForTimeout(120);
    const n = await el(page, label).boundingBox();
    if (b && n && Math.abs(n.x - b.x) < 0.5 && Math.abs(n.y - b.y) < 0.5 && Math.abs(n.height - b.height) < 0.5) return n;
    b = n;
  }
  return b;
}

/** Scroll like a person (the wheel, over the middle of the screen — or over `at`) until the element is wholly on
 *  the screen; fails if it never gets there. Returns how far the page had to be scrolled (px). */
async function reach(page: Page, label: string, at?: { x: number; y: number }, strict = true): Promise<number> {
  const vp = page.viewportSize()!;
  await el(page, label).waitFor({ state: "visible", timeout: 15_000 });
  let moved = 0;
  for (let k = 0; k < 30; k++) {
    const b = (await rect(page, label))!;
    // papers that lie over one another by design (strict = false): reached once some part of it shows, free to tap
    if (!strict && (await freePoint(page, label))) return moved;
    // on screen: wholly, or (a control taller than the screen) its top half; and not under something (the bar)
    const on = (b.y >= -0.5 && b.y + b.height <= vp.height + 0.5) || (b.height > vp.height * 0.8 && b.y >= 0 && b.y < vp.height * 0.5);
    let dy: number;
    if (on) {
      if (await uncovered(page, label, strict)) return moved;
      dy = b.y + b.height / 2 > vp.height / 2 ? 60 : -60;   // under the bar at the foot / the header on top: a little further
    } else dy = b.y + b.height > vp.height ? Math.min(160, b.y + b.height - vp.height + 8) : Math.max(-160, b.y - 8);
    await page.mouse.move(at?.x ?? vp.width / 2, at?.y ?? vp.height / 2);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(160);
    moved += dy;
  }
  const b = (await rect(page, label))!;
  throw new Error(`${label} not reachable by scrolling: at ${Math.round(b.y)}..${Math.round(b.y + b.height)} of ${vp.height}`);
}

/** Nothing over it: its top, middle and foot (of the part on screen; a control taller than the screen, its middle)
 *  are the control itself — not the bar at the foot, not the header on top. */
async function uncovered(page: Page, label: string, strict = true) {
  const vp = page.viewportSize()!;
  const b = (await rect(page, label))!;
  const top = Math.max(0, b.y), bottom = Math.min(vp.height, b.y + b.height);
  const x = b.x + b.width / 2, mid = (top + bottom) / 2;
  const ys = !strict || b.height > vp.height * 0.8 ? [mid] : [top + Math.min(6, b.height / 4), mid, bottom - Math.min(6, b.height / 4)];
  return el(page, label).evaluate((e, q) => q.ys.every((y) => { const hit = document.elementFromPoint(q.x, y); return !!hit && (e === hit || e.contains(hit)); }), { x, ys });
}

/** A point of it on the screen that is the control itself (a grid over the part on screen); null if none. */
async function freePoint(page: Page, label: string): Promise<{ x: number; y: number } | null> {
  const vp = page.viewportSize()!;
  const b = (await rect(page, label))!;
  const top = Math.max(0, b.y), bottom = Math.min(vp.height, b.y + b.height);
  if (bottom - top < 8) return null;
  return el(page, label).evaluate((e, q) => {
    for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
      const x = q.x + (q.w * j) / 8, y = q.top + ((q.bottom - q.top) * i) / 8;
      const hit = document.elementFromPoint(x, y);
      if (hit && (e === hit || e.contains(hit))) return { x, y };
    }
    return null;
  }, { x: b.x, w: b.width, top, bottom });
}

/** The point to tap: the middle of the part on screen, and that point really is the control (nothing over it). */
async function tapPoint(page: Page, label: string) {
  const vp = page.viewportSize()!;
  const b = (await rect(page, label))!;
  const top = Math.max(0, b.y), bottom = Math.min(vp.height, b.y + b.height);
  expect(bottom - top, `${label} on screen`).toBeGreaterThan(8);
  const p = { x: b.x + b.width / 2, y: (top + bottom) / 2 };
  const own = await el(page, label).evaluate((e, q) => { const hit = document.elementFromPoint(q.x, q.y); return !!hit && (e === hit || e.contains(hit)); }, p);
  expect(own, `${label} not covered at its middle`).toBe(true);
  return p;
}

/** Reach it, then tap it where it is (no scrolling by the test's click). */
async function reachTap(page: Page, label: string, at?: { x: number; y: number }, strict = true) {
  await reach(page, label, at, strict);
  if (!strict) { const p = (await freePoint(page, label))!; await page.mouse.click(p.x, p.y); return; }
  const p = await tapPoint(page, label);
  await page.mouse.click(p.x, p.y);
}

/** A finger drag (touch events, as on a phone). */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const scrollTop = (page: Page, testId: string) =>
  page.getByTestId(testId).filter({ visible: true }).first().evaluate((e) => e.scrollTop);

for (const vp of SIZES) {
  test.describe(`short screen ${vp.width}×${vp.height}`, () => {
    test.use({ viewport: vp });
    test(`the whole demo: every page's lowest controls reached and tapped (${vp.width}×${vp.height})`, async ({ page }, info) => {
      test.skip(info.project.name !== "phone-390", "phone sizes only");
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const tag = `${vp.width}x${vp.height}`;
      let n = 0;
      const shot = async (name: string) => { n++; await page.screenshot({ path: `${RUNS}/short/${tag}-${String(n).padStart(2, "0")}-${name}.png` }); };
      const step = async (ms = 1200) => { await reachTap(page, "#demo-step"); await settle(page, ms); };

      await page.goto("/app/?demo=0");
      await page.goto("/app/?demo=1");
      await settle(page, 1500);
      await shot("home");
      await step(900);
      await reachTap(page, "打开邀请");
      await page.waitForURL(/ephemera-seal/);
      await settle(page, 1500);
      await shot("seal-top");

      // the envelope page: its lowest line is reached by scrolling the page, and the page did scroll
      const sealMoved = await reach(page, "先看准备清单");
      expect(sealMoved).toBeGreaterThan(0);
      expect(await scrollTop(page, "stage-scroll")).toBeGreaterThan(0);
      await shot("seal-bottom");
      await reachTap(page, "拆开");
      await page.waitForURL(/ephemera-invite/, { timeout: 15_000 });
      await settle(page, 1800);
      await shot("invite-top");

      // the invitation: a finger drag on the card scrolls the page (and opens nothing)
      await touchDrag(page, { x: vp.width / 2, y: vp.height * 0.7 }, { x: vp.width / 2, y: vp.height * 0.3 });
      await page.waitForTimeout(500);
      expect(await scrollTop(page, "stage-scroll")).toBeGreaterThan(0);
      await expect(page.getByLabel("收起", { exact: true }).filter({ visible: true })).toHaveCount(0);
      await step(600);
      await reach(page, "先收进邀请盒");
      await shot("invite-bottom");
      await reachTap(page, "开始今天");
      await page.waitForURL(/ephemera-day/);
      await settle(page, 1500);
      await shot("day");

      // the day: the first stop's ticket, checked; a photo kept for it
      await step(1500);
      await reachTap(page, "第 1 站");
      await settle(page, 1200);
      await reachTap(page, "检票");
      await settle(page, 2200);
      await shot("ticket-checked");
      await reachTap(page, "放一张照片");
      await settle(page, 900);
      await reach(page, "选一张照片");
      const pick = await tapPoint(page, "选一张照片");
      await pickPhotoInBrowser(page, () => page.mouse.click(pick.x, pick.y));
      await settle(page, 1200);
      await reachTap(page, "按住往下推,放进卡套", undefined, false);   // its foot tucks into the sleeve by design
      await settle(page, 1000);
      await reachTap(page, "盖邮戳封口");
      await settle(page, 900);
      await reach(page, "收好");
      await shot("photo-sealed");
      await reachTap(page, "收好");
      await settle(page, 2000);

      // dinner: the menu opens
      await step();
      await reachTap(page, "第 2 站");
      await settle(page, 1000);
      await reachTap(page, "翻开菜单");
      await settle(page, 2400);
      await shot("menu");

      // the cinema: the stub at the ticket's foot is reached and torn
      await step();
      await reachTap(page, "第 3 站");
      await settle(page, 1200);
      // the stub is on the screen as the ticket opens (the ticket is scaled to fit, not scrolled: a finger drag on
      // the stub inside a scrolling sheet went to the page — 10-27 on her phone's browser the stub was below the screen)
      const stub = (await rect(page, "往下撕副券"))!;
      expect(stub.y + stub.height).toBeLessThanOrEqual(vp.height);
      const y0 = Math.max(stub.y + 12, 4);
      await drag(page, { x: stub.x + stub.width / 2, y: y0 }, { x: stub.x + stub.width / 2, y: Math.min(vp.height - 4, y0 + 90) });
      await settle(page, 2400);
      await shot("cinema-torn");
      await expect(page.getByText("Checked in.").filter({ visible: true })).toHaveCount(3);   // stops 1–3 (the menu checks in as it opens); the tear checked the cinema in
      await reachTap(page, "关上").catch(() => {});

      // a moment and the walk: both open
      await step();
      await reachTap(page, "第 4 站");
      await settle(page, 1200);
      await reachTap(page, "展开");
      await settle(page, 2600);
      await shot("moment");
      // a checked ticket puts itself away 1.5 s after the check: shut it if it is still open (a race, not a step)
      await reachTap(page, "关上").catch(() => {});
      await settle(page, 600);
      await step();
      await reachTap(page, "第 5 站");
      await settle(page, 1200);
      await reachTap(page, "展开地图");
      await settle(page, 2600);
      await shot("walk");
      await reachTap(page, "关上").catch(() => {});
      await settle(page, 600);

      // kept in the box: the flat page's papers are reached and opened; a paper taller than the screen scrolls
      await step(1500);
      await reachTap(page, "收进纪念盒");
      await page.waitForURL(/ephemera-box/);
      await settle(page, 2500);
      await shot("box-lid");
      await reachTap(page, "打开纪念盒");
      await settle(page, 2500);
      await shot("box-flat-top");
      // (the papers lie over one another by design: each is reached when its middle shows)
      for (const l of ["契约书", "限定小卡"]) await reach(page, l, undefined, false);
      await reach(page, "准备清单", undefined, false);
      // the flat page scrolls inside the pager with a finger (the papers below come up)
      for (let k = 0; k < 3; k++) await touchDrag(page, { x: vp.width * 0.5, y: vp.height * 0.75 }, { x: vp.width * 0.5, y: vp.height * 0.3 });
      await page.waitForTimeout(500);
      expect(await scrollTop(page, "box-page-scroll-flat")).toBeGreaterThan(0);
      await shot("box-flat-bottom");
      await reachTap(page, "准备清单", undefined, false);
      await settle(page, 1500);
      await shot("box-prep-top");
      // a finger drag scrolls the paper and leaves it up; the drag is not a tap that puts it down
      await touchDrag(page, { x: vp.width / 2, y: vp.height * 0.75 }, { x: vp.width / 2, y: vp.height * 0.2 });
      await page.waitForTimeout(600);
      await expect(page.getByLabel("放下", { exact: true }).filter({ visible: true })).toHaveCount(1);
      // (scrolled where the paper is taller than the screen; where it fits there is nothing to scroll)
      const pop = await page.getByTestId("pop-paper-scroll").filter({ visible: true }).first().evaluate((e) => ({ top: e.scrollTop, over: e.scrollHeight - e.clientHeight }));
      if (pop.over > 1) expect(pop.top).toBeGreaterThan(0);
      await shot("box-prep-bottom");
      await reachTap(page, "放下");
      await settle(page, 900);
      await reachTap(page, "请柬", undefined, false);
      await settle(page, 1500);
      await shot("box-invite");
      await reachTap(page, "放下");
      await settle(page, 900);
      await reachTap(page, "路线", undefined, false);
      await settle(page, 1800);
      await reach(page, "#route-band-stops");
      await shot("box-route-bottom");
      // the contract page (opened from the flat page): scrolled with a finger to its end, the paper's foot and both
      // lower corners on the screen above the bar
      await page.goto("/app/ephemera-box?id=1");
      await settle(page, 2500);
      await reachTap(page, "契约书", undefined, false);
      await settle(page, 1500);
      const contract = page.getByTestId("box-page-scroll-contract").filter({ visible: true }).first();
      for (let k = 0; k < 5; k++) await touchDrag(page, { x: vp.width / 2, y: vp.height * 0.7 }, { x: vp.width / 2, y: vp.height * 0.2 });
      await page.waitForTimeout(600);
      const cs = await contract.evaluate((e) => ({ top: e.scrollTop, over: e.scrollHeight - e.clientHeight }));
      expect(cs.over).toBeGreaterThan(0);
      expect(cs.top, "scrolled to the end").toBeGreaterThanOrEqual(cs.over - 1);
      const paper = (await page.getByTestId("contract-paper").filter({ visible: true }).first().boundingBox())!;
      const barTop = (await page.getByLabel("Archive", { exact: true }).filter({ visible: true }).first().boundingBox())!.y;
      expect(paper.y + paper.height, "the paper's lowest corner above the bar").toBeLessThanOrEqual(barTop);
      expect(paper.x, "its left corner on the screen").toBeGreaterThanOrEqual(0);
      expect(paper.x + paper.width, "its right corner on the screen").toBeLessThanOrEqual(vp.width);
      await shot("box-contract-bottom");

      // the bar: Me (its last skin) and back home
      await reachTap(page, "Me");
      await settle(page, 1500);
      await reach(page, "原来的粉");
      await shot("me-bottom");
      await reachTap(page, "Home");
      await settle(page, 1500);
      await shot("home-again");
      expect(errors).toEqual([]);
    });
  });
}
