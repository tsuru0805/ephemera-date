// 纪念盒动效:原型里的手感参数挪过来,只抽纯函数方便单测。
// 时长/缓动/阈值/位移量照抄原型数值,别自己改。
// 单位换算:原型 drag() 的 vx/vy 是 px/ms;RNGH onEnd 的 velocityX/velocityY 是 px/s——所有速度阈值在这里都已经
// ×1000 换算过,调用处直接传 RNGH 的 e.velocityY 即可,不用再换算一次。

// 下面这些纯函数会被 UI 线程 worklet(手势回调 / useAnimatedStyle / useAnimatedScrollHandler)直接调用,
// 跨文件调用需要显式 "worklet" 指令才能被 reanimated babel 插件一起编译进去;在 jest 里当普通函数跑,不受影响。
export function clamp(v: number, a = 0, b = 1): number {
  "worklet";
  return Math.max(a, Math.min(b, v));
}

// ── 盒盖(archView 的 lid):按住往上推跟手;推过阈值或甩得够快=揭开;没过=弹回 ──────────────
/** 原型:`if (-y > 170 || vy < -.5) open()`。y=累计 translateY(向上为负),vy 单位 px/ms。 */
export function lidOpenDecision(dy: number, velocityYPerSec: number): boolean {
  "worklet";
  return -dy > 170 || velocityYPerSec < -500;
}
/** 原型 setY:`dy < 0 ? dy : dy * .15`——往上随手指走,往下只给 15% 的阻尼感 */
export function lidDragY(dy: number): number {
  "worklet";
  return dy < 0 ? dy : dy * 0.15;
}

// ── 翻页纸片远近(archView 的 para()/DEP) ──────────────────────────────────────────
/** 原型 DEP 数组:六层循环深度,数值越大跟得越松(离手指越远、转得越多) */
export const PAGE_DEPTH = [0.1, 0.24, 0.16, 0.3, 0.12, 0.2] as const;
/** 原型 para():`off = (k*390 - sl)/390`,sl=scrollLeft。离当前页越远,|off| 越大(未做 1.1 截断,留给调用方按需裁) */
export function pageOffset(scrollX: number, pageIndex: number, pageW = 390): number {
  "worklet";
  return (pageIndex * pageW - scrollX) / pageW;
}
/** 原型:`m.px = off*390*d; m.pr = off*d*12` */
export function depthShift(off: number, depth: number, pageW = 390): { dx: number; rotateDeg: number } {
  "worklet";
  return { dx: off * pageW * depth, rotateDeg: off * depth * 12 };
}

// ── 路线页:往下划,路线画到哪站哪站才亮(archView 路线页 upd()) ───────────────────────────
export const RT_ROW = 214;
/** 原型:`drawn = clamp(st + 780*.62 - y0, 0, L)`;780=原型舞台可见高,这里用真实视口高 vh 代入 */
export function routeDrawn(scrollY: number, vh: number, y0: number, totalLen: number): number {
  "worklet";
  return clamp(scrollY + vh * 0.62 - y0, 0, totalLen);
}
/** 原型:`on = drawn >= i*RT_ROW - 2`——画到这一站,章才从 .3 缩放回 1 */
export function stampRevealed(drawn: number, rowIndex: number, rowH = RT_ROW): boolean {
  "worklet";
  return drawn >= rowIndex * rowH - 2;
}
/** 原型:`t = clamp((st + 780 - (top + i*RT_ROW) - 40)/230)`——卡套/文字从右边滑进来站好的进度 */
export function sleeveSlideT(scrollY: number, vh: number, top: number, rowIndex: number, rowH = RT_ROW): number {
  "worklet";
  return clamp((scrollY + vh - (top + rowIndex * rowH) - 40) / 230);
}
/** 原型 rtObj(卡套)的位移/转角/透明度:`ex=(1-t)*90, ey=(1-t)*34, er=(1-t)*16, op=.1+.9*t` */
export function sleeveSlideFrom(t: number): { dx: number; dy: number; rotateDeg: number; opacity: number } {
  "worklet";
  return { dx: (1 - t) * 90, dy: (1 - t) * 34, rotateDeg: (1 - t) * 16, opacity: 0.1 + 0.9 * t };
}
/** 原型 rtTxt(时间/地名文字块)的位移/透明度:`tx.translate = -(1-t)*20px 0; tx.opacity = t` */
export function textSlideFrom(t: number): { dx: number; opacity: number } {
  "worklet";
  return { dx: -(1 - t) * 20, opacity: t };
}

// ── 一叠照片:往上拨跟手散开,够了(或点)飞去照片页 ───────────────────────────────────────
/** 原型 fan() 的输入侧(stack 的 drag move):`v = -dy/170; v>1 ? 1+(v-1)*.3 : Math.max(-.08, v)` */
export function stackFanValue(dy: number): number {
  "worklet";
  const v = -dy / 170;
  return v > 1 ? 1 + (v - 1) * 0.3 : Math.max(-0.08, v);
}
/** 原型 V 表:三张散开的位移/转角系数,乘当前 fan 值 f 用 */
export const STACK_FAN_V: ReadonlyArray<readonly [number, number, number]> = [
  [86, -70, 15],
  [-84, -52, -13],
  [4, -110, 4],
];
/** 原型 stack 的 drag end:没动过(且没取消)=直接飞;f 过半或往上甩得够快=飞;否则弹回 */
export function stackShouldFly(moved: boolean, cancelled: boolean, fanValue: number, velocityYPerSec: number): boolean {
  "worklet";
  if (cancelled) return false;
  if (!moved) return true;
  return fanValue > 0.5 || velocityYPerSec < -450;
}

// ── 照片页 lightbox:点一张拿起放大,拖着走,拖远松手放回原位 ─────────────────────────────
/** 原型:`k = 1 - Math.min(.42, d/760)`——拖得越远,缩得越小(模拟放回去的透视) */
export function lightboxDragScale(dist: number): number {
  "worklet";
  return 1 - Math.min(0.42, dist / 760);
}
/** 原型:`rot = db.rot + dx/28` */
export function lightboxDragRotate(baseRotateDeg: number, dx: number): number {
  "worklet";
  return baseRotateDeg + dx / 28;
}
/** 原型 dim.opacity:`Math.max(.1, 1 - d/360)` */
export function lightboxDimOpacity(dist: number): number {
  "worklet";
  return Math.max(0.1, 1 - dist / 360);
}
/** 原型 close 判定:`!moved || d>110 || hypot(vx,vy)>.7` */
export function lightboxShouldClose(moved: boolean, dist: number, speedPerSec: number): boolean {
  "worklet";
  return !moved || dist > 110 || speedPerSec > 700;
}

// ── 钢笔尖:进编辑态外圈画出来,退出沉回去(toggleEdit) ────────────────────────────────────
/** 原型 slot 进场:`translate 0 34px→0 -5px(offset .7)→0 0, scale .86→1.02→1`——这里只取首尾给 withSpring 的落点,
 * 中间的回弹交给 withSpring 的物理 */
export const PEN_SLOT_IN_MS = 640;
export const PEN_SLOT_OUT_MS = 360;
export const PEN_RING_MS = 420;

// ── 请他补寄:盖邮戳,折好的小卡飞出去 ──────────────────────────────────────────────────
export const ASK_STAMP_MS = 360;
export const ASK_NOTE_FLY_MS = 1100;
