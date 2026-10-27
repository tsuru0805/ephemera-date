// 准备中:他还在写、没寄出的约会,她看得到准备到哪了、能给他留一句话,内容看不到。
// 一封还没写完的邀请(信纸)+ 一张写给他的明信片 + 一枚还没盖实的邮戳;纸品语言同首页空态那叠纸,
// 不方正堆叠、不用胶带、不用贴纸。数据只来自 /api/dates/preparing(服务端只给进度)。
//
// - 信纸那几行「用笔写上去」:打开时按行序一行行写,点一行重放那一行。
// - 她写过的明信片一张张压在下面(越写越多);他看过的「砰」地盖一次邮戳,这次打开只演一次(seen_at 有值才盖)。
// - 最上面那张点开直接翻到背面写(取代原来的弹框 NotePop),寄出飞走、落到那叠最上面。
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import { GrowingInput } from "../../components/GrowingInput";
import { NOTE_MAX, type HerNote, type Preparing } from "../../lib/ephemeraApi";
import { inkRowDelay, postcardStackOffset, shouldStampOnOpen, TILT_DEPTHS } from "./aliveHome";
import { Art, Caps, Paper, Svg, FitText } from "./components";
import { dateParts, draftRows, missingLine, touched } from "./format";
import { deckle, stampXml } from "./shapes";
import { useSkin } from "./store";
import { FF, rgba, type Skin } from "./theme";
import { Playable } from "./EmptyHome";
import { himEn, himName } from "../../runtime/session";

function Tick({ c }: { c: string }) {
  return <Svg xml={`<svg viewBox="0 0 16 12" width="16" height="12"><path d="M1.5 6.5 L6 10.5 L14.5 1.5" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`} w={16} h={12} style={{ position: "relative" }} />;
}
/** 笔尖(原型 nib()):跟着墨水那一下滑过去 */
function Nib({ P }: { P: Skin }) {
  return <Svg xml={`<svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 20 L7 13 L15 5 L19 9 L11 17 Z M15 5 L19 9" fill="${P.paper}" stroke="${P.deep}" stroke-width="1.6" stroke-linejoin="round"/></svg>`} w={13} h={13} style={{ position: "absolute" }} />;
}

/** 一封还没写完的邀请:进度一行一行写在信纸的横线上 */
function Letter({ v, P, w, h }: { v: Preparing; P: Skin; w: number; h: number }) {
  const dp = dateParts(v.date);
  const miss = missingLine(v);
  const rows = draftRows(v);
  // 固定 6 行(draftRows 的行数恒定),每行一个 ink 进度 0..1;打开时按序写入,点一行单独重放
  const ink = [useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0)];
  const nib = [useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0)];
  const filled = rows.map(([, val]) => (typeof val === "boolean" ? val : val !== "—"));
  const playRow = (i: number) => {
    ink[i].value = 0; nib[i].value = 0;
    nib[i].value = withTiming(1, { duration: 1, easing: Easing.linear }); // 先归位到行首
    ink[i].value = withTiming(1, { duration: 520, easing: Easing.bezier(0.4, 0.1, 0.6, 0.9) });
    nib[i].value = withDelay(40, withTiming(1, { duration: 520, easing: Easing.linear }));
  };
  useEffect(() => {
    let i = 0;
    const timers = rows.map((_, idx) => { if (!filled[idx]) return null; const at = i++; return setTimeout(() => playRow(idx), inkRowDelay(at)); });
    return () => { timers.forEach((t) => { if (t) clearTimeout(t); }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.id]);
  return (
    <>
      <Paper w={w} h={h} d={deckle(w, h)} fill={P.paper} sh={P.sh} />
      <View style={{ position: "absolute", left: 12, top: 12, right: 12, bottom: 12, borderWidth: 0.8, borderColor: rgba(P.sh, 0.2) }} />
      <Text style={{ position: "absolute", left: 28, top: 24, fontFamily: FF.script, paddingRight: 8, fontSize: 27, color: P.deep, opacity: 0.9 }}>Being written</Text>
      <Text style={{ position: "absolute", left: 30, top: 64, fontFamily: FF.pf7I, fontSize: 12.5, color: P.deep }}>{`for ${dp.dow}, ${dp.slash}`}</Text>
      <Caps color={P.ink} size={6.5} style={{ position: "absolute", left: 30, top: 86, opacity: 0.6 }}>{`Last touched · ${touched(v.last_edited_at)}`}</Caps>
      {rows.map(([k, val], i) => {
        const y = 102 + i * 21;
        const valSt = useAnimatedStyle(() => ({ opacity: filled[i] ? ink[i].value : 0.45 }));
        const nibSt = useAnimatedStyle(() => ({ opacity: filled[i] && nib[i].value > 0 && nib[i].value < 1 ? 1 : 0, left: 88 + nib[i].value * 70 }));
        return (
          <Pressable key={k} disabled={!filled[i]} onPress={() => playRow(i)} style={{ position: "absolute", left: 30, top: y, width: 176, height: 22 }} accessibilityLabel={`重放:${k}`} testID={`draft-row-${i}`}>
            <View style={{ position: "absolute", left: 0, right: 0, top: 19, height: 1, backgroundColor: rgba(P.sh, 0.16) }} />
            <Caps color={P.ink} size={6.8} style={{ position: "absolute", left: 0, top: 7, opacity: 0.75 }}>{k}</Caps>
            <Animated.View style={[{ position: "absolute", left: 88, top: 2 }, valSt]}>
              {typeof val === "boolean"
                ? (val ? <View style={{ top: 3 }}><Tick c={P.deep} /></View> : <Text style={{ fontFamily: FF.serif5, fontSize: 11.5, color: P.ink, opacity: 0.45 }}>—</Text>)
                : <Text style={{ fontFamily: FF.serif5, fontSize: 11.5, color: val === "—" ? P.ink : P.deep }}>{val}</Text>}
            </Animated.View>
            <Animated.View style={nibSt}><Nib P={P} /></Animated.View>
          </Pressable>
        );
      })}
      {v.ready ? (
        <Text style={{ position: "absolute", left: 28, top: 230, fontFamily: FF.script, paddingRight: 8, fontSize: 20, color: P.deep }}>Ready to post</Text>
      ) : miss ? (
        <FitText numberOfLines={5} adjustsFontSizeToFit minimumFontScale={0.6} style={{ position: "absolute", left: 30, top: 232, width: 124, height: 64, fontFamily: FF.serif5, fontSize: 10, lineHeight: 13, color: P.ink, opacity: 0.8 }}>{`还差 · ${miss}`}</FitText>
      ) : null}
    </>
  );
}

const SEEN_READ = new Set<number>(); // 这一次打开(这一次 app 存活期间)已经盖过章的明信片 id,盖过不再重演(模块级,同原型 SEEN_READ)

/** 一张明信片(左边小画,右边横线上是留的话);seenAnim=这次要不要播放盖章动效(而非直接静态显示) */
function PostcardFace({ note, P, w, h, seenAnim, under }: { note: HerNote | null; P: Skin; w: number; h: number; seenAnim: boolean; under?: boolean }) {
  const stampOp = useSharedValue(seenAnim ? 0 : (note?.seen_at != null ? 1 : 0));
  const stampRot = useSharedValue(-14);
  useEffect(() => {
    if (!seenAnim) return;
    stampOp.value = withDelay(1800, withTiming(0.9, { duration: 380, easing: Easing.bezier(0.55, 0, 0.8, 0.2) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const stampSt = useAnimatedStyle(() => ({ opacity: stampOp.value, transform: [{ scale: 0.6 + 0.4 * stampOp.value }, { rotate: `${stampRot.value}deg` }] }));
  return (
    <>
      <Paper w={w} h={h} fill={P.paper2} sh={P.sh} />
      <View style={{ position: "absolute", left: 10, top: 10, width: 86, height: h - 20, overflow: "hidden" }}>
        <Art name="sc_moon" color={P.deep} style={{ left: 0, top: -8, width: 86, height: 130, opacity: 0.75 }} />
      </View>
      <View style={{ position: "absolute", left: 104, top: 12, bottom: 12, width: 1, backgroundColor: rgba(P.sh, 0.25) }} />
      <Caps color={P.deep} size={6.5} style={{ position: "absolute", left: 114, top: 16 }}>Leave a word</Caps>
      {[62, 84, 106].map((y) => <View key={y} style={{ position: "absolute", left: 114, width: w - 128, top: y, height: 1, backgroundColor: rgba(P.sh, 0.22) }} />)}
      {note ? (
        <Text numberOfLines={3} style={{ position: "absolute", left: 114, width: w - 126, top: 44, fontFamily: FF.serif5, fontSize: 10.5, lineHeight: 22, color: P.ink }}>{note.text}</Text>
      ) : null}
      {note?.seen_at != null ? (
        // 他看过的邮戳:最上面那张盖右上角;压在下面的盖在露出来的左边缘上、一半出边(像真的销戳;原型 states/motion pmPos)
        <Animated.View style={[{ position: "absolute", ...(under ? { left: -22, top: 26 } : { right: 6, top: 4 }), width: 54, height: 54, zIndex: 3, pointerEvents: "none" }, stampSt]}>
          <Svg xml={stampXml(`SEEN BY ${himEn().toUpperCase()} · `, "", P.deep, 54)} w={54} h={54} style={{ position: "relative" }} />
        </Animated.View>
      ) : null}
    </>
  );
}

const W_BACK = 280, H_BACK = 220;
/** 明信片那叠 + 最上面那张点开直接翻到背面写 */
function PostcardStack({ v, P, w, h, onSend }: { v: Preparing; P: Skin; w: number; h: number; onSend: (text: string) => Promise<unknown> }) {
  const notes = v.notes;
  const top = notes[notes.length - 1] ?? null;
  const pile = notes.slice(0, -1).slice(-4); // 压太多了看不出层次,原型同样只留近几张在视觉上
  const flip = useSharedValue(0); // 0=正面 1=翻到背面在写
  const fly = useSharedValue(0); // 寄出那一下飞走
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const kb = useReanimatedKeyboardAnimation();
  const openWrite = () => { if (writing) return; setWriting(true); flip.value = withTiming(1, { duration: 320, easing: Easing.bezier(0.5, 0, 1, 0.6) }); };
  const closeWrite = () => { setWriting(false); setText(""); setErr(null); flip.value = withTiming(0, calm(340)); };
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    try {
      await onSend(t);
      fly.value = withTiming(1, { duration: 500, easing: Easing.bezier(0.45, 0.05, 0.4, 1) }, (ok) => { if (ok) { fly.value = 0; runOnJS(closeWrite)(); } });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const faceSt = useAnimatedStyle(() => ({ transform: [{ scaleX: 1 - flip.value }] }));
  const backSt = useAnimatedStyle(() => ({ opacity: flip.value, transform: [{ scaleX: flip.value }] }));
  const flySt = useAnimatedStyle(() => ({
    opacity: 1 - fly.value,
    transform: [{ translateX: 40 * fly.value }, { translateY: -70 * fly.value }, { rotate: `${8 * fly.value}deg` }, { scale: 1 - 0.3 * fly.value }],
  }));
  const kbSt = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(kb.height.value * 0.6, -220) }] }));
  return (
    <>
      {pile.map((n, k) => {
        const depth = pile.length - k; // 越早的(k 越小)压得越深
        const o = postcardStackOffset(depth);
        return (
          <View key={n.id} style={{ position: "absolute", left: o.left, top: o.top, width: w, height: h, transform: [{ rotate: `${o.rotateDeg}deg` }] }} pointerEvents="none">
            <PostcardFace note={n} P={P} w={w} h={h} under seenAnim={shouldStampOnOpen(n.seen_at, SEEN_READ.has(n.id))} />
          </View>
        );
      })}
      <Animated.View style={[{ position: "absolute", left: 184, top: 318, width: w, height: h, transform: [{ rotate: "6deg" }] }, flySt]}>
        {/* 点按区要有尺寸:里面全是绝对定位,不给宽高就塌成 0×0,点不中(模拟器实测) */}
        <Pressable onPress={openWrite} accessibilityLabel={`给${himName()}留一句话,点开直接写`} testID="postcard-top" disabled={writing} style={{ width: w, height: h }}>
          <Animated.View style={[{ width: w, height: h }, faceSt]}>
            <PostcardFace note={top} P={P} w={w} h={h} seenAnim={!!top && shouldStampOnOpen(top.seen_at, SEEN_READ.has(top.id))} />
          </Animated.View>
        </Pressable>
      </Animated.View>
      {writing ? (
        // 背面比卡片大:以卡片为中心摆,但不许出右边屏幕(模拟器实测「Post →」被切掉一半)
        <Animated.View style={[{ position: "absolute", left: Math.min(184 - (W_BACK - w) / 2, 390 - W_BACK - 14), top: 318 - 40, width: W_BACK, zIndex: 9 }, backSt, kbSt]}>
          {/* 寄出飞走:飞的是她眼前这张(背面);正面那时压扁看不见 */}
          <Animated.View style={flySt}>
          <Paper w={W_BACK} h={H_BACK} fill={P.paper2} sh={P.sh} shadow="paper" />
          <View style={{ padding: 18 }}>
            <Caps color={P.deep} size={7}>Leave a word</Caps>
            <View style={{ marginTop: 10, borderBottomWidth: 1, borderBottomColor: rgba(P.sh, 0.3) }}>
              <GrowingInput value={text} onChangeText={(x) => setText(cpCut(x, NOTE_MAX))} editable={!busy} autoFocus
                fontFamily={FF.serif5} fontSize={14} lineHeight={22} color={P.ink} maxHeight={90} minHeight={30} style={{ paddingVertical: 4 }} testID="draft-note-input" />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
              <Pressable onPress={closeWrite} hitSlop={10} accessibilityLabel="不写了"><Text style={{ fontFamily: FF.serif5, fontSize: 12, color: P.ink, opacity: 0.6 }}>先不写</Text></Pressable>
              <View style={{ flex: 1 }} />
              <Text style={{ fontFamily: FF.monoR, fontSize: 8.5, color: P.ink, opacity: 0.5, marginRight: 10 }}>{`${cpLen(text)} / ${NOTE_MAX}`}</Text>
              <Pressable onPress={send} disabled={!text.trim() || busy} hitSlop={10} style={{ opacity: text.trim() && !busy ? 1 : 0.35 }} accessibilityLabel={`寄给${himName()}`} testID="draft-note-send">
                <Text style={{ fontFamily: FF.pf7I, fontSize: 15, color: P.deep }}>Post  →</Text>
              </Pressable>
            </View>
            {err ? <Text style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 11, color: P.deep }}>没寄出 · {err}</Text> : null}
          </View>
          </Animated.View>
        </Animated.View>
      ) : null}
    </>
  );
}
/** 首页上半(没有已寄出的下一次约会时):占空态那叠纸的位置 */
export function DraftPage({ items, onSend, top = 0, error }: { items: Preparing[]; onSend: (id: number, text: string) => Promise<unknown>; top?: number; error?: string | null }) {
  const { P } = useSkin();
  const [sel, setSel] = useState<number | null>(null);
  const i = Math.max(0, items.findIndex((x) => x.id === sel));
  const v = items[i];
  useEffect(() => {
    // 她打开过之后,这几条明信片这次打开都算"看过"了(退出重进才会重播盖章/写字动效,同原型 SEEN_READ 只增不减)
    return () => { v?.notes.forEach((n) => { if (n.seen_at != null) SEEN_READ.add(n.id); }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.id]);
  if (!v) return null;
  const lw = 290, lh = 300, pw = 206, ph = 138;
  const dp = dateParts(v.date);
  return (
    <View style={{ position: "absolute", left: 0, top, width: 390, height: 460 }}>
      {/* (原型 states/motion:他在写时这几张纸也能拖甩、跟着倾斜);信纸里每一行能点(重放那一笔),所以不再整张 pointerEvents=none */}
      <Playable depth={TILT_DEPTHS[1]} box={{ left: 22, top: 146, width: lw, height: lh }} testID="draft-letter">
        <View style={{ flex: 1, transform: [{ rotate: "-3deg" }] }} pointerEvents="box-none">
          <Letter v={v} P={P} w={lw} h={lh} />
        </View>
      </Playable>
      {/* 邮戳压在信纸右上角出血:还没寄,日期先盖上去 */}
      <Playable depth={TILT_DEPTHS[4]} box={{ left: 262, top: 120, width: 92, height: 92 }} testID="draft-seal">
        <Svg xml={stampXml("NOT YET POSTED · BEING WRITTEN · ", dp.dot, P.deep, 92)} w={92} h={92}
          style={{ left: 0, top: 0, opacity: 0.7, transform: [{ rotate: "14deg" }] }} />
      </Playable>
      <PostcardStack v={v} P={P} w={pw} h={ph} onSend={(t) => onSend(v.id, t)} />
      {error ? (
        <Text style={{ position: "absolute", left: 30, top: 450, fontFamily: FF.serif5, fontSize: 10.5, color: P.ink, opacity: 0.7 }}>准备中的约会没刷新到 · {error}</Text>
      ) : null}
      {items.length > 1 ? (
        <Pressable onPress={() => setSel(items[(i + 1) % items.length].id)} hitSlop={10} style={{ position: "absolute", left: 214, top: 216 }} accessibilityLabel="下一封">
          <Caps color={P.deep} size={7}>{`${i + 1} / ${items.length}  ›`}</Caps>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 已有寄出的下一次约会时,准备中的那封放在 Hidden Plans 下面 */
export const DRAFT_ROW_H = 490;
export function DraftRow({ items, onSend, top, error }: { items: Preparing[]; onSend: (id: number, text: string) => Promise<unknown>; top: number; error?: string | null }) {
  const { P } = useSkin();
  return (
    <>
      <Text style={{ position: "absolute", left: 22, top, fontFamily: FF.pf7, fontSize: 20, color: P.deep }}>Being Written</Text>
      <View style={{ position: "absolute", left: 168, top: top + 14, width: 40, height: 1, backgroundColor: P.deep }} />
      <DraftPage items={items} onSend={onSend} top={top - 110} error={error} />
    </>
  );
}

/** 字数按码点算(与引擎 Python len 一致;emoji 算一个) */
const cpLen = (x: string) => Array.from(x).length;
const cpCut = (x: string, max: number) => (cpLen(x) > max ? Array.from(x).slice(0, max).join("") : x);
