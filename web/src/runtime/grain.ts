// The page grain tile (made once by drawWarmup.ts, repeated by StageTexture as a CSS background). Kept apart from
// drawWarmup.ts so the pages read it without pulling Skia in.
/** Grain tile side, in page px (the noise is stitched at this period, so the tile repeats without a seam). */
export const GRAIN_TILE = 256;
/** The grain's look (as drawn before: white, then fractal noise at half opacity; seed 4, 3 octaves, 0.75). */
export const GRAIN = { freq: 0.75, octaves: 3, seed: 4, noiseOpacity: 0.5 } as const;

let grainUrl: string | null = null;
/** The grain tile's address (blob:), or null when it could not be made (the page then shows no grain). */
export function grainTile(): string | null { return grainUrl; }
export function setGrainTile(url: string | null) { grainUrl = url; }
