// Telegram paper for the telegrams list: an envelope (a date was sent) or a telegram (changed / cancelled / kept).
// Colours are the default "ivory" set; packaged fonts carry their weight in the file name (no fontWeight).
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import type { DateEvent } from "../../lib/ephemeraApi";
import { tzOffset } from "../../lib/tz";
import { F } from "../../fonts";
import { ff } from "./theme";

export interface DatePlanBrief { id: number; paper_no: string | null; title_en: string; date: string }

export const EPH = {
  page: "#F6E6E1",
  card: "#FBF4EF",
  ink: "#634458",
  title: "#A8435F",
  route: "#C15772",
  seal: "#D92662",
  sealHi: "#FFD9E3",
  envPaper: "#F8D6DE",
} as const;

const FF = {
  black: F.playfairBlack,
  bold: F.playfair,
  italic: F.playfairItalic,
  script: F.script,
  type: F.type,
  serif: "NotoSerifSC-Regular-app",
  serifBold: "NotoSerifSC-Bold-app",
} as const;

const SEAL_FILL = require("../../../assets/images/ephemera/seal_fill.png");
const SEAL_LINE = require("../../../assets/images/ephemera/seal_line.png");

function Wax({ size, style }: { size: number; style?: object }) {
  return (
    <View style={[{ width: size, height: size }, style]} pointerEvents="none">
      <Image source={SEAL_FILL} style={{ position: "absolute", left: 0, top: 0, width: size, height: size, tintColor: EPH.seal }} resizeMode="contain" />
      <Image source={SEAL_LINE} style={{ position: "absolute", left: 0, top: 0, width: size, height: size, tintColor: EPH.sealHi }} resizeMode="contain" />
    </View>
  );
}


const fmtMd = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
};
const fmtAt = (sec: number) => {
  const d = new Date((sec + tzOffset(sec)) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

// one card per event, in the order they happened
export function DateEventCard({ ev, plan, onOpen }: { ev: DateEvent; plan?: DatePlanBrief; onOpen?: () => void }) {
  const name = plan ? `「${plan.title_en.replace(/\n/g, " ")}」` : "";
  if (ev.kind === "envelope") {
    return (
      <Pressable style={st.envRow} onPress={onOpen} testID="date-envelope-card">
        <View style={st.env}>
          <View style={st.envV1} />
          <View style={st.envV2} />
          <Wax size={36} style={st.envWax} />
          <Text style={st.envScript}>Ephemera</Text>
          {plan?.paper_no ? <Text style={st.envNo}>NO. {plan.paper_no}</Text> : null}
        </View>
        <View style={st.envTx}>
          <Text style={st.envTitle}>{ev.text}</Text>
          {plan ? <Text style={st.envSub}>Ephemera · {fmtMd(plan.date)}</Text> : null}
          <Text style={[st.link, { marginTop: 14 }]}>拆开 ›</Text>
        </View>
      </Pressable>
    );
  }
  // telegram paper: something changed (telegram_auto/manual) / cancelled / kept in the box
  const line = ev.kind === "close" ? name : ev.kind === "cancel" ? "有一封电报" : "有一封新电报";
  const foot = ev.kind === "close" ? (plan?.paper_no ? `No. ${plan.paper_no}` : "") : name;
  return (
    <Pressable style={st.tele} onPress={onOpen} testID={`date-telegram-${ev.kind}`}>
      <View style={st.teleTop}>
        <Text style={st.teleBrand}>TELEGRAM</Text>
        <Text style={st.teleAt}>{fmtAt(ev.created_at)}</Text>
      </View>
      <View style={st.teleTop2} />
      {line ? <Text style={st.teleLine}>{line}</Text> : null}
      <View style={st.teleMsgWrap}>
        {/* 打字机体(Courier Prime)没有中文:含中文的电报整条用宋体(同一种字、字距不撑开);纯数字/英文照旧打字机体 */}
        <Text style={[st.teleMsg, { fontFamily: ff(ev.text ?? "", FF.type, FF.serif) }]}>{ev.text}</Text>
      </View>
      <View style={st.teleFt}>
        <Text style={st.teleFoot}>{foot}</Text>
        <Text style={st.link}>去看看 ›</Text>
      </View>
      {ev.kind === "cancel" ? (
        <View style={st.void} pointerEvents="none">
          <Text style={st.voidT}>CANCELLED</Text>
        </View>
      ) : null}
      {ev.kind === "close" ? (
        <View style={st.boxSeal} pointerEvents="none">
          <SvgXml xml={boxSealXml()} width={56} height={56} />
        </View>
      ) : null}
    </Pressable>
  );
}

function boxSealXml(): string {
  const pts = Array.from({ length: 24 }, (_, k) => {
    const a = (k / 24) * Math.PI * 2, r = k % 2 ? 26 : 29;
    return `${k ? "L" : "M"}${(30 + r * Math.cos(a)).toFixed(1)} ${(30 + r * Math.sin(a)).toFixed(1)}`;
  }).join("");
  return `<svg viewBox="0 0 60 60" width="56" height="56"><path d="${pts}Z" fill="${EPH.route}"/>
    <circle cx="30" cy="30" r="20" fill="none" stroke="#fff" stroke-width=".8" stroke-dasharray="1.5 2"/>
    <path d="M30 38 C22 32 23 24 30 28 C37 24 38 32 30 38Z" fill="#fff"/></svg>`;
}

const hair = "rgba(99,68,88,0.45)";
const shadow = { shadowColor: "#502832", shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: 0, height: 7 } };

const st = StyleSheet.create({
  capsXs: { fontFamily: FF.bold, fontSize: 6, letterSpacing: 1.6, color: EPH.ink, opacity: 0.8 },
  link: { fontFamily: FF.serif, fontSize: 11.5, letterSpacing: 1.4, color: EPH.route, textDecorationLine: "underline", textDecorationStyle: "dotted" },
  // envelope
  envRow: { height: 128, marginTop: 16, marginBottom: 12, flexDirection: "row" },
  env: { width: 176, height: 112, marginLeft: 6, marginTop: 6, backgroundColor: EPH.envPaper, transform: [{ rotate: "-3deg" }], overflow: "hidden", ...shadow },
  envV1: { position: "absolute", left: -10, top: -38, width: 120, height: 3, backgroundColor: "rgba(255,255,255,0.6)", transform: [{ rotate: "33deg" }, { translateY: 70 }] },
  envV2: { position: "absolute", right: -10, top: -38, width: 120, height: 3, backgroundColor: "rgba(255,255,255,0.6)", transform: [{ rotate: "-33deg" }, { translateY: 70 }] },
  envWax: { position: "absolute", left: 70, top: 44 },
  envScript: { position: "absolute", left: 12, bottom: 6, fontFamily: FF.script, fontSize: 19, color: EPH.title },
  envNo: { position: "absolute", right: 10, bottom: 11, fontFamily: FF.bold, fontSize: 6, letterSpacing: 1.5, color: EPH.ink, opacity: 0.8 },
  envTx: { marginLeft: 18, marginTop: 20 },
  envTitle: { fontFamily: FF.serifBold, fontSize: 15, letterSpacing: 0.9, color: EPH.title },
  envSub: { marginTop: 6, fontFamily: FF.italic, fontSize: 12, color: EPH.ink, opacity: 0.8 },
  // telegram
  tele: { alignSelf: "center", width: 322, marginVertical: 14, paddingBottom: 12, backgroundColor: EPH.card, ...shadow, shadowOpacity: 0.18 },
  teleTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginHorizontal: 12, paddingTop: 11, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: EPH.ink },
  teleTop2: { marginHorizontal: 12, height: 0, borderBottomWidth: 0.6, borderBottomColor: EPH.ink, marginTop: 1.6 },
  teleBrand: { fontFamily: FF.black, fontSize: 17, letterSpacing: 5.8, color: EPH.title },
  teleAt: { fontFamily: FF.type, fontSize: 9, color: EPH.ink, opacity: 0.75 },
  teleLine: { marginTop: 9, marginHorizontal: 12, fontFamily: FF.serif, fontSize: 11, letterSpacing: 1.1, color: EPH.ink, opacity: 0.75 },
  teleMsgWrap: { marginTop: 6, marginHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "rgba(99,68,88,0.22)" },
  teleMsg: { fontFamily: FF.type, fontSize: 13.5, lineHeight: 21, color: EPH.ink },
  teleFt: { marginTop: 8, marginHorizontal: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  teleFoot: { fontFamily: FF.italic, fontSize: 11, color: EPH.ink, opacity: 0.85 },
  void: { position: "absolute", right: 16, top: 44, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1.6, borderColor: EPH.route, transform: [{ rotate: "-9deg" }], opacity: 0.82 },
  voidT: { fontFamily: FF.black, fontSize: 13, letterSpacing: 2.8, color: EPH.route },
  boxSeal: { position: "absolute", right: 12, top: 36, transform: [{ rotate: "8deg" }] },
});
