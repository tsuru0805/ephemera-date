/// <reference types="jest" />
//
// 放照片每一步的失败都不静默、「收好」何时能点、等待中写清在等什么(取照片 / 放进卡套 / 上传中 N%)、上传超时报错可重试。
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
const mockLaunch = jest.fn();
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: (...a: unknown[]) => mockLaunch(...a) }));
jest.mock("react-native-gesture-handler", () => {
  const chain: object = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : () => chain), apply: () => chain });
  return { Gesture: new Proxy({}, { get: () => () => chain }), GestureDetector: ({ children }: { children: unknown }) => children };
});

import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { Image, Text } from "react-native";
import { ephemeraApi, type Stop, TIMEOUTS, TIMEOUT_WRITE_TEXT } from "../../lib/ephemeraApi";
import { doneTopFor, PhotoFlow, PICK_ERR, PUSH_HINT, statusLine } from "./PhotoFlow";
import { SKINS } from "./theme";

const stop: Stop = { n: 1, stop_id: 11, kind: "walk", time: "13:00", stay_until: null, clue: null, note: null, place: null };
const texts = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(Text).map((t) => [t.props.children].flat(3).filter((x) => typeof x === "string").join("")).join("|");
const byId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((x: ReactTestInstance) => x.props.testID === id && typeof x.type !== "string", { deep: false });
const status = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((x: ReactTestInstance) => x.props.testID === "photo-status" && x.type === Text).map((x) => x.props.children)[0] ?? null;
const wait = (ms: number) => act(async () => { await new Promise((x) => setTimeout(x, ms)); });
// 选好的照片不再自动滑进卡套,要按住往下推(测试用 photo-drag 的 Pressable 兜底=原型「点一下也直接推进去」那条分支)
const dropIn = (r: TestRenderer.ReactTestRenderer) => act(async () => { byId(r, "photo-drag")[0].props.onPress(); await new Promise((x) => setTimeout(x, 450)); });
const asset = { uri: "file:///photo.heic", mimeType: "image/heic", fileName: "IMG_0001.HEIC", width: 4032, height: 3024 };
async function mount(onDone: (...a: any[]) => Promise<void> = jest.fn(async () => {})) { // eslint-disable-line @typescript-eslint/no-explicit-any
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<PhotoFlow s={stop} i={0} P={SKINS.ivory} skin="ivory" onClose={jest.fn()} onSkip={jest.fn()} onDone={onDone} />); });
  return r;
}
beforeEach(() => mockLaunch.mockReset());

describe("取照片:每个失败分支都写明、能重来", () => {
  it("相册打不开(抛错)=写原话,「+」还在可以再点", async () => {
    mockLaunch.mockRejectedValueOnce(new Error("没有访问相册的权限"));
    const r = await mount();
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    expect(status(r)).toBe(PICK_ERR.failed("没有访问相册的权限"));
    expect(byId(r, "photo-pick")).toHaveLength(1);
    act(() => r.unmount());
  });
  it("她自己取消=不算错,不写字", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: true, assets: null });
    const r = await mount();
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    expect(status(r)).toBeNull();
    expect(byId(r, "photo-pick")).toHaveLength(1);
    act(() => r.unmount());
  });
  it("相册返回空(没交回照片)=写明,能再选", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [] });
    const r = await mount();
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    expect(status(r)).toBe(PICK_ERR.empty);
    expect(byId(r, "photo-pick")).toHaveLength(1);
    act(() => r.unmount());
  });
  it("照片读不出来(图片加载失败,如没下到本地的 iCloud 原图)=写明,回到「+」", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    const r = await mount();
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    const img = r.root.findAll((x: ReactTestInstance) => x.type === Image && x.props.testID === "photo-img")[0];
    act(() => img.props.onError({ nativeEvent: { error: "decode failed" } }));
    expect(status(r)).toBe(PICK_ERR.unreadable);
    expect(byId(r, "photo-pick")).toHaveLength(1);
    act(() => r.unmount());
  });
  it("取照片慢(iCloud 下载中):写「正在取照片」,过两秒带秒数", async () => {
    let finish!: (v: unknown) => void;
    mockLaunch.mockReturnValueOnce(new Promise((res) => { finish = res; }));
    const r = await mount();
    act(() => { byId(r, "photo-pick")[0].props.onPress(); });
    expect(status(r)).toBe("正在取照片");
    await wait(2100);
    expect(status(r)).toMatch(/^正在取照片 · [23] 秒$/);
    await act(async () => { finish({ canceled: true, assets: null }); });
    act(() => r.unmount());
  });
});

describe("「收好」什么时候能点", () => {
  it("没照片=灰;刚选到(等她推进卡套)=灰、底下一行说怎么做;推进去以后=能点;没封口时点它=先盖邮戳再收,交回照片/小字/编号", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    const onDone = jest.fn(async (..._a: unknown[]) => {});
    const r = await mount(onDone as never);
    expect(byId(r, "photo-done")[0].props.disabled).toBe(true);
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    expect(byId(r, "photo-done")[0].props.disabled).toBe(true);
    expect(status(r)).toBe(PUSH_HINT); // 落下来之后等她按住往下推,不再自动滑;「收好」灰着=底下那行说为什么(新用户实测:灰着没提示不知道要推)
    expect(byId(r, "photo-drag")).toHaveLength(1); // 这张拍立得现在要靠这个口推进卡套
    await dropIn(r);
    expect(byId(r, "photo-done")[0].props.disabled).toBe(false);
    expect(status(r)).toBeNull();
    await act(async () => { const j = byId(r, "photo-done")[0].props.onPress(); await new Promise((x) => setTimeout(x, 600)); await j; });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toBe(asset);
    expect(byId(r, "photo-sleeve")[0].props.disabled).toBe(true); // 已经封口
    act(() => r.unmount());
  });
});

describe("上传进度与超时", () => {
  it("进度从 0 到完成都写在「收好」底下;等待时「收好」不能点", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    let prog!: (f: number) => void, finish!: () => void;
    const onDone = jest.fn((_a, _c, _id, onProgress: (f: number) => void) => { prog = onProgress; return new Promise<void>((res) => { finish = res; }); });
    const r = await mount(onDone as never);
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    await dropIn(r);
    act(() => { byId(r, "photo-done")[0].props.onPress(); });
    await wait(600);
    expect(status(r)).toBe("上传中");
    expect(byId(r, "photo-done")[0].props.disabled).toBe(true);
    act(() => prog(0)); expect(status(r)).toBe("上传中 0%");
    act(() => prog(0.42)); expect(status(r)).toBe("上传中 42%");
    act(() => prog(1)); expect(status(r)).toBe("上传中 100%");
    await act(async () => { finish(); });
    act(() => r.unmount());
  });
  it("上传失败/超时=写原话,「收好」重新能点(重试)", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    let n = 0;
    const onDone = jest.fn(async () => { if (n++ === 0) throw new Error(TIMEOUT_WRITE_TEXT); });
    const r = await mount(onDone);
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    await dropIn(r);
    await act(async () => { const j = byId(r, "photo-done")[0].props.onPress(); await new Promise((x) => setTimeout(x, 600)); await j; });
    expect(status(r)).toBe(`没收好 · ${TIMEOUT_WRITE_TEXT}`);
    expect(byId(r, "photo-done")[0].props.disabled).toBe(false);
    await act(async () => { await byId(r, "photo-done")[0].props.onPress(); });
    expect(onDone).toHaveBeenCalledTimes(2);
    act(() => r.unmount());
  });
  it("uploadPhoto(XHR):回报进度 0→42%→100%;到期限没回应=明确的超时错", async () => {
    type X = { upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void }; onload?: () => void; onerror?: () => void; status: number; responseText: string; aborted?: boolean };
    const made: X[] = [];
    class FakeXHR {
      upload: X["upload"] = {}; onload?: () => void; onerror?: () => void; status = 0; responseText = ""; aborted = false;
      constructor() { made.push(this as unknown as X); }
      open() {} setRequestHeader() {} send() {} abort() { this.aborted = true; }
    }
    const saved = (global as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    (global as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
    const fracs: number[] = [];
    const p = ephemeraApi.uploadPhoto(13, 11, asset, "", "cid", (f) => fracs.push(f));
    await new Promise((x) => setTimeout(x, 10));
    const x = made[0];
    x.upload.onprogress!({ lengthComputable: true, loaded: 42, total: 100 });
    x.status = 200; x.responseText = JSON.stringify({ id: 1, stop_id: 11, caption: null, created_at: 1 });
    x.onload!();
    await expect(p).resolves.toMatchObject({ id: 1 });
    expect(fracs).toEqual([0, 0.42, 1]);
    const old = TIMEOUTS.photo;
    TIMEOUTS.photo = 30;
    const q = ephemeraApi.uploadPhoto(13, 11, asset, "", "cid2");
    await expect(q).rejects.toMatchObject({ code: "timeout", message: TIMEOUT_WRITE_TEXT });
    expect(made[1].aborted).toBe(true);
    TIMEOUTS.photo = old;
    (global as { XMLHttpRequest?: unknown }).XMLHttpRequest = saved;
  });
});

describe("位置与文字", () => {
  it("「收好」不压在底部导航上;状态行文字", () => {
    expect(doneTopFor(1000, 80)).toBe(742);
    expect(doneTopFor(780, 90)).toBe(780 - 90 - 110);
    expect(statusLine({ k: "uploading", pct: 0.421 })).toBe("上传中 42%");
    expect(statusLine({ k: "idle" })).toBeNull();
  });
});

describe("review", () => {
  type X = { upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void }; onload?: () => void; onerror?: () => void;
    status: number; responseText: string; aborted?: boolean; headers: Record<string, string>; body: unknown };
  let made: X[] = [];
  let saved: unknown;
  class FakeXHR {
    upload: X["upload"] = {}; onload?: () => void; onerror?: () => void; status = 0; responseText = ""; aborted = false; headers: Record<string, string> = {}; body: unknown;
    constructor() { made.push(this as unknown as X); }
    open() {} setRequestHeader(k: string, v: string) { this.headers[k] = v; } send(b: unknown) { this.body = b; } abort() { this.aborted = true; }
  }
  const fdGet = (fd: unknown, k: string): unknown => {
    const f = fd as { get?: (k: string) => unknown; getParts?: () => Array<{ fieldName: string; string?: string }> };
    return typeof f.get === "function" ? f.get(k) : f.getParts?.().find((x) => x.fieldName === k)?.string;
  };
  beforeEach(() => { made = []; saved = (global as { XMLHttpRequest?: unknown }).XMLHttpRequest; (global as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR; });
  afterEach(() => { (global as { XMLHttpRequest?: unknown }).XMLHttpRequest = saved; });
  const tickNow = () => new Promise((x) => setTimeout(x, 5));

  it("M1 连点「收好」:盖戳等待期间再点也只提交一次", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    const onDone = jest.fn(async () => {});
    const r = await mount(onDone);
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    await dropIn(r);
    await act(async () => {
      const a = byId(r, "photo-done")[0].props.onPress();
      const b = byId(r, "photo-done")[0].props.onPress();
      await new Promise((x) => setTimeout(x, 100));
      const c = byId(r, "photo-done")[0].props.onPress();
      await new Promise((x) => setTimeout(x, 600)); await Promise.all([a, b, c]);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("上传带鉴权头;重试用同一个 client_id;断网/引擎拒的原话", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    const r = await mount((file, caption, cid, onProgress) => ephemeraApi.uploadPhoto(13, 11, file, caption, cid, onProgress) as unknown as Promise<void>);
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    await dropIn(r);
    await act(async () => { byId(r, "photo-done")[0].props.onPress(); await new Promise((x) => setTimeout(x, 600)); });
    expect(made).toHaveLength(1);
    expect(made[0].headers.Authorization).toBe("Bearer tok");
    await act(async () => { made[0].onerror!(); await tickNow(); });
    expect(status(r)).toBe("没收好 · 照片没传上去：网络断了，点一下再试");
    await act(async () => { byId(r, "photo-done")[0].props.onPress(); await tickNow(); });
    expect(made).toHaveLength(2);
    expect(fdGet(made[1].body, "client_id")).toBe(fdGet(made[0].body, "client_id"));
    await act(async () => { made[1].status = 413; made[1].responseText = JSON.stringify({ detail: { code: "too_big", text: "照片太大了，换一张小一点的" } }); made[1].onload!(); await tickNow(); });
    expect(status(r)).toBe("没收好 · 照片太大了，换一张小一点的");
    act(() => r.unmount());
  });

  it("超时以后迟到的进度不覆盖错误;卸载后的进度事件不再动页面", async () => {
    const old = TIMEOUTS.photo;
    TIMEOUTS.photo = 40;
    const fr: number[] = [];
    const p = ephemeraApi.uploadPhoto(13, 11, asset, "", "cid", (f) => fr.push(f));
    await expect(p).rejects.toMatchObject({ code: "timeout" });
    made[0].upload.onprogress!({ lengthComputable: true, loaded: 50, total: 100 });   // 迟到
    expect(fr).toEqual([0]);
    TIMEOUTS.photo = old;
    // 页面层:上传中途卸载,之后的进度/完成不再 setState(直接记 setter 调用,不靠 console.error)
    const React = require("react");
    const realUseState = React.useState;
    let afterUnmount = false, lateSets = 0;
    const spy = jest.spyOn(React, "useState").mockImplementation((init: unknown) => {
      const [v, set] = realUseState(init);
      return [v, (x: unknown) => { if (afterUnmount) lateSets++; set(x); }];
    });
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    const r = await mount((file, caption, cid, onProgress) => ephemeraApi.uploadPhoto(13, 11, file, caption, cid, onProgress) as unknown as Promise<void>);
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    await dropIn(r);
    await act(async () => { byId(r, "photo-done")[0].props.onPress(); await new Promise((x) => setTimeout(x, 600)); });
    const x = made[made.length - 1];
    act(() => r.unmount());
    afterUnmount = true;
    await act(async () => {
      x.upload.onprogress!({ lengthComputable: true, loaded: 30, total: 100 });
      x.status = 200; x.responseText = "{}"; x.onload!();
      await tickNow();
    });
    expect(lateSets).toBe(0);
    spy.mockRestore();
  });

  it("上传失败打 [PhotoFlow] 探针", async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const r = await mount(async () => { throw new Error("引擎忙"); });
    await act(async () => { await byId(r, "photo-pick")[0].props.onPress(); });
    await dropIn(r);
    await act(async () => { const j = byId(r, "photo-done")[0].props.onPress(); await new Promise((x) => setTimeout(x, 600)); await j; });
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[PhotoFlow]"))).toBe(true);
    warn.mockRestore();
    act(() => r.unmount());
  });
});
