// 首页空态。
// 一叠还没用的纸品(信纸/明信片/邮票/半张票)压叠出血;不方正堆叠、不用胶带、不用贴纸。
//
// 这叠纸不能是死的——拖、甩(滑一段转一下停住,过一会儿自己归位);
// 点信纸/明信片翻面;印章(邮票/火漆)拖到哪松手就盖一个印子;半截票点一下抽出一截。手机倾斜也作用在这叠纸上
// (纸片按远近错开,见 ./components Tilt/useTilt)。原型 playable()/flipObj()/pressStamp()/pullTicket() 逐条照搬。
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, runOnJS, useAnimatedStyle, useFrameCallback, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import { dragRotationStep, flingActive, flingDecay, flingInitial, tiltOffset, TILT_DEPTHS } from "./aliveHome";
import { Art, Caps, Paper, PaperTex, Svg, useStagePixels, useTilt } from "./components";
import { deckle, perf, stampXml } from "./shapes";
import { useSkin } from "./store";
import { FF, rgba } from "./theme";

// ── D1 引擎:拖 + 甩 + 倾斜,一个 hook 管一张纸(原型 playable 的 RN 版) ──────────────────────
const IDLE_MS_BEFORE_HOME = 2200; // 原型「停住 2.2s 才归位」;按真实毫秒计(120Hz 屏不提前、甩出去也不翻倍)
function useDraggable(depth: number) {
  const { x: tx, y: ty } = useTilt();
  const PR = useStagePixels();   // 舞台缩放也算进去(同 components Tilt)
  const fx = useSharedValue(0), fy = useSharedValue(0), fr = useSharedValue(0);
  const vx = useSharedValue(0), vy = useSharedValue(0), vr = useSharedValue(0);
  const startFx = useSharedValue(0), startFy = useSharedValue(0), lastDx = useSharedValue(0);
  const dragging = useSharedValue(0), idleFrames = useSharedValue(0);
  useFrameCallback((info) => {
    "worklet";
    const k = Math.min(3, (info.timeSincePreviousFrame ?? 16.7) / 16.7);   // 原型参数按 60Hz 一帧定的,这里按实际帧长折算
    if (dragging.value) { idleFrames.value = 0; return; }
    if (flingActive(vx.value, vy.value)) {
      vx.value = vx.value * Math.pow(0.92, k); vy.value = vy.value * Math.pow(0.92, k); vr.value = vr.value * Math.pow(0.9, k);
      fx.value += vx.value * k; fy.value += vy.value * k; fr.value = Math.max(-40, Math.min(40, fr.value + vr.value * k));
      idleFrames.value = 0;
      return;
    }
    const before = idleFrames.value;
    idleFrames.value += 16.7 * k;
    if (before < IDLE_MS_BEFORE_HOME && idleFrames.value >= IDLE_MS_BEFORE_HOME) {
      const ease = Easing.inOut(Easing.cubic);
      fx.value = withTiming(0, { duration: 1400, easing: ease });
      fy.value = withTiming(0, { duration: 1400, easing: ease });
      fr.value = withTiming(0, { duration: 1400, easing: ease });
    }
  });
  const pan = Gesture.Pan()
    .onStart(() => { dragging.value = 1; vx.value = 0; vy.value = 0; vr.value = 0; lastDx.value = 0; startFx.value = fx.value; startFy.value = fy.value; })
    .onUpdate((e) => {
      fx.value = startFx.value + e.translationX; fy.value = startFy.value + e.translationY;
      fr.value = dragRotationStep(fr.value, e.translationX, lastDx.value); lastDx.value = e.translationX;
    })
    .onEnd((e) => { dragging.value = 0; vx.value = flingInitial(e.velocityX); vy.value = flingInitial(e.velocityY); vr.value = flingInitial(e.velocityX) * 0.25; });
  const style = useAnimatedStyle(() => {
    const t = tiltOffset(tx.value, ty.value, depth);
    // 停着的时候对齐到物理像素(倾斜抖动挪零点几像素文字会发虚)
    return { transform: [{ translateX: Math.round((fx.value + t.x) * PR) / PR }, { translateY: Math.round((fy.value + t.y) * PR) / PR }, { rotate: `${fr.value}deg` }] };
  });
  return { pan, style, fx, fy, fr };
}

/** 一张可以拖、甩、点一下有反应的纸(原型 [data-obj]);tap 不传=只拖甩不特别反应(原型 stub 系列同款) */
export function Playable(props: { depth: number; box: { left: number; top: number; width: number; height: number }; onTap?: () => void; testID?: string; children: React.ReactNode }) {
  const drag = useDraggable(props.depth);
  return <PlayableWith drag={drag} {...props} />;
}
/** 同上,拖拽状态由外面给(印章要读自己被拖到了哪);onRelease=拖过之后松手(原型:印章拖到哪松手就在哪盖) */
function PlayableWith({ drag, box, onTap, onRelease, testID, children }: { drag: ReturnType<typeof useDraggable>; depth?: number; box: { left: number; top: number; width: number; height: number }; onTap?: () => void; onRelease?: () => void; testID?: string; children: React.ReactNode }) {
  const pan = onRelease ? drag.pan.onFinalize((_e, ok) => { if (ok) runOnJS(onRelease)(); }) : drag.pan;
  const tap = Gesture.Tap().maxDuration(260).onEnd(() => { if (onTap) runOnJS(onTap)(); });
  const g = onTap ? Gesture.Race(pan, tap) : pan;
  return (
    <GestureDetector gesture={g}>
      <Animated.View testID={testID} style={[{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height }, drag.style]}>{children}</Animated.View>
    </GestureDetector>
  );
}

/** 翻到背面(原型 flipObj):横向压扁到 0 再弹回,露出/收回背面(原型 backFace,竖线仿信纸横格) */
function useFlip() {
  const scaleX = useSharedValue(1);
  const [back, setBack] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const toggle = () => {
    scaleX.value = withSequence(
      withTiming(0, { duration: 200, easing: Easing.bezier(0.5, 0, 1, 0.6) }),
      withTiming(1, calm(300)),
    );
    setTimeout(() => { if (alive.current) setBack((b) => !b); }, 200);
  };
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: scaleX.value }] }));
  return { back, toggle, style };
}
function PaperBack({ w, h, P, ruled = true }: { w: number; h: number; P: ReturnType<typeof useSkin>["P"]; ruled?: boolean }) {
  const rows = Math.max(3, Math.floor((h - 40) / 22));
  return (
    <View style={{ position: "absolute", inset: 0, backgroundColor: P.paper, overflow: "hidden" } as never}>
      <PaperTex opacity={0.6} />
      {ruled ? Array.from({ length: rows }, (_, j) => (
        <View key={j} style={{ position: "absolute", left: 22, right: 22, top: 30 + j * 22, borderTopWidth: 0.6, borderTopColor: rgba(P.sh, 0.2) }} />
      )) : null}
    </View>
  );
}

// ── B ────────────────────────────────────────────────────────────────────────────────
// 一叠还没用的纸品:信纸 + 明信片(带邮票)+ 半张票,压叠出血;只用原型里那套纸和线稿小画,不用贴纸
export function ScrapPage() {
  const { P } = useSkin();
  const B = P.big;
  const lw = 268, lh = 250, pw = 214, ph = 142, tw = 84, th = 152;
  const letter = useFlip(), postcard = useFlip();
  const [marks, setMarks] = useState<Array<{ id: number; x: number; y: number; rot: number }>>([]);
  const stampDrag = useDraggable(TILT_DEPTHS[3]);
  const sealDrag = useDraggable(TILT_DEPTHS[4]);
  const pressStamp = (which: "stamp" | "seal") => {
    const d = which === "stamp" ? stampDrag : sealDrag;
    // 印子落在印章中心(盒子 left/top + 一半)+ 它被拖到的位移
    setMarks((m) => [...m, { id: Date.now() + Math.random(), x: (which === "stamp" ? 300 + 28 : 232 + 35) + d.fx.value, y: (which === "stamp" ? 250 + 34 : 372 + 35) + d.fy.value, rot: d.fr.value }]);
    const bounce = which === "stamp" ? stampDrag : sealDrag;
    bounce.fr.value = withSequence(withTiming(bounce.fr.value + 6, { duration: 90 }), withTiming(bounce.fr.value, { duration: 180 }));
  };
  const pullX = useSharedValue(0);
  const pullTicket = () => {
    pullX.value = withSequence(
      withTiming(58, { duration: 675, easing: Easing.bezier(0.4, 0, 0.2, 1) }),
      withTiming(58, { duration: 450 }),
      withTiming(0, { duration: 375, easing: Easing.bezier(0.4, 0, 0.2, 1) }),
    );
  };
  const pullSt = useAnimatedStyle(() => ({ transform: [{ translateX: pullX.value }, { translateY: -6 * (pullX.value / 58) }] }));
  return (
    <View style={{ position: "absolute", left: 0, top: 0, width: 390, height: 460 }}>
      {/* 印章落在这叠纸上留下的痕迹(拖到哪松手就在那盖一个印子,原型 pressStamp 的 inkMark) */}
      {marks.map((m) => (
        <View key={m.id} pointerEvents="none" style={{ position: "absolute", left: m.x - 28, top: m.y - 28, width: 56, height: 56, opacity: 0.5, transform: [{ rotate: `${m.rot}deg` }], mixBlendMode: "multiply" as never }}>
          <Svg xml={stampXml("EPHEMERA · ", "", P.deep, 56)} w={56} h={56} style={{ position: "relative" }} />
        </View>
      ))}
      {/* 半张票,从左边出血;点一下往外抽一截再滑回去 */}
      <Playable depth={TILT_DEPTHS[0]} box={{ left: -26, top: 214, width: tw, height: th }} onTap={pullTicket} testID="scrap-halfticket">
        <Animated.View style={[{ flex: 1, transform: [{ rotate: "-13deg" }] }, pullSt]}>
          <Paper w={tw} h={th} d={perf(tw, th)} fill={B.c} sh={P.sh} shadow="paper" />
          <View style={{ position: "absolute", left: 10, right: 10, top: 34, height: 86, backgroundColor: B.panel, overflow: "hidden" }}>
            <Art name="sc_cinema" color={B.art} inv style={{ left: 0, top: -5, width: 64, height: 96 }} />
          </View>
          <FoilTextLike text="No. ——" w={tw} P={P} />
        </Animated.View>
      </Playable>
      {/* 信纸:点一下翻到背面(仿信纸横格的背面) */}
      <Playable depth={TILT_DEPTHS[1]} box={{ left: 40, top: 150, width: lw, height: lh }} onTap={letter.toggle} testID="scrap-letter">
        <Animated.View style={[{ flex: 1, transform: [{ rotate: "-4deg" }] }, letter.style]}>
          {letter.back ? <PaperBack w={lw} h={lh} P={P} /> : (
            <>
              <Paper w={lw} h={lh} d={deckle(lw, lh)} fill={P.paper} sh={P.sh} />
              <View style={{ position: "absolute", left: 12, top: 12, right: 12, bottom: 12, borderWidth: 0.8, borderColor: rgba(P.sh, 0.2) }} />
              <Text style={{ position: "absolute", left: 30, top: 40, fontFamily: FF.script, paddingRight: 8, fontSize: 26, color: P.deep, opacity: 0.85 }}>No invitation yet</Text>
              {[96, 124].map((y) => <View key={y} style={{ position: "absolute", left: 30, right: 30, top: y, height: 1, backgroundColor: rgba(P.sh, 0.18) }} />)}
              <Art name="florals" color={P.deep} style={{ left: 18, top: 140, width: 96, height: 96, opacity: 0.4, transform: [{ scaleY: -1 }] }} />
            </>
          )}
        </Animated.View>
      </Playable>
      {/* 明信片压在信纸右下,右边出血;点一下翻到背面 */}
      <Playable depth={TILT_DEPTHS[2]} box={{ left: 214, top: 286, width: pw, height: ph }} onTap={postcard.toggle} testID="scrap-postcard">
        <Animated.View style={[{ flex: 1, transform: [{ rotate: "7deg" }] }, postcard.style]}>
          {postcard.back ? <PaperBack w={pw} h={ph} P={P} /> : (
            <>
              <Paper w={pw} h={ph} fill={P.paper2} sh={P.sh} />
              <View style={{ position: "absolute", left: 10, top: 10, width: 92, height: ph - 20, overflow: "hidden" }}>
                <Art name="sc_moon" color={P.deep} style={{ left: 0, top: -8, width: 92, height: 138, opacity: 0.75 }} />
              </View>
              <View style={{ position: "absolute", left: 112, top: 12, bottom: 12, width: 1, backgroundColor: rgba(P.sh, 0.25) }} />
              {[66, 88, 110].map((y) => <View key={y} style={{ position: "absolute", left: 122, width: 70, top: y, height: 1, backgroundColor: rgba(P.sh, 0.22) }} />)}
              <Caps color={P.deep} size={6.5} style={{ position: "absolute", left: 122, top: 16 }}>Post card</Caps>
            </>
          )}
        </Animated.View>
      </Playable>
      {/* 邮票,压在明信片和信纸交界;拖到哪松手就盖一个印子 */}
      <PlayableWith drag={stampDrag} box={{ left: 300, top: 250, width: 56, height: 68 }} onTap={() => pressStamp("stamp")} onRelease={() => pressStamp("stamp")} testID="scrap-stamp">
        <View style={{ flex: 1, transform: [{ rotate: "-6deg" }] }}>
          <Paper w={56} h={68} d={perf(56, 68, 3, 9)} fill={B.c} sh={P.sh} shadow="paper" />
          <View style={{ position: "absolute", left: 7, right: 7, top: 7, bottom: 7, backgroundColor: B.panel, overflow: "hidden" }}>
            <Art name="sc_station" color={B.art} inv style={{ left: 0, top: -4, width: 42, height: 63 }} />
          </View>
        </View>
      </PlayableWith>
      {/* 火漆印章:同邮票,拖到哪松手就盖一个印子 */}
      <PlayableWith drag={sealDrag} box={{ left: 232, top: 372, width: 70, height: 70 }} onTap={() => pressStamp("seal")} onRelease={() => pressStamp("seal")} testID="scrap-seal">
        <View style={{ flex: 1, opacity: 0.85, transform: [{ rotate: "-16deg" }] }}>
          <Svg xml={stampXml("EPHEMERA · A COLLECTION OF OUR DATES · ", "", P.deep, 70)} w={70} h={70} style={{ position: "relative" }} />
        </View>
      </PlayableWith>
    </View>
  );
}

/** 原型 .foil 烫金字的简化替身(这里不需要随手机倾斜发光,固定烫金色足够) */
function FoilTextLike({ text, w, P }: { text: string; w: number; P: ReturnType<typeof useSkin>["P"] }) {
  return <Text style={{ position: "absolute", left: 0, top: 13, width: w, textAlign: "center", fontFamily: FF.mono, fontSize: 8, color: "#B8914A", letterSpacing: 1 }}>{text}</Text>;
}

/** 「Past Collections」底下:两三张散落的空票根 + 一枝花,高低错开、压叠,最后一张出血;同样能拖甩(原型 stub 系列同款,没有特别的点一下反应) */
export function ScrapRow() {
  const { P } = useSkin();
  const w = 92, h = 166;
  const stub = (left: number, top: number, rot: number, fill: string, art: "sc_dessert" | "sc_cafe" | "sc_museum", depth: number, testID: string) => (
    <Playable key={testID} depth={depth} box={{ left, top, width: w, height: h }} testID={testID}>
      <View style={{ flex: 1, transform: [{ rotate: `${rot}deg` }] }}>
        <Paper w={w} h={h} d={perf(w, h)} fill={fill} sh={P.sh} shadow="paper" />
        <View style={{ position: "absolute", left: 7, top: 7, right: 7, bottom: 7, borderWidth: 1, borderColor: rgba(P.sh, 0.2) }} />
        <View style={{ position: "absolute", left: 12, right: 12, top: 40, height: 74, overflow: "hidden" }}>
          <Art name={art} color={P.ink} style={{ left: 0, top: -14, width: 68, height: 102, opacity: 0.28 }} />
        </View>
        <FoilTextLike text="No. ——" w={w} P={P} />
        <Text style={{ position: "absolute", left: 0, right: 0, top: h - 22, textAlign: "center", fontFamily: FF.mono, fontSize: 8, color: P.ink, opacity: 0.4 }}>— / — / ——</Text>
      </View>
    </Playable>
  );
  return (
    <View style={{ position: "absolute", left: 0, top: 520, width: 390, height: 210 }}>
      <Art name="florals" color={P.deep} style={{ left: 120, top: -6, width: 180, height: 180, opacity: 0.22, transform: [{ rotate: "-18deg" }] }} />
      {stub(24, 18, -6, P.paper, "sc_cafe", TILT_DEPTHS[5], "scrap-stub-0")}
      {stub(142, 34, 5, P.paper2, "sc_dessert", TILT_DEPTHS[0], "scrap-stub-1")}
      {stub(318, 8, 11, P.paper, "sc_museum", TILT_DEPTHS[1], "scrap-stub-2")}
    </View>
  );
}
