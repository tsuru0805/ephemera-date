import {
  dragRotationStep, flingActive, flingDecay, flingInitial, inkRowDelay, photoDragY, photoShouldSlideIn,
  postcardStackOffset, sealDragProgress, sealShouldCommit, sealSplit, shouldStampOnOpen, tiltAxis, tiltEase, tiltOffset, TILT_MAX_RAD,
} from "./aliveHome";

describe("拆信封跟手(sealDragProgress/sealShouldCommit/sealSplit)", () => {
  it("往上拉 150px(满程 300)=一半进度", () => {
    expect(sealDragProgress(-150)).toBeCloseTo(0.5, 5);
  });
  it("往下推(dy>0)夹在 0,不会变负", () => {
    expect(sealDragProgress(40)).toBe(0);
  });
  it("拉过头(超过满程)按 .35 阻尼继续走,不是硬顶死在 1", () => {
    const p = sealDragProgress(-360); // v=1.2
    expect(p).toBeCloseTo(1 + 0.2 * 0.35, 5);
    expect(p).toBeGreaterThan(1);
  });
  it("拉够一半就该 commit", () => {
    expect(sealShouldCommit(0.51, 0)).toBe(true);
    expect(sealShouldCommit(0.5, 0)).toBe(false);
  });
  it("没拉够但甩得够快(<-500px/s 上甩)也该 commit", () => {
    expect(sealShouldCommit(0.3, -600)).toBe(true);
    expect(sealShouldCommit(0.3, -300)).toBe(false);
  });
  it("进度拆成封舌 f 和信纸上提 lift(原型 set(v) 分段)", () => {
    expect(sealSplit(0).f).toBe(0);
    expect(sealSplit(0.21).f).toBeCloseTo(0.5, 2); // .21/.42
    expect(sealSplit(0.42).f).toBe(1);
    expect(sealSplit(0.6).f).toBe(1); // f 在 .42 后封顶
    expect(sealSplit(0.28).lift).toBe(0); // l 起点
    expect(sealSplit(1).lift).toBeCloseTo(1, 5);
    const over = sealSplit(1.2); // 超程部分叠加到 lift 上(原型 over*.5)
    expect(over.lift).toBeCloseTo(1 + 0.2 * 0.5, 5);
  });
});

describe("放照片推进卡套(photoDragY/photoShouldSlideIn)", () => {
  const PH = 154;
  it("往下推顺着走,顶多到 .9 格高", () => {
    expect(photoDragY(80, PH)).toBe(80);
    expect(photoDragY(200, PH)).toBeCloseTo(PH * 0.9, 5);
  });
  it("往上推一点点被摩擦阻住(*0.2)", () => {
    expect(photoDragY(-50, PH)).toBeCloseTo(-10, 5);
  });
  it("没挪动(点一下)算推进去了", () => {
    expect(photoShouldSlideIn(false, 0, 0, PH)).toBe(true);
  });
  it("推过 4 成就算推进去了", () => {
    expect(photoShouldSlideIn(true, PH * 0.41, 0, PH)).toBe(true);
    expect(photoShouldSlideIn(true, PH * 0.39, 0, PH)).toBe(false);
  });
  it("甩得够快(>450px/s 往下)也算推进去了", () => {
    expect(photoShouldSlideIn(true, 10, 500, PH)).toBe(true);
    expect(photoShouldSlideIn(true, 10, 300, PH)).toBe(false);
  });
});

describe("首页那叠纸拖甩(dragRotationStep/flingDecay/flingActive/flingInitial)", () => {
  it("转角随左右位移累积,夹在 ±28°", () => {
    expect(dragRotationStep(0, 10, 0)).toBeCloseTo(1.2, 5);
    expect(dragRotationStep(27, 100, 0)).toBe(28);
    expect(dragRotationStep(-27, -100, 0)).toBe(-28);
  });
  it("速度每帧按摩擦衰减", () => {
    expect(flingDecay(10, 0.92)).toBeCloseTo(9.2, 5);
  });
  it("速度大于阈值=还在滑,小于=停住该归位", () => {
    expect(flingActive(0.3, 0.1)).toBe(true);
    expect(flingActive(0.05, 0.05)).toBe(false);
  });
  it("松手起始速度按 px/s 换算成每帧 px(16ms 一帧)", () => {
    expect(flingInitial(1000)).toBeCloseTo(16, 5);
  });
});

describe("手机倾斜(tiltAxis/tiltEase/tiltOffset)", () => {
  it("28°满程换算成 -1..1,超程夹死", () => {
    expect(tiltAxis(TILT_MAX_RAD)).toBeCloseTo(1, 5);
    expect(tiltAxis(TILT_MAX_RAD * 2)).toBe(1);
    expect(tiltAxis(-TILT_MAX_RAD)).toBeCloseTo(-1, 5);
  });
  it("平滑跟随:每次只走向目标的 8%", () => {
    expect(tiltEase(0, 1, 0.08)).toBeCloseTo(0.08, 5);
  });
  it("位移 = 倾斜 * 远近深度", () => {
    expect(tiltOffset(0.5, -0.5, 10)).toEqual({ x: 5, y: -5 });
  });
});

describe("他在写(shouldStampOnOpen/postcardStackOffset/inkRowDelay)", () => {
  it("seen_at 没值不盖章", () => {
    expect(shouldStampOnOpen(null, false)).toBe(false);
    expect(shouldStampOnOpen(undefined, false)).toBe(false);
  });
  it("seen_at 有值且这次打开没盖过才盖", () => {
    expect(shouldStampOnOpen(123, false)).toBe(true);
    expect(shouldStampOnOpen(123, true)).toBe(false);
  });
  it("明信片堆叠:越早的压得越深,越往左上、转得越多", () => {
    expect(postcardStackOffset(0)).toEqual({ left: 184, top: 318, rotateDeg: -4 });
    expect(postcardStackOffset(2)).toEqual({ left: 156, top: 324, rotateDeg: -14 });
  });
  it("信纸几行的书写延时按序递增", () => {
    expect(inkRowDelay(0)).toBe(500);
    expect(inkRowDelay(1)).toBe(920);
    expect(inkRowDelay(2)).toBe(1340);
  });
});
