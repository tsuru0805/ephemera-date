// Copy Skia's CanvasKit WebAssembly next to the page (public/ is copied into the export as is).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "public"), { recursive: true });
copyFileSync(join(root, "node_modules/canvaskit-wasm/bin/full/canvaskit.wasm"), join(root, "public/canvaskit.wasm"));
