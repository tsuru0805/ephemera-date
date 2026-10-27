// One short line at the bottom of the screen for things that happen outside a page (a link that leads nowhere).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Text, View } from "react-native";
import { FF, SKINS } from "../features/ephemera/theme";

let msg: { text: string; n: number } | null = null;
const subs = new Set<() => void>();
export function showNotice(text: string) { msg = { text, n: (msg?.n ?? 0) + 1 }; subs.forEach((f) => f()); }

export function RootNotice() {
  const m = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => msg, () => msg);
  const op = useRef(new Animated.Value(0)).current;
  const [text, setText] = useState("");
  useEffect(() => {
    if (!m) return undefined;
    setText(m.text);
    Animated.timing(op, { toValue: 1, duration: 300, useNativeDriver: false }).start();
    const t = setTimeout(() => Animated.timing(op, { toValue: 0, duration: 300, useNativeDriver: false }).start(), 2400);
    return () => clearTimeout(t);
  }, [m, op]);
  const P = SKINS.ivory;
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 112, alignItems: "center", opacity: op, zIndex: 120 }}>
      <View style={{ paddingVertical: 7, paddingHorizontal: 14, backgroundColor: P.paper, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 6 } }}>
        <Text testID="root-notice" style={{ maxWidth: 320, fontFamily: FF.serif5, fontSize: 12, lineHeight: 18, color: P.ink }}>{text}</Text>
      </View>
    </Animated.View>
  );
}
