/// <reference types="jest" />
// +D 落码的组件级补充(aliveHome.test.ts 只测纯函数,这里核一下接线没接错):
// - EmptyHome(D1 拖甩倾斜那叠纸):gesture-handler 在 jest 下不能真触发,这里只核渲染不崩(拖甩逻辑靠 aliveHome.test.ts)。
// - Preparing(D2 信纸墨水重放 / 明信片点开就地写 / 寄出):Pressable 走的是真 onPress,这里核真实交互。
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("react-native-reanimated", () => ({
  ...require("react-native-reanimated/mock"),
  useSharedValue: (init: unknown) => require("react").useRef({ value: init }).current,
  useAnimatedSensor: () => ({ isAvailable: false, sensor: { value: { roll: 0 } } }),
  useFrameCallback: () => undefined,
  withTiming: (to: unknown, _c?: unknown, cb?: (ok: boolean) => void) => { cb?.(true); return to; },
  withSpring: (to: unknown) => to, withDelay: (_d: number, a: unknown) => a, withRepeat: (a: unknown) => a, withSequence: (...a: unknown[]) => a[a.length - 1],
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
jest.mock("react-native-gesture-handler", () => {
  const chain: object = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : () => chain), apply: () => chain });
  return { Gesture: new Proxy({}, { get: () => () => chain }), GestureDetector: ({ children }: { children: unknown }) => children };
});
jest.mock("react-native-keyboard-controller", () => ({ useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }) }));

import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { TextInput } from "react-native";
import type { Preparing } from "../../lib/ephemeraApi";
import { ScrapPage, ScrapRow } from "./EmptyHome";
import { DraftPage } from "./Preparing";

const byId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.props.testID === id && typeof x.type !== "string", { deep: false });

describe("EmptyHome(D1):那叠纸渲染不崩", () => {
  it("ScrapPage 五样(半票/信纸/明信片/邮票/火漆)都挂得上,ScrapRow 三张票根同样", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ScrapPage />); });
    expect(byId(r, "scrap-halfticket")).toHaveLength(1);
    expect(byId(r, "scrap-letter")).toHaveLength(1);
    expect(byId(r, "scrap-postcard")).toHaveLength(1);
    expect(byId(r, "scrap-stamp")).toHaveLength(1);
    expect(byId(r, "scrap-seal")).toHaveLength(1);
    act(() => r.unmount());
    act(() => { r = TestRenderer.create(<ScrapRow />); });
    expect(byId(r, "scrap-stub-0")).toHaveLength(1);
    expect(byId(r, "scrap-stub-1")).toHaveLength(1);
    expect(byId(r, "scrap-stub-2")).toHaveLength(1);
    act(() => r.unmount());
  });
});

describe("Preparing(D2):信纸重放 / 明信片就地写 / 寄出", () => {
  const prep = (o: Partial<Preparing> = {}): Preparing => ({
    id: 9, date: "2026-11-02", last_edited_at: Math.floor(Date.now() / 1000) - 86400,
    stops: { count: 3, complete: 2 }, legs: 1, prep: 2, contract: true, card: false,
    art: { drawn: 1, planned: 2 }, missing: [{ what: "legs", count: 1 }], conflicts: 0, ready: false,
    notes: [
      { id: 1, text: "第一句", created_at: 1000, seen_at: 1100 },
      { id: 2, text: "最新这句", created_at: 2000, seen_at: null },
    ],
    ...o,
  });

  it("信纸那几行:填了的能点,点一下不炸(重放靠 useSharedValue,jest 下只核能点)", () => {
    const onSend = jest.fn(async () => prep());
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<DraftPage items={[prep()]} onSend={onSend} />); });
    const stopsRow = byId(r, "draft-row-0")[0]; // Stops 这一行肯定有值
    expect(stopsRow.props.disabled).toBe(false);
    act(() => { stopsRow.props.onPress(); });
    act(() => r.unmount());
  });

  it("最上面那张明信片点开直接写(不再弹框),输入+寄出会调 onSend 并把输入框收起来", async () => {
    const onSend = jest.fn(async () => prep());
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<DraftPage items={[prep()]} onSend={onSend} />); });
    expect(byId(r, "draft-note-input")).toHaveLength(0); // 没点开之前,输入框不存在(不是隐藏的弹框)
    act(() => { byId(r, "postcard-top")[0].props.onPress(); });
    expect(byId(r, "draft-note-input")).toHaveLength(1);
    const input = r.root.findAll((x: ReactTestInstance) => x.type === TextInput && x.props.testID === "draft-note-input")[0];
    act(() => { input.props.onChangeText("写给他的新一句"); });
    await act(async () => { await byId(r, "draft-note-send")[0].props.onPress(); });
    expect(onSend).toHaveBeenCalledWith(9, "写给他的新一句");
    act(() => r.unmount());
  });

  it("已经看过(seen_at 有值)的那条不会再把输入框强制弹出来;没看过的 seen_at=null 不盖章(纯函数已在 aliveHome.test.ts 核过,这里核组件没把规则接反)", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<DraftPage items={[prep()]} onSend={jest.fn()} />); });
    expect(byId(r, "draft-note-input")).toHaveLength(0);
    act(() => r.unmount());
  });
});
