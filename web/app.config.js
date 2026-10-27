// Expo config for the Ephemera web package (web only; no native build is configured here).
// EPHEMERA_WEB_BASE = path the site is served under, e.g. "/app" (engine) or "/ephemera-date" (GitHub Pages).
const base = (process.env.EPHEMERA_WEB_BASE ?? "/app").replace(/\/+$/, "");

module.exports = {
  expo: {
    name: "Ephemera",
    slug: "ephemera-date-web",
    version: "0.1.0",
    orientation: "portrait",
    scheme: "ephemera",
    userInterfaceStyle: "light",
    platforms: ["web"],
    web: { output: "single", bundler: "metro", name: "Ephemera", shortName: "Ephemera", lang: "zh", themeColor: "#FBF6EF", backgroundColor: "#FBF6EF" },
    plugins: ["expo-router"],
    experiments: { typedRoutes: false, baseUrl: base },
    extra: { webBase: base },
  },
};
