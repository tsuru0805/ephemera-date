// 飞行层的路线与交叉淡变(纯函数,UI 线程 worklet;单测钉)。手感照原型 motion.js 第一版 flyPair。
/** 窗口坐标(px)里的一块:中心、宽高、转角 */
export type Box = { cx: number; cy: number; w: number; h: number; rot: number };

/** 起点→终点的路线:中点抬起 lift(px)、途中稍放大(原型 flyPair 的 mid)。纯函数,单测钉 */
export function flightAt(a: Box, b: Box, t: number, lift: number): Box {
  "worklet";
  const u = 1 - t;
  const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2 - lift;
  const grow = lift ? 1 + 0.05 * 4 * t * u : 1;
  return {
    cx: u * u * a.cx + 2 * u * t * mx + t * t * b.cx,
    cy: u * u * a.cy + 2 * u * t * my + t * t * b.cy,
    w: (a.w + (b.w - a.w) * t) * grow,
    h: (a.h + (b.h - a.h) * t) * grow,
    rot: a.rot + (b.rot - a.rot) * t,
  };
}
/**
 * 交叉淡变:起点那帧 0.04→0.3 淡出,目标那帧 0.06→0.3 淡入。
 * 早换:起点那帧是小东西截的,飞大了是拉伸的糊位图;目标那帧按落点原尺寸截、缩着飞=一直清楚——
 * 早点换成目标那帧,糊的时间就短到看不出来(她 10-26「卡片弹跳时文字糊很久才清晰」)。原型 flyPair 是 0.2→0.55。
 */
export function fadeOut(t: number): number {
  "worklet";
  return t <= 0.04 ? 1 : t >= 0.3 ? 0 : 1 - (t - 0.04) / 0.26;
}
export function fadeIn(t: number): number {
  "worklet";
  return t <= 0.06 ? 0 : t >= 0.3 ? 1 : (t - 0.06) / 0.24;
}


/**
 * 变小的飞行(大→小,例如看照片放回原位):起点那帧是按大尺寸截的、缩着飞一直清楚;目标那帧是小东西截的、
 * 开头被放大=糊——所以晚换:起点那帧留到 0.72,目标那帧 0.7→0.92 才淡入(codex 回执:统一早换会让这类更糊)。
 */
export function fadeOutLate(t: number): number {
  "worklet";
  return t <= 0.72 ? 1 : t >= 0.95 ? 0 : 1 - (t - 0.72) / 0.23;
}
export function fadeInLate(t: number): number {
  "worklet";
  return t <= 0.7 ? 0 : t >= 0.92 ? 1 : (t - 0.7) / 0.22;
}
/** 这一程是变大(按面积):变大早换、变小晚换 */
export function growing(a: { w: number; h: number }, b: { w: number; h: number }): boolean {
  "worklet";
  return b.w * b.h >= a.w * a.h;
}

/** The ghost's box on the screen (centre, size, turn) as a clip-path polygon in the texture layer's coordinates. Pure, tested. */
export function ghostClip(q: { cx: number; cy: number; w: number; h: number; rot: number }, tex: { x: number; y: number }): string {
  const r = (q.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), hw = q.w / 2, hh = q.h / 2;
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => `${(q.cx + x * c - y * s - tex.x).toFixed(1)}px ${(q.cy + x * s + y * c - tex.y).toFixed(1)}px`);
  return `polygon(${pts.join(", ")})`;
}
