// Opened on its own, against a real engine: an AI writes and sends a date over MCP; she signs in, opens the letter,
// checks in every stop, puts a photo in; the AI closes the date; it is kept in the box.
// Needs the engine running (EPHEMERA_ENGINE, default http://127.0.0.1:18791) with EPHEMERA_HER_TOKEN / EPHEMERA_AI_TOKEN
// set to the e2e tokens; the test server proxies /api to it (same origin).
import { test } from "@playwright/test";
import { ai, clearActive, close, HER_TOKEN, writeAndSend } from "./engine";
import { drag, expect, nameRun, pickPhotoInBrowser, settle, shot, tapLabel } from "./helpers";

test.skip(!process.env.EPHEMERA_ENGINE, "needs a running engine (EPHEMERA_ENGINE)");

test("standalone: sign in, open the letter, check in, a photo, kept in the box", async ({ page }, info) => {
  nameRun(page, `standalone-${info.project.name}`);
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("[pageerror]", e.message); });
  // a picture resolved to ".../undefined" (the server here answers it with the page, a host's server with 404)
  const undef: string[] = [];
  page.on("request", (r) => { if (/\/undefined(\?|$)/.test(new URL(r.url()).pathname)) undef.push(r.url()); });
  const m = await ai();
  await clearActive(m);
  const plan = await writeAndSend(m, info.project.name === "phone-390" ? "A Quiet\nRiver Walk" : "Tablet\nTea Walk");

  await page.goto("/app/?demo=0");
  await settle(page, 800);
  await shot(page, "01-login");
  await page.getByTestId("login-token").fill("wrong-token");
  await page.getByTestId("login-enter").click();
  await expect(page.getByTestId("login-error")).toHaveText("口令不对");
  await page.getByTestId("login-token").fill(HER_TOKEN);
  await page.getByTestId("login-enter").click();
  await settle(page, 1500);
  await shot(page, "02-home");

  await tapLabel(page, "打开邀请");
  await page.waitForURL(/ephemera-seal/);
  await settle(page, 1200);
  await tapLabel(page, "拆开信封(按住往上拉,或点一下)");
  await page.waitForURL(/ephemera-invite/, { timeout: 15_000 });
  await settle(page, 1500);
  await shot(page, "03-invite");
  await tapLabel(page, "开始今天");
  await page.waitForURL(/ephemera-day/);
  await settle(page, 1500);
  await shot(page, "04-day");
  // the map page: no base map built in this test engine → one readable line, not the setup hint
  await tapLabel(page, "地图");
  await settle(page, 2000);
  await expect(page.getByText("这一带的地图还没准备好，地点和路线照常能看")).toBeVisible();
  await expect(page.getByText(/建底图/)).toHaveCount(0);
  await shot(page, "04b-map");
  await tapLabel(page, "返回");
  await settle(page, 1200);

  // stop 1: the train ticket, and a photo
  await tapLabel(page, "第 1 站");
  await settle(page, 1000);
  await tapLabel(page, "检票");
  await settle(page, 2200);
  await tapLabel(page, "放一张照片");
  await settle(page, 900);
  await pickPhotoInBrowser(page, () => tapLabel(page, "选一张照片"), 900, 1350);
  await settle(page, 1000);
  await tapLabel(page, "按住往下推,放进卡套");
  await settle(page, 900);
  await tapLabel(page, "盖邮戳封口");
  await settle(page, 800);
  await tapLabel(page, "收好");
  await expect(page.getByText("收好了")).toBeVisible({ timeout: 15_000 });
  await settle(page, 1200);
  await shot(page, "05-photo-kept");

  // stops 2 and 3: menus; stop 4: the walk
  for (const n of [2, 3]) {
    await tapLabel(page, `第 ${n} 站`);
    await settle(page, 1000);
    await tapLabel(page, "翻开菜单");
    await settle(page, 2600);
    await tapLabel(page, "这一站不放了").catch(() => {});
  }
  await tapLabel(page, "第 4 站");
  await settle(page, 1000);
  await tapLabel(page, /^展开/);                   // no base map in the test engine: the ticket without a map
  await settle(page, 2600);
  await shot(page, "06-all-checked");
  await tapLabel(page, "关上").catch(() => {});

  // the AI closes the date; the page sees it on its next read
  await close(m, plan);
  await page.reload();
  await settle(page, 2000);
  await tapLabel(page, "收进纪念盒");
  await page.waitForURL(/ephemera-box/);
  await settle(page, 2000);
  await shot(page, "06b-box-lid");                              // the lid: the full name, shrunk to fit, not cut
  await tapLabel(page, "打开纪念盒");
  await settle(page, 2500);
  await shot(page, "07-box");
  for (let k = 0; k < 6 && !/\/ephemera$/.test(new URL(page.url()).pathname); k++) { await tapLabel(page, "返回"); await settle(page, 1200); }
  await shot(page, "08-home");
  expect(errors).toEqual([]);
  expect(undef).toEqual([]);
  void drag;
});
