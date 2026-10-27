// Start-up: the sign-in screen is up before Skia's WebAssembly arrives; if the WebAssembly cannot load, a readable
// line instead of a blank page; the demo then works once it is in.
import { test } from "@playwright/test";
import { expect, nameRun, shot } from "./helpers";

test("sign-in shows before CanvasKit; a failed CanvasKit is a readable line", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough");
  nameRun(page, "boot");
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/canvaskit.wasm", async (route) => { await held; await route.continue(); });
  await page.goto("/app/?demo=0");
  await expect(page.getByTestId("login-token")).toBeVisible({ timeout: 15_000 });   // wasm still held back
  await shot(page, "01-login-before-wasm");
  release();

  // demo: pages wait for CanvasKit with one line, then appear
  const page2 = await page.context().newPage();
  let release2: () => void = () => {};
  const held2 = new Promise<void>((r) => { release2 = r; });
  await page2.route("**/canvaskit.wasm", async (route) => { await held2; await route.continue(); });
  await page2.goto("/app/?demo=1");
  await expect(page2.getByTestId("skia-wait")).toHaveText("正在打开…", { timeout: 15_000 });
  release2();
  await expect(page2.getByTestId("demo-step")).toBeVisible({ timeout: 20_000 });

  // CanvasKit cannot load: a readable sentence, no crash
  const page3 = await page.context().newPage();
  const errors: string[] = [];
  page3.on("pageerror", (e) => errors.push(e.message));
  await page3.route("**/canvaskit.wasm", (route) => route.abort());
  await page3.goto("/app/?demo=1");
  await expect(page3.getByTestId("skia-wait")).toHaveText("页面没能打开：绘图组件没有加载成功。检查一下网络，再刷新试试", { timeout: 20_000 });
  expect(errors).toEqual([]);
});
