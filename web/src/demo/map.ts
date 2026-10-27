// The demo's map: a small invented town drawn procedurally (no map data from anywhere), in the same JSON shape
// the engine's map renderer returns (layers of SVG path strings + stops + legs in the same pixel space).
const W = 900, H = 900;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function town() {
  const rnd = seeded(7);
  const major: string[] = [], minor: string[] = [], tiny: string[] = [], rail: string[] = [], river: string[] = [], water: string[] = [], park: string[] = [];
  // a river from the north-east bending to the south
  river.push(`M${W} 120 C 700 220, 640 420, 700 560 S 820 820, 760 ${H}`);
  // avenues and streets on a slightly irregular grid
  for (let i = 0; i <= 9; i++) {
    const x = i * 100 + (rnd() - 0.5) * 24, y = i * 100 + (rnd() - 0.5) * 24;
    (i % 3 === 0 ? major : minor).push(`M${x.toFixed(1)} 0 L${(x + (rnd() - 0.5) * 40).toFixed(1)} ${H}`);
    (i % 3 === 1 ? major : minor).push(`M0 ${y.toFixed(1)} L${W} ${(y + (rnd() - 0.5) * 40).toFixed(1)}`);
  }
  for (let i = 0; i < 40; i++) {
    const x = rnd() * W, y = rnd() * H, len = 40 + rnd() * 80;
    tiny.push(rnd() > 0.5 ? `M${x.toFixed(1)} ${y.toFixed(1)} h${len.toFixed(1)}` : `M${x.toFixed(1)} ${y.toFixed(1)} v${len.toFixed(1)}`);
  }
  rail.push(`M0 260 C 200 250, 260 300, 420 290 S 700 230, ${W} 200`);
  park.push("M120 560 h150 v120 h-150 Z", "M520 120 h110 v90 h-110 Z");
  water.push("M600 700 c40 -30 90 -10 90 30 c0 40 -60 60 -90 30 Z");
  return { major, minor, tiny, motor: [] as string[], rail, river, water, park };
}

type DemoStop = { n: number; place: { lat: number | null; lng: number | null } | null; no_place?: boolean };

/** lat/lng in the demo are just 0..1 positions in the invented town. */
export function demoMap(stops: DemoStop[]) {
  const xy = (p: { lat: number | null; lng: number | null }) => [Math.round((p.lng ?? 0) * W), Math.round((p.lat ?? 0) * H)] as [number, number];
  const vis = stops.filter((s) => s.place && s.place.lat != null && !s.no_place);
  const pts = vis.map((s) => ({ n: s.n, x: xy(s.place!)[0], y: xy(s.place!)[1], covered: true }));
  const legs = vis.slice(1).map((s, k) => {
    const a = xy(vis[k].place!), b = xy(s.place!);
    const mid: [number, number] = [a[0], b[1]];                 // walk along the grid: one corner
    const m = Math.round(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) * 2;
    return { n: s.n, mode: "walk", kind: "walk" as const, pts: [a, mid, b], meters: m, minutes: Math.max(1, Math.ceil(m / 75)),
      reason: null, reason_text: null, straight_m: null, schematic: false, unverified_connector_m: null, search_margin_m: null };
  });
  const walk = legs.reduce((t, l) => t + l.meters, 0);
  return {
    W, H, layers: town(), stops: pts, legs, walk_paths: [],
    stats: { walk_m: walk, walk_minutes: legs.reduce((t, l) => t + l.minutes, 0), walk_legs_without_network: 0, transit_legs: 0, speed_kmh: 4.5 },
    area: "RIVERSIDE", attribution: "试玩地图 · 虚构的小镇", basemap: null, fill_rule: "evenodd",
  };
}
