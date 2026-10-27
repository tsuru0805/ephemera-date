// 回忆式约会:每一盒多「一叠照片 + 她写给他的信」(他能回信)。小样=p3 原型 memoryFlat / archPhotos / archLetter。
// - 平铺页:平时只摆有的东西(有照片才有那一叠、有信才有信),零加号;钢笔尖在右下角、页码左边同一行,点了整盒进编辑态,
// 编辑态才出空位(空拍立得「放照片」、空白信纸「写给他」),照片页末尾多一个空框。
// - 摆法两种:只有一站 / 没有请柬的盒子=照片和信是主角(大);东西齐全的盒子=两样压在最上面(小),底下的露出一截照样点得到。
// - 照片=挂在整次约会上的那一叠(引擎 stop_id=null);每一站卡套里的照片照旧在路线页。
// - 「我先写一样」:他还没写的迟到的请柬 / 契约书 / 小卡,她可以先写(引擎 PUT /her/write)。
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { Easing, interpolate, runOnJS, type SharedValue, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import Svg, { Path } from "react-native-svg";
import { GrowingInput } from "../../components/GrowingInput";
import { type EphemeraError, ephemeraApi, LETTER_MAX, type HerPhoto, type HerState, type HerWrite, type Plan } from "../../lib/ephemeraApi";
import { Caps, Paper, PaperTex, useStage } from "./components";
import { lightboxDimOpacity, lightboxDragRotate, lightboxDragScale, lightboxShouldClose, PEN_RING_MS, PEN_SLOT_IN_MS, PEN_SLOT_OUT_MS, STACK_FAN_V, stackFanValue, stackShouldFly } from "./boxMotion";
import { dateParts, paperNo } from "./format";
import { PICK_ERR } from "./PhotoFlow";
import { deckle } from "./shapes";
import { FF, rgba, type MapPal, type Skin } from "./theme";
import { FlightSpot } from "./flight";
import { DepthKids } from "./depth";
import { herEn, herName, himEn, himName } from "../../runtime/session";

const WHITE = "#FFFEFB";
export const STACK_MAX = 60;          // 同引擎 PHOTO_PLAN_MAX(挂站 + 不挂站合计)
const CAPTION_MAX = 24;
export const WRITE_MAX = { invite: 200, card: 200, contract_item: 80, contract_items: 5 } as const;

/** 挂在整次约会上的那一叠(不属于某一站),按放进去的先后 */
export const stackPhotos = (photos: HerPhoto[]) =>
  photos.filter((p) => p.stop_id == null).sort((a, b) => a.created_at - b.created_at || a.id - b.id);

/** 只有一站、或者没有请柬的盒子:照片和信是主角 */
export const memorySolo = (plan: Pick<Plan, "stops">, hasInvite: boolean) => plan.stops.length <= 1 || !hasInvite;

/** 字数按码点算(与引擎 Python len 一致) */
const cpLen = (x: string) => Array.from(x).length;
const cpCut = (x: string, max: number) => (cpLen(x) > max ? Array.from(x).slice(0, max).join("") : x);

// ── 照片 ────────────────────────────────────────────────────────────────────────────
type Src = { uri: string; headers?: Record<string, string> };
/** 引擎那张要带 token 取 */
export function usePhotoSrc(planId: number, photoId: number | null): { src: Src | null; err: string | null; setErr: (e: string | null) => void } {
  const [src, setSrc] = useState<Src | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (photoId == null) { setSrc(null); return; }
    let alive = true;
    setErr(null);
    ephemeraApi.photoSource(planId, photoId).then((s) => { if (alive) setSrc(s); })
      .catch((e) => { console.warn("[Keepsakes] 照片没取到", e); if (alive) setErr((e as Error).message || "取不到"); });
    return () => { alive = false; };
  }, [planId, photoId]);
  return { src, err, setErr };
}

/** 拍立得:白边 + 下沿宽一点写小字;照片按原比例裁 */
export function Polaroid({ w, h, src, caption, P, children, err, onImgError }: { w: number; h: number; src: Src | null; caption?: string | null; P: Skin; children?: React.ReactNode;
  /** 照片取不到:写在那张上(不留一张空白让她猜) */ err?: string | null; onImgError?: (msg: string) => void }) {
  return (
    <View style={{ width: w, height: h, backgroundColor: WHITE, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.28, shadowRadius: 6, shadowOffset: { width: 0, height: 4 } }}>
      <View style={{ position: "absolute", left: 7, top: 7, width: w - 14, height: h - 40, backgroundColor: "#EFE8DD", overflow: "hidden" }}>
        {src && !err ? <Image source={src} style={{ width: "100%", height: "100%" }} resizeMode="cover"
          onError={(e) => onImgError?.(e.nativeEvent?.error ? String(e.nativeEvent.error) : "读不出来")} /> : null}
        {err ? <Text testID="polaroid-err" style={{ position: "absolute", left: 8, right: 8, top: 8, fontFamily: FF.serif5, fontSize: 10, lineHeight: 15, color: P.ink }}>{`这张照片没取到 · ${err}`}</Text> : null}
      </View>
      {caption ? <Text numberOfLines={1} style={{ position: "absolute", left: 10, right: 8, bottom: 7, fontFamily: FF.script, paddingRight: 6, fontSize: Math.max(13, Math.round(w / 12)), color: P.deep }}>{caption}</Text> : null}
      {children}
    </View>
  );
}

function NetPolaroid({ planId, ph, w, h, P, caption = true }: { planId: number; ph: HerPhoto; w: number; h: number; P: Skin; caption?: boolean }) {
  const { src, err, setErr } = usePhotoSrc(planId, ph.id);
  return <Polaroid w={w} h={h} src={src} caption={caption ? ph.caption : null} P={P} err={err} onImgError={setErr} />;
}

/** 空拍立得(编辑态的空位):虚线框 + 「+」 */
function EmptyPolaroid({ w, h, P, label }: { w: number; h: number; P: Skin; label?: string }) {
  return (
    <View style={{ width: w, height: h, backgroundColor: WHITE, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.22, shadowRadius: 5, shadowOffset: { width: 0, height: 3 } }}>
      <View style={{ position: "absolute", left: 9, right: 9, top: 9, bottom: 38, borderWidth: 1, borderStyle: "dashed", borderColor: P.deep, opacity: 0.6 }} />
      <Text style={{ position: "absolute", left: 0, right: 0, top: (h - 40) / 2 - 22, textAlign: "center", fontFamily: FF.corm, fontSize: 34, color: P.deep }}>+</Text>
      {label ? <Text style={{ position: "absolute", left: 0, right: 0, bottom: 12, textAlign: "center", fontFamily: FF.serif5, fontSize: 11, letterSpacing: 3.3, marginLeft: 3.3, color: P.deep }}>{label}</Text> : null}
    </View>
  );
}

/** 从相册选几张(一次可多选);她取消=[];取不到=抛原话 */
export async function pickMany(limit: number): Promise<ImagePicker.ImagePickerAsset[]> {
  let r: ImagePicker.ImagePickerResult;
  try {
    r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.85, allowsEditing: false, exif: false,
      allowsMultipleSelection: limit > 1, selectionLimit: Math.max(1, limit), orderedSelection: true });
  } catch (e) {
    throw new Error(PICK_ERR.failed((e as Error)?.message || "相册打不开"));
  }
  if (r.canceled) return [];
  const got = (r.assets ?? []).filter((a) => !!a?.uri);
  if (!got.length) throw new Error(PICK_ERR.empty);
  return got;
}

// ── 往那一叠里放照片:一张张传,每张写进度;没传上的留着、写原话、点一下再传 ──────────────────────────
export type StackUp = { key: string; asset: ImagePicker.ImagePickerAsset; clientId: string; pct: number | null; err: string | null; replaceId?: number };
export function useStackUploads(planId: number, onSaved: () => void) {
  const [ups, setUpsState] = useState<StackUp[]>([]);
  const ref = useRef<StackUp[]>([]);
  const setUps = (fn: (u: StackUp[]) => StackUp[]) => { ref.current = fn(ref.current); setUpsState(ref.current); };
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const patch = (key: string, p: Partial<StackUp>) => setUps((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const run = async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const next = ref.current.find((x) => x.err == null && x.pct == null);
        if (!next || !alive.current) return;
        patch(next.key, { pct: 0 });
        try {
          await ephemeraApi.uploadPhoto(planId, null, next.asset, "", next.clientId, (f) => { if (alive.current) patch(next.key, { pct: f }); }, false, next.replaceId);
          if (!alive.current) return;
          setUps((u) => u.filter((x) => x.key !== next.key));
          onSaved();
        } catch (e) {
          console.warn("[Keepsakes] 照片没传上", e);
          if (!alive.current) continue;
          // 要换的那张已经不在了(别处拿掉 / 已经换过):不再指着它,再点一下当新的一张放进去
          if (next.replaceId != null && (e as EphemeraError).status === 404) patch(next.key, { pct: null, replaceId: undefined, err: "要换的那张已经不在了 · 点一下当新的一张放进去" });
          else patch(next.key, { pct: null, err: `没传上 · ${(e as Error).message} · 点一下再传` });
        }
      }
    } finally {
      running.current = false;
    }
  };
  const add = (assets: ImagePicker.ImagePickerAsset[], replaceId?: number) => {
    const t = Date.now().toString(36);
    setUps((u) => [...u, ...assets.map((a, k) => ({ key: `${t}-${k}`, asset: a, clientId: `st-${planId}-${t}-${k}-${Math.random().toString(36).slice(2, 8)}`, pct: null, err: null, replaceId }))]);
    run();
  };
  const retry = (key: string) => { patch(key, { err: null, pct: null }); run(); };
  /** 没传上的那几张不要了(她离开前确认过) */
  const drop = () => setUps((u) => u.filter((x) => x.err == null));
  return { ups, add, retry, drop };
}

/** 一张正在传 / 没传上的(本地照片 + 状态那一行) */
function UpPolaroid({ u, w, h, P }: { u: StackUp; w: number; h: number; P: Skin }) {
  const line = u.err ?? (u.pct == null ? "等着传" : `上传中 ${Math.round(u.pct * 100)}%`);
  return (
    <Polaroid w={w} h={h} src={{ uri: u.asset.uri }} P={P}>
      <View style={{ position: "absolute", left: 7, right: 7, top: 7, height: h - 40, backgroundColor: rgba(P.sh, u.err ? 0.45 : 0.25) }} />
      <Text testID="stack-up-line" numberOfLines={3} style={{ position: "absolute", left: 10, right: 8, bottom: 6, fontFamily: FF.serif5, fontSize: 9.5, lineHeight: 13, color: P.ink }}>{line}</Text>
    </Polaroid>
  );
}

// ── 钢笔尖(平铺页右下角,页码左边同一行;编辑态外加一圈)────────────────────────────────────
// 进编辑态外圈画出来(淡入+从里往外长),笔尖画一下(转一圈回正);退出同样沉回去(手感时长照抄原型 toggleEdit)。
export function PenNib({ on, M, P, onPress, style }: { on: boolean; M: MapPal; P: Skin; onPress: () => void; style: object }) {
  const ring = useSharedValue(on ? 1 : 0);
  const spin = useSharedValue(0);
  const mounted = useRef(false);
  useEffect(() => {
    ring.value = withTiming(on ? 1 : 0, { duration: PEN_RING_MS, easing: Easing.bezier(0.3, 0.72, 0.1, 1) });
    if (mounted.current) { spin.value = on ? -28 : 18; spin.value = withTiming(0, calm(520)); }
    mounted.current = true;
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  const ringSt = useAnimatedStyle(() => ({ opacity: ring.value, transform: [{ scale: 0.7 + 0.3 * ring.value }] }));
  const svgSt = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value}deg` }] }));
  return (
    <Pressable onPress={onPress} hitSlop={8} testID="flat-pen" accessibilityLabel="编辑" accessibilityState={{ selected: on }}
      style={[{ position: "absolute", width: 30, height: 30, borderRadius: 15, backgroundColor: M.route, alignItems: "center", justifyContent: "center", zIndex: 9, opacity: on ? 1 : 0.92 }, style]}>
      {/* 编辑态外一圈(小样:隔 3px 纸色,再一道 1.2px 深色)——淡入 + 从里往外长,不是直接出现 */}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: -4.2, top: -4.2, width: 38.4, height: 38.4, borderRadius: 19.2, borderWidth: 1.2, borderColor: P.deep }, ringSt]} />
      <Animated.View style={svgSt}>
        <Svg width={15} height={15} viewBox="0 0 24 24"><Path d="M4 20 L7 13 L15 5 L19 9 L11 17 Z M15 5 L19 9" fill="none" stroke={M.card} strokeWidth={1.6} strokeLinejoin="round" /></Svg>
      </Animated.View>
    </Pressable>
  );
}

// ── 平铺页上的两样 ──────────────────────────────────────────────────────────────────
type Lay = { stack: { left: number; top: number; w: number; h: number; ps: Array<[number, number, number, number, number]>; count: boolean };
  empty: { left: number; top: number; w: number; h: number; r: number }; letter: { left: number; top: number; w: number; h: number; r: number; big: boolean } };
/** 摆法(小样 memoryFlat / 齐全那一盒的 memoryTop);ps=[左, 上, 宽, 高, 角度],第 0 张压在最上面带小字 */
const LAY: Record<"solo" | "top", Lay> = {
  solo: { stack: { left: 150, top: 438, w: 230, h: 300, ps: [[30, 44, 176, 214, -2], [10, 14, 150, 182, -9], [66, 6, 150, 182, 11]], count: true },
    empty: { left: 176, top: 470, w: 176, h: 214, r: -3 }, letter: { left: 16, top: 600, w: 214, h: 150, r: -8, big: true } },
  top: { stack: { left: 178, top: 652, w: 190, h: 200, ps: [[26, 24, 124, 150, -2], [6, 8, 104, 126, -8], [62, 0, 104, 126, 10]], count: false },
    empty: { left: 204, top: 676, w: 124, h: 150, r: -3 }, letter: { left: -8, top: 664, w: 188, h: 132, r: -7, big: false } },
};
/** 齐全那一盒的两样贴着页底摆:按这一页实际可见高度往上让(小样 780 高;矮的手机原位会被底部导航压掉一大半,模拟器实见) */
export const layFor = (solo: boolean, ph: number): Lay => {
  if (solo) return LAY.solo;
  const t = LAY.top;
  return { stack: { ...t.stack, top: Math.min(t.stack.top, ph - 150) }, empty: { ...t.empty, top: Math.min(t.empty.top, ph - 128) },
    letter: { ...t.letter, top: Math.min(t.letter.top, ph - 140) } };
};

/** 编辑态才出的空位(空拍立得「放照片」、空白信纸「写给他」)——进编辑态从纸面浮上来,
 * 退出沉回去再真的拿掉(不是说没就没;show 变 false 后还留一拍把退场动完才卸载)。
 *  外层给绝对铺满 + box-none,不改变里面 Pressable 原有的绝对定位坐标系(手感时长照抄 PEN_SLOT_IN/OUT_MS)。 */
function RiseSlot({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(show);
  const t = useSharedValue(show ? 1 : 0);
  useEffect(() => {
    if (show) { setMounted(true); t.value = withTiming(1, { duration: PEN_SLOT_IN_MS, easing: Easing.bezier(0.3, 0.72, 0.1, 1) }); }
    else t.value = withTiming(0, { duration: PEN_SLOT_OUT_MS, easing: Easing.bezier(0.5, 0, 0.75, 0) }, (fin) => { if (fin) runOnJS(setMounted)(false); });
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ opacity: t.value, transform: [{ translateY: (1 - t.value) * 30 }, { scale: 0.86 + 0.14 * t.value }] }));
  if (!mounted) return null;
  return <Animated.View pointerEvents="box-none" style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, st]}>{children}</Animated.View>;
}

/** 一叠照片里被散开的那一张:fan=往上拨散开多少,flyT=决定飞走之后继续往外飞 + 淡出 */
function StackPhotoItem({ k, fan, flyT, baseRotate, children }: { k: number; fan: SharedValue<number>; flyT: SharedValue<number>; baseRotate: number; children: React.ReactNode }) {
  const st = useAnimatedStyle(() => {
    const [vx, vy, vr] = STACK_FAN_V[k];
    const mult = flyT.value > 0 ? 1 + flyT.value * 2.4 : fan.value;
    return {
      opacity: 1 - flyT.value,
      transform: [{ translateX: vx * mult }, { translateY: vy * mult - flyT.value * 260 }, { rotate: `${baseRotate + vr * mult}deg` }, { scale: 1 - 0.25 * flyT.value }],
    };
  });
  return <Animated.View style={st}>{children}</Animated.View>;
}

export function FlatKeepsakes({ plan, photos, ups, P, solo, ph, editing, onPhotos, onAddPhotos, onLetter, onFlyPhotos, onFlyLetter }: {
  plan: Plan; photos: HerPhoto[]; ups: StackUp[]; P: Skin; solo: boolean; ph: number; editing: boolean;
  /** 一叠照片各自飞到照片页它那张的位置(fan=此刻散开多少,起点转角要补);信飞起展开成信页。不给=照旧翻页 */
  onFlyPhotos?: (fan: number) => Promise<void>; onFlyLetter?: () => Promise<void>;
  /** 点那一叠=翻到照片页;点空拍立得=放照片;点信=翻到信页;点空白信纸=写信 */
  onPhotos: () => void; onAddPhotos: () => void; onLetter: (write: boolean) => void;
}) {
  const L = layFor(solo, ph);
  const n = photos.length;
  const shown = photos.slice(0, 3); // 最上面那张=第一张
  const lt = L.letter;
  // 一叠照片往上拨跟手散开,够了(或点)飞去照片页摆好(手感=boxMotion stackFanValue/stackShouldFly)
  const fan = useSharedValue(0);
  const flyT = useSharedValue(0);
  const movedSV = useSharedValue(0);
  const onStackEnd = (moved: boolean, f: number, vy: number) => {
    if (stackShouldFly(moved, false, f, vy)) {
      // 散开到哪就从哪起飞,一张张落到照片页它那张的位置(飞行层);落定后这一叠收回原样
      if (onFlyPhotos) { onFlyPhotos(f).finally(() => { fan.value = 0; }); return; }
      flyT.value = withTiming(1, { duration: 620, easing: Easing.out(Easing.cubic) }, (fin) => {
        if (fin) { runOnJS(onPhotos)(); }
      });
    } else {
      fan.value = withSpring(0, { damping: 12, stiffness: 120 });
    }
  };
  // 手势缓存着(useMemo []),回调要取最新的:否则抓住首次渲染时的 onFlyPhotos(那时还没照片)=往上拨没反应
  const stackEndRef = useRef(onStackEnd);
  stackEndRef.current = onStackEnd;
  const callStackEnd = useCallback((m: boolean, f: number, vy: number) => stackEndRef.current(m, f, vy), []);
  const stackPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-10, 10]).failOffsetX([-12, 12])   // 只认往上下拨;左右划留给翻页
        .onBegin(() => { movedSV.value = 0; })
        .onUpdate((e) => {
          if (Math.abs(e.translationY) > 6) movedSV.value = 1;
          fan.value = stackFanValue(e.translationY);
        })
        .onEnd((e) => { runOnJS(callStackEnd)(movedSV.value === 1, fan.value, e.velocityY); }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const capSt = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - Math.max(fan.value, flyT.value) * 2) }));
  // 点一下信纸,先飞起摆正一下再展开成整页(信页那边另接回信随后压上来)
  const letterLift = useSharedValue(0);
  const tapLetter = () => {
    if (onFlyLetter) { onFlyLetter(); return; }   // 信纸飞起摆正、展开成信页那一张(飞行层)
    letterLift.value = withTiming(1, { duration: 380, easing: Easing.bezier(0.3, 0.72, 0.1, 1) }, (fin) => { if (fin) runOnJS(onLetter)(false); });
  };
  const letterSt = useAnimatedStyle(() => ({
    opacity: 1 - 0.15 * letterLift.value,
    transform: [{ translateY: -24 * letterLift.value }, { scale: 1 + 0.06 * letterLift.value }, { rotate: `${lt.r * (1 - letterLift.value)}deg` }],
  }));
  return (
    <DepthKids start={6}>
      {!plan.letter && plan.reply && !editing ? (
        // 她的信拿掉了、他的回信还在(引擎留着):放他那张,点了去信页
        <Pressable onPress={() => onLetter(false)} testID="flat-reply" accessibilityLabel={`${himName()}的回信`}
          style={{ position: "absolute", left: lt.left, top: lt.top, width: lt.w, height: lt.h, transform: [{ rotate: `${lt.r}deg` }], zIndex: 7 }}>
          <Paper w={lt.w} h={lt.h} d={deckle(lt.w, lt.h, 1.4, 4)} fill={P.paper2} sh={P.sh} texture={0.4} />
          <View style={{ position: "absolute", left: 9, top: 9, right: 9, bottom: 9, borderWidth: 1, borderColor: P.deep, opacity: 0.7 }} />
          <Text style={{ position: "absolute", left: 20, top: 20, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.6, color: P.deep }}>{`${himEn().toUpperCase()} WROTE BACK`}</Text>
          <Text style={{ position: "absolute", left: 20, top: 36, fontFamily: FF.script, paddingRight: 8, fontSize: lt.big ? 24 : 21, color: P.deep }}>{`Dear ${herEn()},`}</Text>
        </Pressable>
      ) : plan.letter ? (
        <Pressable onPress={tapLetter} testID="flat-letter" accessibilityLabel={`${herName()}写的信`}
          style={{ position: "absolute", left: lt.left, top: lt.top, width: lt.w, height: lt.h, zIndex: 7 }}>
          <Animated.View style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, letterSt]}>
            <FlightSpot k={`fl:${plan.id}`} rot={lt.r} style={{ position: "absolute", left: 0, top: 0, width: lt.w, height: lt.h }}>
            <Paper w={lt.w} h={lt.h} d={deckle(lt.w, lt.h, 1.4, 4)} fill={P.paper} sh={P.sh} texture={0.6} />
            <Text style={{ position: "absolute", left: lt.big ? 18 : 16, top: lt.big ? 18 : 16, fontFamily: FF.pf7, fontSize: lt.big ? 6.5 : 6, letterSpacing: 1.6, color: P.ink }}>{`A LETTER · ${dateParts(plan.date).long}`}</Text>
            <Text style={{ position: "absolute", left: lt.big ? 18 : 16, top: lt.big ? 30 : 26, fontFamily: FF.script, paddingRight: 8, fontSize: lt.big ? 28 : 25, color: P.deep }}>{`for ${himEn()},`}</Text>
            <View style={{ position: "absolute", left: lt.big ? 18 : 16, right: lt.big ? 16 : 14, top: lt.big ? 88 : 76, borderTopWidth: 0.6, borderTopColor: rgba(P.sh, 0.3) }} />
            <View style={{ position: "absolute", left: lt.big ? 18 : 16, right: lt.big ? 40 : 36, top: lt.big ? 102 : 90, borderTopWidth: 0.6, borderTopColor: rgba(P.sh, 0.3) }} />
            <Text style={{ position: "absolute", right: lt.big ? 18 : 16, bottom: lt.big ? 12 : 10, fontFamily: FF.script, paddingRight: 6, fontSize: lt.big ? 17 : 15, color: P.deep }}>{`from ${herEn()}`}</Text>
            </FlightSpot>
          </Animated.View>
        </Pressable>
      ) : (
        // 空白信纸「写给他」只在编辑态出:进场从纸面浮上来,退场沉回去
        <RiseSlot show={editing}>
          <Pressable onPress={() => onLetter(true)} testID="flat-letter-blank" accessibilityLabel={`写给${himName()}`}
            style={{ position: "absolute", left: lt.left, top: lt.top, width: lt.w, height: lt.h, transform: [{ rotate: `${lt.r}deg` }], zIndex: 7 }}>
            <Paper w={lt.w} h={lt.h} d={deckle(lt.w, lt.h, 1.4, 4)} fill={P.paper} sh={P.sh} texture={0} />
            <View style={{ position: "absolute", left: 9, top: 9, right: 9, bottom: 9, borderWidth: 0.8, borderStyle: "dashed", borderColor: P.deep, opacity: 0.5 }} />
            <Text style={{ position: "absolute", left: 20, top: 26, fontFamily: FF.script, paddingRight: 8, fontSize: lt.big ? 26 : 22, color: P.deep, opacity: 0.55 }}>{`for ${himEn()},`}</Text>
            {(lt.big ? [74, 92, 110] : [66, 82]).map((y) => <View key={y} style={{ position: "absolute", left: 20, right: 20, top: y, borderTopWidth: 0.6, borderTopColor: rgba(P.sh, 0.25) }} />)}
            <Text style={{ position: "absolute", right: 20, bottom: 16, fontFamily: FF.serif5, fontSize: 11, letterSpacing: 3.3, color: P.deep }}>{`写给${himName()}`}</Text>
          </Pressable>
        </RiseSlot>
      )}
      {n ? (
        <GestureDetector gesture={Gesture.Race(stackPan, Gesture.Tap().maxDuration(500).onEnd(() => { runOnJS(onStackEnd)(false, 0, 0); }))}>
          <View testID="flat-stack" accessibilityLabel="照片" accessibilityRole="button"
            style={{ position: "absolute", left: L.stack.left, top: L.stack.top, width: L.stack.w, height: L.stack.h, zIndex: 8 }}>
            {shown.map((ph, k) => ({ ph, k })).reverse().map(({ ph, k }) => {
              const [x, y, w, h, r] = L.stack.ps[k];
              return (
                <View key={ph.id} style={{ position: "absolute", left: x, top: y }}>
                  <StackPhotoItem k={k} fan={fan} flyT={flyT} baseRotate={r}>
                    <FlightSpot k={`kp:${ph.id}`} rot={r} style={{ width: w, height: h }}>
                      <NetPolaroid planId={plan.id} ph={ph} w={w} h={h} P={P} caption={k === 0} />
                    </FlightSpot>
                  </StackPhotoItem>
                </View>
              );
            })}
            {L.stack.count ? <Animated.Text style={[{ position: "absolute", right: 2, top: 268, textAlign: "right", fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.7, color: P.deep }, capSt]}>{`${String(n).padStart(2, "0")} PHOTOS KEPT`}</Animated.Text> : null}
          </View>
        </GestureDetector>
      ) : (
        // 空拍立得「放照片」只在编辑态(或还在传)出:同样浮上来/沉回去
        <RiseSlot show={editing || ups.length > 0}>
          <Pressable onPress={onAddPhotos} testID="flat-add-photos" accessibilityLabel="放照片"
            style={{ position: "absolute", left: L.empty.left, top: L.empty.top, transform: [{ rotate: `${L.empty.r}deg` }], zIndex: 8 }}>
            {ups.length ? <UpPolaroid u={ups[0]} w={L.empty.w} h={L.empty.h} P={P} /> : <EmptyPolaroid w={L.empty.w} h={L.empty.h} P={P} label="放照片" />}
          </Pressable>
        </RiseSlot>
      )}
    </DepthKids>
  );
}

// ── 照片页「What We Kept」:一张主图 + 大小不一压叠、出血到页边;可上下滑;点哪张看哪张 ───────────────────────
/** 摆法(小样 archPhotos):[左, 上, 宽, 高, 角度];九张一组,往下接着摆 */
const PH_L: Array<[number, number, number, number, number]> = [
  [24, 214, 222, 270, -2.5], [228, 244, 148, 180, 6], [8, 502, 166, 202, 4], [162, 476, 188, 228, -5],
  [40, 726, 150, 182, -7], [198, 716, 168, 204, 3], [8, 936, 194, 236, 2], [206, 962, 154, 188, -6], [66, 1168, 178, 216, 5]];
const PH_BLOCK = 1190;
export const photoSlot = (k: number): [number, number, number, number, number] => {
  const [x, y, w, h, r] = PH_L[k % PH_L.length];
  return [x, y + Math.floor(k / PH_L.length) * PH_BLOCK, w, h, r];
};

export function PhotosPage({ plan, photos, ups, P, M, ph, editing, onOpen, onAdd, onRetry }: {
  plan: Plan; photos: HerPhoto[]; ups: StackUp[]; P: Skin; M: MapPal; ph: number; editing: boolean;
  onOpen: (p: HerPhoto) => void; onAdd: () => void; onRetry: (key: string) => void;
}) {
  const n = photos.length;
  const slots = n + ups.length + (editing && n + ups.length < STACK_MAX ? 1 : 0);
  const last = slots ? photoSlot(slots - 1) : null;
  const H = Math.max(ph, last ? last[1] + last[3] + 120 : ph);
  return (
    <View style={{ flex: 1, backgroundColor: M.page }}>
      <PaperTex />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ height: H }} showsVerticalScrollIndicator={false} testID="photos-page">
        <View style={{ position: "absolute", left: 22, right: 22, top: 70, paddingTop: 10, borderTopWidth: 1, borderTopColor: M.ink }}>
          <Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.8, color: M.ink, opacity: 0.8 }}>{`NO. ${paperNo(plan)} · ${dateParts(plan.date).dot} · ${n} ${n === 1 ? "PHOTO" : "PHOTOS"}`}</Text>
          <Text style={{ marginTop: 10, fontFamily: FF.pf9, fontSize: 40, lineHeight: 38, letterSpacing: -0.8, color: M.title }}>{"What We\nKept"}</Text>
          <Text style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 12, letterSpacing: 3.6, color: M.ink, opacity: 0.7 }}>{`那天留下的 ${n} 张`}</Text>
        </View>
        <DepthKids>
        {photos.map((p, k) => {
          const [x, y, w, h, r] = photoSlot(k);
          return (
            <Pressable key={p.id} onPress={() => onOpen(p)} testID={`stack-photo-${p.id}`} accessibilityLabel="看这张照片"
              style={{ position: "absolute", left: x, top: y, width: w, height: h, transform: [{ rotate: `${r}deg` }], zIndex: k === 0 ? 3 : 2 + (k % 3) }}>
              <FlightSpot k={`pp:${p.id}`} rot={r} style={{ width: w, height: h }}>
                <NetPolaroid planId={plan.id} ph={p} w={w} h={h} P={P} />
              </FlightSpot>
            </Pressable>
          );
        })}
        </DepthKids>
        {ups.map((u, j) => {
          const [x, y, w, h, r] = photoSlot(n + j);
          return (
            <Pressable key={u.key} onPress={() => { if (u.err) onRetry(u.key); }} disabled={!u.err} testID={`stack-up-${j}`}
              style={{ position: "absolute", left: x, top: y, transform: [{ rotate: `${r}deg` }], zIndex: 2 }}>
              <UpPolaroid u={u} w={w} h={h} P={P} />
            </Pressable>
          );
        })}
        {editing && n + ups.length < STACK_MAX ? (() => {
          const [x, y, w, h, r] = photoSlot(n + ups.length);
          return (
            <Pressable onPress={onAdd} testID="stack-add" accessibilityLabel="放照片" style={{ position: "absolute", left: x, top: y, transform: [{ rotate: `${r}deg` }], zIndex: 2 }}>
              <EmptyPolaroid w={w} h={h} P={P} />
            </Pressable>
          );
        })() : null}
        {n ? <Text style={{ position: "absolute", left: 22, top: H - 70, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.6, color: M.ink, opacity: 0.7 }}>TAP A PHOTO TO OPEN</Text> : null}
      </ScrollView>
    </View>
  );
}

/** 点开那一叠里的一张:平时只看;编辑态可改小字 / 换一张 / 拿掉(拿掉要点两下) */
export function StackPhotoPop({ plan, photo, P, editing, swapping, onClose, onSwap, onChanged, flown }: {
  plan: Plan; photo: HerPhoto; P: Skin; editing: boolean; onClose: () => void;
  /** 是从照片页那一张飞过来的(飞行层)=不再自己从小弹大 */
  flown?: boolean;
  /** 这一张已经在换(选好了、排着或正在传):不能再换一次 */
  swapping: boolean;
  /** 换一张:宿主选图后按「换掉这一张」传 */
  onSwap: () => void; onChanged: (h?: HerState) => Promise<unknown>;
}) {
  const { s: sc, top, H } = useStage();
  const { src, err: srcErr, setErr: setSrcErr } = usePhotoSrc(plan.id, photo.id);
  const [cap, setCap] = useState(photo.caption ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [cardH, setCardH] = useState(0);
  const t = useSharedValue(0);
  useEffect(() => { t.value = flown ? 1 : withTiming(1, calm()); }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  // 拿起放大之后按住能拖着走,拖远了(或甩得快)松手就收回去;没拖远就弹回原位
  const dragX = useSharedValue(0), dragY = useSharedValue(0);
  const closeRef = useRef(() => {});
  closeRef.current = () => { if (!busy) onClose(); };   // 拖放手势缓存着,取最新(保存小字时 busy 拦得住;review)
  const closeNow = useCallback(() => closeRef.current(), []);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((e) => { dragX.value = e.translationX; dragY.value = e.translationY; })
        .onEnd((e) => {
          const dist = Math.hypot(dragX.value, dragY.value);
          const speed = Math.hypot(e.velocityX, e.velocityY);
          if (lightboxShouldClose(dist > 4, dist, speed)) { runOnJS(closeNow)(); return; }
          dragX.value = withSpring(0, { damping: 14, stiffness: 170 });
          dragY.value = withSpring(0, { damping: 14, stiffness: 170 });
        }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const box = useAnimatedStyle(() => {
    const dist = Math.hypot(dragX.value, dragY.value);
    const k = lightboxDragScale(dist);
    return { opacity: Math.min(1, t.value * 2), transform: [{ translateX: dragX.value }, { translateY: dragY.value }, { scale: (0.3 + 0.7 * t.value) * k }, { rotate: `${lightboxDragRotate(-2, dragX.value)}deg` }] };
  });
  const dimSt = useAnimatedStyle(() => ({ opacity: Math.min(1, t.value * 2) * lightboxDimOpacity(Math.hypot(dragX.value, dragY.value)) }));
  const kb = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: Math.min(0, kb.height.value * 0.75) / sc }] }));
  const run = async (fn: () => Promise<HerState | undefined>, close: boolean) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await onChanged(await fn()); if (close) onClose(); } catch (e) { setErr(`没改成 · ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const capDirty = (cap.trim() || "") !== (photo.caption ?? "");
  return (
    <Pressable onPress={closeNow} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 15 }} accessibilityLabel="收回">
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.4) }, dimSt]} />
      <View style={{ position: "absolute", left: 0, top, width: 390, height: H, transform: [{ scale: sc }], transformOrigin: "top left" }} pointerEvents="box-none">
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }, lift]} pointerEvents="box-none">
          <GestureDetector gesture={Gesture.Race(pan, Gesture.Tap().maxDuration(500).onEnd(() => { runOnJS(closeNow)(); }))}>
            <Animated.View style={[{ position: "absolute", left: 55, top: 120 }, box]}>
              <FlightSpot k={`pop:${photo.id}`} rot={-2} style={{ width: 280, height: 340 }}>
                <Polaroid w={280} h={340} src={src} caption={editing ? null : photo.caption} P={P} err={srcErr} onImgError={setSrcErr} />
              </FlightSpot>
            </Animated.View>
          </GestureDetector>
          {editing ? (
            <Pressable onPress={(e) => e.stopPropagation()} style={{ position: "absolute", left: 36, width: 318, top: 482, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 18 }}
              onLayout={(e) => setCardH(Math.ceil(e.nativeEvent.layout.height))}>
              {/* 底下垫一张纸:照片页在后面,字不能直接压在照片上 */}
              {cardH ? <View style={{ position: "absolute", left: 0, top: 0 }} pointerEvents="none"><Paper w={318} h={cardH} d={deckle(318, cardH, 1.4, 4)} fill={P.paper} sh={P.sh} shadow="paper" /></View> : null}
              <View style={{ flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: rgba(P.sh, 0.35) }}>
                <TextInput value={cap} onChangeText={(x) => setCap(cpCut(x, CAPTION_MAX))} placeholder="写一行小字" placeholderTextColor={rgba(P.sh, 0.5)} editable={!busy}
                  testID="stack-caption" style={{ flex: 1, paddingVertical: 8, fontFamily: FF.serif5, fontSize: 14, color: P.ink }} />
                <Pressable onPress={() => run(async () => { await ephemeraApi.photoCaption(plan.id, photo.id, cap.trim()); return undefined; }, false)} disabled={!capDirty || busy} hitSlop={8} style={{ opacity: capDirty && !busy ? 1 : 0.35 }} accessibilityLabel="存小字">
                  <Text style={{ fontFamily: FF.serif7, fontSize: 12, letterSpacing: 2.4, color: P.deep }}>存小字</Text>
                </Pressable>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 20 }}>
                <Pressable onPress={() => { if (!busy && !swapping) onSwap(); }} disabled={swapping} hitSlop={8} accessibilityLabel={swapping ? "正在换这一张" : "换一张"} testID="stack-swap">
                  <Text style={{ fontFamily: FF.serif7, fontSize: 13, letterSpacing: 2.6, color: P.deep, opacity: swapping ? 0.5 : 1 }}>{swapping ? "正在换这一张" : "换一张 ›"}</Text>
                </Pressable>
                <Pressable onPress={() => { if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 2600); return; } run(() => ephemeraApi.removePhoto(plan.id, photo.id), true); }}
                  hitSlop={8} testID="stack-remove" accessibilityLabel={armed ? "再点一下拿掉" : "拿掉这张"}>
                  <Text style={{ fontFamily: FF.serif5, fontSize: 12.5, letterSpacing: 2.4, color: P.ink, opacity: armed ? 1 : 0.75 }}>{armed ? "再点一下拿掉" : "拿掉这张"}</Text>
                </Pressable>
              </View>
              {err ? <Text style={{ marginTop: 12, fontFamily: FF.serif5, fontSize: 11.5, lineHeight: 17, color: P.ink }}>{err}</Text> : null}
            </Pressable>
          ) : null}
        </Animated.View>
      </View>
    </Pressable>
  );
}

// ── 信页:她写给他的那封(横线信纸),他的回信压在右下角 ─────────────────────────────────────
const LW = 338, LINE = 26;
export function LetterPage({ plan, P, M, ph, editing, onEdit, landKey }: { plan: Plan; P: Skin; M: MapPal; ph: number; editing: boolean; onEdit: () => void; landKey?: number }) {
  const [textH, setTextH] = useState(0);
  const [replyH, setReplyH] = useState(0);
  // 信纸飞起摆正展开成整页之后,他的回信随后压上来(略晚一拍,从歪着飘进来到压稳)
  const replyT = useSharedValue(0);
  useEffect(() => {
    if (!plan.reply) return;
    if (landKey != null && landKey < 0) { replyT.value = 0; return; }   // 信正在飞过来:回信先藏着,落定(landKey 变成时间)再压上来
    replyT.value = 0;
    replyT.value = withDelay(80, withTiming(1, { duration: 640, easing: Easing.bezier(0.3, 0.72, 0.1, 1) }));
  }, [plan.reply?.text, landKey]); // eslint-disable-line react-hooks/exhaustive-deps   // landKey 变=信刚飞落,回信随后压上来
  const replySt = useAnimatedStyle(() => {
    const t = replyT.value;
    return {
      opacity: interpolate(t, [0, 0.7, 1], [0, 1, 1]),
      transform: [
        { translateX: interpolate(t, [0, 0.7, 1], [70, -4, 0]) },
        { translateY: interpolate(t, [0, 0.7, 1], [120, -6, 0]) },
        { rotate: `${interpolate(t, [0, 0.7, 1], [14, 2, 4])}deg` },
      ],
    };
  });
  const letter = plan.letter;
  const LH = letter ? Math.max(470, 100 + textH + 110) : 0;
  const lines = Math.max(12, Math.ceil((LH - 126 - 70) / LINE));
  const replyTop = letter ? 96 + LH - 26 : 104;   // 她的信拿掉了、回信还在:回信放到原来信的位置
  const RW = 224, RH = Math.max(176, 78 + replyH + 26);
  const H = Math.max(ph, plan.reply ? replyTop + RH + 80 : 96 + LH + 80);
  const editLetter = editing ? onEdit : undefined;
  const d = dateParts(plan.date).long;
  return (
    <View style={{ flex: 1, backgroundColor: M.page }}>
      <PaperTex />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ height: H }} showsVerticalScrollIndicator={false} testID="letter-page">
        <Text style={{ position: "absolute", left: 24, top: 70, fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.8, color: M.ink }}>{`NO. ${paperNo(plan)} · ${dateParts(plan.date).dot} · A LETTER`}</Text>
        <DepthKids>
        {letter ? (
        <Pressable onPress={editLetter} disabled={!editing} testID="letter-paper" accessibilityLabel={editing ? "改这封信" : `${herName()}写的信`}
          style={{ position: "absolute", left: 26, top: 96, width: LW, height: LH, transform: [{ rotate: "-1.5deg" }] }}>
          <FlightSpot k={`lp:${plan.id}`} rot={-1.5} style={{ position: "absolute", left: 0, top: 0, width: LW, height: LH }}>
          <Paper w={LW} h={LH} d={deckle(LW, LH, 1.8, 4)} fill={P.paper} sh={P.sh} texture={0.6} />
          {Array.from({ length: lines }, (_, k) => <View key={k} style={{ position: "absolute", left: 28, right: 28, top: 126 + k * LINE, borderTopWidth: 0.6, borderTopColor: rgba(P.sh, 0.22) }} />)}
          <Text style={{ position: "absolute", left: 28, top: 30, fontFamily: FF.script, paddingRight: 8, fontSize: 40, color: P.deep }}>{`Dear ${himEn()},`}</Text>
          <Text onLayout={(e) => setTextH(Math.ceil(e.nativeEvent.layout.height))} testID="letter-text"
            style={{ position: "absolute", left: 30, right: 28, top: 100, fontFamily: FF.serif, fontSize: 14, lineHeight: LINE, color: P.ink }}>{letter.text}</Text>
          <Text style={{ position: "absolute", right: 30, bottom: 30, fontFamily: FF.script, paddingRight: 6, fontSize: 24, color: P.deep }}>{`— ${herEn()}`}</Text>
          <Text style={{ position: "absolute", left: 30, bottom: 38, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.6, color: P.ink, opacity: 0.7 }}>{d}</Text>
          </FlightSpot>
        </Pressable>
        ) : null}
        {plan.reply ? (
          <Animated.View testID="reply-card" style={[{ position: "absolute", left: letter ? 150 : 40, top: replyTop, width: RW, height: RH, zIndex: 3 }, replySt]}>
            <Paper w={RW} h={RH} d={deckle(RW, RH, 1.6, 4)} fill={P.paper2} sh={P.sh} texture={0.4} />
            <View style={{ position: "absolute", left: 9, top: 9, right: 9, bottom: 9, borderWidth: 1, borderColor: P.deep, opacity: 0.7 }} />
            <Text style={{ position: "absolute", left: 22, top: 22, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.6, color: P.deep }}>{`${himEn().toUpperCase()} WROTE BACK`}</Text>
            <Text style={{ position: "absolute", left: 22, top: 40, fontFamily: FF.script, paddingRight: 8, fontSize: 22, color: P.deep }}>{`Dear ${herEn()},`}</Text>
            <Text onLayout={(e) => setReplyH(Math.ceil(e.nativeEvent.layout.height))} style={{ position: "absolute", left: 22, right: 18, top: 78, fontFamily: FF.serif, fontSize: 11.5, lineHeight: 19, color: P.ink }}>{plan.reply.text}</Text>
          </Animated.View>
        ) : null}
        </DepthKids>
      </ScrollView>
    </View>
  );
}

/** 写 / 改给他的信(横线信纸放大);改的时候可以拿掉整封(点两下)。存好=引擎回的投影交给宿主 */
export function LetterEditor({ plan, P, onSaved, onDirty, onClose }: { plan: Plan; P: Skin; onSaved: (p: Plan) => void;
  /** 有没收好的字(宿主据此拦离开) */ onDirty: (on: boolean) => void; onClose: () => void }) {
  const { s, top } = useStage();
  const had = plan.letter?.text ?? "";
  const [text, setText] = useState(had);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [ph, setPh] = useState(0);
  const kb = useReanimatedKeyboardAnimation();
  const kbSt = useAnimatedStyle(() => ({ bottom: Math.max(0, -kb.height.value) }));
  const t = text.trim();
  const n = cpLen(t);
  const dirty = t !== had;
  useEffect(() => { onDirty(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const away = useAway(dirty, busy, onClose);
  const save = async (v: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { onSaved(await ephemeraApi.letter(plan.id, v)); onClose(); } catch (e) { setErr(`没存上 · ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const W = 338;
  return (
    <Pressable style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.45), zIndex: 45 }} onPress={away.tap}>
      <Animated.View style={[{ position: "absolute", left: 0, right: 0, top }, kbSt]}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 60 * s, paddingBottom: 16 * s, alignItems: "center" }} keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
          <Pressable onPress={(e) => e.stopPropagation()} style={{ width: W * s, height: ph * s }}>
            <View style={{ width: W, transform: [{ scale: s }], transformOrigin: "top left" }}>
              <View style={{ width: W, paddingHorizontal: 28, paddingTop: 24, paddingBottom: 20 }} onLayout={(e) => setPh(Math.ceil(e.nativeEvent.layout.height))}>
                {ph ? <View style={{ position: "absolute", left: 0, top: 0 }}><Paper w={W} h={ph} d={deckle(W, ph, 1.8, 4)} fill={P.paper} sh={P.sh} shadow="paper" /></View> : null}
                <Caps color={P.deep} size={7}>A letter</Caps>
                <Text style={{ marginTop: 4, fontFamily: FF.script, paddingRight: 8, fontSize: 34, color: P.deep }}>{`Dear ${himEn()},`}</Text>
                <View style={{ marginTop: 6, borderBottomWidth: 1, borderBottomColor: rgba(P.sh, 0.3) }}>
                  <GrowingInput value={text} onChangeText={(x) => setText(cpCut(x, LETTER_MAX))} editable={!busy} autoFocus testID="letter-input"
                    fontFamily={FF.serif} fontSize={14} lineHeight={26} color={P.ink} maxHeight={320} minHeight={130} style={{ paddingVertical: 4 }} />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
                  <Text style={{ flex: 1, fontFamily: FF.monoR, fontSize: 8.5, color: P.ink, opacity: 0.5 }}>{`${n} / ${LETTER_MAX}`}</Text>
                  {had ? (
                    <Pressable onPress={() => { if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 2600); return; } save(""); }} disabled={busy} hitSlop={8} style={{ marginRight: 22 }} testID="letter-delete"
                      accessibilityLabel={armed ? "再点一下拿掉" : "拿掉这封信"}>
                      <Text style={{ fontFamily: FF.serif5, fontSize: 12, letterSpacing: 2, color: P.ink, opacity: armed ? 1 : 0.7 }}>{armed ? "再点一下拿掉" : "拿掉这封信"}</Text>
                    </Pressable>
                  ) : null}
                  <Pressable onPress={() => save(t)} disabled={!t || busy || t === had} hitSlop={10} style={{ opacity: t && !busy && t !== had ? 1 : 0.35 }} testID="letter-save" accessibilityLabel="收好">
                    <Text style={{ fontFamily: FF.pf7I, fontSize: 16, color: P.deep }}>Keep  →</Text>
                  </Pressable>
                </View>
                <Text style={{ marginTop: 10, textAlign: "right", fontFamily: FF.script, paddingRight: 6, fontSize: 20, color: P.deep }}>{`— ${herEn()}`}</Text>
                {err ? <Text testID="letter-err" style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 11.5, lineHeight: 17, color: P.ink }}>{err}</Text> : null}
                {away.armed ? <Text testID="letter-away" style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 11.5, lineHeight: 17, color: P.deep }}>{AWAY_TEXT}</Text> : null}
              </View>
            </View>
          </Pressable>
        </ScrollView>
      </Animated.View>
    </Pressable>
  );
}

/** 写到一半在纸外面点:第一下只提醒,再点一下才放下(写的字不悄悄丢) */
const AWAY_TEXT = "还没收好 · 在纸外面再点一下就不要了";
function useAway(dirty: boolean, busy: boolean, onClose: () => void) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const tap = () => {
    if (busy) return;
    if (!dirty || armed) { onClose(); return; }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 3000);
  };
  return { armed, tap };
}

// ── 我先写一样───────────────────────────
export const WRITE_FIRST: Record<"invite" | "contract" | "card", string> = { invite: "迟到的请柬", contract: "契约书", card: "小卡" };
export const writableFirst = (pending: string[] | undefined) => (pending ?? []).filter((w): w is keyof typeof WRITE_FIRST => w in WRITE_FIRST);

export function WriteFirstPop({ plan, P, onWritten, onDirty, onClose }: { plan: Plan; P: Skin; onWritten: (p: Plan) => void;
  onDirty: (on: boolean) => void; onClose: () => void }) {
  const { s, top } = useStage();
  const choices = writableFirst(plan.write_request?.pending);
  const [what, setWhat] = useState<keyof typeof WRITE_FIRST | null>(choices.length === 1 ? choices[0] : null);
  const [text, setText] = useState("");
  const [items, setItems] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ph, setPh] = useState(0);
  const kb = useReanimatedKeyboardAnimation();
  const kbSt = useAnimatedStyle(() => ({ bottom: Math.max(0, -kb.height.value) }));
  const body: HerWrite | null = what === "contract"
    ? (items.map((x) => x.trim()).filter(Boolean).length ? { what, items: items.map((x) => x.trim()).filter(Boolean) } : null)
    : what && text.trim() ? { what, text: text.trim() } : null;
  const dirty = !!body;
  useEffect(() => { onDirty(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const away = useAway(dirty, busy, onClose);
  const save = async () => {
    if (!body || busy) return;
    setBusy(true); setErr(null);
    try { onWritten(await ephemeraApi.herWrite(plan.id, body)); onClose(); } catch (e) { setErr(`没存上 · ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const W = 320;
  return (
    <Pressable style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.45), zIndex: 45 }} onPress={away.tap}>
      <Animated.View style={[{ position: "absolute", left: 0, right: 0, top }, kbSt]}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 140 * s, paddingBottom: 16 * s, alignItems: "center" }} keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
          <Pressable onPress={(e) => e.stopPropagation()} style={{ width: W * s, height: ph * s }}>
            <View style={{ width: W, transform: [{ scale: s }], transformOrigin: "top left" }}>
              <View style={{ width: W, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 22 }} onLayout={(e) => setPh(Math.ceil(e.nativeEvent.layout.height))}>
                {ph ? <View style={{ position: "absolute", left: 0, top: 0 }}><Paper w={W} h={ph} d={deckle(W, ph, 1.6, 4)} fill={P.paper} sh={P.sh} shadow="paper" /></View> : null}
                <Caps color={P.ink} size={7}>Write one first</Caps>
                <Text style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 20, letterSpacing: 1.6, color: P.deep }}>{what ? `你先写${WRITE_FIRST[what]}` : "你先写哪一样"}</Text>
                {!what ? choices.map((w) => (
                  <Pressable key={w} onPress={() => setWhat(w)} testID={`write-first-${w}`} accessibilityLabel={`先写${WRITE_FIRST[w]}`}
                    style={{ marginTop: 14, height: 36, borderTopWidth: 0.6, borderTopColor: rgba(P.sh, 0.35), flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <Text style={{ fontFamily: FF.serif5, fontSize: 14, color: P.ink }}>{WRITE_FIRST[w]}</Text>
                    <Text style={{ fontFamily: FF.serif5, fontSize: 14, color: P.deep }}>写 ›</Text>
                  </Pressable>
                )) : what === "contract" ? (
                  <View style={{ marginTop: 10 }}>
                    {items.map((x, k) => (
                      <View key={k} style={{ flexDirection: "row", alignItems: "flex-start", marginTop: 8, borderBottomWidth: 1, borderBottomColor: rgba(P.sh, 0.3) }}>
                        <Text style={{ width: 22, paddingTop: 6, fontFamily: FF.pf7, fontSize: 11, color: P.deep }}>{`${k + 1}.`}</Text>
                        <GrowingInput value={x} onChangeText={(v) => setItems((a) => a.map((y, j) => (j === k ? cpCut(v, WRITE_MAX.contract_item) : y)))} editable={!busy} autoFocus={k === items.length - 1}
                          testID={`write-first-item-${k}`} fontFamily={FF.serif5} fontSize={14} lineHeight={22} color={P.ink} maxHeight={110} minHeight={30} style={{ flex: 1, paddingVertical: 4 }} />
                      </View>
                    ))}
                    {items.length < WRITE_MAX.contract_items ? (
                      <Pressable onPress={() => setItems((a) => [...a, ""])} hitSlop={8} style={{ marginTop: 10 }} accessibilityLabel="加一条">
                        <Text style={{ fontFamily: FF.serif5, fontSize: 12, letterSpacing: 2, color: P.deep }}>加一条 +</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : (
                  <View style={{ marginTop: 12, borderBottomWidth: 1, borderBottomColor: rgba(P.sh, 0.3) }}>
                    <GrowingInput value={text} onChangeText={(v) => setText(cpCut(v, WRITE_MAX[what]))} editable={!busy} autoFocus testID="write-first-text"
                      fontFamily={FF.serif5} fontSize={14} lineHeight={22} color={P.ink} maxHeight={200} minHeight={66} style={{ paddingVertical: 4 }} />
                  </View>
                )}
                {what ? (
                  <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14 }}>
                    <Text style={{ flex: 1, fontFamily: FF.monoR, fontSize: 8.5, color: P.ink, opacity: 0.5 }}>
                      {what === "contract" ? `${items.filter((x) => x.trim()).length} / ${WRITE_MAX.contract_items} 条` : `${cpLen(text.trim())} / ${WRITE_MAX[what]}`}
                    </Text>
                    <Pressable onPress={save} disabled={!body || busy} hitSlop={10} style={{ opacity: body && !busy ? 1 : 0.35 }} testID="write-first-save" accessibilityLabel="收好">
                      <Text style={{ fontFamily: FF.pf7I, fontSize: 16, color: P.deep }}>Keep  →</Text>
                    </Pressable>
                  </View>
                ) : null}
                {err ? <Text testID="write-first-err" style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 11.5, lineHeight: 17, color: P.ink }}>{err}</Text> : null}
                {away.armed ? <Text testID="write-first-away" style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 11.5, lineHeight: 17, color: P.deep }}>{AWAY_TEXT}</Text> : null}
              </View>
            </View>
          </Pressable>
        </ScrollView>
      </Animated.View>
    </Pressable>
  );
}
