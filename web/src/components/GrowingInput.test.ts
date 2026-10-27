// 弹性输入框高度公式
import { PAD_V, growHeight, mirrorLines } from "./GrowingInput";

describe("growHeight", () => {
  it("空文本 → 不下发高度(有 minHeight 就用它)", () => {
    expect(growHeight("", 0, 160)).toBeUndefined();
    expect(growHeight("", 0, 160, 88)).toBe(88);
    expect(growHeight("x", 0, 160)).toBeUndefined(); // 镜像还没量到
  });
  it("文本高 + 上下 padding + 光标余量,封顶 maxHeight,抬到 minHeight", () => {
    expect(growHeight("x", 20, 160)).toBe(20 + PAD_V * 2 + 2);
    expect(growHeight("x", 20, 160, 88)).toBe(88);
    expect(growHeight("x", 500, 160)).toBe(160);
    expect(growHeight("x", 500, 260, 88)).toBe(260);
  });
});

describe("mirrorLines", () => {
  it("行数能覆盖 maxHeight(触顶后原生滚动接管):14pt 默认行高 21 → 260 需要 13+2 行", () => {
    expect(mirrorLines(260, 14)).toBe(Math.ceil(260 / 21) + 2);
    expect(mirrorLines(160, 14)).toBe(Math.ceil(160 / 21) + 2);
    expect(mirrorLines(260, 14, 20)).toBe(15);
  });
  it("不变式:镜像最多行 × 行高 ≥ maxHeight,对所有用到的档位成立", () => {
    // 按 PingFang 真实行高 ≈1.4 保守复算
    for (const max of [160, 220, 260]) {
      const lh = 14 * 1.4;
      expect(mirrorLines(max, 14) * lh).toBeGreaterThanOrEqual(max);
    }
  });
});
