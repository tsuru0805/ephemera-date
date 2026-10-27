// Ephemera 纸品基础件(原型「质感层」逐条落到 RN):
// ① 真纸纹(paper_tex 柔光叠在纸面上,按纸形裁)② 分层阴影 ③ 凹印字 ④ 烫金(渐变 + 随手机倾斜移动的反光)
// ⑤ 毛边 ⑥ 左上柔光 + 整页颗粒。纸面形状 + 纹理 + 阴影画在 Skia 里(同一块画布里混合才对);字仍用 RN Text。
import {
  Canvas, LinearGradient, Rect, vec,
} from "@shopify/react-native-skia";
import type { Href } from "../../nav/router";
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated as RNAnimated, Image, type ImageStyle, PixelRatio, Pressable, ScrollView, type StyleProp, StyleSheet, Text, type TextStyle, useWindowDimensions, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation, Easing, runOnJS, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useFrameCallback, useSharedValue, withRepeat, withTiming, type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDeviceRotation } from "../../runtime/tilt";
import { useLifecycle } from "../../runtime/host";
import { useRouter } from "../../nav/router";
import RNSvg, { Line as SvgLine, SvgXml } from "react-native-svg";
import { usePosterFonts } from "../../fonts";
import { tiltAxis, tiltEase, tiltOffset } from "./aliveHome";
import { ART_CONTAIN_BOXED, ART_FOCUS_BOXED, ART_LAYOUT, ART_SIZE, ART_H, ART_W, type ArtFocus, type ArtLayout, artPlacement, CENTER, containIn, coverIn, marginRects, overscan } from "./artLayout";
import { glintFrom } from "./glint";
import { FF, rgba, type Skin } from "./theme";
import { FlightSpot } from "./flight";
import { useIsFocused } from "@react-navigation/native";
import { PAINTED_EVENT, PaintHoldProvider, usePaintHold, usePaintScope } from "../../runtime/paintHold";
import { grainTile } from "../../runtime/grain";
import { registerStageTex, stageGrainStyle, stageLightCss } from "./stageTex";
import { useLayoutViewport } from "../../runtime/viewport";

export const PAPER_TEX = require("../../../assets/images/ephemera/paper_tex.jpg");
export const SEAL_BOW = require("../../../assets/images/ephemera/seal_bow.png");
export const CRINKLE = require("../../../assets/images/ephemera/crinkle.jpg");
// the foil numbers name their face by file (as on the phone); on the web the file only selects the family
export const PLAYFAIR_BLACK_FILE = 2;

export const ART = {
  sc_station_ink: require("../../../assets/images/ephemera/sc_station_ink.png"), sc_station_inv: require("../../../assets/images/ephemera/sc_station_inv.png"),
  sc_bistro_ink: require("../../../assets/images/ephemera/sc_bistro_ink.png"), sc_bistro_inv: require("../../../assets/images/ephemera/sc_bistro_inv.png"),
  sc_cinema_ink: require("../../../assets/images/ephemera/sc_cinema_ink.png"), sc_cinema_inv: require("../../../assets/images/ephemera/sc_cinema_inv.png"),
  sc_tonight_ink: require("../../../assets/images/ephemera/sc_tonight_ink.png"), sc_tonight_inv: require("../../../assets/images/ephemera/sc_tonight_inv.png"),
  sc_cafe_ink: require("../../../assets/images/ephemera/sc_cafe_ink.png"), sc_cafe_inv: require("../../../assets/images/ephemera/sc_cafe_inv.png"),
  sc_moon_ink: require("../../../assets/images/ephemera/sc_moon_ink.png"), sc_moon_inv: require("../../../assets/images/ephemera/sc_moon_inv.png"),
  sc_museum_ink: require("../../../assets/images/ephemera/sc_museum_ink.png"), sc_museum_inv: require("../../../assets/images/ephemera/sc_museum_inv.png"),
  sc_dessert_ink: require("../../../assets/images/ephemera/sc_dessert_ink.png"), sc_dessert_inv: require("../../../assets/images/ephemera/sc_dessert_inv.png"),
  // 买东西/神社的固定画换成对得上的新画(原借甜品/博物馆)
  sc_shop_ink: require("../../../assets/images/ephemera/sc_shop_ink.png"), sc_shop_inv: require("../../../assets/images/ephemera/sc_shop_inv.png"),
  sc_shrine_ink: require("../../../assets/images/ephemera/sc_shrine_ink.png"), sc_shrine_inv: require("../../../assets/images/ephemera/sc_shrine_inv.png"),
  // 新大类自己的固定画;一件事=五张小事,按站编号固定挑(format.ts artOf)。
  // 原图 style-refs 1024×1536 线稿,用引擎同一套 date_art_mask.to_mask_png 转成 300×450 的 ink/inv;看展用 sc_exhibition(sc_museum 是旧画,首页空态还在用)
  sc_sweets_ink: require("../../../assets/images/ephemera/sc_sweets_ink.png"), sc_sweets_inv: require("../../../assets/images/ephemera/sc_sweets_inv.png"),
  sc_bar_ink: require("../../../assets/images/ephemera/sc_bar_ink.png"), sc_bar_inv: require("../../../assets/images/ephemera/sc_bar_inv.png"),
  sc_live_ink: require("../../../assets/images/ephemera/sc_live_ink.png"), sc_live_inv: require("../../../assets/images/ephemera/sc_live_inv.png"),
  sc_exhibition_ink: require("../../../assets/images/ephemera/sc_exhibition_ink.png"), sc_exhibition_inv: require("../../../assets/images/ephemera/sc_exhibition_inv.png"),
  sc_aquarium_ink: require("../../../assets/images/ephemera/sc_aquarium_ink.png"), sc_aquarium_inv: require("../../../assets/images/ephemera/sc_aquarium_inv.png"),
  sc_amusement_ink: require("../../../assets/images/ephemera/sc_amusement_ink.png"), sc_amusement_inv: require("../../../assets/images/ephemera/sc_amusement_inv.png"),
  sc_play_ink: require("../../../assets/images/ephemera/sc_play_ink.png"), sc_play_inv: require("../../../assets/images/ephemera/sc_play_inv.png"),
  sc_park_ink: require("../../../assets/images/ephemera/sc_park_ink.png"), sc_park_inv: require("../../../assets/images/ephemera/sc_park_inv.png"),
  sc_onsen_ink: require("../../../assets/images/ephemera/sc_onsen_ink.png"), sc_onsen_inv: require("../../../assets/images/ephemera/sc_onsen_inv.png"),
  sc_stay_ink: require("../../../assets/images/ephemera/sc_stay_ink.png"), sc_stay_inv: require("../../../assets/images/ephemera/sc_stay_inv.png"),
  sc_moment_flowers_ink: require("../../../assets/images/ephemera/sc_moment_flowers_ink.png"), sc_moment_flowers_inv: require("../../../assets/images/ephemera/sc_moment_flowers_inv.png"),
  sc_moment_cups_ink: require("../../../assets/images/ephemera/sc_moment_cups_ink.png"), sc_moment_cups_inv: require("../../../assets/images/ephemera/sc_moment_cups_inv.png"),
  sc_moment_ticket_ink: require("../../../assets/images/ephemera/sc_moment_ticket_ink.png"), sc_moment_ticket_inv: require("../../../assets/images/ephemera/sc_moment_ticket_inv.png"),
  sc_moment_ribbon_ink: require("../../../assets/images/ephemera/sc_moment_ribbon_ink.png"), sc_moment_ribbon_inv: require("../../../assets/images/ephemera/sc_moment_ribbon_inv.png"),
  sc_moment_star_ink: require("../../../assets/images/ephemera/sc_moment_star_ink.png"), sc_moment_star_inv: require("../../../assets/images/ephemera/sc_moment_star_inv.png"),
  florals_ink: require("../../../assets/images/ephemera/florals_ink.png"), florals_inv: require("../../../assets/images/ephemera/florals_inv.png"),
  // spare fixed pictures, two more per kind (the engine rotates them by stop id: art_fixed = "<kind>_2" / "<kind>_3")
  x_train_2_ink: require("../../../assets/images/ephemera/extra/train_2_ink.png"), x_train_2_inv: require("../../../assets/images/ephemera/extra/train_2_inv.png"),
  x_train_3_ink: require("../../../assets/images/ephemera/extra/train_3_ink.png"), x_train_3_inv: require("../../../assets/images/ephemera/extra/train_3_inv.png"),
  x_dinner_2_ink: require("../../../assets/images/ephemera/extra/dinner_2_ink.png"), x_dinner_2_inv: require("../../../assets/images/ephemera/extra/dinner_2_inv.png"),
  x_dinner_3_ink: require("../../../assets/images/ephemera/extra/dinner_3_ink.png"), x_dinner_3_inv: require("../../../assets/images/ephemera/extra/dinner_3_inv.png"),
  x_cinema_2_ink: require("../../../assets/images/ephemera/extra/cinema_2_ink.png"), x_cinema_2_inv: require("../../../assets/images/ephemera/extra/cinema_2_inv.png"),
  x_cinema_3_ink: require("../../../assets/images/ephemera/extra/cinema_3_ink.png"), x_cinema_3_inv: require("../../../assets/images/ephemera/extra/cinema_3_inv.png"),
  x_walk_2_ink: require("../../../assets/images/ephemera/extra/walk_2_ink.png"), x_walk_2_inv: require("../../../assets/images/ephemera/extra/walk_2_inv.png"),
  x_walk_3_ink: require("../../../assets/images/ephemera/extra/walk_3_ink.png"), x_walk_3_inv: require("../../../assets/images/ephemera/extra/walk_3_inv.png"),
  x_cafe_2_ink: require("../../../assets/images/ephemera/extra/cafe_2_ink.png"), x_cafe_2_inv: require("../../../assets/images/ephemera/extra/cafe_2_inv.png"),
  x_cafe_3_ink: require("../../../assets/images/ephemera/extra/cafe_3_ink.png"), x_cafe_3_inv: require("../../../assets/images/ephemera/extra/cafe_3_inv.png"),
  x_viewpoint_2_ink: require("../../../assets/images/ephemera/extra/viewpoint_2_ink.png"), x_viewpoint_2_inv: require("../../../assets/images/ephemera/extra/viewpoint_2_inv.png"),
  x_viewpoint_3_ink: require("../../../assets/images/ephemera/extra/viewpoint_3_ink.png"), x_viewpoint_3_inv: require("../../../assets/images/ephemera/extra/viewpoint_3_inv.png"),
  x_shopping_2_ink: require("../../../assets/images/ephemera/extra/shopping_2_ink.png"), x_shopping_2_inv: require("../../../assets/images/ephemera/extra/shopping_2_inv.png"),
  x_shopping_3_ink: require("../../../assets/images/ephemera/extra/shopping_3_ink.png"), x_shopping_3_inv: require("../../../assets/images/ephemera/extra/shopping_3_inv.png"),
  x_shrine_2_ink: require("../../../assets/images/ephemera/extra/shrine_2_ink.png"), x_shrine_2_inv: require("../../../assets/images/ephemera/extra/shrine_2_inv.png"),
  x_shrine_3_ink: require("../../../assets/images/ephemera/extra/shrine_3_ink.png"), x_shrine_3_inv: require("../../../assets/images/ephemera/extra/shrine_3_inv.png"),
} as const;
export type ArtName = "sc_station" | "sc_bistro" | "sc_cinema" | "sc_tonight" | "sc_cafe" | "sc_moon" | "sc_museum" | "sc_dessert" | "sc_shop" | "sc_shrine" | "florals"
  | "sc_sweets" | "sc_bar" | "sc_live" | "sc_exhibition" | "sc_aquarium" | "sc_amusement" | "sc_play" | "sc_park" | "sc_onsen" | "sc_stay" | "sc_moment_flowers" | "sc_moment_cups" | "sc_moment_ticket" | "sc_moment_ribbon" | "sc_moment_star"
  | `x_${"train" | "dinner" | "cinema" | "walk" | "cafe" | "viewpoint" | "shopping" | "shrine"}_${2 | 3}`;

// ── 烫金反光:手机左右倾斜 → --glint(-30%…30%);读不到倾斜(模拟器)就自己慢慢晃(原型同) ─────
const GlintCtx = createContext<SharedValue<number> | null>(null);
export function GlintProvider({ children }: { children: React.ReactNode }) {
  const rot = useDeviceRotation();
  const wobble = useSharedValue(0);
  const life = useLifecycle();   // in the background the sway stops; it starts again when the page is back
  useEffect(() => {
    if (life !== "active") { cancelAnimation(wobble); return; }
    wobble.value = 0;
    wobble.value = withRepeat(withTiming(Math.PI * 2, { duration: 8700, easing: Easing.linear }), -1, false);
  }, [wobble, life]);
  const glint = useDerivedValue(() => glintFrom(rot.available.value, rot.roll.value, wobble.value));
  return <GlintCtx.Provider value={glint}>{children}</GlintCtx.Provider>;
}
export function useGlint(): SharedValue<number> {
  const g = useContext(GlintCtx);
  const fallback = useSharedValue(0);
  return g ?? fallback;
}

// ── 手机倾斜:纸片按远近错开(原型 tiltLoop,同一颗传感器多处共享,别各开各的) ──────
const TiltCtx = createContext<{ x: SharedValue<number>; y: SharedValue<number> } | null>(null);
export function TiltProvider({ children }: { children: React.ReactNode }) {
  const rot = useDeviceRotation();
  const x = useSharedValue(0), y = useSharedValue(0);
  const focused = useIsFocused();   // not every frame while the home page sits under another page (saves battery)
  const life = useLifecycle();
  const cb = useFrameCallback(() => {
    "worklet";
    const tx = rot.available.value ? tiltAxis(rot.roll.value) : 0;
    const ty = rot.available.value ? tiltAxis(rot.pitch.value) : 0;
    x.value = tiltEase(x.value, tx);
    y.value = tiltEase(y.value, ty);
  });
  useEffect(() => { cb.setActive(focused && life === "active"); }, [focused, life]); // eslint-disable-line react-hooks/exhaustive-deps
  return <TiltCtx.Provider value={{ x, y }}>{children}</TiltCtx.Provider>;
}
export function useTilt(): { x: SharedValue<number>; y: SharedValue<number> } {
  const t = useContext(TiltCtx);
  const fx = useSharedValue(0), fy = useSharedValue(0);
  return t ?? { x: fx, y: fy };
}
/** 包一层就按远近倾斜(原型 DEPTH 6~14 这个量级);不跟手势冲突——拖拽物件自己把这份偏移加到 fling 偏移上即可 */
/** flight=它同时是飞行层的一个落点/起点 */
export function Tilt({ depth, style, children, flight }: { depth: number; style?: ViewStyle; children: React.ReactNode; flight?: string }) {
  const { x, y } = useTilt();
  // the tilt's offset lands on whole device pixels (stage units × the stage's scale × the pixel density): the sensor
  // never sits still, and a move of a fraction of a pixel left the letters soft
  const pr = useStagePixels();
  const st = useAnimatedStyle(() => { const o = tiltOffset(x.value, y.value, depth); return { transform: [{ translateX: Math.round(o.x * pr) / pr }, { translateY: Math.round(o.y * pr) / pr }] }; });
  if (flight) return <FlightSpot k={flight} style={[style, st]}>{children}</FlightSpot>;
  return <Animated.View style={[style, st]}>{children}</Animated.View>;
}

const FOIL_STOPS = ["#7A5A22", "#B8914A", "#F2DC9C", "#9C7638", "#6E5020", "#C9A35C", "#8C6A30"];
const FOIL_POS = [0, 0.22, 0.32, 0.46, 0.64, 0.82, 1];

/** Foil text (prototype .foil): Latin numbers only (No. 1028 …; Courier Prime Bold). On the web the gradient is CSS
 *  (background-clip: text) instead of a live canvas per number: same stops, same 200% sweep moved by the glint. */
export function FoilText({ text, size, style, align = "left", width, file }: { text: string; size: number; style?: ViewStyle; align?: "left" | "center"; width?: number; file?: number }) {
  const glint = useGlint();
  const ref = useRef<HTMLElement | null>(null);
  const H = Math.ceil(size * 1.3);
  const family = file === PLAYFAIR_BLACK_FILE ? "EphemeraDisplay-Black" : "CourierPrime-Bold";
  const apply = (g: number) => {
    const el = ref.current;
    if (!el) return;
    const tw = el.offsetWidth || 1;
    el.style.backgroundPosition = `${-tw * 0.5 - (g / 100) * tw}px 0`;
  };
  useAnimatedReaction(() => glint.value, (g) => { runOnJS(apply)(g); });
  useEffect(() => { apply(glint.value); });   // after layout: the width is known
  const css: React.CSSProperties = {
    display: "inline-block", whiteSpace: "pre", fontFamily: family, fontSize: size, lineHeight: `${H}px`, color: "transparent",
    backgroundImage: `linear-gradient(90deg, ${FOIL_STOPS.map((c, k) => `${c} ${FOIL_POS[k] * 100}%`).join(", ")})`,
    backgroundSize: "200% 100%", backgroundRepeat: "no-repeat", WebkitBackgroundClip: "text", backgroundClip: "text",
  };
  return (
    <View style={[{ height: H, width, alignItems: align === "center" ? "center" : "flex-start", paddingLeft: align === "center" ? 0 : 1 }, style]} pointerEvents="none">
      {React.createElement("span", { ref, style: css }, text)}
    </View>
  );
}

/** Foil hairline (prototype .foilLine), also the base of the NOW tag: CSS gradient swept by the glint */
export function FoilLine({ w, h = 1, style }: { w: number; h?: number; style?: ViewStyle }) {
  const glint = useGlint();
  const ref = useRef<View>(null);
  const apply = (g: number) => {
    const el = ref.current as unknown as HTMLElement | null;
    if (el?.style) el.style.backgroundPosition = `${-w * 0.2 + (g / 100) * w}px 0`;
  };
  useAnimatedReaction(() => glint.value, (g) => { runOnJS(apply)(g); });
  useEffect(() => { apply(glint.value); });
  return (
    <View ref={ref} pointerEvents="none" style={[{ width: w, height: h,
      backgroundImage: "linear-gradient(90deg, #A8823F 0%, #F3DFA6 40%, #A8823F 70%, #D9B972 100%)", backgroundSize: `${w * 1.4}px 100%`, backgroundRepeat: "no-repeat" } as ViewStyle, style]} />
  );
}

/** 烫金细框(原型 border-image: linear-gradient(105deg,#A8823F,#F3DFA6,#A8823F,#E2C27E)) */
export function GoldFrame({ x, y, w, h, sw = 1.2 }: { x: number; y: number; w: number; h: number; sw?: number }) {
  return (
    <Canvas style={{ position: "absolute", left: x - 1, top: y - 1, width: w + 2, height: h + 2 }} pointerEvents="none">
      <Rect x={1 + sw / 2} y={1 + sw / 2} width={w - sw} height={h - sw} style="stroke" strokeWidth={sw}>
        <LinearGradient start={vec(0, 0)} end={vec(w, h * 0.27)} colors={["#A8823F", "#F3DFA6", "#A8823F", "#E2C27E"]} />
      </Rect>
    </Canvas>
  );
}

// ── 纸面:形状 + 纸纹 + 分层阴影 ────────────────────────────────────────────────────────
type ShadowLevel = "none" | "paper" | "soft" | "deep";
const SH_LAYERS: Record<Exclude<ShadowLevel, "none">, Array<[number, number, number]>> = {
  // [dy, blur, alpha] 原型 .tex .shadow 四层 / .paperish 两层 / 弹出物件两层
  soft: [[1, 0, 0.18], [2, 2, 0.16], [12, 14, 0.14], [28, 30, 0.1]],
  paper: [[1, 0, 0.18], [2, 3, 0.2]],
  deep: [[2, 3, 0.18], [24, 40, 0.3]],
};

/** The paper's layered shadow as the passes the page draws, in order (pure, tested). Skia drew it as drop-shadow
 *  image filters on the paper's fill: the paint's filters are folded from the right into MakeCompose(outer, inner),
 *  so the last layer is applied first and each next one shadows the result so far (shadow included). Skia's blur
 *  is a sigma (blur / 2); a 2D canvas takes shadowBlur = 2·sigma, in device pixels like its offsets. */
export function shadowPasses(layers: Array<[number, number, number]>, sh: string, dpr: number): Array<{ color: string; blur: number; dy: number }> {
  const [r, g, b] = sh.split(",").map((x) => Number(x.trim()));
  return layers.slice().reverse().map(([dy, blur, a]) => ({ color: `rgba(${r},${g},${b},${a})`, blur: blur * dpr, dy: dy * dpr }));
}

/** Draw a paper's fill with its shadow into a plain 2D canvas, once, before the browser paints (no frame without it).
 *  Before, Skia drew it in software (CanvasKit raster on the web): the blur took up to a second per paper on a phone,
 *  so a page's papers arrived seconds after its text. The browser's own canvas shadows are the same Gaussian. */
function drawPaper(el: HTMLCanvasElement | null, o: { w: number; h: number; pad: number; d?: string; fill: string; sh: string; layers: Array<[number, number, number]> }) {
  if (!el || typeof el.getContext !== "function" || typeof Path2D === "undefined") return;
  const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const W = Math.ceil((o.w + o.pad * 2) * dpr), H = Math.ceil((o.h + o.pad * 2) * dpr);
  const path = paperPath(o.d, o.w, o.h);
  // two scratch canvases, used in turn (each pass draws the other one over its own shadow)
  const pair = scratch(W, H);
  if (!pair) return;
  let cur = pair[0], other = pair[1];
  const x0 = cur.getContext("2d");
  if (!x0) return;
  x0.setTransform(dpr, 0, 0, dpr, o.pad * dpr, o.pad * dpr);
  x0.fillStyle = o.fill;
  x0.fill(path);
  for (const pass of shadowPasses(o.layers, o.sh, dpr)) {
    const x = other.getContext("2d");
    if (!x) break;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.shadowColor = "transparent"; x.clearRect(0, 0, W, H);
    x.shadowColor = pass.color; x.shadowBlur = pass.blur; x.shadowOffsetX = 0; x.shadowOffsetY = pass.dy;
    x.drawImage(cur, 0, 0);                         // the result so far, over its own shadow
    [cur, other] = [other, cur];
  }
  el.width = W; el.height = H;
  const out = el.getContext("2d");
  if (!out) return;
  out.clearRect(0, 0, W, H);
  out.drawImage(cur, 0, 0);
  markPainted(el);
}
let scratchPair: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
/** The two scratch canvases, sized W×H and cleared (the papers are drawn one at a time, in layout effects). */
function scratch(W: number, H: number): [HTMLCanvasElement, HTMLCanvasElement] | null {
  if (typeof document === "undefined") return null;
  scratchPair ??= [document.createElement("canvas"), document.createElement("canvas")];
  for (const c of scratchPair) {
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }   // (resizing clears)
    else {
      const x = c.getContext("2d");
      if (x) { x.setTransform(1, 0, 0, 1, 0, 0); x.shadowColor = "transparent"; x.shadowBlur = 0; x.shadowOffsetX = 0; x.shadowOffsetY = 0; x.clearRect(0, 0, W, H); }
    }
  }
  return scratchPair;
}
function drawEdge(el: HTMLCanvasElement | null, o: { w: number; h: number; d?: string }) {
  if (!el || typeof el.getContext !== "function" || typeof Path2D === "undefined") return;
  const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  el.width = Math.ceil(o.w * dpr); el.height = Math.ceil(o.h * dpr);
  const x = el.getContext("2d");
  if (!x) return;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.strokeStyle = "rgba(255,255,255,0.55)"; x.lineWidth = 1;
  x.stroke(paperPath(o.d, o.w, o.h));
  markPainted(el);
}
function paperPath(d: string | undefined, w: number, h: number): Path2D {
  if (d) return new Path2D(d);
  const p = new Path2D(); p.rect(0, 0, w, h); return p;
}
function markPainted(el: HTMLCanvasElement) {
  el.dataset.painted = "1";
  el.dispatchEvent(new Event(PAINTED_EVENT, { bubbles: true }));
}

/** The address of a bundled picture on the web ({uri} there; null elsewhere, e.g. in the page tests). */
export function bundledUri(src: unknown): string | null {
  const o = src as { uri?: unknown } | null;
  return o && typeof o === "object" && typeof o.uri === "string" && o.uri ? o.uri : null;
}
/** CSS clip for a paper's outline: the same SVG path the canvas fills (no path = the whole box). */
export const paperClip = (d?: string) => (d ? `path('${d.replace(/'/g, "")}')` : undefined);

// On the web a paper is three layers: the outline filled with its shadow (a 2D canvas drawn once, drawPaper), the
// paper texture as a CSS background in soft-light clipped to the outline, and the white edge. Before, Skia drew all
// of it in one canvas in software, where the shadow blur and the soft-light texture took up to a second per paper
// on a phone. (The texture had in fact never shown on the web: Skia's web resolver fetched ".../undefined" for a
// bundled picture — see shims/skia.tsx assetUri.)
export function Paper({ w, h, d, fill, sh, shadow = "soft", texture = 0.55, style, edge = false, children }: {
  w: number; h: number; d?: string; fill: string; sh: string; shadow?: ShadowLevel; texture?: number; style?: ViewStyle;
  edge?: boolean; children?: React.ReactNode;
}) {
  const pad = shadow === "none" ? 0 : 44;            // as before: the shadow is drawn up to 44 outside the paper
  const fillRef = useRef<HTMLCanvasElement | null>(null);
  const edgeRef = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => { drawPaper(fillRef.current, { w, h, pad, d, fill, sh, layers: shadow === "none" ? [] : SH_LAYERS[shadow] }); }, [w, h, pad, d, fill, sh, shadow]);
  useLayoutEffect(() => { if (edge) drawEdge(edgeRef.current, { w, h, d }); }, [edge, w, h, d]);
  const tex = texture > 0 ? bundledUri(PAPER_TEX) : null;
  const box = { position: "absolute", left: 0, top: 0, width: w, height: h } as const;
  const layered = useContext(InScroll);
  return (
    <View style={[{ position: "absolute", width: w, height: h }, style, layered ? LAYERED : null]} pointerEvents="box-none">
      {React.createElement("canvas", { ref: fillRef, "aria-hidden": true, style: { position: "absolute", left: -pad, top: -pad, width: w + pad * 2, height: h + pad * 2, pointerEvents: "none" } })}
      {tex ? (
        <View pointerEvents="none" style={{ ...box, opacity: texture, mixBlendMode: "soft-light", backgroundImage: `url(${tex})`,
          backgroundSize: "320px 320px", backgroundRepeat: "repeat", clipPath: paperClip(d) } as ViewStyle} />
      ) : null}
      {edge ? React.createElement("canvas", { ref: edgeRef, "aria-hidden": true, style: { ...box, pointerEvents: "none" } }) : null}
      {children}
    </View>
  );
}

const LAYERED = { willChange: "transform" } as unknown as ViewStyle;

/** A colour with an alpha: "#rgb" / "#rrggbb" / "rgb(r, g, b)" (pure, tested). */
export function withAlpha(c: string, a: number): string {
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (h) {
    const x = h[1].length === 3 ? h[1].split("").map((d) => d + d).join("") : h[1];
    const n = parseInt(x, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = /^rgb\(\s*([^)]+?)\s*\)$/i.exec(c.trim());
  return m ? `rgba(${m[1]}, ${a})` : c;
}
/** A shadow that follows what is drawn (the shape's alpha), as the home app's shadow on a view with no background
 *  of its own. RN's shadow* props become box-shadow on the web: the view's rectangle — a round seal got a tilted
 *  square under it, a zigzag paper a box. For views whose content is not their own full rectangle. Pure, tested. */
export function shapeShadow(color: string, opacity: number, radius: number, dy: number): ViewStyle {
  // box-shadow's blur is twice the Gaussian's deviation, drop-shadow's is the deviation: radius / 2 looks the same
  return { filter: `drop-shadow(0px ${dy}px ${radius / 2}px ${withAlpha(color, opacity)})` } as ViewStyle;
}

/** 只叠纸纹(用在已经是 RN View 的矩形色块上,如连票副券、盒盖) */
// 纸纹用 CSS 背景平铺满整块:RN 的 Image resizeMode="repeat" 在网页上只画一块 512 见方的纹(盒盖下半截是平的一条)
export function PaperTex({ opacity = 0.55, style }: { opacity?: number; style?: ViewStyle }) {
  const release = usePaintHold();
  const tex = bundledUri(PAPER_TEX);
  useEffect(() => {
    if (!tex || typeof window === "undefined" || typeof window.Image !== "function") { release(); return; }
    const img = new window.Image();
    img.onload = img.onerror = () => release();
    img.src = tex;
  }, [tex]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View testID="paper-tex" style={[StyleSheet.absoluteFill, { opacity, mixBlendMode: "soft-light", overflow: "hidden",
      backgroundImage: tex ? `url(${tex})` : undefined, backgroundSize: `${PAPER_TEX_TILE}px ${PAPER_TEX_TILE}px`, backgroundRepeat: "repeat" } as ViewStyle, style]} pointerEvents="none" />
  );
}
/** the texture's tile (as the Image drew it before) */
export const PAPER_TEX_TILE = 512;

/** 单色插画(原型 art():Codex 画的线稿 png 当遮罩,染成当前配色) */
export function Art({ name, color, inv, style }: { name: ArtName; color: string; inv?: boolean; style: ImageStyle }) {
  const src = ART[`${name}_${inv ? "inv" : "ink"}` as keyof typeof ART];
  const layout = ART_LAYOUT[name];
  // 旧 8 类等不在取景表里的:在调用方给的框里等比铺满(不再拉伸;「比例绝对不对」)
  if (!layout) {
    const sz = ART_SIZE[name] ?? { w: ART_W, h: ART_H };
    return <BoxedArt source={src} sw={sz.w} sh={sz.h} focus={ART_FOCUS_BOXED[name] ?? CENTER} contain={ART_CONTAIN_BOXED.has(name)} color={color} style={style} />;
  }
  return <FramedArt src={src} layout={layout} color={color} inv={inv} style={style} />;
}

/** 调用方给的框(位置、大小、透明度、翻转都照用)当窗口,画在窗口里按原图比例铺满、按焦点取景,多出的裁掉。
 *  框本身就是原图比例时,画=整框,与原来的拉伸摆放逐像素相同 */
export function BoxedArt({ source, sw, sh, focus = CENTER, contain, color, style, onError }: {
  source: React.ComponentProps<typeof Image>["source"]; sw: number; sh: number; focus?: ArtFocus; contain?: boolean; color: string; style: ImageStyle; onError?: () => void;
}) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const r = box ? (contain ? containIn(box.w, box.h, sw, sh) : coverIn(box.w, box.h, sw, sh, focus)) : null;
  const release = usePaintHold();
  return (
    <View testID="art-box" pointerEvents="none" style={[{ position: "absolute" }, style as ViewStyle, { overflow: "hidden" }]}
      onLayout={(e) => { const { width, height } = e.nativeEvent.layout; setBox((b) => (b && b.w === width && b.h === height ? b : { w: width, h: height })); }}>
      {r ? <Image testID="art-img" source={source} onLoad={release} onError={() => { release(); onError?.(); }} style={{ position: "absolute", tintColor: color, ...r }} resizeMode="stretch" /> : null}
    </View>
  );
}

/** 新固定画:量出所在格子的大小,按取景表摆(焦点居中等比铺满 / 小事整张等比缩进)。调用方框的位置尺寸不再用,
 * 其余样式(透明度、翻转等)照带。一件事的反相(inv)版:画里的白底被染成 color(纸色),四周留的那圈也只在画外铺 color 接上;
 * 画本身底下不铺(线条是挖空的,要透出格子底色) */
function FramedArt({ src, layout, color, inv, style }: { src: number; layout: ArtLayout; color: string; inv?: boolean; style: ImageStyle }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const { left: _l, right: _r, top: _t, bottom: _b, width: _w, height: _h, position: _p, ...rest } = (StyleSheet.flatten(style) ?? {}) as ImageStyle;
  const r = box ? artPlacement(layout, box.w, box.h) : null;
  const ri = r && layout === "contain" ? overscan(r) : r; // 画本身多画一圈,边上半透明那圈藏到纸色/格子边外
  const release = usePaintHold();
  return (
    <View testID="art-frame" style={StyleSheet.absoluteFill} pointerEvents="none"
      onLayout={(e) => { const { width, height } = e.nativeEvent.layout; setBox((b) => (b && b.w === width && b.h === height ? b : { w: width, h: height })); }}>
      {ri ? <Image testID="art-img" source={src} onLoad={release} onError={release} style={[rest, { position: "absolute", tintColor: color, ...ri }]} resizeMode="stretch" /> : null}
      {layout === "contain" && inv && r && box ? marginRects(r, box.w, box.h).map((m, k) => <View key={k} style={{ position: "absolute", backgroundColor: color, ...m }} />) : null}
    </View>
  );
}

export function Svg({ xml, w, h, style }: { xml: string; w: number; h: number; style?: ViewStyle }) {
  return <View style={[{ position: "absolute", width: w, height: h }, style]} pointerEvents="none"><SvgXml xml={xml} width={w} height={h} /></View>;
}

/** 点线(iOS 只给一条边画 dotted 不生效,统一用这个):横线给 w,竖线给 h */
export function Dots({ w, h, color, sw = 1.5, gap = 3, style }: { w?: number; h?: number; color: string; sw?: number; gap?: number; style?: ViewStyle }) {
  const horiz = h === undefined;
  const L = (horiz ? w : h) ?? 0;
  return (
    <View style={[{ position: "absolute", width: horiz ? L : sw, height: horiz ? sw : L }, style]} pointerEvents="none">
      <RNSvg width={horiz ? L : sw} height={horiz ? sw : L}>
        <SvgLine x1={sw / 2} y1={sw / 2} x2={horiz ? L - sw / 2 : sw / 2} y2={horiz ? sw / 2 : L - sw / 2} stroke={color} strokeWidth={sw} strokeLinecap="round" strokeDasharray={[0.01, gap]} />
      </RNSvg>
    </View>
  );
}

/** 带点线下划线的小字链接(原型 border-bottom: 1px dotted) */
export function DotLink({ children, color, style, onPress, label, plain }: { children: React.ReactNode; color: string; style?: TextStyle; onPress?: () => void; label?: string; plain?: boolean }) {
  const [w, setW] = useState(0);
  return (
    <Pressable onPress={onPress} disabled={!onPress} hitSlop={8} accessibilityLabel={label}>
      <Text onLayout={(e) => setW(e.nativeEvent.layout.width)} style={[{ color }, style]}>{children}</Text>
      {!plain && w ? <Dots w={w} sw={1} gap={2.2} color={color} style={{ left: 0, bottom: -2 }} /> : null}
    </Pressable>
  );
}

/** 凹印字(原型 .press-in:下沿一道白高光) */
/** 约会英文名的一行(整类修,「同一类问题整类全修」;同 L2 中文名的做法):单行、放不下按比例缩字号、
 *  到下限(minScale)还放不下才截短「…」。调用方必须给定宽度(width 或 left+right),否则没有「放不下」可言。
 *  英文花体/衬线字宽不等宽,用 iOS 原生排版量宽(adjustsFontSizeToFit),不像中文那样按字数估 */
export function FitLine({ children, style, minScale = 0.35, testID }: { children: string; style: StyleProp<TextStyle>; minScale?: number; testID?: string }) {
  return <FitText testID={testID} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={minScale} ellipsizeMode="tail" style={[style, scriptRoom(style)]}>{children}</FitText>;
}
/** Script lines reach past their text box on all four sides (swashes, capitals' flourishes, descenders) and a one-line
 *  text clips at its box (the envelope's EMPTY STOMACH / FULL MOON lost letters at both ends, heads and tails).
 *  As in the home app (design-base 3f2defc): padding on all four sides, pulled back by the same negative margin
 *  (a fixed width / maxWidth grows by both sides): where the letters sit, the line spacing and the fitted size do not
 *  change; the flourishes fall inside the box; two lines' boxes overlap, transparent, and do not cut each other.
 *  Sides = 0.22 × size; top / bottom = half of (1.5 × size − line height) (this face's glyphs are about 1.5 × size
 *  tall), plus 0.08 × size. */
export function scriptRoom(style: StyleProp<TextStyle>): TextStyle | null {
  const f = StyleSheet.flatten(style) ?? {};
  if (f.fontFamily !== FF.script) return null;
  const fs = typeof f.fontSize === "number" ? f.fontSize : 20;
  const lh = typeof f.lineHeight === "number" ? f.lineHeight : fs * 1.2;
  const pad = Math.round(fs * 0.22);
  const pv = Math.max(0, Math.ceil((fs * 1.5 - lh) / 2)) + Math.round(fs * 0.08);
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    paddingLeft: pad, paddingRight: pad, paddingTop: pv, paddingBottom: pv,
    marginLeft: num(f.marginLeft) - pad, marginRight: num(f.marginRight) - pad,
    marginTop: num(f.marginTop) - pv, marginBottom: num(f.marginBottom) - pv,
    ...(typeof f.width === "number" ? { width: f.width + 2 * pad } : null),
    // (web: a one-line text gets max-width 100% from React Native Web, which would keep the box from growing by the
    //  negative margins when it has no width of its own; let it grow by both sides, as on the phone)
    ...(typeof f.maxWidth === "number" ? { maxWidth: f.maxWidth + 2 * pad } : typeof f.width === "number" ? null : { maxWidth: `calc(100% + ${2 * pad}px)` as unknown as number }),
  };
}

/** Text with adjustsFontSizeToFit on the web (React Native Web ignores it): while the text overflows its box
 *  (wider than one line, or taller than numberOfLines), the font size steps down, to minimumFontScale at most;
 *  then the usual ellipsis. Measured again when a font file arrives (the size of the glyphs changes). */
let measureCtx: CanvasRenderingContext2D | null = null;
/** Width of one line of text at `px` in the element's computed font, letter spacing included. */
export function textWidth(text: string, px: number, cs: CSSStyleDeclaration): number {
  measureCtx ??= typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  if (!measureCtx) return 0;
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${px}px ${cs.fontFamily}`;
  const ls = parseFloat(cs.letterSpacing) || 0;
  const scale = parseFloat(cs.fontSize) ? px / parseFloat(cs.fontSize) : 1;
  return measureCtx.measureText(text).width + ls * scale * [...text].length;
}
/** Width of `text` at `px` in a font family (canvas measureText): the natural width a line would take. */
export function naturalWidth(text: string, family: string, px: number): number | null {
  measureCtx ??= typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  if (!measureCtx) return null;
  measureCtx.font = `${px}px ${family}`;
  return measureCtx.measureText(text).width;
}

/** Extra room (px) a line's ink needs beyond its box on each side, given where the text sits (pure, tested).
 *  box: the element's padding-box width / height, its padding, content width; ink: canvas measureText at the size
 *  shown; centered: text-align center. Negative = enough room already. */
export function inkShortfall(box: { width: number; height: number; padL: number; padT: number; contentW: number; lineHeight: number },
  m: { width: number; actualBoundingBoxLeft: number; actualBoundingBoxRight: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number; fontBoundingBoxAscent: number; fontBoundingBoxDescent: number },
  centered: boolean): { left: number; right: number; top: number; bottom: number } {
  const start = box.padL + (centered ? (box.contentW - m.width) / 2 : 0);
  const baseline = box.padT + (box.lineHeight - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
  return {
    left: m.actualBoundingBoxLeft - start,
    right: start + m.actualBoundingBoxRight - box.width,
    top: m.actualBoundingBoxAscent - baseline,
    bottom: baseline + m.actualBoundingBoxDescent - box.height,
  };
}
type Grown = { pl: string; pr: string; pt: string; pb: string; ml: string; mr: string; mt: string; mb: string; w: string; mw: string };
const SCRIPT_FACE = /PinyonScript/;
/** Script lines (see scriptRoom): the room given by the fixed rule (0.22 / 1.5 × size) is a floor. Where a name's
 *  ink reaches further (FULL MOON's last N swings 0.66 × size past its advance), measure it here and grow the box by
 *  the rest, the same way (padding out, negative margin back, a fixed width wider): the letters do not move. */
function unGrow(el: HTMLElement, grown: { current: Grown | null }) {
  const st = el.style, g = grown.current;
  if (!g) return;
  st.paddingLeft = g.pl; st.paddingRight = g.pr; st.paddingTop = g.pt; st.paddingBottom = g.pb;
  st.marginLeft = g.ml; st.marginRight = g.mr; st.marginTop = g.mt; st.marginBottom = g.mb; st.width = g.w; st.maxWidth = g.mw;
  grown.current = null;
}
function roomForInk(el: HTMLElement, text: string, px: number, grown: { current: Grown | null }) {
  const st = el.style;
  unGrow(el, grown);
  const cs = getComputedStyle(el);
  if (!SCRIPT_FACE.test(cs.fontFamily)) return;
  measureCtx ??= typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  if (!measureCtx) return;
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${px}px ${cs.fontFamily}`;
  const m = measureCtx.measureText(text);
  if (!(m.fontBoundingBoxAscent > 0)) return;
  const n = (v: string) => parseFloat(v) || 0;
  const padL = n(cs.paddingLeft), padR = n(cs.paddingRight), padT = n(cs.paddingTop), padB = n(cs.paddingBottom);
  const lh = n(cs.lineHeight) || m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const s = inkShortfall({ width: el.clientWidth, height: el.clientHeight, padL, padT, contentW: el.clientWidth - padL - padR, lineHeight: lh }, m, cs.textAlign === "center");
  const add = (v: number) => (v > -0.5 ? Math.ceil(v + 1.5) : 0);   // +1.5: anti-aliasing
  // centred text stays centred only if both sides grow alike
  const centered = cs.textAlign === "center";
  const cut = m.width > el.clientWidth - padL - padR + 0.5;   // ends in "…" anyway: only up and down
  const l = cut ? 0 : centered ? Math.max(add(s.left), add(s.right)) : add(s.left), r = cut ? 0 : centered ? l : add(s.right);
  const t = add(s.top), b = add(s.bottom);
  if (!l && !r && !t && !b) return;
  grown.current = { pl: st.paddingLeft, pr: st.paddingRight, pt: st.paddingTop, pb: st.paddingBottom, ml: st.marginLeft, mr: st.marginRight, mt: st.marginTop, mb: st.marginBottom, w: st.width, mw: st.maxWidth };
  const w0 = el.offsetWidth;   // layout width (no page scale)
  st.paddingLeft = `${padL + l}px`; st.paddingRight = `${padR + r}px`; st.paddingTop = `${padT + t}px`; st.paddingBottom = `${padB + b}px`;
  st.marginLeft = `${n(cs.marginLeft) - l}px`; st.marginRight = `${n(cs.marginRight) - r}px`;
  st.marginTop = `${n(cs.marginTop) - t}px`; st.marginBottom = `${n(cs.marginBottom) - b}px`;
  if (l || r) { st.width = `${w0 + l + r}px`; st.maxWidth = "none"; }
}

export function FitText({ style, minimumFontScale = 0.35, children, ...rest }: React.ComponentProps<typeof Text>) {
  const ref = useRef<Text>(null);
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const base = typeof flat.fontSize === "number" ? flat.fontSize : 14;
  const [size, setSize] = useState(base);
  const [gen, setGen] = useState(0);
  const grown = useRef<Grown | null>(null);
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    const f = () => setGen((n) => n + 1);
    fonts?.addEventListener?.("loadingdone", f);
    void fonts?.ready?.then(f);
    const late = [setTimeout(f, 400), setTimeout(f, 1500)];   // a face that arrives without a loadingdone event
    // the box can get its final width after the first measure (inside lists, pagers): measure again when it changes
    const el = ref.current as unknown as Element | null;
    let w = -1;
    const ro = typeof ResizeObserver !== "undefined" && el && typeof el.getBoundingClientRect === "function"
      ? new ResizeObserver((es) => { const nw = Math.round(es[0]?.contentRect.width ?? 0); if (nw !== w) { w = nw; f(); } }) : null;
    if (ro && el) ro.observe(el);
    return () => { fonts?.removeEventListener?.("loadingdone", f); ro?.disconnect(); late.forEach(clearTimeout); };
  }, []);
  useLayoutEffect(() => {
    const el = ref.current as unknown as HTMLElement | null;
    if (!el?.style) return;
    let fs = base;
    const min = base * minimumFontScale;
    const oneLine = rest.numberOfLines === 1;
    if (oneLine && typeof children === "string") {
      // one line: measure the text itself with the page's own font (canvas measureText), not the DOM overflow —
      // WebKit can report no overflow for an ellipsised line, which left long names cut ("A Qu…").
      // The room is read with the text at its full size: a box that shrinks with its text (maxWidth, no width of its
      // own) is then at its limit; read after a shrink it was narrower each time, and the title stepped down 3 % a
      // pass to the floor (day page strip title 27 → 10 px).
      unGrow(el, grown);
      el.style.fontSize = `${base}px`;
      const cs = getComputedStyle(el);
      const avail = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const w = textWidth(children, base, cs);
      // (3% to spare: sub-pixel widths decide the ellipsis)
      if (avail > 0 && w > avail * 0.97) fs = Math.max(min, Math.floor((base * avail * 0.97) / w * 10) / 10);
      // then the DOM's own word (script faces overhang their advance widths): step down while it still overflows
      el.style.fontSize = `${fs}px`;
      for (let k = 0; k < 12 && fs > min && el.scrollWidth > el.clientWidth; k++) {
        fs = Math.max(min, fs * 0.97);
        el.style.fontSize = `${fs}px`;
      }
    } else {
      el.style.fontSize = `${fs}px`;
      for (let k = 0; k < 24 && fs > min; k++) {
        const over = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        if (!over) break;
        const ratio = el.scrollWidth > el.clientWidth + 1 ? el.clientWidth / el.scrollWidth : 0.94;
        fs = Math.max(min, Math.min(fs * 0.97, fs * ratio));
        el.style.fontSize = `${fs}px`;
      }
    }
    el.style.fontSize = `${fs}px`;
    if (oneLine && typeof children === "string") roomForInk(el, children, fs, grown);
    if (Math.abs(fs - size) > 0.05) setSize(fs);
  }, [children, base, minimumFontScale, gen]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Text ref={ref} {...rest} minimumFontScale={minimumFontScale} style={[style, { fontSize: size }]}>{children}</Text>;
}
export const pressIn: TextStyle = { textShadowColor: "rgba(255,255,255,0.65)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 0 };

// ── 整页质感:颗粒(multiply)+ 左上台灯柔光(soft-light) ───────────────────────────────────
export { stageLightCss } from "./stageTex";

/** Page grain + lamp light. On the web both are CSS (the grain is a tile drawn once by Skia: runtime/drawWarmup.ts),
 *  so they are in the page's first frame; before, each page drew them full-screen in two software canvases. */
export function StageTexture({ sh }: { sh: string }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const tile = grainTile();
  // the flight's ghosts are drawn over with this same texture, at its place on the screen (stageTex.ts)
  const box = useRef<View>(null);
  useEffect(() => registerStageTex(box.current as unknown as HTMLElement | null, sh), [sh]);
  // The two blending layers hang straight on the stage's outer layer (the one with the ground colour, holding the
  // page's content): wrapped in another View (React Native Web makes every View its own stacking context) they
  // blended with nothing — multiply / soft-light had no backdrop and fell back to a plain grey veil at 32% over the
  // whole page (measured: screen = colour × 0.68 + grey × 0.32, the "fog"). The size is taken by a separate empty
  // layer that does not blend. Order unchanged: over the content, under the overlay (bar, pops). As the home app.
  return (
    <>
      <View ref={box} style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} />
      {tile ? (
        <View testID="stage-grain" pointerEvents="none" style={[StyleSheet.absoluteFill, stageGrainStyle(tile) as ViewStyle]} />
      ) : null}
      {size.w ? <View testID="stage-light" pointerEvents="none" style={[StyleSheet.absoluteFill, { mixBlendMode: "soft-light", backgroundImage: stageLightCss(size.w, size.h, sh) } as ViewStyle]} /> : null}
    </>
  );
}


// ── 轻提示(原型 #toast:一小条纸) ─────────────────────────────────────────────────────
export function useEphToast(P: Skin) {
  const [msg, setMsg] = useState<string | null>(null);
  const op = useRef(new RNAnimated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = (m: string, ms = 1800) => {
    setMsg(m);
    RNAnimated.timing(op, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => RNAnimated.timing(op, { toValue: 0, duration: 300, useNativeDriver: true }).start(), ms);
  };
  const node = (
    <RNAnimated.View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 112, alignItems: "center", opacity: op, zIndex: 96 }}>
      <View style={{ paddingVertical: 7, paddingHorizontal: 14, backgroundColor: P.paper, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 6 } }}>
        <Text style={{ maxWidth: 320, fontFamily: FF.serif5, fontSize: 12, lineHeight: 18, color: P.ink }}>{msg}</Text>
      </View>
    </RNAnimated.View>
  );
  return { show, node };
}

// ── 返回键 ‹ 与底部导航(Home / Date / Archive / Me) ───────────────────────────────────
/** chip=底下垫一小块圆纸(箭头落在花色纸品上看不清时用,如纪念盒平铺页的信封) */
export function BackKey({ color, onPress, top, chip }: { color: string; onPress: () => void; top: number; chip?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={{ position: "absolute", left: 10, top, width: 40, height: 40, alignItems: "center", justifyContent: "center", zIndex: 13 }} accessibilityLabel="返回">
      {chip ? <View pointerEvents="none" style={{ position: "absolute", left: 5, top: 5, width: 30, height: 30, borderRadius: 15, backgroundColor: chip, opacity: 0.88 }} /> : null}
      <Text style={{ fontFamily: FF.pf, fontSize: 28, color, lineHeight: 34 }}>‹</Text>
    </Pressable>
  );
}

export type NavKey = "Home" | "Date" | "Archive" | "Me";
const NAV_ICON: Record<NavKey, string> = {
  Home: '<svg width="22" height="20" viewBox="0 0 22 20"><path d="M3 9 L11 2 L19 9 V18 H3Z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  Date: '<svg width="22" height="20" viewBox="0 0 22 20"><rect x="3" y="4" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 8 H19 M7 2 V6 M15 2 V6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  Archive: '<svg width="22" height="20" viewBox="0 0 22 20"><path d="M2 5 H20 V9 A2 2 0 0 0 20 13 V17 H2 V13 A2 2 0 0 0 2 9Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 8 L12 10.5 L14.5 10.6 L12.5 12 L13.2 14.5 L11 13 L8.8 14.5 L9.5 12 L7.5 10.6 L10 10.5Z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  Me: '<svg width="22" height="20" viewBox="0 0 22 20"><circle cx="11" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 19 C4 13 18 13 19 19" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};
export const NAV_H = 64;

/** guard:离开前问一声(纪念盒编辑态有没存上的就不走,返回 false)。
 *  below:这一页在亮着的那个标签底下、不是它本身(纪念盒在 Archive 底下):再点一下亮着的标签=回到书架,
 *  不是什么都不做(试玩里收进纪念盒以后点 Archive 没反应,书架上那一册看不到) */
export function NavBar({ on, P, dateHref, guard, below }: { on: NavKey; P: Skin; dateHref: Href | null; guard?: () => Promise<boolean>; below?: boolean }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const go = async (k: NavKey) => {
    if (k === on && !below) return;
    const href: Href | null = k === "Home" ? "/ephemera" : k === "Archive" ? "/ephemera-shelf" : k === "Me" ? "/ephemera-me" : dateHref;
    if (!href) return;
    if (guard && !(await guard())) return;
    router.replace(href);
  };
  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: NAV_H + insets.bottom, paddingBottom: insets.bottom, flexDirection: "row", justifyContent: "space-around", alignItems: "center", backgroundColor: P.bg, borderTopWidth: 1, borderTopColor: rgba(P.sh, 0.14), zIndex: 5 }}>
      {(["Home", "Date", "Archive", "Me"] as NavKey[]).map((k) => (
        <Pressable key={k} onPress={() => go(k)} hitSlop={6} style={{ alignItems: "center", gap: 3, opacity: k === on ? 1 : k === "Date" && !dateHref ? 0.3 : 0.55, minWidth: 56, minHeight: 44, justifyContent: "center" }} accessibilityLabel={k}>
          <SvgXml xml={NAV_ICON[k]} width={22} height={20} color={k === on ? P.deep : P.ink} />
          <Text style={{ fontFamily: FF.corm, fontSize: 10, letterSpacing: 1.2, color: k === on ? P.deep : P.ink }}>{k}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** 字首行加字距的大写小字(原型 .caps) */
export function Caps({ children, color, size = 8.5, ls = 0.3, style, center }: { children: React.ReactNode; color: string; size?: number; ls?: number; style?: TextStyle; center?: boolean }) {
  return <Text style={[{ fontFamily: FF.pf7, fontSize: size, letterSpacing: size * ls, color, textAlign: center ? "center" : undefined }, style]}>{typeof children === "string" ? children.toUpperCase() : children}</Text>;
}

// ── 舞台:原型按 390 宽排版,这里整页按屏宽等比缩放;顶部让出灵动岛 ──────────────────────────────
export const STAGE_W = 390;
/** Device pixels per stage unit (the stage's scale × the pixel density): to put moving things on whole pixels. */
export function useStagePixels(): number {
  const { s } = useStage();
  const d = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : PixelRatio.get();
  return Math.max(1, d * s);
}
export function useStage() {
  const win = useWindowDimensions();
  const lv = useLayoutViewport();     // not the visual viewport: the keyboard must not make the pages shorter
  const width = lv?.width ?? win.width, height = lv?.height ?? win.height;
  const insets = useSafeAreaInsets();
  const s = width / STAGE_W;
  const top = Math.max(0, insets.top - 34);
  // body = 舞台里扣掉底部导航(含底部安全区)后剩下的高度
  return { s, top, H: (height - top) / s, body: (height - top - NAV_H - insets.bottom) / s, insets, width, height };
}

/** How tall a page laid out at fixed places is drawn, and whether it scrolls: the screen's height when that is enough,
 *  else the height the page needs, scrolled (a phone browser's bars, a short phone; as the home app's ticket sheet,
 *  content = max(H, need)). Pure, tested. */
export function tallPage(H: number, need: number | undefined): { h: number; scroll: boolean } {
  return need != null && H < need ? { h: need, scroll: true } : { h: H, scroll: false };
}
/** Papers inside a scrolling page (TallScroll): each is drawn in a layer of its own (will-change: transform). In iOS
 *  Safari a vertical scroll inside the box's horizontal pager otherwise left the papers' text and drawings unpainted —
 *  only their canvases showed (the canvases are layers of their own and were painted over what lies on them). */
const InScroll = createContext(false);
/** A page laid out at fixed places (a pager page): scrolls vertically where `have` is less than `need` (stage units).
 *  The scroll view is always enabled (content as tall as the page has nothing to scroll; one enabled after starting
 *  disabled took no finger in iOS Safari). */
export function TallScroll({ have, need, testID, children }: { have: number; need: number; testID?: string; children: React.ReactNode }) {
  return (
    <ScrollView testID={testID} style={StyleSheet.absoluteFill} contentContainerStyle={{ height: tallPage(have, need).h }} showsVerticalScrollIndicator={false}>
      <InScroll.Provider value>{children}</InScroll.Provider>
    </ScrollView>
  );
}

/** 一整页:皮肤底色 + 颗粒/柔光 + 烫金反光源。children 按 390 宽的坐标排。
 *  minH: a page laid out at fixed places gives the height its lowest control needs; on a shorter screen the page
 *  scrolls instead of cutting it off (pages that scroll by themselves leave it out) */
export function Stage({ P, children, overlay, bg, minH }: { P: Skin; children: React.ReactNode; overlay?: React.ReactNode; bg?: string; minH?: number }) {
  const { s, top, H: screenH } = useStage();
  // (the scroll view stays enabled: content as tall as the screen has nothing to scroll; one disabled and enabled
  // later, after a rotation, did not take a finger in iOS Safari — the card's back, measured)
  const { h: H } = tallPage(screenH, minH);
  // 字体没就绪前不排字:冷启动直进时字先按系统字量了宽,字体到了也不重量,标题会被截( 模拟器实见「Invitation B」)。
  // 加载失败照常排(回退系统字),不永久空白
  const fonts = usePosterFonts();
  const typeset = fonts.ready || !!fonts.error;
  // the page's content is shown once its papers and pictures have drawn (runtime/paintHold.tsx): no first frame of
  // text over missing paper; until then the page's own ground and grain, in its colours
  const { scope, shown } = usePaintScope({ ready: typeset });
  const hide = shown ? null : ({ opacity: 0 } as ViewStyle);
  const stage = (
    <View testID="stage-content" style={[{ position: "absolute", left: 0, top, width: STAGE_W, height: H, transform: [{ scale: s }], transformOrigin: "top left" }, hide]} pointerEvents={shown ? "auto" : "none"}>
      {typeset ? children : null}
    </View>
  );
  return (
    <GlintProvider>
      <PaintHoldProvider value={scope}>
        <View style={{ flex: 1, backgroundColor: bg ?? P.bg, overflow: "hidden" }}>
          {minH != null ? (
            <ScrollView testID="stage-scroll" style={StyleSheet.absoluteFill} contentContainerStyle={{ height: top + H * s }} showsVerticalScrollIndicator={false}>
              {stage}
            </ScrollView>
          ) : stage}
          <StageTexture sh={P.sh} />
          {typeset ? <View style={[StyleSheet.absoluteFill, hide]} pointerEvents={shown ? "box-none" : "none"}>{overlay}</View> : null}
        </View>
      </PaintHoldProvider>
    </GlintProvider>
  );
}

export { Animated };
