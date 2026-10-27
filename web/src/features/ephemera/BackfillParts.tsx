// 补记页与纪念盒编辑态共用的零件:
// 书脊那条(日期 / 名字 / 五本迷你书脊)、地点类型一排、淡显未敲数字的时间框、地名候选条、她的一句话(小爱心 + 细线)、编号章。
// 不放说明句、不放占位提示字(memory feedback_no_explanatory_text_in_app)。
import { forwardRef, useEffect, useRef, useState, type ComponentProps } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming, Easing } from "react-native-reanimated";
import Svg, { Path, SvgXml } from "react-native-svg";
import { ephemeraApi, type PlaceHit } from "../../lib/ephemeraApi";
import { BF_COLORS, maskParts } from "./backfill";
import { asKind, icon } from "./icons";
import { kindZhLine, useKinds } from "./kinds";
import { alpha, FF, planCol, type MapPal, type PlanColor } from "./theme";
import { getSession, herName } from "../../runtime/session";


const HEART = "M8 13 C3 9.5 0 7 0 4 C0 1.8 1.8 0 4 0 C5.6 0 7 1 8 2.4 C9 1 10.4 0 12 0 C14.2 0 16 1.8 16 4 C16 7 13 9.5 8 13Z";
export function Heart({ color, w = 9 }: { color: string; w?: number }) {
  return <Svg width={w} height={w * 0.875} viewBox="0 0 16 14"><Path d={HEART} fill={color} /></Svg>;
}

/** 小样 caret:1.5 宽、0.95em 高、路线色、一秒一闪 */
export function Caret({ color, h }: { color: string; h: number }) {
  const o = useSharedValue(1);
  useEffect(() => { o.value = withRepeat(withTiming(0, { duration: 500, easing: Easing.steps(1) }), -1, true); }, [o]);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: 1.5, height: h, marginLeft: 2, backgroundColor: color }, st]} />;
}

/** 空格里的淡字。
 *  「App 不放说明」的例外,只用于补记页与纪念盒编辑态的输入框 */
/** 中文名上限(引擎定:20 字、单行) */
export const ZH_MAX = 20;
export const HINT = { kind: "选个种类", date: "05.03", time: "14:00", name: "起个英文名", nameZh: "中文名，可不填", place: "去了哪里 / 做了什么", line: "这一站想记下的一句" } as const;

/** 空格里的淡字(压在输入框下面,一敲就让开):思源宋 500 12 号、墨色 35%,同书脊名那条。
 *  不用 TextInput 的 placeholder:它跟输入框同字体同字号(地名是 14.5 粗体),淡字会粗、会折两行,看着像已经填好 */
export function FieldHint({ show, text, M, lineHeight = 19.5, testID }: { show: boolean; text: string; M: MapPal; lineHeight?: number; testID?: string }) {
  if (!show) return null;
  return <Text pointerEvents="none" numberOfLines={1} testID={testID} style={{ position: "absolute", left: 0, top: 0, fontFamily: FF.serif5, fontSize: 12, lineHeight, color: alpha(M.ink, 0.35) }}>{text}</Text>;
}

/** 数字框:敲了的照常显示,没敲的那截按模板淡显(小样「15:3」+ 淡「0」);底下一个透明输入框收数字 */
export function MaskInput({ value, onChange, onBlur, template, style, caret, testID, example }: {
  value: string; onChange: (d: string) => void; onBlur?: () => void; template: "00:00" | "00.00";
  style: TextStyle; caret: string; testID?: string;
  /** 一格都没敲时淡显入力例(日期「05.03」/时间「14:00」),一敲就换回「敲了的 + 淡模板」 */
  example?: string;
}) {
  const ref = useRef<TextInput>(null);
  const [focus, setFocus] = useState(false);
  const [typed, rest] = value === "" && example ? ["", example] : maskParts(value, template);
  const fs = (style.fontSize as number) ?? 20;
  return (
    <Pressable onPress={() => ref.current?.focus()} style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start" }} accessibilityLabel={template === "00:00" ? "时间" : "日期"}>
      <Text style={style}>{typed}<Text style={{ opacity: 0.3 }}>{rest}</Text></Text>
      {focus ? <Caret color={caret} h={fs * 0.95} /> : null}
      <TextInput ref={ref} testID={testID} value={value} onChangeText={(t) => onChange(t.replace(/\D/g, "").slice(0, 4))} keyboardType="number-pad" maxLength={4}
        caretHidden contextMenuHidden onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); onBlur?.(); }}
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, color: "transparent", fontSize: 1 }} />
    </Pressable>
  );
}

/** 光标统一路线色(小样 caret:var(--m-route))。iOS 原生输入框复用时若单行↔多行换了内核,不会重设光标色(RN 0.81
 *  RCTCopyBackedTextInput 不拷 tintColor,而 selectionColor 与复用前相同就不重设)→ 会露出系统蓝。
 *  所以每次获得焦点把颜色在两个肉眼无差的值(不透明度 1 / 0.996)之间换一下,逼原生把光标色设到当下那个内核上。 */
export const caretColors = (route: string): [string, string] => [alpha(route, 1), alpha(route, 0.996)];
type CaretProps = Omit<ComponentProps<typeof TextInput>, "selectionColor"> & { caret: string };
export const CaretInput = forwardRef<TextInput, CaretProps>(function CaretInput({ caret, onFocus, ...rest }, ref) {
  const [k, setK] = useState(0);
  return <TextInput ref={ref} {...rest} selectionColor={caretColors(caret)[k]} onFocus={(e) => { setK((x) => 1 - x); onFocus?.(e); }} />;
});

/** 年份:同「THE DAY · 2026」那行小字,年份四位可改 */
export function YearInput({ value, onChange, onBlur, style, testID, caret }: { value: string; onChange: (d: string) => void; onBlur?: () => void; style: TextStyle; testID?: string; caret: string }) {
  return (
    <CaretInput caret={caret} value={value} testID={testID} onChangeText={(t) => onChange(t.replace(/\D/g, "").slice(0, 4))} onBlur={onBlur} keyboardType="number-pad" maxLength={4}
      style={[style, { padding: 0, margin: 0, minWidth: 24 }]} accessibilityLabel="年份" />
  );
}

const WHITE: MapPal = { page: "#fff", land: "#fff", street: "#fff", water: "#fff", park: "#fff", ink: "#fff", title: "#fff", route: "#fff", card: "#fff", chip: "#fff", chipDone: "#fff", chipLock: "#fff" };

/** 当前类别(替换原来那一排 8 个小图标):选中的图标 + 「中文名 · 细类」;点它弹出种类表(KindPicker)。
 *  disabled=不能改(他写的站):只显示 */
export function KindChip({ kind, subtype, time, M, onPress, disabled, testID }: {
  kind: string | null; subtype: string | null; /** 这一站的时间:晚餐那类按它显示午餐/晚餐 */ time?: string | null; M: MapPal; onPress?: () => void; disabled?: boolean; testID?: string;
}) {
  const label = kind ? kindZhLine(kind, subtype, time) : "";
  return (
    <Pressable onPress={onPress} disabled={disabled || !onPress} hitSlop={6} testID={testID} accessibilityLabel={label || HINT.kind}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6, alignSelf: "flex-start" }}>
      <View style={{ width: 17, height: 17, borderRadius: 8.5, alignItems: "center", justifyContent: "center", backgroundColor: kind ? M.route : "transparent",
        borderWidth: kind ? 0 : 0.8, borderColor: alpha(M.ink, 0.35), borderStyle: "dashed" }}>
        {kind ? <SvgXml xml={icon(asKind(kind), WHITE)} width={11} height={11} /> : null}
      </View>
      <Text numberOfLines={1} style={{ maxWidth: 150, fontFamily: FF.serif5, fontSize: 11.5, color: kind ? M.title : alpha(M.ink, 0.35) }}>{label || HINT.kind}</Text>
    </Pressable>
  );
}

/** 种类表弹层:What kind of stop;一组一个大类(图标 · 中文 · 英文),
 * 下面细类圆角签,末尾「＋ 自定义」就地出输入框(≤ subtype_max 字,单行)。点组头=只选大类不带细类;「一件事」那组没有细类。
 *  在 Modal 里:键盘让位交给表里的 ScrollView automaticallyAdjustKeyboardInsets(键盘盖住表的下半截=内边距让出、把正在写的那格滚到键盘上方;
 * 整张顶起的 KeyboardAvoidingView 在这张高表上不管用——表本身不滚,输入框照样被盖, 模拟器实拍) */
export function KindPicker({ visible, kind, subtype, M, onPick, onClose }: {
  visible: boolean; kind: string | null; subtype: string | null; M: MapPal;
  /** kind=种类表里的代码原样(App 不认识的新种类也原样交出去;图标才按 asKind 兜底) */
  onPick: (kind: string, subtype: string | null) => void; onClose: () => void;
}) {
  const K = useKinds();
  const [custom, setCustom] = useState<string | null>(null); // 正在自定义的那一组
  const [text, setText] = useState("");
  useEffect(() => { if (!visible) { setCustom(null); setText(""); } }, [visible]);
  const done = (k: string) => { const t = text.replace(/\s+/g, " ").trim().slice(0, K.subtype_max); if (t) onPick(k, t); };
  const chip = (label: string, on: boolean, onPress: () => void, dashed?: boolean, testID?: string) => (
    <Pressable key={label} onPress={onPress} testID={testID} accessibilityLabel={label} accessibilityState={{ selected: on }}
      style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, borderWidth: 0.6, borderStyle: dashed ? "dashed" : "solid",
        borderColor: on ? M.route : alpha(M.ink, 0.3), backgroundColor: on ? M.route : "transparent", opacity: dashed ? 0.75 : 1 }}>
      <Text style={{ fontFamily: FF.serif5, fontSize: 11.5, color: on ? M.card : M.ink }}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(40,20,25,0.35)" }} onPress={onClose} accessibilityLabel="关上种类表" />
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: 150, backgroundColor: M.card, borderTopLeftRadius: 18, borderTopRightRadius: 18,
          shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 15, shadowOffset: { width: 0, height: -8 }, overflow: "hidden" }} testID="kind-picker">
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: alpha(M.ink, 0.25), marginTop: 8, marginBottom: 6, alignSelf: "center" }} />
          <Text style={{ marginTop: 6, marginHorizontal: 22, marginBottom: 10, fontFamily: FF.pf9, fontSize: 22, color: M.title }}>What kind of stop</Text>
          <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingBottom: 40 }}>
            {K.kinds.map((d) => {
              const listed = d.subtypes.includes(subtype ?? "");
              return (
                <View key={d.kind} style={{ borderBottomWidth: 0.6, borderBottomColor: alpha(M.ink, 0.15) }}>
                  <Pressable onPress={() => onPick(d.kind, null)} testID={`kind-${d.kind}`} accessibilityLabel={d.zh} accessibilityState={{ selected: kind === d.kind && !subtype }}
                    style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 10, paddingBottom: d.subtypes.length || d.custom ? 4 : 10, paddingHorizontal: 22 }}>
                    <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: kind === d.kind && !subtype ? M.route : alpha(M.route, 0.14), alignItems: "center", justifyContent: "center" }}>
                      <SvgXml xml={icon(asKind(d.kind), kind === d.kind && !subtype ? WHITE : M)} width={20} height={20} />
                    </View>
                    <Text style={{ fontFamily: FF.serif7, fontSize: 14, color: M.ink }}>{d.zh}</Text>
                    <Text style={{ marginLeft: 4, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.56, color: M.title }}>{d.en}</Text>
                  </Pressable>
                  {d.subtypes.length || d.custom ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 4, paddingRight: 22, paddingBottom: 10, paddingLeft: 62 }}>
                      {d.subtypes.map((x) => chip(x, kind === d.kind && subtype === x, () => onPick(d.kind, x), false, `sub-${d.kind}-${x}`))}
                      {kind === d.kind && subtype && !listed ? chip(subtype, true, () => onPick(d.kind, subtype)) : null}
                      {d.custom ? (custom === d.kind ? (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          <CaretInput caret={M.route} value={text} onChangeText={(v) => setText(v.replace(/\n/g, ""))} maxLength={K.subtype_max} autoFocus
                            returnKeyType="done" onSubmitEditing={() => done(d.kind)} testID={`custom-${d.kind}`} accessibilityLabel="自定义细类"
                            style={{ minWidth: 110, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, borderWidth: 0.6, borderColor: M.route, fontFamily: FF.serif5, fontSize: 11.5, color: M.ink }} />
                          <Pressable onPress={() => done(d.kind)} hitSlop={8} accessibilityLabel="好" testID={`custom-ok-${d.kind}`}>
                            <Text style={{ fontFamily: FF.serif7, fontSize: 12, color: M.route }}>好</Text>
                          </Pressable>
                        </View>
                      ) : chip("＋ 自定义", false, () => { setCustom(d.kind); setText(""); }, true, `custom-open-${d.kind}`)) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** 编号章(小样 .rtStamp:22 圆 + 一圈页面色 + 一圈 55% 墨色细线)。faint=末尾那个淡编号;armed=再点一下删这一站 */
/** reveal:「画到哪站哪站才亮」——路线页往下划时外部按滚动算好 scale/opacity 传进来,
 * 包一层 Animated.View(有真实宽高,scale 围绕自己的中心转,不是 0 尺寸容器那种假缩放);不传=一直是原样(其它调用方不受影响) */
export function RtStamp({ n, M, faint, armed, onPress, top = 7, reveal }: { n: number; M: MapPal; faint?: boolean; armed?: boolean; onPress?: () => void; top?: number; reveal?: object }) {
  const body = (
    <Animated.View style={[{ width: 28.6, height: 28.6, borderRadius: 14.3, borderWidth: 0.8, borderColor: alpha(M.ink, 0.55), backgroundColor: M.page, alignItems: "center", justifyContent: "center" }, reveal]}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: M.route, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontFamily: armed ? FF.pf : FF.pf7, fontSize: armed ? 15 : 11, lineHeight: armed ? 17 : 13, color: M.card }}>{armed ? "×" : n}</Text>
      </View>
    </Animated.View>
  );
  const pos: ViewStyle = { position: "absolute", left: 25 - 3.3, top: top - 3.3, opacity: faint ? 0.28 : 1 };
  return onPress ? <Pressable onPress={onPress} hitSlop={8} style={pos} accessibilityLabel={faint ? "加一站" : armed ? `删第 ${n} 站` : `第 ${n} 站`}>{body}</Pressable> : <View style={pos} pointerEvents="none">{body}</View>;
}

/** 书脊那条(小样 backView 92 高那条):THE DAY · 年 / 月日大字;ON THE SPINE / 花体名 + 细线;右边五本迷你书脊 */
export function SpineBand({ M, year, md, name, nameZh, color, onYear, onMd, onName, onNameZh, onColor, onDateBlur, onNameBlur, onNameZhBlur, nameErr, top = 212 }: {
  M: MapPal; year: string; md: string; name: string; nameZh: string; color: PlanColor | null;
  onYear: (v: string) => void; onMd: (v: string) => void; onName: (v: string) => void; onNameZh: (v: string) => void; onColor: (c: PlanColor) => void;
  onDateBlur?: () => void; onNameBlur?: () => void; onNameZhBlur?: () => void;
  /** 英文名那一格写了中文:那一行下面写明(报错类) */ nameErr?: string | null; top?: number;
}) {
  const cap: TextStyle = { fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.56, color: M.title };
  const hint: TextStyle = { position: "absolute", left: 0, fontFamily: FF.serif5, fontSize: 12, color: alpha(M.ink, 0.35) };
  return (
    <View style={{ position: "absolute", left: 22, right: 22, top, height: 92, borderTopWidth: 0.8, borderBottomWidth: 0.8, borderColor: M.ink }}>
      <View style={{ position: "absolute", left: 0, top: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={cap}>{"THE DAY · "}</Text>
          <YearInput value={year} onChange={onYear} onBlur={onDateBlur} style={cap} testID="bf-year" caret={M.route} />
        </View>
        <View style={{ marginTop: 4 }}>
          <MaskInput value={md} onChange={onMd} onBlur={onDateBlur} template="00.00" example={HINT.date} caret={M.route} testID="bf-md"
            style={{ fontFamily: FF.pf9, fontSize: 34, lineHeight: 36, color: M.ink }} />
        </View>
      </View>
      {/* 小样 backView:英文名(花体 26)一格 + 细线,下面中文名(宋体 13,字距 .2em)一格 + 细线 */}
      <View style={{ position: "absolute", left: 118, top: 8, width: 140 }}>
        <Text style={cap}>ON THE SPINE</Text>
        <View style={{ marginTop: 5 }}>
          {name === "" ? <Text pointerEvents="none" testID="bf-name-hint" style={[hint, { bottom: 4 }]}>{HINT.name}</Text> : null}
          <CaretInput caret={M.route} value={name} onChangeText={onName} onBlur={onNameBlur} autoCapitalize="words" autoCorrect={false} maxLength={49} testID="bf-name"
            style={{ padding: 0, fontFamily: FF.script, fontSize: 26, lineHeight: 28.6, height: 30, color: M.ink }} accessibilityLabel="书脊上的名字" />
        </View>
        <View style={{ marginTop: 1, borderTopWidth: 0.6, borderTopColor: M.ink, opacity: 0.5 }} />
        <View style={{ marginTop: 6 }}>
          {nameZh === "" ? <Text pointerEvents="none" testID="bf-name-zh-hint" style={[hint, { top: 1 }]}>{HINT.nameZh}</Text> : null}
          <CaretInput caret={M.route} value={nameZh} onChangeText={(v) => onNameZh(v.replace(/\n/g, ""))} onBlur={onNameZhBlur} autoCorrect={false} maxLength={ZH_MAX} testID="bf-name-zh"
            style={{ padding: 0, fontFamily: FF.serif5, fontSize: 13, lineHeight: 18, height: 18, letterSpacing: 2.6, color: M.ink }} accessibilityLabel="中文名" />
        </View>
        <View style={{ marginTop: 2, borderTopWidth: 0.6, borderTopColor: M.ink, opacity: 0.5 }} />
      </View>
      {nameErr ? <Text testID="bf-name-err" style={{ position: "absolute", left: 118, top: 94, width: 230, fontFamily: FF.serif5, fontSize: 11, lineHeight: 16, color: M.ink, opacity: 0.8 }}>{nameErr}</Text> : null}
      <View style={{ position: "absolute", right: 2, top: 20, width: 80, height: 50 }}>
        {BF_COLORS.map((c, i) => {
          const on = c === color, h = on ? 44 : 36, rot = on ? 0 : [-7, 5, 0, -4, 6][i];
          return (
            <Pressable key={c} onPress={() => onColor(c)} hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }} accessibilityLabel={c} accessibilityState={{ selected: on }}
              style={{ position: "absolute", left: i * 17, bottom: 0, width: 12, height: h, transform: [{ rotate: `${rot}deg` }], transformOrigin: "bottom", opacity: on ? 1 : 0.85,
                shadowColor: M.ink, shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 2 } }}>
              <View style={{ flex: 1, backgroundColor: planCol(c).c }} />
              {on ? <View style={{ position: "absolute", left: -2.8, top: -2.8, right: -2.8, bottom: -2.8, borderWidth: 0.8, borderColor: M.ink }} pointerEvents="none" /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** 地名候选条(小样 slips:214 宽,第一条左侧 3 粗路线色;点线分隔)。err=搜不了的原话 */
/** 候选纸条最高多少(多了在纸条里滚);「输入框一按下去……看不到待选列」——
 * 地名格离键盘 40 时候选排在它下面、正好被键盘盖住。候选一出来,页面按 PLACE_KB_GAP 再滚一次,把整张纸条让到键盘上方 */
export const PLACE_SLIPS_MAX = 280;
/** 页面键盘让位:候选纸条开着=按纸条实际高度(候选条数 × 约 45 + 原话一行)让出来,纸条底离键盘 12;没开照旧 40。
 *  纸条从地名格下沿往下 8 起排 */
export function placeKbGap(hits: number, hasErr: boolean): number {
  if (!hits && !hasErr) return 40;
  const slips = Math.min(PLACE_SLIPS_MAX, 8 + hits * 45 + (hasErr ? 34 : 0));
  return 8 + slips + 12;
}

export function PlaceSlips({ hits, err, M, onPick, style, notice }: { hits: PlaceHit[]; err: string | null; M: MapPal; onPick: (h: PlaceHit) => void; style?: ViewStyle; notice?: string | null }) {
  if (!hits.length && !err) return null;
  const attribution = getSession().config.place_service.attribution;
  return (
    <View testID="place-slips" style={[{ position: "absolute", left: 150, top: 96, width: 214, maxHeight: PLACE_SLIPS_MAX, zIndex: 4, backgroundColor: M.card, paddingVertical: 4,
      shadowColor: M.ink, shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: 0, height: 8 } }, style]}>
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled showsVerticalScrollIndicator={false} bounces={false}>
      {err ? <Text style={{ paddingVertical: 9, paddingLeft: 18, paddingRight: 14, fontFamily: FF.serif5, fontSize: 11, lineHeight: 16, color: M.ink, opacity: 0.75 }}>{err}</Text> : null}
      {notice && hits.length ? <Text testID="place-notice" style={{ paddingTop: 7, paddingBottom: 3, paddingLeft: 18, paddingRight: 14, fontFamily: FF.serif5, fontSize: 10, lineHeight: 15, color: M.ink, opacity: 0.7 }}>{notice}</Text> : null}
      {hits.map((h, j) => (
        <Pressable key={`${h.title}-${j}`} onPress={() => onPick(h)} accessibilityLabel={h.title} style={{ paddingTop: 9, paddingBottom: 9, paddingLeft: 18, paddingRight: 14 }}>
          {j ? <DottedTop color={alpha(M.ink, 0.4)} /> : null}
          {j === 0 ? <View style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, backgroundColor: M.route }} /> : null}
          <Text numberOfLines={1} style={{ fontFamily: FF.serif7, fontSize: 13, color: M.ink }}>{h.title}</Text>
          {h.address ? <Text numberOfLines={1} style={{ marginTop: 2, fontFamily: FF.serif5, fontSize: 9, letterSpacing: 0.54, color: M.ink, opacity: 0.6 }}>{h.address}</Text> : null}
        </Pressable>
      ))}
      {attribution && hits.length ? <Text testID="place-attribution" style={{ paddingTop: 4, paddingBottom: 4, paddingLeft: 18, paddingRight: 14, fontFamily: FF.pf, fontSize: 7.5, color: M.ink, opacity: 0.5 }}>{attribution}</Text> : null}
      </ScrollView>
    </View>
  );
}
function DottedTop({ color }: { color: string }) {
  return (
    <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1, flexDirection: "row", overflow: "hidden" }} pointerEvents="none">
      {Array.from({ length: 72 }, (_, k) => <View key={k} style={{ width: 1, height: 1, marginRight: 2, backgroundColor: color }} />)}
    </View>
  );
}

/** Place search. With a provider that allows search-as-you-type (/api/config place_service.supports_autocomplete):
 *  ask 350ms after typing stops. Otherwise (OpenStreetMap / Nominatim policy): nothing is sent while typing; the
 *  search runs when she presses 「搜索」 (or Enter). Late answers never cover newer ones; picking / closing folds the slips.
 *  A search that could not run keeps its sentence per row (also after blur) until that row is typed in again.
 *  notice = the engine's one line when another service answered (fallback), shown above the results. */
export function usePlaceSearch() {
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const gen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auto = getSession().config.place_service.supports_autocomplete;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const clear = () => { gen.current += 1; if (timer.current) clearTimeout(timer.current); setHits([]); setNotice(null); };
  const run = (t: string, key: string) => {
    const my = gen.current;
    ephemeraApi.placeSearchFull(t).then((r) => { if (my === gen.current) { setHits(r.items); setNotice(r.notice ?? null); } })
      .catch((e: Error) => { if (my === gen.current) { setHits([]); setNotice(null); setErrs((m) => ({ ...m, [key]: e.message })); } });
  };
  const query = (q: string, key: string) => {
    clear();
    setErrs((m) => { if (!(key in m)) return m; const x = { ...m }; delete x[key]; return x; });
    const t = q.trim();
    setPending((m) => ({ ...m, [key]: t }));
    if (!t || !auto) return;
    timer.current = setTimeout(() => run(t, key), 350);
  };
  /** 「搜索」: run the search for this row now (the only way when search-as-you-type is not allowed) */
  const submit = (key: string) => {
    const t = (pending[key] ?? "").trim();
    if (!t) return;
    clear();
    setPending((m) => ({ ...m, [key]: "" }));
    run(t, key);
  };
  /** show the 「搜索」 key: manual mode and something typed that has not been searched yet */
  const needsSubmit = (key: string) => !auto && !!(pending[key] ?? "").trim();
  const errOf = (key: string): string | null => errs[key] ?? null;
  return { hits, errOf, query, clear, submit, needsSubmit, notice, manual: !auto };
}

export const SEARCH_KEY_TEXT = "搜索 ›";
/** 「搜索」 under a place-name field (only when the place service does not allow search-as-you-type) */
export function SearchKey({ search, k, M, testID }: { search: ReturnType<typeof usePlaceSearch>; k: string; M: MapPal; testID?: string }) {
  if (!search.needsSubmit(k)) return null;
  return (
    <Pressable onPress={() => search.submit(k)} hitSlop={8} testID={testID} accessibilityLabel="搜索" style={{ marginTop: 6, alignSelf: "flex-start" }}>
      <Text style={{ fontFamily: FF.serif7, fontSize: 11, letterSpacing: 2, color: M.route }}>{SEARCH_KEY_TEXT}</Text>
    </Pressable>
  );
}

/** 一行里的报错/缺项小字(报错类文案,允许出现):引擎原话或「还缺类型/地名」;给了 onPress=点一下原地重试 */
export function RowErr({ text, M, style, testID, onPress }: { text: string | null | undefined; M: MapPal; style?: TextStyle; testID?: string; onPress?: () => void }) {
  if (!text) return null;
  const t = <Text testID={onPress ? undefined : testID} style={[{ marginTop: 6, width: 150, fontFamily: FF.serif5, fontSize: 11, lineHeight: 16, color: M.ink, opacity: 0.8 }, style]}>{text}</Text>;
  return onPress ? <Pressable onPress={onPress} hitSlop={6} testID={testID} accessibilityLabel={text}>{t}</Pressable> : t;
}

/** 她的一句话:有字=小爱心(路线色)+ 字;空着/正在写=小爱心 + 150 细线(空着整行 .38);无提示字 */
export function HerLine({ value, onChange, onBlur, M, editable, marginTop, testID }: {
  value: string; onChange?: (v: string) => void; onBlur?: () => void; M: MapPal; editable: boolean; marginTop: number; testID?: string;
}) {
  const ref = useRef<TextInput>(null);
  const [focus, setFocus] = useState(false);
  const shown = value.trim();
  if (!editable || (shown && !focus)) {
    if (!shown) return null;
    return (
      <Pressable disabled={!editable} onPress={() => { setFocus(true); setTimeout(() => ref.current?.focus(), 0); }} style={{ marginTop }} accessibilityLabel={`${herName()}的一句话`}>
        <Text style={{ fontFamily: FF.serif5, fontSize: 12, lineHeight: 19.8, color: M.title }}>
          <View style={{ width: 14, height: 9 }}><View style={{ position: "absolute", left: 0, top: 1 }}><Heart color={M.route} /></View></View>
          {shown}
        </Text>
      </Pressable>
    );
  }
  return (
    // collapsable=false:透明度从 .38 变 1 时这一层不许被拍平(拍平=输入框原生重挂=刚获得的焦点立刻丢)
    <View collapsable={false} style={{ marginTop: focus || shown ? marginTop - 2 : marginTop + 2, flexDirection: "row", alignItems: "flex-start", opacity: focus || shown ? 1 : 0.38 }}>
      <View style={{ width: 14, paddingTop: focus || shown ? 7 : 4 }}><Heart color={focus || shown ? M.route : M.ink} /></View>
      <CaretInput ref={ref} caret={M.route} value={value} onChangeText={onChange} onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); onBlur?.(); }} multiline maxLength={120}
        testID={testID} accessibilityLabel={`${herName()}的一句话`} autoFocus={focus && !!shown}
        placeholder={HINT.line} placeholderTextColor={alpha(M.ink, focus || shown ? 0.35 : 0.9)}
        style={{ width: 150, minHeight: 18, padding: 0, paddingBottom: 2, borderBottomWidth: 0.6, borderBottomColor: M.ink, fontFamily: FF.serif5, fontSize: focus || shown ? 12 : 11.5, lineHeight: 19.8, color: M.title }} />
    </View>
  );
}
