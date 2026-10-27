// Online demo (?demo=1 / the demo build): a fake engine in the page. Fictional data, a fast-forward clock,
// no network, no credential. It answers the same paths as the real engine's her side (docs/API.md) with the
// same shapes, so the pages run unchanged. Nothing here is sent anywhere.
import { demoMap } from "./map";
import { himName } from "../runtime/session";

export type DemoStep = "preparing" | "sent" | "live" | "done";
type Mark = { at: number; value: unknown };
type Photo = { id: number; stop_id: number | null; caption: string | null; created_at: number; blob: Blob; client_id?: string };

const DAY = 86400;
const PLAN_ID = 1;

// A fixed, fictional evening. Times are wall-clock in the demo zone (UTC, so the page needs no conversion).
const STOPS = [
  { stop_id: 11, kind: "train", time: "18:00", title: "河畔车站 · 东口", address: "河畔路 1 号", clue: "从有钟的那个出口出来", lat: 0.3, lng: 0.32 },
  { stop_id: 12, kind: "dinner", time: "18:40", title: "小灯餐馆", address: "桥头街 12 号", clue: "窗边会有一盏小灯", lat: 0.46, lng: 0.5 },
  { stop_id: 13, kind: "cinema", time: "20:30", title: "老电影院 · 二号厅", address: "影院巷 3 号", clue: "黑白片，靠后排", lat: 0.62, lng: 0.44 },
  { stop_id: 15, kind: "moment", time: "22:10", title: "买一束花", address: null, clue: "散场后路过的花店", lat: null, lng: null },
  { stop_id: 14, kind: "walk", time: "22:40", title: "沿河步道", address: "河堤", clue: "把今天走完", lat: 0.7, lng: 0.66 },
  // skipped on the day (from the moment the day starts): shown faded, 「跳过了：原因」, no check-in, not counted
  { stop_id: 16, kind: "sweets", time: "23:10", title: "夜里的甜品铺", address: "桥头街 20 号", clue: "关门前最后一份", lat: 0.78, lng: 0.6, skip: "太晚了，下次再去" },
] as Array<{ stop_id: number; kind: string; time: string; title: string; address: string | null; clue: string; lat: number | null; lng: number | null; skip?: string }>;
/** Has he skipped this stop yet (the demo skips it when the day starts)? */
const skippedNow = (s: (typeof STOPS)[number]) => !!s.skip && (db.step === "live" || db.step === "done");

type DB = {
  step: DemoStep; clock: number; day: string; marks: Record<string, Mark>; photos: Photo[]; nextPhoto: number;
  notes: { id: number; text: string; created_at: number; seen_at: number | null }[];
  opened_at: number | null; letter: { text: string; updated_at: number } | null;
  events: { id: number; plan_id: number; kind: string; text: string; created_at: number; read_at: number | null; ref_stop: null }[];
  sentAt: number | null; closedAt: number | null;
};

function isoDay(sec: number) { return new Date(sec * 1000).toISOString().slice(0, 10); }
function atTime(day: string, hm: string) { return Date.parse(`${day}T${hm}:00Z`) / 1000; }

function fresh(): DB {
  const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const day = isoDay(today + DAY);                         // the date is "tomorrow" when the demo starts
  return {
    step: "preparing", clock: today + 15 * 3600, day, marks: {}, photos: [], nextPhoto: 1, notes: [],
    opened_at: null, letter: null, events: [], sentAt: null, closedAt: null,
  };
}
// kept for this tab (a reload does not start over); photos stay in memory only
const KEY = "ephemera.demo";
function restore(): DB {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    if (raw) { const d = JSON.parse(raw) as DB; return { ...d, photos: [], nextPhoto: d.nextPhoto ?? 1 }; }
  } catch { /* start fresh */ }
  return fresh();
}
let db: DB = restore();
const subs = new Set<() => void>();
let version = 0;
const changed = () => {
  version += 1;
  try { globalThis.sessionStorage?.setItem(KEY, JSON.stringify({ ...db, photos: [] })); } catch { /* storage full or off */ }
  subs.forEach((f) => f());
};
/** changes every time the demo state changes (for useSyncExternalStore) */
export const demoVersion = () => version;
export const subscribeDemo = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const demoState = () => db;
export function resetDemo() { db = fresh(); changed(); }

function event(kind: string, text: string) {
  db.events.push({ id: db.events.length + 1, plan_id: PLAN_ID, kind, text, created_at: db.clock, read_at: null, ref_stop: null });
}

/** What the next fast-forward does (label shown on the demo control). */
export function nextStepLabel(): string | null {
  if (db.step === "preparing") return `快进：${himName()}寄出这封邀请`;
  if (db.step === "sent") return "快进：到约会当天";
  if (db.step === "live") {
    const next = STOPS.find((s) => !skippedNow(s) && atTime(db.day, s.time) > db.clock);
    return next ? `快进：到 ${next.time}` : "快进：约会结束";
  }
  return null;
}

/** Advance the demo one step (preparing → sent → each stop of the day → done). */
export function fastForward() {
  if (db.step === "preparing") {
    db.step = "sent"; db.sentAt = db.clock; event("envelope", "你收到一封信");
  } else if (db.step === "sent") {
    db.step = "live"; db.clock = atTime(db.day, "17:50");
    event("telegram_auto", "第 2 站的路线写好了：步行约 9 分钟");
    event("telegram_auto", "第 6 站跳过了：太晚了，下次再去");   // as the engine: skipping a stop sends a telegram_auto
  } else if (db.step === "live") {
    const next = STOPS.find((s) => !skippedNow(s) && atTime(db.day, s.time) > db.clock);
    if (next) db.clock = atTime(db.day, next.time) + 60;
    else {
      db.step = "done"; db.clock = atTime(db.day, "23:50"); db.closedAt = db.clock;
      event("close", "这次约会收进纪念盒了");
    }
  }
  changed();
}

// ── projection (same shape as the engine's her view) ────────────────────────────────
function stopView(s: (typeof STOPS)[number], n: number) {
  const arrive = atTime(db.day, s.time);
  const shown = db.step === "done" || (db.step !== "preparing" && (n === 1 || (db.step === "live" && db.clock >= arrive)));
  const prev = STOPS[n - 2];
  const noPlace = s.lat == null;                 // "a moment": no fixed place, no map
  return {
    n, stop_id: s.stop_id, kind: s.kind, subtype: null, kind_editable: db.step === "done", art_fixed: s.kind === "moment" ? "moment_flowers" : s.kind,
    time: s.time, stay_until: null, arrive_at: arrive, reveal_at: null, her_line: null, no_place: noPlace,
    skipped: skippedNow(s), skip_reason: skippedNow(s) ? s.skip ?? null : null,
    clue: s.clue, note: shown ? null : null,
    place: shown ? {
      title: s.title, address: s.address, lat: s.lat, lng: s.lng, art_url: null, art_inv_url: null,
      place_source: "osm", place_ref: null, coords_status: null, coords_note: null, how_to_get: null, walk_path: null,
      leg: prev && !noPlace ? { mode: "walk", depart_time: null, arrive_time: s.time, minutes: n === 3 ? 14 : 9, summary: null, steps: null,
        fare: null, needs_ticket: false, ticket_note: null, official_url: null } : null,
    } : null,
  };
}

function plan() {
  const done = db.step === "done";
  return {
    id: PLAN_ID, paper_no: "0001", title_en: "An Evening\nin Bloom", title_zh: "一个开花的晚上", together_day: null,
    date: db.day, color: "rose", status: db.step === "preparing" ? "sent" : db.step, open_itinerary: false,
    opened_at: db.opened_at, sent_at: db.sentAt, closed_at: db.closedAt, cancelled_at: null,
    stops: STOPS.map((s, i) => stopView(s, i + 1)),
    prep: [
      { key: "p1", section: "wear", text: "一双走得久的鞋", detail: null, derived: false },
      { key: "p2", section: "bring", text: "一件薄外套", detail: "河边晚上有风", derived: false },
      { key: "p3", section: "weather", text: "晴，夜里 16°", detail: null, derived: false },
    ],
    contract: done ? ["今天不看手机里的工作", "电影散场后慢慢走回去", "下一次由你来挑地方"] : null,
    card: done ? "谢谢你陪我把这个晚上过完。\n下次见。" : null,
    invite: null,
    quote: done ? "Good company, a good day" : null,
    letter: done ? db.letter : null, reply: null,
    write_request: { pending: [], requested_at: null, state: "none", available: false },
    unread: db.events.filter((e) => e.read_at == null).length,
  };
}

function preparing() {
  return [{
    id: PLAN_ID, date: db.day, last_edited_at: db.clock - 1800,
    stops: { count: 4, complete: 3 }, legs: 3, prep: 2, contract: true, card: false,
    art: { drawn: 0, planned: 0 }, missing: [{ what: "stop_clue", count: 1 }], conflicts: 0, ready: false, notes: db.notes,
  }];
}

function her() {
  return { marks: db.marks, photos: db.photos.map(({ blob: _b, client_id: _c, ...p }) => p), now: db.clock };
}

export const DEMO_CONFIG = {
  title: "Ephemera", tz: "UTC", her: "她", him: "他", her_en: "Her", him_en: "Him", together_since: null,
  write_request_available: false, ai_channels: [], ai_activity: { pull: null, context: null }, web_push: false, vapid_public_key: null,
  places: true, map: true, art: false,
  place_service: { available: true, provider: "demo", fallback: null, supports_autocomplete: false, attribution: "试玩数据", store_policy: "store" },
  map_status: { available: true, ready: true, reason: null, text: null },
};

// ── request handling ──────────────────────────────────────────────────────────────
class HttpErr extends Error { constructor(public status: number, public detail: unknown) { super(String(status)); } }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const err = (status: number, text: string, code = "demo") => { throw new HttpErr(status, { code, text }); };

async function bodyOf(init?: RequestInit): Promise<Record<string, unknown>> {
  if (!init?.body || typeof init.body !== "string") return {};
  try { return JSON.parse(init.body) as Record<string, unknown>; } catch { return {}; }
}

function setMark(key: string, on: boolean) {
  const v = plan();
  if (key.startsWith("checkin:")) {
    if (v.status !== "live") err(409, "约会当天才能检票");
    const s = v.stops.find((x) => `checkin:${x.stop_id}` === key);
    if (!s) err(404, "没有这一站");
    if (s!.arrive_at > db.clock) err(409, `${s!.time} 才能拆开这一格`);
    if (!on) err(409, "检过的票不能撤销");
  }
  if (on) db.marks[key] = { at: db.clock, value: true };
  else delete db.marks[key];
}

export async function demoFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url, "http://demo.invalid");
  const p = u.pathname, m = (init?.method || "GET").toUpperCase();
  try {
    if (p === "/api/config") return json(DEMO_CONFIG);
    if (p === "/api/dates") return json({ plans: db.step === "preparing" ? [] : [plan()] });
    if (p === "/api/dates/preparing") return json({ plans: db.step === "preparing" ? preparing() : [] });
    if (p === "/api/dates/kinds") return json({ kinds: [] });
    if (p === "/api/dates/events") return json({ events: db.events });
    if (p === "/api/dates/events/read" && m === "POST") {
      const ids = ((await bodyOf(init)).ids as number[]) ?? [];
      let n = 0;
      db.events.forEach((e) => { if (ids.includes(e.id) && e.read_at == null) { e.read_at = db.clock; n += 1; } });
      changed();
      return json({ marked: n });
    }
    if (p === "/api/dates/place_search") return json({ items: [], source: "demo", fallback_from: null, fallback_code: null, notice: "试玩里不查真实地点，可以直接手写地址" });
    if (p === "/api/dates/backfill") err(409, "试玩里不能补记约会");
    const mm = /^\/api\/dates\/(\d+)(\/.*)?$/.exec(p);
    if (!mm || Number(mm[1]) !== PLAN_ID) err(404, "not found");
    const rest = mm![2] ?? "";
    if (rest === "/note" && m === "POST") {
      if (db.step !== "preparing") err(404, "not found");
      const t = String((await bodyOf(init)).text ?? "").trim();
      if (!t) err(400, "empty");
      db.notes.push({ id: db.notes.length + 1, text: t.slice(0, 100), created_at: db.clock, seen_at: null });
      changed();
      return json(preparing()[0]);
    }
    if (db.step === "preparing") err(404, "not found");
    if (rest === "") return json(plan());
    if (rest === "/her" && m === "GET") return json(her());
    if (rest === "/her/open" && m === "POST") { db.opened_at ??= db.clock; changed(); return json(plan()); }
    if (rest === "/her/mark" && m === "POST") {
      const b = await bodyOf(init);
      setMark(String(b.key ?? ""), b.on !== false);
      changed();
      return json(her());
    }
    if (rest === "/her/letter" && m === "PUT") {
      const t = String((await bodyOf(init)).text ?? "");
      db.letter = t ? { text: t, updated_at: db.clock } : null;
      changed();
      return json(plan());
    }
    if (rest === "/her/write" && m === "PUT") err(409, "他已经写了");
    if (rest === "/her/request_write") err(409, "试玩里没有接 AI", "no_ai_channel");
    if (rest === "/her" && m === "PATCH") err(409, "试玩里不改约会内容");
    if (rest === "/map") return json({ ...demoMap(plan().stops), unplotted: [] });
    const ph = /^\/her\/photo\/(\d+)$/.exec(rest);
    if (ph) {
      const photo = db.photos.find((x) => x.id === Number(ph[1]));
      if (!photo) err(404, "not found");
      if (m === "DELETE") { db.photos = db.photos.filter((x) => x !== photo); changed(); return json(her()); }
      if (m === "PATCH") { photo!.caption = String((await bodyOf(init)).caption ?? "").slice(0, 24) || null; return json({ ...photo, blob: undefined }); }
      return new Response(photo!.blob, { status: 200, headers: { "Content-Type": photo!.blob.type || "image/jpeg" } });
    }
    if (/^\/stops\/\d+\/art$/.test(rest)) err(404, "not found");
    err(404, "not found");
  } catch (e) {
    if (e instanceof HttpErr) return json({ detail: e.detail }, e.status);
    throw e;
  }
  return json({ detail: "not found" }, 404);
}

/** Photo upload (multipart in the real engine). Same rules: checked in first, ≤60 per box, replace keeps one per stop. */
export async function demoUpload(stopId: number | null, blob: Blob, caption: string, clientId: string, replace: boolean, replaceId?: number,
  onProgress?: (f: number) => void) {
  const v = plan();
  if (stopId != null && v.status === "live" && !db.marks[`checkin:${stopId}`]) err(409, "先检票，再放照片");
  if (v.status === "sent") err(409, "约会当天检过票才能放照片");
  const dup = db.photos.find((x) => x.client_id === clientId);
  if (dup) return { ...dup, blob: undefined };
  for (const f of [0.25, 0.6, 0.9]) { onProgress?.(f); await new Promise((r) => setTimeout(r, 120)); }
  if (replace && stopId != null) db.photos = db.photos.filter((x) => x.stop_id !== stopId);
  if (replaceId != null) db.photos = db.photos.filter((x) => x.id !== replaceId);
  const photo: Photo = { id: db.nextPhoto++, stop_id: stopId, caption: caption.trim().slice(0, 24) || null, created_at: db.clock, blob, client_id: clientId };
  db.photos.push(photo);
  changed();
  const { blob: _b, client_id: _c, ...out } = photo;
  return out;
}

export function demoUploadError(e: unknown): { status: number; detail: unknown } | null {
  return e instanceof HttpErr ? { status: e.status, detail: e.detail } : null;
}
