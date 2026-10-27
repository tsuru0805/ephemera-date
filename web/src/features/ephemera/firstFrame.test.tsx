/// <reference types="jest" />
// Host run (iPhone) round 2: what a page shows in its first frames, and the pieces that make it right.
// - papers: fill + shadow drawn once in a 2D canvas (same layers as the Skia drop shadows), texture and page light as CSS;
// - a page / a piece is shown only once its canvases have drawn and its first read is back (paintHold);
// - bundled pictures resolve to their address (Skia's own resolver fetched ".../undefined");
// - the next page about the same date starts from the last read (seal → invite was a blank card for seconds);
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
jest.mock("@shopify/react-native-skia/lib/module/web/LoadSkiaWeb", () => ({ LoadSkiaWeb: jest.fn(async () => undefined) }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
jest.mock("../../fonts", () => ({ F: new Proxy({}, { get: (_t, k) => String(k) }), usePosterFonts: () => ({ ready: true, error: null }) }));
jest.mock("../../nav/router", () => {
  const React = require("react");
  return { useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]), useRouter: () => ({}), useLocalSearchParams: () => ({}) };
});
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));

import { act, create } from "react-test-renderer";
import { Text } from "react-native";
import { paperClip, shadowPasses, stageLightCss, bundledUri } from "./components";
import { assetUri } from "../../shims/skia";
import { pieceDrawn } from "./flight";
import { beginFirstLoad, PaintHoldProvider, usePaintHold, usePaintScope, __resetFirstPage } from "../../runtime/paintHold";
import { ephemeraApi, type HerState, type Plan } from "../../lib/ephemeraApi";
import { forgetPlansSeen, usePlan } from "./store";

describe("papers and page light in CSS (same look as the Skia drawing)", () => {
  it("shadow: Skia's drop-shadow layers as canvas passes — last layer first, shadowBlur = 2·sigma, device pixels", () => {
    // Skia folds the paint's filters from the right (MakeCompose(outer, inner)): the last layer is applied first
    expect(shadowPasses([[1, 0, 0.18], [2, 3, 0.2]], "90,60,70", 3)).toEqual([
      { color: "rgba(90,60,70,0.2)", blur: 9, dy: 6 },
      { color: "rgba(90,60,70,0.18)", blur: 0, dy: 3 },
    ]);
    expect(shadowPasses([[12, 14, 0.14]], " 40, 70 ,100", 1)).toEqual([{ color: "rgba(40,70,100,0.14)", blur: 14, dy: 12 }]);
  });
  it("texture clip follows the paper's outline; a plain paper is not clipped", () => {
    expect(paperClip("M0 0 L10 0 L10 10 Z")).toBe("path('M0 0 L10 0 L10 10 Z')");
    expect(paperClip(undefined)).toBeUndefined();
  });
  it("page light: the two radial gradients, top layer first, stops in px of the radius", () => {
    const css = stageLightCss(390, 800, "90,60,70");
    const [edge, lamp] = css.split(/, (?=radial-gradient)/);
    expect(lamp).toBe("radial-gradient(circle 429px at 70.2px 64px, rgba(255,250,240,0.38) 0px, rgba(255,250,240,0) 235.95px)");
    expect(edge).toBe("radial-gradient(circle 640px at 195px 360px, rgba(0,0,0,0) 384px, rgba(90,60,70,0.14) 640px)");
  });
  it("bundled pictures: the address on the web ({uri}); nothing for a number source in the page tests", () => {
    expect(bundledUri({ uri: "/app/assets/paper_tex.jpg", width: 512 })).toBe("/app/assets/paper_tex.jpg");
    expect(bundledUri(12)).toBeNull();
    expect(bundledUri(null)).toBeNull();
  });
});

describe("Skia pictures resolve to an address (no request to .../undefined)", () => {
  it("{uri} → uri, {default} → default, string as is, nothing → null", () => {
    expect(assetUri({ uri: "/app/assets/seal_bow.png", width: 220, height: 223 })).toBe("/app/assets/seal_bow.png");
    expect(assetUri({ default: "/x.png" })).toBe("/x.png");
    expect(assetUri({ default: { uri: "/y.png" } })).toBe("/y.png");
    expect(assetUri("https://e/x.jpg")).toBe("https://e/x.jpg");
    expect(assetUri({})).toBeNull();
    expect(assetUri("")).toBeNull();
    expect(assetUri(undefined)).toBeNull();
  });
});

describe("a page is shown once it is drawn", () => {
  beforeEach(() => { jest.useFakeTimers(); __resetFirstPage(); });
  afterEach(() => { jest.useRealTimers(); });
  const frames = (n = 3) => { for (let k = 0; k < n; k++) act(() => { jest.advanceTimersByTime(20); }); };

  type Out = { shown?: boolean; release?: () => void };
  function Page({ out, page = true }: { out: Out; page?: boolean }) {
    const { scope, shown } = usePaintScope({ enabled: true, page });
    out.shown = shown;
    return <PaintHoldProvider value={scope}><Piece out={out} /></PaintHoldProvider>;
  }
  function Piece({ out }: { out: Out }) { out.release = usePaintHold(); return <Text>paper</Text>; }

  it("waits for every canvas / picture registered in it, then shows (once)", () => {
    const out: Out = {};
    act(() => { create(<Page out={out} />); });
    frames();
    expect(out.shown).toBe(false);                  // the paper has not drawn yet
    act(() => { out.release!(); });
    frames();
    expect(out.shown).toBe(true);
  });
  it("waits for the page's first read too (a page shown before its data is half a page)", () => {
    const out: Out = {};
    const end = beginFirstLoad();
    act(() => { create(<Page out={out} />); });
    act(() => { out.release!(); });
    frames();
    expect(out.shown).toBe(false);
    act(() => { end(); });
    frames();
    expect(out.shown).toBe(true);
  });
  it("a piece does not wait for other pages' reads", () => {
    const out: Out = {};
    const end = beginFirstLoad();
    act(() => { create(<Page out={out} page={false} />); });
    act(() => { out.release!(); });
    frames();
    expect(out.shown).toBe(true);
    end();
  });
  it("never stays hidden: shown after HOLD_MAX_MS whatever is pending", () => {
    const out: Out = {};
    act(() => { create(<Page out={out} />); });
    frames();
    expect(out.shown).toBe(false);
    act(() => { jest.advanceTimersByTime(2600); });
    expect(out.shown).toBe(true);
  });
});

describe("the flight copies a landing piece only once it is drawn", () => {
  const node = (canvases: Array<string | undefined>, imgs: boolean[], held = false) => ({
    querySelector: (sel: string) => (sel === "[data-paint-held]" && held ? {} : null),
    querySelectorAll: (sel: string) => (sel === "canvas" ? canvases.map((p) => ({ dataset: { painted: p } })) : imgs.map((c) => ({ complete: c }))),
  }) as unknown as HTMLElement;
  it("every canvas has a frame, every picture is in, no piece is holding back", () => {
    expect(pieceDrawn(node(["1", "1"], [true]))).toBe(true);
    expect(pieceDrawn(node(["1", undefined], [true]))).toBe(false);
    expect(pieceDrawn(node(["1"], [false]))).toBe(false);
    expect(pieceDrawn(node(["1"], [true], true))).toBe(false);
    expect(pieceDrawn(node([], []))).toBe(true);
  });
});

describe("the next page about the same date starts from the last read", () => {
  afterEach(() => { jest.restoreAllMocks(); forgetPlansSeen(); });
  it("seal → invite: the invite's first render already has the plan (it reads again all the same)", async () => {
    const plan = { id: 7, title_en: "A Walk", stops: [] } as unknown as Plan;
    const her = { marks: {}, now: 1000 } as unknown as HerState;
    const p1 = jest.spyOn(ephemeraApi, "plan").mockResolvedValue(plan);
    jest.spyOn(ephemeraApi, "her").mockResolvedValue(her);
    const seen: Array<Plan | null> = [];
    function Uses() { const { plan: p } = usePlan(7); seen.push(p); return null; }
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<Uses />); });
    expect(seen[0]).toBeNull();                      // first visit: nothing known yet
    expect(seen[seen.length - 1]?.id).toBe(7);
    act(() => { r.unmount(); });
    seen.length = 0;
    await act(async () => { create(<Uses />); });
    expect(seen[0]?.id).toBe(7);                     // the next page: drawn from the start
    expect(p1).toHaveBeenCalledTimes(2);             // and read again
  });
  it("a read that fails forgets that date (no old copy next time)", async () => {
    const plan = { id: 9, stops: [] } as unknown as Plan;
    const pl = jest.spyOn(ephemeraApi, "plan").mockResolvedValue(plan);
    jest.spyOn(ephemeraApi, "her").mockResolvedValue({ marks: {} } as unknown as HerState);
    const seen: Array<Plan | null> = [];
    function Uses() { const { plan: p } = usePlan(9); seen.push(p); return null; }
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<Uses />); });
    act(() => { r.unmount(); });
    pl.mockRejectedValue(new Error("没有这次约会"));
    await act(async () => { r = create(<Uses />); });   // starts from the old copy, the read fails
    act(() => { r.unmount(); });
    seen.length = 0;
    await act(async () => { create(<Uses />); });
    expect(seen[0]).toBeNull();
  });
  it("a new event about the date reads it again at once (no waiting for the 30 s poll)", async () => {
    const { __emitPlanEvent } = require("../../runtime/eventsWatch");
    const pl = jest.spyOn(ephemeraApi, "plan").mockResolvedValue({ id: 11, stops: [] } as unknown as Plan);
    jest.spyOn(ephemeraApi, "her").mockResolvedValue({ marks: {} } as unknown as HerState);
    function Uses() { usePlan(11); return null; }
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<Uses />); });
    expect(pl).toHaveBeenCalledTimes(1);
    await act(async () => { __emitPlanEvent(12); });           // another date: nothing
    expect(pl).toHaveBeenCalledTimes(1);
    await act(async () => { __emitPlanEvent(11); });
    expect(pl).toHaveBeenCalledTimes(2);
    act(() => r.unmount());
  });
  it("sign-out forgets it", async () => {
    jest.spyOn(ephemeraApi, "plan").mockResolvedValue({ id: 8, stops: [] } as unknown as Plan);
    jest.spyOn(ephemeraApi, "her").mockResolvedValue({ marks: {} } as unknown as HerState);
    function Uses() { usePlan(8); return null; }
    await act(async () => { create(<Uses />); });
    forgetPlansSeen();
    const seen: Array<Plan | null> = [];
    function Again() { const { plan: p } = usePlan(8); seen.push(p); return null; }
    await act(async () => { create(<Again />); });
    expect(seen[0]).toBeNull();
  });
});

describe("script lines: where the fixed room is not enough, the measured ink decides", () => {
  const { inkShortfall } = require("./components");
  const m = (w: number, l: number, r: number) => ({ width: w, actualBoundingBoxLeft: l, actualBoundingBoxRight: r, actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 12, fontBoundingBoxAscent: 36, fontBoundingBoxDescent: 14 });
  it("FULL MOON-like: the last swash past the box on the right, centred", () => {
    // box 320 wide with 11 px padding each side; text 280 wide centred; ink 31 px past the advance on the right
    const s = inkShortfall({ width: 320, height: 83, padL: 11, padT: 23, contentW: 298, lineHeight: 37 }, m(280, 0, 311), true);
    expect(Math.round(s.right)).toBe(11);            // 11 + 9 + 311 − 320
    expect(s.left).toBeLessThan(0);
    expect(s.top).toBeLessThan(0);
    expect(s.bottom).toBeLessThan(0);
  });
  it("left-aligned: a flourish before the first letter is room on the left", () => {
    const s = inkShortfall({ width: 300, height: 60, padL: 0, padT: 0, contentW: 300, lineHeight: 37 }, m(200, 6, 200), false);
    expect(s.left).toBe(6);
  });
});
