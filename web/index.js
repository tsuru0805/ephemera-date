// Entry: start loading Skia's CanvasKit (WebAssembly) and start the router at the same time. The sign-in / waiting
// screen does not draw with Skia, so it is up at once; the pages wait for CanvasKit (src/runtime/skiaReady.ts) and for
// what every page draws (decoded paper, page grain: src/runtime/drawWarmup.ts).
// Pages import Skia through src/shims/skia.tsx, which only touches the real module once CanvasKit is in.
import { loadSkia, setSkiaWarmUp } from "./src/runtime/skiaReady";
import { warmUpDrawing } from "./src/runtime/drawWarmup";

setSkiaWarmUp(warmUpDrawing);
loadSkia();
require("expo-router/entry");
