// Ephemera:皮肤选择 + 页面数据(约会列表 / 单个约会 + 她的记号与照片)。
// 皮肤是她的外观偏好,存本机;记号(打勾/检票/揭盖…)与照片存引擎(date_her.py),换手机也在。
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type Href, useFocusEffect } from "../../nav/router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { lifecycle, onResume } from "../../runtime/host";
import { beginFirstLoad } from "../../runtime/paintHold";
import { onPlanEvent } from "../../runtime/eventsWatch";
import { getSession, onLogout } from "../../runtime/session";
import { ephemeraApi, type DateEvent, type HerState, type Plan, type Preparing } from "../../lib/ephemeraApi";
import { MAPPAL, SKINS, SKIN_ORDER, type SkinKey } from "./theme";

// ── 皮肤 ──────────────────────────────────────────────────────────────────────────
const SKIN_KEY = "ephemera.skin";
let skin: SkinKey = "ivory";
let skinLoaded = false;
const subs = new Set<() => void>();
function loadSkin() {
  if (skinLoaded) return;
  skinLoaded = true;
  // the host may pass a skin in init (theme); a skin she picked on the Me page (stored) still wins
  const t = getSession().theme;
  if (t && (SKIN_ORDER as string[]).includes(t)) skin = t as SkinKey;
  // on the web the stored skin is read at once (AsyncStorage keeps it in localStorage under this key): the first
  // frame is already in her colours, not the default ones changing a moment later
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(SKIN_KEY) : null;
    if (v && (SKIN_ORDER as string[]).includes(v)) skin = v as SkinKey;
  } catch { /* storage blocked: the async read below still runs */ }
  AsyncStorage.getItem(SKIN_KEY).then((v) => {
    if (v && (SKIN_ORDER as string[]).includes(v) && v !== skin) { skin = v as SkinKey; subs.forEach((f) => f()); }
  }).catch(() => {});
}
export function setSkin(k: SkinKey) {
  skin = k;
  subs.forEach((f) => f());
  AsyncStorage.setItem(SKIN_KEY, k).catch(() => {});
}
export function useSkin() {
  loadSkin();
  const k = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => skin);
  return { key: k, P: SKINS[k], M: MAPPAL[k] };
}

// ── 本机小状态(只关乎界面、不算数据):拆过信封、点开过的线索 ────────────────────────────
type Local = { opened?: boolean; clues?: number[] };
const localKey = (id: number) => `ephemera.local.${id}`;
export async function getLocal(id: number): Promise<Local> {
  try { return JSON.parse((await AsyncStorage.getItem(localKey(id))) || "{}") as Local; } catch { return {}; }
}
export async function patchLocal(id: number, patch: Partial<Local>): Promise<Local> {
  const cur = { ...(await getLocal(id)), ...patch };
  await AsyncStorage.setItem(localKey(id), JSON.stringify(cur)).catch(() => {});
  return cur;
}

/** 拆过信封:引擎记下的(换手机也在)或本机记过的,任一即算 */
export const isOpened = (plan: Plan | null | undefined, local: Local) => !!local.opened || plan?.opened_at != null;
/** 她按「拆开」:本机先记(界面立刻算数),再报引擎(不藏行程从引擎记下那一刻起全开)。
 *  返回引擎回的投影;报不上=null(下次回首页补报,见 syncOpened) */
export async function markOpened(id: number): Promise<Plan | null> {
  await patchLocal(id, { opened: true });
  try { return await ephemeraApi.open(id); } catch (e) { console.warn("[ephemera] 拆开没报上引擎,下次补报", e); return null; }
}
/** 本机拆过、引擎还没记(上次没报上 / 这版之前拆的):补报一次 */
export async function syncOpened(plan: Plan): Promise<boolean> {
  const l = await getLocal(plan.id);
  if (l.opened && plan.opened_at == null) ephemeraApi.open(plan.id).catch((e) => console.warn("[ephemera] 补报拆开失败", e));
  return isOpened(plan, l);
}

/** While a page has nothing to show yet, its first read holds the page (paintHold): taken while the page mounts,
 *  given back when the read is back. Returns the give-back for the read's own finally. */
function useFirstReadHold(empty: boolean): () => void {
  const end = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (empty) end.current = beginFirstLoad();
    return () => { end.current?.(); end.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return useCallback(() => { end.current?.(); end.current = null; }, []);
}

// ── 约会列表 ────────────────────────────────────────────────────────────────────────
let plansCache: Plan[] | null = null;
export function usePlans() {
  const [plans, setPlans] = useState<Plan[] | null>(plansCache);
  const [error, setError] = useState<string | null>(null);
  const held = useFirstReadHold(plansCache == null);   // nothing to show yet: the page waits for this read (paintHold)
  const load = useCallback(() => {
    ephemeraApi.plans().then((p) => { plansCache = p; setPlans(p); setError(null); }).catch((e: Error) => setError(e.message)).finally(held);
  }, [held]);
  useFocusEffect(load);
  useEffect(() => onResume(load), [load]);   // back to the foreground (or the demo clock moved): read again
  return { plans, error, reload: load };
}

// ── 准备中:他还在写的约会,只有进度 + 她留的话 ─────────────────────────────────
let prepCache: Preparing[] | null = null;
export function usePreparing() {
  const [items, setItems] = useState<Preparing[] | null>(prepCache);
  const [error, setError] = useState<string | null>(null);
  // 留话成功的结果不许被先发出、后回来的旧读数盖掉:每次写都作废之前发出的读(同 usePlan)
  const gen = useRef(0);
  const held = useFirstReadHold(prepCache == null);
  const load = useCallback(() => {
    const my = gen.current;
    ephemeraApi.preparing()
      .then((p) => { if (my !== gen.current) return; prepCache = p; setItems(p); setError(null); })
      .catch((e: Error) => { if (my === gen.current) setError(e.message); })
      .finally(held);
  }, [held]);
  useFocusEffect(load);
  useEffect(() => onResume(load), [load]);
  /** 留一句话:成功后用服务端回的这一份替换本地(服务端是唯一真源) */
  const note = useCallback(async (id: number, text: string) => {
    gen.current += 1;
    const v = await ephemeraApi.note(id, text);
    gen.current += 1;
    setItems((cur) => { const next = (cur ?? []).map((x) => (x.id === v.id ? v : x)); prepCache = next; return next; });
    return v;
  }, []);
  return { items, error, reload: load, note };
}

/** 下一次约会:还没结束的(已寄出/当天)里日期最早的 */
export function nextPlan(plans: Plan[]): Plan | null {
  return [...plans].filter((p) => p.status === "sent" || p.status === "live").sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)[0] ?? null;
}
/** 收进纪念盒的:从新到旧 */
export function keptPlans(plans: Plan[]): Plan[] {
  return [...plans].filter((p) => p.status === "done").sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

// ── 单个约会 + 她的记号 ────────────────────────────────────────────────────────────────
// Last read of each date this visit: the next page about the same date (seal → invite → day) starts from it instead
// of an empty page while it reads again (it reads again at once all the same).
type PlanSeen = { plan: Plan | null; her: HerState | null; offset: number };
const planSeen = new Map<number, PlanSeen>();
const seen = (id: number, v: Partial<PlanSeen>) => { const cur = planSeen.get(id) ?? { plan: null, her: null, offset: 0 }; planSeen.set(id, { ...cur, ...v }); };
/** Forget what was read (sign-out). */
export function forgetPlansSeen() { planSeen.clear(); plansCache = null; prepCache = null; }
onLogout(forgetPlansSeen);
/** 当天页要跟着时间走:地点到点公开、到站的话到点出现都由引擎决定,页面在前台时每 30 秒问一次 */
export function usePlan(id: number, opts: { poll?: boolean } = {}) {
  const was = planSeen.get(id);
  const [plan, setPlanState] = useState<Plan | null>(was?.plan ?? null);
  const [her, setHerState] = useState<HerState | null>(was?.her ?? null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffsetState] = useState(was?.offset ?? 0); // 引擎时钟 − 手机时钟(秒)
  const setPlan = useCallback((p: Plan) => { seen(id, { plan: p }); setPlanState(p); }, [id]);
  const setHer = useCallback((h: HerState | null | ((x: HerState | null) => HerState | null)) => {
    setHerState((cur) => { const v = typeof h === "function" ? h(cur) : h; seen(id, { her: v }); return v; });
  }, [id]);
  const setOffset = useCallback((o: number) => { seen(id, { offset: o }); setOffsetState(o); }, [id]);
  const held = useFirstReadHold(Number.isFinite(id) && !(was?.plan && was?.her));
  const alive = useRef(true);
  // 轮询与她刚做的动作并发时,晚回来的旧读数不许把刚检的票/刚打的勾盖回去:每次写都作废之前发出的读
  const gen = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    if (!Number.isFinite(id)) { setError("没有这次约会"); return; }
    const my = gen.current;
    try {
      const [p, h] = await Promise.all([ephemeraApi.plan(id), ephemeraApi.her(id)]);
      if (!alive.current || my !== gen.current) return;
      setPlan(p); setHer(h); setError(null);
      if (typeof h.now === "number") setOffset(h.now - Date.now() / 1000);
    } catch (e) {
      planSeen.delete(id);          // a date that could not be read is not shown from an old read next time
      if (alive.current) setError((e as Error).message);
    } finally {
      held();
    }
  }, [id, setPlan, setHer, setOffset, held]);
  useFocusEffect(useCallback(() => {
    load();
    if (!opts.poll) return undefined;
    const t = setInterval(() => { if (lifecycle.get() === "active") load(); }, 30_000);
    return () => clearInterval(t);
  }, [load, opts.poll]));
  useEffect(() => onResume(() => { void load(); }), [load]);
  // a new event about this date (he skipped a stop, moved one, …): read it now, not at the next poll
  useEffect(() => onPlanEvent((pid) => { if (pid === id) void load(); }), [id, load]);
  const mark = useCallback(async (key: string, on = true) => {
    gen.current += 1;
    const h = await ephemeraApi.mark(id, key, on);
    gen.current += 1;
    if (alive.current) { setHer(h); if (typeof h.now === "number") setOffset(h.now - Date.now() / 1000); }
    return h;
  }, [id]);
  /** 她改完(引擎回的就是改后的投影):直接换上,并作废在途的旧读数 */
  const replace = useCallback((p: Plan) => { gen.current += 1; if (alive.current) setPlan(p); }, []);
  /** 照片变了(传上 / 换掉 / 拿掉):只重读她的状态。走自己的读,不被别的写回执作废;同时作废在途的整页旧读数,免得它晚到把新照片盖回去 */
  const herSeq = useRef(0);
  const refreshHer = useCallback(async (h?: HerState) => {
    gen.current += 1;
    const my = ++herSeq.current;          // 先后发的两次刷新,晚发的赢
    const v = h ?? await ephemeraApi.her(id);
    gen.current += 1;
    if (my !== herSeq.current) return v;
    if (alive.current) { setHer(v); if (typeof v.now === "number") setOffset(v.now - Date.now() / 1000); }
    return v;
  }, [id]);
  const now = () => Date.now() / 1000 + offset;
  return { plan, her, error, reload: load, mark, setHer, replace, refreshHer, now };
}

export const has = (her: HerState | null, key: string) => !!her?.marks[key];

/** 页面里的延时动作:卸载时一并清掉(关掉弹层后不再替她检票、不再关别的弹层) */
export function useTimers() {
  const ts = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => { ts.current.forEach(clearTimeout); ts.current.clear(); }, []);
  return useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => { ts.current.delete(t); fn(); }, ms);
    ts.current.add(t);
    return t;
  }, []);
}

// ── 一条信封/电报该去哪页(电报列表与宿主落点共用) ─────────────────────────────────────────
export async function eventHref(ev: Pick<DateEvent, "kind" | "plan_id">, known?: Plan): Promise<Href | null> {
  let p = known;
  if (!p) { try { p = await ephemeraApi.plan(ev.plan_id); } catch { return null; } }
  if (!p || p.status === "cancelled") return null;
  if (p.status === "done") return `/ephemera-box?id=${p.id}` as Href;
  if (p.status === "live") return `/ephemera-day?id=${p.id}` as Href;
  const opened = await syncOpened(p);
  return (opened ? `/ephemera-invite?id=${p.id}` : `/ephemera-seal?id=${p.id}`) as Href;
}
