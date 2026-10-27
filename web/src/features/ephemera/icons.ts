// Ephemera 小图标图库(原型 ICON 表逐个照搬:32 格网格、平涂、≤3 色、无白边厚影)。
// 颜色取地图页那套(随皮肤换);按站点类型取。cafe/viewpoint/shopping/shrine 是新画的四个。
import type { MapPal } from "./theme";
import { hashId } from "./shapes";

// 19 个大类,顺序同引擎 date_kinds.KIND_TABLE(App 的列表顺序从 GET /api/dates/kinds 取)。
export type StopKind = "train" | "dinner" | "cafe" | "sweets" | "bar" | "cinema" | "live" | "museum" | "aquarium" | "amusement"
  | "play" | "walk" | "park" | "viewpoint" | "shrine" | "shopping" | "onsen" | "stay" | "moment";
export const KINDS: StopKind[] = ["train", "dinner", "cafe", "sweets", "bar", "cinema", "live", "museum", "aquarium", "amusement",
  "play", "walk", "park", "viewpoint", "shrine", "shopping", "onsen", "stay", "moment"];
export const asKind = (k: string | null | undefined): StopKind => (KINDS.includes(k as StopKind) ? (k as StopKind) : "walk");

type IconName = StopKind | "tulip" | "moon";

export function icon(name: IconName, p: MapPal): string {
  const C = { cream: p.land, straw: p.street, lake: p.water, sage: p.park, wine: p.ink, berry: p.route, paper: p.card };
  switch (name) {
    case "train": return `<svg viewBox="0 0 32 32"><rect x="4" y="7" width="24" height="17" rx="5" fill="${C.berry}"/><rect x="4" y="16" width="24" height="2.4" fill="${C.wine}"/>
      <rect x="7.5" y="10" width="5" height="4.5" rx="1" fill="${C.cream}"/><rect x="13.5" y="10" width="5" height="4.5" rx="1" fill="${C.cream}"/><rect x="19.5" y="10" width="5" height="4.5" rx="1" fill="${C.cream}"/>
      <circle cx="10" cy="25.5" r="2.2" fill="${C.wine}"/><circle cx="22" cy="25.5" r="2.2" fill="${C.wine}"/><rect x="13" y="4" width="6" height="3" rx="1" fill="${C.wine}"/></svg>`;
    case "dinner": return `<svg viewBox="0 0 32 32"><path d="M10 5h12c0 7-2.4 11-6 11s-6-4-6-11z" fill="${C.berry}"/><path d="M11 9h10c-.3 3.6-2 6-5 6s-4.7-2.4-5-6z" fill="${C.wine}" opacity=".55"/>
      <rect x="15" y="15.5" width="2" height="9" fill="${C.wine}"/><rect x="10.5" y="24.5" width="11" height="2.4" rx="1.2" fill="${C.wine}"/></svg>`;
    case "cinema": return `<svg viewBox="0 0 32 32"><circle cx="10.5" cy="9" r="4.2" fill="${C.wine}"/><circle cx="19.5" cy="9" r="4.2" fill="${C.wine}"/><circle cx="10.5" cy="9" r="1.4" fill="${C.cream}"/><circle cx="19.5" cy="9" r="1.4" fill="${C.cream}"/>
      <rect x="5" y="13.5" width="19" height="11" rx="2.5" fill="${C.berry}"/><path d="M24 16.5l5-2.8v10.6l-5-2.8z" fill="${C.wine}"/><rect x="8" y="16.5" width="6" height="2" rx="1" fill="${C.cream}"/><rect x="11" y="24.5" width="3" height="4" fill="${C.wine}"/><rect x="16" y="24.5" width="3" height="4" fill="${C.wine}"/></svg>`;
    case "walk": return `<svg viewBox="0 0 32 32"><path d="M11 4c4 4 6 8 6 12 0 3.5-2.7 6-6 6s-6-2.5-6-6c0-4 2-8 6-12z" fill="${C.sage}"/><path d="M22 9c3 3 4.5 6 4.5 9 0 2.6-2 4.5-4.5 4.5S17.5 20.6 17.5 18c0-3 1.5-6 4.5-9z" fill="${C.berry}" opacity=".85"/>
      <rect x="10.2" y="17" width="1.6" height="10" fill="${C.wine}"/><rect x="21.2" y="20" width="1.6" height="7" fill="${C.wine}"/><rect x="5" y="27" width="22" height="1.6" rx=".8" fill="${C.wine}"/></svg>`;
    case "tulip": return `<svg viewBox="0 0 40 80"><path d="M20 30 C20 50 19 64 20 78" stroke="${C.sage}" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M20 60 C10 56 7 46 6 38 C14 41 19 49 20 60z" fill="${C.sage}"/><path d="M20 52 C29 49 33 41 34 33 C26 36 21 43 20 52z" fill="${C.sage}"/>
      <path d="M12 12 C12 24 16 30 20 30 C24 30 28 24 28 12 C25 16 23 16 20 9 C17 16 15 16 12 12z" fill="${C.berry}"/><path d="M20 9 C17 16 17 24 20 30 C23 24 23 16 20 9z" fill="${C.straw}"/></svg>`;
    case "moon": return `<svg viewBox="0 0 32 32"><path d="M20 5a11 11 0 1 0 7 19.5A12 12 0 0 1 20 5z" fill="${C.berry}"/></svg>`;
    case "cafe": return `<svg viewBox="0 0 32 32"><path d="M11 3.5c-1.6 2 1.6 3 0 5.2M15.5 3.5c-1.6 2 1.6 3 0 5.2" stroke="${C.wine}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <path d="M6.5 11.5h16v6.5c0 4.2-3.4 7.2-8 7.2s-8-3-8-7.2z" fill="${C.berry}"/><rect x="8" y="12" width="13" height="2.2" rx="1" fill="${C.wine}" opacity=".55"/>
      <path d="M22.5 13.5h2.3a3.2 3.2 0 0 1 0 6.4h-2.3" fill="none" stroke="${C.wine}" stroke-width="2"/><rect x="3.5" y="25.4" width="23" height="2.4" rx="1.2" fill="${C.wine}"/></svg>`;
    case "viewpoint": return `<svg viewBox="0 0 32 32"><rect x="15.3" y="2" width="1.4" height="5" fill="${C.wine}"/><path d="M14 6.5h4l3.2 19.5H10.8z" fill="${C.berry}"/>
      <rect x="9" y="9.5" width="14" height="4.5" rx="1.6" fill="${C.wine}"/><rect x="11" y="10.9" width="10" height="1.7" rx=".6" fill="${C.cream}"/>
      <path d="M13.2 19h5.6M12.6 22.5h6.8" stroke="${C.cream}" stroke-width="1.2"/><rect x="7" y="26" width="18" height="2.4" rx="1.2" fill="${C.wine}"/></svg>`;
    case "shopping": return `<svg viewBox="0 0 32 32"><path d="M12 11.5V9a4 4 0 0 1 8 0v2.5" stroke="${C.wine}" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M6.5 11h19l-1.6 16.5H8.1z" fill="${C.berry}"/><rect x="7.2" y="15" width="17.6" height="2.2" fill="${C.cream}" opacity=".9"/>
      <circle cx="12" cy="11.6" r="1.1" fill="${C.wine}"/><circle cx="20" cy="11.6" r="1.1" fill="${C.wine}"/></svg>`;
    case "shrine": return `<svg viewBox="0 0 32 32"><path d="M2.5 6.8c4.5 1.8 22.5 1.8 27 0v3.2c-4.5 1.5-22.5 1.5-27 0z" fill="${C.berry}"/>
      <rect x="6" y="13" width="20" height="2.2" fill="${C.berry}"/><rect x="8.4" y="9.6" width="2.6" height="17.6" fill="${C.berry}"/><rect x="21" y="9.6" width="2.6" height="17.6" fill="${C.berry}"/>
      <rect x="14.6" y="9.4" width="2.8" height="3.8" fill="${C.wine}"/><rect x="7.4" y="26.4" width="4.6" height="2" fill="${C.wine}"/><rect x="20" y="26.4" width="4.6" height="2" fill="${C.wine}"/></svg>`;
    // 新大类
    case "sweets": return `<svg viewBox="0 0 32 32"><path d="M6 15h20l-2 11H8z" fill="${C.berry}"/><path d="M6 15c0-5 4.5-8 10-8s10 3 10 8z" fill="${C.cream}" stroke="${C.wine}" stroke-width="1.2"/><circle cx="16" cy="5.5" r="2.2" fill="${C.berry}"/><rect x="6" y="18.5" width="20" height="2" fill="${C.wine}" opacity=".5"/></svg>`;
    case "bar": return `<svg viewBox="0 0 32 32"><path d="M5.5 6h21L16 17.5z" fill="${C.berry}"/><path d="M9 9.5h14L16 17z" fill="${C.wine}" opacity=".45"/><rect x="15" y="17" width="2" height="8" fill="${C.wine}"/><rect x="10" y="25" width="12" height="2.4" rx="1.2" fill="${C.wine}"/><circle cx="22" cy="5" r="2.4" fill="${C.sage}"/></svg>`;
    case "live": return `<svg viewBox="0 0 32 32"><rect x="11" y="3" width="10" height="15" rx="5" fill="${C.berry}"/><path d="M13 8h6M13 11h6" stroke="${C.cream}" stroke-width="1.2"/><path d="M8 14c0 5 3.6 8 8 8s8-3 8-8" fill="none" stroke="${C.wine}" stroke-width="1.8"/><rect x="15" y="22" width="2" height="4.5" fill="${C.wine}"/><rect x="10" y="26.5" width="12" height="2.2" rx="1.1" fill="${C.wine}"/></svg>`;
    case "museum": return `<svg viewBox="0 0 32 32"><path d="M3.5 11L16 4l12.5 7z" fill="${C.berry}"/><rect x="5" y="11" width="22" height="2.2" fill="${C.wine}"/><rect x="7" y="14" width="3" height="10" fill="${C.berry}"/><rect x="14.5" y="14" width="3" height="10" fill="${C.berry}"/><rect x="22" y="14" width="3" height="10" fill="${C.berry}"/><rect x="4" y="24.5" width="24" height="2.6" rx="1" fill="${C.wine}"/></svg>`;
    case "aquarium": return `<svg viewBox="0 0 32 32"><path d="M4 16c4-6 10-8 15-6 2 .8 4 2.4 5.5 4L29 10v12l-4.5-4c-1.5 1.6-3.5 3.2-5.5 4-5 2-11 0-15-6z" fill="${C.berry}"/><circle cx="10" cy="14.5" r="1.4" fill="${C.cream}"/><path d="M15 11c1.5 3 1.5 7 0 10" stroke="${C.wine}" stroke-width="1.2" fill="none" opacity=".6"/><circle cx="25" cy="5" r="1.3" fill="${C.lake}"/><circle cx="21.5" cy="3" r="1" fill="${C.lake}"/></svg>`;
    case "amusement": return `<svg viewBox="0 0 32 32"><circle cx="16" cy="13" r="9" fill="none" stroke="${C.berry}" stroke-width="2"/><path d="M16 4v18M7 13h18M9.6 6.6l12.8 12.8M22.4 6.6L9.6 19.4" stroke="${C.berry}" stroke-width="1"/><circle cx="16" cy="13" r="2" fill="${C.wine}"/><circle cx="16" cy="4" r="1.8" fill="${C.wine}"/><circle cx="25" cy="13" r="1.8" fill="${C.wine}"/><circle cx="7" cy="13" r="1.8" fill="${C.wine}"/><path d="M16 13l-6 14h12z" fill="${C.wine}" opacity=".85"/></svg>`;
    case "play": return `<svg viewBox="0 0 32 32"><rect x="4" y="10" width="24" height="13" rx="6.5" fill="${C.berry}"/><path d="M9.5 14v5M7 16.5h5" stroke="${C.cream}" stroke-width="1.8" stroke-linecap="round"/><circle cx="21" cy="15" r="1.6" fill="${C.cream}"/><circle cx="24" cy="18" r="1.6" fill="${C.wine}"/></svg>`;
    case "park": return `<svg viewBox="0 0 32 32"><circle cx="16" cy="11" r="8" fill="${C.sage}"/><circle cx="11" cy="14" r="4.5" fill="${C.sage}" opacity=".8"/><rect x="15" y="16" width="2" height="9" fill="${C.wine}"/><rect x="4" y="22" width="9" height="1.8" fill="${C.berry}"/><rect x="5" y="23.8" width="1.4" height="3" fill="${C.berry}"/><rect x="10.6" y="23.8" width="1.4" height="3" fill="${C.berry}"/><rect x="3" y="27" width="26" height="1.6" rx=".8" fill="${C.wine}"/></svg>`;
    case "onsen": return `<svg viewBox="0 0 32 32"><path d="M10 4c-2 2.5 2 3.5 0 6.5M16 3c-2 2.5 2 3.5 0 6.5M22 4c-2 2.5 2 3.5 0 6.5" stroke="${C.berry}" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M4 15h24c0 7-5 11-12 11S4 22 4 15z" fill="${C.berry}"/><rect x="4" y="15" width="24" height="2.4" fill="${C.wine}" opacity=".5"/></svg>`;
    case "stay": return `<svg viewBox="0 0 32 32"><rect x="3" y="15" width="26" height="8" rx="2" fill="${C.berry}"/><rect x="5" y="11" width="9" height="5" rx="2" fill="${C.cream}" stroke="${C.wine}" stroke-width="1"/><rect x="3" y="9" width="2.4" height="17" fill="${C.wine}"/><rect x="26.6" y="15" width="2.4" height="11" fill="${C.wine}"/></svg>`;
    case "moment": return `<svg viewBox="0 0 32 32"><path d="M16 3l2.6 7.4L26 13l-7.4 2.6L16 23l-2.6-7.4L6 13l7.4-2.6z" fill="${C.berry}"/><path d="M25 20l1.2 3.3 3.3 1.2-3.3 1.2L25 29l-1.2-3.3-3.3-1.2 3.3-1.2z" fill="${C.wine}"/></svg>`;
  }
}

/** 盒子封标:平涂扇边圆标,中间是这次约会主站的图标(主站=电影>晚餐>第一站,原型同) */
export function mainKind(kinds: StopKind[]): StopKind {
  return kinds.find((k) => k === "cinema") ?? kinds.find((k) => k === "dinner") ?? kinds[0] ?? "walk";
}
const MARK_OF: Partial<Record<StopKind, IconName>> = { walk: "moon" };

export function boxMarkXml(o: { no: string; d: string; kinds: StopKind[] }, size: number, withText: boolean, p: MapPal): string {
  const R = 46, n = 22;
  let d = "";
  for (let k = 0; k <= n * 2; k++) {
    const t = (k / (n * 2)) * Math.PI * 2, r = k % 2 ? R : R + 3.2;
    d += (k ? "L" : "M") + (50 + r * Math.cos(t)).toFixed(2) + " " + (50 + r * Math.sin(t)).toFixed(2);
  }
  const mk = mainKind(o.kinds);
  const ic = icon(MARK_OF[mk] ?? mk, p).replace(/<\/?svg[^>]*>/g, "");
  const id = "bm" + hashId(o.no + size + String(withText));
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}">
    <path d="${d}Z" fill="${withText ? p.card : p.route}" ${withText ? `stroke="${p.ink}" stroke-width=".7"` : ""}/>
    <circle cx="50" cy="50" r="${withText ? 38 : 34}" fill="${p.card}" ${withText ? `stroke="${p.ink}" stroke-width="1"` : ""}/>
    <circle cx="50" cy="50" r="${withText ? 34.5 : 30.5}" fill="none" stroke="${withText ? p.ink : p.route}" stroke-width="${withText ? 0.5 : 1.4}"/>
    ${withText ? `<defs><path id="${id}" d="M50 50 m-25.5 0 a25.5 25.5 0 1 1 51 0 a25.5 25.5 0 1 1 -51 0"/></defs>
      <text font-family="EphemeraDisplay-Bold" font-size="6.6" letter-spacing="1.6" fill="${p.ink}"><textPath href="#${id}">NO. ${o.no} · KEPT FOR TWO · ${o.d} ·</textPath></text>
      <g transform="translate(36 36) scale(.875)">${ic}</g>`
    : `<g transform="translate(30 30) scale(1.25)">${ic}</g>`}</svg>`;
}
