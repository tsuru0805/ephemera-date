/// <reference types="jest" />
// Backfill draft photos across a reload: bytes in IndexedDB (key = clientId), object URLs rebuilt on restore;
// without the bytes the stop's photo is dropped and its row says so — never a dead address shown as a photo.
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


import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { Text } from "react-native";
import { BACKFILL_DRAFT_KEY, PHOTO_LOST_TEXT, restoreDraftPhotos, newDraft, blankStop, type Draft } from "./backfill";
import { EphemeraError, ephemeraApi, PHOTO_GONE_TEXT } from "../../lib/ephemeraApi";

const blob = (s = "x") => new Blob([s], { type: "image/jpeg" });
const ph = (cid: string, uri = `blob:dead-${cid}`) => ({ uri, mimeType: "image/jpeg", fileName: `${cid}.jpg`, caption: "", clientId: cid });
function draftWith(): Draft {
  const d = newDraft();
  return { ...d, md: "0503", name: "First Rain", stops: [{ ...blankStop(), key: "a", title: "西川", time: "1700", photo: ph("pa") }, { ...blankStop(), key: "b", title: "南川", time: "1800", photo: ph("pb") }],
    dayPhotos: [ph("d1"), ph("d2")] };
}
const texts = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(Text).map((t) => [t.props.children].flat(3).filter((x) => typeof x === "string").join("")).join("|");
async function flush() { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); }

describe("restoreDraftPhotos", () => {
  it("bytes found → a new address; not found but uploaded → kept without an address; not found, not uploaded → dropped and named", async () => {
    const store: Record<string, Blob> = { pa: blob(), d1: blob() };
    let n = 0;
    const r = await restoreDraftPhotos({ draft: draftWith(), up: ["day:d2"] }, async (cid) => store[cid] ?? null, () => `blob:new-${++n}`);
    expect(r.draft.stops[0].photo?.uri).toBe("blob:new-1");
    expect(r.draft.stops[1].photo).toBeNull();
    expect(r.lost).toEqual(["b"]);
    expect(r.draft.dayPhotos?.map((x) => [x.clientId, x.uri])).toEqual([["d1", "blob:new-2"], ["d2", ""]]);
    expect(r.dayLost).toBe(false);
  });
  it("a failing store counts as no bytes", async () => {
    const r = await restoreDraftPhotos({ draft: draftWith(), up: [] }, async () => { throw new Error("blocked"); }, () => "x");
    expect(r.lost).toEqual(["a", "b"]);
    expect(r.dayLost).toBe(true);
    expect(r.draft.dayPhotos).toEqual([]);
  });
});

describe("backfill page after a reload without the bytes", () => {
  it("the stop's photo is gone and its row says 「刷新后照片要重新选」; the day photos say it once; nothing English", async () => {
    const AS = require("@react-native-async-storage/async-storage");
    await AS.setItem(BACKFILL_DRAFT_KEY, JSON.stringify({ v: 1, draft: draftWith(), clientId: "bf-1", at: 1 }));
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ plans: [] }) }));
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    expect(r.root.findAll((x: ReactTestInstance) => x.props.testID === "row-err-0" && typeof x.type !== "string").length).toBeGreaterThan(0);
    expect(texts(r)).toContain(PHOTO_LOST_TEXT);
    expect(r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-day-lost" && typeof x.type !== "string").length).toBeGreaterThan(0);
    expect(r.root.findAll((x: ReactTestInstance) => x.props.testID === "bf-day-0").length).toBe(0);    // no dead photo shown
    expect(texts(r)).not.toMatch(/Failed to fetch|TypeError/);
    act(() => r.unmount());
  });
  it("an uploaded photo whose bytes are gone: opening it says so, not 「正在取照片」 forever", async () => {
    const AS = require("@react-native-async-storage/async-storage");
    const d = draftWith();
    await AS.setItem(BACKFILL_DRAFT_KEY, JSON.stringify({ v: 1, draft: { ...d, dayPhotos: [] }, clientId: "bf-3", at: 1, up: ["a"], ever: ["a"], box: { id: 9, sid: { a: 1, b: 2 } } }));
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ plans: [] }) }));
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    const sleeve = r.root.findAll((x: ReactTestInstance) => x.props.accessibilityLabel === "第 1 站的卡套" && typeof x.props.onPress === "function")[0];
    await act(async () => { sleeve.props.onPress(); });
    await flush();
    expect(texts(r)).toContain(`已放的照片没取到 · ${PHOTO_LOST_TEXT}`);
    expect(texts(r)).not.toContain("正在取照片");
    act(() => r.unmount());
  });
  it("a draft that ends up empty also drops the stored photo bytes (no orphans)", async () => {
    const AS = require("@react-native-async-storage/async-storage");
    const store = require("../../lib/draftPhotos");
    const clear = jest.spyOn(store, "clearDraftPhotos");
    await AS.setItem(BACKFILL_DRAFT_KEY, JSON.stringify({ v: 1, draft: { ...newDraft(), dayPhotos: [ph("only")] }, clientId: "bf-2", at: 1 }));
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ plans: [] }) }));
    const { EphemeraBackfillScreen } = require("./BackfillScreen");
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraBackfillScreen />); });
    await flush();
    await act(async () => { await new Promise((x) => setTimeout(x, 500)); });   // saved 400 ms after the last change
    expect(clear).toHaveBeenCalled();
    expect(await AS.getItem(BACKFILL_DRAFT_KEY)).toBeNull();
    clear.mockRestore();
    act(() => r.unmount());
  });
  it("an upload of a dead address says so in Chinese, not the browser's words", async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => { throw new TypeError("Failed to fetch"); });
    const e = await ephemeraApi.uploadPhoto(1, 2, { uri: "blob:http://x/dead", mimeType: "image/jpeg" }, "", "c").catch((x) => x);
    expect(e).toBeInstanceOf(EphemeraError);
    expect(e.message).toBe(PHOTO_GONE_TEXT);
  });
  it("a read the browser cannot make reads as a Chinese line", async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => { throw new TypeError("Failed to fetch"); });
    const e = await ephemeraApi.plans().catch((x) => x);
    expect(e.message).toBe("连不上后台，点一下再试");
  });
});
