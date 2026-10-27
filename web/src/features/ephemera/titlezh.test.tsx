/// <reference types="jest" />
// 约会名=英文名(必填)+ 中文名(可选,永远是小字副名)。
// 显示规则(有就小字、没有不显示)、补记/set_plan 请求体带 title_zh、英文名那格写中文=当场写明不发。
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


import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { Text, TextInput } from "react-native";
import type { Plan, Stop } from "../../lib/ephemeraApi";
import { blankStop, buildBackfill, EN_NAME_CJK, enNameError, planOp } from "./backfill";
import { HINT } from "./BackfillParts";
import { titleZh, vertical } from "./format";
import { LateInvite } from "./LateInvite";
import { SKINS } from "./theme";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;
const resp = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} }) as Response;
const stop = (o: Partial<Stop> = {}): Stop => ({ n: 1, stop_id: 11, kind: "cafe", time: "14:00", stay_until: null, clue: null, note: null, her_line: null,
  place: { title: "转角咖啡", address: null, lat: 35.6, lng: 139.7, how_to_get: null, walk_path: null, leg: null }, ...o });
const plan = (o: Partial<Plan>): Plan => ({ id: 13, paper_no: "0917", title_en: "Cafe\nMatinee", date: "2026-09-17", color: "cream", status: "done",
  stops: [stop()], prep: [], contract: null, card: null, quote: null, sent_at: 1790000000, closed_at: 1793181000, cancelled_at: null, invite: null, ...o });
const texts = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(Text).map((t) => [t.props.children].flat(3).filter((x) => typeof x === "string").join("")).join("|");
const byId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.props.testID === id && typeof x.type !== "string", { deep: false });
const inputs = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id);
async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); }
function route(plans: Plan[], extra: (u: string, init?: RequestInit) => Response | undefined = () => undefined) {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const x = extra(u, init);
    if (x) return x;
    if (u.endsWith("/api/dates")) return resp(200, { plans });
    const m = u.match(/\/api\/dates\/(\d+)$/);
    if (m) return resp(200, plans.find((p) => p.id === Number(m[1])));
    if (/\/her$/.test(u) && (!init || init.method === undefined)) return resp(200, { marks: {}, photos: [], now: 1793181000 });
    if (u.includes("/map")) return resp(200, { empty: true, attribution: "" });
    if (u.includes("/events")) return resp(200, { events: [] });
    return resp(404, { detail: "not found" });
  });
}
beforeEach(() => fetchMock.mockReset());

describe("中文名显示规则", () => {
  it("有就返回、空白/没有=null;书脊竖排一字一行", () => {
    expect(titleZh({ title_zh: " 午后的咖啡和电影 " })).toBe("午后的咖啡和电影");
    expect(titleZh({ title_zh: "  " })).toBeNull();
    expect(titleZh({ title_zh: null })).toBeNull();
    expect(titleZh({})).toBeNull();
    expect(vertical("眼镜大作")).toBe("眼\n镜\n大\n作");
  });
  it("书脊:中英都有=编号下面竖排小字;没有中文名不出", async () => {
    const { EphemeraShelfScreen } = require("./ShelfScreen");
    route([plan({ title_zh: "午后的咖啡和电影" }), plan({ id: 14, title_zh: null })]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraShelfScreen />); });
    await flush();
    const zh = byId(r, "spine-zh");
    expect(zh).toHaveLength(1);
    expect(zh[0].props.children).toBe("午\n后\n的\n咖\n啡\n和\n电\n影");
    expect(zh[0].props.style).toMatchObject({ fontSize: 10, opacity: 0.85 });
    act(() => r.unmount());
  });
  it("盒盖 + 平铺页请柬:英文照旧大字,中文在下面小字;没有中文名两处都不出", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    for (const [zh, n] of [["午后的咖啡和电影", 1], [null, 0]] as const) {
      mockParams = { id: "13" };
      route([plan({ title_zh: zh })]);
      let r!: TestRenderer.ReactTestRenderer;
      await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
      await flush();
      expect(byId(r, "lid-zh")).toHaveLength(n);
      expect(byId(r, "invite-zh")).toHaveLength(n);
      expect(texts(r)).toContain("Cafe");
      if (n) {
        expect(byId(r, "lid-zh")[0].props.style[0]).toMatchObject({ fontSize: 18, letterSpacing: 7.2 });
        expect(byId(r, "invite-zh")[0].props.style).toMatchObject({ fontSize: 11 });
      }
      act(() => r.unmount());
    }
  });
  it("迟到的请柬:有中文名多一行小字,没有不出", async () => {
    const P = SKINS.ivory;
    const mk = async (p: Plan) => { let r!: TestRenderer.ReactTestRenderer; await act(async () => { r = TestRenderer.create(<LateInvite plan={p} P={P} posted={null} to="2026.09.17" />); }); return r; };
    const a = await mk(plan({ invite: "x", title_zh: "眼镜大作" }));
    expect(texts(a)).toContain("眼镜大作");
    expect(texts(a)).toContain("CAFE MATINEE");
    const b = await mk(plan({ invite: "x" }));
    expect(texts(b)).not.toContain("眼镜大作");
    act(() => { a.unmount(); b.unmount(); });
  });
});

describe("请求体带 title_zh", () => {
  it("补记:中文名有就带 title_zh,空着不带;set_plan 可改可删", () => {
    const d = { year: "2026", md: "0503", name: "First Rain", color: null, stops: [{ ...blankStop(), title: "a" }] };
    expect(buildBackfill({ ...d, nameZh: " 眼镜大作 " }, "c").body).toMatchObject({ title_en: "First\nRain", title_zh: "眼镜大作" });
    expect(buildBackfill({ ...d, nameZh: "  " }, "c").body).not.toHaveProperty("title_zh");
    expect(buildBackfill(d, "c").body).not.toHaveProperty("title_zh");
    expect(planOp({ nameZh: "眼镜大作" })).toEqual({ op: "set_plan", title_zh: "眼镜大作" });
    expect(planOp({ nameZh: "" })).toEqual({ op: "set_plan", title_zh: "" });
  });
  it("补记页填两格封火漆:请求体里两样都在;提示字两格各一", async () => {
    expect([HINT.name, HINT.nameZh]).toEqual(["起个英文名", "中文名，可不填"]);
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const bodies: Array<Record<string, unknown>> = [];
    route([], (u, init) => (u.endsWith("/backfill") ? (bodies.push(JSON.parse(String(init?.body))), resp(200, plan({}))) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    expect(texts(r)).toContain("起个英文名");
    expect(texts(r)).toContain("中文名，可不填");
    act(() => inputs(r, "bf-name")[0].props.onChangeText("First Rain"));
    act(() => inputs(r, "bf-name-zh")[0].props.onChangeText("眼镜大作"));
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("转角咖啡"));
    await act(async () => { await byId(r, "bf-seal")[0].props.onPress(); });
    await flush();
    expect(bodies[0]).toMatchObject({ title_en: "First\nRain", title_zh: "眼镜大作" });
    act(() => r.unmount());
  });
  it("编辑态头部中文名一格:失焦发 set_plan title_zh", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    const ops: unknown[] = [];
    route([plan({ sent_at: null })], (_u, init) => (init?.method === "PATCH" ? (ops.push(...JSON.parse(String(init.body)).ops), resp(200, plan({ sent_at: null, title_zh: "午后" }))) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    act(() => inputs(r, "bf-name-zh")[0].props.onChangeText("午后"));
    await act(async () => { inputs(r, "bf-name-zh")[0].props.onBlur(); });
    await flush();
    expect(ops).toEqual([{ op: "set_plan", title_zh: "午后" }]);
    act(() => r.unmount());
  });
});

describe("英文名那格写了中文:不静默", () => {
  it("判断", () => {
    expect(enNameError("First Rain")).toBeNull();
    expect(enNameError("第一场雨")).toBe(EN_NAME_CJK);
    expect(enNameError("Ｒａｉｎ")).toBe(EN_NAME_CJK); // 全角也拦
  });
  it("补记页:那一行当场写明,封火漆不发、火漆下面也写明", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    let sent = 0;
    route([], (u) => (u.endsWith("/backfill") ? (sent++, resp(200, plan({}))) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    act(() => inputs(r, "bf-name")[0].props.onChangeText("第一场雨"));
    expect(byId(r, "bf-name-err")).toHaveLength(1);
    expect(texts(r)).toContain(EN_NAME_CJK);
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("a"));
    await act(async () => { await byId(r, "bf-seal")[0].props.onPress(); });
    await flush();
    expect(sent).toBe(0);
    expect(texts(r)).toContain(`没存好 · ${EN_NAME_CJK}`);
    act(() => r.unmount());
  });
  it("编辑态:那一行写明,不发 set_plan,离开(返回键)也拦", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    const ops: unknown[] = [];
    route([plan({ sent_at: null })], (_u, init) => (init?.method === "PATCH" ? (ops.push(1), resp(200, plan({ sent_at: null }))) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    act(() => inputs(r, "bf-name")[0].props.onChangeText("第一场雨"));
    await act(async () => { inputs(r, "bf-name")[0].props.onBlur(); });
    await flush();
    expect(texts(r)).toContain(EN_NAME_CJK);
    expect(ops).toEqual([]);
    await act(async () => { const j = r.root.findAll((x: ReactTestInstance) => x.props.accessibilityLabel === "返回" && typeof x.props.onPress === "function", { deep: false })[0].props.onPress(); await new Promise((x) => setTimeout(x, 250)); await j; });
    await flush();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});

describe("对拍:引擎回 cjk_title_en / 中文名 20 字单行", () => {
  const GW = { code: "cjk_title_en", text: "英文名这一格只写英文，中文名写在下面一格", field: "title_en" };
  it("中文名格上限 20,换行去掉", async () => {
    const { ZH_MAX } = require("./BackfillParts");
    expect(ZH_MAX).toBe(20);
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    route([]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    expect(inputs(r, "bf-name-zh")[0].props.maxLength).toBe(20);
    act(() => inputs(r, "bf-name-zh")[0].props.onChangeText("午后\n的咖啡"));
    expect(inputs(r, "bf-name-zh")[0].props.value).toBe("午后的咖啡");
    act(() => r.unmount());
  });
  it("补记页:引擎回 cjk_title_en=原话挂在英文格那一行下面;她改了英文名就清", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    route([], (u) => (u.endsWith("/backfill") ? resp(400, { detail: GW }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    act(() => inputs(r, "bf-name")[0].props.onChangeText("Rain"));   // 前端判断放过(引擎另有规则)
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("a"));
    expect(byId(r, "bf-name-err")).toHaveLength(0);
    await act(async () => { await byId(r, "bf-seal")[0].props.onPress(); });
    await flush();
    const err = byId(r, "bf-name-err");
    expect(err).toHaveLength(1);
    expect(err[0].props.children).toBe(GW.text);
    act(() => inputs(r, "bf-name")[0].props.onChangeText("Rainy"));
    expect(byId(r, "bf-name-err")).toHaveLength(0);
    act(() => r.unmount());
  });
  it("编辑态:set_plan 被回 cjk_title_en=原话挂在英文格那一行下面,不进头部总报错", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    route([plan({ sent_at: null })], (_u, init) => (init?.method === "PATCH" ? resp(400, { detail: { ...GW, op_index: 0 } }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    act(() => inputs(r, "bf-name")[0].props.onChangeText("Rain"));
    await act(async () => { inputs(r, "bf-name")[0].props.onBlur(); });
    await flush();
    const err = byId(r, "bf-name-err");
    expect(err).toHaveLength(1);
    expect(err[0].props.children).toBe(GW.text);
    expect(texts(r)).not.toContain(`没改成 · ${GW.text}`);
    act(() => r.unmount());
  });
});

describe("review L1–L3", () => {
  const LONG = "一二三四五六七八九十一二三四五六七八九十"; // 20 字(引擎上限)
  it("L3 中文检测按码点对齐引擎:𠮷/全角拦,Café/〰️/〽/半角箭头 ￩ 放行", () => {
    const { hasCjkName, isCjkCodePoint } = require("./backfill");
    expect(enNameError("𠮷野家")).toBe(EN_NAME_CJK);
    expect(enNameError("A𠮷")).toBe(EN_NAME_CJK);
    expect(enNameError("Ｒａｉｎ")).toBe(EN_NAME_CJK);
    expect(enNameError("Café")).toBeNull();
    expect(enNameError("Rain 〰️")).toBeNull();
    expect(enNameError("〽 Rain")).toBeNull();
    expect(enNameError("Rain ￩")).toBeNull();          // FFE9 半角箭头
    expect(hasCjkName("ひらがな")).toBe(true);
    expect(hasCjkName("カタカナ")).toBe(true);
    expect(hasCjkName("한글")).toBe(true);
    expect(hasCjkName("ㄅㄆ")).toBe(true);
    expect(hasCjkName("Rain。")).toBe(true);            // 3002 在 3000–303F
    expect([0xffe6, 0xffe7, 0xffe8, 0xffee].map(isCjkCodePoint)).toEqual([true, false, false, false]);
  });
  it("L2 fitZh:放得下照原字号;放不下按比例缩;到下限截短末格「⋯」;任何情况估宽不越界", () => {
    const { fitZh } = require("./format");
    expect(fitZh("午后", 18, 12, 0.4, 270)).toEqual({ text: "午后", size: 18 });
    const mid = fitZh("一二三四五六七八九十一二", 18, 12, 0.4, 270);   // 12 字:缩
    expect(mid.text).toBe("一二三四五六七八九十一二");
    expect(mid.size).toBeLessThan(18); expect(mid.size).toBeGreaterThanOrEqual(12);
    const cut = fitZh(LONG, 18, 12, 0.4, 270);                           // 20 字:到下限截短
    expect(cut.size).toBe(12);
    expect(cut.text.endsWith("⋯")).toBe(true);
    for (const [base, min, k, w] of [[18, 12, 0.4, 270], [11, 9, 0.35, 196], [15.5, 12, 0.35, 266], [13.75, 11, 0.35, 258]]) {
      for (const n of [1, 5, 10, 15, 20]) {
        const r = fitZh(LONG.slice(0, n), base, min, k, w);
        expect([...r.text].length * r.size * (1 + k)).toBeLessThanOrEqual(w + 0.01);
        expect(r.size).toBeGreaterThanOrEqual(min);
      }
    }
  });
  it("L2 20 字最长名:盒盖 / 迷你请柬 / 大请柬 / 迟到的请柬 都是单行(numberOfLines=1)、估宽不越界", async () => {
    const { EphemeraBoxScreen, ZH_FIT } = require("./BoxScreen");
    mockParams = { id: "13" };
    route([plan({ title_zh: LONG, invite: "x" })]);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    const one = (id: string) => r.root.findAll((x: ReactTestInstance) => x.props.testID === id && x.type === Text)[0];
    const lid = one("lid-zh");
    expect(lid.props.numberOfLines).toBe(1);
    const ls = [lid.props.style].flat(2).reduce((a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b }), {});
    expect([...String(lid.props.children)].length * (ls.fontSize as number) * 1.4).toBeLessThanOrEqual(ZH_FIT.lid.width + 0.01);
    act(() => r.unmount());
    // 平铺页没有迟到请柬时才出迷你原请柬:换一盒寄出过的
    route([plan({ title_zh: LONG, sent_at: 1790000000 })]);
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    const mini = r.root.findAll((x: ReactTestInstance) => x.props.testID === "invite-zh" && x.type === Text)[0];
    expect(mini.props.numberOfLines).toBe(1);
    expect([...String(mini.props.children)].length * mini.props.style.fontSize * 1.35).toBeLessThanOrEqual(ZH_FIT.mini.width + 0.01);
    act(() => r.unmount());
    const late = await (async () => { let x!: TestRenderer.ReactTestRenderer; await act(async () => { x = TestRenderer.create(<LateInvite plan={plan({ invite: "x", title_zh: LONG })} P={SKINS.ivory} posted={null} to="2026.09.17" />); }); return x; })();
    const lz = late.root.findAll((x: ReactTestInstance) => x.props.testID === "late-zh" && x.type === Text)[0];
    expect(lz.props.numberOfLines).toBe(1);
    expect(String(lz.props.children).endsWith("⋯")).toBe(true);
    act(() => late.unmount());
    const { EphemeraInviteScreen } = require("./InviteScreen");
    route([plan({ title_zh: LONG, status: "sent" })]);
    let inv!: TestRenderer.ReactTestRenderer;
    await act(async () => { inv = TestRenderer.create(<EphemeraInviteScreen />); });
    await flush();
    const big = inv.root.findAll((x: ReactTestInstance) => x.props.testID === "invite-big-zh" && x.type === Text)[0];
    expect(big.props.numberOfLines).toBe(1);
    act(() => inv.unmount());
  });
  it("L1 英文名 A 在途时改成含中文的 B:回执回来后不自动发 B;那一行写明;离开照样拦", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    let release!: (r: Response) => void;
    const first = new Promise<Response>((res) => { release = res; });
    const bodies: unknown[] = [];
    route([plan({ sent_at: null })], (_u, init) => {
      if (init?.method !== "PATCH") return undefined;
      bodies.push(JSON.parse(String(init.body)).ops[0]);
      return bodies.length === 1 ? (first as never) : resp(200, plan({ sent_at: null }));
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    act(() => inputs(r, "bf-name")[0].props.onChangeText("Second Rain"));
    await act(async () => { inputs(r, "bf-name")[0].props.onBlur(); });
    act(() => inputs(r, "bf-name")[0].props.onChangeText("第二场雨"));
    await act(async () => { release(resp(200, plan({ sent_at: null, title_en: "Second\nRain" }))); await new Promise((x) => setTimeout(x, 50)); });
    await flush();
    expect(bodies).toEqual([{ op: "set_plan", title_en: "Second\nRain" }]); // B 没被发出去
    expect(inputs(r, "bf-name")[0].props.value).toBe("第二场雨");          // 草稿留着
    expect(texts(r)).toContain(EN_NAME_CJK);
    await act(async () => { const j = r.root.findAll((x: ReactTestInstance) => x.props.accessibilityLabel === "返回" && typeof x.props.onPress === "function", { deep: false })[0].props.onPress(); await new Promise((x) => setTimeout(x, 250)); await j; });
    await flush();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});
