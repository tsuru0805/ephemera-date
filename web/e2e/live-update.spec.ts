// An open day page follows what he does on the day without being sent to the background and back: the AI skips a
// stop (and takes the skip back) over MCP; the page shows it by its own reading (every 30 s, as the home app; at
// once when the page's event watch sees a new event for that date, embedded).
import { test } from "@playwright/test";
import { ai, clearActive, HER_TOKEN, writeAndSend } from "./engine";
import { expect, RUNS, settle } from "./helpers";

test.skip(!process.env.EPHEMERA_ENGINE, "needs a running engine (EPHEMERA_ENGINE)");

test("day page: a stop skipped (and un-skipped) while it is open shows up by itself", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "one viewport is enough");
  test.setTimeout(180_000);
  const m = await ai();
  await clearActive(m);
  const plan = await writeAndSend(m);
  await page.goto("/app/?demo=0");
  await page.getByTestId("login-token").fill(HER_TOKEN);
  await page.getByTestId("login-enter").click();
  await settle(page, 1200);
  await page.goto(`/app/ephemera-day?id=${plan}`);
  await settle(page, 1500);
  const r = await page.request.get(`/api/dates/${plan}`, { headers: { Authorization: `Bearer ${HER_TOKEN}` } });
  const p = (await r.json()) as { plan?: { stops: Array<{ stop_id: number }> }; stops?: Array<{ stop_id: number }> };
  const stops = p.plan?.stops ?? p.stops ?? [];
  expect(stops.length).toBeGreaterThan(2);
  const out = await m.call("date_live", { plan, op: "skip", stop_id: stops[2].stop_id, reason: "雨太大，换个日子" });
  expect(out).toMatch(/跳过/);
  const t0 = Date.now();
  await expect(page.getByText("跳过了：雨太大，换个日子").filter({ visible: true }).first()).toBeVisible({ timeout: 40_000 });
  console.log(`[live] the skip showed after ${Math.round((Date.now() - t0) / 1000)} s (no background / foreground)`);
  await page.screenshot({ path: `${RUNS}/live-skip.png` });
  await m.call("date_live", { plan, op: "unskip", stop_id: stops[2].stop_id });
  await expect(page.getByText("跳过了：雨太大，换个日子")).toHaveCount(0, { timeout: 40_000 });
  await clearActive(m);
});
