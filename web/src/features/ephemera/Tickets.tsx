// Ephemera ⑤ 当天:点开某一站的票,四种纸品四种手势(「每站打开」)——
// 蓝车票=点一下打孔 / 毛边预约卡=翻开见菜单 / 电影票=下拉撕副券 / 三折地图=展开后路线自己画到终点。
// 票面格子只填投影里有的:线路/上下车站/出发/车费/待到几点/地址/怎么去/到站给她的话。
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from "react-native-reanimated";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { ephemeraApi, type MapData, type Plan, type Stop } from "../../lib/ephemeraApi";
import { Art, Dots, FoilText, GoldFrame, Paper, PaperTex, pressIn, Svg as SvgBox, FitText, shapeShadow } from "./components";
import { addressOf, ART_OF, kindEn, kindOf, legLine, paperNo, placeName, two, type Paper4 } from "./format";
import { kindLine } from "./kinds";
import { deckle, perf, stampXml, zig } from "./shapes";
import { useTimers } from "./store";
import { FF, ff, MAPPAL, rgba, segC, type Skin, type SkinKey } from "./theme";
import { StopArt } from "./StopArt";
import { himEn } from "../../runtime/session";

type TicketProps = { plan: Plan; s: Stop; i: number; done: boolean; P: Skin; skin: SkinKey; onCheck: () => void };

/** The sheet learns how far down his note reaches (its foot, in the ticket box's units: a note drawn below the
 *  ticket makes the sheet's need taller, so it is scaled to show it rather than cut — the sheet does not scroll). */
export const TicketFoot = createContext<(foot: number) => void>(() => {});
/** onLayout for a note whose parent sits `base` below the ticket box's top */
function useReportFoot(base: number) {
  const report = useContext(TicketFoot);
  return (e: { nativeEvent: { layout: { y: number; height: number } } }) => report(base + e.nativeEvent.layout.y + e.nativeEvent.layout.height);
}

export function noteFrom(P: Skin, note: string, top: number, left = 22, right = 22) {
  return <NoteFrom P={P} note={note} top={top} left={left} right={right} />;
}
function NoteFrom({ P, note, top, left, right }: { P: Skin; note: string; top: number; left: number; right: number }) {
  const onLayout = useReportFoot(0);
  return (
    <View onLayout={onLayout} style={{ position: "absolute", left, right, top, paddingVertical: 16, paddingHorizontal: 18, backgroundColor: P.paper, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 8 } }}>
      <Text><Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 22, color: P.deep }}>from </Text><Text style={{ fontFamily: FF.serif7, fontSize: 15, letterSpacing: 1.5, color: P.deep }}>{himEn()}</Text></Text>
      <Text style={{ marginTop: 6, fontFamily: FF.serif5, fontSize: 13.5, lineHeight: 24, color: P.ink }}>{note}</Text>
    </View>
  );
}

export function fieldsOf(s: Stop): Array<[string, string]> {
  const pl = s.place, leg = pl?.leg;
  const out: Array<[string, string]> = [["Time", s.time ?? "—"]];
  if (s.stay_until) out.push(["Until", s.stay_until]);
  const addr = addressOf(s); // 没有地点的站(一件事)不显示地址
  if (addr) out.push(["Address", addr]);
  const how = legLine(leg, pl?.how_to_get);
  if (how) out.push(["How", how]);
  return out.slice(0, 4);
}

export function Ticket(p: TicketProps & { paper: Paper4 }) {
  if (p.paper === "train") return <TrainTicket {...p} />;
  if (p.paper === "dinner") return <MenuTicket {...p} />;
  if (p.paper === "walk") return <WalkTicket {...p} />;
  if (p.paper === "shop") return <ShopTicket {...p} />;
  return <CinemaTicket {...p} />;
}

// ── 购物小票:窄条小票、上下撕口;店名+小画+打字机体明细(只填投影里有的);
// 点一下底下的条码=「扫一下」,扫描线走过、盖章 THANK YOU ────────────────────────────────────
function ShopTicket({ plan, s, i, done, P, skin, onCheck }: TicketProps) {
  const c = segC(skin, i), W = 300, H = 620;
  const scan = useSharedValue(done ? 1 : 0), stamp = useSharedValue(done ? 1 : 0);
  const fired = useRef(done);
  const fire = () => {
    if (fired.current) return;
    fired.current = true;
    scan.value = withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) });
    stamp.value = withDelay(650, withTiming(1, { duration: 450, easing: Easing.bezier(0.6, -0.4, 0.7, 1.4) }));
    onCheck();
  };
  const scanSt = useAnimatedStyle(() => ({ opacity: scan.value > 0 && scan.value < 1 ? 0.9 : 0, transform: [{ translateX: 220 * scan.value }] }));
  const stampSt = useAnimatedStyle(() => ({ opacity: 0.85 * stamp.value, transform: [{ rotate: "-10deg" }, { scale: 1.8 - 0.8 * stamp.value }] }));
  const title = placeName(s);
  const lead = (k: string, v: string) => (
    <View key={k} style={{ flexDirection: "row", alignItems: "flex-start", marginTop: 7 }}>
      <Text style={{ fontFamily: FF.mono, fontSize: 10, letterSpacing: 1, color: P.deep }}>{k.toUpperCase()}</Text>
      <Svg style={{ flex: 1, marginHorizontal: 6, marginTop: 8 }} height={3}>
        <Line x1="1" y1="1.5" x2="100%" y2="1.5" stroke={rgba(P.sh, 0.45)} strokeWidth={1.4} strokeDasharray="0.01 3.4" strokeLinecap="round" />
      </Svg>
      <Text numberOfLines={3} style={{ maxWidth: 150, textAlign: "right", fontFamily: ff(v, FF.monoR, FF.serif5), fontSize: 11.5, lineHeight: 16, color: P.ink }}>{v}</Text>
    </View>
  );
  return (
    <View style={{ position: "absolute", left: 11, top: 18, width: W, height: H }}>
      <Paper w={W} h={H} d={zig(W, H, 5)} fill={P.paper} sh={P.sh} />
      <View style={{ position: "absolute", left: 0, right: 0, top: 26, alignItems: "center" }}>
        <FoilText text={`RECEIPT No. ${two(i)} · ${paperNo(plan)}`} size={9.5} />
        <FitText numberOfLines={1} adjustsFontSizeToFit style={[{ marginTop: 10, maxWidth: 250, fontFamily: ff(title, FF.pf9, FF.serif9), fontSize: 22, color: P.ink }, pressIn]}>{title}</FitText>
        <Text style={{ marginTop: 6, fontFamily: FF.mono, fontSize: 9, letterSpacing: 2.4, color: P.deep }}>{kindLine(s)}</Text>
      </View>
      <View style={{ position: "absolute", left: 40, right: 40, top: 112, height: 170, backgroundColor: c.bg, overflow: "hidden" }}>
        <StopArt s={s} color={c.art} inv style={{ left: -6, right: -6, top: -30, height: 330 }} />
      </View>
      <Dots w={W - 48} sw={1.6} gap={4} color={rgba(P.sh, 0.4)} style={{ left: 24, top: 300 }} />
      <View style={{ position: "absolute", left: 28, right: 28, top: 306 }}>
        {fieldsOf(s).map(([k, v]) => lead(k, v))}
      </View>
      {s.note ? (
        <View style={{ position: "absolute", left: 28, right: 28, top: 426 }}>
          <Dots w={W - 56} sw={1.6} gap={4} color={rgba(P.sh, 0.4)} style={{ position: "relative" }} />
          <Text style={{ marginTop: 8 }}><Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 20, color: P.deep }}>from </Text><Text style={{ fontFamily: FF.serif7, fontSize: 14, letterSpacing: 1.5, color: P.deep }}>{himEn()}</Text></Text>
          <Text numberOfLines={3} style={{ marginTop: 3, fontFamily: FF.serif5, fontSize: 12.5, lineHeight: 21, color: P.ink }}>{s.note}</Text>
        </View>
      ) : null}
      <Pressable onPress={fire} disabled={done} style={{ position: "absolute", left: 40, right: 40, top: 534, height: 60, alignItems: "center" }} accessibilityLabel="扫一下">
        <View style={{ flexDirection: "row", gap: 1.6, height: 40, overflow: "hidden" }}>
          {[2, 1, 3, 1, 1, 2, 4, 1, 2, 1, 3, 2, 1, 1, 4, 2, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 3, 1, 2, 4, 1, 1, 2, 3, 1, 2, 1, 3].map((x, q) => <View key={q} style={{ width: x, backgroundColor: P.ink }} />)}
          <Animated.View style={[{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: P.deep }, scanSt]} />
        </View>
        <Text style={{ marginTop: 6, fontFamily: FF.mono, fontSize: 8.5, letterSpacing: 2, color: P.ink, opacity: 0.7 }}>{`${paperNo(plan)} ${two(i)} ${(s.time ?? "").replace(":", "")}`}</Text>
      </Pressable>
      <Animated.View style={[{ position: "absolute", right: 22, top: 424, width: 104, height: 104 }, stampSt]} pointerEvents="none">
        <SvgBox xml={stampXml("THANK YOU · FOR TWO · THANK YOU · ", "", P.deep, 104)} w={104} h={104} />
      </Animated.View>
    </View>
  );
}

// ── 车票:点一下打孔 ───────────────────────────────────────────────────────────────
function TrainTicket({ s, i, done, P, skin, onCheck }: TicketProps) {
  const c = segC(skin, i);
  const leg = s.place?.leg, steps = leg?.steps ?? [];
  const from = steps[0]?.board, to = steps[steps.length - 1]?.alight;
  const name = placeName(s);
  const [punched, setPunched] = useState(done);
  const press = useSharedValue(0), hole = useSharedValue(done ? 1 : 0), chad = useSharedValue(0);
  const tap = () => {
    if (punched) return;
    setPunched(true);
    press.value = withSequence(withTiming(1, { duration: 130 }), withTiming(0, { duration: 130 }));
    hole.value = withSequence(withTiming(1.15, { duration: 180 }), withTiming(1, { duration: 80 }));
    chad.value = withTiming(1, { duration: 1000, easing: Easing.bezier(0.5, 0, 0.8, 0.6) });
    onCheck();
  };
  const cardSt = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.03 * press.value }, { rotate: `${-1 * press.value}deg` }] }));
  const holeSt = useAnimatedStyle(() => ({ transform: [{ scale: hole.value }] }));
  const chadSt = useAnimatedStyle(() => ({ opacity: 1 - chad.value, transform: [{ translateX: 30 * chad.value }, { translateY: 460 * chad.value }, { rotate: `${200 * chad.value}deg` }] }));
  const info: Array<[string, string]> = [];
  if (steps[0]?.line) info.push(["Line", steps[0].line]);
  if (leg?.depart_time) info.push(["Depart", leg.depart_time]);
  if (leg?.fare != null && leg.fare !== "") info.push(["Fare", String(leg.fare)]);   // the engine stores a number, no currency
  if (leg?.ticket_note) info.push(["Note", leg.ticket_note]);
  const nameSize = name.length > 8 ? 22 : name.length > 5 ? 28 : 34;
  return (
    <>
      <Pressable onPress={tap} style={{ position: "absolute", left: 0, top: 40, width: 322, height: 420 }} accessibilityLabel="检票">
        <Animated.View style={[{ flex: 1 }, cardSt]}>
          <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderRadius: 12, backgroundColor: c.bg, overflow: "hidden", shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 12 } }}>
            <PaperTex />
          </View>
          <View style={{ position: "absolute", left: 10, top: 10, right: 10, bottom: 10, borderWidth: 1.2, borderColor: "#FFF6F2", borderRadius: 8, opacity: 0.8 }} />
          <View style={{ position: "absolute", left: 0, right: 0, top: 30, alignItems: "center" }}>
            <Text style={{ fontFamily: FF.pf7, fontSize: 8, letterSpacing: 2.9, color: "#FFF6F2" }}>{`${two(i)} · LOCAL LINE · ADMIT TWO`}</Text>
            <FitText numberOfLines={1} adjustsFontSizeToFit style={{ marginTop: 18, maxWidth: 280, fontFamily: FF.serif9, fontSize: nameSize, letterSpacing: nameSize * 0.2, color: "#FFF6F2" }}>{name}</FitText>
          </View>
          {from || to ? (
            <View style={{ position: "absolute", left: 30, right: 30, top: 150, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View><Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: "#FFF6F2" }}>FROM</Text><Text style={{ fontFamily: FF.serif7, fontSize: 15, marginTop: 4, color: "#FFF6F2" }}>{from ?? "—"}</Text></View>
              <Svg width={70} height={12}><Path d="M0 6 H64 M58 1 L66 6 L58 11" stroke="#FFF6F2" strokeWidth={1.4} fill="none" /></Svg>
              <View style={{ alignItems: "flex-end" }}><Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: "#FFF6F2" }}>TO</Text><Text style={{ fontFamily: FF.serif7, fontSize: 15, marginTop: 4, color: "#FFF6F2" }}>{to ?? name}</Text></View>
            </View>
          ) : null}
          <View style={{ position: "absolute", left: 30, top: 220, width: 96, height: 96, borderRadius: 48, borderWidth: 1.6, borderColor: "#FFF6F2", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontFamily: FF.pf9, fontSize: 26, lineHeight: 30, color: "#FFF6F2" }}>{s.time ?? "—"}</Text>
            <Text style={{ fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 2, marginTop: 1, color: "#FFF6F2" }}>MEET AT</Text>
          </View>
          <View style={{ position: "absolute", left: 148, right: 28, top: 222 }}>
            {info.map(([k, v]) => (
              <View key={k} style={{ marginBottom: 10 }}>
                <Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2, color: "#FFF6F2", opacity: 0.8 }}>{k.toUpperCase()}</Text>
                <Text style={{ fontFamily: ff(v, FF.pf7, FF.serif5), fontSize: 13, marginTop: 2, color: "#FFF6F2" }}>{v}</Text>
              </View>
            ))}
          </View>
          {punched ? <Animated.View style={[{ position: "absolute", right: 34, top: 34, width: 18, height: 18, borderRadius: 9, backgroundColor: P.bg, shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 2, shadowOffset: { width: 0, height: 2 } }, holeSt]} /> : null}
          {punched && !done ? <Animated.View style={[{ position: "absolute", right: 34, top: 34, width: 18, height: 18, borderRadius: 9, backgroundColor: c.bg }, chadSt]} /> : null}
        </Animated.View>
      </Pressable>
      {s.note ? noteFrom(P, s.note, 488) : null}
    </>
  );
}

// ── 预约卡:点一下封面翻开,里面是菜单 ───────────────────────────────────────────────────
function MenuTicket({ s, i, done, P, skin, onCheck }: TicketProps) {
  const c = segC(skin, i);
  const [open, setOpen] = useState(done);
  const later = useTimers();
  const flip = useSharedValue(done ? 1 : 0), bon = useSharedValue(done ? 1 : 0);
  const tap = () => {
    if (open) return;
    setOpen(true);
    flip.value = withTiming(1, { duration: 1000, easing: Easing.bezier(0.5, 0, 0.2, 1) });
    bon.value = withDelay(1100, withTiming(1, { duration: 450, easing: Easing.bezier(0.6, -0.4, 0.7, 1.4) }));
    later(onCheck, 600);
  };
  const coverSt = useAnimatedStyle(() => ({ opacity: flip.value > 0.7 ? 1 - (flip.value - 0.7) / 0.3 : 1, transform: [{ perspective: 1200 }, { rotateX: `${-100 * flip.value}deg` }] }));
  const bonSt = useAnimatedStyle(() => ({ opacity: 0.85 * bon.value, transform: [{ rotate: "12deg" }, { scale: 1.7 - 0.7 * bon.value }] }));
  const rows = fieldsOf(s);
  const title = placeName(s);
  const noteFoot = useReportFoot(30);
  return (
    <View style={{ position: "absolute", left: 6, top: 30, width: 310, height: 470 }}>
      <Paper w={310} h={470} d={deckle(310, 470)} fill="#FFFDF8" sh={P.sh} />
      <View style={{ position: "absolute", left: 14, top: 14, right: 14, bottom: 14, borderWidth: 1, borderColor: P.deep, opacity: 0.55 }} />
      <View style={{ position: "absolute", left: 18, top: 18, right: 18, bottom: 18, borderWidth: 0.5, borderColor: P.deep, opacity: 0.4 }} />
      <View style={{ position: "absolute", left: 0, right: 0, top: 40, alignItems: "center" }}>
        <Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 34, color: P.deep }}>Menu</Text>
        <Text numberOfLines={1} style={{ marginTop: 6, maxWidth: 260, fontFamily: ff(title, FF.pf7, FF.serif7), fontSize: 8, letterSpacing: 2.7, color: P.deep }}>{`${title.toUpperCase()} · TABLE FOR TWO`}</Text>
      </View>
      <View style={{ position: "absolute", left: 40, right: 40, top: 130 }}>
        {rows.map(([k, v]) => (
          <View key={k} style={{ flexDirection: "row", alignItems: "flex-end", marginVertical: 9 }}>
            <Text style={{ width: 58, fontFamily: FF.pf7I, fontSize: 11, color: P.deep }}>{k}</Text>
            <View style={{ flex: 1, height: 1, marginBottom: 5, marginHorizontal: 6, overflow: "hidden" }}><Dots w={300} sw={1} gap={2.5} color={rgba(P.sh, 0.5)} style={{ left: 0, top: 0 }} /></View>
            <Text numberOfLines={2} style={{ maxWidth: 150, textAlign: "right", fontFamily: ff(v, FF.pf7, FF.serif5), fontSize: 13.5, color: P.ink }}>{v}</Text>
          </View>
        ))}
      </View>
      {s.note ? (
        <View onLayout={noteFoot} style={{ position: "absolute", left: 40, right: 40, top: 300, borderTopWidth: 1, borderTopColor: rgba(P.sh, 0.25), paddingTop: 16 }}>
          <Text><Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 22, color: P.deep }}>from </Text><Text style={{ fontFamily: FF.serif7, fontSize: 15, letterSpacing: 1.5, color: P.deep }}>{himEn()}</Text></Text>
          <Text style={{ marginTop: 6, fontFamily: FF.serif5, fontSize: 13.5, lineHeight: 24, color: P.ink }}>{s.note}</Text>
        </View>
      ) : null}
      <Animated.View style={[{ position: "absolute", right: 30, bottom: 30, width: 92, height: 92 }, bonSt]} pointerEvents="none">
        <SvgBox xml={stampXml("BON APPÉTIT · TABLE FOR TWO · ", "", P.deep, 92)} w={92} h={92} />
      </Animated.View>
      {!done ? (
        <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: 310, height: 470, transformOrigin: "top" }, coverSt]} pointerEvents={open ? "none" : "auto"}>
          <Pressable onPress={tap} style={{ flex: 1 }} accessibilityLabel="翻开菜单">
            <Paper w={310} h={470} d={deckle(310, 470)} fill="#FFFDF8" sh={P.sh} />
            <View style={{ position: "absolute", left: 14, top: 14, right: 14, bottom: 14, borderWidth: 1, borderColor: P.deep, opacity: 0.6 }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: 44, alignItems: "center" }}>
              <Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 40, color: P.deep }}>Réservation</Text>
              <Text style={{ marginTop: 8, fontFamily: FF.pf7, fontSize: 8, letterSpacing: 2.9, color: P.deep }}>{`${two(i)} · ${kindEn(s).toUpperCase()} FOR TWO · ${s.time ?? ""}`}</Text>
            </View>
            <View style={{ position: "absolute", left: 75, top: 140, width: 160, height: 200, borderRadius: 100, overflow: "hidden", backgroundColor: c.bg }}>
              <StopArt s={s} color={c.art} inv style={{ left: -20, right: -20, top: -10, height: 300 }} />
            </View>
            <FitText numberOfLines={1} adjustsFontSizeToFit style={{ position: "absolute", left: 20, right: 20, top: 360, textAlign: "center", fontFamily: FF.serif9, fontSize: 19, letterSpacing: 1.5, color: P.deep }}>{title}</FitText>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

// ── 电影票:副券往下撕 ──────────────────────────────────────────────────────────────
function CinemaTicket({ plan, s, i, done, P, skin, onCheck }: TicketProps) {
  const c = segC(skin, i), W = 322;
  const dy = useSharedValue(0), gone = useSharedValue(done ? 1 : 0), stamp = useSharedValue(done ? 1 : 0);
  const fired = useRef(done);
  const fire = () => { if (fired.current) return; fired.current = true; onCheck(); };
  const pan = useMemo(() => Gesture.Pan()
    .onUpdate((e) => { if (gone.value === 0) dy.value = Math.max(0, e.translationY); })
    .onEnd(() => {
      if (dy.value > 40) {
        gone.value = withTiming(1, { duration: 600, easing: Easing.bezier(0.4, 0, 0.6, 1) });
        stamp.value = withDelay(250, withTiming(1, { duration: 450, easing: Easing.bezier(0.6, -0.4, 0.7, 1.4) }));
        runOnJS(fire)();
      } else dy.value = withSpring(0, { damping: 9, stiffness: 160 });
    }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const stubSt = useAnimatedStyle(() => ({
    opacity: 1 - gone.value,
    transform: [{ translateX: 40 * gone.value }, { translateY: dy.value + (260 - dy.value) * gone.value }, { rotate: `${dy.value * 0.05 + 18 * gone.value}deg` }],
  }));
  const stampSt = useAnimatedStyle(() => ({ opacity: 0.85 * stamp.value, transform: [{ rotate: "-14deg" }, { scale: 1.8 - 0.8 * stamp.value }] }));
  const title = placeName(s);
  const noteFoot = useReportFoot(18);
  return (
    <View style={{ position: "absolute", left: 0, top: 18, width: W, height: 690 }}>
      <Paper w={W} h={590} d={perf(W, 590, 5, 15)} fill={P.paper} sh={P.sh} />
      <GoldFrame x={14} y={14} w={W - 28} h={562} />
      <View style={{ position: "absolute", left: 0, right: 0, top: 30, alignItems: "center" }}>
        <FoilText text={`TICKET No. ${two(i)} · ${paperNo(plan)}`} size={10} />
        <Text style={{ marginTop: 8, fontFamily: FF.pf7, fontSize: 8, letterSpacing: 2.9, color: P.deep }}>{kindLine(s)}</Text>
        <FitText numberOfLines={1} adjustsFontSizeToFit style={[{ marginTop: 8, maxWidth: 270, fontFamily: FF.serif9, fontSize: 22, letterSpacing: 1.3, color: P.ink }, pressIn]}>{title}</FitText>
      </View>
      <View style={{ position: "absolute", left: 30, right: 30, top: 134, height: 190, backgroundColor: c.bg, overflow: "hidden" }}>
        <StopArt s={s} color={c.art} inv style={{ left: -10, right: -10, top: -40, height: 300 }} />
      </View>
      <View style={{ position: "absolute", left: 30, right: 30, top: 340, flexDirection: "row", flexWrap: "wrap", borderTopWidth: 1, borderTopColor: rgba(P.sh, 0.25) }}>
        {fieldsOf(s).map(([k, v], j) => (
          <View key={k} style={{ width: "50%", paddingVertical: 9, paddingRight: 4, paddingLeft: j % 2 ? 12 : 0, borderBottomWidth: 1, borderBottomColor: rgba(P.sh, 0.25), borderRightWidth: j % 2 ? 0 : 1, borderRightColor: rgba(P.sh, 0.25) }}>
            <Text style={{ fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 2, color: P.deep }}>{k.toUpperCase()}</Text>
            <Text numberOfLines={2} style={{ marginTop: 3, fontFamily: ff(v, FF.pf7, FF.serif5), fontSize: 13, lineHeight: 18, color: P.ink }}>{v}</Text>
          </View>
        ))}
      </View>
      {s.note ? (
        <View onLayout={noteFoot} style={{ position: "absolute", left: 30, right: 30, top: 470 }}>
          <Text><Text style={{ fontFamily: FF.script, paddingRight: 8, fontSize: 22, color: P.deep }}>from </Text><Text style={{ fontFamily: FF.serif7, fontSize: 15, letterSpacing: 1.5, color: P.deep }}>{himEn()}</Text></Text>
          <Text style={{ marginTop: 4, fontFamily: FF.serif5, fontSize: 13.5, lineHeight: 24, color: P.ink }}>{s.note}</Text>
        </View>
      ) : null}
      <Animated.View style={[{ position: "absolute", right: 24, top: 300, width: 110, height: 110 }, stampSt]} pointerEvents="none">
        <SvgBox xml={stampXml(`ADMITTED · ${plan.title_en.replace("\n", " ").toUpperCase()} · `, "", P.deep, 110)} w={110} h={110} />
      </Animated.View>
      <Dots w={W - 24} sw={2} gap={4} color={rgba(P.sh, 0.4)} style={{ left: 12, top: 589 }} />
      {!done ? (
        <GestureDetector gesture={pan}>
          <Animated.View style={[{ position: "absolute", left: 0, top: 590, width: W, height: 100 }, stubSt]} accessibilityLabel="往下撕副券">
            <Paper w={W} h={100} d={perf(W, 100, 5, 15)} fill={P.paper} sh={P.sh} />
            <View style={{ position: "absolute", left: 0, right: 0, top: 20, alignItems: "center" }}>
              <Text style={{ fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 2.7, color: P.deep }}>ADMIT TWO · KEEP THIS HALF</Text>
              <Text style={{ marginTop: 14, fontFamily: FF.pf, fontSize: 18, color: P.deep }}>↓</Text>
            </View>
          </Animated.View>
        </GestureDetector>
      ) : null}
    </View>
  );
}

// ── 三折地图:点中间那折展开,路线自己画到终点(插画地图,原型 pictoMap) ───────────────────────
const APath = Animated.createAnimatedComponent(Path);

/** 散步那一段在真地图上:用整次约会的地图数据,裁到这一站的散步路线
 *  (没有散步路线就用到这一站的那段路;都没有=null,用原来的插画地图) */
type WalkGeo = { layers: Record<string, string[]>; tf: string; s: number; pts: Array<[number, number]>; len: number };
function walkGeo(m: MapData | null, n: number, W: number, H: number): WalkGeo | null {
  if (!m || m.empty) return null;
  const raw = m.walk_paths.find((w) => w.n === n)?.pts ?? m.legs.find((l) => l.n === n && l.pts.length > 1)?.pts;
  if (!raw || raw.length < 2) return null;
  const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = 46;
  const sc = Math.min((W - pad * 2) / Math.max(x1 - x0, 120), (H - 110 - pad) / Math.max(y1 - y0, 120), 3);
  const tx = W / 2 - ((x0 + x1) / 2) * sc, ty = 80 + (H - 80) / 2 - ((y0 + y1) / 2) * sc;
  const pts = raw.map(([x, y]) => [x * sc + tx, y * sc + ty] as [number, number]);
  const len = pts.slice(1).reduce((a, p, k) => a + Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]), 0);
  return { layers: m.layers, tf: `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${sc.toFixed(5)})`, s: sc, pts, len };
}

function WalkTicket({ plan, s, i, done, P, skin, onCheck }: TicketProps) {
  const W = 300, H = 400, pw = W / 3;
  const M = MAPPAL[skin];
  const [mapData, setMapData] = useState<MapData | null>(null);
  // tried = the map answered (or could not): only then is it known whether this stop has a real route
  const [tried, setTried] = useState(false);
  useEffect(() => {
    let alive = true;
    ephemeraApi.map(plan.id).then((m) => { if (alive) setMapData(m); }).catch(() => {}).finally(() => { if (alive) setTried(true); });
    return () => { alive = false; };
  }, [plan.id]);
  const real = useMemo(() => walkGeo(mapData, s.n, W, H), [mapData, s.n]);
  const [open, setOpen] = useState(done);
  const later = useTimers();
  const unfold = useSharedValue(done ? 1 : 0), draw = useSharedValue(done ? 1 : 0), fold = useSharedValue(done ? 0 : 1);
  const tap = () => {
    if (open) return;
    setOpen(true);
    fold.value = withTiming(0, { duration: 300 });
    unfold.value = withTiming(1, { duration: 1100, easing: Easing.bezier(0.5, 0, 0.2, 1) });
    draw.value = withDelay(900, withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.ease) }));
    later(onCheck, 1900);
  };
  const leftSt = useAnimatedStyle(() => ({ width: pw * unfold.value, left: pw - pw * unfold.value }));
  const leftInner = useAnimatedStyle(() => ({ left: -(pw - pw * unfold.value) }));
  const rightSt = useAnimatedStyle(() => ({ width: pw * unfold.value }));
  const foldSt = useAnimatedStyle(() => ({ opacity: fold.value }));
  const realLen = real?.len ?? 1;
  const realProps = useAnimatedProps(() => ({ strokeDashoffset: realLen * (1 - draw.value), strokeDasharray: draw.value >= 1 ? [0.1, 5.5] : [realLen, realLen] }));
  const head = (
    <>
      <Rect x={6} y={6} width={W - 12} height={H - 12} fill="none" stroke={P.deep} strokeWidth={1.2} />
      <Rect x={10} y={10} width={W - 20} height={H - 20} fill="none" stroke={P.deep} strokeWidth={0.5} />
      <G><Rect x={W / 2 - 75} y={18} width={150} height={30} fill={P.deep} /><Rect x={W / 2 - 72} y={21} width={144} height={24} fill="none" stroke={P.paper} strokeWidth={0.6} opacity={0.7} />
        <SvgText x={W / 2} y={39} textAnchor="middle" fontFamily="PinyonScript-Regular" fontSize={21} fill={P.paper}>{kindEn(s)}</SvgText>
        <SvgText x={W / 2} y={70} textAnchor="middle" fontFamily="EphemeraDisplay-Bold" fontSize={6.5} letterSpacing={2.4} fill={P.ink}>{`${two(i)} · ${s.time ?? ""}`}</SvgText></G>
    </>
  );
  const ns = "non-scaling-stroke" as const, L = real?.layers ?? {}, j = (k: string) => (L[k] ?? []).join("");
  const realMap = real ? (
    <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <Rect width={W} height={H} fill={M.land} />
      <G transform={real.tf}>
        <Path d={j("park")} fill={M.park} fillRule="evenodd" />
        <Path d={j("water")} fill={M.water} fillRule="evenodd" />
        <Path d={j("river")} fill="none" stroke={M.water} strokeWidth={20} strokeLinecap="round" strokeLinejoin="round" />
        <Path d={j("tiny")} fill="none" stroke={M.street} strokeOpacity={0.5} strokeWidth={0.6} vectorEffect={ns} strokeLinecap="round" />
        <Path d={j("minor")} fill="none" stroke={M.street} strokeWidth={1.3} vectorEffect={ns} strokeLinecap="round" strokeLinejoin="round" />
        <Path d={j("major") + j("motor")} fill="none" stroke={M.street} strokeWidth={3.2} vectorEffect={ns} strokeLinecap="round" strokeLinejoin="round" />
        <Path d={j("rail")} fill="none" stroke={M.ink} strokeOpacity={0.38} strokeWidth={1.4} strokeDasharray="4 2.5" vectorEffect={ns} />
      </G>
      <Rect x={0} y={0} width={W} height={84} fill={M.land} opacity={0.82} />
      <Path d={"M" + real.pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")} fill="none" stroke={M.land} strokeWidth={6.5} strokeLinecap="round" strokeLinejoin="round" />
      <APath d={"M" + real.pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")} fill="none" stroke={M.route} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" animatedProps={realProps} />
      <Circle cx={real.pts[0][0]} cy={real.pts[0][1]} r={4.5} fill={M.route} stroke={M.land} strokeWidth={1.4} />
      {(() => { const E = real.pts[real.pts.length - 1]; return <Path d={`M${E[0]} ${E[1] + 11} C ${E[0] - 15} ${E[1] - 1}, ${E[0] - 13} ${E[1] - 18}, ${E[0]} ${E[1] - 9} C ${E[0] + 13} ${E[1] - 18}, ${E[0] + 15} ${E[1] - 1}, ${E[0]} ${E[1] + 11}Z`} fill={M.route} stroke={M.land} strokeWidth={1} />; })()}
      {head}
      <SvgText x={W - 16} y={H - 16} textAnchor="end" fontFamily="EphemeraDisplay-Regular, NotoSerifSC-Regular-app" fontSize={5.5} fill={M.ink} opacity={0.5}>{mapData?.attribution || "© OpenStreetMap contributors"}</SvgText>
    </Svg>
  ) : null;
  // No real route for this stop (a moment, no base map, no path): no map at all — the same folded ticket carries
  // this stop's picture, its kind line and name instead, and the walk stamp when it is checked.
  const c = segC(skin, i);
  const stampSt = useAnimatedStyle(() => ({ opacity: draw.value, transform: [{ scale: 1.6 - 0.6 * draw.value }, { rotate: "-10deg" }] }));
  const face = (
    <View style={{ width: W, height: H, backgroundColor: P.paper }} testID="walk-nomap">
      <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>{head}</Svg>
      <View style={{ position: "absolute", left: 30, right: 30, top: 84, height: 206, backgroundColor: c.bg, overflow: "hidden" }}>
        <StopArt s={s} color={c.art} inv style={{ left: -10, right: -10, top: -40, height: 300 }} />
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, top: 306, alignItems: "center" }}>
        <Text style={{ fontFamily: FF.pf7, fontSize: 8, letterSpacing: 2.9, color: P.deep }}>{kindLine(s)}</Text>
        <FitText numberOfLines={1} adjustsFontSizeToFit style={[{ marginTop: 8, maxWidth: 250, fontFamily: FF.serif9, fontSize: 20, letterSpacing: 1.3, color: P.ink }, pressIn]}>{placeName(s)}</FitText>
      </View>
      <Animated.View style={[{ position: "absolute", right: 22, bottom: 18, width: 60, height: 60 }, stampSt]} pointerEvents="none">
        <Svg width={60} height={60} viewBox="0 0 60 60">
          <Path d="M30 50 C 8 34, 10 14, 30 24 C 50 14, 52 34, 30 50Z" fill="none" stroke={c.stamp} strokeWidth={2.4} strokeLinecap="round" />
        </Svg>
      </Animated.View>
    </View>
  );
  const blank = <View style={{ width: W, height: H, backgroundColor: P.paper }} />;
  const map = realMap ?? (tried ? face : blank);
  // until the map has answered, the cover says "Map" (no flash of another word when a route does arrive)
  const cover = tried && !real ? kindEn(s) : "Map";
  return (
    <>
      <View style={{ position: "absolute", left: 11, top: 20, width: W, height: H, ...shapeShadow(`rgb(${P.sh})`, 0.3, 14, 12) }}>
        {/* 中间那折一直在;左右两折从中间往外展开 */}
        <View style={{ position: "absolute", left: pw, top: 0, width: pw, height: H, overflow: "hidden" }}><View style={{ marginLeft: -pw }}>{map}</View><PaperTex /></View>
        <Animated.View style={[{ position: "absolute", top: 0, height: H, overflow: "hidden" }, leftSt]}><Animated.View style={[{ position: "absolute", top: 0, width: W }, leftInner]}>{map}</Animated.View><PaperTex /></Animated.View>
        <Animated.View style={[{ position: "absolute", left: pw * 2, top: 0, height: H, overflow: "hidden" }, rightSt]}><View style={{ marginLeft: -pw * 2 }}>{map}</View><PaperTex /></Animated.View>
        {!done ? (
          <Animated.View style={[{ position: "absolute", left: pw, top: 0, width: pw, height: H, backgroundColor: P.big.c, alignItems: "center", justifyContent: "center" }, foldSt]} pointerEvents={open ? "none" : "auto"}>
            <Pressable onPress={tap} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }} accessibilityLabel={real ? "展开地图" : "展开"}>
              <FitText numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4} style={{ maxWidth: pw - 10, fontFamily: FF.script, paddingRight: 8, fontSize: 30, color: P.big.l }}>{cover}</FitText>
            </Pressable>
          </Animated.View>
        ) : null}
      </View>
      {s.note ? noteFrom(P, s.note, 440) : null}
    </>
  );
}
