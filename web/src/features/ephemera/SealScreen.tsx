// Ephemera ② 拆信封(原型 sealView,信封=A 法式压纹:整面纸 + 大花体字标 + FROM/TO + 粉色蝴蝶结火漆)。
// 按钮只用字区分:大号「拆开」+ 烫金细线 + BREAK THE SEAL;次要「or, 先看准备清单 ›」。
import { Canvas, Group, Image as SkImage, Skia, useImage } from "@shopify/react-native-skia";
import { type Href, useLocalSearchParams, useRouter } from "../../nav/router";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import Svg, { Path } from "react-native-svg";
import { sealDragProgress, sealShouldCommit, sealSplit } from "./aliveHome";
import { BackKey, Caps, FitLine, FoilLine, Paper, pressIn, SEAL_BOW, Stage, Svg as SvgBox, useStage, shapeShadow } from "./components";
import { dateParts, paperNo, titleLines } from "./format";
import { LoadErr } from "./DayScreen";
import { PrepCard, PREP_W } from "./PrepCard";
import { foilRuleXml } from "./shapes";
import { markOpened, usePlan, useSkin } from "./store";
import { FF, rgba } from "./theme";
import type { Plan } from "../../lib/ephemeraApi";
import { FlightSpot, fly } from "./flight";
import { herEn, himEn } from "../../runtime/session";

/** the sender's name on the envelope, letter by letter (D · A · W · N) */
const spaced = (name: string) => [...name.toUpperCase()].join(" · ");

const W = 334, Hh = 440, TIP = Hh * 0.6, EX = 28, EY = 92;
const FLAP_D = `M0 0 L${W} 0 L${W} 18 C${W * 0.82} ${TIP * 0.55} ${W * 0.62} ${TIP - 10} ${W * 0.5} ${TIP} C${W * 0.38} ${TIP - 10} ${W * 0.18} ${TIP * 0.55} 0 18 Z`;
const POCKET_D = `M0 ${Hh * 0.3} L${W * 0.5} ${TIP + 30} L${W} ${Hh * 0.3} L${W} ${Hh} L0 ${Hh} Z`;
const SEAL = 64;
/** The lowest control (「先看准备清单」, top 740, 30 tall): a shorter screen scrolls to it */
export const SEAL_MIN_H = 772;

/** 按住往上拉开信封(跟手),拉够或甩得够快=commit,不够松手合回(reseal)。
 *  onOpened:commit 那一刻触发一次(留给跨页变形接入用,这里先照原样跳页);信纸外层 View 的 ref 也是留给跨页变形接的口。 */
export const EphemeraSealScreen = forwardRef<View, { onOpened?: () => void }>(function EphemeraSealScreen({ onOpened }, letterRef) {
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const router = useRouter();
  const { P } = useSkin();
  const { plan, her, mark, error } = usePlan(id);
  const [prep, setPrep] = useState(false);
  const opening = useRef(false); // 拦「已经在跳页了」,不管走的是点按钮还是拖够了
  const starting = useRef(false); // 拦「点按钮的整套动画已经起了」,不被拖拽重复触发
  // 拆开后的跳页:她半路返回 / 去了别的页 = 不再把她带走
  const mounted = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; timers.current.forEach(clearTimeout); }; }, []);

  const crack = useSharedValue(0), tagOff = useSharedValue(0), flap = useSharedValue(0), back2 = useSharedValue(0), lift = useSharedValue(0);
  const drag = useSharedValue(0); // 跟手进度(原型 p);按钮点开/拖够commit后锁住,不再跟手势更新
  const locked = useSharedValue(0);
  const sway = useSharedValue(0), halo = useSharedValue(0);
  useEffect(() => {
    sway.value = withRepeat(withSequence(withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: 2000, easing: Easing.inOut(Easing.sin) })), -1);
    halo.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }), -1);
  }, [sway, halo]);

  // 够了:报引擎「她拆开了」、等它最多 4 秒、跳请柬页
  const finishOpen = () => {
    if (opening.current || !plan) return;
    opening.current = true;
    const told = markOpened(plan.id);
    timers.current.push(setTimeout(() => {
      Promise.race([told, new Promise<void>((r) => { timers.current.push(setTimeout(() => r(), 4000)); })])
        // 信纸展开成请柬(飞行层接着变)
        .finally(() => { if (mounted.current) fly(`letter:${plan.id}`, `invite:${plan.id}`, () => router.replace(`/ephemera-invite?id=${plan.id}&m=1` as Href), { dur: 780, lift: 40 }); });
    }, 4));
  };

  // 点一下 / 按钮「拆开」:原样的整套开封动画(先裂火漆,停顿一下,封舌翻开,信纸展开)
  const open = () => {
    if (starting.current || opening.current || !plan) return;
    starting.current = true; locked.value = 1;
    onOpened?.();
    crack.value = withTiming(1, { duration: 700, easing: Easing.bezier(0.22, 1, 0.36, 1) });
    tagOff.value = withTiming(1, { duration: 500 });
    flap.value = withDelay(450, withTiming(1, { duration: 420, easing: Easing.bezier(0.55, 0, 0.8, 0.4) }));
    back2.value = withDelay(850, withTiming(1, calm(620)));
    lift.value = withDelay(1000, withTiming(1, { duration: 1100, easing: Easing.bezier(0.22, 1, 0.36, 1) }));
    timers.current.push(setTimeout(finishOpen, 1950));
  };

  // 拖够了(或甩得够快):跟手已经在视觉上接近开了,快速补到底,不走按钮那套长动画(原型 commit:tween 到 1,260ms)
  const commitDrag = () => {
    "worklet";
    locked.value = 1;
    const dur = 260, ease = Easing.bezier(0.3, 0.72, 0.1, 1);
    crack.value = withTiming(1, { duration: dur, easing: ease });
    tagOff.value = withTiming(1, { duration: dur, easing: ease });
    flap.value = withTiming(1, { duration: dur, easing: ease });
    back2.value = withTiming(1, { duration: dur, easing: ease });
    lift.value = withTiming(1, { duration: dur, easing: ease }, (ok) => { if (ok) runOnJS(finishOpen)(); });
  };
  // 没拉够:合回去,火漆重新粘上(原型 reseal,backOut 回弹)
  const resealDrag = () => {
    "worklet";
    const sp = { damping: 14, stiffness: 140 };
    drag.value = withSpring(0, sp);
    crack.value = withSpring(0, sp);
    tagOff.value = withSpring(0, sp);
    flap.value = withSpring(0, sp);
    back2.value = withSpring(0, sp);
    lift.value = withSpring(0, sp);
  };
  const startOpen = () => { onOpened?.(); };
  // 不用 useMemo 缓存:plan 从 null 变成有值那一刻,open/commitDrag 等闭包要跟着换新,缓存住会一直拿第一次渲染时的
  // 空 plan(手势对象本身很轻,每次渲染重建没有代价;真正拖拽发生时 plan 早已加载完,不会再因为别的 state 重新渲染)
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (locked.value) return;
      drag.value = sealDragProgress(e.translationY);
      const { f, lift: l } = sealSplit(drag.value);
      crack.value = f; tagOff.value = f; flap.value = f; back2.value = f; lift.value = l;
    })
    .onEnd((e) => {
      if (locked.value) return;
      if (sealShouldCommit(drag.value, e.velocityY)) { runOnJS(startOpen)(); commitDrag(); } else resealDrag();
    });
  const tap = Gesture.Tap().maxDuration(1000).onEnd(() => { if (!locked.value) runOnJS(open)(); });
  const envelopeGesture = Gesture.Race(pan, tap);

  const sealL = useAnimatedStyle(() => ({ opacity: 1 - crack.value, transform: [{ translateX: -26 * crack.value }, { translateY: 30 * crack.value }, { rotate: `${-28 * crack.value}deg` }] }));
  const sealR = useAnimatedStyle(() => ({ opacity: 1 - crack.value, transform: [{ translateX: 26 * crack.value }, { translateY: 34 * crack.value }, { rotate: `${32 * crack.value}deg` }] }));
  const haloSt = useAnimatedStyle(() => ({ opacity: crack.value > 0 ? 0 : 0.7 * (1 - halo.value), transform: [{ scale: 0.8 + 0.55 * halo.value }] }));
  const tagSt = useAnimatedStyle(() => ({ opacity: 1 - tagOff.value, transform: [{ rotate: `${tagOff.value > 0 ? 18 * tagOff.value : -4 + 7 * sway.value}deg` }, { translateY: 10 * tagOff.value }] }));
  const faceSt = useAnimatedStyle(() => ({ transform: [{ scaleY: 1 - flap.value }] }));
  const back2St = useAnimatedStyle(() => ({ opacity: back2.value > 0 ? 1 : 0, transform: [{ scaleY: -back2.value }] }));
  const flapZ = useAnimatedStyle(() => ({ zIndex: flap.value > 0.99 ? 1 : 4 }));
  const letterSt = useAnimatedStyle(() => ({ transform: [{ translateY: -130 * lift.value }] }));

  if (!plan) return <Stage P={P}><BackKey color={P.deep} top={40} onPress={() => router.back()} />{error ? <LoadErr P={P} msg={error} /> : null}</Stage>;
  const [t1, t2] = titleLines(plan);
  const dp = dateParts(plan.date);

  return (
    <Stage P={P} minH={SEAL_MIN_H} overlay={prep ? (
      <Pressable style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.4), zIndex: 45 }} onPress={() => setPrep(false)}>
        <PrepPop onClose={() => setPrep(false)}>
          <PrepCard plan={plan} her={her} P={P} live onToggle={(k, on) => { mark(k, on).catch(() => {}); }} />
        </PrepPop>
      </Pressable>
    ) : null}>
      <BackKey color={P.deep} top={40} onPress={() => fly(`env:${plan.id}`, `bigT:${plan.id}`, () => router.back(), { dur: 700, back: true })} />
      <Caps color={P.deep} center style={{ position: "absolute", left: 0, right: 0, top: 54 }}>{`No. ${paperNo(plan)} · A private invitation`}</Caps>

      <GestureDetector gesture={envelopeGesture}>
      <FlightSpot k={`env:${plan.id}`} style={{ position: "absolute", left: EX, top: EY, width: W, height: Hh }}>
      <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} accessibilityLabel="拆开信封(按住往上拉,或点一下)">
        <Paper w={W} h={Hh} fill={P.envBack} sh={P.sh} />
        {/* 信纸外层 View(ref 口留给接 A 路跨页变形):里面那层才带跟手的上提位移 */}
        <View ref={letterRef} style={{ position: "absolute", left: 16, right: 16, top: 30, height: Hh - 60, zIndex: 2 }}>
          <FlightSpot k={`letter:${plan.id}`} style={[{ flex: 1 }, letterSt]}>
            <Paper w={W - 32} h={Hh - 60} fill={P.paper} sh={P.sh} shadow="paper" />
            <Text style={{ position: "absolute", left: 0, right: 0, top: 34, textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 34, color: P.deep }}>You're invited</Text>
          </FlightSpot>
        </View>
        <View style={{ position: "absolute", left: 0, top: 0, width: W, height: Hh, zIndex: 3 }} pointerEvents="none">
          <Paper w={W} h={Hh} d={POCKET_D} fill={P.envPaper} sh={P.sh} shadow="none" />
          <View style={{ position: "absolute", left: 0, right: 0, top: Hh * 0.78, bottom: 0, borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: P.envPaper,
            shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: -2 }, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.7)" }} />
          <Text style={{ position: "absolute", left: 0, right: 0, top: Hh * 0.78 + 24, textAlign: "center", fontFamily: FF.pf7I, fontSize: 13, lineHeight: 22, color: P.deep }}>{"Plans for the two of us.\nOpen when you're ready."}</Text>
          <Emboss d={`M0 ${Hh * 0.3} L${W * 0.5} ${TIP + 30} L${W} ${Hh * 0.3}`} sh={P.sh} />
        </View>
        <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: W, height: Hh }, flapZ]} pointerEvents="none">
          <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: W, height: Hh, transformOrigin: "top" }, back2St]}>
            <Paper w={W} h={Hh} d={FLAP_D} fill={P.envBack} sh={P.sh} shadow="none" />
          </Animated.View>
          <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: W, height: Hh, transformOrigin: "top" }, faceSt]}>
            <Paper w={W} h={Hh} d={FLAP_D} fill={P.envPaper} sh={P.sh} shadow="none" />
            <View style={{ position: "absolute", left: 24, top: 26 }}>
              <Text style={{ fontFamily: FF.corm, fontSize: 13, letterSpacing: 0.8, color: P.deep }}>FROM :</Text>
              <Text style={{ fontFamily: FF.pf7, fontSize: 8, letterSpacing: 3.4, marginTop: 6, color: P.deep }}>{spaced(himEn())}</Text>
            </View>
            <Text style={{ position: "absolute", right: 24, top: 26, fontFamily: FF.serif5, fontSize: 13, color: P.deep }}>
              <Text style={{ fontFamily: FF.corm }}>TO : </Text>{herEn()}
            </Text>
            <View style={{ position: "absolute", left: 18, right: 18, top: TIP * 0.3 }}>
              <FitLine testID="seal-t1" style={[{ textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 42, lineHeight: 50, color: P.deep }, pressIn]}>{t1}</FitLine>
              {t2 ? <FitLine testID="seal-t2" style={[{ textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 50, lineHeight: 50, color: P.deep }, pressIn]}>{`  ${t2}`}</FitLine> : null}
            </View>
            <Text style={{ position: "absolute", left: 0, right: 0, top: TIP * 0.3 + 118, textAlign: "center", fontFamily: FF.pf7I, fontSize: 12, letterSpacing: 0.5, color: P.deep }}>A night for two is coming</Text>
            <Emboss d={FLAP_D.replace(/Z$/, "")} sh={P.sh} />
          </Animated.View>
        </Animated.View>
        <View style={{ position: "absolute", left: W / 2 - SEAL / 2, top: TIP - 4 - SEAL / 2, width: SEAL, height: SEAL, zIndex: 6 }}>
          <Animated.View style={[{ position: "absolute", left: -10, top: -10, width: SEAL + 20, height: SEAL + 20, borderRadius: (SEAL + 20) / 2, borderWidth: 1.5, borderColor: P.btn }, haloSt]} />
          <Animated.View style={[{ position: "absolute", left: 0, top: 0 }, sealL]}><SealHalf side="l" /></Animated.View>
          <Animated.View style={[{ position: "absolute", left: 0, top: 0 }, sealR]}><SealHalf side="r" /></Animated.View>
        </View>
      </View>
      </FlightSpot>
      </GestureDetector>

      <Animated.View style={[{ position: "absolute", left: 306, top: 470, width: 66, zIndex: 7, transformOrigin: "33px -24px" }, tagSt]} pointerEvents="none">
        <View style={{ position: "absolute", left: 32, top: -30, width: 1, height: 32, backgroundColor: P.deep }} />
        <Paper w={66} h={84} d="M11.9 0 L54.1 0 L66 15.1 L66 84 L0 84 L0 15.1 Z" fill={P.tag} sh={P.sh} shadow="paper" texture={0.4} />
        <View style={{ position: "absolute", left: 0, right: 0, top: 14, alignItems: "center" }}>
          <Caps color={P.tagT} size={8} ls={0.2}>{dp.mon}</Caps>
          <Text style={{ fontFamily: FF.pf9, fontSize: 30, lineHeight: 32, color: P.tagT }}>{dp.d}</Text>
          <Caps color={P.tagT} size={8} ls={0.2}>{dp.dow}</Caps>
        </View>
      </Animated.View>

      <View style={{ position: "absolute", left: 0, right: 0, top: 560, alignItems: "center" }}>
        <SvgBox xml={foilRuleXml()} w={220} h={14} style={{ position: "relative" }} />
        <Text style={[{ marginTop: 12, fontFamily: FF.pf7I, fontSize: 15, color: P.deep }, pressIn]}>A special day is waiting for you.</Text>
        <Text style={[{ marginTop: 8, fontFamily: FF.serif5, fontSize: 13, letterSpacing: 4.2, color: P.ink }, pressIn]}>准备好了，就拆开吧</Text>
      </View>
      <Pressable onPress={open} style={{ position: "absolute", left: 95, right: 95, top: 640, height: 70, alignItems: "center" }} accessibilityLabel="拆开">
        <Text style={[{ fontFamily: FF.serif9, fontSize: 30, letterSpacing: 21, marginLeft: 21, color: P.btn }, pressIn]}>拆开</Text>
        <FoilLine w={120} style={{ position: "absolute", top: 46 }} />
        <Text style={{ marginTop: 14, fontFamily: FF.pf7, fontSize: 8, letterSpacing: 3.4, color: P.btn, opacity: 0.85 }}>BREAK THE SEAL</Text>
      </Pressable>
      <Pressable onPress={() => setPrep(true)} style={{ position: "absolute", left: 0, right: 0, top: 740, height: 30, flexDirection: "row", justifyContent: "center", alignItems: "baseline" }} accessibilityLabel="先看准备清单">
        <Text style={{ fontFamily: FF.pf7I, fontSize: 14, color: P.ink, opacity: 0.75 }}>or,  </Text>
        <Text style={{ fontFamily: FF.serif5, fontSize: 13, letterSpacing: 2, color: P.ink, borderBottomWidth: 1, textDecorationLine: "underline", textDecorationStyle: "dotted" }}>先看准备清单</Text>
        <Text style={{ fontFamily: FF.pf, fontSize: 14, color: P.ink, opacity: 0.7 }}>  ›</Text>
      </Pressable>
    </Stage>
  );
});

/** 封好的信封静态版(首页 Hidden Plans 那只小信封用;和上面拆信封页是同一只,只是不动)。
 *  bare=不写字:缩小摆放时字会被位图缩放得发糊,由调用方按实际尺寸另写 */
export const ENVELOPE = { w: W, h: Hh, tip: TIP };
export function ClosedEnvelope({ plan, bare }: { plan: Plan | null; bare?: boolean }) {
  const { P } = useSkin();
  const [t1, t2] = plan ? titleLines(plan) : ["You're", "invited"];
  return (
    <View style={{ width: W, height: Hh }} pointerEvents="none">
      <Paper w={W} h={Hh} fill={P.envBack} sh={P.sh} />
      <Paper w={W} h={Hh} d={POCKET_D} fill={P.envPaper} sh={P.sh} shadow="none" />
      <View style={{ position: "absolute", left: 0, right: 0, top: Hh * 0.78, bottom: 0, borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: P.envPaper,
        shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: -2 }, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.7)" }} />
      {bare ? null : <Text style={{ position: "absolute", left: 0, right: 0, top: Hh * 0.78 + 24, textAlign: "center", fontFamily: FF.pf7I, fontSize: 13, lineHeight: 22, color: P.deep }}>{"Plans for the two of us.\nOpen when you're ready."}</Text>}
      <Emboss d={`M0 ${Hh * 0.3} L${W * 0.5} ${TIP + 30} L${W} ${Hh * 0.3}`} sh={P.sh} />
      <Paper w={W} h={Hh} d={FLAP_D} fill={P.envPaper} sh={P.sh} shadow="none" />
      {bare ? null : <><View style={{ position: "absolute", left: 24, top: 26 }}>
        <Text style={{ fontFamily: FF.corm, fontSize: 13, letterSpacing: 0.8, color: P.deep }}>FROM :</Text>
        <Text style={{ fontFamily: FF.pf7, fontSize: 8, letterSpacing: 3.4, marginTop: 6, color: P.deep }}>{spaced(himEn())}</Text>
      </View>
      <Text style={{ position: "absolute", right: 24, top: 26, fontFamily: FF.serif5, fontSize: 13, color: P.deep }}>
        <Text style={{ fontFamily: FF.corm }}>TO : </Text>{herEn()}
      </Text>
      <View style={{ position: "absolute", left: 18, right: 18, top: TIP * 0.3 }}>
        <FitLine style={[{ textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 42, lineHeight: 50, color: P.deep }, pressIn]}>{t1}</FitLine>
        {t2 ? <FitLine style={[{ textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 50, lineHeight: 50, color: P.deep }, pressIn]}>{`  ${t2}`}</FitLine> : null}
      </View></>}
      <Emboss d={FLAP_D.replace(/Z$/, "")} sh={P.sh} />
      <View style={{ position: "absolute", left: W / 2 - SEAL / 2, top: TIP - 4 - SEAL / 2, width: SEAL, height: SEAL }}>
        <View style={{ position: "absolute", left: 0, top: 0 }}><SealHalf side="l" /></View>
        <View style={{ position: "absolute", left: 0, top: 0 }}><SealHalf side="r" /></View>
      </View>
    </View>
  );
}

/** 卡片从下面滑上来、微微歪着(原型 #prepPop) */
export function PrepPop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const { s, top, H } = useStage();
  const t = useSharedValue(0);
  useEffect(() => { t.value = withTiming(1, calm()); }, [t]);
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: 720 * (1 - t.value) }, { rotate: `${5 - 6.5 * t.value}deg` }] }));
  return (
    <View style={{ position: "absolute", left: 0, top, width: 390, height: H, transform: [{ scale: s }], transformOrigin: "top left" }}>
      <ScrollView contentContainerStyle={{ paddingTop: 128, paddingBottom: 80, alignItems: "center" }} showsVerticalScrollIndicator={false}>
        <Pressable onPress={(e) => e.stopPropagation()}>
          <Animated.View style={[{ width: PREP_W, ...shapeShadow("#000", 0.28, 20, 24) }, st]}>{children}</Animated.View>
        </Pressable>
      </ScrollView>
      <Pressable onPress={onClose} style={{ position: "absolute", right: 14, top: 52, width: 40, height: 40, alignItems: "center", justifyContent: "center" }} accessibilityLabel="收起">
        <Text style={{ fontFamily: FF.pf, fontSize: 30, color: "#fff" }}>×</Text>
      </Pressable>
    </View>
  );
}

function SealHalf({ side }: { side: "l" | "r" }) {
  const img = useImage(SEAL_BOW);
  const clip = useMemo(() => {
    const p = Skia.Path.Make(), s = SEAL;
    const pts = side === "l" ? [[0, 0], [0.55, 0], [0.45, 0.5], [0.58, 1], [0, 1]] : [[0.55, 0], [1, 0], [1, 1], [0.58, 1], [0.45, 0.5]];
    pts.forEach(([x, y], i) => (i ? p.lineTo(x * s, y * s) : p.moveTo(x * s, y * s)));
    p.close();
    return p;
  }, [side]);
  return (
    <Canvas style={{ width: SEAL, height: SEAL + 8, ...shapeShadow("#5a3c46", 0.35, 4, 3) }}>
      <Group clip={clip}>{img ? <SkImage image={img} x={0} y={0} width={SEAL} height={SEAL} fit="contain" /> : null}</Group>
    </Canvas>
  );
}

/** 压纹:一道白高光 + 下面一道淡影(原型 emboss) */
function Emboss({ d, sh }: { d: string; sh: string }) {
  return (
    <Svg style={{ position: "absolute", left: 0, top: 0 }} width={W} height={Hh} viewBox={`0 0 ${W} ${Hh}`} pointerEvents="none">
      <Path d={d} fill="none" stroke={rgba(sh, 0.16)} strokeWidth={2} translateY={1.2} />
      <Path d={d} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={1.1} />
    </Svg>
  );
}
