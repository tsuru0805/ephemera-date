// Tests run the pages under jest-expo with test renderers; the web-only pieces are stubbed per test where needed.
// sessionStorage/localStorage exist in browsers; give node a small in-memory one so the session code runs as-is.
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
// (newer Node has a half-working global localStorage without --localstorage-file: replace it too)
for (const k of ["localStorage", "sessionStorage"]) {
  let ok = false;
  try { ok = typeof globalThis[k]?.getItem === "function" && typeof globalThis[k]?.clear === "function"; } catch { ok = false; }
  if (!ok) Object.defineProperty(globalThis, k, { value: mem(), configurable: true, writable: true });
}
// The page tests were written against a place service that searches as you type; the engine's default (OSM) does
// not (press 「搜索」). Tests that cover the press-to-search mode set it themselves (placeSearchManual.test.tsx).
const session = require("./src/runtime/session");
session.__setSession({ config: session.mergeConfig({ place_service: { available: true, provider: "test", supports_autocomplete: true } }) });
