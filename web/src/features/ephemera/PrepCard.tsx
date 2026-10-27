// Ephemera ⑦ 准备清单(原型 prepCard):信封不用拆就能看。他写四类——提前准备 / 穿什么 / 带什么 / 天气。
// 点一条画上勾(勾记在引擎,换手机也在);全部勾完,一张贴纸贴上来封好清单。约会结束后收进纪念盒平铺页(只读)。
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import Svg, { Path } from "react-native-svg";
import type { HerState, Plan } from "../../lib/ephemeraApi";
import { prepMarkKey } from "../../lib/ephemeraApi";
import { Paper, Svg as SvgBox } from "./components";
import { isCheckable, paperNo, prepGroups } from "./format";
import { deckle, stampXml } from "./shapes";
import { FF, rgba, type Skin } from "./theme";

const APath = Animated.createAnimatedComponent(Path);
export const PREP_W = 338;

export function prepHeight(plan: Plan): number {
  let y = 116;
  for (const g of prepGroups(plan.prep)) {
    y += 12 + g.items.reduce((h, it) => h + (!isCheckable(it) ? 24 : it.detail ? 47 : 32), 0) + 12;
  }
  return Math.max(600, y + 96);
}

/** k=按多大画(纪念盒平铺页 0.5、拿起来看 0.95):直接按这个尺寸排字,不整张缩放——缩放会让字发糊 */
export function PrepCard({ plan, her, P, live, onToggle, k = 1 }: { plan: Plan; her: HerState | null; P: Skin; live: boolean; onToggle?: (key: string, on: boolean) => void; k?: number }) {
  const u = (n: number) => n * k;
  const W = u(PREP_W), H = u(prepHeight(plan));
  const keys = plan.prep.filter(isCheckable).map(prepMarkKey);
  // 收进纪念盒以后(live=false)清单是封好的样子:全勾 + 封标(原型 prepCard(a, false))
  const done = (k: string) => !live || !!her?.marks[k];
  const sealed = keys.length > 0 && keys.every(done);
  let y = u(116);
  const rows = prepGroups(plan.prep).map((g) => {
    const top = y;
    y += u(12 + g.items.reduce((h, it) => h + (!isCheckable(it) ? 24 : it.detail ? 47 : 32), 0) + 12);
    return (
      <View key={g.key} style={{ position: "absolute", left: u(34), right: u(34), top, borderTopWidth: 0.8, borderTopColor: rgba(P.sh, 0.3), paddingTop: u(12), flexDirection: "row" }}>
        <View style={{ width: u(78) }}>
          <Text style={{ fontFamily: FF.pf7, fontSize: u(7.5), letterSpacing: u(2), color: P.deep }}>{g.en.toUpperCase()}</Text>
          <Text style={{ marginTop: u(4), fontFamily: FF.serif5, fontSize: u(9.5), letterSpacing: u(1.9), color: P.ink, opacity: 0.7 }}>{g.zh}</Text>
        </View>
        <View style={{ flex: 1 }}>
          {g.items.map((it) => {
            if (!isCheckable(it)) return <Text key={it.text} style={{ fontFamily: FF.serif5, fontSize: u(14), letterSpacing: u(0.8), color: P.ink, height: u(24) }}>{it.text}</Text>;
            const mk = prepMarkKey(it);
            return <Check key={mk} k={k} on={done(mk)} P={P} text={it.text} detail={it.detail} disabled={!live} onPress={() => onToggle?.(mk, !done(mk))} />;
          })}
        </View>
      </View>
    );
  });
  return (
    <View style={{ width: W, height: H }}>
      <Paper w={W} h={H} d={deckle(W, H, 1.8 * k, 4 * k)} fill={P.paper} sh={P.sh} shadow="none" />
      <View style={{ position: "absolute", left: u(10), top: u(10), right: u(10), bottom: u(10), borderWidth: 1.1 * Math.max(k, 0.6), borderColor: P.deep }} pointerEvents="none" />
      <View style={{ position: "absolute", left: u(13), top: u(13), right: u(13), bottom: u(13), borderWidth: 0.5, borderColor: P.deep }} pointerEvents="none" />
      <Text style={{ position: "absolute", left: 0, right: 0, top: u(34), textAlign: "center", fontFamily: FF.script, paddingRight: u(8), fontSize: u(34), color: P.deep }}>Before the date</Text>
      <Text style={{ position: "absolute", left: 0, right: 0, top: u(82), textAlign: "center", fontFamily: FF.serif7, fontSize: u(7.5), letterSpacing: u(2.2), color: P.ink }}>{`NO. ${paperNo(plan)} · 准备清单`}</Text>
      {rows}
      <Text style={{ position: "absolute", left: 0, right: 0, bottom: u(34), textAlign: "center", fontFamily: FF.serif5, fontSize: u(11), letterSpacing: u(2.6), color: P.ink, opacity: 0.6 }}>
        {sealed || !live ? "准备好了" : ""}
      </Text>
      <PrepSeal on={sealed || !live} W={W} H={H} P={P} k={k} />
    </View>
  );
}

/** 勾满:盖一枚橡皮章(同请柬 TOP SECRET 那种章;原型的贴纸判不搭) */
function PrepSeal({ on, W, H, P, k = 1 }: { on: boolean; W: number; H: number; P: Skin; k?: number }) {
  const t = useSharedValue(on ? 1 : 0);
  useEffect(() => { t.value = on ? withTiming(1, calm(320)) : withTiming(0, { duration: 200 }); }, [on, t]);
  const st = useAnimatedStyle(() => ({
    opacity: Math.min(1, t.value * 1.4),
    transform: [{ translateX: 40 * k * (1 - t.value) }, { translateY: -90 * k * (1 - t.value) }, { rotate: `${-9 + 35 * (1 - t.value)}deg` }, { scale: 1 + 0.5 * (1 - t.value) }],
  }));
  return (
    <Animated.View style={[{ position: "absolute", left: W - 124 * k, top: H - 124 * k, width: 104 * k, height: 104 * k, opacity: 0.85 }, st]} pointerEvents="none">
      <SvgBox xml={stampXml("READY · BEFORE THE DATE · ", "", P.deep, 104 * k)} w={104 * k} h={104 * k} style={{ left: 0, top: 0 }} />
    </Animated.View>
  );
}

function Check({ on, P, text, detail, disabled, onPress, k = 1 }: { on: boolean; P: Skin; text: string; detail: string | null; disabled: boolean; onPress: () => void; k?: number }) {
  const u = (n: number) => n * k;
  const off = useSharedValue(on ? 0 : 34);
  useEffect(() => { off.value = withTiming(on ? 0 : 34, { duration: 350 }); }, [on, off]);
  const ap = useAnimatedProps(() => ({ strokeDashoffset: off.value }));
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={4} style={{ paddingLeft: u(28), marginBottom: u(12) }} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <View style={{ position: "absolute", left: 0, top: u(3), width: u(15), height: u(15), borderWidth: 1.2 * Math.max(k, 0.6), borderColor: P.deep, borderRadius: u(2) }} />
      <Svg width={u(22)} height={u(18)} viewBox="0 0 24 20" style={{ position: "absolute", left: -u(1), top: -u(4) }}>
        <APath d="M2 11 C5 13 7 16 8.5 18 C11 11 16 5 22 1.5" fill="none" stroke={P.deep} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={34} animatedProps={ap} />
      </Svg>
      <Text style={{ fontFamily: FF.serif5, fontSize: u(14), letterSpacing: u(0.6), color: P.ink }}>{text}</Text>
      {detail ? <Text style={{ marginTop: u(2), fontFamily: FF.serif5, fontSize: u(11), color: P.ink, opacity: 0.6 }}>{detail}</Text> : null}
    </Pressable>
  );
}
