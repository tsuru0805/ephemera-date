// 纪念盒左右翻页时纸片有远近——每一样东西各自一个深度(原型 motion.js para():DEP 按顺序轮),
// 近的跟得紧、远的慢半拍、稍转一点。页级只给「这一页在第几页 + 翻到哪了」,每样东西包一层 Depth。
import React, { createContext, useContext } from "react";
import { StyleSheet, Text, type ViewStyle } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { depthShift, pageOffset } from "./boxMotion";

/** 原型 DEP 表:按出现顺序轮 */
export const DEP = [0.1, 0.24, 0.16, 0.3, 0.12, 0.2] as const;

type Ctx = { scrollX: SharedValue<number>; index: number } | null;
const PageCtx = createContext<Ctx>(null);
export function PageDepth({ scrollX, index, children }: { scrollX: SharedValue<number>; index: number; children: React.ReactNode }) {
  return <PageCtx.Provider value={{ scrollX, index }}>{children}</PageCtx.Provider>;
}

/** 一样东西:box 给了(它自己的 left/top/width/height)就绕自己转;没给=整层只平移 */
export function Depth({ d, box, z, children }: { d: number; box?: { left: number; top: number; width: number; height: number } | null; z?: number; children: React.ReactNode }) {
  const ctx = useContext(PageCtx);
  const st = useAnimatedStyle(() => {
    if (!ctx) return {};
    const off = Math.max(-1.2, Math.min(1.2, pageOffset(ctx.scrollX.value, ctx.index)));
    const { dx, rotateDeg } = depthShift(off, d);
    return { transform: [{ translateX: dx }, { rotate: `${box ? rotateDeg : 0}deg` }] };
  });
  const base: ViewStyle = box ? { position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height } : StyleSheet.absoluteFillObject;
  return <Animated.View pointerEvents="box-none" style={[base, z != null ? { zIndex: z } : null, st]}>{children}</Animated.View>;
}

function boxOf(style: unknown): { left: number; top: number; width: number; height: number } | null {
  const s = StyleSheet.flatten(style as ViewStyle) as ViewStyle | undefined;
  if (!s) return null;
  const ok = (v: unknown): v is number => typeof v === "number";
  return ok(s.left) && ok(s.top) && ok(s.width) && ok(s.height) ? { left: s.left, top: s.top, width: s.width, height: s.height } : null;
}

/**
 * 把一组绝对定位的子元素逐个包上 Depth(深度按顺序轮 DEP)。子元素自己写了 left/top/width/height 的,
 * 包层就落在它那块、它挪到 (0,0)——转的时候绕自己的中心;没写全的整层只平移。zIndex 跟着提到包层(否则跨包层失效)。 */
export function DepthKids({ children, start = 0 }: { children: React.ReactNode; start?: number }) {
  let i = start;
  return (
    <>
      {React.Children.map(children, (c) => {
        if (!React.isValidElement(c) || c.type === Text) return c;   // 字不动(原型只动纸:.aItem / 信封)
        const props = c.props as { style?: unknown; children?: unknown };
        // 手势外壳(GestureDetector 这类)自己没 style:层级取它里面那一层的(否则被别的纸压住)
        const kid = !props.style && React.isValidElement(props.children) ? (props.children.props as { style?: unknown }).style : undefined;
        const flat = (StyleSheet.flatten((props.style ?? kid) as ViewStyle) ?? {}) as ViewStyle;
        const b = boxOf(props.style);
        const d = DEP[i++ % DEP.length];
        const inner = b ? React.cloneElement(c as React.ReactElement<{ style?: unknown }>, { style: [props.style, { left: 0, top: 0 }] }) : c;
        return <Depth d={d} box={b} z={typeof flat.zIndex === "number" ? flat.zIndex : undefined}>{inner}</Depth>;
      })}
    </>
  );
}
