// After `expo export`: font licences next to the fonts; for the demo build (GitHub Pages) a 404.html that is the app
// (Pages has no SPA fallback: a deep link or a reload on /ephemera-day must still load the page) and .nojekyll
// (Jekyll would drop the _expo/ folder). Fails the build if a source map slipped into the output.
// Usage: node scripts/postbuild.mjs <dir> [--demo]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const demo = process.argv.includes("--demo");
if (!dir || !existsSync(join(dir, "index.html"))) { console.error(`no export in ${dir}`); process.exit(1); }

mkdirSync(join(dir, "licenses"), { recursive: true });
copyFileSync("licenses/OFL-1.1.txt", join(dir, "licenses", "OFL-1.1.txt"));
copyFileSync("ASSETS.md", join(dir, "licenses", "ASSETS.md"));

if (demo) {
  copyFileSync(join(dir, "index.html"), join(dir, "404.html"));
  writeFileSync(join(dir, ".nojekyll"), "");
}

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(dir);
const maps = files.filter((f) => f.endsWith(".map"));
if (maps.length) { console.error("source maps in the output:", maps); process.exit(1); }
console.log(`postbuild ok: ${dir}${demo ? " (demo)" : ""}, ${files.length} files`);
