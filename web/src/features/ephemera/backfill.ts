// 补记过往约会 / 结束后编辑 / 迟到的请柬:表单 → 引擎请求体、编辑 → ops、页面上要排的字。纯函数,有单测。
// 契约=引擎 date_plan.py her_backfill / her_edit(只传认识的键、空的键不带;不全的值照原样带上,让引擎回原因,不静默丢)。
import type { BackfillBody, BackfillStop, DateEvent, HerOp, PlaceHit, Plan, Stop } from "../../lib/ephemeraApi";
import { kindDef } from "./kinds";
import { dateParts } from "./format";
import type { PlanColor } from "./theme";
import { himEn } from "../../runtime/session";
import { tzOffset } from "../../lib/tz";

/** 书脊上的五种颜色,从左到右(小样 [P.big.c, ...PAST_COL] = 引擎 COLORS 的顺序) */
export const BF_COLORS: PlanColor[] = ["blush", "rose", "cream", "sky", "berry"];
export const MAX_STOPS = 6;

export type DraftPhoto = { uri: string; mimeType?: string | null; fileName?: string | null; caption: string; clientId: string };
export type DraftStop = {
  key: string; kind: string | null; time: string; // 种类代码原样(端点新增的、App 还不认识的也原样发;图标/纸品才按 asKind 兜底)
  /** 细类(≤12 字);kindManual=她亲手选过种类(选地点候选时的自动分类不覆盖) */
  subtype?: string | null; kindManual?: boolean; // time=她敲的数字(最多 4 位),显示成 HH:MM
  title: string; address: string | null; lat: number | null; lng: number | null; herLine: string; photo: DraftPhoto | null;
  /** picked from place search: which service and its place id (sent back with the coordinates) */
  placeSource?: string | null; placeRef?: string | null;
};
export type Draft = { year: string; md: string; name: string; nameZh?: string; color: PlanColor | null; stops: DraftStop[];
  /** 补记页最下面「这次的照片」:挂在整次约会上的那一叠(一次可放多张;盒子建成后再传) */
  dayPhotos?: DraftPhoto[] };

let seq = 0;
export const newKey = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;
/** 一次「存好」的编号(同一页面会话固定一个):超时重发,引擎认得是同一盒 */
export const newClientId = () => `bf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const blankStop = (): DraftStop => ({ key: newKey(), kind: null, time: "", title: "", address: null, lat: null, lng: null, herLine: "", photo: null });
export const newDraft = (now = new Date()): Draft => ({ year: String(now.getFullYear()), md: "", name: "", nameZh: "", color: null, stops: [blankStop()] });

/** 只留数字,最多 n 位 */
export const digits = (s: string, n: number) => s.replace(/\D/g, "").slice(0, n);

/** 敲了的数字 + 还没敲的那截(按模板补 0,页面上淡显):「153」→ ["15:3", "0"] */
export function maskParts(d: string, template: "00:00" | "00.00"): [string, string] {
  const sep = template[2];
  const typed = d.length > 2 ? `${d.slice(0, 2)}${sep}${d.slice(2)}` : d;
  return [typed, template.slice(typed.length)];
}
/** 时间:没敲=不带;敲全=HH:MM;敲了一半=照敲的带上(引擎回「时间要写成 HH:MM」,不静默丢) */
export const timeValue = (d: string) => (d ? maskParts(d, "00:00")[0] : "");
export const timeDigits = (t: string | null | undefined) => digits(t ?? "", 4);

/** 日期:年 4 位 + 月日 4 位 → YYYY-MM-DD;不全照敲的带上(同上) */
export function dateValue(year: string, md: string): string {
  if (!year && !md) return "";
  return `${year}-${md.slice(0, 2)}${md.length > 2 ? `-${md.slice(2)}` : ""}`;
}
export const mdDigits = (date: string) => { const [, m = "", d = ""] = date.split("-"); return digits(m + d, 4); };

/** 书脊上的名字:她写一行,按最接近一半的空格折成两行(同他写的约会名「The Evening\nScreening」);一个词就一行 */
export function splitTitle(name: string): string {
  const t = name.replace(/\s+/g, " ").trim();
  const words = t.split(" ");
  if (words.length < 2) return t;
  let best = 1, cost = Infinity;
  for (let i = 1; i < words.length; i++) {
    const c = Math.max(words.slice(0, i).join(" ").length, words.slice(i).join(" ").length);
    if (c < cost) { cost = c; best = i; }
  }
  return `${words.slice(0, best).join(" ")}\n${words.slice(best).join(" ")}`;
}

/** 一站什么都没写(没类型没时间没地名没话没照片)=她点了加一站又空着,不发 */
export const isBlank = (s: DraftStop) => !s.kind && !s.time && !s.title.trim() && !s.herLine.trim() && !s.photo;

function stopBody(s: DraftStop): BackfillStop {
  const o: BackfillStop = {};
  if (s.kind) o.kind = s.kind;
  const moment = s.kind === "moment"; // 一件事:没有地点、不分细类(引擎 规则)
  const sub = (s.subtype ?? "").trim();
  if (sub && !moment) o.subtype = sub;
  const t = timeValue(s.time);
  if (t) o.time = t;
  const title = s.title.trim();
  if (title) o.title = title;
  if (s.address && !moment) o.address = s.address;
  if (typeof s.lat === "number" && typeof s.lng === "number" && !moment) {
    o.lat = s.lat; o.lng = s.lng;
    if (s.placeSource) { o.place_source = s.placeSource; if (s.placeRef) o.place_ref = s.placeRef; }
  }
  const line = s.herLine.trim();
  if (line) o.her_line = line;
  return o;
}

/** 补记请求体:只带认识的键,空的不带;client_id 必带(同一页面会话固定)。返回体 + 实际发出的站(照片按它对回 stop_id) */
export function buildBackfill(d: Draft, clientId: string): { body: BackfillBody; sent: DraftStop[] } {
  const sent = d.stops.filter((s) => !isBlank(s));
  const body: BackfillBody = { client_id: clientId, stops: sent.map(stopBody) };
  const date = dateValue(d.year, d.md);
  if (date) body.date = date;
  const title = splitTitle(d.name);
  if (title) body.title_en = title;
  const zh = (d.nameZh ?? "").trim();
  if (zh) body.title_zh = zh;
  if (d.color) body.color = d.color;
  return { body, sent };
}

/** 地名框里选了一个候选:带出地名、地址、坐标 */
export function applyHit<T extends { title: string; address: string | null; lat: number | null; lng: number | null; kind?: string | null; subtype?: string | null; kindManual?: boolean; placeSource?: string | null; placeRef?: string | null }>(s: T, h: PlaceHit): T {
  const out = { ...s, title: h.title, address: h.address ?? null, lat: h.lat ?? null, lng: h.lng ?? null, placeSource: h.source ?? null, placeRef: h.provider_id ?? null };
  const auto = autoKind(s, h);
  return auto ? { ...out, kind: auto.kind, subtype: auto.subtype } : out;
}

/** 自动分类:候选带建议种类、她又没亲手选过种类 → 用候选的(细类一起);候选没给(null)或她选过 → 不动 */
export function autoKind(s: { kindManual?: boolean }, h: Pick<PlaceHit, "kind" | "subtype">): { kind: string; subtype: string | null } | null {
  if (s.kindManual || !h.kind || !kindDef(h.kind)) return null; // 种类表(端点/兜底)里没有的不认
  return { kind: h.kind, subtype: h.kind === "moment" ? null : (h.subtype ?? null) };
}

/** 选种类:她亲手选的(以后自动分类不覆盖);选「一件事」=地点清掉(地名留着当那件事)、细类清掉 */
export function pickKind<T extends { kind: string | null; subtype?: string | null; kindManual?: boolean; address: string | null; lat: number | null; lng: number | null }>(s: T, kind: string, subtype: string | null): T {
  const out = { ...s, kind, subtype: kind === "moment" ? null : subtype, kindManual: true };
  return kind === "moment" ? { ...out, address: null, lat: null, lng: null } : out;
}

// ── 纪念盒编辑态:每改一处就发一笔(PATCH /her,整笔原子)────────────────────────────────────────────
export const lineOp = (stopId: number, text: string): HerOp => ({ op: "set_line", stop_id: stopId, her_line: text.trim() });
export const timeOp = (stopId: number, d: string): HerOp => ({ op: "update_stop", stop_id: stopId, time: timeValue(d) });
export function placeOp(stopId: number, title: string, hit?: PlaceHit | null): HerOp {
  if (!hit) return { op: "update_stop", stop_id: stopId, title: title.trim() };
  const o: Extract<HerOp, { op: "update_stop" }> = { op: "update_stop", stop_id: stopId, title: hit.title };
  if (hit.address) o.address = hit.address;
  if (typeof hit.lat === "number" && typeof hit.lng === "number") {
    o.lat = hit.lat; o.lng = hit.lng;
    if (hit.source) { o.place_source = hit.source; if (hit.provider_id) o.place_ref = hit.provider_id; }
  }
  return o;
}
export const removeOp = (stopId: number): HerOp => ({ op: "remove_stop", stop_id: stopId });
/** 补一站:同补记的站,只带写了的;位置不带=接在最后 */
export const addStopOp = (s: DraftStop): HerOp => ({ op: "add_stop", ...stopBody(s) });
export function planOp(o: { name?: string; nameZh?: string; year?: string; md?: string; color?: PlanColor }): HerOp {
  const op: Extract<HerOp, { op: "set_plan" }> = { op: "set_plan" };
  if (o.name !== undefined) op.title_en = splitTitle(o.name);
  if (o.nameZh !== undefined) op.title_zh = o.nameZh.trim(); // 空=删掉中文名
  if (o.year !== undefined && o.md !== undefined) op.date = dateValue(o.year, o.md);
  if (o.color !== undefined) op.color = o.color;
  return op;
}

// ── 请柬 ───────────────────────────────────────────────────────────────────────────
/** 平铺页那张请柬:他写了迟到的请柬=那张;从没寄出过的(没有 sent_at)没有原请柬=不出现;其余照旧原请柬。
 *  (不是「补记」标记:读口里没有那个字段;原请柬本来就是寄出去的那一张) */
export function invitePaper(p: Pick<Plan, "invite" | "sent_at">): "late" | "original" | null {
  if (p.invite) return "late";
  return neverSent(p) ? null : "original";
}

/** 平铺页信封的落款:她补记的盒子(从没寄出过)=from us;他写的照旧 from him */
export const envelopeFrom = (p: Pick<Plan, "sent_at">) => (p.sent_at == null ? "from us" : `from ${himEn()}`);
/** 从没寄出过(sent_at 空)=她补记的那一盒;他写的约会都寄出过。迟到的请柬与编辑态头部那条(set_plan)共用这一个判断 */
export const neverSent = (p: Pick<Plan, "sent_at">) => p.sent_at == null;

/** 路线页头那行的站数:1 站写单数 */
export const stopsLabel = (n: number) => (n === 1 ? "1 STOP" : `${n} STOPS`);

const stampDay = (sec: number) => { const d = new Date((sec + tzOffset(sec)) * 1000); return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`; };
/** 两枚邮戳:写信那天(他补写请柬的 late_written 事件;拿不到=收进纪念盒那天 closed_at)+ 寄往的那天(约会日) */
export function lateStamps(p: Pick<Plan, "id" | "date" | "closed_at">, events: Array<Pick<DateEvent, "plan_id" | "kind" | "text" | "created_at">>): { posted: string | null; to: string } {
  const ev = events.filter((e) => e.plan_id === p.id && e.kind === "late_written" && e.text.includes("请柬")).sort((a, b) => b.created_at - a.created_at)[0];
  const at = ev?.created_at ?? p.closed_at;
  return { posted: at != null ? stampDay(at) : null, to: dateParts(p.date).long };
}

/** 编辑态退出前的缺项:补的那一站类型和地名都要有才能存(引擎 add_stop 要这两样) */
export function missingLabel(d: Pick<DraftStop, "kind" | "title">): string | null {
  const k = !d.kind, t = !d.title.trim();
  return k && t ? "还缺类型和地名" : k ? "还缺类型" : t ? "还缺地名" : null;
}

/** 补的那一站在途期间她又写的:站建好后一笔补交(时间/地名坐标/类型合成一个 update_stop,一句话 set_line) */
export type Seed = { t?: string; title?: string; hit?: PlaceHit | null; line?: string; kind?: string; subtype?: string | null };
export function seedOps(stopId: number, seed: Seed): HerOp[] {
  const u: Extract<HerOp, { op: "update_stop" }> = { op: "update_stop", stop_id: stopId };
  if (seed.t !== undefined) u.time = timeValue(seed.t);
  if (seed.title !== undefined) {
    const p = placeOp(stopId, seed.title, seed.hit) as Extract<HerOp, { op: "update_stop" }>;
    Object.assign(u, { title: p.title }, p.address ? { address: p.address } : {}, typeof p.lat === "number" ? { lat: p.lat, lng: p.lng } : {});
  }
  if (seed.kind) u.kind = seed.kind;
  if (seed.subtype !== undefined && seed.kind !== "moment") u.subtype = seed.subtype;
  const ops: HerOp[] = Object.keys(u).length > 2 ? [u] : [];
  if (seed.line !== undefined) ops.push(lineOp(stopId, seed.line));
  return ops;
}

/** 补的那一站发出去时的样子 vs 现在的样子 → 在途期间新写的那些(没有新写的=null) */
export function seedFromDiff(sent: DraftStop, cur: DraftStop): Seed | null {
  const seed: Seed = {};
  if (cur.time !== sent.time) seed.t = cur.time;
  if (cur.title !== sent.title || cur.lat !== sent.lat || cur.lng !== sent.lng) {
    seed.title = cur.title;
    seed.hit = typeof cur.lat === "number" && typeof cur.lng === "number" ? { title: cur.title, address: cur.address, lat: cur.lat, lng: cur.lng } : null;
  }
  if (cur.herLine !== sent.herLine) seed.line = cur.herLine;
  if (cur.kind && cur.kind !== sent.kind) seed.kind = cur.kind;
  if ((cur.subtype ?? null) !== (sent.subtype ?? null)) seed.subtype = cur.subtype ?? null;
  return Object.keys(seed).length ? seed : null;
}

// ── 编辑态「草稿 ↔ 引擎」同步(每个可编辑字段一份):base=最近确认过的引擎值;发出去记 sent;
// 回执:base=引擎值,且只有草稿还等于 sent(在途期间没再改)才把草稿换成引擎值;否则草稿不动,draft≠base 就再发一次。
// 被拒:草稿留着、不自动重发(等她再提交/点那一行重试)。引擎那份别处变了(别的字段的回执、重读):只动 base,
// 草稿只在没在途且原本就和 base 相同(她没动过)时跟着走。
export type Field<T> = { draft: T; base: T; sent: T | null; inflight: boolean; failed: boolean };
export type FieldEv<T> = { t: "edit"; v: T } | { t: "server"; v: T } | { t: "send" } | { t: "ack"; v: T } | { t: "fail" };
export type Eq<T> = (a: T, b: T) => boolean;
export const fieldInit = <T>(server: T, draft: T = server): Field<T> => ({ draft, base: server, sent: null, inflight: false, failed: false });
export function fieldStep<T>(f: Field<T>, ev: FieldEv<T>, eq: Eq<T> = Object.is): Field<T> {
  switch (ev.t) {
    case "edit": return { ...f, draft: ev.v };
    case "server":
      if (eq(ev.v, f.base)) return f;
      return { ...f, base: ev.v, draft: !f.inflight && eq(f.draft, f.base) ? ev.v : f.draft };
    case "send": return { ...f, sent: f.draft, inflight: true, failed: false };
    case "ack": {
      const keep = f.sent === null || !eq(f.draft, f.sent);
      return { draft: keep ? f.draft : ev.v, base: ev.v, sent: null, inflight: false, failed: false };
    }
    case "fail": return { ...f, sent: null, inflight: false, failed: true };
  }
}
/** 现在该不该发:没在途、草稿和最新确认值不同(颜色点回原值也是和最新 base 比) */
export const fieldDirty = <T>(f: Field<T>, eq: Eq<T> = Object.is) => !eq(f.draft, f.base);
export const fieldShouldSend = <T>(f: Field<T>, eq: Eq<T> = Object.is) => !f.inflight && fieldDirty(f, eq);

/** 站的地点:地名 + 地址 + 坐标一起算一个字段 */
export type PlaceVal = { title: string; address: string | null; lat: number | null; lng: number | null; source?: string | null; ref?: string | null };
export const placeEq: Eq<PlaceVal> = (a, b) => a.title.trim() === b.title.trim() && (a.address ?? null) === (b.address ?? null) && a.lat === b.lat && a.lng === b.lng;
export const placeOfStop = (s: { place: { title: string | null; address: string | null; lat: number | null; lng: number | null } | null }): PlaceVal =>
  ({ title: s.place?.title ?? "", address: s.place?.address ?? null, lat: s.place?.lat ?? null, lng: s.place?.lng ?? null });
/** 编辑态地点那格:选了候选=地名+地址+坐标;没选候选直接写的=一件事、没有固定地点——
 * 带 no_place:true 让引擎把原来的地址/坐标清掉(不留旧坐标画假点) */
export function placeFieldOp(stopId: number, v: PlaceVal): HerOp {
  if (typeof v.lat === "number" && typeof v.lng === "number") return placeOp(stopId, v.title, { title: v.title, address: v.address, lat: v.lat, lng: v.lng, source: v.source ?? null, provider_id: v.ref ?? null });
  return { op: "update_stop", stop_id: stopId, title: v.title.trim(), no_place: true };
}

/** 编辑态种类那格(只给她补的站):大类 + 细类一起算一个字段。 */
export type KindVal = { kind: string | null; subtype: string | null };
export const kindEq: Eq<KindVal> = (a, b) => a.kind === b.kind && ((a.subtype ?? "").trim() || null) === ((b.subtype ?? "").trim() || null);
/** 改种类发的那一笔:选「一件事」=只带 kind(引擎自动设成没有固定地点、清掉地址坐标,不分细类);
 * 别的种类带上细类(空=清掉);从「一件事」改成别的种类时,地点那格选过候选(有坐标)就同一笔带上地点——
 * 引擎要求离开一件事的同一笔里补地点(moment_needs_place),没有就照发、让那一行写引擎原话 */
export function kindFieldOp(stopId: number, v: KindVal, wasKind: string | null, place: PlaceVal | null): HerOp {
  const u: Extract<HerOp, { op: "update_stop" }> = { op: "update_stop", stop_id: stopId };
  if (v.kind) u.kind = v.kind;
  if (v.kind === "moment") return u;
  u.subtype = (v.subtype ?? "").trim() || null;
  if (wasKind === "moment" && place && typeof place.lat === "number" && typeof place.lng === "number") {
    u.title = place.title.trim();
    if (place.address) u.address = place.address;
    u.lat = place.lat; u.lng = place.lng;
  } else if (wasKind === "moment" && place?.title.trim()) {
    u.title = place.title.trim(); // 手写的地名(没选候选、没坐标):照带,引擎回 moment_needs_place 原话,让她选一个候选
  }
  return u;
}
/** 这一站能不能改种类/细类:引擎每站给 kind_editable(done 的约会才有值,只作开关);没有这个字段(旧引擎)退回整盒判断——
 * 从没寄出过的那一盒(她补记的)整盒都是她的站 */
export const kindEditableOf = (s: Pick<Stop, "kind_editable">, plan: Pick<Plan, "sent_at">) => (typeof s.kind_editable === "boolean" ? s.kind_editable : neverSent(plan));
/** 离开一件事那一笔带哪个地点:地点那格选过候选(有坐标)=它;没坐标时,只有地名格的字还是缓存地点的名字(她没改写)才回填缓存的地点;
 * 她手写了别的名字=只带她写的地名(引擎回 moment_needs_place,那一行写原话让她选候选),不拿旧地点盖掉她写的 */
export function placeForKind(now: PlaceVal, cached: PlaceVal | null): PlaceVal {
  if ((typeof now.lat === "number" && typeof now.lng === "number") || !cached) return now;
  return now.title.trim() === cached.title.trim() ? cached : now;
}
/** 离开「一件事」这一笔会不会顺带把地点也存上(存上了地点那格的旧报错要抹掉) */
export const kindOpCarriesPlace = (op: HerOp) => op.op === "update_stop" && typeof op.lat === "number";

/** 英文名那一格写了中文/全角字:不静默,当场在那一行说(引擎的原话对拍后以引擎为准) */
export const EN_NAME_CJK = "英文名这一格只写英文，中文名写在下面一格";
/** 引擎拒「英文名里有中文」的 code(原话与 EN_NAME_CJK 统一,显示时用引擎回的原话) */
export const CJK_TITLE_EN = "cjk_title_en";
/** 和引擎(unicodedata)逐条对齐的「中日韩/全角」判断,按码点,不用 \p{}(Hermes 支持不确定)。
 *  放行:半角箭头等 FFE8–FFEE;〰 U+3030、〽 U+303D(emoji 序列里会出现,引擎放行) */
const CJK_RANGES: Array<[number, number]> = [
  [0x20000, 0x3ffff],            // 扩展 B 起各区(𠮷 等)
  [0x4e00, 0x9fff],              // CJK 统一汉字
  [0x3400, 0x4dbf],              // 扩展 A
  [0xf900, 0xfaff],              // 兼容汉字
  [0x3040, 0x309f],              // 平假名
  [0x30a0, 0x30ff],              // 片假名
  [0x31f0, 0x31ff],              // 片假名音标扩展
  [0x1100, 0x11ff],              // 韩文字母
  [0x3130, 0x318f],              // 韩文兼容字母
  [0xa960, 0xa97f],              // 韩文字母扩展 A
  [0xd7b0, 0xd7ff],              // 韩文字母扩展 B
  [0xac00, 0xd7af],              // 韩文音节
  [0x3100, 0x312f],              // 注音
  [0x31a0, 0x31bf],              // 注音扩展
  [0x3000, 0x303f],              // CJK 符号与标点(下面两枚例外)
  [0xff00, 0xffe6],              // 全角形式
];
const CJK_ALLOWED = new Set([0x3030, 0x303d]);
export function isCjkCodePoint(cp: number): boolean {
  if (CJK_ALLOWED.has(cp)) return false;
  return CJK_RANGES.some(([a, b]) => cp >= a && cp <= b);
}
export function hasCjkName(s: string): boolean {
  for (const ch of s) if (isCjkCodePoint(ch.codePointAt(0)!)) return true;
  return false;
}
export const enNameError = (name: string): string | null => (hasCjkName(name) ? EN_NAME_CJK : null);

// ── 补记草稿────────────────────────────
// 补记页写的东西随手存在手机上(不经引擎),回到补记页就接着写;盒子建成后清掉。只存一份。
export const BACKFILL_DRAFT_KEY = "ephemera.backfill.draft.v1";
export type SavedBackfill = { v: 1; draft: Draft; clientId: string; at: number; /** 盒子已建成(照片可能还没传完) */ box?: { id: number; sid: Record<string, number> } | null;
  /** 已传上去、之后没再改的站 key / 传上去过的站 key(之后换照片=按「换掉」传)——恢复后不重传、不多出一张 */
  up?: string[]; ever?: string[] };
/** 草稿里有没有她写过的东西(只有默认年份 + 一个空站 = 没写) */
export const draftHasContent = (d: Draft) =>
  !!(d.md.trim() || d.name.trim() || (d.nameZh ?? "").trim() || d.color || d.stops.some((s) => !isBlank(s)) || d.stops.length > 1 || !!d.dayPhotos?.length);
/** 读回来的草稿形状对不对(不对=当没有,不让坏数据弄崩补记页) */
export function parseSavedBackfill(raw: string | null): SavedBackfill | null {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as Partial<SavedBackfill>;
    const d = x?.draft as Partial<Draft> | undefined;
    if (x?.v !== 1 || typeof x.clientId !== "string" || !d || typeof d.year !== "string" || typeof d.md !== "string"
      || typeof d.name !== "string" || !Array.isArray(d.stops) || !d.stops.length) return null;
    const stops = d.stops.filter((st) => st && typeof st.key === "string" && typeof st.title === "string" && typeof st.herLine === "string" && typeof st.time === "string");
    if (stops.length !== d.stops.length) return null;
    const box = x.box && typeof x.box.id === "number" && x.box.sid && typeof x.box.sid === "object"
      && Object.values(x.box.sid).every((n) => typeof n === "number") ? { id: x.box.id, sid: x.box.sid } : null;
    const keys = (a: unknown) => (Array.isArray(a) ? a.filter((k): k is string => typeof k === "string") : []);
    return { v: 1, clientId: x.clientId, at: typeof x.at === "number" ? x.at : 0, box, up: keys(x.up), ever: keys(x.ever),
      draft: { year: d.year, md: d.md, name: d.name, nameZh: d.nameZh ?? "", color: (d.color ?? null) as PlanColor | null, stops: stops as DraftStop[],
        dayPhotos: Array.isArray(d.dayPhotos) ? d.dayPhotos.filter((x) => x && typeof x.uri === "string" && typeof x.clientId === "string") : [] } };
  } catch {
    return null;
  }
}

// ── 草稿里的照片：刷新后接回来 ─────────────────────────────
// 照片字节另存（lib/draftPhotos，IndexedDB，按 clientId）。读回草稿时逐张接回：读到=换上新的 blob 地址；
// 读不到、但已经传上去了=留着这条（照片在盒子里），地址置空；读不到又没传=这一站的照片拿掉，那一行写明要重新选。
export const PHOTO_LOST_TEXT = "刷新后照片要重新选";
export async function restoreDraftPhotos(saved: Pick<SavedBackfill, "draft" | "up">, get: (clientId: string) => Promise<Blob | null>,
  makeUrl: (b: Blob) => string): Promise<{ draft: Draft; lost: string[]; dayLost: boolean }> {
  const up = new Set(saved.up ?? []);
  const lost: string[] = [];
  let dayLost = false;
  const back = async (ph: DraftPhoto, uploaded: boolean): Promise<DraftPhoto | null> => {
    const b = await get(ph.clientId).catch(() => null);
    if (b) return { ...ph, uri: makeUrl(b) };
    return uploaded ? { ...ph, uri: "" } : null;
  };
  const stops: DraftStop[] = [];
  for (const st of saved.draft.stops) {
    if (!st.photo) { stops.push(st); continue; }
    const ph = await back(st.photo, up.has(st.key));
    if (!ph) lost.push(st.key);
    stops.push({ ...st, photo: ph });
  }
  const day: DraftPhoto[] = [];
  for (const ph of saved.draft.dayPhotos ?? []) {
    const x = await back(ph, up.has(`day:${ph.clientId}`));
    if (x) day.push(x); else dayLost = true;
  }
  return { draft: { ...saved.draft, stops, dayPhotos: day }, lost, dayLost };
}
