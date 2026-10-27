// Ephemera 纯逻辑单测:形状、数据→页面映射、准备清单勾选键与引擎对齐、烫金反光、地图三态。
jest.mock("../../lib/storage", () => ({ storage: { getBase: jest.fn(), getToken: jest.fn() } }));
jest.mock("../../fonts", () => ({ F: new Proxy({}, { get: (_t, k) => String(k) }) }));
import { prepMarkKey, type Plan, type Stop } from "../../lib/ephemeraApi";
import { glintFrom } from "./glint";
import { dateParts, kindEn, legLine, PAPER_OF, paperNo, placeName, prepGroups, prepLeft, quoteParts, stopState, titleLines } from "./format";
import { mainKind } from "./icons";
import { bigTicket, deckle, hashId, perf, stampXml, stripPath, zig } from "./shapes";
import { ff, mix, planCol } from "./theme";
import { mapState } from "./mapState";

const stop = (o: Partial<Stop>): Stop => ({ n: 1, stop_id: 1, kind: "train", time: "19:00", stay_until: null, clue: null, place: null, note: null, ...o });
const plan = (o: Partial<Plan>): Plan => ({ id: 3, paper_no: "1028", title_en: "The Evening\nScreening", date: "2026-10-28", color: "rose", status: "sent", stops: [], prep: [], contract: null, card: null, quote: null, sent_at: null, closed_at: null, cancelled_at: null, ...o });

describe("形状", () => {
  it("路径闭合且确定性(同尺寸两次一样)", () => {
    for (const d of [perf(102, 184), bigTicket(360, 300), stripPath(346, 600, [92, 204]), deckle(346, 640), zig(180, 270)]) {
      expect(d.trim().endsWith("Z")).toBe(true);
      expect(d).not.toMatch(/NaN|undefined/);
    }
    expect(deckle(100, 100)).toBe(deckle(100, 100));
  });
  it("印章 defs id 由内容决定,同一页多枚不撞", () => {
    expect(stampXml("A · ", "", "#000", 76)).toBe(stampXml("A · ", "", "#000", 76));
    expect(hashId("a")).not.toBe(hashId("b"));
    expect(stampXml("A&B<", "", "#000", 60)).toContain("A&amp;B&lt;");
  });
});

describe("数据 → 页面", () => {
  it("约会名两行、日期各部件、编号兜底", () => {
    expect(titleLines(plan({}))).toEqual(["The Evening", "Screening"]);
    expect(titleLines(plan({ title_en: "Moonlit" }))).toEqual(["Moonlit", ""]);
    const d = dateParts("2026-10-28");
    expect([d.slash, d.dot, d.long, d.dow, d.mon]).toEqual(["10 / 28", "10.28", "2026.10.28", "Wed", "Oct"]);
    expect(paperNo(plan({ paper_no: null, id: 7 }))).toBe("0007");
  });
  it("十九种站映射到四种纸品(新的借最接近的:票类→电影票、菜单类→晚餐、信封类→散步;§14 住宿借买东西那张)", () => {
    expect(PAPER_OF).toEqual({ train: "train", dinner: "dinner", cinema: "cinema", walk: "walk", cafe: "dinner", viewpoint: "walk", shopping: "shop", shrine: "walk",
      sweets: "dinner", bar: "dinner", onsen: "dinner", live: "cinema", museum: "cinema", aquarium: "cinema", amusement: "cinema", play: "cinema",
      park: "walk", moment: "walk", stay: "shop" });
    expect(kindEn(stop({ kind: "walk", time: "23:00" }))).toBe("Night walk");
    expect(kindEn(stop({ kind: "walk", time: "14:00" }))).toBe("Walk");
    expect(kindEn(stop({ kind: "bogus", time: "10:00" }))).toBe("Walk");
    expect(mainKind(["train", "dinner", "cinema"])).toBe("cinema");
    expect(mainKind(["walk", "dinner"])).toBe("dinner");
  });
  it("到点只认引擎下发的 arrive_at;当天以外永不亮", () => {
    const s = stop({ arrive_at: 1000 });
    expect(stopState(s, false, 999, true)).toBe("locked");
    expect(stopState(s, false, 1000, true)).toBe("now");
    expect(stopState(s, false, 2000, false)).toBe("locked");
    expect(stopState(s, true, 0, false)).toBe("done");
    expect(stopState(stop({ arrive_at: null }), false, 9e9, true)).toBe("locked");
  });
  it("站名去掉「·」后半;怎么去:他写的一句优先", () => {
    expect(placeName(stop({ place: { title: "河畔駅 · 正面改札", address: null, lat: null, lng: null, how_to_get: null, walk_path: null, leg: null } }))).toBe("河畔駅");
    const leg = { mode: "walk" as const, depart_time: null, arrive_time: null, minutes: 6, summary: "出站右转", steps: null, fare_yen: null, needs_ticket: false, ticket_note: null, official_url: null };
    expect(legLine(leg, null)).toBe("出站右转 · 步行约 6 分钟");
    expect(legLine({ ...leg, mode: "taxi", summary: null }, null)).toBe("坐出租车约 6 分钟");
    expect(legLine(leg, "他写的")).toBe("他写的");
    expect(legLine(null, null)).toBeNull();
  });
  it("准备清单按四类分组,空类不出", () => {
    const g = prepGroups([{ section: "bring", text: "伞", detail: null, derived: false }, { section: "book", text: "票", detail: null, derived: false }]);
    expect(g.map((x) => x.key)).toEqual(["book", "bring"]);
  });
  it("那一句话按逗号拆", () => {
    expect(quoteParts("“Same story, a different ending with you.”")).toEqual(["Same story", "a different ending with you."]);
    expect(quoteParts(null)).toEqual([]);
  });
});

describe("准备清单勾选键", () => {
  it("引擎给了 key 就用", () => {
    expect(prepMarkKey({ key: "p:bring:伞", section: "bring", text: "伞", detail: null, derived: false })).toBe("prep:p:bring:伞");
  });
  it("没给 key 时与引擎 date_her.prep_key 同算法(sha1(section|text) 前 12 位)", () => {
    // 引擎:hashlib.sha1("bring|一件薄外套".encode()).hexdigest()[:12] == "2e17b1364860"(python 实算)
    expect(prepMarkKey({ section: "bring", text: "一件薄外套", detail: null, derived: false })).toBe("prep:bring:2e17b1364860");
  });
  it("首页小纸包:天气不算;没拉到记号=全没勾", () => {
    const prep = [{ key: "p:bring:伞", section: "bring" as const, text: "伞", detail: null, derived: false },
      { section: "wear" as const, text: "薄外套", detail: null, derived: false }, { section: "weather" as const, text: "晴", detail: null, derived: false }];
    expect(prepLeft(prep, null)).toEqual({ total: 2, left: 2 });
    expect(prepLeft(prep, { marks: { "prep:p:bring:伞": { at: 1, value: true } } })).toEqual({ total: 2, left: 1 });
    expect(prepLeft([], null)).toEqual({ total: 0, left: 0 });
  });
});

describe("烫金反光", () => {
  it("读到倾斜:按角度,夹在 ±30", () => {
    expect(glintFrom(true, Math.PI / 18, 0)).toBeCloseTo(10);
    expect(glintFrom(true, Math.PI / 2, 0)).toBe(30);
    expect(glintFrom(true, -Math.PI / 2, 0)).toBe(-30);
  });
  it("读不到(模拟器/没有陀螺仪):慢晃 ±18", () => {
    expect(glintFrom(false, 0.5, Math.PI / 2)).toBeCloseTo(18);
    expect(glintFrom(true, 0, Math.PI * 1.5)).toBeCloseTo(-18);
  });
});

describe("地图三态", () => {
  it("可见=地点已公开;下一站=第一个还没到的;结束后没有下一站", () => {
    const p = plan({ status: "live", stops: [stop({ arrive_at: 100, place: {} as Stop["place"] }), stop({ stop_id: 2, arrive_at: 200 }), stop({ stop_id: 3, arrive_at: 300 })] });
    expect(mapState(p, 150)).toEqual({ vis: [true, false, false], arrived: [true, false, false], next: 1, here: 0, over: false, noDay: p.sent_at == null });
    expect(mapState({ ...p, status: "done" }, 400).next).toBe(-1);
  });
});

describe("配色", () => {
  it("约会颜色未知时退回 rose;拉丁字体里遇到中文/日元换思源宋", () => {
    expect(planCol("nope")).toEqual(planCol("rose"));
    expect(ff("No. 1028", "L", "C")).toBe("L");
    expect(ff("河畔", "L", "C")).toBe("C");
    expect(ff("¥160", "L", "C")).toBe("C");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

