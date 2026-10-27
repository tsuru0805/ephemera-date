// The backfill draft keeps its photos across a reload (bytes in IndexedDB); when the bytes are gone, the rows say
// 「刷新后照片要重新选」 instead of showing a dead photo. Runs in the demo (the draft lives in the browser either way).
import { test } from "@playwright/test";
import { expect, nameRun, pickPhotoInBrowser, settle, shot, tapLabel } from "./helpers";

test("backfill draft photos survive a reload; without the bytes the rows ask again", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough");
  nameRun(page, "draft-reload");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/app/?demo=0");
  await page.goto("/app/?demo=1");
  await settle(page, 1200);
  await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase("ephemera"); });
  await page.goto("/app/ephemera-backfill");
  await settle(page, 1500);
  await page.getByTestId("bf-title-0").filter({ visible: true }).first().fill("河边");
  // a photo for the first stop, and one photo of the day
  await tapLabel(page, "第 1 站的卡套");
  await settle(page, 800);
  await pickPhotoInBrowser(page, () => tapLabel(page, "选一张照片"));
  await settle(page, 900);
  await tapLabel(page, "按住往下推,放进卡套");
  await settle(page, 900);
  await tapLabel(page, "收好");
  await settle(page, 1000);
  await pickPhotoInBrowser(page, () => page.getByTestId("bf-day-add").filter({ visible: true }).first().click(), 800, 1200);
  await settle(page, 1500);                                   // the draft is saved 400 ms after the last change
  await shot(page, "01-before-reload");

  await page.reload();
  await settle(page, 2500);
  await expect(page.getByTestId("bf-day-0").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("刷新后照片要重新选")).toHaveCount(0);
  const ok = await page.getByTestId("bf-day-0").filter({ visible: true }).first().locator("img").evaluateAll((imgs) => imgs.some((i) => (i as HTMLImageElement).naturalWidth > 0));
  expect(ok).toBe(true);
  await shot(page, "02-after-reload");

  // the bytes are gone (another browser profile, storage cleared …): say so, no dead photo
  await page.evaluate(() => new Promise<void>((r) => { const q = indexedDB.deleteDatabase("ephemera"); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await settle(page, 2500);
  await expect(page.getByTestId("bf-day-lost").filter({ visible: true })).toHaveText("刷新后照片要重新选");
  await expect(page.getByTestId("row-err-0").filter({ visible: true })).toHaveText("刷新后照片要重新选");
  await expect(page.getByTestId("bf-day-0")).toHaveCount(0);
  await expect(page.getByText(/Failed to fetch|TypeError/)).toHaveCount(0);
  await shot(page, "03-bytes-gone");
  expect(errors).toEqual([]);
});
