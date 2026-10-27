// What shows before the pages: the standalone sign-in, or (embedded) the wait for the host's init.
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { usePosterFonts } from "../fonts";
import { FF, SKINS, rgba } from "../features/ephemera/theme";
import { connect, useSession } from "./session";
import { SKIA_TEXT } from "./skiaReady";
import { useSkin } from "../features/ephemera/store";

const P = SKINS.ivory;
export const INIT_WAIT_MS = 10_000;
/** The waiting lines (正在打开… and the host waits) in the pages' own status-line style (home app LoadErr). */
export const LOADING_LINE = { fontSize: 13, opacity: 0.7 } as const;
export const GATE_TEXT = {
  base: "后台地址",
  baseHint: "留空 = 和这个页面同一个地址",
  token: "口令",
  enter: "进入",
  entering: "正在连接…",
  waitHost: "宿主还没有发来初始化消息",
  /** iframe without a registered host origin: the page cannot accept any message */
  needHost: "放在 iframe 里时，页面地址要带上 ?host=<宿主来源>（例如 ?host=https://app.example.com），页面才会接收宿主的消息",
  /** iframe, registered, still nothing after a while */
  waitHostIframe: "宿主还没有发来初始化消息。宿主要在收到 ready 之后发 init，并且只能从 ?host= 登记的来源发",
  failed: "初始化没有成功",
} as const;

function Login() {
  const s = useSession();
  const [base, setBase] = useState(s.apiBase);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    await connect(base, token.trim(), true).catch(() => {});
    setBusy(false);
  };
  const field = { width: 280, paddingVertical: 8, borderBottomWidth: 0.8, borderBottomColor: P.ink, fontFamily: FF.serif5, fontSize: 15, color: P.ink } as const;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: P.bg, gap: 18 }}>
      <Text style={{ fontFamily: FF.pf9, fontSize: 44, color: P.deep, letterSpacing: -0.5 }}>Ephemera</Text>
      <View style={{ gap: 4 }}>
        <Text style={{ fontFamily: FF.serif5, fontSize: 11, letterSpacing: 1.4, color: P.ink, opacity: 0.7 }}>{GATE_TEXT.base}</Text>
        <TextInput testID="login-base" value={base} onChangeText={setBase} placeholder={GATE_TEXT.baseHint} placeholderTextColor={rgba(P.sh, 0.45)}
          autoCapitalize="none" autoCorrect={false} inputMode="url" style={field} />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ fontFamily: FF.serif5, fontSize: 11, letterSpacing: 1.4, color: P.ink, opacity: 0.7 }}>{GATE_TEXT.token}</Text>
        <TextInput testID="login-token" value={token} onChangeText={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false}
          onSubmitEditing={go} style={field} />
      </View>
      {s.error ? <Text testID="login-error" style={{ width: 280, fontFamily: FF.serif5, fontSize: 12, color: P.deep }}>{s.error}</Text> : null}
      <Pressable testID="login-enter" onPress={go} disabled={busy} style={{ marginTop: 6, width: 280, height: 44, borderRadius: 22, backgroundColor: P.btn, alignItems: "center", justifyContent: "center", opacity: busy ? 0.6 : 1 }}>
        <Text style={{ fontFamily: FF.serif9, fontSize: 16, letterSpacing: 6, marginLeft: 6, color: "#fff" }}>{busy ? GATE_TEXT.entering : GATE_TEXT.enter}</Text>
      </Pressable>
    </View>
  );
}

function Waiting() {
  const s = useSession();
  const [late, setLate] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLate(true), INIT_WAIT_MS); return () => clearTimeout(t); }, []);
  const msg = s.phase === "failed" ? `${GATE_TEXT.failed} · ${s.error ?? ""}`
    : s.mode === "iframe" && !s.hostOrigin ? GATE_TEXT.needHost
      : late ? (s.mode === "iframe" ? GATE_TEXT.waitHostIframe : GATE_TEXT.waitHost) : null;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: P.bg }}>
      {msg ? <Text testID="gate-message" style={{ maxWidth: 300, textAlign: "center", fontFamily: FF.serif5, fontSize: LOADING_LINE.fontSize, lineHeight: 20, color: P.ink, opacity: LOADING_LINE.opacity }}>{msg}</Text> : null}
    </View>
  );
}

/** Signed in, the pages are waiting for CanvasKit: the same blank paper with one line; or why it could not load. */
export function SkiaWait({ failed }: { failed: boolean }) {
  usePosterFonts();
  const { P: S } = useSkin();   // in her skin's colours: the first page lands on the same ground
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: S.bg }}>
      {/* the pages' own status line (the home app's 没拉到 · … : serif 500, 13, ink at 0.7) */}
      <Text testID="skia-wait" style={{ maxWidth: 300, textAlign: "center", fontFamily: FF.serif5, fontSize: LOADING_LINE.fontSize, lineHeight: 20, color: S.ink, opacity: failed ? 0.85 : LOADING_LINE.opacity }}>
        {failed ? SKIA_TEXT.failed : SKIA_TEXT.loading}
      </Text>
    </View>
  );
}

export function Gate() {
  const s = useSession();
  usePosterFonts();
  if (s.mode === "standalone" && s.phase === "login") return <Login />;
  return <Waiting />;
}
