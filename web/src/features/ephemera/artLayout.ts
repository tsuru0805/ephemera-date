// 固定画放进小格子时怎么取景(纯函数,有单测)。
// 旧 8 类(sc_station 等)不在表里 = 在调用方给的框里等比铺满(ART_FOCUS_BOXED, 起不再拉伸)。
// 新大类:按「主体在哪」(焦点 fx/fy,0–1,按 300×450 原图量)等比铺满格子(cover),焦点落在格子中心,越界就贴边;
// z = 再放大几倍(格子很小时让主体认得出)。
// 一件事的五张小事:白底中间一个小物件,不裁,整张等比缩进格子(contain),四周留白。
import type { ArtName } from "./components";

export const ART_W = 300, ART_H = 450;
export type ArtFocus = { fx: number; fy: number; z?: number };
export type ArtLayout = ArtFocus | "contain";

/** 焦点逐张看原图定的(style-refs 1024×1536,与 300×450 同比例) */
export const ART_LAYOUT: Partial<Record<ArtName, ArtLayout>> = {
  sc_sweets: { fx: 0.63, fy: 0.62 },      // 甜品店橱窗(蛋糕架 + 面包)
  sc_bar: { fx: 0.4, fy: 0.55 },          // 吧台 + 酒柜
  sc_live: { fx: 0.5, fy: 0.55 },         // 舞台中间的麦克风 + 吉他钢琴
  sc_exhibition: { fx: 0.51, fy: 0.46 },  // 长廊尽头的拱门、画和胸像
  sc_aquarium: { fx: 0.5, fy: 0.58 },     // 海底隧道
  sc_amusement: { fx: 0.5, fy: 0.34 },    // 摩天轮的轮心
  sc_play: { fx: 0.5, fy: 0.5 },          // 一排街机
  sc_park: { fx: 0.44, fy: 0.62 },        // 林荫小路 + 长椅
  sc_onsen: { fx: 0.47, fy: 0.56 },       // 冒热气的汤池
  sc_stay: { fx: 0.55, fy: 0.6 },         // 窗边的扶手椅和小圆桌
  sc_moment_flowers: "contain", sc_moment_cups: "contain", sc_moment_ticket: "contain",
  sc_moment_ribbon: "contain", sc_moment_star: "contain",
};

export type Rect = { left: number; top: number; width: number; height: number };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// 「小票上的图膨胀了」「这个图的比例绝对不对」。旧 8 类固定画与每站现画原先按调用方给的框拉伸摆放,
// 框多不是原图比例(连票小格 73×96、首页邮票 90×118、首页大票 226×190…)→ 画被横向/纵向拉变形。
// 改为:仍用调用方的框(位置大小、被外层格子裁的方式都不变),但画在框里等比铺满(cover)、按焦点取景,不再拉伸。
/** 旧 8 类固定画的焦点(逐张看原图定,同 ART_LAYOUT 的 fx/fy 量法) */
export const ART_FOCUS_BOXED: Partial<Record<ArtName, ArtFocus>> = {
  sc_station: { fx: 0.55, fy: 0.45 },  // 站房 + 挂钟
  sc_bistro: { fx: 0.5, fy: 0.52 },    // 桌上的锅与两只酒杯
  sc_cinema: { fx: 0.5, fy: 0.36 },    // 银幕
  sc_tonight: { fx: 0.5, fy: 0.45 },   // 河对岸的城(横图)
  sc_cafe: { fx: 0.5, fy: 0.55 },      // 遮阳篷 + 小圆桌
  sc_moon: { fx: 0.42, fy: 0.45 },     // 路灯 + 河
  sc_shop: { fx: 0.5, fy: 0.45 },      // 店面橱窗
  sc_shrine: { fx: 0.5, fy: 0.45 },    // 鸟居 + 拜殿
};
/** 不是 300×450 的原图(其余固定画与每站现画都是 2:3 竖图 300×450) */
export const ART_SIZE: Partial<Record<ArtName, { w: number; h: number }>> = { sc_tonight: { w: 520, h: 347 }, florals: { w: 300, h: 300 } };
/** 装饰小花不是场景:不裁(裁了会切掉枝梢),整张等比缩进框里居中 */
export const ART_CONTAIN_BOXED: ReadonlySet<ArtName> = new Set<ArtName>(["florals"]);
export const PAINTED_SIZE = { w: ART_W, h: ART_H };
export const CENTER: ArtFocus = { fx: 0.5, fy: 0.5 };

/** 原图 sw×sh 在 cw×ch 的框里等比铺满(cover),焦点尽量落在框中心,越界贴边;框与原图同比例时=整框原样 */
export function coverIn(cw: number, ch: number, sw: number, sh: number, f: ArtFocus = CENTER): Rect {
  const s = Math.max(cw / sw, ch / sh) * (f.z ?? 1);
  const width = sw * s, height = sh * s;
  return {
    left: clamp(cw / 2 - f.fx * width, cw - width, 0),
    top: clamp(ch / 2 - f.fy * height, ch - height, 0),
    width, height,
  };
}

/** 原图 sw×sh 整张等比缩进 cw×ch 的框,居中 */
export function containIn(cw: number, ch: number, sw: number, sh: number): Rect {
  const s = Math.min(cw / sw, ch / sh), width = sw * s, height = sh * s;
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height };
}

/** 在 cw×ch 的格子里,这张画摆在哪(相对格子左上角) */
export function artPlacement(layout: ArtLayout, cw: number, ch: number): Rect {
  if (layout === "contain") {
    const s = Math.min(cw / ART_W, ch / ART_H);
    const width = ART_W * s, height = ART_H * s;
    // 取整到像素,画和四周补的纸色之间不留亚像素缝
    const w = Math.round(width), h = Math.round(height);
    return { left: Math.round((cw - w) / 2), top: Math.round((ch - h) / 2), width: w, height: h };
  }
  return coverIn(cw, ch, ART_W, ART_H, layout);
}

/** 画摆好后格子里剩下的空白(上下左右最多四条),contain 的反相版用纸色补上。
 *  每条往画里多盖 BLEED 像素:缩放后画的最外一圈像素会和透明边混成半透明(实拍一圈淡方框线),盖住它 */
export const BLEED = 1;
/** contain 时画本身往外多画 OVERSCAN:缩放后画最外一圈会和透明边混成半透明,把这圈推到纸色/格子边外面去
 *  (左右由补的纸色盖住,上下贴格子边的由格子 overflow:hidden 裁掉) */
export const OVERSCAN = 2;
export const overscan = (r: Rect, d = OVERSCAN): Rect => ({ left: r.left - d, top: r.top - d, width: r.width + 2 * d, height: r.height + 2 * d });
export function marginRects(r: Rect, cw: number, ch: number): Rect[] {
  const out: Rect[] = [];
  if (r.top > 0) out.push({ left: 0, top: 0, width: cw, height: r.top + BLEED });
  if (r.top + r.height < ch) out.push({ left: 0, top: r.top + r.height - BLEED, width: cw, height: ch - r.top - r.height + BLEED });
  if (r.left > 0) out.push({ left: 0, top: r.top, width: r.left + BLEED, height: r.height });
  if (r.left + r.width < cw) out.push({ left: r.left + r.width - BLEED, top: r.top, width: cw - r.left - r.width + BLEED, height: r.height });
  return out;
}
