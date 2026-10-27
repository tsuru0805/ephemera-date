// Ephemera:约会数据 → 页面上要排的字。纯函数,有单测。
// 原则:页面只摆投影里有的东西,没有的格子不编。
import { type HerState, type Leg, type MapData, type Plan, type PrepItem, prepMarkKey, type Preparing, type PreparingWhat, type Stop } from "../../lib/ephemeraApi";
import { asKind, type StopKind } from "./icons";
import type { ArtName } from "./components";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function titleLines(p: Pick<Plan, "title_en">): [string, string] {
  const [a, ...b] = (p.title_en || "").split("\n");
  return [a ?? "", b.join(" ")];
}
export const titleOne = (p: Pick<Plan, "title_en">) => titleLines(p).filter(Boolean).join(" ");
/** 中文名:有就返回(去掉首尾空白),没有=null——没有就什么都不显示;有就永远是英文名底下的小字 */
export const titleZh = (p: Pick<Plan, "title_zh">): string | null => (p.title_zh ?? "").trim() || null;
/** 中文名一行排得下:按全角字宽 1em + 字距 k·em 估宽;放不下按比例缩字号,到下限 min 还放不下就截短、末格「⋯」 */
export function fitZh(text: string, base: number, min: number, k: number, width: number): { text: string; size: number } {
  const cs = [...text], per = 1 + k;
  if (cs.length * base * per <= width) return { text, size: base };
  const s = width / (cs.length * per);
  if (s >= min) return { text, size: Math.floor(s * 10) / 10 };
  const m = Math.max(1, Math.floor(width / (min * per)));
  return { text: cs.slice(0, m - 1).join("") + "⋯", size: min };
}

/** 中文名竖排(书脊):一字一行 */
export const vertical = (s: string) => [...s].join("\n");

export function dateParts(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const mm = String(m).padStart(2, "0"), dd = String(d).padStart(2, "0");
  return { y, m, d, mm, dd, mon: MON[m - 1], dow, slash: `${mm} / ${dd}`, dot: `${mm}.${dd}`, long: `${y}.${mm}.${dd}`, md: `${m}/${d}` };
}

export const paperNo = (p: Pick<Plan, "paper_no" | "id">) => p.paper_no || String(p.id).padStart(4, "0");
export const two = (i: number) => String(i + 1).padStart(2, "0");

/** 每种站用哪种纸品(原型只画了四种;后来新加的四种先借最接近的那种) */
// 纸品:原型四种 + 「买东西单独画」的购物小票;咖啡/展望台/神社借最近的
export type Paper4 = "train" | "dinner" | "cinema" | "walk" | "shop";
// 新大类的当天检票纸(检票动作沿用同族;暖帘/房卡/纸条借最接近的):
// 门票类 live/museum/aquarium/amusement/play → 电影票(撕副券);菜单类 sweets/bar → 菜单(翻开);信封类 park → 散步(展开);
//   onsen 暖帘 → 菜单(掀开=翻开);stay 房卡 → 购物小票(刷一下=扫一下);moment 小纸条 → 散步(展开)
export const PAPER_OF: Record<StopKind, Paper4> = {
  train: "train", dinner: "dinner", cinema: "cinema", walk: "walk",
  cafe: "dinner", viewpoint: "walk", shopping: "shop", shrine: "walk",
  sweets: "dinner", bar: "dinner", live: "cinema", museum: "cinema", aquarium: "cinema", amusement: "cinema", play: "cinema",
  park: "walk", onsen: "dinner", stay: "shop", moment: "walk",
};
// 固定画(没有每站现画时):新大类各有自己的一张;
// 一件事没有单独一张:按站编号在五张小事里固定挑(artOf);整盒的主图(只知道种类不知道站)用第一张
export const ART_OF: Record<StopKind, ArtName> = {
  train: "sc_station", dinner: "sc_bistro", cinema: "sc_cinema", walk: "sc_tonight",
  cafe: "sc_cafe", viewpoint: "sc_moon", shopping: "sc_shop", shrine: "sc_shrine",
  sweets: "sc_sweets", bar: "sc_bar", live: "sc_live", museum: "sc_exhibition", aquarium: "sc_aquarium",
  amusement: "sc_amusement", play: "sc_play", park: "sc_park", onsen: "sc_onsen", stay: "sc_stay", moment: "sc_moment_flowers",
};
/** 一件事的五张小事,顺序和引擎 date_art.MOMENT_VARIANTS 一致(花/碰杯/票根/丝带/星星) */
export const MOMENT_ART: readonly ArtName[] = ["sc_moment_flowers", "sc_moment_cups", "sc_moment_ticket", "sc_moment_ribbon", "sc_moment_star"];
/** the spare fixed pictures shipped with the page: two more per kind (art_fixed "<kind>_2" / "<kind>_3") */
const SPARE_ART = /^(train|dinner|cinema|walk|cafe|viewpoint|shopping|shrine)_[23]$/;
/** 这一站的固定画:一件事按站编号挑,选法同引擎 style_name(stop_id % 5;编号缺=0,负数照 Python 取模落在 0..4) */
export function artOf(s: Pick<Stop, "kind" | "stop_id"> & { art_fixed?: string | null }): ArtName {
  // the engine picks a fixed picture per stop (rotating spares by stop id): use it when the page has that picture
  const fx = s.art_fixed;
  if (fx && fx !== s.kind) {
    const name = (fx.startsWith("moment_") ? `sc_${fx}` : `x_${fx}`) as ArtName;
    if (fx.startsWith("moment_") ? (MOMENT_ART as readonly string[]).includes(name) : SPARE_ART.test(fx)) return name;
  }
  const k = asKind(s.kind);
  if (k !== "moment") return ART_OF[k];
  const n = MOMENT_ART.length, id = Math.trunc(Number(s.stop_id) || 0);
  return MOMENT_ART[((id % n) + n) % n];
}
/** 中文名(权威=引擎种类表 kinds.ts;这里只给旧调用点) */
export const KIND_ZH: Record<StopKind, string> = {
  train: "集合 · 出发", dinner: "晚餐", cinema: "电影", walk: "散步",
  cafe: "咖啡", viewpoint: "展望台", shopping: "买东西", shrine: "神社",
  sweets: "甜品·面包", bar: "酒吧", live: "演出·Live", museum: "看展", aquarium: "水族馆·动物园", amusement: "游乐园",
  play: "玩乐", park: "公园", onsen: "温泉", stay: "住宿", moment: "一件事",
};
/** 纸品上的英文字(花体/打字机体那种,非「站名上面那行小字」——那行用 kinds.ts kindLine) */
export function kindEn(s: Pick<Stop, "kind" | "time">): string {
  const k = asKind(s.kind);
  const night = !!s.time && Number(s.time.slice(0, 2)) >= 18;
  return ({ train: "Meeting point", dinner: "Dinner", cinema: "Screening", walk: night ? "Night walk" : "Walk",
    cafe: "Café", viewpoint: "Viewpoint", shopping: "Shopping", shrine: "Shrine",
    sweets: "Sweets", bar: "Bar", live: "Live", museum: "Museum", aquarium: "Aquarium", amusement: "Amusement park",
    play: "Play", park: "Park", onsen: "Hot spring", stay: "Stay", moment: "Something we did" } as Record<StopKind, string>)[k];
}
export const kindOf = (s: Pick<Stop, "kind">) => asKind(s.kind);
export const paperOf = (s: Pick<Stop, "kind">) => PAPER_OF[asKind(s.kind)];

/** 站在页面上的三态:检过票 done / 到点可以拆 now / 还没到 locked(到点只认引擎下发的 arrive_at) */
export type StopState = "done" | "now" | "locked" | "skipped";
export function stopState(s: Stop, checked: boolean, nowSec: number, live: boolean): StopState {
  if (s.skipped) return "skipped";   // 他跳过的站(检过票后才跳过也照样标「跳过了」,不算进度)
  if (checked) return "done";
  if (live && typeof s.arrive_at === "number" && nowSec >= s.arrive_at) return "now";
  return "locked";
}

/** 这一站有没有地点:引擎标了 no_place,或者没有坐标 = 一件事、没有固定地点。
 *  这种站不画地图点、不给「在地图里打开」、不显示地址行;卡套照它的种类走 */
export const hasPlace = (s: Pick<Stop, "place" | "no_place">) => !s.no_place && s.place?.lat != null && s.place?.lng != null;
/** 地址行:没有地点的站不显示 */
export const addressOf = (s: Pick<Stop, "place" | "no_place">) => (hasPlace(s) ? s.place?.address || null : null);

/** 站名(地点名去掉「·」后半段,原型 title.split('·')[0]) */
export const placeName = (s: Stop) => (s.place?.title ?? "").split("·")[0].trim();

const MODE_ZH: Record<string, string> = { walk: "步行", train: "坐电车", subway: "坐地铁", bus: "坐公交", taxi: "坐出租车", other: "其他方式" };
/** 「怎么去」一句:他写的一句话优先;没有就按交通方式+分钟拼(同引擎 leg_phrase 的形) */
export function legLine(leg: Leg | null | undefined, howToGet?: string | null): string | null {
  if (howToGet) return howToGet;
  if (!leg) return null;
  const head = MODE_ZH[leg.mode ?? "other"] ?? "其他方式";
  const base = leg.minutes ? `${head}约 ${leg.minutes} 分钟` : head;
  return leg.summary ? `${leg.summary} · ${base}` : base;
}

export const PREP_SECTIONS: Array<{ key: PrepItem["section"]; en: string; zh: string }> = [
  { key: "book", en: "Book ahead", zh: "提前准备" },
  { key: "wear", en: "Wear", zh: "穿什么" },
  { key: "bring", en: "Bring", zh: "带什么" },
  { key: "weather", en: "Weather", zh: "天气" },
];
export function prepGroups(prep: PrepItem[]) {
  return PREP_SECTIONS.map((s) => ({ ...s, items: prep.filter((p) => p.section === s.key) })).filter((g) => g.items.length);
}
/** 天气一栏是「看一眼」的信息,不打勾(原型 info 行) */
export const isCheckable = (it: PrepItem) => it.section !== "weather";
/** 首页小纸包:要勾的有几样、还差几样(她勾的记号在引擎,键同 PrepCard) */
export function prepLeft(prep: PrepItem[], her: Pick<HerState, "marks"> | null): { total: number; left: number } {
  const keys = prep.filter(isCheckable).map(prepMarkKey);
  return { total: keys.length, left: keys.filter((k) => !her?.marks[k]).length };
}

/** 那一句话拆两行(票根上小字两行、契约书上大字分行):按逗号拆 */
export function quoteParts(q: string | null | undefined): string[] {
  if (!q) return [];
  const t = q.replace(/[“”"「」]/g, "").trim();
  const parts = t.split(/[,，]\s*/).filter(Boolean);
  return parts.length ? parts : [t];
}

export const stopsMain = (p: Plan): StopKind[] => p.stops.map((s) => asKind(s.kind));


// ── 准备中:只有进度,文字在这里拼 ────────────────────────────────────────
const DRAFT_WHAT: Record<PreparingWhat, (n: number) => string> = {
  stops: () => "站",
  stop_kind: (n) => `${n} 站的类型`,
  stop_time: (n) => `${n} 站的时间`,
  stop_title: (n) => `${n} 个地点名`,
  stop_address: (n) => `${n} 个地址`,
  stop_clue: (n) => `${n} 条线索`,
  first_reveal: () => "第 1 站的公开时间",
  legs: (n) => `${n} 段路线要重写`,
  prep: () => "准备清单",
  other: (n) => `${n} 项`,
};

export function missingLine(v: Preparing): string {
  const bits = v.missing.map((m) => DRAFT_WHAT[m.what]?.(m.count) ?? `${m.count} 项`);
  if (v.conflicts) bits.push(`${v.conflicts} 处时间要改`);
  return bits.join(" · ");
}

/** 他上次动笔:今天 / 昨天 / N 天前(按手机日历日算) */
export function touched(ts: number | null, nowMs = Date.now()): string {
  if (ts == null) return "—";
  const day = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000; };
  const n = Math.max(0, Math.round(day(nowMs) - day(ts * 1000)));
  return n === 0 ? "TODAY" : n === 1 ? "YESTERDAY" : `${n} DAYS AGO`;
}

export function draftRows(v: Preparing): Array<[string, string | boolean]> {
  const s = v.stops;
  return [
    ["Stops", s.count ? `${s.count} 站${s.complete < s.count ? ` · ${s.count - s.complete} 站没写完` : ""}` : "—"],
    ["Routes", v.legs ? `${v.legs} 段` : "—"],
    ["Packing list", v.prep ? `${v.prep} 类` : "—"],
    ["Contract", v.contract],
    ["Little card", v.card],
    ["Sketches", v.art.planned ? `${v.art.drawn} / ${v.art.planned}` : "—"],
  ];
}


// ── 约会海报 · 花体倒计时────────────────────────────────────────────
const WORDS = ["today", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
/** 离那天还有几天(按手机日历日;过了算 0) */
export function daysLeft(date: string, now = new Date()): number {
  const [y, m, d] = date.split("-").map(Number);
  const a = Date.UTC(y, m - 1, d), b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((a - b) / 86400000));
}
/** 底纹那个花体字:二十天以内写英文词,再远写数字 */
export function dayWord(n: number): string {
  return n < WORDS.length ? WORDS[n] : String(n);
}

/** 「走了多少公里」:没有记下的路(她补记的约会没有站到站怎么走 / 地图空)或不到 0.1 km → null=那一格不显示 */
export function walkKmText(m: MapData): string | null {
  if (m.empty) return null;
  const t = (m.stats.walk_m / 1000).toFixed(1);
  return t === "0.0" ? null : t;
}
