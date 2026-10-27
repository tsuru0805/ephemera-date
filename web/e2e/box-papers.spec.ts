// The box's contract and card pages (as the home app, design-base cb929c9), against a real engine:
// - the contract page scrolls to the paper's foot and both lower corners; a Chinese line of the quote stands at a line
//   height taller than its glyphs (iOS cut their tops at 45);
// - the card's back: a long Japanese text scrolls inside the card (judged by the laid-out height), a drag scrolls it
//   without turning the card, the last line can be reached, and a tap on the text turns the card back.
import { type Page, test } from "@playwright/test";
import { ai, clearActive, HER_TOKEN, writeAndSend } from "./engine";
import { expect, RUNS, settle, tapLabel } from "./helpers";

test.skip(!process.env.EPHEMERA_ENGINE, "needs a running engine (EPHEMERA_ENGINE)");

const LONG_JA = [
  "今日は一日、", "本当にありがとう。", "駅で待っているあいだ、", "少しだけ緊張していました。", "小さな灯りの店で", "食べた夕ごはん。",
  "映画のあと、", "川沿いを歩いた時間。", "ぜんぶ覚えておきたい。", "風が少し冷たくて、", "上着を貸してくれたこと。", "帰り道の信号、",
  "花屋の前で笑ったこと。", "次はあなたが", "行きたい場所を選んでね。", "どこへでも、", "また一緒に行こう。", "おやすみなさい。",
].join("\n");

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
const vis = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true }).first();
/** Opacity as seen: the product of its own and its ancestors'. */
const seen = (page: Page, sel: ReturnType<Page["getByText"]>) => sel.evaluate((e) => { let o = 1; for (let a: Element | null = e; a; a = a.parentElement) o *= Number(getComputedStyle(a).opacity); return o; });

/** A date written with the long card, closed with a Chinese quote; she signed in. Returns how to open its box. */
async function setUp(page: Page) {
  expect([...LONG_JA].length).toBeLessThanOrEqual(200);   // the engine's limit for the card
  const m = await ai();
  await clearActive(m);
  const plan = await writeAndSend(m, "Papers\nin the Box", { card: LONG_JA });
  await m.call("date_close", { plan, quote: "好的同伴，好的一天" });

  await page.goto("/app/?demo=0");
  await settle(page, 800);
  await page.getByTestId("login-token").fill(HER_TOKEN);
  await page.getByTestId("login-enter").click();
  await settle(page, 1200);
  const openBox = async () => {
    await page.goto(`/app/ephemera-box?id=${plan}`);
    await settle(page, 2000);
    await tapLabel(page, "打开纪念盒").catch(() => {});     // the lid (once)
    await settle(page, 2200);
  };
  return openBox;
}

test("box: the contract page scrolls to the paper's foot and both lower corners; a Chinese quote line is not cut", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one size is enough");
  const openBox = await setUp(page);
  await openBox();
  await tapLabel(page, "契约书");
  await settle(page, 1800);
  const quote = page.getByText("好的同伴,", { exact: true }).filter({ visible: true }).first();
  expect(await quote.evaluate((e) => getComputedStyle(e).lineHeight)).toBe("56px");
  // taller than the screen: the page scrolls, a finger drag takes it to its end
  const scroller = vis(page, "box-page-scroll-contract");
  const over = await scroller.evaluate((e) => e.scrollHeight - e.clientHeight);
  expect(over, "the contract page is taller than the screen: it scrolls").toBeGreaterThan(0);
  await page.screenshot({ path: `${RUNS}/box-contract-top.png` });
  const vp = page.viewportSize()!;
  for (let k = 0; k < 4; k++) await touchDrag(page, { x: vp.width / 2, y: vp.height * 0.7 }, { x: vp.width / 2, y: vp.height * 0.25 });
  await page.waitForTimeout(600);
  expect(await scroller.evaluate((e) => Math.round(e.scrollTop))).toBeGreaterThanOrEqual(Math.floor(over) - 1);
  // the paper's foot and both lower corners above the bar
  const corners = await vis(page, "contract-paper").evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { bottom: r.bottom, left: r.left, right: r.right };
  });
  const bar = (await page.getByLabel("Archive", { exact: true }).filter({ visible: true }).first().boundingBox())!;
  expect(corners.bottom, "the paper's lowest corner shows above the bar").toBeLessThanOrEqual(bar.y - 6);
  expect(corners.left, "its left corner on the screen").toBeGreaterThanOrEqual(0);
  expect(corners.right, "its right corner on the screen").toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: `${RUNS}/box-contract-foot.png` });
});

for (const vp of [{ width: 390, height: 844 }, { width: 390, height: 650 }]) test.describe(`${vp.width}×${vp.height}`, () => {
  test.use({ viewport: vp });   // 650: a browser with its bars
  test(`box: the card's long back scrolls inside the card, a drag does not turn it, a tap on the text does (${vp.height})`, async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one size is enough");
  const openBox = await setUp(page);
  await openBox();
  await tapLabel(page, "限定小卡");
  await settle(page, 1800);
  await tapLabel(page, "撕开袋口").catch(() => {});
  await page.waitForTimeout(3000);
  await tapLabel(page, "小卡");
  await page.waitForTimeout(1500);
  const back = vis(page, "card-back-scroll");
  const m0 = await back.evaluate((e) => ({ over: e.scrollHeight - e.clientHeight, top: e.scrollTop, y: getComputedStyle(e).overflowY }));
  expect(m0.over, "the long text is taller than the card: the back scrolls").toBeGreaterThan(0);
  expect(m0.y).not.toBe("hidden");
  await page.screenshot({ path: `${RUNS}/box-card-back-top-${vp.height}.png` });
  const bb = (await back.boundingBox())!;
  for (let k = 0; k < 4; k++) await touchDrag(page, { x: bb.x + bb.width / 2, y: bb.y + bb.height * 0.8 }, { x: bb.x + bb.width / 2, y: bb.y + bb.height * 0.2 });
  await page.waitForTimeout(600);
  const m1 = await back.evaluate((e) => ({ top: e.scrollTop, over: e.scrollHeight - e.clientHeight }));
  expect(m1.top, "dragged to the end").toBeGreaterThanOrEqual(m1.over - 1);
  const front = page.getByText("LIMITED EDITION").first();
  expect(await seen(page, front), "a drag does not turn the card").toBeLessThan(0.05);
  // the last line shows inside the card
  const last = await page.getByText(/おやすみなさい。/).filter({ visible: true }).first().evaluate((e) => {
    const r = e.getBoundingClientRect(), s = (e.closest('[data-testid="card-back-scroll"]') as HTMLElement).getBoundingClientRect();
    return { textBottom: r.bottom, boxBottom: s.bottom };
  });
  expect(last.textBottom).toBeLessThanOrEqual(last.boxBottom + 1);
  await page.screenshot({ path: `${RUNS}/box-card-back-end-${vp.height}.png` });
  // a tap on the text turns it back to the front
  await tapLabel(page, "翻回正面");
  await page.waitForTimeout(1400);
  expect(await seen(page, front), "turned back to the front").toBeGreaterThan(0.95);
  await page.screenshot({ path: `${RUNS}/box-card-front-again-${vp.height}.png` });
});
});
