// The development server (`npm start`, base /app): CanvasKit and the service worker are served at the root there,
// and the page still comes up. Opt-in: EPHEMERA_E2E_DEV=1 starts the dev server (playwright.config.ts).
import { test } from "@playwright/test";
import { expect } from "./helpers";

test.skip(!process.env.EPHEMERA_E2E_DEV, "set EPHEMERA_E2E_DEV=1 to start the dev server");

test("dev server under /app: the demo home comes up", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:18800/app/?demo=1");
  await expect(page.getByTestId("demo-step")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Invitation Box")).toBeVisible();
  expect(errors).toEqual([]);
});
