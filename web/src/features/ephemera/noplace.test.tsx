/// <reference types="jest" />
// 一站也可以是一件事、没有固定地点。每个显示站的页面遇到没有坐标的站都不崩、不画假点、
// 不给假地图链接、不显示地址行;卡套照种类走。补记一件事的请求体、地名格提示字。
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("react-native-reanimated", () => ({
  ...require("react-native-reanimated/mock"),
  useSharedValue: (init: unknown) => require("react").useRef({ value: init }).current,
  useAnimatedSensor: () => ({ isAvailable: false, sensor: { value: { roll: 0 } } }),
  withTiming: (to: unknown) => to, withSpring: (to: unknown) => to, withDelay: (_d: number, a: unknown) => a, withRepeat: (a: unknown) => a,
}));
jest.mock("@shopify/react-native-skia", () => {
  const { View } = require("react-native");
  const Pass = ({ children }: { children?: unknown }) => <View>{children as never}</View>;
  const stub: object = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : stub), apply: () => stub });
  return new Proxy({ Skia: stub, vec: (x: number, y: number) => ({ x, y }), useImage: () => null, useFont: () => null }, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : k === "__esModule" ? true : Pass) });
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
jest.mock("../../fonts", () => ({ F: new Proxy({}, { get: (_t, k) => String(k) }), usePosterFonts: () => ({ ready: true, error: null }) }));
jest.mock("../../lib/storage", () => ({ storage: { getBase: async () => "http://gw.test", getToken: async () => "tok" } }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
const mockNav = { dispatch: jest.fn() };
const mockPrevent: { on: boolean; cb: ((o: { data: { action: { type: string } } }) => void) | null } = { on: false, cb: null };
jest.mock("@react-navigation/native", () => ({
  usePreventRemove: (on: boolean, cb: (o: { data: { action: { type: string } } }) => void) => { mockPrevent.on = on; mockPrevent.cb = cb; },
}));
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  return {
    useRouter: () => mockRouter,
    useNavigation: () => mockNav,
    useLocalSearchParams: () => mockParams,
    usePathname: () => "/ephemera-shelf",
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, [cb]),
  };
});

jest.mock("react-native-gesture-handler", () => {
  const chain: object = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : () => chain), apply: () => chain });
  return { Gesture: new Proxy({}, { get: () => () => chain }), GestureDetector: ({ children }: { children: unknown }) => children };
});

import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { Text, TextInput } from "react-native";
import { ephemeraApi, type Plan, type Stop } from "../../lib/ephemeraApi";
import { blankStop, buildBackfill, placeFieldOp } from "./backfill";
import { HINT } from "./BackfillParts";
import { addressOf, hasPlace } from "./format";
import { mapLinkOf, markable } from "./MapScreen";
import { fieldsOf } from "./Tickets";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;
const resp = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} }) as Response;
const placed = (title: string, lat: number | null, lng: number | null, address: string | null = null) =>
  ({ title, address, lat, lng, how_to_get: null, walk_path: null, leg: null });
const stop = (o: Partial<Stop>): Stop => ({ n: 1, stop_id: 11, kind: "cafe", time: "14:00", stay_until: null, clue: null, note: null, her_line: null, place: placed("转角咖啡", 35.64, 139.71, "桥东区 东站南 1丁目"), ...o });
const thing = (o: Partial<Stop> = {}): Stop => stop({ n: 2, stop_id: 12, kind: "shopping", time: "15:30", no_place: true, place: placed("买了一束花", null, null), ...o });
const plan = (o: Partial<Plan>): Plan => ({ id: 13, paper_no: "0503", title_en: "First\nRain", date: "2026-05-03", color: "cream", status: "done",
  stops: [stop({}), thing()], prep: [], contract: null, card: null, quote: null, sent_at: null, closed_at: 1793181000, cancelled_at: null, invite: null, ...o });
const texts = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(Text).map((t) => [t.props.children].flat(3).filter((x) => typeof x === "string").join("")).join("|");
const inputs = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id);
const byLabel = (r: TestRenderer.ReactTestRenderer, label: string) => r.root.findAll((x: ReactTestInstance) => x.props.accessibilityLabel === label && typeof x.props.onPress === "function" && typeof x.type !== "string", { deep: false });

/** 种类改成点「当前类别」弹种类表再点一组(原来那一排小图标没了);默认最后一行(补的那一站) */
const chooseKind = async (r: TestRenderer.ReactTestRenderer, kind: string) => {
  const chips = r.root.findAll((x: ReactTestInstance) => typeof x.props.testID === "string" && /^(bf|edit)-kind-/.test(x.props.testID) && typeof x.props.onPress === "function" && typeof x.type !== "string", { deep: false });
  await act(async () => { chips[chips.length - 1].props.onPress(); });
  await act(async () => { r.root.findAll((x: ReactTestInstance) => x.props.testID === `kind-${kind}` && typeof x.props.onPress === "function" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
};
async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); }
function route(plans: Plan[], extra: (u: string, init?: RequestInit) => Response | undefined = () => undefined, map: unknown = { empty: true, attribution: "" }) {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const x = extra(u, init);
    if (x) return x;
    if (u.endsWith("/api/dates")) return resp(200, { plans });
    const m = u.match(/\/api\/dates\/(\d+)$/);
    if (m) return resp(200, plans.find((p) => p.id === Number(m[1])));
    if (/\/her$/.test(u) && (!init || init.method === undefined)) return resp(200, { marks: { lid: { at: 1, value: true } }, photos: [], now: 1793181000 });
    if (u.includes("/map")) return resp(200, map);
    if (u.includes("/events")) return resp(200, { events: [] });
    return resp(404, { detail: "not found" });
  });
}
beforeEach(() => fetchMock.mockReset());

describe("判断:这一站有没有地点", () => {
  it("no_place 或没有坐标=没有地点;地址行只给有地点的站", () => {
    expect(hasPlace(stop({}))).toBe(true);
    expect(hasPlace(thing())).toBe(false);
    expect(hasPlace(stop({ place: placed("青川", null, null, "青川区") }))).toBe(false); // 没坐标也算
    expect(hasPlace(stop({ no_place: true }))).toBe(false);                            // 标了 no_place,哪怕还带着旧坐标
    expect(addressOf(stop({}))).toBe("桥东区 东站南 1丁目");
    expect(addressOf(stop({ place: placed("青川", null, null, "青川区") }))).toBeNull();
  });
});

describe("地名格提示字 + 补记一件事", () => {
  it("提示字是「去了哪里 / 做了什么」,补记页空着时显示", async () => {
    expect(HINT.place).toBe("去了哪里 / 做了什么");
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    route([]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    expect(texts(r)).toContain("去了哪里 / 做了什么");
    act(() => r.unmount());
  });
  it("写「买了一束花」不点候选直接封火漆:只带地名,不带 address/lat/lng/no_place 空键", async () => {
    expect(buildBackfill({ year: "2026", md: "0503", name: "", color: null, stops: [{ ...blankStop(), kind: "shopping", title: "买了一束花" }] }, "c").body.stops)
      .toEqual([{ kind: "shopping", title: "买了一束花" }]);
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const bodies: Array<Record<string, unknown>> = [];
    route([], (u, init) => {
      if (u.includes("place_search")) return resp(200, { items: [{ title: "花屋", address: "青川区", lat: 35.6, lng: 139.7 }] });
      if (u.endsWith("/backfill")) { bodies.push(JSON.parse(String(init?.body))); return resp(200, plan({ stops: [thing({ n: 1 })] })); }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    act(() => inputs(r, "bf-title-0")[0].props.onFocus());
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("买了一束花"));
    await act(async () => { await new Promise((x) => setTimeout(x, 450)); }); // 候选照样出来
    expect(byLabel(r, "花屋")).toHaveLength(1);
    await act(async () => { inputs(r, "bf-title-0")[0].props.onBlur(); await new Promise((x) => setTimeout(x, 300)); }); // 不点候选,直接失焦
    await chooseKind(r, "shopping");
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-seal" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
    await flush();
    const st = (bodies[0].stops as Array<Record<string, unknown>>)[0];
    expect(st).toEqual({ kind: "shopping", title: "买了一束花" });
    act(() => r.unmount());
  });
  it("编辑态:有坐标的站改写地名不点候选=存成没有地点(带 no_place,清掉旧坐标);选候选=照旧带坐标", async () => {
    expect(placeFieldOp(11, { title: "买了一束花", address: null, lat: null, lng: null })).toEqual({ op: "update_stop", stop_id: 11, title: "买了一束花", no_place: true });
    expect(placeFieldOp(11, { title: "花屋", address: "青川区", lat: 35.6, lng: 139.7 })).toEqual({ op: "update_stop", stop_id: 11, title: "花屋", address: "青川区", lat: 35.6, lng: 139.7 });
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    const ops: unknown[] = [];
    route([plan({})], (_u, init) => (init?.method === "PATCH" ? (ops.push(...JSON.parse(String(init.body)).ops), resp(200, plan({ stops: [stop({ no_place: true, place: placed("买了一束花", null, null) }), thing()] }))) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "box-pen" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
    act(() => inputs(r, "edit-title-11")[0].props.onChangeText("买了一束花"));
    await act(async () => { inputs(r, "edit-title-11")[0].props.onBlur(); });
    await flush();
    expect(ops).toEqual([{ op: "update_stop", stop_id: 11, title: "买了一束花", no_place: true }]);
    act(() => r.unmount());
  });
});

describe("每个显示站的页面", () => {
  it("当天页票券(检票那张):没有地点的站不出地址行", () => {
    expect(fieldsOf(stop({})).map((x) => x[0])).toContain("Address");
    expect(fieldsOf(thing({ place: placed("买了一束花", null, null, "旧地址") })).map((x) => x[0])).toEqual(["Time"]);
  });
  it("当天页整页(连票):有一件事那一站也照常排,不崩", async () => {
    const { EphemeraDayScreen } = require("./DayScreen");
    mockParams = { id: "13" };
    route([plan({ status: "live" })]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraDayScreen />); });
    await flush();
    expect(texts(r)).toContain("买了一束花");
    act(() => r.unmount());
  });
  it("地图页:没有地点的站不给「在地图里打开」、不出地址、不落点(引擎就算给了点也不画)", async () => {
    expect(mapLinkOf(stop({}))).toContain("&ll=35.64,139.71");
    expect(mapLinkOf(thing())).toBeNull();
    expect(markable(plan({}), [{ n: 1 }, { n: 2 }], [true, true])).toEqual([0]);
    const { EphemeraMapScreen } = require("./MapScreen");
    mockParams = { id: "13" };
    const map = { W: 800, H: 800, attribution: "", layers: { major: [], minor: [], tiny: [], motor: [], rail: [], river: [], water: [], park: [] },
      stops: [{ n: 1, x: 300, y: 300 }, { n: 2, x: 400, y: 400 }], legs: [], walk_paths: [], stats: { walk_m: 0, transit_legs: 0 } };
    route([plan({ status: "live" })], undefined, map);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraMapScreen />); });
    await flush();
    const t = texts(r);
    expect(t).toContain("买了一束花");
    expect(t).not.toContain("旧地址");
    const count = (w: string) => t.split("|").filter((x) => x === w).length;
    expect(count("转角咖啡")).toBe(count("买了一束花") + 1); // 有地点的站多一处=地图上的落点标注;一件事那站只在票根带里
    act(() => r.unmount());
  });
  it("纪念盒:平铺页连票与路线页卡套照种类走,一件事那一站照常显示,不崩", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    route([plan({ sent_at: 1790000000 })]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    expect(texts(r)).toContain("买了一束花");          // 路线页站名
    expect(texts(r)).toContain("SHOPPING");           // 平铺页连票那一格按种类
    expect(r.root.findAll((x: ReactTestInstance) => x.props.accessibilityLabel === "打开第 2 站的卡套").length).toBeGreaterThan(0);
    act(() => r.unmount());
  });
  it("电报:一件事那一站的电报照常显示,点开到那一盒", async () => {
    const { EphemeraTelegramsScreen } = require("./TelegramsScreen");
    route([plan({})], (u) => (u.endsWith("/events") ? resp(200, { events: [{ id: 5, plan_id: 13, kind: "telegram_auto", text: "第 2 站改成了「买了一束花」", ref_stop: { n: 2, title: "买了一束花" }, created_at: 1793181000, read_at: 1 }] }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraTelegramsScreen />); });
    await flush();
    expect(texts(r)).toContain("第 2 站改成了「买了一束花」");
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "date-telegram-telegram_auto" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
    await flush();
    expect(mockRouter.push).toHaveBeenCalledWith("/ephemera-box?id=13");
    act(() => r.unmount());
  });
});
void ephemeraApi;

// ── 返工:候选「跳过失焦提交」标记跨焦点周期残留 / 投影 null→无地点 切换 / 地图空态 ───────────────────
describe("I1 编辑态地名:标记只对当前焦点周期有效", () => {
  const HIT_X = { title: "花屋", address: "青川区", lat: 35.6, lng: 139.7 };
  const HIT_ORIG = { title: "转角咖啡", address: "桥东区 东站南 1丁目", lat: 35.64, lng: 139.71 };
  function deferred<T>() { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; }
  /** 引擎按 op 改第 1 站的地点,回改后的投影 */
  let cur: Stop;
  const apply = (o: Record<string, unknown>) => {
    const title = String(o.title ?? cur.place?.title);
    cur = o.no_place ? { ...cur, no_place: true, place: placed(title, null, null) }
      : { ...cur, no_place: false, place: placed(title, (o.lat as number) ?? null, (o.lng as number) ?? null, (o.address as string) ?? null) };
    return resp(200, plan({ stops: [cur, thing()] }));
  };
  async function open(onPatch?: (o: Record<string, unknown>) => Response | Promise<Response>) {
    cur = stop({});
    const ops: Array<Record<string, unknown>> = [];
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    route([plan({})], (u, init) => {
      if (u.includes("place_search")) return resp(200, { items: [HIT_X, HIT_ORIG] });
      if (init?.method === "PATCH") { const o = JSON.parse(String(init.body)).ops[0]; ops.push(o); return (onPatch?.(o) ?? apply(o)) as never; }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "box-pen" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
    return { r, ops };
  }
  const field = (r: TestRenderer.ReactTestRenderer) => inputs(r, "edit-title-11")[0];
  const type = async (r: TestRenderer.ReactTestRenderer, v: string) => { act(() => field(r).props.onFocus()); act(() => field(r).props.onChangeText(v)); await act(async () => { await new Promise((x) => setTimeout(x, 450)); }); };
  const pick = async (r: TestRenderer.ReactTestRenderer, t: string) => { await act(async () => { byLabel(r, t)[0].props.onPress(); await new Promise((x) => setTimeout(x, 20)); }); await flush(); };
  const blur = async (r: TestRenderer.ReactTestRenderer) => { await act(async () => { field(r).props.onBlur(); await new Promise((x) => setTimeout(x, 20)); }); await flush(); };
  const thingAndBlur = async (r: TestRenderer.ReactTestRenderer) => { act(() => field(r).props.onFocus()); act(() => field(r).props.onChangeText("买了一束花")); await blur(r); };
  const NO_PLACE = { op: "update_stop", stop_id: 11, title: "买了一束花", no_place: true };

  it("改一个字后点原候选(和原来一样=不发),那次失焦被跳过;下一次改写成一件事再失焦=提交 no_place", async () => {
    const { r, ops } = await open();
    await type(r, "转角珈");
    await pick(r, "转角咖啡");
    await blur(r);           // 选候选收键盘带出的那一次失焦:跳过
    expect(ops).toEqual([]);
    await thingAndBlur(r);
    expect(ops).toEqual([NO_PLACE]);
    act(() => r.unmount());
  });
  it("先失焦再点候选(候选还留着那 250ms):直接提交候选;之后改写成一件事再失焦=照样提交 no_place", async () => {
    const { r, ops } = await open();
    await type(r, "花");
    await blur(r);           // 失焦=把「花」存成一件事
    await pick(r, "花屋");    // 已失焦:不靠 blur,直接提交候选
    await act(async () => { await new Promise((x) => setTimeout(x, 80)); }); await flush();
    expect(ops).toEqual([{ op: "update_stop", stop_id: 11, title: "花", no_place: true }, { op: "update_stop", stop_id: 11, ...HIT_X }]);
    await thingAndBlur(r);
    expect(ops[ops.length - 1]).toEqual(NO_PLACE);
    act(() => r.unmount());
  });
  it("回执还没回来时重选候选:回执后补发新选的那个;再改写成一件事失焦=提交 no_place", async () => {
    const first = deferred<Response>();
    let n = 0;
    const { r, ops } = await open((o) => (n++ === 0 ? first.p.then(() => apply(o)) : apply(o)));
    await type(r, "花");
    await pick(r, "花屋");
    await blur(r);
    await type(r, "猿");
    await pick(r, "转角咖啡");
    await blur(r);
    expect(ops).toEqual([{ op: "update_stop", stop_id: 11, ...HIT_X }]); // 在途:不另发
    await act(async () => { first.resolve(resp(200, {})); await new Promise((x) => setTimeout(x, 50)); }); await flush();
    expect(ops[1]).toEqual({ op: "update_stop", stop_id: 11, ...HIT_ORIG });
    expect(field(r).props.value).toBe("转角咖啡");
    await thingAndBlur(r);
    expect(ops[ops.length - 1]).toEqual(NO_PLACE);
    act(() => r.unmount());
  });
  it("补记页同名逻辑:先失焦再点候选也直接带上候选;再改写成一件事失焦后封火漆=只带地名", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const bodies: Array<Record<string, unknown>> = [];
    route([], (u, init) => {
      if (u.includes("place_search")) return resp(200, { items: [HIT_X] });
      if (u.endsWith("/backfill")) { bodies.push(JSON.parse(String(init?.body))); return resp(200, plan({ stops: [thing({ n: 1 })] })); }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    const f = () => inputs(r, "bf-title-0")[0];
    act(() => f().props.onFocus()); act(() => f().props.onChangeText("花"));
    await act(async () => { await new Promise((x) => setTimeout(x, 450)); });
    await act(async () => { f().props.onBlur(); });
    await pick(r, "花屋");
    act(() => f().props.onFocus()); act(() => f().props.onChangeText("买了一束花"));
    await act(async () => { f().props.onBlur(); });
    await chooseKind(r, "shopping");
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-seal" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
    await flush();
    expect((bodies[0].stops as unknown[])[0]).toEqual({ kind: "shopping", title: "买了一束花" });
    act(() => r.unmount());
  });
});

describe("I2 同一站 place 从 null(没公开)切到「一件事」(有标题、无地址无坐标)", () => {
  it("公开后显示标题、能检票、没有地址行、地图上不落点", async () => {
    const { AppState } = require("react-native");
    Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
    const intervals: Array<() => void> = [];
    const spy = jest.spyOn(global, "setInterval").mockImplementation(((fn: () => void, ms?: number) => { if (ms === 30_000) intervals.push(fn); return 0 as never; }) as never);
    const locked = plan({ status: "live", stops: [stop({ arrive_at: 1793170000 }), thing({ arrive_at: 1793180000, place: null, no_place: undefined })] });
    const open = plan({ status: "live", stops: [stop({ arrive_at: 1793170000 }), thing({ arrive_at: 1793180000 })] });
    let current = locked;
    const marks: string[] = [];
    route([locked], (u, init) => {
      const m = u.match(/\/api\/dates\/(\d+)$/);
      if (m) return resp(200, current);
      if (u.endsWith("/her/mark")) { marks.push(JSON.parse(String(init?.body)).key); return resp(200, { marks: { lid: { at: 1, value: true }, "checkin:12": { at: 1, value: true } }, photos: [], now: 1793181000 }); }
      return undefined;
    });
    const { EphemeraDayScreen } = require("./DayScreen");
    mockParams = { id: "13" };
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraDayScreen />); });
    await flush();
    expect(texts(r)).toContain("? ? ?");
    expect(texts(r)).not.toContain("买了一束花");
    current = open;                                   // 引擎那边公开了
    await act(async () => { intervals.forEach((f) => f()); });
    await flush();
    expect(texts(r)).toContain("买了一束花");
    expect(markable(open, [{ n: 1 }, { n: 2 }], [true, true])).toEqual([0]);
    await act(async () => { byLabel(r, "第 2 站")[0].props.onPress(); });
    await flush();
    const t = texts(r);
    expect(t).not.toMatch(/Address/i);
    await act(async () => { byLabel(r, "扫一下")[0].props.onPress(); });
    await flush();
    expect(marks).toEqual(["checkin:12"]);
    act(() => r.unmount());
    spy.mockRestore();
  });
});

describe("I3 地图空着:还没公开 vs 没有能落点的地点", () => {
  it("还有没公开的站=Sealed until the day;全公开了只是都是一件事=不写字", async () => {
    const { emptyMapLabel } = require("./MapScreen");
    expect(emptyMapLabel({ vis: [true, false] })).toBe("Sealed until the day");
    expect(emptyMapLabel({ vis: [true, true] })).toBe("");
    const { EphemeraMapScreen } = require("./MapScreen");
    mockParams = { id: "13" };
    route([plan({ status: "done", stops: [thing({ n: 1, stop_id: 11 }), thing()] })]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraMapScreen />); });
    await flush();
    expect(texts(r)).not.toContain("Sealed until the day");
    act(() => r.unmount());
  });
});

describe("候选收起计时(假时钟):失焦后 250ms 内回来=不收;再失焦 250ms 后才收", () => {
  const HIT = { title: "花屋", address: "青川区", lat: 35.6, lng: 139.7 };
  afterEach(() => jest.useRealTimers());
  async function check(r: TestRenderer.ReactTestRenderer, field: () => ReactTestInstance) {
    const slip = () => byLabel(r, "花屋").length;
    act(() => field().props.onFocus());
    act(() => field().props.onChangeText("花"));
    await act(async () => { await new Promise((x) => setTimeout(x, 450)); }); // 真时钟等候选出来
    await flush();
    expect(slip()).toBe(1);
    jest.useFakeTimers();
    act(() => { field().props.onBlur(); });
    act(() => { jest.advanceTimersByTime(200); });
    expect(slip()).toBe(1);
    act(() => { field().props.onFocus(); });          // 250ms 内回来
    act(() => { jest.advanceTimersByTime(300); });     // 越过旧期限(200+300=500 > 250)
    expect(slip()).toBe(1);
    act(() => { field().props.onBlur(); });
    act(() => { jest.advanceTimersByTime(249); });
    expect(slip()).toBe(1);
    act(() => { jest.advanceTimersByTime(2); });
    expect(slip()).toBe(0);
    jest.useRealTimers();
  }
  it("补记页", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    route([], (u) => (u.includes("place_search") ? resp(200, { items: [HIT] }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    await check(r, () => inputs(r, "bf-title-0")[0]);
    act(() => r.unmount());
  });
  it("纪念盒编辑态", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    route([plan({})], (u, init) => (u.includes("place_search") ? resp(200, { items: [HIT] })
      : init?.method === "PATCH" ? resp(200, plan({ stops: [stop({ no_place: true, place: placed("花", null, null) }), thing()] })) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "box-pen" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
    await check(r, () => inputs(r, "edit-title-11")[0]);
    act(() => r.unmount());
  });
});
