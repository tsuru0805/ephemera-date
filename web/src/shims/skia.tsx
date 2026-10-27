// Skia for the pages, on the web:
// 1. Lazy: the real module builds its API from CanvasKit when it is evaluated, so it is required only on first use
//    (after src/runtime/skiaReady.ts has loaded CanvasKit; the pages are not shown before that).
// 2. Skia's web <Canvas> wraps a plain <div> that takes one CSS style object, while the pages pass React Native styles
//    (arrays, absoluteFill, transforms, mixBlendMode, pointerEvents): the Canvas sits inside a React Native Web View
//    that understands those styles, and Skia's own div just fills it.
// 3. useImage: a picture decoded once is kept, so the next page that uses it draws it in its first frame (instead of
//    a first frame without it); drawWarmup.ts decodes the common ones before the pages are shown.
// 4. A canvas holds its page hidden until it has drawn once (runtime/paintHold.tsx).
// (Skia draws in software on the web — see skiaReady.ts — so many canvases per page do not hit the browser's
// limit of ~16 WebGL contexts.)
import React, { useEffect, useRef, useState } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { getSkia } from "../runtime/skiaReady";
import { PAINTED_EVENT, usePaintHold } from "../runtime/paintHold";

type SkiaModule = typeof import("@shopify/react-native-skia");
let mod: SkiaModule | null = null;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const real = (): SkiaModule => (mod ??= require("@shopify/react-native-skia") as SkiaModule);

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };
const lazy = (name: keyof SkiaModule) => {
  const C = (props: AnyProps) => React.createElement(real()[name] as React.ComponentType<AnyProps>, props);
  C.displayName = `Sk${String(name)}`;
  return C;
};

export const Group = lazy("Group");
export const Path = lazy("Path");
export const Rect = lazy("Rect");
export const Shadow = lazy("Shadow");
export const LinearGradient = lazy("LinearGradient");
export const RadialGradient = lazy("RadialGradient");
export const ImageShader = lazy("ImageShader");
export const FractalNoise = lazy("FractalNoise");
export const Image = lazy("Image");
type SkImageT = NonNullable<ReturnType<SkiaModule["useImage"]>>;
const decoded = new Map<string, SkImageT>();
/** Where a bundled picture is served. On the web a bundled picture is {uri, width, height}; Skia's own resolver only
 *  knows numbers (native) and `.default`, so it fetched ".../undefined" (404) and the papers had no texture.
 *  Pure, tested. */
export function assetUri(source: unknown): string | null {
  if (typeof source === "string") return source || null;
  if (source && typeof source === "object") {
    const o = source as { uri?: unknown; default?: unknown };
    if (typeof o.uri === "string" && o.uri) return o.uri;
    if (typeof o.default === "string" && o.default) return o.default;
    if (o.default && typeof o.default === "object") return assetUri(o.default);
    return null;
  }
  if (typeof source === "number") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require("@shopify/react-native-skia/lib/module/Platform") as { Platform: { resolveAsset: (s: unknown) => string } };
    try { return Platform.resolveAsset(source) || null; } catch { return null; }
  }
  return null;
}
/** Skia's useImage, given an address it can read, with pictures decoded before kept (by address) and given back
 *  at once. Bytes (Uint8Array) go through unchanged; a source with no address is no picture (no request). */
export const useImage = ((source: Parameters<SkiaModule["useImage"]>[0], onError?: Parameters<SkiaModule["useImage"]>[1]) => {
  const bytes = source instanceof Uint8Array;
  const uri = source == null || bytes ? null : assetUri(source);
  const have = uri ? decoded.get(uri) : undefined;
  const img = real().useImage((have ? null : bytes ? source : uri) as Parameters<SkiaModule["useImage"]>[0], onError);
  if (img && uri && !have) decoded.set(uri, img);
  return have ?? img;
}) as SkiaModule["useImage"];
/** The real Skia module (for code that runs after CanvasKit is in but before the pages are shown: drawWarmup.ts). */
export const realSkia = (): SkiaModule => real();
/** Decode a bundled picture now (after CanvasKit is in), so useImage has it on first render. */
export async function preloadImage(source: unknown): Promise<void> {
  const uri = assetUri(source);
  if (!uri) throw new Error("picture without an address");
  if (decoded.has(uri)) return;
  const { Skia: S } = real();
  const data = await S.Data.fromURI(uri);
  const img = S.Image.MakeImageFromEncoded(data);
  if (img) decoded.set(uri, img as SkImageT);
}

export const vec: SkiaModule["vec"] = (...a) => real().vec(...a);
/** Skia.Path.Make() etc.: forwarded to the real API object on use */
// (before CanvasKit is in, nothing is read through it: dev tools such as React Refresh inspect every export,
// and touching the real module early would build Skia's API on an undefined CanvasKit)
export const Skia = new Proxy({} as SkiaModule["Skia"], {
  get: (_t, k) => (getSkia().state === "ready" ? (real().Skia as unknown as Record<string | symbol, unknown>)[k] : undefined),
});

type Props = { style?: StyleProp<ViewStyle>; pointerEvents?: "none" | "auto" | "box-none" | "box-only"; children?: React.ReactNode } & AnyProps;

export function Canvas({ style, pointerEvents, children, ...rest }: Props) {
  // draw only once the box has a size (a 0×0 canvas cannot be drawn into); a box sized in the style is known at once
  const flat = (StyleSheet.flatten(style) ?? {}) as ViewStyle;
  const known = typeof flat.width === "number" && typeof flat.height === "number" && flat.width > 0 && flat.height > 0;
  const [sized, setSized] = useState(known);
  const release = usePaintHold();
  const box = useRef<View>(null);
  useEffect(() => {
    const el = box.current as unknown as HTMLElement | null;
    if (!el || typeof el.addEventListener !== "function") { release(); return undefined; }
    el.addEventListener(PAINTED_EVENT, release);
    return () => el.removeEventListener(PAINTED_EVENT, release);
  }, [release]);
  const SkCanvas = real().Canvas as unknown as React.ComponentType<AnyProps>;
  return (
    <View ref={box} style={style} pointerEvents={pointerEvents} onLayout={(e) => {
      const { width, height } = e.nativeEvent.layout;
      if (width > 0 && height > 0) setSized(true); else release();   // nothing to draw in an empty box
    }}>
      {sized ? <SkCanvas {...rest} style={{ flex: 1 }}>{children}</SkCanvas> : null}
    </View>
  );
}
