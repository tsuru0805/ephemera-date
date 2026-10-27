// Ephemera ⑥ 纪念归档 · 书架(原型 shelfView):一次约会一盒,书脊=那次的颜色 + 花体名;
// 放满一层换下一层、整页往下滑、从新到旧、每层标日期范围(纪念归档)。
import { type Href, useRouter } from "../../nav/router";
import { useEffect } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import { LinearGradient } from "expo-linear-gradient";
import { SvgXml } from "react-native-svg";
import type { Plan } from "../../lib/ephemeraApi";
import { NavBar, PaperTex, Stage, useStage, FitText } from "./components";
import { dateParts, paperNo, stopsMain, titleLines, titleZh, vertical } from "./format";
import { boxMarkXml } from "./icons";
import { keptPlans, nextPlan, usePlans, useSkin } from "./store";
import { FF, planCol } from "./theme";
import { FlightSpot, fly } from "./flight";

const SW = [84, 66, 74, 60, 70, 78, 64, 72], SH = [420, 372, 400, 346, 388, 410, 360, 396];
const W = 346, GAP = 6, TOP = 150, ROW_H = 470;

export function EphemeraShelfScreen() {
  const router = useRouter();
  const { P, M } = useSkin();
  const { plans } = usePlans();
  const { body } = useStage();
  const kept = plans ? keptPlans(plans) : [];
  const next = plans ? nextPlan(plans) : null;
  const rows = shelfRows(kept);
  const total = TOP + ROW_H * Math.max(1, rows.length) + 120;
  const first = kept.length ? dateParts(kept[kept.length - 1].date).dot : null;
  return (
    <Stage P={P} overlay={<NavBar on="Archive" P={P} dateHref={next ? (`/ephemera-day?id=${next.id}` as Href) : null} />}>
      <ScrollView style={{ width: 390, height: body }} contentContainerStyle={{ height: total }} showsVerticalScrollIndicator={false}>
        <Text style={{ position: "absolute", left: 22, top: 46, fontFamily: FF.pf9, fontSize: 42, color: P.deep }}>Archive</Text>
        <Text style={{ position: "absolute", left: 26, top: 96, fontFamily: FF.script, paddingRight: 8, fontSize: 19, color: P.deep }}>kept, one box at a time</Text>
        <View style={{ position: "absolute", right: 22, top: 58, alignItems: "flex-end" }}>
          <Text style={{ fontFamily: FF.pf9, fontSize: 34, lineHeight: 36, color: P.deep }}>{String(kept.length).padStart(2, "0")}</Text>
          <Text style={{ marginTop: 4, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 2, color: P.ink }}>DATES KEPT</Text>
        </View>
        {rows.map((r, ri) => {
          const base = TOP + ROW_H * (ri + 1) - 40;
          let x = 22;
          const ds = r.map((o) => dateParts(o.p.date).dot);
          const range = ds.length > 1 ? `${ds[ds.length - 1]} — ${ds[0]}` : ds[0] ?? "";
          return (
            <View key={ri} style={{ position: "absolute", left: 0, top: 0, width: 390, height: total }} pointerEvents="box-none">
              {range ? <Text style={{ position: "absolute", left: 22, top: base - 448, fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: P.deep }}>{`SHELF ${String(ri + 1).padStart(2, "0")} · ${range}`}</Text> : null}
              {r.map(({ p, k, w }, j) => {
                const h = SH[k % 8], lean = ri > 0 && j === r.length - 1 && r.length > 2, left = x; // 第一层最后一本是空白书脊(它自己歪),同小样
                x += w + (lean ? 16 : GAP);
                return <Spine key={p.id} p={p} w={w} h={h} left={left} top={base - h} lean={lean} delay={80 + Math.min(k, 8) * 70} M={M} onPress={() => fly(`spine:${p.id}`, `box:${p.id}`, () => router.push(`/ephemera-box?id=${p.id}&m=1&from=spine` as Href), { dur: 820, pre: { dy: -46, ms: 260 } })} />;
              })}
              {ri === 0 ? <BlankSpine left={x} base={base} onPress={() => fly("blank-spine", "backfill-page", () => router.push("/ephemera-backfill?m=1" as Href), { dur: 820, pre: { dy: -46, ms: 240 } })} /> : null}
              <View style={{ position: "absolute", left: 0, right: 0, top: base, height: 12, backgroundColor: P.paper2, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.6)", shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 6 } }} />
            </View>
          );
        })}
        {first ? <Text style={{ position: "absolute", right: 22, top: total - 90, fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: P.deep }}>{`SINCE ${first}`}</Text> : null}
        {plans && !kept.length ? <Text style={{ position: "absolute", left: 22 + BLANK_W + 20, top: TOP + 40, fontFamily: FF.script, paddingRight: 8, fontSize: 26, color: P.deep, opacity: 0.6 }}>Nothing kept yet</Text> : null}
      </ScrollView>
    </Stage>
  );
}

/** 书架分层:放满一层换下一层;第一层末尾留一本空白书脊的位置——
 * 小样不预留,排满时会伸出屏外;这里第一层少放 BLANK_W−16 宽,保证空白书脊落在屏内,小样那排数据下摆法不变) */
export const BLANK_W = 44;
export function shelfRows<T>(kept: T[]): Array<Array<{ p: T; k: number; w: number }>> {
  const rows: Array<Array<{ p: T; k: number; w: number }>> = [];
  let row: Array<{ p: T; k: number; w: number }> = [], used = 0;
  kept.forEach((p, k) => {
    const w = SW[k % 8], cap = rows.length ? W : W - (BLANK_W - 16);
    if (used + w > cap && row.length) { rows.push(row); row = []; used = 0; }
    row.push({ p, k, w }); used += w + GAP;
  });
  rows.push(row); // 第一层哪怕一本都没有也在(空白书脊在那)
  return rows.filter((r, i) => i === 0 || r.length);
}

/** 书脊上的中文小字(竖排,一字 12 高,从 94 起)不许压到竖排英文花体上:英文从书脊下方 h-52 往上长,
 * 长度按花体平均字宽 0.38 字号估(实拍量 Cafe Matinee);放不下就截短,最后一格换「⋯」(实拍:短书脊 + 长名会叠在一起) */
export function spineZh(zh: string, en: string, h: number, fs: number): string {
  const enTop = h - 52 - en.length * fs * 0.38;
  const room = Math.floor((enTop - 8 - 94) / 12);
  const cs = [...zh];
  if (cs.length <= room) return zh;
  return room <= 1 ? "" : cs.slice(0, room - 1).join("") + "⋯";
}

/** 补记入口:一本没印字的书脊(小样 blankSpine:纸色、细框 .35、空圆章、「No.」、两道细线、中间一道竖线,向左歪 4°) */
function BlankSpine({ left, base, onPress }: { left: number; base: number; onPress: () => void }) {
  const { P } = useSkin();
  const w = BLANK_W, h = 386;
  return (
    <FlightSpot k="blank-spine" rot={-4} style={{ position: "absolute", left, top: base - h, width: w, height: h, transform: [{ rotate: "-4deg" }], transformOrigin: "bottom", shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: 0, height: 8 } }}>
      <Pressable onPress={onPress} style={{ flex: 1, backgroundColor: P.paper, overflow: "hidden" }} accessibilityLabel="补记一次约会" testID="shelf-blank-spine">
        <PaperTex opacity={0.7} />
        <LinearGradient colors={["rgba(0,0,0,0.14)", "rgba(0,0,0,0)"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 5 }} />
        <View style={{ position: "absolute", left: 6, right: 6, top: 8, bottom: 8, borderWidth: 0.8, borderColor: P.deep, opacity: 0.35 }} />
        <View style={{ position: "absolute", left: w / 2 - 12, top: 20, width: 24, height: 24, borderRadius: 12, borderWidth: 0.8, borderColor: P.deep, opacity: 0.45 }} />
        <Text style={{ position: "absolute", left: 0, right: 0, top: 58, textAlign: "center", fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.95, color: P.deep, opacity: 0.6 }}>NO.</Text>
        <View style={{ position: "absolute", left: 12, right: 12, top: 76, borderTopWidth: 0.8, borderTopColor: P.deep, opacity: 0.4 }} />
        <View style={{ position: "absolute", left: w / 2, top: 110, height: 200, borderLeftWidth: 0.6, borderLeftColor: P.deep, opacity: 0.22 }} />
        <View style={{ position: "absolute", left: 12, right: 12, bottom: 26, borderTopWidth: 0.8, borderTopColor: P.deep, opacity: 0.4 }} />
      </Pressable>
    </FlightSpot>
  );
}

function Spine({ p, w, h, left, top, lean, delay, M, onPress }: { p: Plan; w: number; h: number; left: number; top: number; lean: boolean; delay: number; M: ReturnType<typeof useSkin>["M"]; onPress: () => void }) {
  const { P } = useSkin();
  const c = planCol(p.color), ink = c.t;
  const t = useSharedValue(0);
  useEffect(() => { t.value = withDelay(delay, withTiming(1, calm())); }, [t, delay]);
  const st = useAnimatedStyle(() => ({ opacity: Math.min(1, t.value * 1.5), transform: [{ rotate: lean ? "-6deg" : "0deg" }, { translateY: 30 * (1 - t.value) }] }));
  const [t1, t2] = titleLines(p);
  const dp = dateParts(p.date);
  return (
    <FlightSpot k={`spine:${p.id}`} rot={lean ? -6 : 0} style={[{ position: "absolute", left, top, width: w, height: h, transformOrigin: "bottom", shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: 0, height: 8 } }, st]}>
      <Pressable onPress={onPress} style={{ flex: 1, backgroundColor: c.c, overflow: "hidden" }} accessibilityLabel={`${t1} ${t2}`}>
        <PaperTex />
        <LinearGradient colors={["rgba(0,0,0,0.14)", "rgba(0,0,0,0)"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 5 }} />
        <View style={{ position: "absolute", left: 7, right: 7, top: 8, bottom: 8, borderWidth: 0.8, borderColor: ink, opacity: 0.55 }} />
        <View style={{ position: "absolute", left: w / 2 - 15, top: 18 }}><SvgXml xml={boxMarkXml({ no: paperNo(p), d: dp.dot, kinds: stopsMain(p) }, 30, false, M)} width={30} height={30} /></View>
        <Text style={{ position: "absolute", left: 0, right: 0, top: 58, textAlign: "center", fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.3, color: ink }}>NO.</Text>
        <Text style={{ position: "absolute", left: 0, right: 0, top: 70, textAlign: "center", fontFamily: FF.pf9, fontSize: 13, color: ink }}>{paperNo(p)}</Text>
        {/* 中英都有:中文小字竖排在编号下面(小样:宋体 500 10,字距 .2em,透明度 .85) */}
        {titleZh(p) ? <Text testID="spine-zh" style={{ position: "absolute", left: 0, right: 0, top: 94, textAlign: "center", fontFamily: FF.serif5, fontSize: 10, lineHeight: 12, color: ink, opacity: 0.85 }}>{vertical(spineZh(titleZh(p)!, `${t1} ${t2}`.trim(), h, w > 70 ? 30 : 26))}</Text> : null}
        {/* 竖排花体名:文字框按中心转 -90°,字的开头落在书脊下方(原型 .vcap) */}
        <FitText numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={{ position: "absolute", width: h - 140, height: 40, left: w / 2 - (h - 140) / 2, top: h - 52 - (h - 140) / 2 - 20, fontFamily: FF.script, paddingRight: 8, fontSize: w > 70 ? 30 : 26, lineHeight: 40, color: ink, transform: [{ rotate: "-90deg" }] }}>{`${t1} ${t2}`.trim()}</FitText>
        <Text style={{ position: "absolute", left: 0, right: 0, bottom: 20, textAlign: "center", fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 0.9, color: ink }}>{dp.dot}</Text>
      </Pressable>
    </FlightSpot>
  );
}

