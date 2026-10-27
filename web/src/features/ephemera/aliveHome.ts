// +D:拆信/放照片跟手手势 + 首页活着的纯函数(UI 线程 worklet 与 jest 共用,数值抄原型
//  sealView / openPhotoFlow / playable / tiltLoop,手感参数照抄不改)。

// ── C1 拆信封:按住往上拉跟手,够了 commit,不够松手合回 ────────────────────────────────────
/** dy=指尖位移(RN translationY,上拉为负);max=原型 300px 满程。超过满程按原型 .35 阻尼继续走,不是硬顶死。 */
export function sealDragProgress(dy: number, max = 300): number {
  "worklet";
  const v = -dy / max;
  if (v > 1) return 1 + (v - 1) * 0.35;
  return Math.max(0, Math.min(1, v));
}
/** 松手判定:拉够一半,或者甩得够快(原型 vy<-.5 px/ms = -500 px/s;RN velocityY 单位已是 px/s)。 */
export function sealShouldCommit(p: number, velocityY: number): boolean {
  "worklet";
  return p > 0.5 || velocityY < -500;
}
/** 进度拆成「封舌/火漆」的 f 和「信纸上提」的 l(原型 set(v) 的 f/l/over)。 */
export function sealSplit(p: number): { f: number; lift: number } {
  "worklet";
  const f = Math.max(0, Math.min(1, p / 0.42));
  const l = Math.max(0, Math.min(1, (p - 0.28) / 0.72));
  const over = Math.max(0, p - 1);
  return { f, lift: l + over * 0.5 };
}

// ── C2 放照片:拍立得按住往下推进卡套,推不够弹回(原型 slideIn 前的 drag) ───────────────────
/** my=指尖位移(往下为正);PH=拍立得高度。往上推一点点会被摩擦阻住(*0.2),往下顺着走但顶多到 .9 格高。 */
export function photoDragY(my: number, PH: number): number {
  "worklet";
  return my > 0 ? Math.min(PH * 0.9, my) : my * 0.2;
}
/** 松手判定:没挪动(算点一下)、推过 4 成、或甩得够快(原型 vy>.45 px/ms = 450 px/s)就算推进去了。 */
export function photoShouldSlideIn(moved: boolean, y: number, velocityY: number, PH: number): boolean {
  "worklet";
  return !moved || y > PH * 0.4 || velocityY > 450;
}

// ── D1 空首页那叠纸:拖、甩、自己慢慢归位(原型 playable) ─────────────────────────────────
/** 拖拽中纸片的转角随左右位移累积,夹在 ±28°(原型 playable.move)。 */
export function dragRotationStep(prevR: number, dx: number, lastDx: number, max = 28): number {
  "worklet";
  return Math.max(-max, Math.min(max, prevR + (dx - lastDx) * 0.12));
}
/** 每帧速度衰减;< .3px 判定停住,该归位了(原型 Math.hypot(ux,uy) > .3)。 */
export function flingDecay(v: number, friction: number): number {
  "worklet";
  return v * friction;
}
export function flingActive(ux: number, uy: number, threshold = 0.3): boolean {
  "worklet";
  return Math.hypot(ux, uy) > threshold;
}
/** 松手瞬间起始速度(原型 end 里 vx*16 这类换算;单位从 px/s 换成每帧 px)。 */
export function flingInitial(velocityPxPerSec: number, scale = 16 / 1000): number {
  "worklet";
  return velocityPxPerSec * scale;
}

// ── D3 手机倾斜:纸片按远近错开(原型 tiltLoop) ─────────────────────────────────────────
/** 28° 满程(与 glint.ts 同源单位);原始传感器读数(弧度)换算成 -1..1。 */
export const TILT_MAX_RAD = (28 * Math.PI) / 180;
export function tiltAxis(raw: number): number {
  "worklet";
  return Math.max(-1, Math.min(1, raw / TILT_MAX_RAD));
}
/** 平滑跟随(原型 tilt.x += (tilt.tx - tilt.x)*.08,每帧调一次)。 */
export function tiltEase(cur: number, target: number, k = 0.08): number {
  "worklet";
  return cur + (target - cur) * k;
}
/** 某张纸的位移 = 倾斜 * 远近深度(原型 DEPTH = [6,11,8,14,5,10])。 */
export const TILT_DEPTHS = [6, 11, 8, 14, 5, 10];
export function tiltOffset(x: number, y: number, depth: number): { x: number; y: number } {
  "worklet";
  return { x: x * depth, y: y * depth };
}

// ── D2 他在写:邮戳只演一次、墨水一行行写 ───────────────────────────────────────────────
/** 该不该在这次打开盖「他看过」的邮戳:seen_at 有值、且这次打开还没给它盖过。 */
export function shouldStampOnOpen(seenAt: number | null | undefined, alreadyStamped: boolean): boolean {
  return seenAt != null && !alreadyStamped;
}
/** 她写过的明信片压在最新那张下面,越早的压得越深(原型 184-d*14 / 318+d*3 / -4-d*5,d=从底往上数第几张)。 */
export function postcardStackOffset(depthFromTop: number): { left: number; top: number; rotateDeg: number } {
  const d = depthFromTop;
  return { left: 184 - d * 14, top: 318 + d * 3, rotateDeg: -4 - d * 5 };
}
/** 信纸那几行,打开时一行行写上去的延时(原型 500 + i*420)。 */
export function inkRowDelay(i: number, base = 500, step = 420): number {
  return base + i * step;
}
