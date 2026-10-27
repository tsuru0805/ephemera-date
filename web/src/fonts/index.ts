// The page fonts (all SIL Open Font License; sources: ASSETS.md). Chinese weights are split by unicode-range:
// the "core" file of each (every character the pages themselves print) loads before the first paint, the rest
// only when such a character is on screen. font-display: block = text waits for its font, never shows another face.
// When a font file fails, the page still typesets (system fallback) instead of staying blank.
import { Asset } from "expo-asset";
import { useEffect, useSyncExternalStore } from "react";
import { FILES } from "./files";
import manifest from "./manifest.json";

type Part = { file: string; range: string; core: boolean };
const MANIFEST = manifest as Record<string, Part[]>;

export const F = {
  type: "CourierPrime-Bold", // 700
  typeRegular: "CourierPrime-Regular", // 400
  playfair: "EphemeraDisplay-Bold", // 700
  playfairBlack: "EphemeraDisplay-Black", // 900
  playfairItalic: "EphemeraDisplay-BoldItalic", // 700 italic
  script: "PinyonScript-Regular",
  ephSerif500: "NotoSerifSC-Medium-eph",
  ephSerif900: "NotoSerifSC-Black-eph",
  cormorant: "CormorantGaramond-Medium-eph", // 500
  cormorantSemi: "CormorantGaramond-SemiBold-eph", // 600
  playfairRegular: "EphemeraDisplay-Regular", // 400
  playfairRegularItalic: "EphemeraDisplay-Italic", // 400 italic
} as const;

export type PosterFontState = { ready: boolean; error: Error | null };

export function fontFaces(): Array<{ family: string; url: string; range: string; core: boolean }> {
  const out = [];
  for (const [family, parts] of Object.entries(MANIFEST)) {
    for (const p of parts) out.push({ family, url: Asset.fromModule(FILES[p.file]).uri, range: p.range, core: p.core });
  }
  return out;
}

let state: PosterFontState = { ready: false, error: null };
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const set = (s: PosterFontState) => { state = s; subs.forEach((f) => f()); };

function load(): Promise<void> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return Promise.resolve();
  const core: Promise<FontFace>[] = [];
  for (const f of fontFaces()) {
    const face = new FontFace(f.family, `url(${f.url}) format("woff2")`, { unicodeRange: f.range, display: "block" });
    document.fonts.add(face);
    if (f.core) core.push(face.load());
  }
  return Promise.all(core).then(() => undefined);
}

export function ensureFonts(): Promise<void> {
  if (state.ready) return Promise.resolve();
  if (inflight) return inflight;
  inflight = load()
    .then(() => set({ ready: true, error: null }))
    .catch((e: unknown) => set({ ready: false, error: e instanceof Error ? e : new Error(String(e)) }))
    .finally(() => { inflight = null; });
  return inflight;
}

/** One loading state for every page; mounting starts the load once. */
export function usePosterFonts(): PosterFontState {
  const st = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state, () => state);
  useEffect(() => { void ensureFonts(); }, []);
  return st;
}
