// Metro: two native-only modules the pages import are replaced on the web by src/shims/ (same API surface the
// pages use): the keyboard controller (driven by the host or visualViewport) and the photo library picker
// (host pickPhoto or the browser's file picker, same checks as the engine). Skia's Canvas gets a style adapter.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const SHIMS = {
  "react-native-keyboard-controller": path.resolve(__dirname, "src/shims/keyboard-controller.tsx"),
  "expo-image-picker": path.resolve(__dirname, "src/shims/image-picker.ts"),
};
const upstream = config.resolver.resolveRequest;
const SKIA_SHIM = path.resolve(__dirname, "src/shims/skia.tsx");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (SHIMS[moduleName]) return { type: "sourceFile", filePath: SHIMS[moduleName] };
  // Skia's web <Canvas> takes plain CSS only: pages get a Canvas that accepts React Native styles (the shim itself
  // and Skia's own files import the real module)
  if (moduleName === "@shopify/react-native-skia" && context.originModulePath !== SKIA_SHIM && !context.originModulePath.includes("node_modules"))
    return { type: "sourceFile", filePath: SKIA_SHIM };
  return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};
for (const ext of ["wasm", "woff2"]) if (!config.resolver.assetExts.includes(ext)) config.resolver.assetExts.push(ext);
module.exports = config;
