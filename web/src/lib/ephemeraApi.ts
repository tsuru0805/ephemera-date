// Ephemera:她那一侧页面的接口。
// 读口(约会列表/单个/事件/已读)= 引擎 date_plan.py;写口与地图口 = 引擎 date_her.py。
// 服务端按公开矩阵投影,没公开的字段根本不下发——前端不做任何保密判断,有什么画什么。
import { storage } from "./storage";
import { apiFetch } from "./transport";
import { realNewlines } from "./realNewlines";
import { isDemo, onLogout } from "../runtime/session";
import { demoUpload, demoUploadError } from "../demo/server";
import { blobOf } from "./pickedBlobs";

export { realNewlines };

export type DateEventKind = "envelope" | "telegram_manual" | "telegram_auto" | "cancel" | "close" | "late_written";
export interface DateEvent {
  id: number; plan_id: number; kind: DateEventKind; text: string; created_at: number; read_at: number | null;
  ref_stop?: { n: number | null; title?: string } | null;
}

export type LegStep = { line?: string; direction?: string; board?: string; alight?: string; stops?: number; depart?: string; arrive?: string };
export type Leg = {
  mode: "walk" | "train" | "subway" | "bus" | "taxi" | "other" | null;
  depart_time: string | null; arrive_time: string | null; minutes: number | null;
  summary: string | null; steps: LegStep[] | null; fare?: number | string | null;
  needs_ticket: boolean; ticket_note: string | null; official_url: string | null;
};
export type Place = {
  title: string | null; address: string | null; lat: number | null; lng: number | null;
  how_to_get: string | null; walk_path: Array<[number, number]> | null; leg: Leg | null;
  /** 每站现画:地点公开且这一站现在的样子已画好才有(ink=线条遮罩 / inv=反相);否则 null,用固定画 */
  art_url?: string | null; art_inv_url?: string | null;
  /** where the place was picked from + coordinate state when the provider's terms do not allow keeping them */
  place_source?: string | null; place_ref?: string | null;
  coords_status?: "cached" | "expired" | "not_storable" | null; coords_note?: string | null;
};
export type Stop = {
  n: number; stop_id: number; kind: string | null; time: string | null; stay_until: string | null;
  clue: string | null; place: Place | null; note: string | null;
  arrive_at?: number | null; // 引擎刀3 起下发(换算后的绝对到达,epoch 秒)
  reveal_at?: number | null; // 还没公开、且他自己写了公开时间时才有(epoch 秒);默认公开的站一律 null
  her_line?: string | null; // 她给这一站写的一句话(只在结束后能写)
  /** 一站也可以是一件事、没有固定地点:true 时 address / lat / lng 为 null */
  no_place?: boolean;
  /** 细类(可空,≤12 字,单行);一件事没有细类 */
  subtype?: string | null;
  /** 她能不能改这一站的种类/细类(引擎 date-kinds:只在 done 的约会里有值,功能开关不显示;缺=旧引擎) */
  kind_editable?: boolean;
  /** the fixed picture this stop uses when there is no generated one (engine rotates spares by stop id) */
  art_fixed?: string | null;
  /** he skipped this stop on the day / after sending (still on record; the pages mark it 跳过了: no check-in, not counted) */
  skipped?: boolean;
  /** why it was skipped (written when he skips; null otherwise) */
  skip_reason?: string | null;
};
export type PrepItem = { key?: string; section: "book" | "wear" | "bring" | "weather"; text: string; detail: string | null; derived: boolean; to_stop?: number };
export type PlanStatus = "sent" | "live" | "done" | "cancelled";
export type Plan = {
  id: number; paper_no: string | null; title_en: string; date: string; color: string; status: PlanStatus;
  /** 中文名,可选;有就永远是英文名底下的小字副名 */
  title_zh?: string | null;
  /** 这次约会是在一起的第几天(引擎按「和他的第 N 天」同一个起点算,起点那天=第 1 天;约会早于起点/没设起点=null) */
  together_day?: number | null;
  /** 「请他补寄」:还没写的几样 + 她请过没有 + 叫醒他那一轮的结果(引擎 date_asks;他的约会也有,通常只有事件卡后续) */
  write_request?: { pending: string[]; requested_at: number | null; state: "none" | "queued" | "sent" | "failed"; available?: boolean } | null;
  stops: Stop[]; prep: PrepItem[]; contract: string[] | null; card: string | null; quote: string | null;
  sent_at: number | null; closed_at: number | null; cancelled_at: number | null; unread?: number;
  /** 迟到的请柬正文:他写了才有(同小卡的公开规则)。读口里没有「是不是补记」的字段,前端也不推断 */
  invite?: string | null;
  /** 补记时同一个 client_id 重发:引擎原样回那一盒,外加 duplicate */
  duplicate?: boolean;
  /** 这次他选了不藏行程:她拆开请柬(opened_at 有值)以后全部站一起公开(公开由引擎投影决定,前端照画) */
  open_itinerary?: boolean;
  /** 她按「拆开」被引擎记下的时刻(epoch 秒);本地拆过而这里是 null=补报一次 */
  opened_at?: number | null;
  /** 她写给他的信 / 他的回信(结束后才有;没写=null) */
  letter?: Letter | null;
  reply?: Letter | null;
};
export type Letter = { text: string; updated_at: number };
export const LETTER_MAX = 2000;
/** stop_id=null:挂在整次约会上的照片 */
export type HerPhoto = { id: number; stop_id: number | null; caption: string | null; created_at: number };
export type HerState = { marks: Record<string, { at: number; value: unknown }>; photos: HerPhoto[]; now: number };
export type MapData =
  | { empty: true; attribution: string }
  | {
      empty?: false; W: number; H: number; attribution: string; area?: string | null;
      layers: Record<"major" | "minor" | "tiny" | "motor" | "rail" | "river" | "water" | "park", string[]> & { ferry?: string[] };
      stops: Array<{ n: number; x: number; y: number }>;
      legs: Array<{ n: number; mode: string; kind: "walk" | "transit" | "road" | "straight"; pts: Array<[number, number]>; meters: number;
        /** walking legs that cross water by ferry: the ferry pieces (same pixel space) */
        has_ferry?: boolean; ferry?: Array<{ pts: Array<[number, number]>; meters: number | null; minutes: number | null }> }>;
      walk_paths: Array<{ n: number; pts: Array<[number, number]> }>;
      stats: { walk_m: number; transit_legs: number };
      basemap?: string | null;
      /** stops that are public but not drawn, with the reason (coordinates not storable / lookup failed …) */
      unplotted?: Array<{ n: number; stop_id?: number; reason: string; text: string | null }>;
    };

/** 准备中:他还在写、没寄出的约会。服务端只给进度,名字/颜色/任何内容都不下发。 */
export type PreparingWhat = "stops" | "stop_kind" | "stop_time" | "stop_title" | "stop_address" | "stop_clue" | "first_reveal" | "legs" | "prep" | "other";
// 「他看过」的邮戳:seen_at=这句话真的送进他某一轮对话、且他那一轮实际发出的时刻(引擎写, A 路接线);
// 没有这个字段或为 null=没看过,不盖章。只读,App 这边不写它。
export type HerNote = { id: number; text: string; created_at: number; seen_at?: number | null };
export type Preparing = {
  id: number; date: string; last_edited_at: number | null;
  stops: { count: number; complete: number }; legs: number; prep: number; contract: boolean; card: boolean;
  art: { drawn: number; planned: number };
  missing: { what: PreparingWhat; count: number }[]; conflicts: number; ready: boolean;
  notes: HerNote[];
};
export const NOTE_MAX = 100;

/** 引擎拒绝:message = 给她看的那句 */
export class EphemeraError extends Error {
  constructor(public status: number, message: string, public code?: string, public field?: string, public opIndex?: number) { super(message); }
}

export const ERR_TEXT = {
  auth: "口令不对或已经失效，重新登录一下",
  gone: "没有找到，可能已经删掉了",
  server: (status: number) => `后台出错了（HTTP ${status}），等一下再试`,
  network: "连不上后台，点一下再试",
} as const;
function statusText(status: number): string {
  if (status === 401 || status === 403) return ERR_TEXT.auth;
  if (status === 404) return ERR_TEXT.gone;
  return ERR_TEXT.server(status);
}

/** detail 两种形状:字符串(旧口)/ {code,text,field?,op_index?} */
export function errorFromDetail(status: number, detail: unknown): EphemeraError {
  // engine sentences are Chinese; the few English ones (auth, not found) and anything else get a readable Chinese line
  if (typeof detail === "string" && /[\u3400-\u9fff]/.test(detail)) return new EphemeraError(status, detail);
  if (detail && typeof detail === "object" && typeof (detail as { text?: unknown }).text === "string") {
    const d = detail as { code?: unknown; text: string; field?: unknown; op_index?: unknown };
    return new EphemeraError(status, d.text, typeof d.code === "string" ? d.code : undefined,
      typeof d.field === "string" ? d.field : undefined, typeof d.op_index === "number" ? d.op_index : undefined);
  }
  return new EphemeraError(status, statusText(status));
}

// ── 她的写口(契约=引擎 date_plan.py her_backfill / her_edit / her_write / date_place)──────────
export type BackfillStop = { kind?: string; subtype?: string; time?: string; title?: string; address?: string; lat?: number; lng?: number; her_line?: string;
  /** picked from place search: the hit's source / provider_id, passed back as is (the engine applies that provider's terms) */
  place_source?: string; place_ref?: string };
/** 只带认识的键;空的键不带(带了引擎会拒)。date/title_en/color 没填就不带,引擎回原因 */
export type BackfillBody = { client_id: string; date?: string; title_en?: string; title_zh?: string; color?: string; stops: BackfillStop[]; invite_text?: string; contract?: string[]; card?: string };
export type HerOp =
  | { op: "set_line"; stop_id: number; her_line: string }
  | { op: "update_stop"; stop_id: number; time?: string; title?: string; address?: string; lat?: number; lng?: number; kind?: string; subtype?: string | null; no_place?: boolean; place_source?: string; place_ref?: string }
  | { op: "add_stop"; position?: number; kind?: string; subtype?: string; time?: string; title?: string; address?: string; lat?: number; lng?: number; her_line?: string; no_place?: boolean; place_source?: string; place_ref?: string }
  | { op: "remove_stop"; stop_id: number }
  | { op: "set_plan"; title_en?: string; title_zh?: string; date?: string; color?: string };
export type HerWrite = { what: "invite" | "card"; text: string } | { what: "contract"; items: string[] };
/** kind/subtype = 引擎按谷歌地点类型给的建议分类 */
export type PlaceHit = { title: string; address: string | null; lat: number | null; lng: number | null; kind?: string | null; subtype?: string | null;
  source?: string | null; provider_id?: string | null; region?: string | null; fallback_from?: string | null; coords_storable?: boolean };
export type PlaceSearch = { items: PlaceHit[]; source?: string | null; fallback_from?: string | null; fallback_code?: string | null; notice?: string | null };

async function headers(json = false): Promise<Record<string, string>> {
  const t = await storage.getToken();
  return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}) };
}

/** 每个请求都有期限(AbortController):写 20 秒、读 20 秒、地点搜索 8 秒、照片 60 秒。到点=明确的错误,不挂着。
 *  可变对象只为单测把时间调短;正式代码不改它 */
export const TIMEOUTS = { write: 20_000, read: 20_000, search: 8_000, photo: 60_000 };
export const TIMEOUT_WRITE_TEXT = "网络没回应，这次没存上，点一下再试";
/** a photo whose bytes are gone (the page was reloaded before it was uploaded) */
export const PHOTO_GONE_TEXT = "刷新后照片要重新选";
export const TIMEOUT_READ_TEXT = "网络没回应，点一下再试";
type Budget = keyof typeof TIMEOUTS;

async function call<T>(path: string, init?: RequestInit & { json?: unknown; budget?: Budget }): Promise<T> {
  const base = await storage.getBase();
  const { json, budget, ...rest } = init ?? {};
  const write = !!rest.method && rest.method !== "GET";
  const kind: Budget = budget ?? (write ? "write" : "read");
  const ac = new AbortController();
  let timedOut = false;
  const timeoutErr = () => new EphemeraError(0, write || kind === "photo" ? TIMEOUT_WRITE_TEXT : TIMEOUT_READ_TEXT, "timeout");
  const work = (async () => {
    const r = await apiFetch(`${base}${path}`, {
      ...rest,
      signal: ac.signal,
      headers: { ...(await headers(json !== undefined)), ...(rest.headers as Record<string, string> | undefined) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    if (timedOut) throw timeoutErr();               // 到点后才回来的:连响应体都不读
    if (!r.ok) {
      let detail: unknown;
      try { detail = ((await r.json()) as { detail?: unknown }).detail; } catch { /* 非 JSON */ }
      throw errorFromDetail(r.status, detail);
    }
    return realNewlines((await r.json()) as T);
  })();
  work.catch(() => { /* 到点后才失败的那份结果不再有人等,吞掉免得未处理 */ });
  // 期限独立 reject:就算底层不理会 abort(请求或读响应体挂住),到点也一定给出明确的错;
  // 到点以后才回来的结果(成功或失败)被 race 丢弃,不进页面状态
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; ac.abort(); reject(timeoutErr()); }, TIMEOUTS[kind]);
  });
  try {
    return await Promise.race([work, deadline]);
  } catch (e) {
    if (timedOut) throw timeoutErr();
    // the browser's own errors ("Failed to fetch", a body that is not JSON …) never reach the page as they are
    if (!(e instanceof EphemeraError)) throw new EphemeraError(0, write ? TIMEOUT_WRITE_TEXT : ERR_TEXT.network, "network");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const ephemeraApi = {
  plans: () => call<{ plans: Plan[] }>("/api/dates").then((j) => j.plans ?? []),
  plan: (id: number) => call<Plan>(`/api/dates/${id}`),
  preparing: () => call<{ plans: Preparing[] }>("/api/dates/preparing").then((j) => j.plans ?? []),
  note: (id: number, text: string) => call<Preparing>(`/api/dates/${id}/note`, { method: "POST", json: { text } }),
  events: (plan?: number) => call<{ events: DateEvent[] }>(`/api/dates/events${plan ? `?plan=${plan}` : ""}`).then((j) => j.events ?? []),
  markRead: (ids: number[]) => (ids.length ? call<{ marked: number }>("/api/dates/events/read", { method: "POST", json: { ids } }) : Promise.resolve({ marked: 0 })),
  her: (id: number) => call<HerState>(`/api/dates/${id}/her`),
  mark: (id: number, key: string, on = true) => call<HerState>(`/api/dates/${id}/her/mark`, { method: "POST", json: { key, on } }),
  map: (id: number) => call<MapData>(`/api/dates/${id}/map`),
  /** 补记一次以前的约会;返回=她的投影(同 plan()) */
  backfill: (body: BackfillBody) => call<Plan>("/api/dates/backfill", { method: "POST", json: body }),
  /** 结束后她的编辑:整笔原子,任一项被拒=整笔不生效 */
  herEdit: (id: number, ops: HerOp[]) => call<Plan>(`/api/dates/${id}/her`, { method: "PATCH", json: { ops } }),
  /** 她先写三样之一(他已写=409「他已经写了」) */
  /** 一次把这一盒他还没写的全部请他补写,马上叫醒他一轮(client_id 防连点重发) */
  requestWrite: (id: number, clientId: string) => call<Plan>(`/api/dates/${id}/her/request_write`, { method: "POST", json: { client_id: clientId } }),
  herWrite: (id: number, w: HerWrite) => call<Plan>(`/api/dates/${id}/her/write`, { method: "PUT", json: w }),
  /** 她按「拆开」:引擎只记第一次(重复调用无害) */
  open: (id: number) => call<Plan>(`/api/dates/${id}/her/open`, { method: "POST" }),
  /** 她写/改这次约会的信;text="" = 删掉 */
  letter: (id: number, text: string) => call<Plan>(`/api/dates/${id}/her/letter`, { method: "PUT", json: { text } }),
  /** 站的种类表(19 大类 + 细类);失败由 kinds.ts 用打包兜底 */
  kinds: () => call<unknown>("/api/dates/kinds"),
  /** 地点搜索(引擎经地图侧车;失败带文案:503 闸关 / 429 超额 / 504 超时) */
  placeSearch: (q: string) => call<PlaceSearch>(`/api/dates/place_search?q=${encodeURIComponent(q)}`, { budget: "search" }).then((j) => j.items ?? []),
  /** same search, with the fallback notice (shown as is) */
  placeSearchFull: (q: string) => call<PlaceSearch>(`/api/dates/place_search?q=${encodeURIComponent(q)}`, { budget: "search" }).then((j) => ({ ...j, items: j.items ?? [] })),
  /** 引擎的相对路径(每站现画的小画)→ 带口令取回的本地地址 */
  async authedSource(url: string): Promise<{ uri: string; headers: Record<string, string> }> {
    return { uri: await authedObjectUrl(url), headers: {} };
  },
  /** clientId=这一次「收好」的一次性编号:超时后再点,引擎认得是同一张,不存两份 */
  /** 照片上传走 XHR:要上传进度。onProgress(0~1);期限 TIMEOUTS.photo,
   * 到点=明确的错(TIMEOUT_WRITE_TEXT),引擎拒=原话(errorFromDetail)。clientId 同一次「收好」固定,重试引擎认得 */
  /** stopId=null:放进这次约会的那一叠(不挂某一站)。replace=true:这一站原来那张换掉(引擎把同站旧照片记删除);「再点进去显示已放的那张、可以换」 */
  async uploadPhoto(id: number, stopId: number | null, file: { uri: string; mimeType?: string | null; fileName?: string | null; file?: Blob | null }, caption: string, clientId: string,
    onProgress?: (frac: number) => void, replace = false, replaceId?: number): Promise<HerPhoto> {
    // the browser needs the bytes: the picked File/Blob, or (fallback) the object/data URL read back into a Blob
    // object/data URLs from the picker are read back into a Blob; anything else goes as a {uri,name,type} part
    let blob: Blob | null = file.file ?? blobOf(file.uri);
    if (!blob && /^(blob|data):/.test(file.uri)) {
      // an address from before a reload is dead: say so in words, not the browser's "Failed to fetch"
      try { blob = await (await fetch(file.uri)).blob(); } catch { throw new EphemeraError(0, PHOTO_GONE_TEXT, "unreadable"); }
    }
    if (isDemo()) {
      if (!blob) throw new EphemeraError(0, PHOTO_GONE_TEXT, "unreadable");
      try { return (await demoUpload(stopId, blob, caption, clientId, replace, replaceId, onProgress)) as HerPhoto; }
      catch (e) { const d = demoUploadError(e); if (d) throw errorFromDetail(d.status, d.detail); throw e; }
    }
    const fd = new FormData();
    if (stopId != null) fd.append("stop_id", String(stopId)); // absent = belongs to the whole date (the stack of photos)
    fd.append("caption", caption);
    fd.append("client_id", clientId);
    if (replace) fd.append("replace", "1");
    if (replaceId != null) fd.append("replace_id", String(replaceId)); // replace this one photo in the stack
    if (blob) fd.append("file", blob, file.fileName || "photo.jpg");
    else fd.append("file", { uri: file.uri, name: file.fileName || "photo.jpg", type: file.mimeType || "image/jpeg" } as unknown as Blob);
    const url = `${await storage.getBase()}/api/dates/${id}/her/photo`;
    const hs = await headers();
    return new Promise<HerPhoto>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let done = false;
      const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => finish(() => { try { xhr.abort(); } catch { /* already over */ } reject(new EphemeraError(0, TIMEOUT_WRITE_TEXT, "timeout")); }), TIMEOUTS.photo);
      xhr.open("POST", url);
      Object.entries(hs).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      // progress that arrives after the end (timeout / error / done) is dropped: it must not cover an error state
      if (xhr.upload) xhr.upload.onprogress = (e) => { if (!done && e.lengthComputable && e.total > 0) onProgress?.(Math.min(1, e.loaded / e.total)); };
      xhr.onload = () => finish(() => {
        let body: unknown = null;
        try { body = JSON.parse(xhr.responseText || "null"); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) { onProgress?.(1); resolve(body as HerPhoto); }
        else reject(errorFromDetail(xhr.status, (body as { detail?: unknown } | null)?.detail));
      });
      xhr.onerror = () => finish(() => reject(new EphemeraError(0, "照片没传上去：网络断了，点一下再试", "network")));
      onProgress?.(0);
      xhr.send(fd);
    });
  },
  /** 从这一盒里拿掉一张照片;回她的状态 */
  removePhoto: (id: number, photoId: number) => call<HerState>(`/api/dates/${id}/her/photo/${photoId}`, { method: "DELETE" }),
  /** 只改照片底下那行小字(不换照片) */
  photoCaption: (id: number, photoId: number, caption: string) =>
    call<HerPhoto>(`/api/dates/${id}/her/photo/${photoId}`, { method: "PATCH", json: { caption } }),
  async photoSource(id: number, photoId: number): Promise<{ uri: string; headers: Record<string, string> }> {
    return { uri: await authedObjectUrl(`/api/dates/${id}/her/photo/${photoId}`), headers: {} };
  },
};

// The browser's <img> cannot send an Authorization header: fetch the bytes with it and hand the page an object URL.
const objectUrls = new Map<string, Promise<string>>();
/** Forget every photo fetched with the credential: revoke the object URLs, empty the cache (sign-out / logout). */
export function forgetPhotoUrls() {
  for (const p of objectUrls.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  objectUrls.clear();
}
onLogout(forgetPhotoUrls);
/** only for tests */
export const __photoUrlCount = () => objectUrls.size;
async function authedObjectUrl(path: string): Promise<string> {
  const key = `${await storage.getBase()}${path}`;
  let p = objectUrls.get(key);
  if (!p) {
    p = (async () => {
      let r: Response;
      try { r = await apiFetch(key, { headers: await headers() }); } catch { throw new EphemeraError(0, ERR_TEXT.network, "network"); }
      if (!r.ok) throw errorFromDetail(r.status, await r.json().then((j) => (j as { detail?: unknown }).detail).catch(() => undefined));
      return URL.createObjectURL(await r.blob());
    })();
    p.catch(() => objectUrls.delete(key));
    objectUrls.set(key, p);
  }
  return p;
}

/** 准备清单条目的勾选键:引擎给了稳定 key 就用;否则同引擎 date_her.prep_key 的摘要法 */
export function prepMarkKey(it: PrepItem): string {
  if (it.key) return `prep:${it.key}`;
  return `prep:${it.section}:${sha1hex(`${it.section}|${it.text}`).slice(0, 12)}`;
}

// 小巧的 SHA-1(只为和引擎 hashlib.sha1 对齐,算准备清单键;不做任何安全用途)
function sha1hex(msg: string): string {
  const bytes = utf8(msg);
  const ml = bytes.length * 8;
  const withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, ml >>> 0);
  dv.setUint32(withPad.length - 8, Math.floor(ml / 2 ** 32));
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
}

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else { out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  return new Uint8Array(out);
}
