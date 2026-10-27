/// <reference types="jest" />
// 站的种类 19 个大类 + 细类,选地点时自动建议分类。
// 种类表端点 + 兜底副本、自动分类不盖她手选的、一件事规则、细类显示、自定义细类 ≤12 字、种类表 UI、编辑态改种类。
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
import type { Plan, Stop } from "../../lib/ephemeraApi";
import { applyHit, autoKind, blankStop, buildBackfill, envelopeFrom, kindEditableOf, kindFieldOp, pickKind, placeForKind } from "./backfill";
import { HINT, KindPicker } from "./BackfillParts";
import { ART_OF, artOf, MOMENT_ART, PAPER_OF } from "./format";
import { ART, Art } from "./components";
import { ART_FOCUS_BOXED, ART_LAYOUT, artPlacement, coverIn, marginRects } from "./artLayout";
import { Image } from "react-native";
import { icon, KINDS } from "./icons";
import { __resetKindsForTests, KINDS_FALLBACK, kindLine, kindLineNarrow, kindsNow, kindZhLine, loadKinds, parseKinds, setKinds } from "./kinds";
import { routeBandLabel, ticketStatus } from "./MapScreen";
import { mapState } from "./mapState";
import { MAPPAL } from "./theme";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;
const resp = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} }) as Response;
const placed = (title: string, lat: number | null, lng: number | null, address: string | null = null) =>
  ({ title, address, lat, lng, how_to_get: null, walk_path: null, leg: null });
const stop = (o: Partial<Stop>): Stop => ({ n: 1, stop_id: 11, kind: "museum", subtype: "美术馆", time: "11:00", stay_until: null, clue: null, note: null, her_line: null, place: placed("山顶美术馆", 35.66, 139.73, "山顶区 6丁目"), ...o });
const thing = (o: Partial<Stop> = {}): Stop => stop({ n: 2, stop_id: 12, kind: "moment", subtype: null, time: "15:30", no_place: true, place: placed("买了一束花", null, null), ...o });
const plan = (o: Partial<Plan>): Plan => ({ id: 13, paper_no: "0503", title_en: "First\nRain", date: "2026-05-03", color: "cream", status: "done",
  stops: [stop({}), thing()], prep: [], contract: null, card: null, quote: null, sent_at: null, closed_at: 1793181000, cancelled_at: null, invite: null, ...o });
const texts = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(Text).map((t) => [t.props.children].flat(3).filter((x) => typeof x === "string").join("")).join("|");
const inputs = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id);
const byId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.props.testID === id && typeof x.props.onPress === "function" && typeof x.type !== "string", { deep: false });
const byLabel = (r: TestRenderer.ReactTestRenderer, label: string) => r.root.findAll((x: ReactTestInstance) => x.props.accessibilityLabel === label && typeof x.props.onPress === "function" && typeof x.type !== "string", { deep: false });
/** 带无障碍名的那一层(组件外壳也带 testID,但名字在里面那层 Pressable 上) */
const labelOf = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.props.testID === id && x.props.accessibilityLabel !== undefined)[0]?.props.accessibilityLabel;
const byPrefix = (r: TestRenderer.ReactTestRenderer, pre: string) => {
  const seen = new Set<string>();
  return r.root.findAll((x: ReactTestInstance) => typeof x.props.testID === "string" && x.props.testID.startsWith(pre) && typeof x.props.onPress === "function" && typeof x.type !== "string")
    .filter((x) => (seen.has(x.props.testID) ? false : (seen.add(x.props.testID), true)));
};
const press = async (r: TestRenderer.ReactTestRenderer, id: string) => { await act(async () => { byId(r, id)[0].props.onPress(); }); };
const wait = (ms: number) => act(async () => { await new Promise((x) => setTimeout(x, ms)); });
async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); }
function route(plans: Plan[], extra: (u: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const x = extra(u, init);
    if (x) return x;
    if (u.endsWith("/api/dates/kinds")) return resp(503, { detail: "down" }); // 默认拿不到=用兜底副本
    if (u.endsWith("/api/dates")) return resp(200, { plans });
    const m = u.match(/\/api\/dates\/(\d+)$/);
    if (m) return resp(200, plans.find((p) => p.id === Number(m[1])));
    if (/\/her$/.test(u) && (!init || init.method === undefined)) return resp(200, { marks: { lid: { at: 1, value: true } }, photos: [], now: 1793181000 });
    if (u.includes("/map")) return resp(200, { empty: true, attribution: "" });
    if (u.includes("/events")) return resp(200, { events: [] });
    return resp(404, { detail: "not found" });
  });
}
beforeEach(() => { fetchMock.mockReset(); __resetKindsForTests(); });

// 引擎 date_kinds.kinds_payload() 的形状(date-kinds 分支):逐项键名/类型照抄,这里只放头两类 + 一件事
const GW_SHAPE = { kinds: [
  { kind: "train", zh: "集合", en: "MEETING POINT", subtypes: ["车站", "地铁站", "巴士站", "路口", "店门口"], custom: true, no_place: false },
  // 同一类按时间显示午餐/晚餐(分界 16:30),只 dinner 带 by_time
  { kind: "dinner", zh: "午餐 / 晚餐", en: "LUNCH / DINNER", subtypes: ["餐馆", "拉面", "寿司", "烤肉", "居酒屋", "定食", "意大利菜", "法餐", "中餐", "韩餐"], custom: true, no_place: false,
    by_time: { before: "16:30", zh: "午餐", en: "LUNCH", else_zh: "晚餐", else_en: "DINNER" } },
  { kind: "moment", zh: "一件事", en: "SOMETHING WE DID", subtypes: [], custom: false, no_place: true },
], subtype_max: 12 };

describe("种类表:端点 + 兜底副本", () => {
  it("兜底副本和端点同形状:同样的键、同样的类型,parse 原样通过;顺序=图标表顺序,19 类都有图标和纸品", () => {
    const keysOf = (o: object) => Object.keys(o).sort();
    expect(keysOf(KINDS_FALLBACK)).toEqual(keysOf(GW_SHAPE));
    for (const d of KINDS_FALLBACK.kinds) {
      expect(keysOf(d)).toEqual(keysOf(GW_SHAPE.kinds.find((g) => g.kind === d.kind) ?? GW_SHAPE.kinds[0]));
      expect(typeof d.zh).toBe("string"); expect(typeof d.en).toBe("string");
      expect(d.subtypes.every((x) => typeof x === "string" && x.length <= KINDS_FALLBACK.subtype_max)).toBe(true);
    }
    expect(parseKinds(KINDS_FALLBACK)).toEqual(KINDS_FALLBACK);
    expect(parseKinds(GW_SHAPE)).toEqual(GW_SHAPE);
    // 和端点逐项一致的那几类(端点头两类 + 一件事)
    for (const g of GW_SHAPE.kinds) expect(KINDS_FALLBACK.kinds.find((d) => d.kind === g.kind)).toEqual(g);
    expect(KINDS_FALLBACK.kinds.map((d) => d.kind)).toEqual(KINDS);
    expect(KINDS).toHaveLength(19);
    for (const k of KINDS) { expect(icon(k, Object.values(MAPPAL)[0])).toMatch(/^<svg/); expect(PAPER_OF[k]).toBeTruthy(); }
    // 一件事是唯一没有地点、不能自定义的
    expect(KINDS_FALLBACK.kinds.filter((d) => d.no_place).map((d) => d.kind)).toEqual(["moment"]);
    expect(KINDS_FALLBACK.kinds.filter((d) => !d.custom).map((d) => d.kind)).toEqual(["moment"]);
  });
  it("形状不对=当没拿到", () => {
    expect(parseKinds(null)).toBeNull();
    expect(parseKinds({ kinds: [] , subtype_max: 12 })).toBeNull();
    expect(parseKinds({ kinds: GW_SHAPE.kinds })).toBeNull();
    expect(parseKinds({ kinds: [{ kind: "x", zh: "x", en: "X", subtypes: [1], custom: true, no_place: false }], subtype_max: 12 })).toBeNull();
  });
  it("拉端点:拿到=用端点的(顺序照端点);失败=留兜底", async () => {
    route([], (u) => (u.endsWith("/api/dates/kinds") ? resp(200, GW_SHAPE) : undefined));
    await loadKinds();
    expect(kindsNow()).toEqual(GW_SHAPE);
    __resetKindsForTests();
    route([]);
    await loadKinds();
    expect(kindsNow()).toBe(KINDS_FALLBACK);
  });
});

describe("细类显示 / 一件事 / 自动分类(纯函数)", () => {
  it("站名上面那行:英文大类 · 细类;没细类只写英文大类;一件事不带细类", () => {
    expect(kindLine({ kind: "museum", subtype: "美术馆" })).toBe("MUSEUM · 美术馆");
    expect(kindLine({ kind: "museum", subtype: null })).toBe("MUSEUM");
    expect(kindLine({ kind: "museum", subtype: "  " })).toBe("MUSEUM");
    expect(kindLine({ kind: "moment", subtype: "花店" })).toBe("SOMETHING WE DID");
    expect(kindLine({ kind: "live", subtype: "Live house" })).toBe("LIVE · LIVE HOUSE"); // 小样整行大写
    expect(kindZhLine("dinner", "拉面")).toBe("晚餐 · 拉面");
    expect(kindLineNarrow({ kind: "museum", subtype: "美术馆" })).toBe("MUSEUM\n美术馆"); // 当天页窄栏:细类另起一行
    expect(kindLineNarrow({ kind: "museum", subtype: null })).toBe("MUSEUM");
    expect(kindZhLine("dinner", null)).toBe("晚餐");
  });
  it("自动分类:候选带种类、她没手选过=用候选的(细类一起);她手选过=不盖;候选没给(null)=不动", () => {
    const hit = { title: "小灯面馆 桥东店", address: "桥东区", lat: 35.66, lng: 139.7, kind: "dinner", subtype: "拉面" };
    expect(applyHit({ ...blankStop(), title: "小灯面馆" }, hit)).toMatchObject({ kind: "dinner", subtype: "拉面", title: "小灯面馆 桥东店", lat: 35.66 });
    const manual = pickKind({ ...blankStop() }, "cafe", null);
    expect(manual.kindManual).toBe(true);
    expect(applyHit(manual, hit)).toMatchObject({ kind: "cafe", subtype: null, title: "小灯面馆 桥东店", lat: 35.66 });
    expect(applyHit({ ...blankStop(), kind: "walk" }, { ...hit, kind: null, subtype: null })).toMatchObject({ kind: "walk" });
    expect(autoKind({}, { kind: "bogus", subtype: null })).toBeNull();
    expect(autoKind({}, { kind: "moment", subtype: "x" })).toEqual({ kind: "moment", subtype: null });
  });
  it("选「一件事」=地点和细类清掉、地名留着当那件事;请求体不带地址坐标细类", () => {
    const s = { ...blankStop(), kind: "dinner" as const, subtype: "拉面", title: "买了一束花", address: "桥东区", lat: 35.6, lng: 139.7 };
    const m = pickKind(s, "moment", "拉面");
    expect(m).toMatchObject({ kind: "moment", subtype: null, title: "买了一束花", address: null, lat: null, lng: null, kindManual: true });
    expect(buildBackfill({ year: "2026", md: "0503", name: "", color: null, stops: [{ ...s, kind: "moment" }] }, "c").body.stops).toEqual([{ kind: "moment", title: "买了一束花" }]);
    expect(buildBackfill({ year: "2026", md: "0503", name: "", color: null, stops: [s] }, "c").body.stops)
      .toEqual([{ kind: "dinner", subtype: "拉面", title: "买了一束花", address: "桥东区", lat: 35.6, lng: 139.7 }]);
  });
  it("编辑态改种类那一笔:一件事只带 kind;别的种类带细类(空=清);从一件事离开且地点选过候选=同一笔带地点", () => {
    const P = { title: "小灯面馆", address: "桥东区", lat: 35.66, lng: 139.7 };
    expect(kindFieldOp(11, { kind: "moment", subtype: null }, "museum", P)).toEqual({ op: "update_stop", stop_id: 11, kind: "moment" });
    expect(kindFieldOp(11, { kind: "museum", subtype: "画廊" }, "museum", P)).toEqual({ op: "update_stop", stop_id: 11, kind: "museum", subtype: "画廊" });
    expect(kindFieldOp(11, { kind: "cafe", subtype: "" }, "museum", P)).toEqual({ op: "update_stop", stop_id: 11, kind: "cafe", subtype: null });
    expect(kindFieldOp(12, { kind: "dinner", subtype: "拉面" }, "moment", P)).toEqual({ op: "update_stop", stop_id: 12, kind: "dinner", subtype: "拉面", title: "小灯面馆", address: "桥东区", lat: 35.66, lng: 139.7 });
    expect(kindFieldOp(12, { kind: "dinner", subtype: null }, "moment", { title: "花", address: null, lat: null, lng: null })).toEqual({ op: "update_stop", stop_id: 12, kind: "dinner", subtype: null, title: "花" });
  });
});

describe("种类表弹层", () => {
  const M = Object.values(MAPPAL)[0];
  it("19 组照端点顺序;点细类=选那一项;自定义 ≤12 字、单行(多的截掉,换行去掉);一件事那组没有细类也没有自定义", async () => {
    const onPick = jest.fn();
    let r!: TestRenderer.ReactTestRenderer;
    route([]);
    await act(async () => { r = TestRenderer.create(<KindPicker visible kind="dinner" subtype="拉面" M={M} onPick={onPick} onClose={() => {}} />); });
    expect(texts(r)).toContain("What kind of stop");
    expect(byPrefix(r, "kind-").map((x) => x.props.testID).filter((id) => id !== "kind-picker"))
      .toEqual(KINDS.map((k) => `kind-${k}`));
    expect(byId(r, "sub-dinner-拉面")[0].props.accessibilityState).toEqual({ selected: true });
    expect(byId(r, "custom-open-moment")).toHaveLength(0);
    expect(r.root.findAll((x: ReactTestInstance) => typeof x.props.testID === "string" && x.props.testID.startsWith("sub-moment-"))).toHaveLength(0);
    await press(r, "sub-museum-美术馆");
    expect(onPick).toHaveBeenLastCalledWith("museum", "美术馆");
    await press(r, "kind-park");
    expect(onPick).toHaveBeenLastCalledWith("park", null);
    await press(r, "custom-open-bar");
    const box = inputs(r, "custom-bar")[0];
    expect(box.props.maxLength).toBe(12);
    act(() => box.props.onChangeText("屋上の\nビアガーデン十三文字目"));
    expect(inputs(r, "custom-bar")[0].props.value).toBe("屋上のビアガーデン十三文字目");
    await press(r, "custom-ok-bar");
    expect(onPick).toHaveBeenLastCalledWith("bar", "屋上のビアガーデン十三文");
    expect([...onPick.mock.calls.at(-1)![1]]).toHaveLength(12);
    act(() => r.unmount());
  });
  it("她自定义过、不在表里的细类:那组里显示成选中的一枚", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    route([]);
    await act(async () => { r = TestRenderer.create(<KindPicker visible kind="bar" subtype="屋上" M={M} onPick={() => {}} onClose={() => {}} />); });
    expect(byLabel(r, "屋上")[0].props.accessibilityState).toEqual({ selected: true });
    act(() => r.unmount());
  });
});

describe("补记页:当前类别 + 自动分类", () => {
  const RAMEN = { title: "小灯面馆 桥东店", address: "桥东区 宇田川町", lat: 35.661, lng: 139.699, kind: "dinner", subtype: "拉面" };
  const PLAIN = { title: "青川", address: "青川区", lat: 35.64, lng: 139.7, kind: null, subtype: null };
  async function openBf() {
    await require("@react-native-async-storage/async-storage").clear(); // 每次当新开的补记页(补记草稿会存在手机上)
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    route([], (u) => (u.includes("place_search") ? resp(200, { items: u.includes(encodeURIComponent("青川")) ? [PLAIN] : [RAMEN] }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    return r;
  }
  const typePick = async (r: TestRenderer.ReactTestRenderer, q: string, title: string) => {
    act(() => inputs(r, "bf-title-0")[0].props.onFocus());
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText(q));
    await wait(450);
    await act(async () => { byLabel(r, title)[0].props.onPress(); });
    await flush();
  };
  it("空着=「选个种类」;选拉面店=自动成「晚餐 · 拉面」;点开种类表选的就是那一项", async () => {
    const r = await openBf();
    expect(labelOf(r, "bf-kind-0")).toBe(HINT.kind);
    await typePick(r, "小灯面馆", "小灯面馆 桥东店");
    expect(labelOf(r, "bf-kind-0")).toBe("晚餐 · 拉面");
    await press(r, "bf-kind-0");
    expect(byId(r, "sub-dinner-拉面")[0].props.accessibilityState).toEqual({ selected: true });
    act(() => r.unmount());
  });
  it("她先手选了咖啡:再选拉面店也不改;候选没给种类=也不改", async () => {
    const r = await openBf();
    await press(r, "bf-kind-0"); await press(r, "sub-cafe-喫茶店");
    await typePick(r, "小灯面馆", "小灯面馆 桥东店");
    expect(labelOf(r, "bf-kind-0")).toBe("咖啡 · 喫茶店");
    act(() => r.unmount());
    const r2 = await openBf();
    await typePick(r2, "青川", "青川");
    expect(labelOf(r2, "bf-kind-0")).toBe(HINT.kind);
    act(() => r2.unmount());
  });
  it("选「一件事」=地点清掉(封火漆的请求体不带地址坐标细类)", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const bodies: Array<Record<string, unknown>> = [];
    route([], (u, init) => {
      if (u.includes("place_search")) return resp(200, { items: [RAMEN] });
      if (u.endsWith("/backfill")) { bodies.push(JSON.parse(String(init?.body))); return resp(200, plan({ stops: [thing({ n: 1 })] })); }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    await typePick(r, "小灯面馆", "小灯面馆 桥东店");
    await press(r, "bf-kind-0"); await press(r, "kind-moment");
    expect(labelOf(r, "bf-kind-0")).toBe("一件事");
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-seal" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
    await flush();
    expect((bodies[0].stops as unknown[])[0]).toEqual({ kind: "moment", title: "小灯面馆 桥东店" });
    act(() => r.unmount());
  });
});

describe("纪念盒:小字 + 编辑态改种类", () => {
  async function openBox(p: Plan, onPatch?: (o: Record<string, unknown>) => Response, hits: unknown[] = []) {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    const ops: Array<Record<string, unknown>> = [];
    route([p], (u, init) => {
      if (u.includes("place_search")) return resp(200, { items: hits });
      if (init?.method === "PATCH") { const o = JSON.parse(String(init.body)).ops[0]; ops.push(o); return onPatch?.(o) ?? resp(200, p); }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    return { r, ops };
  }
  const pen = async (r: TestRenderer.ReactTestRenderer) => { await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "box-pen" && typeof x.type !== "string", { deep: false })[0].props.onPress(); }); await flush(); };
  it("路线页:站名上面写「英文大类 · 细类」,一件事只写 SOMETHING WE DID", async () => {
    const { r } = await openBox(plan({ sent_at: 1790000000 }));
    expect(texts(r)).toContain("MUSEUM · 美术馆");
    expect(texts(r)).toContain("SOMETHING WE DID");
    act(() => r.unmount());
  });
  it("他写的盒子(寄出过):编辑态种类只显示,不出当前类别", async () => {
    const { r } = await openBox(plan({ sent_at: 1790000000 }));
    await pen(r);
    expect(byId(r, "edit-kind-11")).toHaveLength(0);
    expect(texts(r)).toContain("MUSEUM · 美术馆");
    act(() => r.unmount());
  });
  it("她补记的盒子:改细类=发 kind+subtype;选「一件事」=只发 kind(引擎清地点)", async () => {
    const { r, ops } = await openBox(plan({}));
    await pen(r);
    expect(labelOf(r, "edit-kind-11")).toBe("看展 · 美术馆");
    await press(r, "edit-kind-11"); await press(r, "sub-museum-画廊");
    await flush();
    expect(ops[0]).toEqual({ op: "update_stop", stop_id: 11, kind: "museum", subtype: "画廊" });
    await press(r, "edit-kind-11"); await press(r, "kind-moment");
    await flush();
    expect(ops[1]).toEqual({ op: "update_stop", stop_id: 11, kind: "moment" });
    act(() => r.unmount());
  });
  it("一件事改成别的种类:没地点=引擎原话写在那一行;再选个地点=种类和地点同一笔发", async () => {
    const NEED = "第 2 站从「一件事」改成别的种类，要同时选一个地点（address 或 lat+lng）";
    const RAMEN = { title: "小灯面馆 桥东店", address: "桥东区", lat: 35.661, lng: 139.699, kind: "dinner", subtype: "拉面" };
    const { r, ops } = await openBox(plan({}), (o) => (o.lat === undefined
      ? resp(400, { detail: { code: "moment_needs_place", text: NEED, field: "kind", op_index: 0 } })
      : resp(200, plan({ stops: [stop({}), thing({ kind: "dinner", subtype: null, no_place: false, place: placed("小灯面馆 桥东店", 35.661, 139.699, "桥东区") })] }))), [RAMEN]);
    await pen(r);
    await press(r, "edit-kind-12"); await press(r, "kind-dinner");
    await flush();
    expect(ops[0]).toEqual({ op: "update_stop", stop_id: 12, kind: "dinner", subtype: null, title: "买了一束花" }); // 没坐标:只带她的地名,引擎回原话
    expect(texts(r)).toContain(`没改成 · ${NEED}`);
    act(() => inputs(r, "edit-title-12")[0].props.onFocus());
    act(() => inputs(r, "edit-title-12")[0].props.onChangeText("小灯面馆"));
    await wait(450);
    await act(async () => { byLabel(r, "小灯面馆 桥东店")[0].props.onPress(); await new Promise((x) => setTimeout(x, 20)); });
    await flush();
    // 地点那格不单独再发一笔(单发会被引擎当 往返);她手选的晚餐不被候选的「拉面」盖
    expect(ops.slice(1)).toEqual([{ op: "update_stop", stop_id: 12, kind: "dinner", subtype: null, title: "小灯面馆 桥东店", address: "桥东区", lat: 35.661, lng: 139.699 }]);
    expect(texts(r)).not.toContain(NEED);
    act(() => r.unmount());
  });
});

function deferred<T>() { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; }
async function openBoxRaw(p: Plan, onPatch: (o: Record<string, unknown>) => Response | Promise<Response>, hits: unknown[] = []) {
  const { EphemeraBoxScreen } = require("./BoxScreen");
  mockParams = { id: String(p.id) };
  const ops: Array<Record<string, unknown>> = [];
  route([p], (u, init) => {
    if (u.includes("place_search")) return resp(200, { items: hits });
    if (init?.method === "PATCH") { const o = JSON.parse(String(init.body)).ops[0]; ops.push(o); return onPatch(o); }
    return undefined;
  });
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
  await flush();
  await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "box-pen" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
  await flush();
  return { r, ops };
}

describe("返工 Q1:快速「普通 → 一件事 → 普通」,回执慢", () => {
  it("一件事那笔在途时又改回别的种类:回执后的补发按回执后的种类(一件事)组包,带上地点", async () => {
    const first = deferred<Response>();
    const asMoment = plan({ stops: [stop({ kind: "moment", subtype: null, no_place: true, place: placed("山顶美术馆", null, null) }), thing()] });
    const back = plan({ stops: [stop({ kind: "cafe", subtype: null }), thing()] });
    let n = 0;
    const { r, ops } = await openBoxRaw(plan({}), () => (n++ === 0 ? first.p : resp(200, back)));
    await press(r, "edit-kind-11"); await press(r, "kind-moment");
    await wait(10);
    expect(ops).toEqual([{ op: "update_stop", stop_id: 11, kind: "moment" }]);
    await press(r, "edit-kind-11"); await press(r, "kind-cafe");
    await wait(10);
    expect(ops).toHaveLength(1); // 在途:先不发
    await act(async () => { first.resolve(resp(200, asMoment)); });
    await wait(30); await flush();
    expect(ops[1]).toEqual({ op: "update_stop", stop_id: 11, kind: "cafe", subtype: null, title: "山顶美术馆", address: "山顶区 6丁目", lat: 35.66, lng: 139.73 });
    expect(ops).toHaveLength(2);
    expect(texts(r)).not.toContain("没改成");
    act(() => r.unmount());
  });
  it("改回的是带细类的种类:离开那一笔照样带地点(按字段里的种类判断,不看投影旧值)", async () => {
    const first = deferred<Response>();
    const { r, ops } = await openBoxRaw(plan({}), () => first.p);
    await press(r, "edit-kind-11"); await press(r, "kind-moment");
    await press(r, "edit-kind-11"); await press(r, "sub-dinner-拉面");
    await act(async () => { first.resolve(resp(200, plan({ stops: [stop({ kind: "moment", subtype: null, no_place: true, place: placed("山顶美术馆", null, null) }), thing()] }))); });
    await wait(30); await flush();
    expect(ops[1]).toMatchObject({ kind: "dinner", subtype: "拉面", lat: 35.66, lng: 139.73 });
    act(() => r.unmount());
  });
});

describe("收口:地点 A → 一件事 → 手写 B → 改回普通类", () => {
  const A = { title: "山顶美术馆", address: "山顶区 6丁目", lat: 35.66, lng: 139.73 };
  it("只有地名格还是缓存地点的名字才回填;她手写了别的=只带她写的", () => {
    expect(placeForKind({ title: "山顶美术馆", address: null, lat: null, lng: null }, A)).toEqual(A);
    expect(placeForKind({ title: " 山顶美术馆 ", address: null, lat: null, lng: null }, A)).toEqual(A);
    expect(placeForKind({ title: "买了一束花", address: null, lat: null, lng: null }, A)).toEqual({ title: "买了一束花", address: null, lat: null, lng: null });
    const C = { title: "转角", address: "桥东区", lat: 35.6, lng: 139.7 };
    expect(placeForKind(C, A)).toEqual(C);
    expect(placeForKind({ title: "x", address: null, lat: null, lng: null }, null)).toEqual({ title: "x", address: null, lat: null, lng: null });
  });
  it("手写 B 后改回咖啡:请求只带 kind/细类 + B,不拿 A 盖掉;引擎原话挂在那一行", async () => {
    const NEED = "第 1 站从「一件事」改成别的种类，要同时选一个地点（address 或 lat+lng）";
    const momentA = plan({ stops: [stop({ kind: "moment", subtype: null, no_place: true, place: placed("山顶美术馆", null, null) }), thing()] });
    const momentB = plan({ stops: [stop({ kind: "moment", subtype: null, no_place: true, place: placed("买了一束花", null, null) }), thing()] });
    const { r, ops } = await openBoxRaw(plan({}), (o) => (o.kind === "moment" ? resp(200, momentA)
      : o.no_place ? resp(200, momentB)
      : resp(400, { detail: { code: "moment_needs_place", text: NEED, field: "kind", op_index: 0 } })));
    await press(r, "edit-kind-11"); await press(r, "kind-moment");
    await flush();
    act(() => inputs(r, "edit-title-11")[0].props.onFocus());
    act(() => inputs(r, "edit-title-11")[0].props.onChangeText("买了一束花"));
    await act(async () => { inputs(r, "edit-title-11")[0].props.onBlur(); });
    await flush();
    expect(ops[1]).toEqual({ op: "update_stop", stop_id: 11, title: "买了一束花", no_place: true });
    await press(r, "edit-kind-11"); await press(r, "kind-cafe");
    await flush();
    expect(ops[2]).toEqual({ op: "update_stop", stop_id: 11, kind: "cafe", subtype: null, title: "买了一束花" });
    expect(texts(r)).toContain(`没改成 · ${NEED}`);
    expect(inputs(r, "edit-title-11")[0].props.value).toBe("买了一束花");
    act(() => r.unmount());
  });
});

describe("返工 Q2:端点新加了 App 还不认识的种类", () => {
  const WITH_BOAT = { kinds: [...KINDS_FALLBACK.kinds, { kind: "boat", zh: "坐船", en: "BOAT", subtypes: ["游船"], custom: true, no_place: false }], subtype_max: 12 };
  it("点选它=请求体里是原值(不被兜底成 walk);候选建议它也照收", async () => {
    setKinds(WITH_BOAT);
    expect(autoKind({}, { kind: "boat", subtype: "游船" })).toEqual({ kind: "boat", subtype: "游船" });
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const bodies: Array<Record<string, unknown>> = [];
    route([], (u, init) => {
      if (u.endsWith("/api/dates/kinds")) return resp(200, WITH_BOAT);
      if (u.endsWith("/backfill")) { bodies.push(JSON.parse(String(init?.body))); return resp(200, plan({ stops: [stop({ kind: "boat", subtype: "游船" })] })); }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("南川"));
    await press(r, "bf-kind-0"); await press(r, "sub-boat-游船");
    expect(labelOf(r, "bf-kind-0")).toBe("坐船 · 游船");
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-seal" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
    await flush();
    expect((bodies[0].stops as unknown[])[0]).toEqual({ kind: "boat", subtype: "游船", title: "南川" });
    act(() => r.unmount());
  });
});

describe("返工 Q3:能不能改种类按站的 kind_editable", () => {
  it("有字段按字段;缺字段退回整盒(从没寄出过=能改)", () => {
    expect(kindEditableOf({ kind_editable: true }, { sent_at: 1790000000 })).toBe(true);
    expect(kindEditableOf({ kind_editable: false }, { sent_at: null })).toBe(false);
    expect(kindEditableOf({}, { sent_at: null })).toBe(true);
    expect(kindEditableOf({}, { sent_at: 1790000000 })).toBe(false);
  });
  it("他写的盒子里她补的站(kind_editable=true)出当前类别,他的站(false)只显示;补记的盒子里标了 false 的也只显示", async () => {
    const his = plan({ sent_at: 1790000000, stops: [stop({ kind_editable: false }), thing({ kind: "cafe", subtype: null, no_place: false, place: placed("转角", 35.6, 139.7), kind_editable: true })] });
    const a = await openBoxRaw(his, () => resp(200, his));
    expect(byId(a.r, "edit-kind-11")).toHaveLength(0);
    expect(labelOf(a.r, "edit-kind-12")).toBe("咖啡");
    await press(a.r, "edit-kind-12"); await press(a.r, "sub-cafe-喫茶店");
    await flush();
    expect(a.ops).toEqual([{ op: "update_stop", stop_id: 12, kind: "cafe", subtype: "喫茶店" }]);
    act(() => a.r.unmount());
    const mine = plan({ stops: [stop({ kind_editable: false }), thing({ kind_editable: true })] });
    const b = await openBoxRaw(mine, () => resp(200, mine));
    expect(byId(b.r, "edit-kind-11")).toHaveLength(0);
    expect(byId(b.r, "edit-kind-12")).toHaveLength(1);
    act(() => b.r.unmount());
  });
});

describe("建议项:新补的站在途时改细类", () => {
  it("add_stop 还没回来就改了细类:站建好后补交 kind + subtype", async () => {
    const add = deferred<Response>();
    const his = plan({ sent_at: 1790000000 });
    const built = plan({ sent_at: 1790000000, stops: [stop({}), thing(), stop({ n: 3, stop_id: 99, kind: "walk", subtype: null, place: placed("青川", null, null) })] });
    const { r, ops } = await openBoxRaw(his, (o) => (o.op === "add_stop" ? add.p : resp(200, built)));
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    act(() => inputs(r, "bf-title-2")[0].props.onChangeText("青川"));
    await press(r, "bf-kind-2"); await press(r, "kind-walk");
    await flush();
    expect(ops[0]).toMatchObject({ op: "add_stop", kind: "walk", title: "青川" });
    await press(r, "bf-kind-2"); await press(r, "sub-walk-河边");
    await act(async () => { add.resolve(resp(200, built)); });
    await wait(50); await flush();
    expect(ops.slice(1)).toContainEqual({ op: "update_stop", stop_id: 99, kind: "walk", subtype: "河边" });
    act(() => r.unmount());
  });
});

describe("现有问题整类修", () => {
  it("地图页:结束了的约会每站都是已完成,没有「进行中」、没有「现在 / 下一站」那一块", async () => {
    const done = plan({ stops: [stop({}), stop({ n: 2, stop_id: 12, kind: "bar", subtype: "红酒吧", place: placed("Bar Hoshi", 35.67, 139.74) })] });
    const st = mapState(done, 0);
    expect(st.over).toBe(true);
    expect(st.arrived).toEqual([true, true]);
    expect([0, 1].map((i) => ticketStatus(done.stops[i], i, st, false))).toEqual([["done", "已完成"], ["done", "已完成"]]);
    const live = { ...done, status: "live" as const, stops: done.stops.map((x, i) => ({ ...x, arrive_at: 100 + i * 100 })) };
    const ls = mapState(live, 150);
    expect(ticketStatus(live.stops[0], 0, ls, false)).toEqual(["now", "进行中"]);
    expect(ticketStatus(live.stops[1], 1, ls, false)).toEqual(["now", "下一站"]);
    // 「以检票为准」:时间过了、票没检=没检票(不打勾);检过的才已完成,和当天页一个口径
    const three = { ...live, stops: [...live.stops, { ...live.stops[1], n: 3, stop_id: 13, arrive_at: 300 }] };
    const ts = mapState(three, 350);
    expect(ticketStatus(three.stops[0], 0, ts, false)).toEqual(["soon", "没检票"]);
    expect(ticketStatus(three.stops[0], 0, ts, true)).toEqual(["done", "已完成"]);
    // 他写的约会结束了也以检票为准(当天页同一口径);她补记的(没寄出过)没有当天,结束了算已完成(上面 done 那组)
    const heldDone = { ...done, sent_at: 1790000000 };
    const hs = mapState(heldDone, 0);
    expect(ticketStatus(heldDone.stops[0], 0, hs, false)).toEqual(["soon", "没检票"]);
    expect(ticketStatus(heldDone.stops[0], 0, hs, true)).toEqual(["done", "已完成"]);
    const { EphemeraMapScreen } = require("./MapScreen");
    mockParams = { id: "13" };
    route([done]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraMapScreen />); });
    await flush();
    expect(texts(r)).not.toContain("进行中");
    expect(texts(r)).not.toContain("今天最后一站");
    expect(texts(r).split("已完成").length - 1).toBe(2);
    act(() => r.unmount());
  });
  it("盒盖英文名:每行单行、按比例缩字号、到下限才截短,宽度收在盒盖里", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    route([plan({ title_en: "Kinds One Very Long Single Line" })], (u, init) => (/\/her$/.test(u) && !init?.method ? resp(200, { marks: {}, photos: [], now: 1793181000 }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    const t1 = r.root.findAll((x: ReactTestInstance) => x.props.testID === "lid-t1" && x.type === Text)[0];
    expect(t1.props.numberOfLines).toBe(1);
    expect(t1.props.adjustsFontSizeToFit).toBe(true);
    expect(t1.props.minimumFontScale).toBeGreaterThan(0);
    expect(t1.props.ellipsizeMode).toBe("tail");
    const w = [t1.props.style].flat(3).find((x: { width?: number }) => x && typeof x.width === "number").width;
    expect(36 + w).toBeLessThanOrEqual(390 - 20);
    act(() => r.unmount());
  });
});

describe("新大类的固定画", () => {
  const OLD8 = ["train", "dinner", "cinema", "walk", "cafe", "viewpoint", "shopping", "shrine"];
  it("19 类都有固定画(ink + inv 两张都在);11 个新大类各用自己的一张,不再借旧图", () => {
    for (const k of KINDS) {
      const a = ART_OF[k];
      expect(ART).toHaveProperty(`${a}_ink`);
      expect(ART).toHaveProperty(`${a}_inv`);
    }
    const oldArts = new Set(OLD8.map((k) => ART_OF[k as keyof typeof ART_OF]));
    const fresh = KINDS.filter((k) => !OLD8.includes(k)).map((k) => ART_OF[k]);
    expect(fresh.filter((a) => oldArts.has(a))).toEqual([]);
    expect(new Set(fresh).size).toBe(fresh.length);
    for (const a of MOMENT_ART) { expect(ART).toHaveProperty(`${a}_ink`); expect(ART).toHaveProperty(`${a}_inv`); }
  });
  it("一件事按站编号挑小事:顺序和引擎 MOMENT_VARIANTS 一致,stop_id % 5,同一站永远同一张", () => {
    const GW = ["moment_flowers", "moment_cups", "moment_ticket", "moment_ribbon", "moment_star"]; // 引擎 date_art.MOMENT_VARIANTS
    expect(MOMENT_ART).toEqual(GW.map((x) => `sc_${x}`));
    for (let id = 0; id < 12; id++) expect(artOf({ kind: "moment", stop_id: id })).toBe(`sc_${GW[id % 5]}`);
    expect(artOf({ kind: "moment", stop_id: 37 })).toBe(artOf({ kind: "moment", stop_id: 37 }));
    expect(artOf({ kind: "moment", stop_id: -1 })).toBe("sc_moment_star"); // 同 Python:-1 % 5 == 4
    expect(artOf({ kind: "museum", stop_id: 3 })).toBe(ART_OF.museum);
  });
});

describe("补记盒的信封落款 / 结束约会的票根带", () => {
  it("她补记的盒子(从没寄出过)=from us;他写的照旧 from Him", async () => {
    expect(envelopeFrom({ sent_at: null })).toBe("from us");
    expect(envelopeFrom({ sent_at: 1790000000 })).toBe("from Him");
    for (const [p, want] of [[plan({}), "from us"], [plan({ sent_at: 1790000000 }), "from Him"]] as const) {
      const { EphemeraBoxScreen } = require("./BoxScreen");
      mockParams = { id: "13" };
      route([p]);
      let r!: TestRenderer.ReactTestRenderer;
      await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
      await flush();
      const t = r.root.findAll((x: ReactTestInstance) => x.props.testID === "flat-env-from" && x.type === Text)[0];
      expect(t.props.children).toBe(want);
      act(() => r.unmount());
    }
  });
  it("地图页票根带:结束了=THE ROUTE WE TOOK,进行中照旧 TODAY'S ROUTE", async () => {
    expect(routeBandLabel({ status: "done" })).toBe("THE ROUTE WE TOOK");
    expect(routeBandLabel({ status: "live" })).toBe("TODAY'S ROUTE");
    const { EphemeraMapScreen } = require("./MapScreen");
    mockParams = { id: "13" };
    route([plan({})]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraMapScreen />); });
    await flush();
    expect(texts(r)).toContain("THE ROUTE WE TOOK");
    expect(texts(r)).not.toContain("TODAY'S ROUTE");
    act(() => r.unmount());
  });
});

describe("固定画取景(焦点 / contain)", () => {
  const OLD8 = ["train", "dinner", "cinema", "walk", "cafe", "viewpoint", "shopping", "shrine"] as const;
  it("旧 8 类(和首页那几张)不在取景表里:在调用方的框里等比铺满,不再拉伸", () => {
    for (const k of OLD8) expect(ART_LAYOUT[ART_OF[k]]).toBeUndefined();
    for (const k of OLD8) expect(ART_FOCUS_BOXED[ART_OF[k]]).toBeDefined();
    for (const a of ["sc_museum", "sc_dessert", "sc_tonight", "florals"] as const) expect(ART_LAYOUT[a]).toBeUndefined();
    const box = { left: -10, right: -10, top: -8, height: 96 };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Art name="sc_station" color="#123456" inv style={box} />); });
    const win = r.root.findAll((x: ReactTestInstance) => x.props.testID === "art-box" && typeof x.props.onLayout === "function")[0];
    expect(win.props.style).toEqual([{ position: "absolute" }, box, { overflow: "hidden" }]); // 框的位置大小照用
    act(() => win.props.onLayout({ nativeEvent: { layout: { width: 73, height: 96 } } })); // 连票小格:73×96 不是 2:3
    const img = r.root.findByType(Image);
    expect(img.props.resizeMode).toBe("stretch");
    expect(img.props.style.width / img.props.style.height).toBeCloseTo(300 / 450, 5); // 画保持 2:3
    expect(img.props.style.width).toBeCloseTo(73, 5);                                 // 宽铺满,高多出的裁掉
    expect(img.props.style.tintColor).toBe("#123456");
    act(() => r.unmount());
  });
  it("框本身是原图比例 → 画=整框(与原来的拉伸摆放相同);横图 sc_tonight 按自己的比例;小花整张缩进不裁", () => {
    const one = (name: "sc_moon" | "sc_tonight" | "florals", w: number, h: number) => {
      let r!: TestRenderer.ReactTestRenderer;
      act(() => { r = TestRenderer.create(<Art name={name} color="#000" style={{ left: 0, top: 0, width: w, height: h }} />); });
      const win = r.root.findAll((x: ReactTestInstance) => x.props.testID === "art-box" && typeof x.props.onLayout === "function")[0];
      act(() => win.props.onLayout({ nativeEvent: { layout: { width: w, height: h } } }));
      const st = r.root.findByType(Image).props.style;
      act(() => r.unmount());
      return st;
    };
    expect(one("sc_moon", 92, 138)).toMatchObject({ left: 0, top: 0, width: 92, height: 138 });
    const t = one("sc_tonight", 226, 190);
    expect(t.width / t.height).toBeCloseTo(520 / 347, 5);
    expect(t.height).toBeCloseTo(190, 5);
    const f = one("florals", 115, 100);
    expect(f.width).toBeCloseTo(100, 5); expect(f.height).toBeCloseTo(100, 5); expect(f.left).toBeCloseTo(7.5, 5);
  });
  it("coverIn:焦点落框中心、越界贴边、不露空", () => {
    const r = coverIn(90, 118, 300, 450, { fx: 0.5, fy: 0.52 });
    expect(r.width).toBeCloseTo(90, 5); expect(r.height).toBeCloseTo(135, 5);
    expect(r.top).toBeLessThanOrEqual(0); expect(r.top + r.height).toBeGreaterThanOrEqual(118);
    const e = coverIn(100, 60, 300, 450, { fx: 1, fy: 1 });
    expect(e.top + e.height).toBeCloseTo(60, 5);
  });
  it("新大类焦点数据齐全(0–1);一件事五张都走 contain", () => {
    const fresh = KINDS.filter((k) => !(OLD8 as readonly string[]).includes(k) && k !== "moment");
    expect(fresh).toHaveLength(10);
    for (const k of fresh) {
      const l = ART_LAYOUT[ART_OF[k]];
      expect(l).toBeDefined();
      expect(l).not.toBe("contain");
      const f = l as { fx: number; fy: number };
      expect(f.fx).toBeGreaterThanOrEqual(0); expect(f.fx).toBeLessThanOrEqual(1);
      expect(f.fy).toBeGreaterThanOrEqual(0); expect(f.fy).toBeLessThanOrEqual(1);
    }
    for (const a of MOMENT_ART) expect(ART_LAYOUT[a]).toBe("contain");
  });
  it("焦点:等比铺满,焦点落在格子中心;越界贴边,不露空", () => {
    // 156×216 的格子(当天页那格),原图 300×450:按宽铺满 s=0.52 → 156×234
    const p = artPlacement({ fx: 0.5, fy: 0.34 }, 156, 216);
    expect(p.width).toBeCloseTo(156); expect(p.height).toBeCloseTo(234);
    expect(p.left).toBeCloseTo(0);
    expect(p.top).toBe(0); // 焦点居中要 top=108-79.6=28.4,会露出上边的空 → 贴上边
    const q = artPlacement({ fx: 0.5, fy: 0.8 }, 100, 60); // 扁格子:按宽铺满 100×150
    expect(q.top).toBeCloseTo(30 - 0.8 * 150);
    expect(q.top + q.height).toBeGreaterThanOrEqual(60);
    const e = artPlacement({ fx: 1, fy: 1 }, 100, 60);
    expect(e.left + e.width).toBeCloseTo(100); expect(e.top + e.height).toBeCloseTo(60);
  });
  it("一件事 contain:整张等比缩进格子居中,四周留的白补纸色(只在画外)", () => {
    const p = artPlacement("contain", 156, 216); // 按高:144×216
    expect(p).toEqual({ left: 6, top: 0, width: 144, height: 216 });
    // 左右各 6 的纸色,各往画里多盖 1(压住缩放后画边那圈半透明)
    expect(marginRects(p, 156, 216)).toEqual([{ left: 0, top: 0, width: 7, height: 216 }, { left: 149, top: 0, width: 7, height: 216 }]);
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Art name="sc_moment_cups" color="#abcdef" inv style={{ left: -14, right: -14, top: -14, height: 120 }} />); });
    const frame = r.root.findAll((x: ReactTestInstance) => x.props.testID === "art-frame" && typeof x.props.onLayout === "function")[0];
    act(() => frame.props.onLayout({ nativeEvent: { layout: { width: 156, height: 216 } } }));
    const img = r.root.findByType(Image);
    expect([img.props.style].flat().reduce((a: object, b: object) => ({ ...a, ...b }), {})).toMatchObject({ left: 4, top: -2, width: 148, height: 220, tintColor: "#abcdef" }); // 多画 2 圈,边上那圈藏到纸色/格子边外
    act(() => r.unmount());
  });
});
