// The online demo (?demo=1): a whole date — sent → open the letter → the day (check in, a photo) → kept in the box.
import { test } from "@playwright/test";
import { drag, expect, nameRun, pickPhotoInBrowser, RUNS, settle, shot, tapLabel } from "./helpers";

test("demo: a whole date from the letter to the box", async ({ page }, info) => {
  nameRun(page, `demo-${info.project.name}`);
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("[pageerror]", e.message, e.stack?.split("\n").slice(0, 6).join("\n")); });
  // a picture resolved to ".../undefined" (the server here answers it with the page, a host's server with 404)
  const undef: string[] = [];
  page.on("request", (r) => { if (/\/undefined(\?|$)/.test(new URL(r.url()).pathname)) undef.push(r.url()); });
  page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 400)); });
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1500);
  await shot(page, "01-preparing");

  // he sends it
  await page.getByTestId("demo-step").click();
  await settle(page);
  await shot(page, "02-sent");
  await tapLabel(page, "打开邀请");
  await page.waitForURL(/ephemera-seal/);
  await settle(page, 1200);
  await shot(page, "03-seal");
  await tapLabel(page, "拆开信封(按住往上拉,或点一下)");
  await page.waitForURL(/ephemera-invite/, { timeout: 15_000 });
  await settle(page, 1500);
  await shot(page, "04-invite");

  // the day comes
  await page.getByTestId("demo-step").click();
  await settle(page, 600);
  await tapLabel(page, "开始今天");
  await page.waitForURL(/ephemera-day/);
  await settle(page, 1500);
  await shot(page, "05-day");
  await page.getByTestId("demo-step").click();     // 18:00, the first stop opens
  await settle(page, 1500);
  await shot(page, "06-day-now");
  await tapLabel(page, "第 1 站");
  await settle(page, 1200);
  await shot(page, "07-ticket");
  await tapLabel(page, "检票");
  await settle(page, 2200);
  await shot(page, "08-checked");

  // a photo for the first stop
  await tapLabel(page, "放一张照片");
  await settle(page, 900);
  await pickPhotoInBrowser(page, () => tapLabel(page, "选一张照片"));
  await settle(page, 1200);
  await shot(page, "09-photo-picked");
  await tapLabel(page, "按住往下推,放进卡套");
  await settle(page, 1000);
  await tapLabel(page, "盖邮戳封口");
  await settle(page, 900);
  await page.getByTestId("photo-caption").fill("河边的风");
  await shot(page, "10-photo-sealed");
  await tapLabel(page, "收好");
  await settle(page, 2000);
  await shot(page, "11-photo-kept");

  // dinner: open the menu
  await page.getByTestId("demo-step").click();
  await settle(page, 1200);
  await tapLabel(page, "第 2 站");
  await settle(page, 1000);
  await tapLabel(page, "翻开菜单");
  await settle(page, 2600);
  await shot(page, "12-dinner-checked");
  await tapLabel(page, "这一站不放了").catch(() => {});

  // the cinema: tear the stub down
  await page.getByTestId("demo-step").click();
  await settle(page, 1200);
  await tapLabel(page, "第 3 站");
  await settle(page, 1200);
  const stub = page.getByLabel("往下撕副券").filter({ visible: true }).first();
  await stub.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(300);
  const box = (await stub.boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + 20 }, { x: box.x + box.width / 2, y: box.y + 260 });
  await settle(page, 2600);
  await shot(page, "13-cinema-checked");

  // a moment (no fixed place): the folded ticket opens to the stop's picture and name — no map
  await page.getByTestId("demo-step").click();
  await settle(page, 1200);
  await tapLabel(page, "第 4 站");
  await settle(page, 1200);
  await shot(page, "14-moment-folded");
  await tapLabel(page, "展开");
  await settle(page, 2800);
  await expect(page.getByTestId("walk-nomap").first()).toBeVisible();
  await shot(page, "15-moment-open");
  if (info.project.name === "phone-390") await page.screenshot({ path: `${RUNS}/walk-nomap-1-moment.png` });
  await tapLabel(page, "关上").catch(() => {});
  await settle(page, 600);

  // the walk with a real route: the map, as before
  await page.getByTestId("demo-step").click();
  await settle(page, 1200);
  await tapLabel(page, "第 5 站");
  await settle(page, 1200);
  await tapLabel(page, "展开地图");
  await settle(page, 2800);
  await expect(page.getByTestId("walk-nomap")).toHaveCount(0);
  await shot(page, "15b-walk-checked");
  if (info.project.name === "phone-390") await page.screenshot({ path: `${RUNS}/walk-nomap-2-route.png` });
  await tapLabel(page, "关上").catch(() => {});

  // the day is over: keep it in the box
  await page.getByTestId("demo-step").click();
  await settle(page, 1500);
  await shot(page, "16-day-over");
  await tapLabel(page, "收进纪念盒");
  await page.waitForURL(/ephemera-box/);
  await settle(page, 2500);
  await shot(page, "17-box");
  await tapLabel(page, "打开纪念盒");
  await settle(page, 2500);
  await shot(page, "18-box-open");
  // the prep list on the flat page is drawn at its half size (k=0.5), not a whole card scaled down (blurry type)
  const prep = page.getByLabel("准备清单", { exact: true }).filter({ visible: true }).first();
  await prep.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const prepScaled = await prep.evaluate((el) => [...el.querySelectorAll("*")].filter((e) => /matrix\(0\.5,/.test(getComputedStyle(e).transform)).length);
  expect(prepScaled).toBe(0);
  if (info.project.name === "phone-390") {
    await page.screenshot({ path: `${RUNS}/prep-k-flat.png` });
    await prep.screenshot({ path: `${RUNS}/prep-k-flat-card.png` });
  }
  await prep.click();
  await settle(page, 1500);
  if (info.project.name === "phone-390") await page.screenshot({ path: `${RUNS}/prep-k-pop.png` });
  await tapLabel(page, "放下");
  await settle(page, 900);
  // the photo put in at the first stop is there when the box is opened again (route page)
  await tapLabel(page, "路线");
  await settle(page, 1800);
  await shot(page, "18b-box-route");
  // the skipped stop on the route page: its own line in the serif, with the reason
  await expect(page.getByText("跳过了：太晚了，下次再去").first()).toBeAttached();
  // its time, place and clue faded as on the day page (her call); the reason line not; the band counts 5 stops
  const skTime = page.getByTestId("route-skipped-time-16").filter({ visible: true }).first();
  await skTime.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  expect(Number(await skTime.evaluate((e) => getComputedStyle(e).opacity))).toBeCloseTo(0.45, 2);
  expect(Number(await page.getByText("跳过了：太晚了，下次再去").first().evaluate((e) => getComputedStyle(e).opacity))).toBe(1);
  if (info.project.name === "phone-390") await page.screenshot({ path: `${RUNS}/skip-route-row.png` });
  const band = page.getByTestId("route-band-stops").filter({ visible: true }).first();
  await band.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await expect(band).toHaveText("05");                                     // 6 stops, one skipped
  await expect(page.getByText(/· 5 STOPS$/).first()).toBeAttached();        // and the page's head line
  if (info.project.name === "phone-390") await page.screenshot({ path: `${RUNS}/skip-route-stops.png` });

  // back through the package's own history, never out of it: the box → the day → … → home
  for (let k = 0; k < 6 && !/\/ephemera(\?|$)/.test(new URL(page.url()).pathname + "?"); k++) {
    await tapLabel(page, "返回");
    await settle(page, 1300);
  }
  await shot(page, "19-back-home");
  expect(new URL(page.url()).pathname).toMatch(/\/app\/ephemera$/);
  expect(errors).toEqual([]);
  expect(undef).toEqual([]);
});
