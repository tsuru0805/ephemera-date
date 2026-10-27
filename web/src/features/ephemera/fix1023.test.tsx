/// <reference types="jest" />
// 六条里的四条:补记的约会没有路程 → 不显示「走了多少公里」;晚餐按时间显示午餐/晚餐(分界 16:30);
// 放过照片的站再点进来显示那张(可改小字 / 换一张);一站多张旧数据以最新那张为准。
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
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
jest.mock("../../fonts", () => ({ F: new Proxy({}, { get: (_t, k) => String(k) }), usePosterFonts: () => ({ ready: true, error: null }) }));
jest.mock("../../lib/storage", () => ({ storage: { getBase: async () => "http://gw.test", getToken: async () => "tok" } }));

import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { TextInput } from "react-native";
import type { HerPhoto, MapData, Stop } from "../../lib/ephemeraApi";
import { latestPhoto } from "./BoxScreen";
import { walkKmText } from "./format";
import { draftHasContent, newDraft, parseSavedBackfill } from "./backfill";
import { __resetKindsForTests, KINDS_FALLBACK, kindLine, kindLineNarrow, kindNames, kindZhLine, minutesOf, parseKinds } from "./kinds";
import { PhotoFlow, sleeveLayout } from "./PhotoFlow";
import { containerPadBottom, residualPad } from "../../components/SafeKeyboardAwareScrollView";
import { SKINS } from "./theme";

const map = (walk_m: number): MapData => ({ W: 1, H: 1, attribution: "", layers: { major: [], minor: [], tiny: [], motor: [], rail: [], river: [], water: [], park: [] },
  stops: [], legs: [], walk_paths: [], stats: { walk_m, transit_legs: 0 } });

describe("走了多少公里:没有路就不显示那一格", () => {
  it("地图空 / 0 米 / 不到 0.1 km → null;有路照常一位小数", () => {
    expect(walkKmText({ empty: true, attribution: "" })).toBeNull();
    expect(walkKmText(map(0))).toBeNull();
    expect(walkKmText(map(40))).toBeNull();
    expect(walkKmText(map(1234))).toBe("1.2");
  });
});

describe("晚餐按时间显示午餐/晚餐(分界 16:30)", () => {
  beforeEach(() => __resetKindsForTests());
  it("16:30 前=午餐 LUNCH;16:30 及以后、没填时间=晚餐 DINNER;草稿四位数字同样认", () => {
    expect(kindNames("dinner", "12:00")).toEqual({ zh: "午餐", en: "LUNCH" });
    expect(kindNames("dinner", "16:29")).toEqual({ zh: "午餐", en: "LUNCH" });
    expect(kindNames("dinner", "1600")).toEqual({ zh: "午餐", en: "LUNCH" });
    expect(kindNames("dinner", "16:30")).toEqual({ zh: "晚餐", en: "DINNER" });
    expect(kindNames("dinner", "19:00")).toEqual({ zh: "晚餐", en: "DINNER" });
    expect(kindNames("dinner", null)).toEqual({ zh: "晚餐", en: "DINNER" });
    expect(kindNames("dinner", "")).toEqual({ zh: "晚餐", en: "DINNER" });
    expect(kindNames("dinner", "25:00")).toEqual({ zh: "晚餐", en: "DINNER" });
  });
  it("别的类不受影响;各显示口都按时间", () => {
    expect(kindNames("cafe", "10:00")).toEqual({ zh: "咖啡", en: "CAFÉ" });
    expect(kindLine({ kind: "dinner", subtype: "拉面", time: "12:30" })).toBe("LUNCH · 拉面");
    expect(kindLine({ kind: "dinner", subtype: null, time: "18:00" })).toBe("DINNER");
    expect(kindLineNarrow({ kind: "dinner", subtype: "寿司", time: "13:00" })).toBe("LUNCH\n寿司");
    expect(kindZhLine("dinner", "铁板烧", "16:00")).toBe("午餐 · 铁板烧");
    expect(kindZhLine("dinner", null, "17:00")).toBe("晚餐");
  });
  it("选类别的列表里这一类叫「午餐 / 晚餐」;端点的 by_time 形状不对=整份当没拿到", () => {
    expect(KINDS_FALLBACK.kinds.find((k) => k.kind === "dinner")!.zh).toBe("午餐 / 晚餐");
    expect(parseKinds(KINDS_FALLBACK)).toEqual(KINDS_FALLBACK);
    const bad = { ...KINDS_FALLBACK, kinds: KINDS_FALLBACK.kinds.map((k) => (k.kind === "dinner" ? { ...k, by_time: { before: "x" } } : k)) };
    expect(parseKinds(bad)).toBeNull();
    expect(minutesOf("09:05")).toBe(545);
    expect(minutesOf("abc")).toBeNull();
  });
});

describe("一站多张以最新为准", () => {
  it("按 created_at,再按 id", () => {
    const ph = (id: number, stop_id: number, created_at: number): HerPhoto => ({ id, stop_id, caption: null, created_at });
    expect(latestPhoto([ph(1, 5, 10), ph(2, 5, 20), ph(3, 6, 30)], 5)!.id).toBe(2);
    expect(latestPhoto([ph(1, 5, 10), ph(4, 5, 10)], 5)!.id).toBe(4);
    expect(latestPhoto([ph(1, 5, 10)], 7)).toBeNull();
  });
});

describe("放过照片的站再点进来:显示那张", () => {
  const stop: Stop = { n: 1, stop_id: 11, kind: "walk", time: "13:00", stay_until: null, clue: null, note: null, place: null };
  const byId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.props.testID === id && typeof x.type !== "string", { deep: false });
  async function mount(p: { onCaption?: (c: string) => Promise<void>; onClose?: () => void; onDone?: (...a: unknown[]) => Promise<void> }) {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<PhotoFlow s={stop} i={0} P={SKINS.ivory} skin="ivory" onClose={p.onClose ?? jest.fn()} onSkip={jest.fn()}
        onDone={(p.onDone ?? jest.fn(async () => {})) as never} existing={{ source: { uri: "https://gw.test/p.jpg" }, caption: "第二件半价" }} onCaption={p.onCaption} />);
    });
    return r;
  }
  it("打开就是那张:没有「+」,有「换一张」,小字照填", async () => {
    const r = await mount({});
    expect(byId(r, "photo-pick")).toHaveLength(0);
    expect(byId(r, "photo-swap")).toHaveLength(1);
    expect(r.root.findAllByType(TextInput)[0].props.value).toBe("第二件半价");
    act(() => r.unmount());
  });
  it("小字没改,「收好」=关上;改了=只存小字", async () => {
    const onClose = jest.fn(), onCaption = jest.fn(async () => {});
    const r = await mount({ onClose, onCaption });
    await act(async () => { await byId(r, "photo-done")[0].props.onPress(); });
    expect(onClose).toHaveBeenCalledTimes(1); expect(onCaption).not.toHaveBeenCalled();
    act(() => r.root.findAllByType(TextInput)[0].props.onChangeText("黑框"));
    await act(async () => { await byId(r, "photo-done")[0].props.onPress(); });
    expect(onCaption).toHaveBeenCalledWith("黑框");
    act(() => r.unmount());
  });
  it("「换一张」→ 回到选图那一步", async () => {
    const r = await mount({});
    act(() => byId(r, "photo-swap")[0].props.onPress());
    expect(byId(r, "photo-pick")).toHaveLength(1);
    expect(byId(r, "photo-swap")).toHaveLength(0);
    act(() => r.unmount());
  });
});

describe("放照片:小字在卡套下面(不被高卡套压住)", () => {
  it("小字整行在卡套下沿之下,且不压到「收好」;地方不够卡套往上挪", () => {
    for (const sh of [104, 120, 170, 176, 184]) for (const doneTop of [600, 657, 742]) {
      const { cy, captionTop } = sleeveLayout(sh, doneTop);
      expect(captionTop).toBeGreaterThanOrEqual(cy + sh / 2 + 12);
      expect(captionTop + 36).toBeLessThanOrEqual(doneTop - 8);
      expect(cy).toBeLessThanOrEqual(500);
    }
  });
});

describe("键盘收起后垫子残留兜底", () => {
  it("容器底边距:paddingBottom > paddingVertical > padding", () => {
    expect(containerPadBottom({ paddingBottom: 40, padding: 10 })).toBe(40);
    expect(containerPadBottom([{ padding: 10 }, { paddingVertical: 20 }])).toBe(20);
    expect(containerPadBottom(undefined)).toBe(0);
  });
  it("没有残留(只剩库常驻的 1pt)=0;残留一个键盘高=抵掉;已抵过的量算回去,不来回跳", () => {
    expect(residualPad(901, 900, 0, 0)).toBe(0);
    expect(residualPad(1237, 900, 0, 0)).toBe(336);
    expect(residualPad(901, 900, 0, 336)).toBe(336);   // 抵消后内容高回到 901:仍是 336,稳定
    expect(residualPad(941, 900, 40, 0)).toBe(0);
  });
});

describe("补记草稿的读写形状", () => {
  it("只有默认年份 + 一个空站=没写;读回坏数据=当没有", () => {
    expect(draftHasContent(newDraft())).toBe(false);
    expect(draftHasContent({ ...newDraft(), name: "Golden Hour" })).toBe(true);
    const d = { ...newDraft(), md: "1010" };
    expect(parseSavedBackfill(JSON.stringify({ v: 1, draft: d, clientId: "bf-x", at: 1 }))!.draft.md).toBe("1010");
    expect(parseSavedBackfill("{oops")).toBeNull();
    expect(parseSavedBackfill(JSON.stringify({ v: 2, draft: d, clientId: "bf-x" }))).toBeNull();
    expect(parseSavedBackfill(JSON.stringify({ v: 1, draft: { ...d, stops: [] }, clientId: "bf-x" }))).toBeNull();
    expect(parseSavedBackfill(null)).toBeNull();
  });
});
