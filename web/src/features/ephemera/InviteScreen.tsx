// Ephemera ③ 请柬(原型 openView):毛边纸 + 双框 + 时间 / 地点(当天公开)/ 着装 / 要带的东西 + TOP SECRET 章;
// 底部「开始今天」。着装、要带的东西取自准备清单「穿什么」「带什么」;地点=第 1 站,公开了才写名字。
import { type Href, useLocalSearchParams, useRouter } from "../../nav/router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import { Art, BackKey, FitLine, FoilLine, Paper, pressIn, Stage, Svg, FitText } from "./components";
import { dateParts, fitZh, placeName, titleLines, titleZh } from "./format";
import { deckle, secretXml } from "./shapes";
import { getLocal, usePlan, useSkin } from "./store";
import { ephemeraApi } from "../../lib/ephemeraApi";
import { LoadErr } from "./DayScreen";
import { PrepCard } from "./PrepCard";
import { PrepPop } from "./SealScreen";
import { FF, rgba } from "./theme";
import { FlightSpot, fly } from "./flight";
import { himName } from "../../runtime/session";

const CW = 346, CH = 640;
/** The lowest control (「先收进邀请盒」, top 798): a shorter screen scrolls to it */
export const INVITE_MIN_H = 818;
const ZH_BIG_W = CW - 80; // 大请柬中文名一行的宽度(两侧框线 + 花各让 40)

function LineIn({ delay, children, style }: { delay: number; children: React.ReactNode; style?: object }) {
  const t = useSharedValue(0);
  useEffect(() => { t.value = withDelay(delay, withTiming(1, { duration: 700, easing: Easing.bezier(0.22, 1, 0.36, 1) })); }, [t, delay]);
  const st = useAnimatedStyle(() => ({ opacity: t.value, transform: [{ translateY: 10 * (1 - t.value) }] }));
  return <Animated.View style={[style, st]}>{children}</Animated.View>;
}

export function EphemeraInviteScreen() {
  const sp = useLocalSearchParams<{ id: string; m?: string }>();
  const id = Number(sp.id);
  const flewIn = sp.m === "1";   // 请柬是飞进来的(飞行层落在这里)=不再自己从下往上弹,否则落点对不上、会跳
  const router = useRouter();
  const { P } = useSkin();
  const { plan, her, mark, error, replace } = usePlan(id);
  const [prep, setPrep] = useState(false);
  // 不藏行程:拆开要引擎记下才全开。拆信封那一下没报上(或请柬先读到了没拆的样子)=这里再报一次;
  // 报不上写明原因,点一下再试(不静默)
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const tell = async () => {
    if (!plan || opening) return;
    setOpening(true); setOpenErr(null);
    try { replace(await ephemeraApi.open(plan.id)); } catch (e) { setOpenErr((e as Error).message || "网络没回应"); } finally { setOpening(false); }
  };
  const needTell = !!plan?.open_itinerary && plan.opened_at == null && plan.status !== "cancelled";
  useEffect(() => {
    if (!needTell || !plan) return;
    getLocal(plan.id).then((l) => { if (l.opened) tell(); }).catch(() => {});
  }, [needTell, plan?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const enter = useSharedValue(0), stamp = useSharedValue(0);
  useEffect(() => {
    if (!plan) return;
    enter.value = flewIn ? 1 : withTiming(1, calm());
    stamp.value = withDelay(1100, withTiming(1, { duration: 450, easing: Easing.bezier(0.6, -0.4, 0.7, 1.4) }));
  }, [plan?.id, enter, stamp]);
  const cardSt = useAnimatedStyle(() => ({ opacity: Math.min(1, enter.value * 1.5), transform: [{ translateY: 120 * (1 - enter.value) }, { scale: 0.92 + 0.08 * enter.value }] }));
  const stampSt = useAnimatedStyle(() => ({ opacity: 0.85 * stamp.value, transform: [{ rotate: "-12deg" }, { scale: 1.6 - 0.6 * stamp.value }] }));

  if (!plan) return <Stage P={P}><BackKey color={P.deep} top={28} onPress={() => router.back()} />{error ? <LoadErr P={P} msg={error} /> : null}</Stage>;
  const prepLive = plan.status === "sent" || plan.status === "live";
  const [t1, t2] = titleLines(plan);
  const zhBig = titleZh(plan) ? fitZh(titleZh(plan)!, 15.5, 12, 0.35, ZH_BIG_W) : null; // 单行:放不下缩,到 12 截短「⋯」
  const dp = dateParts(plan.date);
  const s0 = plan.stops[0];
  const wear = plan.prep.filter((p) => p.section === "wear").map((p) => p.text);
  const bring = plan.prep.filter((p) => p.section === "bring").map((p) => p.text);
  // 不藏行程且引擎已记下拆开:一站一行「时间 地点」(第一站的时间就是集合时间,不再单列 Time;小样 p3 openView ?open=1)
  const route = !!plan.open_itinerary && plan.opened_at != null && plan.stops.some((x) => x.place);
  const rows: Array<[string, string]> = [
    ...(route ? [["Route", ""] as [string, string]] : [["Time", `${s0?.time ?? "—"} 〜`] as [string, string],
      ["Place", s0?.place ? placeName(s0) : "（当天公开）"] as [string, string]]),
    ...(wear.length ? [["Dress code", wear.join(" · ")] as [string, string]] : []),
    ...(bring.length ? [["Bring", bring.map((b) => `· ${b}`).join("\n")] as [string, string]] : []),
  ];

  return (
    <Stage P={P} minH={INVITE_MIN_H} overlay={prep ? (
      <Pressable style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.4), zIndex: 45 }} onPress={() => setPrep(false)}>
        <PrepPop onClose={() => setPrep(false)}>
          <PrepCard plan={plan} her={her} P={P} live={prepLive} onToggle={(k, on) => { mark(k, on).catch(() => {}); }} />
        </PrepPop>
      </Pressable>
    ) : null}>
      <BackKey color={P.deep} top={28} onPress={() => fly(`invite:${plan.id}`, `bigT:${plan.id}`, () => router.back(), { dur: 720, back: true })} />
      <FlightSpot k={`invite:${plan.id}`} style={[{ position: "absolute", left: 22, top: 70, width: CW, height: CH }, cardSt]}>
        <Paper w={CW} h={CH} d={deckle(CW, CH)} fill={P.paper} sh={P.sh} />
        <View style={{ position: "absolute", left: 12, top: 12, right: 12, bottom: 12, borderWidth: 1.4, borderColor: P.deep }} pointerEvents="none">
          <View style={{ position: "absolute", left: 4, top: 4, right: 4, bottom: 4, borderWidth: 0.6, borderColor: P.deep }} />
        </View>
        <Art name="florals" color={P.deep} style={{ right: 14, top: 14, width: 84, height: 84, opacity: 0.4, transform: [{ scaleX: -1 }] }} />
        <View style={{ position: "absolute", left: 0, right: 0, top: 44, alignItems: "center" }}>
          <LineIn delay={0}><Text style={[{ fontFamily: FF.script, paddingRight: 8, fontSize: 30, color: P.deep }, pressIn]}>You're invited</Text></LineIn>
          <LineIn delay={80}>
            <View style={{ marginTop: 10, width: ZH_BIG_W }}>
              {[t1, t2].filter(Boolean).map((t, q) => <FitLine key={q} style={[{ textAlign: "center", fontFamily: FF.pf9, fontSize: 34, lineHeight: 34, letterSpacing: 1.4, color: P.deep }, pressIn]}>{t.toUpperCase()}</FitLine>)}
            </View>
          </LineIn>
          {/* 中文名小字(迷你请柬 24→11,这张 34→15.5,字距 .35em) */}
          {zhBig ? <LineIn delay={160}><Text testID="invite-big-zh" numberOfLines={1} style={[{ marginTop: 6, marginLeft: zhBig.size * 0.35, maxWidth: ZH_BIG_W, fontFamily: FF.serif5, fontSize: zhBig.size, lineHeight: 20, letterSpacing: zhBig.size * 0.35, color: P.deep }, pressIn]}>{zhBig.text}</Text></LineIn> : null}
          <LineIn delay={240}>
            <Text style={{ marginTop: 18, fontFamily: FF.pf7, fontSize: 24, color: P.ink }}>
              {dp.long} <Text style={{ fontFamily: FF.pf7I, fontSize: 18 }}>{dp.dow}</Text>
            </Text>
          </LineIn>
        </View>
        {/* 拆开以后,准备清单从请柬上的这几行进(着装/要带的就来自清单;原型只在信封页有入口) */}
        <Pressable onPress={() => plan.prep.length && setPrep(true)} style={{ position: "absolute", left: 34, right: 34, top: 282, borderBottomWidth: 1, borderBottomColor: rgba(P.sh, 0.28) }} accessibilityLabel="准备清单">
          {rows.map(([k, v], i) => (
            <LineIn key={k} delay={320 + i * 70} style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: rgba(P.sh, 0.28) }}>
              <View style={{ width: 100, paddingHorizontal: 10, paddingTop: 13, paddingBottom: 11, borderRightWidth: 1, borderRightColor: rgba(P.sh, 0.28) }}>
                <Text style={[{ fontFamily: FF.pf7, fontSize: 9, letterSpacing: 2, color: P.deep }, pressIn]}>{k.toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 11 }}>
                {k === "Route" ? plan.stops.map((x) => (
                  <Text key={x.stop_id} numberOfLines={1} testID="invite-route-row" style={[{ fontFamily: FF.serif5, fontSize: 14, lineHeight: 22, color: P.ink }, pressIn]}>
                    <Text style={{ fontFamily: FF.pf7, fontSize: 12, color: P.deep }}>{`${x.time ?? "—"}  `}</Text>{x.place ? placeName(x) : "（当天公开）"}
                  </Text>
                )) : <Text style={[{ fontFamily: FF.serif5, fontSize: 14, lineHeight: 22, color: P.ink }, pressIn]}>{v}</Text>}
              </View>
            </LineIn>
          ))}
        </Pressable>
        {/* 「最下面那行字母快飞出去了」:原来歪 6° 贴着框线 → 摆正、收在内框里(两种请柬同一行) */}
        <FitText numberOfLines={1} adjustsFontSizeToFit style={{ position: "absolute", left: 34, right: 34, bottom: 40, textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 19, color: P.deep }}>Good company makes a good day.</FitText>
        {/* 不藏行程:没另外藏东西就不盖 TOP SECRET(小样 ?open=1) */}
        {route ? null : <Animated.View style={[{ position: "absolute", right: 44, bottom: 96, width: 120, height: 51 }, stampSt]} pointerEvents="none">
          <Svg xml={secretXml(P.deep)} w={120} h={51} />
        </Animated.View>}
      </FlightSpot>

      {needTell && openErr ? (
        <Pressable onPress={tell} disabled={opening} testID="invite-open-err" accessibilityLabel="再告诉一次"
          style={{ position: "absolute", left: 34, right: 34, top: 690, alignItems: "center", opacity: opening ? 0.5 : 1 }}>
          <Text style={{ textAlign: "center", fontFamily: FF.serif5, fontSize: 11.5, lineHeight: 17, color: P.ink }}>{`拆开没告诉到${himName()}那边,行程还没打开 · ${openErr} · 点一下再试`}</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={() => fly(`invite:${plan.id}`, `day-strip:${plan.id}`, () => router.push(`/ephemera-day?id=${plan.id}&m=1` as Href), { dur: 820 })} style={{ position: "absolute", left: 80, right: 80, top: 726, height: 60, alignItems: "center" }} accessibilityLabel="开始今天">
        <Text style={[{ fontFamily: FF.serif9, fontSize: 22, letterSpacing: 11, marginLeft: 11, color: P.btn }, pressIn]}>开始今天</Text>
        <FoilLine w={130} style={{ position: "absolute", top: 34 }} />
        <Text style={{ marginTop: 12, fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 3.2, color: P.btn, opacity: 0.85 }}>BEGIN THE DAY</Text>
      </Pressable>
      <Pressable onPress={() => router.replace("/ephemera" as Href)} style={{ position: "absolute", left: 0, right: 0, top: 798, flexDirection: "row", justifyContent: "center", alignItems: "baseline" }} accessibilityLabel="先收进邀请盒">
        <Text style={{ fontFamily: FF.pf7I, fontSize: 13, color: P.ink, opacity: 0.75 }}>or,  </Text>
        <Text style={{ fontFamily: FF.serif5, fontSize: 12.5, letterSpacing: 2, color: P.ink, textDecorationLine: "underline", textDecorationStyle: "dotted" }}>先收进邀请盒</Text>
      </Pressable>
    </Stage>
  );
}
