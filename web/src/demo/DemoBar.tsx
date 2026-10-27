// The demo's only extra control: move the clock to the next moment of the date (sent → the day → each stop → over).
import { useSyncExternalStore } from "react";
import { Pressable, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FF, SKINS, rgba } from "../features/ephemera/theme";
import { refreshAll } from "../runtime/host";
import { demoVersion, fastForward, nextStepLabel, resetDemo, subscribeDemo } from "./server";
import { router, HOME } from "../nav/router";

export const DEMO_TEXT = { tag: "试玩", restart: "重新开始试玩" } as const;

export function DemoBar() {
  useSyncExternalStore(subscribeDemo, demoVersion, demoVersion);
  const insets = useSafeAreaInsets();
  const label = nextStepLabel();
  const P = SKINS.ivory;
  const press = () => {
    if (label) { fastForward(); refreshAll(); return; }
    resetDemo(); router.replace(HOME as never); refreshAll();
  };
  return (
    <Pressable testID="demo-step" onPress={press} accessibilityLabel={label ?? DEMO_TEXT.restart}
      style={{ position: "absolute", top: insets.top + 6, right: 8, zIndex: 110, flexDirection: "row", alignItems: "center", gap: 6,
        paddingVertical: 5, paddingHorizontal: 10, borderRadius: 13, backgroundColor: P.paper, borderWidth: 0.8, borderColor: rgba(P.sh, 0.3),
        shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.2, shadowRadius: 5, shadowOffset: { width: 0, height: 3 } }}>
      <Text style={{ fontFamily: FF.serif7, fontSize: 10, letterSpacing: 1.2, color: P.deep }}>{DEMO_TEXT.tag}</Text>
      <Text style={{ fontFamily: FF.serif5, fontSize: 11, color: P.ink }}>{label ?? DEMO_TEXT.restart}</Text>
    </Pressable>
  );
}
