/// <reference types="jest" />
// 补记表单组 body(只带认识的键、client_id 固定)、编辑 ops 组装、报错文案透传、有没有迟到的请柬两态、
// 书架空白书脊入口、读口里没有「补记」字段时不做区别显示、late_written 电报能显示并点开到那一盒。
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
// photo bytes of a restored draft: these tests restore drafts with photos as if the browser had kept the bytes
// (the lost-bytes path has its own tests in draftPhotos.test.tsx)
jest.mock("../../lib/draftPhotos", () => ({
  getDraftPhoto: async () => new Blob(["x"], { type: "image/jpeg" }), putDraftPhoto: async () => true,
  deleteDraftPhotos: async () => undefined, clearDraftPhotos: async () => undefined,
}));
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
import { EphemeraError, ephemeraApi, errorFromDetail, type Plan, type Stop, TIMEOUTS, TIMEOUT_READ_TEXT, TIMEOUT_WRITE_TEXT } from "../../lib/ephemeraApi";
import { addStopOp, blankStop, buildBackfill, dateValue, type Draft, invitePaper, lateStamps, lineOp, maskParts, missingLabel, neverSent, newDraft, placeOp, planOp, removeOp, seedFromDiff, seedOps, splitTitle, stopsLabel, timeOp, fieldInit, fieldStep, fieldShouldSend } from "./backfill";
import { caretColors } from "./BackfillParts";
import { MAPPAL } from "./theme";
import { shelfRows } from "./ShelfScreen";
import { PhotoFlow } from "./PhotoFlow";
import { boxStopMap } from "./BackfillScreen";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;
// 照片上传改走 XHR(要上传进度):测试里把 XHR 转给同一个 fetchMock,原有按 URL 断言照旧
class XHRviaFetch {
  upload: { onprogress?: unknown } = {}; onload?: () => void; onerror?: () => void; status = 0; responseText = "";
  private url = ""; private method = "GET";
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader() {}
  abort() {}
  send(body: unknown) {
    Promise.resolve(fetchMock(this.url, { method: this.method, body })).then(async (r: Response) => {
      this.status = r.status; this.responseText = JSON.stringify(await r.json()); this.onload?.();
    }, () => this.onerror?.());
  }
}
(global as { XMLHttpRequest?: unknown }).XMLHttpRequest = XHRviaFetch;
const resp = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} }) as Response;

const stop = (o: Partial<Stop>): Stop => ({ n: 1, stop_id: 11, kind: "cafe", time: "14:00", stay_until: null, clue: null, note: null, her_line: null,
  place: { title: "转角咖啡 东站", address: null, lat: null, lng: null, how_to_get: null, walk_path: null, leg: null }, ...o });
const plan = (o: Partial<Plan>): Plan => ({ id: 13, paper_no: "0503", title_en: "First\nRain", date: "2026-05-03", color: "cream", status: "done",
  stops: [stop({})], prep: [], contract: null, card: null, quote: null, sent_at: null, closed_at: 1793181000, cancelled_at: null, invite: null, ...o });

const BACKFILL_KEYS = ["client_id", "date", "title_en", "color", "stops", "invite_text", "contract", "card"];
const STOP_KEYS = ["kind", "time", "title", "address", "lat", "lng", "her_line"];

describe("补记表单 → 请求体", () => {
  const d = (o: Partial<Draft>): Draft => ({ year: "2026", md: "0503", name: "First Rain", color: "cream", stops: [], ...o });
  it("只带认识的键,空的不带;client_id 原样带上", () => {
    const s1 = { ...blankStop(), kind: "cafe" as const, time: "1400", title: " 转角咖啡 东站 ", herLine: "下雨了，他把伞往我这边歪" };
    const s2 = { ...blankStop(), kind: "walk" as const, title: "青川", address: "青川区 河畔 1丁目", lat: 35.644, lng: 139.699 };
    const { body, sent } = buildBackfill(d({ stops: [s1, blankStop(), s2] }), "bf-x");
    expect(body).toEqual({ client_id: "bf-x", date: "2026-05-03", title_en: "First\nRain", color: "cream", stops: [
      { kind: "cafe", time: "14:00", title: "转角咖啡 东站", her_line: "下雨了，他把伞往我这边歪" },
      { kind: "walk", title: "青川", address: "青川区 河畔 1丁目", lat: 35.644, lng: 139.699 },
    ] });
    expect(sent.map((s) => s.key)).toEqual([s1.key, s2.key]); // 什么都没写的那站不发,照片按发出的站对 stop_id
    for (const k of Object.keys(body)) expect(BACKFILL_KEYS).toContain(k);
    for (const st of body.stops) for (const [k, v] of Object.entries(st)) { expect(STOP_KEYS).toContain(k); expect(v).not.toBe(""); expect(v).not.toBeNull(); }
  });
  it("没填的日期/名字/颜色整键不带;只敲一半的时间、日期照敲的带(让引擎回原因,不静默丢)", () => {
    const { body } = buildBackfill(d({ md: "", year: "", name: "  ", color: null, stops: [{ ...blankStop(), title: "a", time: "153" }] }), "c");
    expect(body).toEqual({ client_id: "c", stops: [{ title: "a", time: "15:3" }] });
    expect(dateValue("2026", "050")).toBe("2026-05-0");
    expect(buildBackfill(newDraft(new Date(2026, 9, 22)), "c").body).toEqual({ client_id: "c", date: "2026-", stops: [] });
  });
  it("书脊名折成两行(同他写的约会名);数字框淡显没敲的那截", () => {
    expect(splitTitle("First Rain")).toBe("First\nRain");
    expect(splitTitle("Last Night of the Year")).toBe("Last Night\nof the Year");
    expect(splitTitle("  Moonlit ")).toBe("Moonlit");
    expect(maskParts("153", "00:00")).toEqual(["15:3", "0"]);
    expect(maskParts("", "00.00")).toEqual(["", "00.00"]);
    expect(maskParts("05", "00.00")).toEqual(["05", ".00"]);
  });
});

describe("编辑 ops", () => {
  it("每种 op 只带契约里的键", () => {
    expect(lineOp(5, " 他买错了票 ")).toEqual({ op: "set_line", stop_id: 5, her_line: "他买错了票" });
    expect(lineOp(5, "")).toEqual({ op: "set_line", stop_id: 5, her_line: "" }); // 空=删
    expect(timeOp(5, "1930")).toEqual({ op: "update_stop", stop_id: 5, time: "19:30" });
    expect(placeOp(5, " 青川 ")).toEqual({ op: "update_stop", stop_id: 5, title: "青川" });
    expect(placeOp(5, "青川", { title: "青川", address: "青川区", lat: 35.6, lng: 139.6 })).toEqual({ op: "update_stop", stop_id: 5, title: "青川", address: "青川区", lat: 35.6, lng: 139.6 });
    expect(placeOp(5, "x", { title: "X", address: null, lat: null, lng: null })).toEqual({ op: "update_stop", stop_id: 5, title: "X" });
    expect(addStopOp({ ...blankStop(), kind: "walk", title: "青川", herLine: "风很大" })).toEqual({ op: "add_stop", kind: "walk", title: "青川", her_line: "风很大" });
    expect(removeOp(7)).toEqual({ op: "remove_stop", stop_id: 7 });
    expect(planOp({ name: "First Rain" })).toEqual({ op: "set_plan", title_en: "First\nRain" });
    expect(planOp({ year: "2026", md: "0504" })).toEqual({ op: "set_plan", date: "2026-05-04" });
    expect(planOp({ color: "sky" })).toEqual({ op: "set_plan", color: "sky" });
  });
});

describe("报错文案透传", () => {
  beforeEach(() => fetchMock.mockReset());
  it("detail 对象 → message=text,带 code/field/op_index;字符串照旧;别的形状给 HTTP 码", () => {
    const e = errorFromDetail(403, { code: "his_stop", text: "第 1 站是他写的，不能删", op_index: 0, field: "stop_id" });
    expect([e.message, e.code, e.field, e.opIndex, e.status]).toEqual(["第 1 站是他写的，不能删", "his_stop", "stop_id", 0, 403]);
    expect(errorFromDetail(404, "not found").message).toBe("没有找到，可能已经删掉了");   // the engine's few English lines become Chinese
    expect(errorFromDetail(422, [{ msg: "x" }]).message).toBe("后台出错了（HTTP 422），等一下再试");
  });
  it("引擎拒绝时 ephemeraApi 抛出的就是那句原话", async () => {
    fetchMock.mockResolvedValueOnce(resp(400, { detail: { code: "not_past", text: "补记的约会日期要早于今天（今天是 10/28）", field: "date" } }));
    await expect(ephemeraApi.backfill({ client_id: "c", stops: [] })).rejects.toMatchObject({ message: "补记的约会日期要早于今天（今天是 10/28）", code: "not_past", field: "date" });
    fetchMock.mockResolvedValueOnce(resp(503, { detail: { code: "gate_off", text: "地点搜索现在关着（地图的花钱开关没开），先手写地址" } }));
    await expect(ephemeraApi.placeSearch("青川")).rejects.toBeInstanceOf(EphemeraError);
    expect(fetchMock.mock.calls[1][0]).toBe(`http://gw.test/api/dates/place_search?q=${encodeURIComponent("青川")}`);
  });
});

describe("请柬两态 + 邮戳", () => {
  it("他写了迟到的请柬=那张;没写且从没寄出=不出现;他写的约会照旧原请柬", () => {
    expect(invitePaper({ invite: "请你再来一次", sent_at: null })).toBe("late");
    expect(invitePaper({ invite: null, sent_at: null })).toBeNull();
    expect(invitePaper({ invite: undefined, sent_at: 1790000000 })).toBe("original");
  });
  it("写信那天=这一盒的 late_written(请柬那条,取最新);拿不到用 closed_at", () => {
    const p = plan({});
    const ev = (id: number, kind: string, text: string, at: number) => ({ id, plan_id: 13, kind, text, created_at: at, read_at: null });
    expect(lateStamps(p, [ev(1, "late_written", "他写好了小卡", 1792000000), ev(2, "late_written", "他写好了迟到的请柬", 1792900000), { ...ev(3, "late_written", "他写好了迟到的请柬", 1793000000), plan_id: 9 }] as never))
      .toEqual({ posted: "2026.10.25", to: "2026.05.03" });
    expect(lateStamps(p, [])).toEqual({ posted: "2026.10.28", to: "2026.05.03" });
  });
});

describe("收口小修", () => {
  it("从没寄出过=补记的那一盒(迟到请柬与头部那条共用);1 站写单数", () => {
    expect(neverSent({ sent_at: null })).toBe(true);
    expect(neverSent({ sent_at: 1790000000 })).toBe(false);
    expect([stopsLabel(1), stopsLabel(2), stopsLabel(6)]).toEqual(["1 STOP", "2 STOPS", "6 STOPS"]);
  });
  it("光标色两档肉眼无差,都是路线色", () => {
    const [a, b] = caretColors("#C15772");
    expect(a).toBe("rgba(193,87,114,1)");
    expect(b).toBe("rgba(193,87,114,0.996)");
  });
});

describe("书架分层", () => {
  it("一本都没有也有第一层(放空白书脊);第一层留出空白书脊的位置,不伸出屏外", () => {
    expect(shelfRows([])).toEqual([[]]);
    for (let k = 1; k <= 16; k++) {
      const r0 = shelfRows(Array.from({ length: k }, (_, i) => i))[0];
      const right = 22 + r0.reduce((a, b) => a + b.w, 0) + 6 * r0.length; // 空白书脊左边
      expect(right + 44).toBeLessThanOrEqual(390);
    }
    // 小样那排(11 次约会)第一层仍是四本
    expect(shelfRows(Array.from({ length: 11 }, (_, i) => i))[0]).toHaveLength(4);
  });
});

// ── 页面 ──────────────────────────────────────────────────────────────────────────
const texts = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(Text).map((t) => [t.props.children].flat(3).filter((x) => typeof x === "string").join("")).join("|");
const byId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n: ReactTestInstance) => n.props.testID === id && typeof n.type !== "string", { deep: false });
async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); }

function route(url: string, plans: Plan[], extra: (u: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const x = extra(u, init);
    if (x) return x;
    if (u.endsWith("/api/dates")) return resp(200, { plans });
    const m = u.match(/\/api\/dates\/(\d+)$/);
    if (m) return resp(200, plans.find((p) => p.id === Number(m[1])));
    if (/\/her$/.test(u) && (!init || init.method === undefined)) return resp(200, { marks: { lid: { at: 1, value: true } }, photos: [], now: 1793181000 });
    if (u.includes("/map")) return resp(200, { empty: true, attribution: "" });
    if (u.includes("/events")) return resp(200, { events: [] });
    return resp(404, { detail: "not found" });
  });
  return url;
}

describe("书架:空白书脊入口", () => {
  beforeEach(() => { fetchMock.mockReset(); mockRouter.push.mockReset(); });
  it("第一层末尾有一本空白书脊,点它进补记页;一个盒子都没有时也在", async () => {
    const { EphemeraShelfScreen } = require("./ShelfScreen");
    for (const plans of [[plan({ id: 7, sent_at: 1790000000 })], []]) {
      route("", plans);
      let r!: TestRenderer.ReactTestRenderer;
      await act(async () => { r = TestRenderer.create(<EphemeraShelfScreen />); });
      await flush();
      const blank = byId(r, "shelf-blank-spine");
      expect(blank).toHaveLength(1);
      await act(async () => { blank[0].props.onPress(); });   // 先量起点再跳页(飞行层),跳页晚一拍
      await flush();
      expect(mockRouter.push).toHaveBeenLastCalledWith("/ephemera-backfill?m=1");   // 空白书抽出来变补记页(飞行层),整页只淡入
      act(() => r.unmount());
    }
  });
});

describe("补记页", () => {
  beforeEach(async () => { fetchMock.mockReset(); mockRouter.back.mockReset(); await require("@react-native-async-storage/async-storage").clear(); });
  it("草稿:写的东西停手后存在手机上,再进补记页接着写;盒子建成就清掉", async () => {
    const AS = require("@react-native-async-storage/async-storage");
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const { BACKFILL_DRAFT_KEY } = require("./backfill");
    route("", [], (u) => (u.endsWith("/backfill") ? resp(200, plan({})) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    const input = (id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id)[0];
    act(() => input("bf-name").props.onChangeText("Golden Hour"));
    act(() => input("bf-title-0").props.onChangeText("西川"));
    await act(async () => { await new Promise((x) => setTimeout(x, 450)); });
    expect(JSON.parse(await AS.getItem(BACKFILL_DRAFT_KEY)).draft.name).toBe("Golden Hour");
    act(() => r.unmount());
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    expect(input("bf-name").props.value).toBe("Golden Hour");
    expect(input("bf-title-0").props.value).toBe("西川");
    act(() => input("bf-time-0").props.onChangeText("1700"));
    act(() => input("bf-md").props.onChangeText("1010"));
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-seal" && typeof x.props.onPress === "function")[0].props.onPress(); });
    await flush();
    expect(await AS.getItem(BACKFILL_DRAFT_KEY)).toBeNull();
    act(() => r.unmount());
  });
  it("草稿(review):敲完立刻离开也存上;盒子建成但照片没传完=草稿留着盒子,回来是补照片状态,不建第二盒", async () => {
    const AS = require("@react-native-async-storage/async-storage");
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const { BACKFILL_DRAFT_KEY } = require("./backfill");
    let backfills = 0;
    route("", [], (u) => {
      if (u.endsWith("/backfill")) { backfills++; return resp(200, plan({ id: 21, stops: [stop({ stop_id: 77 })] })); }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    const input = (id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id)[0];
    act(() => input("bf-name").props.onChangeText("Golden Hour"));
    act(() => r.unmount());                                   // 没等 400ms 就走
    await flush();
    expect(JSON.parse(await AS.getItem(BACKFILL_DRAFT_KEY)).draft.name).toBe("Golden Hour");
    // 建盒成功、照片上传失败(草稿里带一张没传的照片)
    const ephemera = require("../../lib/ephemeraApi");
    const up = jest.spyOn(ephemera.ephemeraApi, "uploadPhoto").mockRejectedValue(new Error("网断了"));
    const d0 = JSON.parse(await AS.getItem(BACKFILL_DRAFT_KEY));
    d0.draft.md = "1010";
    d0.draft.stops[0] = { ...d0.draft.stops[0], kind: "walk", time: "1700", title: "西川",
      photo: { uri: "file:///sunset.jpg", mimeType: "image/jpeg", fileName: "sunset.jpg", caption: "日落", clientId: "ph-1" } };
    await AS.setItem(BACKFILL_DRAFT_KEY, JSON.stringify(d0));
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-seal" && typeof x.props.onPress === "function")[0].props.onPress(); });
    await flush();
    const saved = JSON.parse(await AS.getItem(BACKFILL_DRAFT_KEY));
    expect(saved.box).toEqual({ id: 21, sid: expect.any(Object) });   // 盒子记在草稿里
    act(() => r.unmount());
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    expect(input("bf-title-0").props.value).toBe("西川");
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-seal" && typeof x.props.onPress === "function")[0].props.onPress(); });
    await flush();
    expect(backfills).toBe(1);                                // 回来再点火漆:不建第二盒
    up.mockRestore();
    act(() => r.unmount());
  });
  it("草稿(review):只改了年份也恢复;恢复后传过又换掉的那站按「换掉」传,已传没改的不重传", async () => {
    const AS = require("@react-native-async-storage/async-storage");
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const { BACKFILL_DRAFT_KEY, newDraft } = require("./backfill");
    route("", [], () => undefined);
    const yr = { ...newDraft(), year: "2019" };
    await AS.setItem(BACKFILL_DRAFT_KEY, JSON.stringify({ v: 1, draft: yr, clientId: "bf-y", at: 1 }));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    const input = (id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id)[0];
    expect(input("bf-year").props.value).toBe("2019");
    act(() => r.unmount());
    const ephemera = require("../../lib/ephemeraApi");
    const up = jest.spyOn(ephemera.ephemeraApi, "uploadPhoto").mockResolvedValue({ id: 1, stop_id: 77, caption: null, created_at: 1 });
    const d = { ...newDraft(), md: "1010", name: "Golden Hour" };
    const ph = (cid: string) => ({ uri: `file:///${cid}.jpg`, mimeType: "image/jpeg", fileName: "a.jpg", caption: "", clientId: cid });
    d.stops = [{ ...d.stops[0], key: "a", kind: "walk", time: "1700", title: "西川", photo: ph("p-new") },
               { ...d.stops[0], key: "b", kind: "walk", time: "1800", title: "河边", photo: ph("p-b") }];
    await AS.setItem(BACKFILL_DRAFT_KEY, JSON.stringify({ v: 1, draft: d, clientId: "bf-z", at: 1, box: { id: 21, sid: { a: 77, b: 78 } },
      up: ["b"], ever: ["a", "b"] }));
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    await act(async () => { await r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-seal" && typeof x.props.onPress === "function")[0].props.onPress(); });
    await flush();
    expect(up).toHaveBeenCalledTimes(1);                       // b 已传没改:不重传
    expect(up.mock.calls[0][1]).toBe(77);
    expect(up.mock.calls[0][6]).toBe(true);                    // a 传过又换了:按「换掉」传
    up.mockRestore();
    act(() => r.unmount());
  });
  it("空格里的淡字:日期/时间给入力例,名字/地名/那一句给指示;一敲就让开", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const { HINT } = require("./BackfillParts");
    route("", [], () => undefined);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    const input = (id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id)[0];
    expect(texts(r)).toContain("05.03");
    expect(texts(r)).toContain("14:00");
    expect(texts(r)).toContain("起个英文名");
    expect(texts(r)).toContain(HINT.place); // 地名的淡字压在输入框下面(不用 placeholder:那会跟输入框同为 14.5 粗体)
    expect(input("bf-title-0").props.placeholder).toBeUndefined();
    const line = r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.accessibilityLabel === "她的一句话")[0];
    expect(line.props.placeholder).toBe(HINT.line);
    act(() => input("bf-name").props.onChangeText("F"));
    act(() => input("bf-md").props.onChangeText("1"));
    act(() => input("bf-time-0").props.onChangeText("1"));
    act(() => input("bf-title-0").props.onChangeText("目"));
    expect(texts(r)).not.toContain(HINT.place);
    expect(texts(r)).not.toContain("起个英文名");
    expect(texts(r)).not.toContain("05.03");
    expect(texts(r)).toContain("1|0.00");          // 敲了一位:换回「敲了的 + 淡模板」
    act(() => r.unmount());
  });
  it("封火漆:报错原样显示;再封一次用同一个 client_id;成了回书架", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    const bodies: Array<Record<string, unknown>> = [];
    let n = 0;
    route("", [], (u, init) => {
      if (!u.endsWith("/backfill")) return undefined;
      bodies.push(JSON.parse(String(init?.body)));
      return n++ === 0 ? resp(400, { detail: { code: "bad_color", text: "颜色只能是 blush 浅粉 / rose 粉", field: "color" } }) : resp(200, plan({}));
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    const input = (id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id)[0];
    act(() => input("bf-title-0").props.onChangeText("转角咖啡 东站"));
    act(() => input("bf-time-0").props.onChangeText("1400"));
    act(() => input("bf-name").props.onChangeText("First Rain"));
    act(() => input("bf-md").props.onChangeText("0503"));
    await act(async () => { await byId(r, "bf-seal")[0].props.onPress(); });
    await flush();
    expect(texts(r)).toContain("没存好 · 颜色只能是 blush 浅粉 / rose 粉");
    expect(mockRouter.back).not.toHaveBeenCalled();
    await act(async () => { await byId(r, "bf-seal")[0].props.onPress(); });
    await flush();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].client_id).toBeTruthy();
    expect(bodies[1].client_id).toBe(bodies[0].client_id);
    expect(bodies[0]).toEqual({ client_id: bodies[0].client_id, date: `${new Date().getFullYear()}-05-03`, title_en: "First\nRain", stops: [{ title: "转角咖啡 东站", time: "14:00" }] });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });
});

describe("纪念盒", () => {
  beforeEach(() => { fetchMock.mockReset(); });
  async function open(p: Plan, extra?: Parameters<typeof route>[2]) {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: String(p.id) };
    route("", [p], extra);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    return r;
  }
  it("请他补寄:列出他还没写的几样;按一次全部请;请过=已经请他了;叫醒没成=可再请;被拒=原话", async () => {
    const wr = (state: "none" | "queued" | "sent" | "failed", pending = ["invite", "contract", "card", "quote", "wb_after"]) =>
      plan({ write_request: { pending, requested_at: state === "none" ? null : 1793181000, state }, together_day: 28 });
    const posts: string[] = [];
    let r = await open(wr("none"), (u, init) => {
      if (!u.endsWith("/her/request_write")) return undefined;
      posts.push(JSON.parse(String(init?.body)).client_id);
      return resp(200, wr("queued"));
    });
    expect(texts(r)).toContain("迟到的请柬 · 契约书\n小卡 · 那一句话");     // 两样一行;事件卡后续不列给她
    expect(texts(r)).toContain("请他补寄 ›");
    expect(texts(r)).toContain("在一起的第 28 天");
    await act(async () => { await byId(r, "ask-slip")[0].props.onPress(); });
    await flush();
    expect(posts).toHaveLength(1);
    expect(texts(r)).toContain("已经请他了");
    act(() => r.unmount());
    r = await open(wr("failed"));
    expect(texts(r)).toContain("没叫醒他 · 再请一次 ›");
    act(() => r.unmount());
    r = await open(wr("none"), (u) => (u.endsWith("/her/request_write") ? resp(409, { detail: { code: "nothing_to_write", text: "他都写完了" } }) : undefined));
    await act(async () => { await byId(r, "ask-slip")[0].props.onPress(); });
    await flush();
    expect(texts(r)).toContain("没请成 · 他都写完了");
    act(() => r.unmount());
    r = await open(wr("none", ["wb_after"]));                                // 只剩事件卡后续=不出现
    expect(byId(r, "ask-slip")).toHaveLength(0);
    act(() => r.unmount());
  });
  it("平铺页:有迟到的请柬=那张;补记且他没写=请柬位置空;他写的=原请柬", async () => {
    for (const [p, want] of [[plan({ invite: "那天下着雨。" }), "flat-invite-late"], [plan({}), null], [plan({ sent_at: 1790000000 }), "flat-invite-original"]] as const) {
      const r = await open(p);
      const ids = ["flat-invite-late", "flat-invite-original"].filter((id) => byId(r, id).length);
      expect(ids).toEqual(want ? [want] : []);
      if (want === "flat-invite-late") expect(texts(r)).toContain("A LATE INVITATION · SENT AFTER THE DAY");
      act(() => r.unmount());
    }
  });
  it("读口里没有补记字段:他写的和补记的已结束约会,页面上一样有钢笔尖,也没有任何「补记」字样", async () => {
    for (const p of [plan({ sent_at: 1790000000 }), plan({})]) {
      expect(Object.keys(p)).not.toContain("origin");
      const r = await open(p);
      expect(byId(r, "box-pen")).toHaveLength(1);
      expect(texts(r)).not.toMatch(/补记|origin|BACKFILL/i);
      act(() => r.unmount());
    }
  });
  it("编辑态头部那条(名字/日期/颜色)只在从没寄出过的那一盒出现;他写的盒子没有", async () => {
    for (const [p, want] of [[plan({ sent_at: 1790000000 }), 0], [plan({}), 1]] as const) {
      const r = await open(p);
      const nameInput = () => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === "bf-name");
      expect(nameInput()).toHaveLength(0);
      await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
      expect(nameInput()).toHaveLength(want);
      act(() => r.unmount());
    }
  });
  it("路线页头 1 站写「1 STOP」,多站「N STOPS」", async () => {
    const one = await open(plan({}));
    expect(texts(one)).toContain("· 1 STOP");
    expect(texts(one)).not.toContain("1 STOPS");
    act(() => one.unmount());
    const two = await open(plan({ stops: [stop({}), stop({ n: 2, stop_id: 12 })] }));
    expect(texts(two)).toContain("· 2 STOPS");
    act(() => two.unmount());
  });
  it("补记页与编辑态所有能打字的框光标都是路线色(获得焦点在两档间换,逼原生重设)", async () => {
    const ok = caretColors(MAPPAL.ivory.route);
    const typing = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && !x.props.caretHidden);
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    route("", []);
    let b!: TestRenderer.ReactTestRenderer;
    await act(async () => { b = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    const ins = typing(b);
    expect(ins.length).toBeGreaterThanOrEqual(4); // 年份 / 书脊名 / 地名 / 她的一句话
    for (const x of ins) expect(ok).toContain(x.props.selectionColor);
    const before = typing(b).find((x) => x.props.testID === "bf-title-0")!.props.selectionColor;
    act(() => typing(b).find((x) => x.props.testID === "bf-title-0")!.props.onFocus({}));
    expect(typing(b).find((x) => x.props.testID === "bf-title-0")!.props.selectionColor).not.toBe(before);
    act(() => b.unmount());
    const r = await open(plan({}));
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    const eins = typing(r);
    expect(eins.length).toBeGreaterThanOrEqual(4); // 年份 / 书脊名 / 地名 / 她的一句话
    for (const x of eins) expect(ok).toContain(x.props.selectionColor);
    act(() => r.unmount());
  });
  it("非编辑态显示她的一句话;编辑态改一句发 set_line;被拒=原话提示", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const r = await open(plan({ stops: [stop({ her_line: "下雨了" }), stop({ n: 2, stop_id: 12, her_line: null })] }), (u, init) => {
      if (init?.method !== "PATCH") return undefined;
      calls.push(JSON.parse(String(init.body)));
      return resp(403, { detail: { code: "his_stop", text: "第 2 站是他写的，不能删（时间、地名、地址、位置可以改）", op_index: 0, field: "stop_id" } });
    });
    expect(texts(r)).toContain("下雨了");
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    const line = () => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === "edit-line-12")[0];
    act(() => line().props.onFocus());
    act(() => line().props.onChangeText("风很大"));
    await act(async () => { line().props.onBlur(); });
    await flush();
    expect(calls).toEqual([{ ops: [{ op: "set_line", stop_id: 12, her_line: "风很大" }] }]);
    expect(texts(r)).toContain("没改成 · 第 2 站是他写的，不能删（时间、地名、地址、位置可以改）");
    act(() => r.unmount());
  });
});

describe("电报:late_written", () => {
  beforeEach(() => { fetchMock.mockReset(); mockRouter.push.mockReset(); });
  it("出现在电报列表,点开落到那一盒", async () => {
    const { EphemeraTelegramsScreen } = require("./TelegramsScreen");
    const p = plan({});
    route("", [p], (u) => (u.endsWith("/events") ? resp(200, { events: [{ id: 5, plan_id: 13, kind: "late_written", text: "他写好了迟到的请柬", created_at: 1793181000, read_at: null }] })
      : u.endsWith("/events/read") ? resp(200, { marked: 1 }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraTelegramsScreen />); });
    await flush();
    expect(texts(r)).toContain("他写好了迟到的请柬");
    await act(async () => { await byId(r, "date-telegram-late_written")[0].props.onPress(); });
    await flush();
    expect(mockRouter.push).toHaveBeenCalledWith("/ephemera-box?id=13");
    act(() => r.unmount());
  });
});

// ── 返工:她输入的东西不许悄悄丢 ──────────────────────────────────────────
function deferred<T>() { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; }
const inputs = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === id);
const byLabel = (r: TestRenderer.ReactTestRenderer, label: string) => r.root.findAll((x: ReactTestInstance) => x.props.accessibilityLabel === label && typeof x.props.onPress === "function" && typeof x.type !== "string", { deep: false });

/** 种类改成点「当前类别」弹种类表再点一组(原来那一排小图标没了);默认最后一行(补的那一站) */
const chooseKind = async (r: TestRenderer.ReactTestRenderer, kind: string) => {
  const chips = r.root.findAll((x: ReactTestInstance) => typeof x.props.testID === "string" && /^(bf|edit)-kind-/.test(x.props.testID) && typeof x.props.onPress === "function" && typeof x.type !== "string", { deep: false });
  await act(async () => { chips[chips.length - 1].props.onPress(); });
  await act(async () => { r.root.findAll((x: ReactTestInstance) => x.props.testID === `kind-${kind}` && typeof x.props.onPress === "function" && typeof x.type !== "string", { deep: false })[0].props.onPress(); });
};
const fdGet = (fd: unknown, k: string): unknown => {
  const f = fd as { get?: (k: string) => unknown; getParts?: () => Array<{ fieldName: string; string?: string }> };
  return typeof f.get === "function" ? f.get(k) : f.getParts?.().find((x) => x.fieldName === k)?.string;
};

describe("返工:纯函数", () => {
  it("缺项文案 / 在途补交 / 盒子建成后的行→站映射", () => {
    expect(missingLabel({ kind: null, title: " " })).toBe("还缺类型和地名");
    expect(missingLabel({ kind: null, title: "青川" })).toBe("还缺类型");
    expect(missingLabel({ kind: "walk", title: "" })).toBe("还缺地名");
    expect(missingLabel({ kind: "walk", title: "青川" })).toBeNull();
    const sent = { ...blankStop(), kind: "walk" as const, title: "青川" };
    expect(seedFromDiff(sent, sent)).toBeNull();
    const seed = seedFromDiff(sent, { ...sent, herLine: "风很大", time: "1530" })!;
    expect(seedOps(99, seed)).toEqual([{ op: "update_stop", stop_id: 99, time: "15:30" }, { op: "set_line", stop_id: 99, her_line: "风很大" }]);
    const a = blankStop(), b = blankStop();
    expect(boxStopMap([a, b], { stops: [{ stop_id: 41 }, { stop_id: 42 }] as never })).toEqual({ [a.key]: 41, [b.key]: 42 });
  });
  it("herWrite 请求契约:PUT /her/write,契约书用 items,小卡/请柬用 text", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(resp(200, plan({})));
    await ephemeraApi.herWrite(13, { what: "contract", items: ["第一条"] });
    await ephemeraApi.herWrite(13, { what: "card", text: "给你" });
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i.method, JSON.parse(i.body)])).toEqual([
      ["http://gw.test/api/dates/13/her/write", "PUT", { what: "contract", items: ["第一条"] }],
      ["http://gw.test/api/dates/13/her/write", "PUT", { what: "card", text: "给你" }],
    ]);
  });
});

describe("返工:纪念盒编辑态", () => {
  beforeEach(() => fetchMock.mockReset());
  async function openEdit(p: Plan, patch: (body: { ops: Array<Record<string, unknown>> }, u: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: String(p.id) };
    route("", [p], (u, init) => (init?.method === "PATCH" ? patch(JSON.parse(String(init.body)), u, init) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    return r;
  }
  const penOut = async (r: TestRenderer.ReactTestRenderer) => { await act(async () => { const j = byId(r, "box-pen")[0].props.onPress(); await new Promise((x) => setTimeout(x, 200)); await j; }); await flush(); };

  it("G1 改名字时点了颜色:名字草稿不被引擎那份盖掉;名字被拒=草稿留着 + 原话", async () => {
    const r = await openEdit(plan({}), (b) => (b.ops[0].color ? resp(200, plan({ color: "sky" }))
      : resp(400, { detail: { code: "long_title_en", text: "英文名每行最多 24 个字符", field: "title_en" } })));
    act(() => inputs(r, "bf-name")[0].props.onChangeText("Second Rain"));
    await act(async () => { byLabel(r, "sky")[0].props.onPress(); });
    await flush();
    expect(inputs(r, "bf-name")[0].props.value).toBe("Second Rain");
    await act(async () => { inputs(r, "bf-name")[0].props.onBlur(); });
    await flush();
    expect(inputs(r, "bf-name")[0].props.value).toBe("Second Rain");
    expect(texts(r)).toContain("没改成 · 英文名每行最多 24 个字符");
    act(() => r.unmount());
  });

  it("G2 补的站在途时她接着写的一句话:站建好后补交,不丢", async () => {
    const add = deferred<Response>();
    const bodies: unknown[] = [];
    const r = await openEdit(plan({}), (b) => {
      bodies.push(b);
      if (b.ops[0].op === "add_stop") return add.p;
      return resp(200, plan({ stops: [stop({}), stop({ n: 2, stop_id: 99, kind: "walk", place: { ...stop({}).place!, title: "青川" }, her_line: "风很大" })] }));
    });
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("青川"));
    await chooseKind(r, "walk");
    expect(bodies).toEqual([{ ops: [{ op: "add_stop", kind: "walk", title: "青川" }] }]);
    act(() => inputs(r, "bf-line-1")[0].props.onFocus());
    act(() => inputs(r, "bf-line-1")[0].props.onChangeText("风很大"));
    await act(async () => { add.resolve(resp(200, plan({ stops: [stop({}), stop({ n: 2, stop_id: 99, kind: "walk", place: { ...stop({}).place!, title: "青川" } })] }))); });
    await flush();
    expect(bodies[1]).toEqual({ ops: [{ op: "set_line", stop_id: 99, her_line: "风很大" }] });
    act(() => r.unmount());
  });

  it("G3 钢笔尖退出时有没填完的补站:停在编辑态,那一行写「还缺类型」,草稿还在", async () => {
    const r = await openEdit(plan({}), () => resp(200, plan({})));
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("青川"));
    await penOut(r);
    expect(inputs(r, "bf-title-1")[0].props.value).toBe("青川");
    expect(texts(r)).toContain("还缺类型");
    act(() => r.unmount());
  });

  it("G4 补的站照片上传失败:照片和目标站留着,报错可见,点卡套原地重试", async () => {
    const photoCalls: unknown[] = [];
    const { EphemeraBoxScreen } = require("./BoxScreen");
    const p = plan({});
    mockParams = { id: "13" };
    route("", [p], (u, init) => {
      if (init?.method === "PATCH") return resp(200, plan({ stops: [stop({}), stop({ n: 2, stop_id: 99, kind: "walk" })] }));
      if (u.endsWith("/her/photo")) { photoCalls.push(fdGet(init?.body, "stop_id")); return photoCalls.length === 1 ? resp(500, { detail: "磁盘满了" }) : resp(200, { id: 1, stop_id: 99, caption: null, created_at: 1 }); }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    await act(async () => { byLabel(r, "第 2 站的卡套")[0].props.onPress(); });
    await act(async () => { await r.root.findByType(PhotoFlow).props.onDone({ uri: "file:///p.jpg", mimeType: "image/jpeg", fileName: "p.jpg" }, "", "cid-1"); });
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("青川"));
    await chooseKind(r, "walk");
    await flush();
    expect(photoCalls).toEqual(["99"]);
    expect(texts(r)).toContain("没收好 · 磁盘满了 · 点卡套再试一次");
    await penOut(r);
    expect(byId(r, "box-sleeve-99")).toHaveLength(1); // 还在编辑态(照片没传上不退出)
    await act(async () => { byId(r, "box-sleeve-99")[0].props.onPress(); });
    await flush();
    expect(photoCalls).toEqual(["99", "99"]);
    expect(texts(r)).not.toContain("磁盘满了");
    act(() => r.unmount());
  });

  it("G5 改动串行:上一笔没回来,下一笔不发;回执按先后换上", async () => {
    const first = deferred<Response>();
    const bodies: unknown[] = [];
    const two = [stop({}), stop({ n: 2, stop_id: 12 })];
    const r = await openEdit(plan({ stops: two }), (b) => {
      bodies.push(b);
      if (bodies.length === 1) return first.p;
      return resp(200, plan({ stops: [stop({ her_line: "一" }), stop({ n: 2, stop_id: 12, her_line: "二" })] }));
    });
    const line = (id: number) => inputs(r, `edit-line-${id}`)[0];
    for (const [id, v] of [[11, "一"], [12, "二"]] as const) {
      act(() => line(id).props.onFocus());
      act(() => line(id).props.onChangeText(v));
      await act(async () => { line(id).props.onBlur(); });
    }
    await flush();
    expect(bodies).toHaveLength(1);
    await act(async () => { first.resolve(resp(200, plan({ stops: [stop({ her_line: "一" }), stop({ n: 2, stop_id: 12 })] }))); });
    await flush();
    expect(bodies).toEqual([{ ops: [{ op: "set_line", stop_id: 11, her_line: "一" }] }, { ops: [{ op: "set_line", stop_id: 12, her_line: "二" }] }]);
    await penOut(r);
    expect(texts(r)).toContain("一");
    expect(texts(r)).toContain("二");
    act(() => r.unmount());
  });

  it("事件读失败:不打扰她,邮戳用 closed_at,记一笔 warn;迟到请柬拿起来看可以滚", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    route("", [plan({ invite: "很长的请柬".repeat(30) })], (u) => (u.includes("/events") ? resp(500, { detail: "boom" }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("迟到请柬读事件失败"))).toBe(true);
    expect(r.root.findAll((x: ReactTestInstance) => typeof x.props.xml === "string" && x.props.xml.includes("POSTED · 2026.10.28")).length).toBeGreaterThan(0);
    await act(async () => { byId(r, "flat-invite-late")[0].props.onPress(); });
    expect(byId(r, "late-invite-scroll")).toHaveLength(1);
    act(() => r.unmount());
    warn.mockRestore();
  });
});

describe("返工:补记页", () => {
  beforeEach(() => { fetchMock.mockReset(); mockRouter.back.mockReset(); });
  it("盒子建成但照片失败:再点火漆只补照片,按建成时钉死的行→站挂,不再建第二盒", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    let backfills = 0;
    const photo: unknown[] = [];
    route("", [], (u, init) => {
      if (u.endsWith("/backfill")) { backfills++; return resp(200, plan({ id: 21, stops: [stop({ stop_id: 77 })] })); }
      if (u.endsWith("/her/photo")) { photo.push([u, fdGet(init?.body, "stop_id")]); return photo.length === 1 ? resp(500, { detail: "磁盘满了" }) : resp(200, { id: 1, stop_id: 77, caption: null, created_at: 1 }); }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("转角咖啡"));
    await act(async () => { byLabel(r, "第 1 站的卡套")[0].props.onPress(); });
    await act(async () => { await r.root.findByType(PhotoFlow).props.onDone({ uri: "file:///p.jpg", mimeType: "image/jpeg", fileName: "p.jpg" }, "", "cid-1"); });
    await act(async () => { await byId(r, "bf-seal")[0].props.onPress(); });
    await flush();
    expect(texts(r)).toContain("照片没收好 · 磁盘满了");
    await act(async () => { await byId(r, "bf-seal")[0].props.onPress(); });
    await flush();
    expect(backfills).toBe(1);
    expect(photo).toEqual([["http://gw.test/api/dates/21/her/photo", "77"], ["http://gw.test/api/dates/21/her/photo", "77"]]);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });
  it("地名搜不了:原话挂在那一行,失焦后还在,直到她再输入", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    route("", [], (u) => (u.includes("place_search") ? resp(503, { detail: { code: "gate_off", text: "地点搜索现在关着（地图的花钱开关没开），先手写地址" } }) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    act(() => inputs(r, "bf-title-0")[0].props.onFocus());
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("青川"));
    await act(async () => { await new Promise((x) => setTimeout(x, 450)); });
    await flush();
    await act(async () => { inputs(r, "bf-title-0")[0].props.onBlur(); await new Promise((x) => setTimeout(x, 300)); });
    expect(texts(r)).toContain("地点搜索现在关着（地图的花钱开关没开），先手写地址");
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("青川"));
    expect(texts(r)).not.toContain("地点搜索现在关着");
    act(() => r.unmount());
  });
});

describe("返工:编辑态离开纪念盒的每条路都拦", () => {
  beforeEach(() => { fetchMock.mockReset(); mockNav.dispatch.mockReset(); mockRouter.back.mockReset(); });
  async function openWithUnfinished() {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: "13" };
    route("", [plan({})], (u, init) => (init?.method === "PATCH" ? resp(200, plan({ stops: [stop({}), stop({ n: 2, stop_id: 99, kind: "walk" })] })) : undefined));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("青川"));
    return r;
  }
  const settle = async () => { await act(async () => { await new Promise((x) => setTimeout(x, 250)); }); await flush(); };

  it("编辑态空格淡字:补的空站显示提示,已有值的站不显示;敲字让开,清空再回来", async () => {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    const { HINT } = require("./BackfillParts");
    mockParams = { id: "13" };
    route("", [plan({})], () => undefined);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    const count = (t: string) => r.root.findAllByType(Text).filter((x) => [x.props.children].flat(3).join("") === t).length;
    expect(count(HINT.place)).toBe(1);                     // 只有补的空站有,已有地名的第 1 站没有
    expect(texts(r)).toContain(HINT.time);
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("目"));
    expect(count(HINT.place)).toBe(0);
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText(""));
    expect(count(HINT.place)).toBe(1);                     // 清空=提示回来
    act(() => r.unmount());
  });

  it("左上返回键:有没填完的补站=不走,那一行写「还缺类型」,草稿在;填完了才走", async () => {
    const r = await openWithUnfinished();
    const back = () => byLabel(r, "返回")[0].props.onPress();
    await act(async () => { const j = back(); await new Promise((x) => setTimeout(x, 250)); await j; });
    await flush();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(texts(r)).toContain("还缺类型");
    expect(inputs(r, "bf-title-1")[0].props.value).toBe("青川");
    await chooseKind(r, "walk");
    await flush();
    await act(async () => { const j = back(); await new Promise((x) => setTimeout(x, 250)); await j; });
    await settle();
    expect(mockNav.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
    act(() => r.unmount());
  });

  it("iOS 右滑返回 / 别处导航(beforeRemove):编辑态一律先拦;没填完=不放行,填完了=原样放行那一个动作", async () => {
    const r = await openWithUnfinished();
    expect(mockPrevent.on).toBe(true);
    const action = { type: "POP" };
    await act(async () => { mockPrevent.cb!({ data: { action } }); });
    await settle();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    expect(texts(r)).toContain("还缺类型");
    expect(inputs(r, "bf-title-1")[0].props.value).toBe("青川");
    await chooseKind(r, "walk");
    await flush();
    await act(async () => { mockPrevent.cb!({ data: { action } }); });
    await settle();
    expect(mockNav.dispatch).toHaveBeenCalledWith(action);
    expect(mockPrevent.on).toBe(false);
    act(() => r.unmount());
  });

  it("底部导航切走:同一道问,没填完不跳", async () => {
    const r = await openWithUnfinished();
    mockRouter.replace.mockReset();
    await act(async () => { const j = byLabel(r, "Home")[0].props.onPress(); await new Promise((x) => setTimeout(x, 250)); await j; });
    await flush();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(texts(r)).toContain("还缺类型");
    act(() => r.unmount());
  });
});

// ── 最终轮:编辑态「草稿 ↔ 引擎」同步换成每字段 {draft, base, 在途};请求一律有期限 ─────────────────────
const hang = (init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));

describe("字段同步 reducer(fieldStep)", () => {
  it("同字段在途时继续输入:回执不冲掉新草稿,且该再发一次", () => {
    let f = fieldInit("First Rain");
    f = fieldStep(f, { t: "edit", v: "A" });
    f = fieldStep(f, { t: "send" });
    f = fieldStep(f, { t: "edit", v: "B" });
    expect(fieldShouldSend(f)).toBe(false); // 在途不另发
    f = fieldStep(f, { t: "ack", v: "A" });
    expect([f.draft, f.base, fieldShouldSend(f)]).toEqual(["B", "A", true]);
    f = fieldStep(fieldStep(f, { t: "send" }), { t: "ack", v: "B" });
    expect([f.draft, f.base, fieldShouldSend(f)]).toEqual(["B", "B", false]);
  });
  it("改回原值:和最新 base 比,不和旧值比(cream→sky→cream 最后是 cream)", () => {
    let f = fieldInit("cream");
    f = fieldStep(fieldStep(f, { t: "edit", v: "sky" }), { t: "send" });
    f = fieldStep(f, { t: "edit", v: "cream" });
    f = fieldStep(f, { t: "ack", v: "sky" });
    expect([f.draft, f.base, fieldShouldSend(f)]).toEqual(["cream", "sky", true]);
  });
  it("首笔被拒:草稿留着、不在途、可再发;下一笔成功后干净", () => {
    let f = fieldInit("");
    f = fieldStep(fieldStep(f, { t: "edit", v: "风很大" }), { t: "send" });
    f = fieldStep(f, { t: "fail" });
    expect([f.draft, f.failed, f.inflight, fieldShouldSend(f)]).toEqual(["风很大", true, false, true]);
    f = fieldStep(fieldStep(f, { t: "send" }), { t: "ack", v: "风很大" });
    expect([f.failed, fieldShouldSend(f)]).toEqual([false, false]);
  });
  it("引擎那份别处变了:没动过的草稿跟着走,动过的不动", () => {
    expect(fieldStep(fieldInit("a"), { t: "server", v: "b" }).draft).toBe("b");
    expect(fieldStep(fieldStep(fieldInit("a"), { t: "edit", v: "x" }), { t: "server", v: "b" }).draft).toBe("x");
  });
});

describe("请求期限(B)", () => {
  const saved = { ...TIMEOUTS };
  afterEach(() => Object.assign(TIMEOUTS, saved));
  it("写/搜索不回应=到点给明确的错,不挂着", async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => hang(init));
    Object.assign(TIMEOUTS, { write: 40, search: 30 });
    await expect(ephemeraApi.herEdit(13, [{ op: "set_line", stop_id: 11, her_line: "x" }])).rejects.toMatchObject({ code: "timeout", message: TIMEOUT_WRITE_TEXT });
    await expect(ephemeraApi.placeSearch("青川")).rejects.toMatchObject({ code: "timeout", message: TIMEOUT_READ_TEXT });
  });
  it("底层不理会 abort、到点后才成功:照样到点给错,迟到的结果被丢弃(review)", async () => {
    fetchMock.mockReset();
    let lateJson = 0;
    // 不监听 abort;80ms 后才「成功」,且读响应体时计数——迟到结果不该被任何人用到
    fetchMock.mockImplementation(() => new Promise((res) => setTimeout(() => res({
      ok: true, status: 200, json: async () => { lateJson += 1; return { id: 13, stops: [] }; },
    } as unknown as Response), 80)));
    Object.assign(TIMEOUTS, { write: 30 });
    const t0 = Date.now();
    await expect(ephemeraApi.herEdit(13, [{ op: "set_line", stop_id: 11, her_line: "x" }])).rejects.toMatchObject({ code: "timeout", message: TIMEOUT_WRITE_TEXT });
    expect(Date.now() - t0).toBeLessThan(75);          // 到期限就给错,不等那份迟到的
    await new Promise((x) => setTimeout(x, 120));       // 迟到的那份回来了也没有地方接
    expect(lateJson).toBe(0);
  });
  it("读响应体挂住:到点照样给错", async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response));
    Object.assign(TIMEOUTS, { read: 30 });
    await expect(ephemeraApi.plan(13)).rejects.toMatchObject({ code: "timeout", message: TIMEOUT_READ_TEXT });
  });
});

describe("最终轮:纪念盒编辑态", () => {
  beforeEach(() => { fetchMock.mockReset(); mockNav.dispatch.mockReset(); mockRouter.back.mockReset(); });
  const saved = { ...TIMEOUTS };
  afterEach(() => Object.assign(TIMEOUTS, saved));
  async function openEdit(p: Plan, onPatch: (b: { ops: Array<Record<string, unknown>> }, init?: RequestInit) => Response | Promise<Response>, extra?: (u: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
    const { EphemeraBoxScreen } = require("./BoxScreen");
    mockParams = { id: String(p.id) };
    route("", [p], (u, init) => (init?.method === "PATCH" ? onPatch(JSON.parse(String(init.body)), init) : extra?.(u, init)));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBoxScreen />); });
    await flush();
    await act(async () => { await byId(r, "box-pen")[0].props.onPress(); });
    return r;
  }
  const wait = async (ms = 250) => { await act(async () => { await new Promise((x) => setTimeout(x, ms)); }); await flush(); };
  const leaveBack = async (r: TestRenderer.ReactTestRenderer) => { await act(async () => { const j = byLabel(r, "返回")[0].props.onPress(); await new Promise((x) => setTimeout(x, 250)); await j; }); await flush(); };

  it("①同字段在途:名字 A 在途时又输入 B,A 的回执不冲掉 B,并补发 B;颜色 cream→sky→cream 最后停在 cream", async () => {
    const a = deferred<Response>(), c = deferred<Response>();
    const bodies: Array<Record<string, unknown>> = [];
    const r = await openEdit(plan({}), (b) => {
      bodies.push(b.ops[0]);
      if (b.ops[0].title_en === "A") return a.p;
      if (b.ops[0].color === "sky") return c.p;
      if (b.ops[0].title_en) return resp(200, plan({ title_en: String(b.ops[0].title_en) }));
      return resp(200, plan({ title_en: "B", color: String(b.ops[0].color) }));
    });
    const name = () => inputs(r, "bf-name")[0];
    act(() => name().props.onChangeText("A"));
    await act(async () => { name().props.onBlur(); });
    act(() => name().props.onChangeText("B"));
    await act(async () => { name().props.onBlur(); });
    await flush();
    expect(bodies).toEqual([{ op: "set_plan", title_en: "A" }]);
    await act(async () => { a.resolve(resp(200, plan({ title_en: "A" }))); });
    await wait(100);
    expect(name().props.value).toBe("B");
    expect(bodies[1]).toEqual({ op: "set_plan", title_en: "B" });
    await act(async () => { byLabel(r, "sky")[0].props.onPress(); });
    await wait(50);
    await act(async () => { byLabel(r, "cream")[0].props.onPress(); });
    await act(async () => { c.resolve(resp(200, plan({ title_en: "B", color: "sky" }))); });
    await wait(150);
    expect(bodies.slice(2)).toEqual([{ op: "set_plan", color: "sky" }, { op: "set_plan", color: "cream" }]);
    expect(byLabel(r, "cream")[0].props.accessibilityState.selected).toBe(true);
    act(() => r.unmount());
  });

  it("②补站在途期间改了类型和坐标:站建好后补交;补交失败=草稿和原话留着、所有离开都不放行,点那一行重试成功才放行", async () => {
    const add = deferred<Response>();
    const ops: Array<Record<string, unknown>> = [];
    let failing = true;
    const base = (o: Partial<Stop>) => plan({ stops: [stop({}), stop({ n: 2, stop_id: 99, kind: "walk", place: { title: "青川", address: null, lat: null, lng: null, how_to_get: null, walk_path: null, leg: null }, ...o })] });
    const r = await openEdit(plan({}), (b) => {
      ops.push(...b.ops);
      if (b.ops[0].op === "add_stop") return add.p;
      if (failing) return resp(500, { detail: "引擎忙" });
      return resp(200, base({ kind: "cafe", place: { title: "青川", address: "青川区", lat: 35.6, lng: 139.6, how_to_get: null, walk_path: null, leg: null } }));
    }, (u) => (u.includes("place_search") ? resp(200, { items: [{ title: "青川", address: "青川区", lat: 35.6, lng: 139.6 }] }) : undefined));
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("青川"));
    await chooseKind(r, "walk");
    // 在途:改类型、搜地名选一个带坐标的
    await chooseKind(r, "cafe");
    act(() => inputs(r, "bf-title-1")[0].props.onFocus());
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("青川"));
    await wait(450);
    await act(async () => { byLabel(r, "青川")[0].props.onPress(); });
    await act(async () => { add.resolve(resp(200, base({}))); });
    await wait(200);
    const sent = ops.slice(1);
    expect(sent).toEqual(expect.arrayContaining([
      { op: "update_stop", stop_id: 99, title: "青川", address: "青川区", lat: 35.6, lng: 139.6 },
      { op: "update_stop", stop_id: 99, kind: "cafe", subtype: null }, // 换大类=细类一起换(没选细类=清掉)
    ]));
    expect(texts(r)).toContain("没改成 · 引擎忙");
    await leaveBack(r);
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    await act(async () => { mockPrevent.cb!({ data: { action: { type: "POP" } } }); });
    await wait();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    failing = false;
    await act(async () => { byId(r, "row-err-s99")[0].props.onPress(); });
    await wait(200);
    expect(texts(r)).not.toContain("引擎忙");
    await leaveBack(r);
    expect(mockNav.dispatch).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("③悬挂请求:到点给明确的错挂在那一行,队列接着走,离开不卡死", async () => {
    Object.assign(TIMEOUTS, { write: 60 });
    const two = [stop({}), stop({ n: 2, stop_id: 12 })];
    const bodies: Array<Record<string, unknown>> = [];
    const r = await openEdit(plan({ stops: two }), (b, init) => {
      bodies.push(b.ops[0]);
      if (b.ops[0].stop_id === 11) return hang(init);
      return resp(200, plan({ stops: [stop({}), stop({ n: 2, stop_id: 12, her_line: "二" })] }));
    });
    const line = (id: number) => inputs(r, `edit-line-${id}`)[0];
    for (const [id, v] of [[11, "一"], [12, "二"]] as const) {
      act(() => line(id).props.onFocus());
      act(() => line(id).props.onChangeText(v));
      await act(async () => { line(id).props.onBlur(); });
    }
    await wait(300);
    expect(bodies.map((b) => b.stop_id)).toEqual([11, 12]);
    expect(texts(r)).toContain(`没改成 · ${TIMEOUT_WRITE_TEXT}`);
    await leaveBack(r); // 卡住的那一句没存上:有期限地问完,停在原地
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("没存上的改动:返回键不放行,原话在那一行,草稿在", async () => {
    const r = await openEdit(plan({ stops: [stop({}), stop({ n: 2, stop_id: 12 })] }), () => resp(400, { detail: { code: "long", text: "那一句话最多 120 个字" } }));
    const line = () => inputs(r, "edit-line-12")[0];
    act(() => line().props.onFocus());
    act(() => line().props.onChangeText("风很大"));
    await act(async () => { line().props.onBlur(); });
    await flush();
    await leaveBack(r);
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    expect(texts(r)).toContain("没改成 · 那一句话最多 120 个字");
    expect(texts(r)).toContain("风很大");
    act(() => r.unmount());
  });

  it("没传上的照片:右滑返回(beforeRemove)不放行,原话在那一行", async () => {
    let n = 0;
    const r = await openEdit(plan({}), () => resp(200, plan({ stops: [stop({}), stop({ n: 2, stop_id: 99, kind: "walk" })] })),
      (u) => (u.endsWith("/her/photo") ? (n++, resp(500, { detail: "磁盘满了" })) : undefined));
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    await act(async () => { byLabel(r, "第 2 站的卡套")[0].props.onPress(); });
    await act(async () => { await r.root.findByType(PhotoFlow).props.onDone({ uri: "file:///p.jpg", mimeType: "image/jpeg", fileName: "p.jpg" }, "", "cid-1"); });
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("青川"));
    await chooseKind(r, "walk");
    await wait(100);
    expect(n).toBe(1);
    await act(async () => { mockPrevent.cb!({ data: { action: { type: "POP" } } }); });
    await wait();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    expect(texts(r)).toContain("没收好 · 磁盘满了 · 点卡套再试一次");
    act(() => r.unmount());
  });

  it("E 放行只走一次:等待期间连着触发两次离开,被拦的动作只 dispatch 一次", async () => {
    const r = await openEdit(plan({}), () => resp(200, plan({})));
    const action = { type: "POP" };
    await act(async () => { mockPrevent.cb!({ data: { action } }); mockPrevent.cb!({ data: { action } }); await byLabel(r, "返回")[0].props.onPress(); });
    await wait(300);
    expect(mockNav.dispatch).toHaveBeenCalledTimes(1);
    expect(mockNav.dispatch).toHaveBeenCalledWith(action);
    act(() => r.unmount());
  });
});

describe("最终轮:搜索报错按行各自存(D)", () => {
  beforeEach(() => fetchMock.mockReset());
  it("第 1 行搜不了的原话,第 2 行搜成了也不抹掉;只有在第 1 行再输入才清", async () => {
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    route("", [], (u) => (!u.includes("place_search") ? undefined
      : u.includes(encodeURIComponent("青川")) ? resp(503, { detail: { code: "gate_off", text: "地点搜索现在关着" } })
      : resp(200, { items: [{ title: "Hilltop Sky", address: "桥东区", lat: 35.6, lng: 139.7 }] })));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    act(() => inputs(r, "bf-title-0")[0].props.onFocus());
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("青川"));
    await act(async () => { await new Promise((x) => setTimeout(x, 450)); });
    await act(async () => { inputs(r, "bf-title-0")[0].props.onBlur(); await new Promise((x) => setTimeout(x, 300)); });
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    act(() => inputs(r, "bf-title-1")[0].props.onFocus());
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("Hilltop"));
    await act(async () => { await new Promise((x) => setTimeout(x, 450)); });
    expect(texts(r)).toContain("地点搜索现在关着");
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("目"));
    expect(texts(r)).not.toContain("地点搜索现在关着");
    act(() => r.unmount());
  });
});

describe("确认审 N1:封火漆成功、照片还在上传时她离开了这页", () => {
  beforeEach(() => { fetchMock.mockReset(); mockRouter.back.mockReset(); mockRouter.replace.mockReset(); });
  it("不导航(不把她现在的页面退掉)、不 setState、不再开始下一张;已发出的那张在后台传完", async () => {
    // 直接记组件的 setState 调用(不靠 console.error):包一层 React.useState,卸载后还有没有人调 setter
    const React = require("react");
    const realUseState = React.useState;
    let afterUnmount = false, lateSets = 0;
    const spy = jest.spyOn(React, "useState").mockImplementation((init: unknown) => {
      const [v, set] = realUseState(init);
      return [v, (x: unknown) => { if (afterUnmount) lateSets++; set(x); }];
    });
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    let releaseFirst!: (r: Response) => void;
    const photoCalls: string[] = [];
    route("", [], (u) => {
      if (u.endsWith("/backfill")) return resp(200, plan({ id: 21, stops: [stop({ stop_id: 77 }), stop({ n: 2, stop_id: 78 })] }));
      if (u.endsWith("/her/photo")) { photoCalls.push(u); return new Promise<Response>((res) => { releaseFirst = res; }) as never; }
      return undefined;
    });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    act(() => inputs(r, "bf-title-0")[0].props.onChangeText("转角咖啡"));
    await act(async () => { byLabel(r, "加一站")[0].props.onPress(); });
    act(() => inputs(r, "bf-title-1")[0].props.onChangeText("青川"));
    for (const n of [1, 2]) {
      await act(async () => { byLabel(r, `第 ${n} 站的卡套`)[0].props.onPress(); });
      await act(async () => { await r.root.findByType(PhotoFlow).props.onDone({ uri: `file:///p${n}.jpg`, mimeType: "image/jpeg", fileName: `p${n}.jpg` }, "", `cid-${n}`, () => {}); });
    }
    let sealing!: Promise<void>;
    await act(async () => { sealing = byId(r, "bf-seal")[0].props.onPress(); await new Promise((x) => setTimeout(x, 30)); });
    expect(photoCalls).toHaveLength(1);              // 第 1 张在传
    act(() => r.unmount());                          // 她离开了
    afterUnmount = true;
    await act(async () => { releaseFirst(resp(200, { id: 1, stop_id: 77, caption: null, created_at: 1 })); await sealing; });
    expect(photoCalls).toHaveLength(1);              // 没再开始第 2 张
    expect(mockRouter.back).not.toHaveBeenCalled();  // 没把她现在的页面退掉
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(lateSets).toBe(0);                        // 离页后没有任何 setState
    spy.mockRestore();
  });
});
