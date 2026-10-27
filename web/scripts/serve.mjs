// Serve an export for local testing: the site under its base path with SPA fallback (any page path → index.html),
// and optionally /api, /context, /mcp proxied to a running engine (same origin, like `ephemera-date serve` will).
// Usage: node scripts/serve.mjs <dir> [--port 18790] [--base /app] [--engine http://127.0.0.1:8770]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = args[0] ?? "dist";
const port = Number(opt("--port", "18790"));
const base = opt("--base", "/app").replace(/\/+$/, "");
const engine = opt("--engine", "");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".map": "application/json" };

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (engine && /^\/(api|context|mcp)(\/|$)/.test(url.pathname)) {
    const t = new URL(engine);
    const p = request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: `${t.hostname}:${t.port}` } }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    p.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(p);
    return;
  }
  if (url.pathname === "/" || url.pathname === "") { res.writeHead(302, { Location: `${base}/` }); res.end(); return; }
  if (!url.pathname.startsWith(base + "/") && url.pathname !== base) { res.writeHead(404); res.end(); return; }
  const rel = normalize(decodeURIComponent(url.pathname.slice(base.length))).replace(/^(\.\.[/\\])+/, "");
  let file = join(dir, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html");   // SPA fallback
  const ext = extname(file);
  res.writeHead(200, { "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`serving ${dir} at http://127.0.0.1:${port}${base}/`));
