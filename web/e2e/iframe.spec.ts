// The page inside another origin's <iframe> (examples/iframe-host.html): handshake, navigate, back to the bottom →
// close, a missing date → home with a line, lifecycle / keyboard / safeArea / logout, and a cancelled photo pick.
import { test, type FrameLocator, type Page } from "@playwright/test";
import { ai, clearActive, HER_TOKEN, writeAndSend } from "./engine";
import { expect, nameRun, shot } from "./helpers";

test.skip(!process.env.EPHEMERA_ENGINE, "needs a running engine (EPHEMERA_ENGINE)");
const PORT = Number(process.env.EPHEMERA_E2E_PORT ?? 18790);

async function hostLog(page: Page) { return page.locator("#log").innerText(); }
const inFrame = (f: FrameLocator, label: string) => f.getByLabel(label, { exact: true }).filter({ visible: true }).first();

test("iframe host: handshake, navigate, close, cancelled pick", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough for the host page");
  nameRun(page, "iframe");
  const m = await ai();
  await clearActive(m);
  await writeAndSend(m, "Iframe\nEvening");
  const pageUrl = `http://127.0.0.1:${PORT}/app/`;
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT + 2}/ex/iframe-host.html?page=${encodeURIComponent(pageUrl)}&api=${encodeURIComponent(`http://127.0.0.1:${PORT}`)}`);
  await page.locator("#cred").fill(HER_TOKEN);
  await page.locator("#b-reopen").click();
  const f = page.frameLocator("#page");

  // handshake: ready → init (credential only in the message) → ok
  await expect(inFrame(f, "打开邀请")).toBeVisible({ timeout: 20_000 });
  const log1 = await hostLog(page);
  expect(log1).toContain('"type":"ready"');
  expect(log1).toMatch(/"ok":true/);
  expect(page.frames().find((x) => x.url().startsWith(pageUrl))!.url()).not.toContain(HER_TOKEN);
  await shot(page, "01-ready");

  // navigate from the host, then back twice: once inside the page, then the page asks to close
  await page.locator("#b-tele").click();
  await expect(f.getByText("Telegrams")).toBeVisible();
  await page.locator("#b-back").click();
  await expect(inFrame(f, "打开邀请")).toBeVisible();
  await page.locator("#b-back").click();
  await expect(page.locator("#closed")).toBeVisible();
  expect(await hostLog(page)).toContain('"type":"close"');
  await shot(page, "02-closed");

  // a date that does not exist: home + one line
  await page.locator("#b-reopen").click();
  await expect(inFrame(f, "打开邀请")).toBeVisible({ timeout: 20_000 });
  await page.locator("#b-gone").click();
  await expect(f.getByTestId("root-notice")).toHaveText("这次约会找不到了");

  // lifecycle / keyboard / safeArea are acknowledged
  for (const b of ["#b-bg", "#b-fg", "#b-kb", "#b-kb0", "#b-safe"]) await page.locator(b).click();
  await page.waitForTimeout(300);
  const acks = (await hostLog(page)).split("\n").filter((l) => l.startsWith("←") && l.includes('"ok":true')).length;
  expect(acks).toBeGreaterThanOrEqual(8);

  // a photo pick the host cancels: the page goes back to waiting, no error line
  await page.locator("#pick-cancel").check();
  await inFrame(f, "打开邀请").click();
  await expect(inFrame(f, "拆开信封(按住往上拉,或点一下)")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await inFrame(f, "拆开信封(按住往上拉,或点一下)").click();
  await expect(inFrame(f, "开始今天")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2000);     // the letter is still flying into the invitation
  await inFrame(f, "开始今天").click();
  await page.waitForTimeout(2000);
  await inFrame(f, "第 1 站").click();
  await inFrame(f, "检票").click();
  await page.waitForTimeout(2300);
  await inFrame(f, "放一张照片").click();
  await inFrame(f, "选一张照片").click();
  await page.waitForTimeout(800);
  expect(await hostLog(page)).toMatch(/"type":"pickPhoto"[^\n]*"max":1/);
  expect(await hostLog(page)).toMatch(/"cancelled":true/);
  await expect(f.getByTestId("photo-status")).toHaveCount(0);
  await shot(page, "03-pick-cancelled");

  // the host reports a keyboard: a field near the bottom moves above it (page scrolls its own content)
  await page.locator("#b-kb0").click();
  await page.evaluate(() => { const ifr = document.getElementById("page") as HTMLIFrameElement; ifr.contentWindow!.postMessage({ v: 1, id: "nb", type: "navigate", payload: { page: "backfill" } }, new URL(ifr.src).origin); });
  const field = f.getByTestId("bf-line-0").filter({ visible: true }).first();
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.click();
  await page.locator("#b-kb").click();                       // keyboard 336
  // desktop Chromium's visualViewport does not shrink: the host's height is used after the wait for visualViewport
  await page.waitForTimeout(1200);
  const frameBox = (await page.locator("#page").boundingBox())!;
  const fb = (await field.boundingBox())!;
  expect(fb.y + fb.height).toBeLessThanOrEqual(frameBox.y + frameBox.height - 336 + 1);
  await shot(page, "04-keyboard");
  await page.locator("#b-kb0").click();

  // logout: the page forgets the credential and waits for a new init
  await page.locator("#b-logout").click();
  await expect(inFrame(f, "打开邀请")).toHaveCount(0);
});
