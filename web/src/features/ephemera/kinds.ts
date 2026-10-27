// 站的种类 = 19 个大类 + 细类。
// 权威 = 引擎 GET /api/dates/kinds(date_kinds.KIND_TABLE);App 一律从那里拿,不在前端各处硬抄。
// 网络失败时用这里打包的一份兜底副本(KINDS_FALLBACK,与引擎 date-kinds 分支逐字一致;
// 测试 kinds288.test 核它与端点形状相同)。拿到端点的值后存进模块缓存,页面同步读。
import { useEffect, useSyncExternalStore } from "react";
import { ephemeraApi } from "../../lib/ephemeraApi";
import { asKind, type StopKind } from "./icons";

/** 同一类按这一站的时间换名字:
 *  time < before → zh/en,否则(含没填时间)→ else_zh/else_en。只 dinner 有。 */
export type ByTime = { before: string; zh: string; en: string; else_zh: string; else_en: string };
export type KindDef = { kind: string; zh: string; en: string; subtypes: string[]; custom: boolean; no_place: boolean; by_time?: ByTime };
export type KindsPayload = { kinds: KindDef[]; subtype_max: number };
export const MOMENT = "moment";

const T = (kind: string, zh: string, en: string, subtypes: string[]): KindDef =>
  ({ kind, zh, en, subtypes, custom: kind !== MOMENT, no_place: kind === MOMENT });
/** 兜底副本(引擎 date_kinds.KIND_TABLE) */
export const KINDS_FALLBACK: KindsPayload = {
  kinds: [
    T("train", "集合", "MEETING POINT", ["车站", "地铁站", "巴士站", "路口", "店门口"]),
    { ...T("dinner", "午餐 / 晚餐", "LUNCH / DINNER", ["餐馆", "拉面", "寿司", "烤肉", "居酒屋", "定食", "意大利菜", "法餐", "中餐", "韩餐"]),
      by_time: { before: "16:30", zh: "午餐", en: "LUNCH", else_zh: "晚餐", else_en: "DINNER" } },
    T("cafe", "咖啡", "CAFÉ", ["咖啡馆", "茶馆", "喫茶店", "早午餐"]),
    T("sweets", "甜品·面包", "SWEETS", ["甜品店", "面包店", "冰淇淋", "和果子", "蛋糕店"]),
    T("bar", "酒吧", "BAR", ["酒吧", "红酒吧", "精酿", "居酒屋二次会", "夜景酒廊"]),
    T("cinema", "电影", "SCREENING", ["电影院", "迷你影院"]),
    T("live", "演出·Live", "LIVE", ["Live house", "剧场", "音乐会", "演唱会", "落语·曲艺"]),
    T("museum", "看展", "MUSEUM", ["美术馆", "博物馆", "画廊", "特展", "科学馆"]),
    T("aquarium", "水族馆·动物园", "AQUARIUM & ZOO", ["水族馆", "动物园", "植物园", "猫咖·动物咖啡"]),
    T("amusement", "游乐园", "AMUSEMENT PARK", ["主题乐园", "游乐园", "摩天轮"]),
    T("play", "玩乐", "PLAY", ["卡拉OK", "游戏厅", "保龄球", "密室逃脱", "桌游"]),
    T("walk", "散步", "WALK", ["街道", "河边", "海边", "商店街"]),
    T("park", "公园", "PARK", ["公园", "庭园", "赏花", "赏枫"]),
    T("viewpoint", "展望台", "VIEWPOINT", ["展望台", "夜景", "观景塔"]),
    T("shrine", "神社", "SHRINE", ["神社", "寺庙", "教会"]),
    T("shopping", "买东西", "SHOPPING", ["商场", "服装", "眼镜店", "书店", "文具", "杂货", "花店", "超市"]),
    T("onsen", "温泉", "HOT SPRING", ["温泉", "钱汤", "SPA", "桑拿"]),
    T("stay", "住宿", "STAY", ["酒店", "旅馆", "民宿"]),
    T(MOMENT, "一件事", "SOMETHING WE DID", []),
  ],
  subtype_max: 12,
};

/** 端点回来的东西形状对不对(不对=当没拿到,用兜底) */
export function parseKinds(x: unknown): KindsPayload | null {
  if (!x || typeof x !== "object") return null;
  const r = x as { kinds?: unknown; subtype_max?: unknown };
  if (!Array.isArray(r.kinds) || !r.kinds.length || typeof r.subtype_max !== "number" || r.subtype_max <= 0) return null;
  const kinds: KindDef[] = [];
  for (const k of r.kinds) {
    const d = k as Partial<KindDef>;
    if (typeof d.kind !== "string" || typeof d.zh !== "string" || typeof d.en !== "string" || !Array.isArray(d.subtypes)
      || !d.subtypes.every((x) => typeof x === "string") || typeof d.custom !== "boolean" || typeof d.no_place !== "boolean") return null;
    const bt = parseByTime((k as { by_time?: unknown }).by_time);
    if (bt === undefined) return null;
    kinds.push({ kind: d.kind, zh: d.zh, en: d.en, subtypes: d.subtypes as string[], custom: d.custom, no_place: d.no_place, ...(bt ? { by_time: bt } : {}) });
  }
  return { kinds, subtype_max: r.subtype_max };
}

/** null=没有这个字段;undefined=有但形状不对(整份当没拿到) */
function parseByTime(x: unknown): ByTime | null | undefined {
  if (x == null) return null;
  const b = x as Partial<ByTime>;
  const ok = typeof b.before === "string" && minutesOf(b.before) != null
    && [b.zh, b.en, b.else_zh, b.else_en].every((v) => typeof v === "string" && v.length > 0);
  return ok ? { before: b.before!, zh: b.zh!, en: b.en!, else_zh: b.else_zh!, else_en: b.else_en! } : undefined;
}
/** "HH:MM" 或草稿里的四位数字 "HHMM" → 分钟;认不出 = null */
export function minutesOf(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):?(\d{2})$/.exec((t ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}
/** 这一站的大类叫什么(中/英):按时间换名的类(晚餐)看 time,其余=表里的名字 */
export function kindNames(k: string | null | undefined, time?: string | null): { zh: string; en: string } {
  const d = kindDef(k) ?? kindDef(asKind(k));
  if (!d) return { zh: "", en: "" };
  if (!d.by_time) return { zh: d.zh, en: d.en };
  const t = minutesOf(time), b = minutesOf(d.by_time.before)!;
  return t != null && t < b ? { zh: d.by_time.zh, en: d.by_time.en } : { zh: d.by_time.else_zh, en: d.by_time.else_en };
}

let current: KindsPayload = KINDS_FALLBACK;
let fetched = false;
const subs = new Set<() => void>();
export const kindsNow = () => current;
/** 测试/重拉用 */
export function setKinds(p: KindsPayload) { current = p; subs.forEach((f) => f()); }
export function __resetKindsForTests() { current = KINDS_FALLBACK; fetched = false; }

/** 拉一次端点(App 生命周期内一次就够;失败留兜底,下次进页面再试) */
export async function loadKinds(): Promise<KindsPayload> {
  try {
    const p = parseKinds(await ephemeraApi.kinds());
    if (p) { setKinds(p); fetched = true; }
  } catch { /* 用兜底副本 */ }
  return current;
}
export function useKinds(): KindsPayload {
  const v = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current);
  useEffect(() => { if (!fetched) void loadKinds(); }, []);
  return v;
}

export const kindDef = (k: string | null | undefined): KindDef | null => (k ? current.kinds.find((d) => d.kind === k) ?? null : null);
/** 英文大类(端点 en,如 MUSEUM);认不得的按 asKind 落回 */
export const kindEnOf = (k: string | null | undefined) => (kindDef(k) ?? kindDef(asKind(k)))?.en ?? "";
export const kindZhOf = (k: string | null | undefined) => (kindDef(k) ?? kindDef(asKind(k)))?.zh ?? "";
/** 站名上面那行小字:「英文大类 · 细类」;没有细类只写英文大类;一件事不带细类。
 *  整行大写(小样 rtTxt 的 text-transform:uppercase:LIVE · LIVE HOUSE;中文不受影响) */
export function kindLine(s: { kind: string | null; subtype?: string | null; time?: string | null }): string {
  const en = kindNames(s.kind, s.time).en;
  const sub = s.kind !== MOMENT ? (s.subtype ?? "").trim() : "";
  return (sub ? `${en} · ${sub}` : en).toUpperCase();
}
/** 窄栏(当天页票条 56 宽)用:细类另起一行,不让「美术馆」这种细类在字中间被折开 */
export function kindLineNarrow(s: { kind: string | null; subtype?: string | null; time?: string | null }): string {
  const en = kindNames(s.kind, s.time).en.toUpperCase();
  const sub = s.kind !== MOMENT ? (s.subtype ?? "").trim().toUpperCase() : "";
  return sub ? `${en}\n${sub}` : en;
}
/** 选择框里的「中文名 · 细类」(time 给了就按时间换名:午餐/晚餐) */
export function kindZhLine(kind: string | null | undefined, subtype?: string | null, time?: string | null): string {
  if (!kind) return "";
  const zh = kindNames(kind, time).zh, sub = kind !== MOMENT ? (subtype ?? "").trim() : "";
  return sub ? `${zh} · ${sub}` : zh;
}
export const isMoment = (k: string | null | undefined) => k === MOMENT;
export const asStopKind = (k: string | null | undefined): StopKind => asKind(k);
