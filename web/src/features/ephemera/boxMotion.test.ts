// 纪念盒动效:纯函数单测(手感参数照抄原型 motion.js,这里只核算法不核动画本身)。
import {
  clamp, depthShift, lidDragY, lidOpenDecision, lightboxDimOpacity, lightboxDragRotate, lightboxDragScale, lightboxShouldClose,
  pageOffset, routeDrawn, sleeveSlideFrom, sleeveSlideT, stackFanValue, stackShouldFly, stampRevealed, textSlideFrom,
} from "./boxMotion";

describe("盒盖拖", () => {
  it("往上拖够 170 或甩得够快才算揭开", () => {
    expect(lidOpenDecision(-171, 0)).toBe(true);
    expect(lidOpenDecision(-169, 0)).toBe(false);
    expect(lidOpenDecision(-50, -600)).toBe(true); // 甩得快,没拖够也算
    expect(lidOpenDecision(-50, -100)).toBe(false);
  });
  it("往上随手指,往下只给 15% 阻尼", () => {
    expect(lidDragY(-80)).toBe(-80);
    expect(lidDragY(80)).toBeCloseTo(12);
  });
});

describe("翻页远近", () => {
  it("offset 随滚动位置线性变化,当前页为 0", () => {
    expect(pageOffset(390, 1)).toBe(0);
    expect(pageOffset(0, 1)).toBe(1);
    expect(pageOffset(780, 1)).toBe(-1);
  });
  it("深度越大,位移和转角越大", () => {
    const a = depthShift(1, 0.1); expect(a.dx).toBe(39); expect(a.rotateDeg).toBeCloseTo(1.2);
    const b = depthShift(1, 0.3); expect(b.dx).toBe(117); expect(b.rotateDeg).toBeCloseTo(3.6);
    expect(depthShift(0, 0.3)).toEqual({ dx: 0, rotateDeg: 0 });
  });
});

describe("路线页画路线", () => {
  it("画到的长度随滚动增加,不超过总长、不小于 0", () => {
    expect(routeDrawn(0, 780, 232, 1000)).toBeGreaterThan(0);
    expect(routeDrawn(-1000, 780, 232, 1000)).toBe(0);
    expect(routeDrawn(10000, 780, 232, 1000)).toBe(1000);
  });
  it("每站章要画到那一站才亮(drawn 刚好够 - 2 的容差)", () => {
    expect(stampRevealed(428, 2, 214)).toBe(true); // 2*214-2=426
    expect(stampRevealed(425, 2, 214)).toBe(false);
  });
  it("卡套滑入进度 0~1,滑够了位移/转角归零、透明度 1", () => {
    const t0 = sleeveSlideT(0, 780, 214, 5, 214);
    expect(t0).toBe(0);
    const t1 = sleeveSlideT(100000, 780, 214, 0, 214);
    expect(t1).toBe(1);
    expect(sleeveSlideFrom(1)).toEqual({ dx: 0, dy: 0, rotateDeg: 0, opacity: 1 });
    expect(sleeveSlideFrom(0)).toEqual({ dx: 90, dy: 34, rotateDeg: 16, opacity: 0.1 });
  });
  it("文字块只走位移+透明度(没有转角/纵向位移)", () => {
    expect(textSlideFrom(1).dx).toBeCloseTo(0);
    expect(textSlideFrom(1).opacity).toBe(1);
    expect(textSlideFrom(0)).toEqual({ dx: -20, opacity: 0 });
  });
});

describe("一叠照片散开/飞走", () => {
  it("往上拨值为正、小量反向有一点跟手(-.08 封底)", () => {
    expect(stackFanValue(-170)).toBe(1);
    expect(stackFanValue(0)).toBeCloseTo(0);
    expect(stackFanValue(20)).toBeCloseTo(-0.08); // -20/170≈-0.118,封到 -0.08
    expect(stackFanValue(1000)).toBe(-0.08);
  });
  it("没动过直接飞;取消不飞;过半或甩得快飞,否则弹回", () => {
    expect(stackShouldFly(false, false, 0, 0)).toBe(true);
    expect(stackShouldFly(false, true, 0, 0)).toBe(false);
    expect(stackShouldFly(true, false, 0.6, 0)).toBe(true);
    expect(stackShouldFly(true, false, 0.1, -500)).toBe(true);
    expect(stackShouldFly(true, false, 0.1, 0)).toBe(false);
  });
});

describe("照片页 lightbox 拖放", () => {
  it("拖得越远缩得越小,但封底 .58", () => {
    expect(lightboxDragScale(0)).toBe(1);
    expect(lightboxDragScale(760)).toBeCloseTo(0.58);
    expect(lightboxDragScale(10000)).toBeCloseTo(0.58);
  });
  it("转角随横向位移走", () => {
    expect(lightboxDragRotate(-1.2, 28)).toBeCloseTo(-0.2);
  });
  it("暗幕透明度随距离下降,封底 .1", () => {
    expect(lightboxDimOpacity(0)).toBe(1);
    expect(lightboxDimOpacity(360)).toBe(0.1);
    expect(lightboxDimOpacity(1000)).toBe(0.1);
  });
  it("没动/拖远/甩得快=放手就收回原位", () => {
    expect(lightboxShouldClose(false, 0, 0)).toBe(true);
    expect(lightboxShouldClose(true, 111, 0)).toBe(true);
    expect(lightboxShouldClose(true, 50, 701)).toBe(true);
    expect(lightboxShouldClose(true, 50, 0)).toBe(false);
  });
});

it("clamp 夹在 [a,b]", () => {
  expect(clamp(-1)).toBe(0);
  expect(clamp(2)).toBe(1);
  expect(clamp(0.5)).toBe(0.5);
  expect(clamp(15, 0, 10)).toBe(10);
});
