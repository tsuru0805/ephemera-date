// 飞行层的路线与交叉淡变(纯函数)+ 带 m=1 的跳页只淡入
import { ephemeraStackOptions } from "../../nav/stackOptions";
import { type Box, fadeIn, fadeInLate, fadeOut, fadeOutLate, flightAt, ghostClip, growing } from "./flightMath";
import { registerStageTex, stageTexNow, underStageTex } from "./stageTex";

const A: Box = { cx: 100, cy: 600, w: 102, h: 184, rot: 0 };
const B: Box = { cx: 195, cy: 390, w: 390, h: 780, rot: -3 };

describe("flightAt", () => {
  it("两端精确落在起点/终点", () => {
    expect(flightAt(A, B, 0, 30)).toEqual(A);
    const end = flightAt(A, B, 1, 30);
    expect(end.cx).toBeCloseTo(B.cx); expect(end.cy).toBeCloseTo(B.cy);
    expect(end.w).toBeCloseTo(B.w); expect(end.h).toBeCloseTo(B.h); expect(end.rot).toBeCloseTo(B.rot);
  });
  it("中途抬起、稍放大(原型 mid:抬 lift、×1.05)", () => {
    const m = flightAt(A, B, 0.5, 40);
    expect(m.cy).toBeCloseTo((A.cy + B.cy) / 2 - 20);   // 二次贝塞尔中点=控制点抬高量的一半
    expect(m.w).toBeCloseTo(((A.w + B.w) / 2) * 1.05);
    const flat = flightAt(A, B, 0.5, 0);
    expect(flat.w).toBeCloseTo((A.w + B.w) / 2);
  });
});

describe("交叉淡变时段", () => {
  it("早换(她 10-26 字糊太久):起点那帧 0.04 前全在、0.3 后全无;目标那帧 0.06 前没有、0.3 后全在", () => {
    expect(fadeOut(0.02)).toBe(1); expect(fadeOut(0.31)).toBe(0); expect(fadeOut(0.17)).toBeCloseTo(0.5);
    expect(fadeIn(0.05)).toBe(0); expect(fadeIn(0.31)).toBe(1); expect(fadeIn(0.18)).toBeCloseTo(0.5);
  });
});

describe("ephemeraStackOptions", () => {
  it("m=1 = 有东西飞过来,整页只淡入;平常照旧从下往上", () => {
    expect(ephemeraStackOptions("ephemera-box", { id: "3", m: "1" })).toEqual({ animation: "fade", animationDuration: 380 });
    expect(ephemeraStackOptions("ephemera-box", { id: "3" })).toEqual({ animation: "fade_from_bottom", animationDuration: 420 });
    expect(ephemeraStackOptions("chat", { m: "1" })).toBeNull();
  });
});

// 小卡上一串 \n(他把换行写成了字面反斜杠 n)——读到的文字一律转真换行
import { realNewlines } from "../../lib/realNewlines";
describe("realNewlines", () => {
  it("字面 \\n / \\r\\n 转真换行;嵌套对象数组都转;别的不动", () => {
    expect(realNewlines("灰粉色的秘密\\n\\n要打开")).toBe("灰粉色的秘密\n\n要打开");
    expect(realNewlines({ plans: [{ card_text: "a\\r\\nb", id: 3, ok: true, x: null }] })).toEqual({ plans: [{ card_text: "a\nb", id: 3, ok: true, x: null }] });
    expect(realNewlines("真换行\n不动")).toBe("真换行\n不动");
  });
});

describe("按方向挑交叉淡变(变大早换、变小晚换)", () => {
  it("变大=目标那帧更大更清楚,早换;变小=起点那帧更清楚,留到 0.72 才换", () => {
    expect(growing({ w: 100, h: 180 }, { w: 400, h: 800 })).toBe(true);
    expect(growing({ w: 280, h: 340 }, { w: 150, h: 180 })).toBe(false);
    expect(fadeOutLate(0.7)).toBe(1); expect(fadeOutLate(0.96)).toBe(0);
    expect(fadeInLate(0.69)).toBe(0); expect(fadeInLate(0.93)).toBe(1);
  });
});

describe("the page texture over a piece in flight", () => {
  it("ghostClip: the ghost's turned box, in the texture layer's coordinates", () => {
    expect(ghostClip({ cx: 100, cy: 200, w: 40, h: 20, rot: 0 }, { x: 0, y: 0 })).toBe("polygon(80.0px 190.0px, 120.0px 190.0px, 120.0px 210.0px, 80.0px 210.0px)");
    expect(ghostClip({ cx: 100, cy: 200, w: 40, h: 20, rot: 0 }, { x: 10, y: 50 })).toBe("polygon(70.0px 140.0px, 110.0px 140.0px, 110.0px 160.0px, 70.0px 160.0px)");
    // a quarter turn: width and height swap places
    expect(ghostClip({ cx: 0, cy: 0, w: 40, h: 20, rot: 90 }, { x: 0, y: 0 })).toBe("polygon(10.0px -20.0px, 10.0px 20.0px, -10.0px 20.0px, -10.0px -20.0px)");
  });
  it("the texture's place: the latest page still on screen; a piece in a pop is not under it", () => {
    const el = (connected: boolean, r: { left: number; top: number; width: number; height: number }) =>
      ({ isConnected: connected, getBoundingClientRect: () => r }) as unknown as HTMLElement;
    expect(stageTexNow()).toBeNull();
    const off1 = registerStageTex(el(true, { left: 0, top: 0, width: 390, height: 844 }), "90,60,70");
    const off2 = registerStageTex(el(false, { left: 0, top: 0, width: 390, height: 844 }), "1,2,3");   // gone from the page
    expect(stageTexNow()).toEqual({ x: 0, y: 0, w: 390, h: 844, sh: "90,60,70" });
    off1(); off2();
    expect(stageTexNow()).toBeNull();
    const inStage = { closest: (q: string) => (q.includes("stage-content") ? {} : null) } as unknown as HTMLElement;
    const inPop = { closest: () => null } as unknown as HTMLElement;
    expect(underStageTex(inStage)).toBe(true);
    expect(underStageTex(inPop)).toBe(false);
    expect(underStageTex(null)).toBe(false);
  });
});
