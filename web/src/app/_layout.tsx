// Root of the web package: session (standalone / embedded / demo), the embedding channel, safe area,
// the page stack (routes are the package's own, not the host's) and the flight layer above it.
import { Stack } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaInsetsContext, SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { DemoBar } from "../demo/DemoBar";
import { FlightLayer } from "../features/ephemera/flight";
import { installHost, setLifecycle, setNavigateHandler, useHostSafeArea } from "../runtime/host";
import { Gate, SkiaWait } from "../runtime/Gate";
import { useSkiaReady } from "../runtime/skiaReady";
import { useFirstPageShown } from "../runtime/paintHold";
import { RootNotice } from "../runtime/notice";
import { goTo } from "../runtime/navigate";
import { detectMode, getSession, isEmbedded, startSession, useSession } from "../runtime/session";
import { startWebPush } from "../runtime/webPush";
import { startEventsWatch } from "../runtime/eventsWatch";
import { useRouter } from "../nav/router";
import { ephemeraStackOptions } from "../nav/stackOptions";

let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  startSession(detectMode());
  installHost();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => setLifecycle(document.hidden ? "background" : "active"));
    // the pages draw their own focus (underline / caret); no browser focus ring, no tap highlight, no page bounce
    const css = document.createElement("style");
    css.textContent = "input,textarea{outline:none!important}*{-webkit-tap-highlight-color:transparent}html,body{overscroll-behavior:none;touch-action:manipulation}";
    document.head.appendChild(css);
  }
}
boot();

/** The host's safe area wins over the browser's env(safe-area-inset-*). */
function Insets({ children }: { children: React.ReactNode }) {
  const measured = useSafeAreaInsets();
  const host = useHostSafeArea();
  return <SafeAreaInsetsContext.Provider value={host ?? measured}>{children}</SafeAreaInsetsContext.Provider>;
}

function Navigator() {
  const router = useRouter();
  useEffect(() => {
    setNavigateHandler((t) => { void goTo(router, t); });
    return () => setNavigateHandler(null);
  }, [router]);
  useEffect(() => { if (isEmbedded()) startEventsWatch(); else if (getSession().mode === "standalone") startWebPush(); }, []);
  return (
    <>
      <Stack screenOptions={({ route }) => ({ headerShown: false, contentStyle: s.transparent, ...ephemeraStackOptions(route.name, route.params) })} />
      <FlightLayer />
    </>
  );
}

export default function RootLayout() {
  const session = useSession();
  const skia = useSkiaReady();
  const firstShown = useFirstPageShown();
  return (
    <GestureHandlerRootView style={s.root}>
      <SafeAreaProvider>
        <Insets>
          <View style={s.root}>
            {session.phase !== "ready" ? <Gate /> : skia.state === "ready" ? <Navigator /> : <SkiaWait failed={skia.state === "failed"} />}
            {/* the loading line stays over the first page until that page has drawn (runtime/paintHold.tsx) */}
            {session.phase === "ready" && skia.state === "ready" && !firstShown ? <View style={StyleSheet.absoluteFill}><SkiaWait failed={false} /></View> : null}
            {session.mode === "demo" && session.phase === "ready" && skia.state === "ready" ? <DemoBar /> : null}
            <RootNotice />
          </View>
        </Insets>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FBF6EF" },
  transparent: { backgroundColor: "transparent" },
});
