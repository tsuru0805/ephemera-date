// Ephemera ④ Me 页(原型 meView):四套皮肤,整套一起换(首页/大票/信封/请柬/地图页都跟着)。
// 原型那句说明「整套一起换:……」按正式 App 不放说明句的规矩不放;原型里的对照页入口不搬。
import { type Href } from "../../nav/router";
import { Pressable, Text, View } from "react-native";
import { DotLink, NAV_H, NavBar, Stage, useStage } from "./components";
import { getSession, logout } from "../../runtime/session";
import { PUSH_TEXT, usePushState } from "../../runtime/webPush";
import { perf } from "./shapes";
import { nextPlan, setSkin, usePlans, useSkin } from "./store";
import { FF, PLAN_COLORS, SKINS, SKIN_ORDER } from "./theme";
import Svg, { Path } from "react-native-svg";

export function EphemeraMeScreen() {
  const { key, P } = useSkin();
  const { plans } = usePlans();
  const next = plans ? nextPlan(plans) : null;
  const past = [PLAN_COLORS.rose, PLAN_COLORS.cream, PLAN_COLORS.sky, PLAN_COLORS.berry];
  const push = usePushState();
  const { s, insets } = useStage();
  const standalone = getSession().mode === "standalone";
  // the lowest control above the bar: the skins (to 612), or the sign-in lines under them (from 652); a shorter screen
  // scrolls to it
  const minH = (standalone ? 720 : 624) + (NAV_H + insets.bottom) / s;
  return (
    <Stage P={P} minH={minH} overlay={<NavBar on="Me" P={P} dateHref={next ? (`/ephemera-day?id=${next.id}` as Href) : null} />}>
      <Text style={{ position: "absolute", left: 22, top: 48, fontFamily: FF.pf9, fontSize: 40, color: P.deep }}>Me</Text>
      <Text style={{ position: "absolute", left: 26, top: 96, fontFamily: FF.script, paddingRight: 8, fontSize: 19, color: P.deep }}>How the box looks</Text>
      {SKIN_ORDER.map((k, i) => {
        const q = SKINS[k], x = 24 + (i % 2) * 176, y = 160 + Math.floor(i / 2) * 236, on = k === key;
        return (
          <Pressable key={k} onPress={() => setSkin(k)} style={{ position: "absolute", left: x, top: y, width: 166, height: 216, backgroundColor: q.bg, borderRadius: 6, overflow: "hidden",
            borderWidth: on ? 2.5 : 1, borderColor: on ? q.btn : "rgba(0,0,0,0.08)", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 9, shadowOffset: { width: 0, height: 8 } }} accessibilityLabel={q.name} accessibilityState={{ selected: on }}>
            <Text style={{ position: "absolute", left: 12, top: 12, fontFamily: FF.pf9, fontSize: 17, color: q.deep }}>Invitation Box</Text>
            <Svg style={{ position: "absolute", left: 12, top: 44 }} width={142} height={64}><Path d={perf(142, 64, 3, 10)} fill={q.big.c} /></Svg>
            <View style={{ position: "absolute", left: 12 + 142 - 52, top: 52, width: 44, height: 48, backgroundColor: q.big.panel }} />
            <View style={{ position: "absolute", left: 22, top: 56, width: 60, height: 6, backgroundColor: q.big.l }} />
            <View style={{ position: "absolute", left: 22, top: 68, width: 44, height: 6, backgroundColor: q.big.l, opacity: 0.6 }} />
            {past.map((t, j) => (
              <Svg key={j} style={{ position: "absolute", left: 12 + j * 36, top: 118 }} width={30} height={48}><Path d={perf(30, 48, 2, 7)} fill={t.c} /></Svg>
            ))}
            <View style={{ position: "absolute", left: 12, right: 12, top: 178, height: 24, borderRadius: 12, backgroundColor: q.btn, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontFamily: FF.serif5, fontSize: 11, color: "#fff" }}>{q.name}{on ? " · 使用中" : ""}</Text>
            </View>
          </Pressable>
        );
      })}
      {standalone ? (
        <View style={{ position: "absolute", left: 26, top: 652, gap: 14 }}>
          {push.state === "off" || push.state === "busy" ? (
            <DotLink color={P.deep} onPress={push.state === "off" ? push.turnOn : undefined} label={PUSH_TEXT.on} style={{ fontFamily: FF.serif5, fontSize: 12, letterSpacing: 2 }}>{PUSH_TEXT.on}</DotLink>
          ) : push.state === "on" ? (
            <Text style={{ fontFamily: FF.serif5, fontSize: 12, letterSpacing: 2, color: P.ink, opacity: 0.7 }}>{PUSH_TEXT.done}</Text>
          ) : null}
          {push.err ? <Text style={{ fontFamily: FF.serif5, fontSize: 11, color: P.ink, opacity: 0.8 }}>{`${PUSH_TEXT.failed} · ${push.err}`}</Text> : null}
          <DotLink color={P.ink} onPress={logout} label="退出登录" style={{ fontFamily: FF.serif5, fontSize: 12, letterSpacing: 2 }}>退出登录</DotLink>
        </View>
      ) : null}
    </Stage>
  );
}
