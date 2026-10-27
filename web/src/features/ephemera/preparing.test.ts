// 准备中纯逻辑单测:缺项文字、上次动笔、进度行。
jest.mock("../../lib/storage", () => ({ storage: { getBase: jest.fn(), getToken: jest.fn() } }));
jest.mock("../../fonts", () => ({ F: new Proxy({}, { get: (_t, k) => String(k) }) }));
import type { Preparing } from "../../lib/ephemeraApi";
import { dayWord, daysLeft, draftRows, missingLine, touched } from "./format";

const v = (o: Partial<Preparing> = {}): Preparing => ({
  id: 9, date: "2026-10-26", last_edited_at: null, stops: { count: 3, complete: 2 }, legs: 1, prep: 0,
  contract: true, card: false, art: { drawn: 0, planned: 2 }, missing: [], conflicts: 0, ready: false, notes: [], ...o,
});

describe("准备中", () => {
  it("缺项只说类别和数目", () => {
    expect(missingLine(v({ missing: [{ what: "stop_title", count: 1 }, { what: "stop_clue", count: 2 }, { what: "prep", count: 1 }], conflicts: 1 })))
      .toBe("1 个地点名 · 2 条线索 · 准备清单 · 1 处时间要改");
    expect(missingLine(v({ missing: [{ what: "stops", count: 1 }] }))).toBe("站");
    expect(missingLine(v())).toBe("");
  });
  it("上次动笔按手机日历日", () => {
    const now = new Date(2026, 9, 21, 12, 0).getTime();
    expect(touched(null, now)).toBe("—");
    expect(touched(new Date(2026, 9, 21, 0, 5).getTime() / 1000, now)).toBe("TODAY");
    expect(touched(new Date(2026, 9, 20, 23, 50).getTime() / 1000, now)).toBe("YESTERDAY");
    expect(touched(new Date(2026, 9, 19, 22, 40).getTime() / 1000, now)).toBe("2 DAYS AGO");
  });
  it("进度行:没写=—,布尔=勾", () => {
    const r = Object.fromEntries(draftRows(v()));
    expect(r["Stops"]).toBe("3 站 · 1 站没写完");
    expect(r["Routes"]).toBe("1 段");
    expect(r["Packing list"]).toBe("—");
    expect(r["Contract"]).toBe(true);
    expect(r["Little card"]).toBe(false);
    expect(r["Sketches"]).toBe("0 / 2");
    expect(Object.fromEntries(draftRows(v({ stops: { count: 0, complete: 0 }, art: { drawn: 0, planned: 0 } })))["Stops"]).toBe("—");
  });
});


describe("约会海报 · 花体倒计时", () => {
  it("还剩几天按日历日,过了算 0", () => {
    expect(daysLeft("2026-10-26", new Date(2026, 9, 21, 23, 59))).toBe(5);
    expect(daysLeft("2026-10-26", new Date(2026, 9, 26, 0, 1))).toBe(0);
    expect(daysLeft("2026-10-26", new Date(2026, 9, 28))).toBe(0);
  });
  it("二十天以内写英文词,再远写数字", () => {
    expect(dayWord(5)).toBe("five");
    expect(dayWord(0)).toBe("today");
    expect(dayWord(20)).toBe("twenty");
    expect(dayWord(31)).toBe("31");
  });
});
