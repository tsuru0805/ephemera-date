// End-to-end runs against the exported site (npm run build first). Videos and screenshots go to
// EPHEMERA_RUNS (default /tmp/ephemera-web-runs), never into the repository.
import { defineConfig } from "@playwright/test";

const RUNS = process.env.EPHEMERA_RUNS ?? "/tmp/ephemera-web-runs";
const PORT = Number(process.env.EPHEMERA_E2E_PORT ?? 18790);

export default defineConfig({
  testDir: "e2e",
  outputDir: `${RUNS}/artifacts`,
  timeout: 300_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    video: "on",
    screenshot: "on",
    trace: "off",
  },
  projects: [
    { name: "phone-390", use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
    { name: "tablet-768", use: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
  ],
  webServer: [
    { command: `node scripts/serve.mjs dist --port ${PORT} --base /app${process.env.EPHEMERA_ENGINE ? ` --engine ${process.env.EPHEMERA_ENGINE}` : ""}`, port: PORT, reuseExistingServer: true },
    // the iframe host example, on another origin (another port) than the page
    { command: `node scripts/serve.mjs examples --port ${PORT + 2} --base /ex`, port: PORT + 2, reuseExistingServer: true },
    // opt-in: the development server with the default base /app (e2e/dev.spec.ts)
    ...(process.env.EPHEMERA_E2E_DEV ? [{ command: "CI=1 BROWSER=none npx expo start --web --port 18800", port: 18800, reuseExistingServer: true, timeout: 180_000 }] : []),
  ],
});
