// 迟到的请柬:同一张请柬纸(毛边 + 双框 + 花),
// 抬头过去时 You were invited / A LATE INVITATION · SENT AFTER THE DAY;正文=他写的请柬;两枚邮戳=写信那天 + 寄往的那天。
// 他还没写时这张纸不出现(由平铺页按 invitePaper 决定)。
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import type { Plan } from "../../lib/ephemeraApi";
import { Art, Paper, PaperTex, Svg as SvgBox, useStage } from "./components";
import { dateParts, fitZh, placeName, titleOne, titleZh } from "./format";
import { deckle, stampXml } from "./shapes";
import { FF, rgba, type Skin } from "./theme";

export const LATE_W = 330, LATE_H = 560;

export function LateInvite({ plan, P, posted, to, f = 1 }: { plan: Plan; P: Skin; posted: string | null; to: string; f?: number }) {
  // f=整张按比例缩(平铺页那张);直接按 f 排字号与位置,不用 transform scale(缩放变换会把字和纸纹按位图缩,发糊)
  const W = LATE_W * f;
  const s0 = plan.stops[0];
  // 中文名单行(两侧各让 36):放不下缩,到 11 截短「⋯」(都随 f 等比)
  const zhL = titleZh(plan) ? fitZh(titleZh(plan)!, 13.75 * f, 11 * f, 0.35, W - 72 * f) : null;
  const rows: Array<[string, string]> = [["Time", s0?.time ? `${s0.time} 〜` : "—"], ["Meet", s0 ? placeName(s0) : "—"], ["Stops", `${plan.stops.length} 站`]];
  // 正文长了往下推:表格起点至少在 340(小样),纸跟着加高,邮戳永远压在底边
  const [bodyH, setBodyH] = useState(0);
  const rowsTop = Math.max(340 * f, 230 * f + bodyH + 20 * f);
  const H = Math.max(LATE_H * f, rowsTop + (3 * 34 + 150) * f);
  const st = 78 * f;
  return (
    <View style={{ width: W, height: H }}>
      <Paper w={W} h={H} d={deckle(W, H, 1.8, 4)} fill={P.paper} sh={P.sh} texture={0.6} />
      <View style={{ position: "absolute", left: 10 * f, top: 10 * f, right: 10 * f, bottom: 10 * f, borderWidth: 1.1, borderColor: P.deep }} />
      <View style={{ position: "absolute", left: 13 * f, top: 13 * f, right: 13 * f, bottom: 13 * f, borderWidth: 0.5, borderColor: P.deep }} />
      <Art name="florals" color={P.deep} style={{ right: 14 * f, top: 14 * f, width: 76 * f, height: 76 * f, opacity: 0.4, transform: [{ scaleX: -1 }] }} />
      <View style={{ position: "absolute", left: 0, right: 0, top: 44 * f, alignItems: "center" }}>
        <Text style={{ fontFamily: FF.script, paddingRight: 8 * f, fontSize: 30 * f, lineHeight: 34 * f, color: P.deep }}>You were invited</Text>
        <Text style={{ marginTop: 6 * f, fontFamily: FF.pf7, fontSize: 6.5 * f, letterSpacing: 2.08 * f, color: P.ink }}>A LATE INVITATION · SENT AFTER THE DAY</Text>
        <Text style={{ marginTop: 18 * f, textAlign: "center", fontFamily: FF.pf9, fontSize: 30 * f, lineHeight: 32 * f, letterSpacing: 0.9 * f, color: P.deep }}>{titleOne(plan).toUpperCase()}</Text>
        {/* 中文名小字(迷你请柬 24→11,这张 30→13.75,字距 .35em) */}
        {zhL ? <Text testID="late-zh" numberOfLines={1} style={{ marginTop: 6 * f, marginLeft: zhL.size * 0.35, maxWidth: (W - 72 * f), fontFamily: FF.serif5, fontSize: zhL.size, lineHeight: 18 * f, letterSpacing: zhL.size * 0.35, color: P.deep }}>{zhL.text}</Text> : null}
        <Text style={{ marginTop: 14 * f, fontFamily: FF.pf7, fontSize: 18 * f, color: P.ink }}>{dateParts(plan.date).long}</Text>
      </View>
      <Text onLayout={(e) => setBodyH(e.nativeEvent.layout.height)} style={{ position: "absolute", left: 36 * f, right: 36 * f, top: 230 * f, fontFamily: FF.serif5, fontSize: 12 * f, lineHeight: 22.8 * f, color: P.ink, opacity: 0.6 }}>{plan.invite ?? ""}</Text>
      <View style={{ position: "absolute", left: 30 * f, right: 30 * f, top: rowsTop }}>
        {rows.map(([k, v]) => (
          <View key={k} style={{ flexDirection: "row", borderTopWidth: 0.6, borderTopColor: rgba(P.sh, 0.3), paddingVertical: 8 * f }}>
            <Text style={{ width: 72 * f, paddingTop: 2 * f, fontFamily: FF.pf7, fontSize: 7 * f, letterSpacing: 1.54 * f, color: P.deep }}>{k.toUpperCase()}</Text>
            <Text numberOfLines={2} style={{ flex: 1, fontFamily: FF.serif5, fontSize: 11.5 * f, lineHeight: 17.25 * f, color: P.ink }}>{v}</Text>
          </View>
        ))}
      </View>
      {posted ? <SvgBox xml={stampXml(`POSTED · ${posted} · `, "", P.deep, 78)} w={st} h={st} style={{ left: 22 * f, bottom: 30 * f, opacity: 0.85, transform: [{ rotate: "-14deg" }] }} /> : null}
      <SvgBox xml={stampXml(`TO · ${to} · `, "", P.deep, 78)} w={st} h={st} style={{ right: 26 * f, bottom: 44 * f, opacity: 0.85, transform: [{ rotate: "9deg" }] }} />
    </View>
  );
}

/** 平铺页上那张(压在原请柬的位置,按 236 宽排) */
export function LateInviteMini(props: { plan: Plan; P: Skin; posted: string | null; to: string }) {
  return <LateInvite {...props} f={236 / LATE_W} />;
}

/** 拿起来看(小样 lateView:纸色底 + 纸纹 + 一层淡阴影,纸在 top 118 斜 -2°,右上 ×)。
 *  正文长了纸会加高:整层可以上下滑,邮戳在纸底,滑到底总看得见;点纸外面或 × 放下 */
export function LateInvitePop({ plan, P, posted, to, onClose }: { plan: Plan; P: Skin; posted: string | null; to: string; onClose: () => void }) {
  const { s: sc, top, H } = useStage();
  const [paperH, setPaperH] = useState(LATE_H);
  const t = useSharedValue(0);
  useEffect(() => { t.value = withTiming(1, calm()); }, [t]);
  const st = useAnimatedStyle(() => ({ opacity: Math.min(1, t.value * 2), transform: [{ translateY: 40 * (1 - t.value) }, { rotate: "-2deg" }] }));
  const contentH = Math.max(H, 118 + paperH + 80);
  return (
    <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: P.paper2, zIndex: 15 }} testID="late-invite-pop">
      <PaperTex opacity={0.7} />
      <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.18) }} pointerEvents="none" />
      <View style={{ position: "absolute", left: 0, top, width: 390, height: H, transform: [{ scale: sc }], transformOrigin: "top left" }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ height: contentH }} showsVerticalScrollIndicator={false} testID="late-invite-scroll">
          <Pressable onPress={onClose} style={{ position: "absolute", left: 0, top: 0, width: 390, height: contentH }} accessibilityLabel="放下" />
          <Animated.View style={[{ position: "absolute", left: (390 - LATE_W) / 2, top: 118 }, st]} onLayout={(e) => setPaperH(e.nativeEvent.layout.height)}>
            <LateInvite plan={plan} P={P} posted={posted} to={to} />
          </Animated.View>
        </ScrollView>
        <Pressable onPress={onClose} style={{ position: "absolute", right: 16, top: 40, width: 40, height: 40, alignItems: "center", justifyContent: "center" }} accessibilityLabel="关上">
          <Text style={{ fontFamily: FF.corm, fontSize: 26, color: P.deep }}>×</Text>
        </Pressable>
      </View>
    </View>
  );
}
