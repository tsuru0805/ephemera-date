/// <reference types="jest" />
// 回忆式约会(App):一叠照片只认不挂站的、两种摆法的判定、平时零加号/编辑态才有空位、「我先写一样」只列她能写的三样、
// 信页与回信、拆开报引擎(本机拆过引擎没记=补报)、补记页「这次的照片」进草稿。
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("react-native-reanimated", () => ({
  ...require("react-native-reanimated/mock"),
  useSharedValue: (init: unknown) => require("react").useRef({ value: init }).current,
  withTiming: (to: unknown) => to, withSpring: (to: unknown) => to, withDelay: (_d: number, a: unknown) => a, withRepeat: (a: unknown) => a,
}));
jest.mock("@shopify/react-native-skia", () => {
  const { View } = require("react-native");
  const Pass = ({ children }: { children?: unknown }) => <View>{children as never}</View>;
  const stub: object = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : stub), apply: () => stub });
  return new Proxy({ Skia: stub, vec: (x: number, y: number) => ({ x, y }), useImage: () => null, useFont: () => null }, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : k === "__esModule" ? true : Pass) });
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("react-native-keyboard-controller", () => ({ useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }) }));
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
jest.mock("../../fonts", () => ({ F: new Proxy({}, { get: (_t, k) => String(k) }), usePosterFonts: () => ({ ready: true, error: null }) }));
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock("expo-router", () => ({ useFocusEffect: (fn: () => void) => require("react").useEffect(fn, []),
  useLocalSearchParams: () => ({ id: "7" }), useRouter: () => mockRouter }));
jest.mock("../../lib/storage", () => ({ storage: { getBase: async () => "http://gw.test", getToken: async () => "tok" } }));

import AsyncStorage from "@react-native-async-storage/async-storage";
import TestRenderer, { act } from "react-test-renderer";
import { ephemeraApi, type HerPhoto, type Plan } from "../../lib/ephemeraApi";
import { parseSavedBackfill, draftHasContent, newDraft } from "./backfill";
import { daySlot, dayPhotosHeight } from "./BackfillScreen";
import { cardTextSize, lidLines, LID_MIN, LID_MIN2 } from "./BoxScreen";
import { FlatKeepsakes, LetterEditor, LetterPage, memorySolo, photoSlot, stackPhotos, useStackUploads, writableFirst } from "./Keepsakes";
import { EphemeraError } from "../../lib/ephemeraApi";
import { forgetPlansSeen, isOpened, markOpened, syncOpened, usePlan } from "./store";
import { EphemeraInviteScreen } from "./InviteScreen";
import { EphemeraDayScreen } from "./DayScreen";
import { PrepCard, PREP_W } from "./PrepCard";
import { scriptRoom } from "./components";
import { FF } from "./theme";
import { MAPPAL, SKINS } from "./theme";
import { stopState } from "./format";
import { ticketStatus } from "./MapScreen";
import { mapState } from "./mapState";

const P = SKINS.ivory, M = MAPPAL.ivory;
const ph = (id: number, stop_id: number | null, created_at = id): HerPhoto => ({ id, stop_id, caption: null, created_at });
const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 7, paper_no: null, title_en: "Golden Hour", date: "2026-10-10", color: "blush", status: "done",
  stops: [{ n: 1, stop_id: 1, kind: "walk", time: "17:00", stay_until: null, clue: null, place: null, note: null }],
  prep: [], contract: null, card: null, quote: null, sent_at: null, closed_at: 1, cancelled_at: null, ...over,
});
const ids = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => typeof n.props.testID === "string").map((n) => n.props.testID as string);

beforeEach(() => { jest.restoreAllMocks(); jest.spyOn(ephemeraApi, "photoSource").mockResolvedValue({ uri: "x", headers: {} }); });

describe("一叠照片 / 摆法", () => {
  it("只认不挂站的,按放进去的先后", () => {
    expect(stackPhotos([ph(3, null, 30), ph(1, 5), ph(2, null, 10)]).map((p) => p.id)).toEqual([2, 3]);
  });
  it("只有一站、或者没有请柬=照片和信是主角;齐全的多站盒子=压在最上面", () => {
    expect(memorySolo(plan(), true)).toBe(true);
    const two = plan({ stops: [...plan().stops, { ...plan().stops[0], n: 2, stop_id: 2 }] });
    expect(memorySolo(two, false)).toBe(true);
    expect(memorySolo(two, true)).toBe(false);
  });
  it("照片页九张一组往下接,补记页一行五张", () => {
    expect(photoSlot(0)).toEqual([24, 214, 222, 270, -2.5]);
    expect(photoSlot(9)[1]).toBe(214 + 1190);
    expect(daySlot(5)[1]).toBeGreaterThan(daySlot(4)[1]);
    expect(dayPhotosHeight(6)).toBeGreaterThan(dayPhotosHeight(5));
  });
});

describe("平铺页:平时零加号,编辑态才有空位", () => {
  const render = (p: Plan, photos: HerPhoto[], editing: boolean) => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<FlatKeepsakes plan={p} photos={photos} ups={[]} P={P} solo ph={780} editing={editing} onPhotos={jest.fn()} onAddPhotos={jest.fn()} onLetter={jest.fn()} />); });
    return r;
  };
  it("没照片没信、不在编辑:什么都不摆", () => {
    expect(ids(render(plan(), [], false))).toEqual([]);
  });
  it("没照片没信、编辑态:空拍立得「放照片」+ 空白信纸「写给他」", () => {
    const got = ids(render(plan(), [], true));
    expect(got).toContain("flat-add-photos");
    expect(got).toContain("flat-letter-blank");
  });
  it("有照片有信:那一叠 + 信;编辑态也不另出空位", () => {
    const p = plan({ letter: { text: "那天的风", updated_at: 1 } });
    const got = ids(render(p, [ph(1, null), ph(2, null)], true));
    expect(got).toContain("flat-stack");
    expect(got).toContain("flat-letter");
    expect(got).not.toContain("flat-add-photos");
    expect(got).not.toContain("flat-letter-blank");
  });
});

describe("信页", () => {
  it("她的信全文;他回了才有回信那张", () => {
    let r!: TestRenderer.ReactTestRenderer;
    const p = plan({ letter: { text: "那天的风", updated_at: 1 } });
    act(() => { r = TestRenderer.create(<LetterPage plan={p} P={P} M={M} ph={780} editing={false} onEdit={jest.fn()} />); });
    expect(r.root.findByProps({ testID: "letter-text" }).props.children).toBe("那天的风");
    expect(ids(r)).not.toContain("reply-card");
    act(() => { r.update(<LetterPage plan={{ ...p, reply: { text: "我也记得", updated_at: 2 } }} P={P} M={M} ph={780} editing={false} onEdit={jest.fn()} />); });
    expect(ids(r)).toContain("reply-card");
  });
});

describe("我先写一样", () => {
  it("只列她能先写的三样(那一句话 / 回信 / 事件卡后续不列)", () => {
    expect(writableFirst(["invite", "quote", "card", "reply", "wb_after", "contract"])).toEqual(["invite", "card", "contract"]);
    expect(writableFirst(undefined)).toEqual([]);
  });
});

describe("拆开报引擎", () => {
  beforeEach(async () => { await AsyncStorage.clear(); });
  it("按拆开:本机先记、再报引擎;报不上也不挡她(下次补报)", async () => {
    const open = jest.spyOn(ephemeraApi, "open").mockResolvedValueOnce(plan({ opened_at: 100 })).mockRejectedValueOnce(new Error("断网"));
    expect((await markOpened(7))?.opened_at).toBe(100);
    jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await markOpened(8)).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
    expect(isOpened(null, JSON.parse((await AsyncStorage.getItem("ephemera.local.8")) || "{}"))).toBe(true);
  });
  it("引擎记下的也算拆过(换手机);本机拆过引擎没记=补报一次,引擎已记=不再报", async () => {
    const open = jest.spyOn(ephemeraApi, "open").mockResolvedValue(plan());
    expect(await syncOpened(plan({ id: 9, opened_at: 50 }))).toBe(true);
    expect(open).not.toHaveBeenCalled();
    await AsyncStorage.setItem("ephemera.local.9", JSON.stringify({ opened: true }));
    expect(await syncOpened(plan({ id: 9, opened_at: null }))).toBe(true);
    expect(open).toHaveBeenCalledWith(9);
    expect(await syncOpened(plan({ id: 10, opened_at: null }))).toBe(false);
  });
});

describe("补记页「这次的照片」进草稿", () => {
  it("只放了照片也算写过;读回来保留,坏的那条丢掉", () => {
    const d = { ...newDraft(), dayPhotos: [{ uri: "file://a.jpg", caption: "", clientId: "day-1" }] };
    expect(draftHasContent(d)).toBe(true);
    const saved = parseSavedBackfill(JSON.stringify({ v: 1, clientId: "c", at: 1, draft: { ...d, dayPhotos: [...d.dayPhotos, { uri: 3 }] } }));
    expect(saved?.draft.dayPhotos).toEqual([{ uri: "file://a.jpg", caption: "", clientId: "day-1" }]);
  });
});

describe("review修", () => {
  it("她删了信、回信还在:平铺页放他那张,信页只有回信", () => {
    const p = plan({ letter: null, reply: { text: "我也记得", updated_at: 2 } });
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<FlatKeepsakes plan={p} photos={[]} ups={[]} P={P} solo ph={780} editing={false} onPhotos={jest.fn()} onAddPhotos={jest.fn()} onLetter={jest.fn()} />); });
    expect(ids(r)).toContain("flat-reply");
    act(() => { r.update(<LetterPage plan={p} P={P} M={M} ph={780} editing={false} onEdit={jest.fn()} />); });
    expect(ids(r)).toContain("reply-card");
    expect(ids(r)).not.toContain("letter-paper");
  });
  it("写信写到一半在纸外面点:第一下只提醒、不关;再点一下才放下;有没收好的字告诉宿主", () => {
    const onClose = jest.fn(), onDirty = jest.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<LetterEditor plan={plan()} P={P} onSaved={jest.fn()} onDirty={onDirty} onClose={onClose} />); });
    act(() => { r.root.findByProps({ testID: "letter-input" }).props.onChangeText("写了一半"); });
    expect(onDirty).toHaveBeenLastCalledWith(true);
    const backdrop = r.root.findAll((n) => n.props.onPress && n.props.style?.zIndex === 45)[0];
    act(() => { backdrop.props.onPress(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(ids(r)).toContain("letter-away");
    act(() => { backdrop.props.onPress(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    r.unmount();
  });
  it("一叠照片:换的那张已经不在了=不再指着它,写明「当新的一张放进去」;没传上的可以不要", async () => {
    const up = jest.spyOn(ephemeraApi, "uploadPhoto").mockRejectedValueOnce(new EphemeraError(404, "要换的那张照片不在了")).mockRejectedValueOnce(new EphemeraError(0, "网络断了"));
    jest.spyOn(console, "warn").mockImplementation(() => {});
    let api!: ReturnType<typeof useStackUploads>;
    const Probe = () => { api = useStackUploads(7, jest.fn()); return null; };
    act(() => { TestRenderer.create(<Probe />); });
    await act(async () => { api.add([{ uri: "file://a.jpg", width: 1, height: 1 } as never], 42); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(api.ups[0].replaceId).toBeUndefined();
    expect(api.ups[0].err).toContain("当新的一张放进去");
    await act(async () => { api.retry(api.ups[0].key); await new Promise((r) => setTimeout(r, 0)); });
    expect(up).toHaveBeenLastCalledWith(7, null, expect.anything(), "", expect.any(String), expect.any(Function), false, undefined);
    expect(api.ups[0].err).toContain("网络断了");
    act(() => { api.drop(); });
    expect(api.ups).toEqual([]);
  });
});

describe("限定小卡", () => {
  it("卡背的字按字数定大小:短的 16、最长 200 字也不小于 11.5", () => {
    expect(cardTextSize("短短一句").fontSize).toBe(16);
    expect(cardTextSize("字".repeat(200)).fontSize).toBe(11.5);
    expect(cardTextSize(null).fontSize).toBe(16);
    expect(cardTextSize(Array(20).fill("字").join("\n")).fontSize).toBeLessThan(16);   // 一字一行二十行:按行数挑小号
    expect(cardTextSize(Array(40).fill("字").join("\n")).fits).toBe(false);           // 怎么都放不下=卡里可以滑
  });
});

describe("照片刷新的先后(review)", () => {
  it("先发的那次晚回来,不许把后发那次的新列表盖回去", async () => {
    const her = jest.spyOn(ephemeraApi, "her").mockResolvedValue({ marks: {}, photos: [], now: 1 });
    jest.spyOn(ephemeraApi, "plan").mockResolvedValue(plan());
    let api!: ReturnType<typeof usePlan>;
    const Probe = () => { api = usePlan(7); return null; };
    await act(async () => { TestRenderer.create(<Probe />); });
    let first!: (v: unknown) => void;
    her.mockImplementationOnce(() => new Promise((r) => { first = r as never; }))
      .mockResolvedValueOnce({ marks: {}, photos: [ph(1, null), ph(2, null)], now: 1 });
    let p1!: Promise<unknown>;
    await act(async () => { p1 = api.refreshHer(); await api.refreshHer(); });
    await act(async () => { first({ marks: {}, photos: [ph(1, null)], now: 1 }); await p1; });
    expect(api.her?.photos.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe("不藏行程的请柬", () => {
  const stop = (n: number, t: string, title: string) => ({ n, stop_id: n, kind: "walk", time: t, stay_until: null, clue: null, note: null,
    place: { title, address: null, lat: null, lng: null, how_to_get: null, walk_path: null, leg: null } });
  const render = async (p: Plan) => {
    jest.spyOn(ephemeraApi, "plan").mockResolvedValue(p);
    jest.spyOn(ephemeraApi, "her").mockResolvedValue({ marks: {}, photos: [], now: 1 });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraInviteScreen />); });
    return r;
  };
  it("拆开后(引擎记下了):一站一行时间+地点,不再写「当天公开」", async () => {
    const r = await render(plan({ status: "sent", open_itinerary: true, opened_at: 5, stops: [stop(1, "19:00", "河畔駅"), stop(2, "19:30", "Le Petit Pot")] }));
    expect(r.root.findAll((n) => n.props.testID === "invite-route-row" && typeof n.type === "string").length).toBe(2);
    r.unmount();
  });
  it("藏行程的照旧:Time / Place 两行", async () => {
    const r = await render(plan({ status: "sent", stops: [{ ...stop(1, "19:00", "x"), place: null }] }));
    expect(r.root.findAll((n) => n.props.testID === "invite-route-row").length).toBe(0);
    r.unmount();
  });
});

describe("当天页提示写在页头日期那一行(不和连票上的字重叠)", () => {
  beforeEach(() => { forgetPlansSeen(); });
  it("点还没到时间的一格:日期那行换成提示,不出浮层", async () => {
    const st = { n: 1, stop_id: 1, kind: "walk", time: "23:00", stay_until: null, clue: null, note: null, place: null, arrive_at: 4102444800 };
    jest.spyOn(ephemeraApi, "plan").mockResolvedValue(plan({ status: "live", sent_at: 1, stops: [st] }));
    jest.spyOn(ephemeraApi, "her").mockResolvedValue({ marks: {}, photos: [], now: 1 });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraDayScreen />); });
    const seg = r.root.findAll((n) => n.props.accessibilityLabel === "第 1 站" && typeof n.props.onPress === "function")[0];
    await act(async () => { seg.props.onPress(); });
    const hint = r.root.findAll((n) => n.props.testID === "day-hint" && typeof n.type === "string");
    expect(hint.length).toBe(1);
    expect(String(hint[0].props.children)).toContain("才能拆开这一格");
    r.unmount();
  });
});

describe("花体标题不被裁(信封上两行花体名两端各缺一个字母、字头与下伸笔画被切)", () => {
  it("花体行两侧留 0.22 倍字号、负外边距等量撑开、定宽的加宽;非花体不动", () => {
    expect(scriptRoom({ fontFamily: FF.script, fontSize: 50, lineHeight: 37, paddingRight: 8 })).toEqual({ paddingLeft: 11, paddingRight: 11, marginLeft: -11, marginRight: -11,
      paddingTop: 23, paddingBottom: 23, marginTop: -23, marginBottom: -23, maxWidth: "calc(100% + 22px)" });   // 上下:(75-37)/2=19 + 4;网页:不定宽的行放开 max-width
    expect(scriptRoom({ fontFamily: FF.script, fontSize: 118, width: 330 })).toMatchObject({ width: 330 + 52, marginLeft: -26 });
    expect(scriptRoom({ fontFamily: FF.pf9, fontSize: 34 })).toBeNull();
  });
});

describe("盒盖英文名:先一行缩到下限,放不下再在词边界折两行", () => {
  it("缩到 0.7 能放下=一行;放不下=最靠中间的空格折两行(每行下限 0.5);一个长词不折;他自己写的两行照旧;没量出来先一行", () => {
    expect(LID_MIN).toBe(0.7);
    expect(LID_MIN2).toBe(0.5);                                                                    // 两行时每行的下限
    expect(lidLines("Late Night Dessert", null, 400)).toEqual(["Late Night Dessert", null]);      // 400×0.7=280 ≤ 330
    expect(lidLines("Late Night Dessert", null, 600)).toEqual(["Late Night", "Dessert"]);
    expect(lidLines("Supercalifragilistic", null, 900)).toEqual(["Supercalifragilistic", null]);
    expect(lidLines("Empty Stomach", "Full Moon", 9999)).toEqual(["Empty Stomach", "Full Moon"]);
    expect(lidLines("Empty Stomach Full Moon", null, null)).toEqual(["Empty Stomach Full Moon", null]);
  });
});

describe("跳过的站(约会要有弹性)", () => {
  const st = (o: object) => ({ n: 1, stop_id: 1, kind: "dinner", time: "18:00", stay_until: null, clue: null, note: null, place: null, arrive_at: 100, ...o });
  it("当天页:跳过的站是 skipped(检过票的仍算检过);地图票券写「跳过了」;下一站不落在跳过的站上", () => {
    expect(stopState(st({ skipped: true }) as never, false, 50, true)).toBe("skipped");
    expect(stopState(st({ skipped: true }) as never, true, 50, true)).toBe("skipped");   // 检过票后才跳过也标跳过
    const p = plan({ status: "live", sent_at: 1, stops: [st({ stop_id: 1, arrive_at: 100, skipped: true }), st({ n: 2, stop_id: 2, arrive_at: 200 })] as never });
    const ms = mapState(p, 50);
    expect(ms.next).toBe(1);
    expect(ticketStatus(p.stops[0], 0, ms, false)).toEqual(["lock", "跳过了"]);
    expect(ticketStatus(p.stops[0], 0, ms, true)).toEqual(["lock", "跳过了"]);
    const p3 = plan({ status: "live", sent_at: 1, stops: [st({ stop_id: 1, arrive_at: 10 }), st({ n: 2, stop_id: 2, arrive_at: 20, skipped: true }), st({ n: 3, stop_id: 3, arrive_at: 999 })] as never });
    expect(mapState(p3, 50).here).toBe(0);                     // 当前站不落在跳过的第 2 站
  });
  it("当天页:跳过的站写「跳过了：原因」、点了不开票、不算进进度", async () => {
    forgetPlansSeen();
    const a = st({ stop_id: 1, arrive_at: 1, place: null }), b = st({ n: 2, stop_id: 2, arrive_at: 1, skipped: true, skip_reason: "太晚了" });
    jest.spyOn(ephemeraApi, "plan").mockResolvedValue(plan({ status: "live", sent_at: 1, stops: [a, b] as never }));
    jest.spyOn(ephemeraApi, "her").mockResolvedValue({ marks: {}, photos: [], now: 50 });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<EphemeraDayScreen />); });
    const texts = r.root.findAll((n) => typeof n.type === "string" && typeof n.props.children === "string").map((n) => n.props.children as string);
    expect(texts).toContain("跳过了：太晚了");
    expect(texts).toContain(" / 1");                            // 两站里跳过一站:进度只算一站
    const seg = r.root.findAll((n) => n.props.accessibilityLabel === "第 2 站" && typeof n.props.onPress === "function")[0];
    await act(async () => { seg.props.onPress(); });
    expect(r.root.findAll((n) => n.props.accessibilityLabel === "检票")).toHaveLength(0);
    const hint = r.root.findAll((n) => n.props.testID === "day-hint" && typeof n.type === "string");
    expect(String(hint[0]?.props.children)).toContain("这一站跳过了");
    r.unmount();
  });
});

describe("准备清单在纪念盒里按真实尺寸画,不整张缩放(糊)", () => {
  it("k=0.5 时整张宽 169、字号减半,外层没有 scale", () => {
    const p = plan({ prep: [{ section: "bring", text: "外套", detail: null, derived: false }] as never });
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<PrepCard plan={p} her={null} P={P} live={false} k={0.5} />); });
    const root = r.root.findAll((n) => typeof n.type === "string" && n.props.style && n.props.style.width === PREP_W * 0.5);
    expect(root.length).toBeGreaterThan(0);
    const scaled = r.root.findAll((n) => typeof n.type === "string" && JSON.stringify(n.props.style ?? {}).includes('"scale":0.5'));
    expect(scaled).toEqual([]);
    const item = r.root.findAll((n) => typeof n.type === "string" && n.props.children === "外套")[0];
    expect(item.props.style.fontSize).toBe(7);
    r.unmount();
  });
});

describe("a short screen (a phone browser with its bars): pages laid out at fixed places scroll, nothing is cut off", () => {
  const { tallPage, Stage, useStage } = require("./components");
  it("tallPage: the screen's height when enough, else the page's need, scrolled", () => {
    expect(tallPage(844, 818)).toEqual({ h: 844, scroll: false });
    expect(tallPage(660, 818)).toEqual({ h: 818, scroll: true });   // iOS Chrome on a 402-wide phone: 680 px tall
    expect(tallPage(660, undefined)).toEqual({ h: 660, scroll: false });   // pages that scroll by themselves
  });
  it("Stage with minH: a scroll view as tall as the page needs; enough room = exactly the screen (nothing to scroll)", () => {
    let probe!: { s: number; top: number; H: number };
    const Probe = () => { probe = useStage(); return null; };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<><Probe /><Stage P={P} minH={probe ? probe.H + 100 : 2000}>{null}</Stage></>); });
    const sv = () => r.root.findAll((n) => n.props?.testID === "stage-scroll" && n.props.contentContainerStyle)[0];
    expect(sv().props.contentContainerStyle.height).toBeCloseTo(probe.top + 2000 * probe.s, 3);
    expect(sv().props.scrollEnabled).not.toBe(false);   // never disabled (one enabled later took no finger in iOS Safari)
    act(() => { r.update(<><Probe /><Stage P={P} minH={probe.H - 10}>{null}</Stage></>); });
    expect(sv().props.contentContainerStyle.height).toBeCloseTo(probe.top + probe.H * probe.s, 3);
    r.unmount();
  });
  it("the box's fixed pages scroll on a shorter screen; their papers are drawn in layers of their own (iOS Safari)", () => {
    const { TallScroll, Paper } = require("./components");
    const flat = (st: unknown): Record<string, unknown> => (Array.isArray(st) ? Object.assign({}, ...st.map(flat)) : ((st as Record<string, unknown>) ?? {}));
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<TallScroll have={637} need={720} testID="ts"><Paper w={100} h={80} fill="#fff" sh="0,0,0" /></TallScroll>); });
    const sv = r.root.findAll((n) => n.props?.testID === "ts" && n.props.contentContainerStyle)[0];
    expect(sv.props.contentContainerStyle.height).toBe(720);
    expect(sv.props.scrollEnabled).not.toBe(false);
    expect(r.root.findAll((n) => typeof n.type === "string" && flat(n.props.style).willChange === "transform").length).toBeGreaterThan(0);
    act(() => { r.update(<TallScroll have={780} need={720} testID="ts"><Paper w={100} h={80} fill="#fff" sh="0,0,0" /></TallScroll>); });
    expect(r.root.findAll((n) => n.props?.testID === "ts" && n.props.contentContainerStyle)[0].props.contentContainerStyle.height).toBe(780);
    r.unmount();
    // outside a scrolling page a paper is not layered
    act(() => { r = TestRenderer.create(<Paper w={100} h={80} fill="#fff" sh="0,0,0" />); });
    expect(r.root.findAll((n) => typeof n.type === "string" && flat(n.props.style).willChange === "transform")).toEqual([]);
    r.unmount();
  });
  it("the card page is scaled (not scrolled) to show the card whole on a shorter screen: its back scrolls inside", () => {
    const { fitScale, boxPageNeed, CARD_PAGE_H } = require("./BoxScreen");
    expect(boxPageNeed("card")).toBe(CARD_PAGE_H);
    expect(CARD_PAGE_H).toBeGreaterThanOrEqual(416 + 302 / 2 + 20);   // the card's foot (turned) and its shadow
    expect(fitScale(637, CARD_PAGE_H)).toBe(1);                         // iOS Safari on the iPhone 17e: as it is
    expect(fitScale(536, CARD_PAGE_H)).toBeCloseTo(0.893, 3);           // a 600-tall browser window
  });
  it("the needs cover each page's lowest control", () => {
    const { INVITE_MIN_H } = require("./InviteScreen");
    const { SEAL_MIN_H } = require("./SealScreen");
    const { BOX_PAGE_MIN_H } = require("./BoxScreen");
    expect(INVITE_MIN_H).toBeGreaterThanOrEqual(798 + 18);   // 「先收进邀请盒」
    expect(SEAL_MIN_H).toBeGreaterThanOrEqual(740 + 30);     // 「先看准备清单」
    expect(BOX_PAGE_MIN_H).toBeGreaterThanOrEqual(582 + 100); // the prep list on the flat page shows enough to tap
  });
});

describe("the box's contract and card pages (as the home app, design-base cb929c9)", () => {
  const { CONTRACT_H, BOX_PAGE_MIN_H, boxPageNeed, QUOTE_ZH_LH, cardOverflows } = require("./BoxScreen");
  it("the contract page scrolls to the paper's foot and both lower corners (850); the other fixed pages as before", () => {
    expect(CONTRACT_H).toBeGreaterThanOrEqual(226 + 580 + 20);   // the paper from 226, 580 tall, turned -3°
    expect(boxPageNeed("contract")).toBe(CONTRACT_H);
    expect(boxPageNeed("flat")).toBe(BOX_PAGE_MIN_H);
  });
  it("a Chinese line of the quote is taller than its glyphs (iOS cut their tops at 45)", () => {
    expect(QUOTE_ZH_LH).toBeGreaterThanOrEqual(44 * 1.25);
  });
  it("the card's back scrolls by the height the text really takes, not by an estimate", () => {
    expect(cardOverflows(258, 300)).toBe(true);
    expect(cardOverflows(258, 258.5)).toBe(false);
    expect(cardOverflows(0, 300)).toBe(false);          // not laid out yet
  });
});

// 10-27 她在手机浏览器上试玩:电影票的副券在屏幕外(撕不了、回到当天页还是没检票);盒盖的封标下面一块方影子、
// 纸纹只铺到 512 高(下面平的一条)、矮屏「打开」被封标盖住
describe("short phone browser: the ticket, the lid, shadows that follow the shape", () => {
  it("a ticket on a shorter screen is scaled to show whole, its foot (the cinema's stub) included", () => {
    const { ticketFit, ticketNeed } = require("./DayScreen");
    expect(ticketNeed("cinema")).toBeGreaterThanOrEqual(58 + 18 + 690);   // the sheet's top + the stub's foot
    expect(ticketNeed("shop")).toBeGreaterThanOrEqual(58 + 18 + 620);
    expect(ticketNeed("dinner")).toBeGreaterThanOrEqual(58 + 30 + 470);
    expect(ticketNeed("train")).toBeGreaterThanOrEqual(58 + 40 + 420);
    expect(ticketFit(844, "cinema")).toBe(1);                           // a phone app: as it is
    expect(ticketFit(658, "cinema")).toBeCloseTo(658 / 770, 3);         // her phone's browser with its bars
    expect(ticketFit(658, "train")).toBe(1);                            // a short ticket is not made smaller
  });
  it("the lid's title block moves up, then gets smaller, so 「打开」 stays above the seal", () => {
    const { lidTitle, lidOpenTop } = require("./BoxScreen");
    expect(lidTitle(664)).toEqual({ lift: 0, k: 1 });                  // a tall screen: as designed
    expect(lidTitle(576)).toEqual({ lift: 0, k: 1 });
    expect(lidOpenTop(664)).toBe(500);
    for (const ph of [594, 511, 470]) {                                 // her browser; an iPhone SE-class browser; shorter
      const seam = ph - 116, { lift, k } = lidTitle(seam), top = lidOpenTop(seam);
      expect(top + 72).toBeLessThanOrEqual(seam - 56);                  // 「打开 / BREAK THE SEAL」 above the seal's top
      expect(top).toBeGreaterThanOrEqual(150 + 280 * k - lift + 10);    // and under the title block's foot
      expect(150 - lift).toBeGreaterThanOrEqual(20);                    // the title stays on the lid
    }
    expect(lidTitle(594 - 116).k).toBe(1);                              // her browser: moved up only, not smaller
  });
  it("his note below a ticket makes the sheet taller (scaled to show it, never cut)", () => {
    const { ticketFit, ticketNeed } = require("./DayScreen");
    expect(ticketNeed("train")).toBe(522);
    expect(ticketNeed("train", 488 + 140)).toBe(58 + 488 + 140 + 16);   // a three-line note under the train ticket
    expect(ticketNeed("cinema", 600)).toBe(770);                        // a note above the stub: the stub decides
    expect(ticketFit(600, "train", 628)).toBeCloseTo(600 / 702, 3);
  });
  it("a shadow on a shape follows the shape (drop-shadow), with the colour's alpha", () => {
    const { shapeShadow, withAlpha } = require("./components");
    expect(withAlpha("#000", 0.18)).toBe("rgba(0, 0, 0, 0.18)");
    expect(withAlpha("#5a3c46", 0.35)).toBe("rgba(90, 60, 70, 0.35)");
    expect(withAlpha("rgb(120, 80, 90)", 0.3)).toBe("rgba(120, 80, 90, 0.3)");
    const st = shapeShadow("#000", 0.18, 3, 2);
    expect(st).toEqual({ filter: "drop-shadow(0px 2px 1.5px rgba(0, 0, 0, 0.18))" });
    expect(Object.keys(st).some((k) => k.startsWith("shadow"))).toBe(false);   // no box-shadow (the view's rectangle)
  });
  it("the paper texture is a repeating background over the whole box, not one picture", () => {
    const { PaperTex, PAPER_TEX_TILE } = require("./components");
    const { Image } = require("react-native");
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<PaperTex />); });
    expect(r.root.findAllByType(Image)).toHaveLength(0);
    const v = r.root.findByProps({ testID: "paper-tex" });
    const st = Object.assign({}, ...[v.props.style].flat(3).filter(Boolean));
    expect(st.backgroundRepeat).toBe("repeat");
    expect(PAPER_TEX_TILE).toBe(512);
    r.unmount();
  });
  it("on a page below the lit tab (the box under Archive), the lit tab goes back to the shelf", async () => {
    const { NavBar } = require("./components");
    const { SKINS } = require("./theme");
    const press = async (below: boolean) => {
      mockRouter.replace.mockClear();
      let r!: TestRenderer.ReactTestRenderer;
      act(() => { r = TestRenderer.create(<NavBar on="Archive" below={below} P={SKINS.ivory} dateHref={null} />); });
      let tab = r.root.findAll((x) => x.props.children === "Archive")[0];
      while (!tab.props.onPress) tab = tab.parent!;
      await act(async () => { await tab.props.onPress(); });
      r.unmount();
      return mockRouter.replace.mock.calls.map((c) => c[0]);
    };
    expect(await press(true)).toEqual(["/ephemera-shelf"]);
    expect(await press(false)).toEqual([]);                             // on the shelf itself: nothing to do
  });
});
