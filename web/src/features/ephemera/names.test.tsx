/// <reference types="jest" />
// English lines of the papers use the English forms of address (her_en / him_en, default Her / Him); Chinese lines
// keep the Chinese ones (her / him).
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



import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import { __setSession, mergeConfig } from "../../runtime/session";
import { ClosedEnvelope } from "./SealScreen";
import type { Plan } from "../../lib/ephemeraApi";

const plan = { id: 3, paper_no: "0003", title_en: "Quiet\nEvening", title_zh: "", date: "2026-05-03", color: "rose", status: "sent", stops: [], prep: [],
  contract: null, card: null, quote: null, sent_at: 1, closed_at: null, cancelled_at: null } as unknown as Plan;
const texts = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(Text).map((t) => [t.props.children].flat(3).filter((x) => typeof x === "string").join("")).join("|");

describe("the envelope", () => {
  it("FROM : spaced English name, TO : English name (configured)", () => {
    __setSession({ config: mergeConfig({ her: "小满", him: "阿远", her_en: "Lin", him_en: "Ari" }) });
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ClosedEnvelope plan={plan} />); });
    const t = texts(r);
    expect(t).toContain("A · R · I");
    expect(t).toContain("|Lin|TO : |");   // the outer Text holds the name, the inner one "TO : "
    expect(t).not.toContain("小满");
    act(() => r.unmount());
  });
  it("defaults: H · I · M and TO : Her", () => {
    __setSession({ config: mergeConfig({ her: "小满", him: "阿远" }) });
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ClosedEnvelope plan={plan} />); });
    expect(texts(r)).toContain("H · I · M");
    expect(texts(r)).toContain("|Her|TO : |");
    act(() => r.unmount());
  });
});
