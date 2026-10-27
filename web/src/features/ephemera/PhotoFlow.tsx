// Ephemera ⑧ 当天放照片(原型 openPhotoFlow):
// 选图 → 滑进卡套(整张藏进去,不露边)→ 亲手封口(点卡套,邮戳落下)→ 可写一行小字 → 收好。
// 照片与小字存引擎(date_her.py);这一站不放 = 记一笔「没放」,纪念盒里那格走兜底句。
//
// - 每一步都有状态、失败都不静默:取照片(相册/iCloud 下载)→「正在取照片 · N 秒」;取不到/读不出 → 原话 + 点「+」重来;
// 上传 →「上传中 42%」;超时/引擎拒 → 原话 + 点「收好」重试。进度/报错属于状态提示,允许出现。
// - 「收好」照片进了卡套就能点:还没封口时点它=先盖邮戳再收(封口这一下原来只能点卡套,真机上她不知道要点)。
// - 底部「收好 / 这一站不放了」按页面高度往上让,不压在底部导航上。
//
// 已经放过照片的站再点进来:
// 直接显示已放的那张(在卡套里、已封口、小字照填),「收好」=存小字的改动(没改就是关上);
// 原来「这一站不放了」的位置换成「换一张」→ 回到选图那一步,收好时宿主按「换掉」上传。
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import { photoDragY, photoShouldSlideIn } from "./aliveHome";
import type { Stop } from "../../lib/ephemeraApi";
import { FoilLine, NAV_H, useStage } from "./components";
import { useTimers } from "./store";
import { paperOf, two } from "./format";
import { kindLine } from "./kinds";
import { PhotoSleeve, SLEEVE_SIZE } from "./Sleeves";
import { FF, rgba, segC, type Skin, type SkinKey } from "./theme";

const PW = 128, PH = 154, CAPTION_MAX = 24;
export const PUSH_HINT = "把照片往下推进卡套，就能收好";
export const PICK_ERR = {
  failed: (m: string) => `没取到照片 · ${m}`,
  empty: "没取到照片 · 相册没有交回这张照片，点「+」再选一次",
  unreadable: "这张照片读不出来，点「+」换一张",
} as const;
/** 底部「收好」的位置:原型 742,但不许压到底部导航上(按舞台高度往上让) */
export const doneTopFor = (H: number, navStage: number) => Math.min(742, H - navStage - 110);
/** 卡套与小字的竖向位置:小字整行在卡套下沿之下(原来按「收好」往上让,高卡套(晚餐 184)会把小字压在卡套底下看不见, 模拟器实见);
 * 地方不够就把卡套往上挪(上面给落下的拍立得留的空间仍够) */
export function sleeveLayout(sh: number, doneTop: number): { cy: number; captionTop: number } {
  const cy = Math.min(500, doneTop - 60 - sh / 2);
  return { cy, captionTop: cy + sh / 2 + 16 };
}

export type PhotoStatus = { k: "idle" } | { k: "picking"; sec: number } | { k: "sliding" } | { k: "ready" } | { k: "uploading"; pct: number | null } | { k: "error"; text: string };
/** 「收好」底下那一行:等什么就写什么(灰着必须有原因) */
export function statusLine(st: PhotoStatus): string | null {
  switch (st.k) {
    case "picking": return st.sec >= 2 ? `正在取照片 · ${st.sec} 秒` : "正在取照片";
    case "sliding": return "放进卡套";
    case "uploading": return st.pct == null ? "上传中" : `上传中 ${Math.round(st.pct * 100)}%`;
    case "error": return st.text;
    default: return null;
  }
}

/** 这一站已经放了的那张:source=null 表示还在取(引擎那张要带 token 取) */
export type ExistingPhoto = { source: { uri: string; headers?: Record<string, string> } | null; caption: string; /** 取不到那张时的原话(可换一张) */ error?: string | null };

export function PhotoFlow({ s, i, P, skin, onClose, onSkip, onDone, existing, onCaption }: {
  s: Stop; i: number; P: Skin; skin: SkinKey; onClose: () => void; onSkip: () => void;
  /** onProgress(0~1):上传进度(宿主若当场上传就回报;补记页先留在本地不上传)。有 existing 时=换一张 */
  onDone: (file: ImagePicker.ImagePickerAsset, caption: string, clientId: string, onProgress: (frac: number) => void) => Promise<void>;
  /** 这一站已放的照片(有=打开就显示它) */
  existing?: ExistingPhoto | null;
  /** 只改小字(不换照片);失败抛错=原话显示 */
  onCaption?: (caption: string) => Promise<void>;
}) {
  const { s: sc, top, H, insets } = useStage();
  const paper = paperOf(s);
  const { w: sw, h: sh } = SLEEVE_SIZE[paper];
  const doneTop = doneTopFor(H, (NAV_H + insets.bottom) / sc);
  const { cy, captionTop } = sleeveLayout(sh, doneTop);
  const cx = 195, sx = cx - sw / 2, sy = cy - sh / 2;
  const [asset, setAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  // 显示已放的那张:有 existing 且她还没点「换一张」
  const [keepOld, setKeepOld] = useState(!!existing);
  const old = keepOld && existing ? existing : null;
  const [inside, setInside] = useState(!!existing); // 照片已经滑进卡套
  const [sealed, setSealed] = useState(!!existing);
  const [caption, setCaption] = useState(existing?.caption ?? "");
  const [st, setSt] = useState<PhotoStatus>({ k: "idle" });
  const [clientId] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const later = useTimers();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const dim = useSharedValue(0), drop = useSharedValue(0), slide = useSharedValue(0), after = useSharedValue(existing ? 1 : 0);
  useEffect(() => { dim.value = withTiming(1, { duration: 400 }); }, [dim]);
  const busy = st.k === "picking" || st.k === "uploading";

  const reset = (err: string) => {
    setAsset(null); setInside(false); setSealed(false);
    drop.value = 0; slide.value = 0; after.value = 0;
    setSt({ k: "error", text: err });
  };
  // 换一张:回到选图那一步(小字留着)
  const swap = () => {
    if (busy) return;
    setKeepOld(false); setInside(false); setSealed(false);
    after.value = 0;
    setSt({ k: "idle" });
  };
  const pick = async () => {
    if (asset || old || st.k === "picking") return;
    setSt({ k: "picking", sec: 0 });
    const t0 = Date.now();
    const tick = setInterval(() => { if (alive.current) setSt((x) => (x.k === "picking" ? { k: "picking", sec: Math.floor((Date.now() - t0) / 1000) } : x)); }, 1000);
    let r: ImagePicker.ImagePickerResult;
    try {
      r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.85, allowsEditing: false, exif: false });
    } catch (e) {
      clearInterval(tick);
      console.warn("[PhotoFlow] 取照片失败", e);
      if (alive.current) reset(PICK_ERR.failed((e as Error)?.message || "相册打不开"));
      return;
    }
    clearInterval(tick);
    if (!alive.current) return;
    if (r.canceled) { setSt({ k: "idle" }); return; } // 她自己取消:不算错
    const a = r.assets?.[0];
    if (!a?.uri) { console.warn("[PhotoFlow] 相册返回空", r); reset(PICK_ERR.empty); return; }
    setAsset(a);
    setSt({ k: "idle" }); // 落下来之后等她自己按住往下推,不再自动滑
    drop.value = withTiming(1, calm(520));
  };
  // 选中的照片从缩略图长出来之后,要她按住往下推进卡套;推不够(没过 4 成、甩得不够快)就弹回去。
  // 滑到底的落定用 later(JS 定时器)等视觉动画走完再翻 inside,不挂在 reanimated 回调上(与 withTiming mock 在 jest 下不回调一致,
  // 这里的 420ms 要跟下面 slide 动画时长对上)。
  const commitSlideIn = () => {
    if (inside) return;
    slide.value = withTiming(PH, { duration: 420, easing: Easing.bezier(0.5, 0, 0.3, 1) });
    later(() => { setInside(true); setSt((x) => (x.k === "idle" || x.k === "sliding" ? { k: "ready" } : x)); }, 420);
  };
  const photoPan = Gesture.Pan()
    .onUpdate((e) => { if (inside) return; slide.value = photoDragY(e.translationY, PH); })
    .onEnd((e) => {
      if (inside) return;
      const moved = Math.abs(e.translationY) > 6 || Math.abs(e.translationX) > 6;
      if (photoShouldSlideIn(moved, slide.value, e.velocityY, PH)) runOnJS(commitSlideIn)();
      else slide.value = withSpring(0, { damping: 11, stiffness: 160 });
    });
  const seal = () => {
    if (!inside || sealed) return;
    setSealed(true);
    after.value = withDelay(450, withTiming(1, { duration: 400 }));
  };
  // 点下就锁(盖戳等待之前):连点「收好」只提交一次
  const submitting = useRef(false);
  const done = async () => {
    if (old) {
      if (busy || submitting.current) return;
      const cap = caption.trim().slice(0, CAPTION_MAX);
      if (cap === (old.caption ?? "").trim() || !onCaption) { onClose(); return; }
      submitting.current = true;
      setSt({ k: "uploading", pct: null });
      try {
        await onCaption(cap);
      } catch (e) {
        console.warn("[PhotoFlow] 小字没存上", e);
        if (alive.current) setSt({ k: "error", text: `没收好 · ${(e as Error).message}` });
      } finally {
        submitting.current = false;
      }
      return;
    }
    if (!asset || !inside || busy || submitting.current) return;
    submitting.current = true;
    setSt({ k: "uploading", pct: null });
    try {
      if (!sealed) { seal(); await new Promise((r) => later(() => r(null), 480)); } // 先盖邮戳再收
      await onDone(asset, caption.trim().slice(0, CAPTION_MAX), clientId, (f) => { if (alive.current) setSt((x) => (x.k === "uploading" ? { k: "uploading", pct: f } : x)); });
    } catch (e) {
      console.warn("[PhotoFlow] 上传没成", e);
      if (alive.current) setSt({ k: "error", text: `没收好 · ${(e as Error).message}` });
    } finally {
      submitting.current = false;
    }
  };

  const dimSt = useAnimatedStyle(() => ({ opacity: dim.value }));
  const polSt = useAnimatedStyle(() => ({ opacity: Math.min(1, drop.value * 2), transform: [{ translateY: -120 * (1 - drop.value) }, { rotate: `${-6 * (1 - drop.value)}deg` }] }));
  const slideSt = useAnimatedStyle(() => ({ transform: [{ translateY: slide.value }] })); // slide 现在存的是像素位移,不再是 0..1 比例
  const afterSt = useAnimatedStyle(() => ({ opacity: after.value }));
  // 写小字时键盘升起:整层往上让,输入框不被盖住(键盘高度是负数)
  const kb = useReanimatedKeyboardAnimation();
  const kbSt = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(kb.height.value * 0.75, -300) }] }));
  const c = segC(skin, i);
  const photo = asset && inside ? { uri: asset.uri } : old?.source ?? null;
  // 照片落下来、还没推进卡套时「收好」灰着,写明要做什么;推进去以后这句消失(同家里 3f2defc)
  const line = old && !old.source && st.k === "idle" ? (old.error ? `已放的照片没取到 · ${old.error}` : "正在取照片")
    : asset && !inside && st.k === "idle" ? PUSH_HINT : statusLine(st);
  const canDone = old ? !busy : !!asset && inside && !busy;

  return (
    <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 45 }}>
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.82) }, dimSt]} />
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, kbSt]}>
      <View style={{ position: "absolute", left: 0, top, width: 390, height: H, transform: [{ scale: sc }], transformOrigin: "top left" }}>
        <View style={{ position: "absolute", left: 0, right: 0, top: 84, alignItems: "center" }}>
          <Text style={{ fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 2.2, color: "#fff" }}>{`${two(i)} · ${s.time ?? ""} · ${kindLine(s)}`}</Text>
          <Text style={{ marginTop: 6, fontFamily: FF.script, paddingRight: 8, fontSize: 34, color: "#fff" }}>keep a moment</Text>
        </View>
        {!asset && !old ? (
          <Pressable onPress={pick} disabled={st.k === "picking"} style={{ position: "absolute", left: 195 - 32, top: 172, width: 64, height: 64, padding: 4, backgroundColor: "#FFFEFB", opacity: st.k === "picking" ? 0.6 : 1, shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }} accessibilityLabel="选一张照片" testID="photo-pick">
            <View style={{ flex: 1, backgroundColor: "#EFE8DD", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontFamily: FF.pf, fontSize: 28, color: P.deep, lineHeight: 32 }}>+</Text>
            </View>
          </Pressable>
        ) : null}
        {asset ? (
          <View style={{ position: "absolute", left: cx - PW / 2, top: sy - PH + 6, width: PW, height: PH, overflow: "hidden", zIndex: 1 }} pointerEvents="box-none">
            <Animated.View style={[{ width: PW, height: PH }, polSt]}>
              <GestureDetector gesture={photoPan}>
                {/* Pressable 兜底:点一下也直接推进去(原型 !moved 分支),顺手给了个不用跟手势也能点到的入口 */}
                <Pressable disabled={inside} onPress={commitSlideIn} testID="photo-drag" accessibilityLabel="按住往下推,放进卡套">
                  <Animated.View style={[{ width: PW, height: PH, backgroundColor: "#FFFEFB", paddingTop: 8, paddingHorizontal: 8, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 2, shadowOffset: { width: 0, height: 2 } }, slideSt]}>
                    <Image source={{ uri: asset.uri }} style={{ width: PW - 16, height: 112 }} resizeMode="cover" testID="photo-img"
                      onError={(e) => { console.warn("[PhotoFlow] 照片读不出来", asset.uri, e.nativeEvent?.error); reset(PICK_ERR.unreadable); }} />
                  </Animated.View>
                </Pressable>
              </GestureDetector>
            </Animated.View>
          </View>
        ) : null}
        <Pressable onPress={seal} disabled={!inside || sealed} style={{ position: "absolute", left: sx, top: sy, width: sw, height: sh, zIndex: 2, transform: [{ rotate: "-2deg" }] }} accessibilityLabel="盖邮戳封口" testID="photo-sleeve">
          <PhotoSleeve paper={paper} s={s} c={c} P={P} i={i} photo={photo} sealed={sealed} />
        </Pressable>
        <Animated.View style={[{ position: "absolute", left: 60, right: 60, top: captionTop, zIndex: 3 }, afterSt]} pointerEvents={sealed ? "auto" : "none"}>
          <TextInput testID="photo-caption" editable={!busy} value={caption} onChangeText={setCaption} maxLength={CAPTION_MAX} placeholder="写一行小字" placeholderTextColor="rgba(255,255,255,0.6)"
            style={{ borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.7)", color: "#fff", fontFamily: FF.serif5, fontSize: 14, textAlign: "center", paddingVertical: 6 }} />
        </Animated.View>
        <Pressable onPress={done} disabled={!canDone} style={{ position: "absolute", left: 110, right: 110, top: doneTop, alignItems: "center", opacity: canDone ? 1 : 0.35 }} accessibilityLabel="收好" testID="photo-done">
          <Text style={{ fontFamily: FF.serif9, fontSize: 20, letterSpacing: 12, marginLeft: 12, color: "#fff" }}>收好</Text>
          <FoilLine w={110} style={{ marginTop: 10 }} />
        </Pressable>
        {/* 「收好」底下那一行:等什么 / 哪步没成(状态提示) */}
        {line ? <Text testID="photo-status" style={{ position: "absolute", left: 40, right: 40, top: doneTop + 50, textAlign: "center", fontFamily: FF.serif5, fontSize: 12, lineHeight: 18, color: "#fff", opacity: 0.85 }}>{line}</Text> : null}
        {old ? (
          <Pressable onPress={swap} disabled={busy} style={{ position: "absolute", left: 0, right: 0, top: doneTop + (line ? 84 : 54), alignItems: "center" }} accessibilityLabel="换一张" testID="photo-swap">
            <Text style={{ fontFamily: FF.serif5, fontSize: 11.5, letterSpacing: 2.3, color: "#fff", opacity: 0.75 }}>换一张</Text>
          </Pressable>
        ) : null}
        {!asset && !old && st.k !== "picking" ? (
          <Pressable onPress={onSkip} style={{ position: "absolute", left: 0, right: 0, top: doneTop + (line ? 84 : 54), alignItems: "center" }} accessibilityLabel="这一站不放了">
            <Text style={{ fontFamily: FF.serif5, fontSize: 11.5, letterSpacing: 2.3, color: "#fff", opacity: 0.75 }}>这一站不放了</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} style={{ position: "absolute", right: 14, top: 40, width: 40, height: 40, alignItems: "center", justifyContent: "center" }} accessibilityLabel="关上">
          <Text style={{ fontFamily: FF.pf, fontSize: 30, color: "#fff" }}>×</Text>
        </Pressable>
      </View>
      </Animated.View>
    </View>
  );
}
