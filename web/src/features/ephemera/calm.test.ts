// Pops, turns and lights come to rest without overshooting (as the home app): the curve never passes its end, and no
// page pops anything with a spring or an overshooting curve any more. Letting go (a piece springing back to its place)
// and the stamps (postmark, fingerprint, seal, punch) keep theirs — not in her list.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { CALM_CURVE, POP_MS } from "./calm";

/** y of a CSS cubic-bezier at x (by bisection on the x curve). */
function bezierY([x1, y1, x2, y2]: readonly number[], x: number): number {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0, hi = 1;
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (at(x1, x2, m) < x) lo = m; else hi = m; }
  return at(y1, y2, (lo + hi) / 2);
}

describe("calm: the pops stop at their end", () => {
  it("easeOutQuint, never past 1, fast first", () => {
    expect(CALM_CURVE).toEqual([0.22, 1, 0.36, 1]);
    let max = 0;
    for (let x = 0; x <= 1.0001; x += 0.01) max = Math.max(max, bezierY(CALM_CURVE, Math.min(1, x)));
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    expect(bezierY(CALM_CURVE, 0.25)).toBeGreaterThan(0.7);   // most of the way in the first quarter
    expect(POP_MS).toBe(420);
  });
  it("no page pops to 1 with a spring, and no overshooting curve outside the stamps", () => {
    const dir = __dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
    const springsTo1: string[] = [], overshoot: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      if (/withSpring\(\s*1\b/.test(src)) springsTo1.push(f);
      for (const m of src.matchAll(/Easing\.bezier\(([^)]*)\)/g)) {
        const [, y1, , y2] = m[1].split(",").map(Number);
        if (y1 > 1 || y2 > 1) overshoot.push(`${f}: ${m[1]}`);
      }
    }
    expect(springsTo1).toEqual([]);
    // the stamps' landing (postmarks, the menu's bon appétit, the fingerprint, the top-secret stamp, the sleeve's seal) keep their thump
    const STAMPS = /^((Tickets|InviteScreen|BoxScreen)\.tsx: 0\.6, -0\.4, 0\.7, 1\.4|Sleeves\.tsx: 0\.6, -0\.3, 0\.7, 1\.3)$/;   // + the sleeve's postmark
    expect(overshoot.filter((o) => !STAMPS.test(o))).toEqual([]);
  });
});
