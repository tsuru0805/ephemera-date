// Ephemera 卡套:每站一个,按纸品类型各有各的形状。
// PhotoSleeve = 当天放照片时那只(原型 sleeveHTML:贴纸跨在卡套口上封口;椭圆窗放照片前实心、放进去才中空透出虚化照片)
// RouteSleeve = 纪念盒路线页那只(原型 sleeveObj:平面印刷感;车票夹=票往上抽 / 菜单卡=封面翻开 / 电影票封=票露头 / 信封=翻盖打开)
import { useEffect } from "react";
import { Image, Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle, Defs, Path, SvgXml, Text as SvgText, TextPath } from "react-native-svg";
import type { Stop } from "../../lib/ephemeraApi";
import { Paper, PaperTex, shapeShadow } from "./components";
import type { Paper4 } from "./format";
import { two } from "./format";
import { icon } from "./icons";
import { perf } from "./shapes";
import { FF, mix, rgba, type MapPal, type Skin } from "./theme";

export const SLEEVE_SIZE: Record<Paper4, { w: number; h: number }> = {
  train: { w: 170, h: 104 }, dinner: { w: 146, h: 184 }, cinema: { w: 136, h: 170 }, walk: { w: 186, h: 120 }, shop: { w: 150, h: 176 },
};

/** 椭圆窗:没放照片=实心纸;放了=中空,透出虚化的照片 */
function OvalWin({ photo, P }: { photo: { uri: string; headers?: Record<string, string> } | null; P: Skin }) {
  if (!photo) {
    return (
      <View style={{ flex: 1, backgroundColor: P.paper }}>
        <PaperTex />
        <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderRadius: 999, borderWidth: 0.8, borderColor: P.deep, opacity: 0.55 }} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: P.paper2 }}>
      <Image source={photo} blurRadius={8} style={{ position: "absolute", left: -30, top: -20, width: 150, height: 150, opacity: 0.7 }} />
      <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderRadius: 999, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.45, shadowRadius: 3, borderWidth: 0.5, borderColor: rgba(P.sh, 0.3) }} />
    </View>
  );
}

export function PhotoSleeve({ paper, s, c, P, i, photo, sealed }: {
  paper: Paper4; s: Stop; c: { bg: string; art: string }; P: Skin; i: number;
  photo: { uri: string; headers?: Record<string, string> } | null; sealed: boolean;
}) {
  const { w, h } = SLEEVE_SIZE[paper];
  // 没有线索(她补记的站、她补的站)就不印「线索」这个空标签
  const clue = (top: number) => (!s.clue ? null :
    <>
      <Text style={{ position: "absolute", left: 14, right: 12, top, fontFamily: FF.serif5, fontSize: 7, letterSpacing: 2.1, color: P.deep }}>线索</Text>
      <Text numberOfLines={3} style={{ position: "absolute", left: 14, right: 12, top: top + 13, fontFamily: FF.serif5, fontSize: 11.5, lineHeight: 16.7, color: P.ink }}>{s.clue}</Text>
    </>
  );
  let body: React.ReactNode;
  if (paper === "train") {
    body = (
      <>
        <Paper w={w} h={h} d={perf(w, h, 3.5, 11)} fill={c.bg} sh={P.sh} shadow="paper" />
        <View style={{ position: "absolute", left: 8, top: 8, right: 8, bottom: 8, borderWidth: 0.8, borderColor: c.art, opacity: 0.8 }} />
        <Text style={{ position: "absolute", left: 16, top: 26, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 2, color: c.art }}>{`PHOTO · ${s.time ?? ""}`}</Text>
        <Text numberOfLines={3} style={{ position: "absolute", left: 16, top: 44, right: 14, fontFamily: FF.serif5, fontSize: 12, lineHeight: 17.4, color: c.art }}>{s.clue}</Text>
      </>
    );
  } else if (paper === "dinner") {
    body = (
      <>
        <Paper w={w} h={h} fill={P.paper} sh={P.sh} shadow="paper" />
        <View style={{ position: "absolute", left: 8, top: 8, right: 8, bottom: 8, borderWidth: 0.8, borderColor: P.deep }} />
        <View style={{ position: "absolute", left: 33, top: 26, width: 80, height: 96, borderRadius: 999, overflow: "hidden" }}><OvalWin photo={photo} P={P} /></View>
        <View style={{ position: "absolute", left: 29, top: 22, width: 88, height: 104, borderRadius: 999, borderWidth: 0.6, borderColor: P.deep }} />
        {clue(134)}
      </>
    );
  } else if (paper === "cinema") {
    body = (
      <>
        <View style={{ position: "absolute", left: 40, top: -20, width: 56, height: 28, backgroundColor: P.deep, borderTopLeftRadius: 8, borderTopRightRadius: 8 }} />
        <Paper w={w} h={h} fill={P.paper} sh={P.sh} shadow="paper" />
        <View style={{ position: "absolute", left: 8, top: 8, right: 8, bottom: 8, borderWidth: 1, borderColor: P.deep }} />
        <Text style={{ position: "absolute", left: 16, top: 40, fontFamily: FF.script, paddingRight: 8, fontSize: 24, color: P.deep }}>develop me</Text>
        {clue(88)}
      </>
    );
  } else if (paper === "shop") {
    // 购物纸袋:提手两道、袋口一折;照片装进袋里
    body = (
      <>
        <Svg style={{ position: "absolute", left: 0, top: -26 }} width={w} height={34}>
          <Path d={`M${w * 0.3} 30 C${w * 0.3} 2 ${w * 0.45} 2 ${w * 0.45} 30`} fill="none" stroke={P.deep} strokeWidth={2.2} strokeLinecap="round" />
          <Path d={`M${w * 0.55} 30 C${w * 0.55} 2 ${w * 0.7} 2 ${w * 0.7} 30`} fill="none" stroke={P.deep} strokeWidth={2.2} strokeLinecap="round" />
        </Svg>
        <Paper w={w} h={h} fill={c.bg} sh={P.sh} shadow="paper" />
        <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: 26, backgroundColor: rgba(P.sh, 0.1) }} />
        <View style={{ position: "absolute", left: 8, top: 34, right: 8, bottom: 8, borderWidth: 0.8, borderColor: c.art, opacity: 0.8 }} />
        <Text style={{ position: "absolute", left: 16, top: 46, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 2, color: c.art }}>{`PHOTO · ${s.time ?? ""}`}</Text>
        <Text numberOfLines={4} style={{ position: "absolute", left: 16, top: 64, right: 14, fontFamily: FF.serif5, fontSize: 12, lineHeight: 17.4, color: c.art }}>{s.clue}</Text>
      </>
    );
  } else {
    body = (
      <>
        <Paper w={w} h={h} fill={P.envPaper} sh={P.sh} shadow="paper" />
        <Svg style={{ position: "absolute", left: 0, top: 0 }} width={w} height={50}><Path d={`M0 0 L${w} 0 L${w / 2} 50 Z`} fill={rgba(P.sh, 0.08)} /></Svg>
        <Text numberOfLines={2} style={{ position: "absolute", left: 14, right: 12, bottom: 14, fontFamily: FF.serif5, fontSize: 11.5, color: P.deep }}>{s.clue}</Text>
      </>
    );
  }
  const sx = paper === "walk" ? w / 2 - 17 : w - 40, sy = paper === "walk" ? 22 : -22, sw = paper === "walk" ? 34 : 52;
  return (
    <View style={{ width: w, height: h }}>
      {body}
      <PostSeal sealed={sealed} x={sx - 10} y={sy - 6} w={sw + 20} r={i % 2 ? -10 : 9} color={P.deep} time={s.time} />
    </View>
  );
}

/** 封口邮戳:没盖=悬在上面、歪着、大一点、淡;盖上=「啪」落到卡套口(原型 .unsealed .sealStk 的动作;
 * 贴纸、火漆都不合适,改成盖邮戳:一圈 KEPT · A MOMENT,中间那一站的时间,旁边几道波浪) */
const UNSEALED = 1.45;   // 没盖时的大小倍数
function PostSeal({ sealed, x, y, w, r, color, time }: { sealed: boolean; x: number; y: number; w: number; r: number; color: string; time: string | null }) {
  const t = useSharedValue(sealed ? 1 : 0);
  useEffect(() => { t.value = withTiming(sealed ? 1 : 0, { duration: 420, easing: Easing.bezier(0.6, -0.3, 0.7, 1.3) }); }, [sealed, t]);
  const st = useAnimatedStyle(() => ({
    opacity: 0.45 + 0.45 * t.value,
    // 按 1.45 倍真画(矢量),缩放终点 ≤1:没盖时停在 1.45 倍也不是放大的糊位图
    transform: [{ translateX: -30 * (1 - t.value) }, { translateY: -84 * (1 - t.value) }, { rotate: `${r + (-16 - r) * (1 - t.value)}deg` }, { scale: (1 + 0.45 * (1 - t.value)) / UNSEALED }],
  }));
  const c = w / 2, rr = w * 0.37, id = `ps${Math.round(w)}${Math.abs(r)}`;
  return (
    <Animated.View style={[{ position: "absolute", left: x - (w + 34) * (UNSEALED - 1) / 2, top: y - w * (UNSEALED - 1) / 2, width: (w + 34) * UNSEALED, height: w * UNSEALED }, st]} pointerEvents="none">
      <Svg width={(w + 34) * UNSEALED} height={w * UNSEALED} viewBox={`0 0 ${w + 34} ${w}`}>
        <Circle cx={c} cy={c} r={w * 0.46} fill="none" stroke={color} strokeWidth={1.6} />
        <Circle cx={c} cy={c} r={w * 0.29} fill="none" stroke={color} strokeWidth={0.8} />
        <Defs><Path id={id} d={`M${c},${c} m-${rr},0 a${rr},${rr} 0 1,1 ${2 * rr},0 a${rr},${rr} 0 1,1 -${2 * rr},0`} /></Defs>
        <SvgText fontFamily="EphemeraDisplay-Bold" fontSize={w * 0.105} letterSpacing={w * 0.02} fill={color}><TextPath href={`#${id}`}>KEPT · A MOMENT · KEPT · </TextPath></SvgText>
        <SvgText x={c} y={c + w * 0.06} textAnchor="middle" fontFamily="EphemeraDisplay-Black" fontSize={w * 0.17} fill={color}>{time ?? ""}</SvgText>
        {[0, 1, 2].map((k) => <Path key={k} d={`M${w - 2} ${c - 8 + k * 8} q4 -3 8 0 t8 0 t8 0 t8 0`} fill="none" stroke={color} strokeWidth={1.2} strokeLinecap="round" />)}
      </Svg>
    </Animated.View>
  );
}

// 新大类的卡套
type MapColorKey = "water" | "street" | "chip" | "park";
type KindSv = { t: "tix"; tk: [string, string]; env: string; bg: MapColorKey } | { t: "menu"; b: string; i: string } | { t: "walk"; i: string } | { t: "noren" } | { t: "key" } | { t: "note" };
export const KIND_SV: Record<string, KindSv> = {
  museum: { t: "tix", tk: ["admission", "No. 01"], env: "today’s exhibition", bg: "water" },
  aquarium: { t: "tix", tk: ["admission", "Blue"], env: "under the sea", bg: "water" },
  amusement: { t: "tix", tk: ["one day pass", "Ride"], env: "all day, all rides", bg: "street" },
  live: { t: "tix", tk: ["admit two", "Live"], env: "tonight’s stage", bg: "chip" },
  play: { t: "tix", tk: ["1 credit", "Play"], env: "game on", bg: "park" },
  sweets: { t: "menu", b: "Pâtisserie", i: "something sweet" },
  bar: { t: "menu", b: "Last Call", i: "two seats at the bar" },
  park: { t: "walk", i: "under the trees" },
  onsen: { t: "noren" }, stay: { t: "key" }, moment: { t: "note" },
};
/** 票头的缺口票形(小样 clip-path:两侧 40%–60% 处各一道 V 口),112×90 */
const TIX_PATH = "M0 0 H112 V36 L105.3 45 L112 54 V90 H0 V54 L6.7 45 L0 36 Z";
const alphaHex = (h: string, a: number) => { const n = parseInt(h.replace("#", ""), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

// ── 纪念盒路线页的卡套 ─────────────────────────────────────────────────────────────────
/** 路线页卡套后面露出的一角拍立得:这一站放了照片。放在卡套之前渲染=压在卡套底下 */
export function PhotoPeek({ testID }: { testID?: string }) {
  return (
    <View testID={testID} pointerEvents="none" style={{ position: "absolute", left: 92, top: -16, width: 62, height: 52, backgroundColor: "#FFFEFB", transform: [{ rotate: "9deg" }],
      shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 2 } }}>
      <View style={{ position: "absolute", left: 5, right: 5, top: 5, height: 36, backgroundColor: "#D9D2C6" }} />
    </View>
  );
}

export function RouteSleeve({ paper, s, i, M, opening, seen }: { paper: Paper4; s: Stop; i: number; M: MapPal; opening: boolean; seen: boolean }) {
  const t = useSharedValue(opening ? 1 : 0);
  useEffect(() => { t.value = withTiming(opening ? 1 : 0, { duration: paper === "dinner" ? 700 : 560, easing: Easing.bezier(0.3, 0, 0.2, 1) }); }, [opening, t, paper]);
  const no = two(i);
  const ic = icon(s.kind as never, M);
  const caps = (txt: string, color: string, extra?: object) => <Text style={[{ fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.4, color }, extra]}>{txt.toUpperCase()}</Text>;
  const Icon = ({ size }: { size: number }) => <View style={{ width: size, height: size }}><SvgXmlLite xml={ic} size={size} /></View>;
  const rule = (color: string) => <View style={{ position: "absolute", left: 6, top: 6, right: 6, bottom: 6, borderWidth: 0.8, borderColor: color, opacity: 0.55 }} pointerEvents="none" />;
  const pull = useAnimatedStyle(() => ({ transform: [{ translateY: -46 * t.value }] }));
  const pullC = useAnimatedStyle(() => ({ transform: [{ translateY: -40 * t.value }] }));
  const coverSt = useAnimatedStyle(() => ({ transform: [{ perspective: 700 }, { rotateX: `${-165 * t.value}deg` }], opacity: t.value > 0.5 ? 0 : 1 }));
  const flapSt = useAnimatedStyle(() => ({ transform: [{ perspective: 700 }, { rotateX: `${-170 * t.value}deg` }], opacity: t.value > 0.55 ? 0.6 : 1 }));
  const norenL = useAnimatedStyle(() => ({ transform: [{ translateX: -22 * t.value }, { rotate: `${-6 * t.value}deg` }] }));
  const norenR = useAnimatedStyle(() => ({ transform: [{ translateX: 22 * t.value }, { rotate: `${6 * t.value}deg` }] }));
  const shadow = shapeShadow(M.ink, 0.16, 6, 6);
  let body: React.ReactNode;
  const ksv = KIND_SV[s.kind ?? ""];
  if (ksv?.t === "tix") {
    // 门票夹:票头字 + 信封底色/信封字,票往上抽
    body = (
      <>
        <Animated.View style={[{ position: "absolute", left: 30, right: 30, top: -10, height: 90, alignItems: "center", paddingTop: 10 }, pullC]}>
          <Svg style={{ position: "absolute", left: 0, top: 0 }} width={112} height={90}><Path d={TIX_PATH} fill={M.card} /></Svg>
          {caps(ksv.tk[0], M.route, { letterSpacing: 1.56 })}
          <Text style={{ marginTop: 4, fontFamily: FF.pf9, fontSize: 20, lineHeight: 20, color: M.route }}>{ksv.tk[1]}</Text>
        </Animated.View>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 128, backgroundColor: M[ksv.bg], borderRadius: 4, alignItems: "center", justifyContent: "center", gap: 4 }}>
          <Icon size={26} />
          {caps(ksv.env, M.ink, { letterSpacing: 1.56 })}
          <Text style={{ fontFamily: FF.pf7I, fontSize: 12, color: M.ink }}>{s.time ?? ""}</Text>
        </View>
      </>
    );
  } else if (ksv?.t === "menu") {
    // 菜单卡(同晚餐那张,封面字换成这一类的):sweets=Pâtisserie / bar=Last Call
    body = (
      <>
        <View style={{ position: "absolute", left: 10, right: 10, top: 10, bottom: 0, backgroundColor: M.card, borderRadius: 3, alignItems: "center", justifyContent: "flex-end", paddingBottom: 12 }}>{caps("menu", M.title)}</View>
        <Animated.View style={[{ position: "absolute", left: 10, right: 10, top: 10, bottom: 0, backgroundColor: M.chip, borderRadius: 3, alignItems: "center", justifyContent: "center", gap: 6, transformOrigin: "top", backfaceVisibility: "hidden" }, coverSt]}>
          {rule(M.title)}
          <Icon size={34} />
          <Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 25, color: M.title }}>{ksv.b}</Text>
          {caps(ksv.i, M.title)}
        </Animated.View>
      </>
    );
  } else if (ksv?.t === "walk") {
    // 散步信封(park):信封字换成这一类的,翻盖上的小图是这一类的图标
    body = (
      <>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 124, backgroundColor: M.park, borderRadius: 4, alignItems: "center", justifyContent: "flex-end", paddingBottom: 16 }}>
          {rule(M.ink)}
          {caps(ksv.i, M.ink)}
          <Text style={{ marginTop: 4, fontFamily: FF.pf7I, fontSize: 13, color: M.ink }}>{s.time ?? ""}</Text>
        </View>
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, top: 44, height: 74, transformOrigin: "top", alignItems: "center", justifyContent: "flex-end" }, flapSt]}>
          <Svg style={{ position: "absolute" }} width={172} height={74}><Path d="M0 0 L172 0 L86 74 Z" fill={mix(M.park, M.ink, 0.82)} /></Svg>
          <View style={{ marginBottom: 14 }}><SvgXmlLite xml={ic} size={22} /></View>
        </Animated.View>
      </>
    );
  } else if (ksv?.t === "noren") {
    // 温泉暖帘(小样 .sv-noren):横杆 + 两幅布(ゆ / ♨)+ 下面卡片;打开=两幅布往两边掀
    body = (
      <>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 72, backgroundColor: M.card, borderBottomLeftRadius: 4, borderBottomRightRadius: 4, alignItems: "center", justifyContent: "center", gap: 3 }}>
          {caps("photo inside", M.ink)}
          <Text style={{ fontFamily: FF.pf7I, fontSize: 12, color: M.route }}>{s.time ?? ""}</Text>
        </View>
        <Animated.View style={[{ position: "absolute", left: 6, top: 10, width: 72, height: 92, backgroundColor: M.route, alignItems: "center", justifyContent: "center" }, norenL]}>
          <Text style={{ fontFamily: FF.serif7, fontSize: 26, lineHeight: 32, color: M.card }}>ゆ</Text>
        </Animated.View>
        <Animated.View style={[{ position: "absolute", right: 6, top: 10, width: 72, height: 92, backgroundColor: M.route, alignItems: "center", justifyContent: "center" }, norenR]}>
          {/* ♨ 打包字体里都没有这个字(不让它退成系统字):照字形画 */}
          <Svg width={30} height={30} viewBox="0 0 30 30">
            <Path d="M4 17c0 6 5 10 11 10s11-4 11-10" fill="none" stroke={M.card} strokeWidth={2.4} strokeLinecap="round" />
            <Path d="M8 15c0 3 3 5 7 5s7-2 7-5" fill="none" stroke={M.card} strokeWidth={2.2} strokeLinecap="round" />
            {[9, 15, 21].map((x) => <Path key={x} d={`M${x} 13c-2.4-2.6 2.4-4 0-7s2-4 0-5`} fill="none" stroke={M.card} strokeWidth={2} strokeLinecap="round" />)}
          </Svg>
        </Animated.View>
        <View style={{ position: "absolute", left: 4, right: 4, top: 6, height: 5, borderRadius: 3, backgroundColor: M.ink }} />
      </>
    );
  } else if (ksv?.t === "key") {
    // 房卡(小样 .sv-key):卡套 + 露头的房卡(打开=房卡往上抽)
    body = (
      <>
        <Animated.View style={[{ position: "absolute", left: 40, right: 18, top: 2, height: 72, borderRadius: 8, backgroundColor: M.card, shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 3, shadowOffset: { width: 0, height: 2 } }, pull]}>
          <View style={{ position: "absolute", left: 0, right: 0, top: 14, height: 12, backgroundColor: M.ink, opacity: 0.85 }} />
          <View style={{ position: "absolute", right: 12, bottom: 8 }}><Icon size={22} /></View>
        </Animated.View>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 118, backgroundColor: M.street, borderRadius: 6, paddingTop: 26, paddingHorizontal: 16 }}>
          {caps("room key · photo inside", M.ink, { letterSpacing: 1.56 })}
          <Text style={{ marginTop: 6, fontFamily: FF.pf9, fontSize: 19, lineHeight: 19, color: M.ink }}>Room 802</Text>
        </View>
      </>
    );
  } else if (ksv?.t === "note") {
    // 小纸条(小样 .sv-note):一件事;顶上几道横线,a little thing,时间 · we did
    body = (
      <View style={{ position: "absolute", left: 14, right: 14, top: 8, bottom: 6, backgroundColor: M.card, borderRadius: 2, transform: [{ rotate: "-2deg" }], alignItems: "center", justifyContent: "center", gap: 6,
        shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 2 } }}>
        {[7, 15, 23].map((y) => <View key={y} style={{ position: "absolute", left: 0, right: 0, top: y, height: 1, backgroundColor: alphaHex(M.route, 0.3) }} />)}
        <Icon size={22} />
        <Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 22, color: M.route }}>a little thing</Text>
        {caps(s.time ? `${s.time} · we did` : "we did", M.ink, { letterSpacing: 1.56 })}
      </View>
    );
  } else if (paper === "train") {
    body = (
      <>
        <Animated.View style={[{ position: "absolute", left: 22, right: 22, top: 2, height: 100, backgroundColor: M.card, alignItems: "center", paddingTop: 14, gap: 6 }, pull]}>
          {caps(`Ticket · ${no}`, M.route)}
          <Icon size={34} />
          <View style={{ position: "absolute", right: 12, top: 12, width: 9, height: 9, borderRadius: 5, backgroundColor: M.page }} />
        </Animated.View>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 112 }}>
          <Svg style={{ position: "absolute" }} width={172} height={112}><Path d="M0 18 Q0 0 18 0 L64 0 Q86 22 108 0 L154 0 Q172 0 172 18 L172 112 L0 112 Z" fill={M.street} /></Svg>
          {rule(M.ink)}
          <View style={{ paddingTop: 30, paddingHorizontal: 16 }}>
            {caps("photo inside", M.ink)}
            <Text style={{ marginTop: 5, fontFamily: FF.pf9, fontSize: 19, color: M.ink }}>{`Stop ${no}`}</Text>
            <Text style={{ marginTop: 6, fontFamily: FF.pf7I, fontSize: 11, color: M.route }}>{s.time ?? ""}</Text>
          </View>
        </View>
      </>
    );
  } else if (paper === "dinner") {
    body = (
      <>
        <View style={{ position: "absolute", left: 10, right: 10, top: 10, bottom: 0, backgroundColor: M.card, borderRadius: 3, alignItems: "center", justifyContent: "flex-end", paddingBottom: 12 }}>{caps("menu", M.title)}</View>
        <Animated.View style={[{ position: "absolute", left: 10, right: 10, top: 10, bottom: 0, backgroundColor: M.chip, borderRadius: 3, alignItems: "center", justifyContent: "center", gap: 6, transformOrigin: "top", backfaceVisibility: "hidden" }, coverSt]}>
          {rule(M.title)}
          <Icon size={34} />
          <Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 25, color: M.title }}>Réservation</Text>
          {caps("table for two", M.title)}
        </Animated.View>
      </>
    );
  } else if (paper === "cinema") {
    body = (
      <>
        <Animated.View style={[{ position: "absolute", left: 30, right: 30, top: -10, height: 90, backgroundColor: M.card, alignItems: "center", paddingTop: 10 }, pullC]}>
          {caps("Admit two", M.route)}
          <Text style={{ marginTop: 4, fontFamily: FF.pf9, fontSize: 22, color: M.route }}>{no}</Text>
        </Animated.View>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 128, backgroundColor: M.water, borderRadius: 4, alignItems: "center", justifyContent: "center", gap: 4 }}>
          <View style={{ position: "absolute", left: 10, right: 10, top: 9, flexDirection: "row", justifyContent: "space-between" }}>
            {Array.from({ length: 12 }, (_, k) => <View key={k} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: M.card }} />)}
          </View>
          {rule(M.ink)}
          <Icon size={34} />
          {caps("tonight's screening", M.ink)}
          <Text style={{ fontFamily: FF.pf7I, fontSize: 12, color: M.ink }}>{s.time ?? ""}</Text>
        </View>
      </>
    );
  } else if (paper === "shop") {
    body = (
      <>
        <Animated.View style={[{ position: "absolute", left: 34, right: 34, top: 4, height: 96, backgroundColor: M.card, alignItems: "center", paddingTop: 10 }, pullC]}>
          {caps("receipt", M.route)}
          <Text style={{ marginTop: 4, fontFamily: FF.mono, fontSize: 11, color: M.route }}>{no}</Text>
        </Animated.View>
        <Svg style={{ position: "absolute", left: 0, top: 8 }} width={172} height={30}>
          <Path d="M52 30 C52 4 76 4 76 30 M96 30 C96 4 120 4 120 30" fill="none" stroke={M.ink} strokeWidth={2} strokeLinecap="round" />
        </Svg>
        <View style={{ position: "absolute", left: 6, right: 6, bottom: 0, height: 124, backgroundColor: M.chip, borderRadius: 3, alignItems: "center", justifyContent: "center", gap: 4 }}>
          <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: 16, backgroundColor: rgba("0,0,0", 0.06) }} />
          {rule(M.ink)}
          <Icon size={34} />
          {caps("a little something", M.ink)}
          <Text style={{ fontFamily: FF.pf7I, fontSize: 12, color: M.ink }}>{s.time ?? ""}</Text>
        </View>
      </>
    );
  } else {
    body = (
      <>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 124, backgroundColor: M.park, borderRadius: 4, alignItems: "center", justifyContent: "flex-end", paddingBottom: 16 }}>
          {rule(M.ink)}
          {caps("for the walk home", M.ink)}
          <Text style={{ marginTop: 4, fontFamily: FF.pf7I, fontSize: 13, color: M.ink }}>{s.time ?? ""}</Text>
        </View>
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, top: 44, height: 74, transformOrigin: "top", alignItems: "center", justifyContent: "flex-end" }, flapSt]}>
          <Svg style={{ position: "absolute" }} width={172} height={74}><Path d="M0 0 L172 0 L86 74 Z" fill={mix(M.park, M.ink, 0.82)} /></Svg>
          <View style={{ marginBottom: 14 }}><SvgXmlLite xml={icon("moon", M)} size={22} /></View>
        </Animated.View>
      </>
    );
  }
  return (
    <View style={[{ position: "absolute", left: 0, top: 0, width: 172, height: 168 }, shadow]}>
      {body}
      <View style={{ position: "absolute", right: 8, bottom: 8, opacity: seen ? 1 : 0 }}>
        <Svg width={14} height={12} viewBox="0 0 16 14"><Path d="M8 13 C3 9.5 0 7 0 4 C0 1.8 1.8 0 4 0 C5.6 0 7 1 8 2.4 C9 1 10.4 0 12 0 C14.2 0 16 1.8 16 4 C16 7 13 9.5 8 13Z" fill={M.route} /></Svg>
      </View>
    </View>
  );
}

function SvgXmlLite({ xml, size }: { xml: string; size: number }) {
  return <SvgXml xml={xml} width={size} height={size} />;
}
