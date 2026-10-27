// 约会页面之间「同一样东西接着变」(邮票→盒盖、请柬→连票…)。
// Reanimated 4.1 没有跨页共享元素,这里自建:根布局最上层一块飞行层(FlightLayer)。
// 起点/终点各自包一层 <FlightSpot k=…>(量得到位置、截得到一帧);飞的时候:截起点一帧 → 藏两头真身 → 跳页 →
// 等目标那页登记上、截目标一帧 → 两帧在飞行层里同一路线交叉淡变(中途换成目标的样子)→ 落地真身现身。
// 网页上「一帧」是那个元素的拷贝(DOM 克隆,画布逐像素拷过去)。目标页第一帧就藏(藏的是外层,拷的是里层,拷得到)。
// 手感照原型第一版 flyPair/morphGo(缓动、交叉淡变时段、抬起量)。
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Dimensions, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, { Easing, makeMutable, type SharedValue, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";

import { type Box, fadeIn, fadeInLate, fadeOut, fadeOutLate, flightAt, ghostClip, growing } from "./flightMath";
import { PaintPiece } from "../../runtime/paintHold";
import { grainTile } from "../../runtime/grain";
import { STAGE_GRAIN_OPACITY, stageGrainStyle, stageLightCss, stageTexNow, underStageTex } from "./stageTex";

export type { Box };

type Spot = { ref: React.RefObject<View | null>; rot: number };
const spots = new Map<string, Spot>();
const hidden = new Map<string, SharedValue<number>>();
function hiddenOf(key: string): SharedValue<number> {
  let v = hidden.get(key);
  if (!v) {
    const m = makeMutable(0);
    v = m && typeof m === "object" ? m : ({ value: 0 } as SharedValue<number>);   // jest 的 reanimated 替身 makeMutable 原样返回数字
    hidden.set(key, v);
  }
  return v;
}

/**
 * 能飞的东西包这一层(替掉原来最外层那个绝对定位的 View;style 照原样传,动画 style 也行)。
 *  rot=它摆着的转角(°,跟原来 transform 里的 rotate 一致),量位置不带转角,飞行时照这个转。 */
export function FlightSpot({ k, rot = 0, style, bg, children, pointerEvents }: { k: string | null; rot?: number; style?: StyleProp<ViewStyle>; bg?: string; children?: React.ReactNode; pointerEvents?: "auto" | "none" | "box-none" | "box-only" }) {
  const ref = useRef<View>(null);
  const hv = hiddenOf(k ?? "_");
  const rotRef = useRef(rot);
  rotRef.current = rot;
  useEffect(() => {
    if (!k) return;
    const s: Spot = { ref, get rot() { return rotRef.current; } } as Spot;
    spots.set(k, s);
    return () => { if (spots.get(k) === s) spots.delete(k); };
  }, [k]);
  const hide = useAnimatedStyle(() => ({ opacity: hv.value ? 0 : 1 }));
  // 「藏」单独一层,不跟外面传进来的 style 共用一个 view(落点页自带的入场 opacity 会把它盖掉=飞行时看到两张;review)
  return (
    <Animated.View style={style} pointerEvents={pointerEvents}>
      <Animated.View style={[StyleSheet.absoluteFill, hide]} pointerEvents="box-none">
        {/* 底色放在最里层(PaintPiece 那层,与纸纹同层):纸纹用混合模式,隔着一层就只能跟透明混(发灰)。bg=原来外层的 backgroundColor */}
        <View ref={ref} collapsable={false} style={StyleSheet.absoluteFill} pointerEvents="box-none"><PaintPiece bg={bg}>{children}</PaintPiece></View>
      </Animated.View>
    </Animated.View>
  );
}

function measure(s: Spot): Promise<Box | null> {
  return new Promise((res) => {
    const v = s.ref.current;
    if (!v || typeof v.measureInWindow !== "function") return res(null);   // 量不到=不飞,照常跳页
    try { v.measureInWindow((x, y, w, h) => res(w > 0 && h > 0 ? { cx: x + w / 2, cy: y + h / 2, w, h, rot: s.rot } : null)); } catch { res(null); }
  });
}
// On the web a frame is a copy of the element itself (cloned DOM, canvases copied pixel for pixel), not a bitmap.
type SkImage = { el: HTMLElement; w: number; h: number };
async function shot(s: Spot): Promise<SkImage | null> {
  try {
    const node = s.ref.current as unknown as HTMLElement | null;
    if (!node || typeof node.cloneNode !== "function") return null;
    const r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const el = node.cloneNode(true) as HTMLElement;
    const from = node.querySelectorAll("canvas"), to = el.querySelectorAll("canvas");
    from.forEach((c, k) => {
      const t = to[k];
      if (!t || !c.width || !c.height) return;
      try { t.width = c.width; t.height = c.height; t.getContext("2d")?.drawImage(c, 0, 0); if (c.dataset.painted) t.dataset.painted = c.dataset.painted; } catch { /* tainted: leave blank */ }
    });
    el.style.position = "absolute"; el.style.left = "0px"; el.style.top = "0px";
    el.style.width = `${node.offsetWidth}px`; el.style.height = `${node.offsetHeight}px`;
    el.setAttribute("aria-hidden", "true");
    // a copy never takes a touch: copied Pressables carry pointer-events:auto of their own (it would take the taps meant
    // for the page under it while it flies); inert takes the whole copy out of hit testing
    (el as HTMLElement & { inert?: boolean }).inert = true;
    el.querySelectorAll<HTMLElement>("*").forEach((c) => { c.style.pointerEvents = "none"; });
    el.style.pointerEvents = "none";
    return { el, w: node.offsetWidth, h: node.offsetHeight };
  } catch { return null; }
}
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** Is everything in this piece drawn (its canvases have a frame, its pictures are in)? Pure over the DOM, tested. */
export function pieceDrawn(node: HTMLElement): boolean {
  if (node.querySelector("[data-paint-held]")) return false;     // a piece still holding itself back (paintHold.tsx)
  const cs = Array.from(node.querySelectorAll("canvas"));
  if (cs.some((c) => c.dataset.painted !== "1")) return false;
  return Array.from(node.querySelectorAll("img")).every((i) => i.complete);
}
/** Wait (at most ms) until the landing piece is drawn before copying it: a copy taken earlier is its texture over
 *  empty canvases (the grey card seen for a moment after breaking the seal). */
async function whenDrawn(s: Spot, ms: number): Promise<void> {
  const node = s.ref.current as unknown as HTMLElement | null;
  if (!node || typeof node.querySelectorAll !== "function") return;
  const t0 = Date.now();
  while (!pieceDrawn(node) && Date.now() - t0 < ms) await frame();
}
async function waitSpot(key: string, ms: number): Promise<{ s: Spot; b: Box } | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = spots.get(key);
    if (s) { const b = await measure(s); if (b) { await frame(); return { s, b: (await measure(s)) ?? b }; } }
    await frame();
  }
  return null;
}

/** tex: the page texture's box on the screen when the flight began (null: none); ta / tb: the piece at the start / at
 *  the landing lies under it (in the page, not in a pop) — then its ghost is drawn over with the same texture */
type Tex = { x: number; y: number; w: number; h: number; sh: string };
type Flight = { id: number; a: Box; ia: SkImage; b?: Box; ib?: SkImage | null; lift: number; dur: number; delay?: number; pre?: { dy: number; ms: number }; gone?: boolean; done: () => void;
  tex?: Tex | null; ta?: boolean; tb?: boolean };
let push: ((f: Flight) => void) | null = null;
let land: ((id: number, b: Box, ib: SkImage | null, tb: boolean) => void) | null = null;
let drop: ((id: number) => void) | null = null;
let seq = 0;
let busy = false;
export const flightBusy = () => busy;

/**
 * 从 from 飞到 to。go()=跳页(href 带 m=1,整页只淡入)。目标 900ms 内没出现/截不到 = 起点那帧就地淡掉,跳页照常。
 *  pre:起飞前先往上抽出一截(书脊,dy 为舞台单位,负=往上)。 */
export async function fly(from: string, to: string, go: () => void, o: FlyOpts = {}): Promise<void> {
  return flyMany([{ from, to }], go, o);
}

/** back=返回类(落点在导航栈里被盖住的那一页,不在 window 里,截出来是透明的):不截落点,起点那张一路飞到落点上,落地真身接上 */
type FlyOpts = { dur?: number; lift?: number; pre?: { dy: number; ms: number }; stagger?: number; settle?: number; back?: boolean };
/** 一个起点按需改量到的框(比如那一叠照片散开到一半:量到的是没散开的位置,散开的位移/转角在这里补上) */
export type FlyPair = { from: string; to: string; adjust?: (b: Box) => Box };

/**
 * 几样东西一起飞(那一叠照片→照片页各自的位置)。settle=go() 之后等多久再量终点(同页翻页要等翻完,ms)。
 *  任何一样量不到起点 = 全都不飞,照常 go()。 */
export async function flyMany(pairs: FlyPair[], go: () => void, o: FlyOpts = {}): Promise<void> {
  if (busy) return;                              // 飞着/正在截帧时再点=不理(连点不会叠两层页;review)
  const safeGo = () => { try { go(); } catch (e) { console.warn("[Flight] 跳页出错", e); } };
  const ss = pairs.map((p) => spots.get(p.from));
  if (!push || !pairs.length || ss.some((s) => !s)) { safeGo(); return; }
  busy = true;                                   // 同步就锁上(截帧要 await,这段窗口里第二下点击也得挡住)
  const as: Box[] = [], ias: SkImage[] = [], tas: boolean[] = [];
  const tex = stageTexNow();
  for (let k = 0; k < pairs.length; k++) {
    const m = await measure(ss[k]!);
    const im = m ? await shot(ss[k]!) : null;
    if (!m || !im) { busy = false; safeGo(); return; }
    as.push(pairs[k].adjust ? pairs[k].adjust!(m) : m); ias.push(im);
    tas.push(underStageTex(ss[k]!.ref.current as unknown as HTMLElement | null));
  }
  const hs = pairs.flatMap((p) => [hiddenOf(p.from), hiddenOf(p.to)]);
  for (const h of hs) h.value = 1;               // 两头真身都藏(目标页第一帧就藏,先于 go())
  try {
    await Promise.all(pairs.map((p, k) => new Promise<void>((resolve) => {
      const id = ++seq;
      // 没给 pre 也先轻轻拿起来一点:等目标那页截帧的这一两百毫秒里,手上的东西不是僵着的
      push?.({ id, a: as[k], ia: ias[k], lift: o.lift ?? 0, dur: o.dur ?? 760, pre: o.pre ?? { dy: -8, ms: 180 }, delay: (o.stagger ?? 0) * k, done: resolve, tex, ta: tas[k] });
      const after = async () => {
        if (o.settle) await new Promise((r) => setTimeout(r, o.settle));
        const hit = await waitSpot(p.to, 900);
        if (hit && !o.back) { await whenDrawn(hit.s, 900); await frame(); await frame(); }   // drawn, and two frames more (as the home app)
        const ib = hit && !o.back ? await shot(hit.s) : null;
        if (hit) land?.(id, hit.b, ib, underStageTex(hit.s.ref.current as unknown as HTMLElement | null));
        else drop?.(id);
      };
      if (k === 0) { safeGo(); }
      after();
    })));
  } finally {
    for (const h of hs) h.value = 0;
    busy = false;
  }
}

function Shot({ img, w, h }: { img: SkImage; w: number; h: number }) {
  // the copy keeps its own layout size (unscaled, as laid out on the page) and is scaled to the box it flies in
  const ref = useRef<View>(null);
  useEffect(() => {
    const host = ref.current as unknown as HTMLElement | null;
    if (!host) return undefined;
    const el = img.el;
    el.style.transformOrigin = "0 0";
    el.style.transform = `scale(${img.w ? w / img.w : 1}, ${img.h ? h / img.h : 1})`;
    host.appendChild(el);
    return () => { el.remove(); };
  }, [img, w, h]);
  return <View ref={ref} style={{ width: w, height: h, overflow: "visible" }} pointerEvents="none" />;
}

function FlightItem({ f, finish }: { f: Flight; finish: () => void }) {
  const t = useSharedValue(0);
  const pre = useSharedValue(0);
  const born = useRef(Date.now());
  const preMs = f.pre?.ms ?? 0;
  const preDy = (f.pre?.dy ?? 0) * (Dimensions.get("window").width / 390);   // 舞台单位(390 宽)→窗口 px
  const fo = useSharedValue(1);
  useEffect(() => { if (preMs) pre.value = withTiming(1, { duration: preMs, easing: Easing.bezier(0.3, 0, 0.2, 1) }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!f.b) return;
    const wait = Math.max(0, preMs - (Date.now() - born.current)) + (f.delay ?? 0);
    t.value = withDelay(wait, withTiming(1, { duration: f.dur, easing: Easing.bezier(0.3, 0.72, 0.1, 1) }));
    const h = setTimeout(finish, wait + f.dur + 30);
    return () => clearTimeout(h);
  }, [f.b]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!f.gone) return;
    fo.value = withTiming(0, { duration: 260 });
    const h = setTimeout(finish, 300);
    return () => clearTimeout(h);
  }, [f.gone]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = f.a, b = f.b ?? f.a, has = !!f.b, hasB = !!f.ib, lift = f.lift;   // 别把 SkImage 抓进 worklet
  const grow = growing(a, b);   // 变大早换、变小晚换(两头哪一帧清楚就多留哪一帧)
  const sa = useAnimatedStyle(() => {
    const a2 = { ...a, cy: a.cy + preDy * pre.value };
    const q = has ? flightAt(a2, b, t.value, lift) : a2;
    return {
      position: "absolute", left: q.cx - a.w / 2, top: q.cy - a.h / 2, width: a.w, height: a.h,
      opacity: fo.value * (has && hasB ? (grow ? fadeOut(t.value) : fadeOutLate(t.value)) : 1),
      transform: [{ rotate: `${q.rot}deg` }, { scaleX: q.w / a.w }, { scaleY: q.h / a.h }],
    };
  });
  const sb = useAnimatedStyle(() => {
    const a2 = { ...a, cy: a.cy + preDy * pre.value };
    const q = flightAt(a2, b, t.value, lift);
    return {
      position: "absolute", left: q.cx - b.w / 2, top: q.cy - b.h / 2, width: b.w, height: b.h, opacity: grow ? fadeIn(t.value) : fadeInLate(t.value),
      transform: [{ rotate: `${q.rot}deg` }, { scaleX: q.w / b.w }, { scaleY: q.h / b.h }],
    };
  });
  // the page texture over the ghosts, where they are: a full-screen copy of the page's grain and light at the page's
  // place, clipped to the ghost's box frame by frame, as opaque as the ghosts that are under a page's texture
  const grain = useRef<View>(null), light = useRef<View>(null);
  const tex = f.tex, tile = grainTile();
  useEffect(() => {
    if (!tex || typeof requestAnimationFrame !== "function") return undefined;
    const g = grain.current as unknown as HTMLElement | null, l = light.current as unknown as HTMLElement | null;
    let raf = 0;
    const step = () => {
      const a2 = { ...a, cy: a.cy + preDy * pre.value };
      const q = has ? flightAt(a2, b, t.value, lift) : a2;
      const opA = has && hasB ? (grow ? fadeOut(t.value) : fadeOutLate(t.value)) : 1;
      const opB = has && hasB ? (grow ? fadeIn(t.value) : fadeInLate(t.value)) : 0;
      const cover = fo.value * Math.min(1, (f.ta ? opA : 0) + (f.tb ? opB : 0));
      const clip = ghostClip(q, tex);
      if (g) { g.style.clipPath = clip; g.style.opacity = String(cover * STAGE_GRAIN_OPACITY_FLIGHT); }
      if (l) { l.style.clipPath = clip; l.style.opacity = String(cover); }
      raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [tex, f.ta, f.tb, has, hasB]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Animated.View testID="flight-from" style={sa}><Shot img={f.ia} w={a.w} h={a.h} /></Animated.View>
      {f.b && f.ib ? <Animated.View testID="flight-to" style={sb}><Shot img={f.ib} w={b.w} h={b.h} /></Animated.View> : null}
      {tex && (f.ta || f.tb) ? (
        <>
          {tile ? <View ref={grain} testID="flight-grain" pointerEvents="none" style={[{ position: "absolute", left: tex.x, top: tex.y, width: tex.w, height: tex.h }, stageGrainStyle(tile, 0) as ViewStyle]} /> : null}
          <View ref={light} testID="flight-light" pointerEvents="none" style={[{ position: "absolute", left: tex.x, top: tex.y, width: tex.w, height: tex.h, opacity: 0, mixBlendMode: "soft-light", backgroundImage: stageLightCss(tex.w, tex.h, tex.sh) } as ViewStyle]} />
        </>
      ) : null}
    </>
  );
}

const STAGE_GRAIN_OPACITY_FLIGHT = STAGE_GRAIN_OPACITY;

/** 挂在根布局最上层(Stack 之后);不挡手势 */
export function FlightLayer() {
  const [items, setItems] = useState<Flight[]>([]);
  useEffect(() => {
    push = (f) => setItems((x) => [...x, f]);
    land = (id, b, ib, tb) => setItems((x) => x.map((f) => (f.id === id ? { ...f, b, ib, tb } : f)));
    drop = (id) => setItems((x) => x.map((f) => (f.id === id ? { ...f, gone: true } : f)));
    return () => { push = land = drop = null; };
  }, []);
  if (!items.length) return null;
  // zIndex auto: this layer is not a stacking context of its own, so the texture over the ghosts blends with what is
  // under them (ghost over page), not with a transparent layer (that turns a blend into a grey veil)
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: "auto" } as unknown as ViewStyle]} pointerEvents="none">
      {items.map((f) => <FlightItem key={f.id} f={f} finish={() => { f.done(); setItems((x) => x.filter((y) => y.id !== f.id)); }} />)}
    </View>
  );
}

/** 测试用:清登记(jest 各用例之间) */
export function __resetFlight() { spots.clear(); hidden.clear(); busy = false; }
