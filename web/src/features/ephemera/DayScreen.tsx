// Ephemera ⑤ 当天连票(原型 dayView/strip):一整条连票,每站一格,齿孔分隔,票头写约会名,票尾记数;
// 右侧副券跳色(每格不同色,随皮肤换);检票记号各不同(打孔 / BON APPÉTIT 章 / ADMITTED 章 / 爱心)。
// 到点亮 NOW(只认引擎下发的到达时刻 + 引擎时钟);地点没公开的格子写「? ? ?」,线索点开才看。
import { type Href, useLocalSearchParams, useRouter } from "../../nav/router";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import Svg, { Path } from "react-native-svg";
import { ephemeraApi, type Plan, type Stop } from "../../lib/ephemeraApi";
import { Art, BackKey, DotLink, Dots, FoilLine, FoilText, GoldFrame, NavBar, Paper, pressIn, Stage, Svg as SvgBox, useStage, FitText } from "./components";
import { ART_OF, dateParts, kindOf, paperNo, paperOf, placeName, stopState, titleOne, two, type Paper4, type StopState } from "./format";
import { kindLineNarrow } from "./kinds";
import { PhotoFlow } from "./PhotoFlow";
import { stampXml, stripPath } from "./shapes";
import { getLocal, has, patchLocal, usePlan, useSkin, useTimers } from "./store";
import { Ticket, TicketFoot } from "./Tickets";
import { FF, rgba, segC, type Skin, type SkinKey } from "./theme";
import { StopArt } from "./StopArt";
import { FlightSpot, fly } from "./flight";
import { tzOffset } from "../../lib/tz";

const W = 346, HEAD = 92, SEG = 112, FOOT = 64, SX = 262;

export function EphemeraDayScreen() {
  const sp = useLocalSearchParams<{ id: string; m?: string }>();
  const id = Number(sp.id);
  const flewIn = sp.m === "1";   // 连票是请柬飞过来变的=不再自己弹进来
  const router = useRouter();
  const { key: skin, P } = useSkin();
  const { plan, her, mark, reload, now, error } = usePlan(id, { poll: true });
  const { body } = useStage();
  // 这一页的提示(下一张 / 检完了 / 才能拆开 / 收好了 / 没检成的原因)写在页头日期那一行,两秒后换回日期:
  // 浮层不管放哪都会压到连票上的字(贴底压页脚、页头下压票头 No.·ADMIT TWO)
  const [hint, setHint] = useState<string | null>(null);
  const hintT = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (hintT.current) clearTimeout(hintT.current); }, []);
  const say = (m: string) => { setHint(m); if (hintT.current) clearTimeout(hintT.current); hintT.current = setTimeout(() => setHint(null), 2200); };
  const [clues, setClues] = useState<number[]>([]);
  const [sheet, setSheet] = useState<number | null>(null);
  const [photoFor, setPhotoFor] = useState<number | null>(null);
  const [, tick] = useState(0);
  const later = useTimers();
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { getLocal(id).then((l) => setClues(l.clues ?? [])); }, [id]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 20_000); return () => clearInterval(t); }, []);
  // 开着的那张票被跳过了(30 秒轮询换上新数据):自己收起,不留一张还能检票的票
  const sheetSkipped = sheet !== null && !!plan?.stops[sheet]?.skipped;
  useEffect(() => { if (sheetSkipped) { setSheet(null); say("这一站跳过了"); } }, [sheetSkipped]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!plan) return <Stage P={P}><BackKey color={P.deep} top={40} onPress={() => router.back()} />{error ? <LoadErr P={P} msg={error} /> : null}</Stage>;
  const live = plan.status === "live";
  const nowSec = now();
  const states = plan.stops.map((s) => stopState(s, has(her, `checkin:${s.stop_id}`), nowSec, live));
  const doneN = states.filter((x) => x === "done").length;
  const liveN = states.filter((x) => x !== "skipped").length;   // 跳过的站不算进进度
  const dp = dateParts(plan.date);
  const clock = new Date((nowSec + tzOffset(nowSec)) * 1000);
  const hhmm = `${String(clock.getUTCHours()).padStart(2, "0")}:${String(clock.getUTCMinutes()).padStart(2, "0")}`;
  const photoOf = (s: Stop) => her?.photos.find((p) => p.stop_id === s.stop_id) ?? null;

  const openClue = (s: Stop) => { const n = [...clues, s.stop_id]; setClues(n); patchLocal(plan.id, { clues: n }); };
  const check = async (i: number) => {
    const s = plan.stops[i];
    // 票开着的时候他跳过了这一站(30 秒轮询换上的新数据):不检票,收起说明白
    if (states[i] === "skipped") { setSheet(null); say("这一站跳过了"); return; }
    try {
      await mark(`checkin:${s.stop_id}`);
      if (closeT.current) clearTimeout(closeT.current);
      closeT.current = later(() => {
        setSheet((cur) => (cur === i ? null : cur));
        const nx = plan.stops.findIndex((_, k) => k !== i && states[k] !== "done" && states[k] !== "skipped");
        say(nx < 0 ? "今天的票都检完了" : `下一张：${plan.stops[nx].time ?? ""}`);
      }, 1500);
    } catch (e) {
      // 没检成:收起这张票(重开时按引擎的真实状态画,不留「已打孔」的假样子)
      setSheet(null);
      say((e as Error).message);
    }
  };

  return (
    <Stage P={P} overlay={
      <>
        {sheet !== null ? <TicketSheet plan={plan} i={sheet} done={states[sheet] === "done"} P={P} skin={skin} onClose={() => setSheet(null)} onCheck={() => check(sheet)} /> : null}
        {photoFor !== null ? (
          <PhotoFlow s={plan.stops[photoFor]} i={photoFor} P={P} skin={skin} onClose={() => setPhotoFor(null)}
            onSkip={async () => { const s = plan.stops[photoFor]; setPhotoFor(null); await mark(`nophoto:${s.stop_id}`).catch(() => {}); say("这一站没放照片"); }}
            onDone={async (file, cap, cid, onProgress) => { await ephemeraApi.uploadPhoto(plan.id, plan.stops[photoFor].stop_id, file, cap, cid, onProgress); setPhotoFor(null); await reload(); say("收好了"); }} />
        ) : null}
        {sheet === null && photoFor === null ? <NavBar on="Date" P={P} dateHref={`/ephemera-day?id=${plan.id}` as Href} /> : null}
      </>
    }>
      <BackKey color={P.deep} top={40} onPress={() => router.back()} />
      <Text style={{ position: "absolute", left: 48, top: 40, fontFamily: FF.script, paddingRight: 8, fontSize: 38, color: P.deep }}>{"Today's Trip"}</Text>
      {hint ? (
        <FitText testID="day-hint" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={{ position: "absolute", left: 52, top: 86, width: 140, fontFamily: FF.serif5, fontSize: 12, letterSpacing: 0.6, color: P.deep }}>{hint}</FitText>
      ) : <Text style={{ position: "absolute", left: 52, top: 88, fontFamily: FF.pf7, fontSize: 11, letterSpacing: 2.2, color: P.ink }}>{`${dp.dot} ${dp.dow.toUpperCase()}`}</Text>}
      <View style={{ position: "absolute", right: 20, top: 84, height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: P.paper, justifyContent: "center", shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }}>
        <Text style={{ fontFamily: FF.pf7, fontSize: 13, color: P.ink }}>{hhmm}</Text>
      </View>
      <Pressable onPress={() => router.push(`/ephemera-map?id=${plan.id}` as Href)} style={{ position: "absolute", right: 96, top: 84, height: 26, paddingHorizontal: 10, borderRadius: 13, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: P.paper, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }} accessibilityLabel="地图">
        <Svg width={16} height={14} viewBox="0 0 16 14"><Path d="M1 2.5 L5.5 1 L10.5 2.5 L15 1 V11.5 L10.5 13 L5.5 11.5 L1 13Z M5.5 1 V11.5 M10.5 2.5 V13" fill="none" stroke={P.deep} strokeWidth={1.1} strokeLinejoin="round" /></Svg>
        <Text style={{ fontFamily: FF.pf7I, fontSize: 12, color: P.deep }}>Map</Text>
      </Pressable>
      <ScrollView style={{ position: "absolute", left: 0, top: 122, width: 390, height: body - 122 }} contentContainerStyle={{ paddingTop: 6, paddingBottom: 60, alignItems: "center" }} showsVerticalScrollIndicator={false}>
        {/* 他收尾以后:第一屏就看得到「收进纪念盒」(原来在连票下面要往下滑) */}
        {plan.status === "done" ? (
          <Pressable onPress={() => fly(`day-strip:${plan.id}`, `box:${plan.id}`, () => router.push(`/ephemera-box?id=${plan.id}&m=1` as Href), { dur: 860 })} style={{ width: 240, alignItems: "center", marginTop: 2, marginBottom: 18 }} accessibilityLabel="收进纪念盒">
            <Text style={[{ fontFamily: FF.serif9, fontSize: 22, letterSpacing: 11, marginLeft: 11, color: P.btn }, pressIn]}>收进纪念盒</Text>
            <FoilLine w={160} style={{ marginTop: 12 }} />
            <Text style={{ marginTop: 12, fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 3.2, color: P.btn, opacity: 0.85 }}>KEEP THE DAY</Text>
          </Pressable>
        ) : null}
        <Strip flewIn={flewIn} plan={plan} states={states} P={P} skin={skin} clues={clues} doneN={doneN} totalN={liveN}
          photo={(s) => (photoOf(s) ? "kept" : has(her, `nophoto:${s.stop_id}`) ? "skip" : null)}
          onSeg={(i) => {
            if (states[i] === "skipped") { say("这一站跳过了"); return false; }
            if (states[i] === "locked") { if (plan.status !== "done") say(`${plan.stops[i].time ?? ""} 才能拆开这一格`); return plan.status === "done"; }
            setSheet(i); return true;
          }}
          onClue={openClue} onPhoto={(i) => setPhotoFor(i)} />
      </ScrollView>
    </Stage>
  );
}

function Strip({ flewIn, plan, states, P, skin, clues, doneN, totalN, photo, onSeg, onClue, onPhoto }: {
  flewIn?: boolean;
  plan: Plan; states: StopState[]; P: Skin; skin: SkinKey; clues: number[]; doneN: number; totalN: number;
  photo: (s: Stop) => "kept" | "skip" | null; onSeg: (i: number) => boolean; onClue: (s: Stop) => void; onPhoto: (i: number) => void;
}) {
  const n = plan.stops.length, H = HEAD + SEG * n + FOOT;
  const seps = [HEAD, ...plan.stops.map((_, k) => HEAD + SEG * (k + 1))];
  const enter = useSharedValue(0);
  useEffect(() => { enter.value = flewIn ? 1 : withTiming(1, calm()); }, [enter, flewIn]);
  const st = useAnimatedStyle(() => ({ opacity: Math.min(1, enter.value * 1.4), transform: [{ translateY: 40 * (1 - enter.value) }] }));
  return (
    <FlightSpot k={`day-strip:${plan.id}`} style={[{ width: W, height: H, marginBottom: 30 }, st]}>
      <Paper w={W} h={H} d={stripPath(W, H, seps)} fill={P.paper} sh={P.sh} texture={0.6} />
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: HEAD, alignItems: "center" }}>
        <GoldFrame x={14} y={12} w={W - 28} h={HEAD - 22} />
        <FoilText text={`No. ${paperNo(plan)} · ADMIT TWO · ${n} STOPS`} size={9} style={{ marginTop: 22 }} />
        <FitText testID="day-strip-title" numberOfLines={1} adjustsFontSizeToFit style={[{ marginTop: 4, maxWidth: W - 50, fontFamily: FF.script, paddingRight: 8, fontSize: 28, color: P.deep }, pressIn]}>{titleOne(plan)}</FitText>
      </View>
      {seps.map((y) => <Dots key={y} w={W - 24} color={rgba(P.sh, 0.38)} style={{ left: 12, top: y - 0.75 }} />)}
      {plan.stops.map((s, i) => (
        <Seg key={s.stop_id} s={s} i={i} title={titleOne(plan)} over={plan.status === "done"} st={states[i]} P={P} skin={skin} clue={clues.includes(s.stop_id)} photo={photo(s)}
          onPress={() => onSeg(i)} onClue={() => onClue(s)} onPhoto={() => onPhoto(i)} />
      ))}
      <View style={{ position: "absolute", left: 0, right: 0, top: H - FOOT, height: FOOT, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 22 }}>
        <Text style={{ fontFamily: FF.pf7, fontSize: 7, lineHeight: 12.6, letterSpacing: 2, color: P.ink, opacity: 0.75 }}>{"KEEP THIS STRIP\nGOOD COMPANY MAKES A GOOD DAY"}</Text>
        <Text style={{ fontFamily: FF.pf7, fontSize: 18, color: P.deep }}>{doneN}<Text style={{ fontSize: 11, opacity: 0.6 }}>{` / ${totalN}`}</Text></Text>
      </View>
    </FlightSpot>
  );
}

function Mark({ paper, c, title }: { paper: Paper4; c: { stamp: string }; title: string }) {
  const { P } = useSkin();
  if (paper === "train") return (
    <>
      {[22, 62].map((t) => <View key={t} style={{ position: "absolute", left: 22, top: t, width: 18, height: 18, borderRadius: 9, backgroundColor: P.bg, borderTopWidth: 2, borderTopColor: "rgba(0,0,0,0.25)" }} />)}
    </>
  );
  if (paper === "walk") return (
    <Svg style={{ position: "absolute", left: 6, top: 20 }} width={60} height={60} viewBox="0 0 60 60">
      <Path d="M30 50 C 8 34, 10 14, 30 24 C 50 14, 52 34, 30 50Z" fill="none" stroke={c.stamp} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  );
  const txt = paper === "dinner" ? "BON APPÉTIT · TABLE FOR TWO · " : paper === "shop" ? "THANK YOU · FOR TWO · " : `ADMITTED · ${title.toUpperCase()} · `;
  return <SvgBox xml={stampXml(txt, "", c.stamp, 76)} w={76} h={76} style={{ left: -8, top: 12, opacity: 0.9, transform: [{ rotate: paper === "dinner" ? "12deg" : paper === "shop" ? "-8deg" : "-14deg" }] }} />;
}

function Seg({ s, i, st, P, skin, clue, photo, title, over, onPress, onClue, onPhoto }: {
  s: Stop; i: number; title: string; over: boolean; st: StopState; P: Skin; skin: SkinKey; clue: boolean; photo: "kept" | "skip" | null;
  onPress: () => boolean; onClue: () => void; onPhoto: () => void;
}) {
  const y = HEAD + SEG * i, hidden = !s.place, locked = st === "locked" || st === "skipped", c = segC(skin, i), paper = paperOf(s);
  const shake = useSharedValue(0);
  const shakeSt = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const press = () => { if (!onPress()) shake.value = withSequence(withTiming(-5, { duration: 80 }), withTiming(5, { duration: 80 }), withTiming(0, { duration: 80 })); };
  const sub = st === "skipped" ? (s.skip_reason ? `跳过了：${s.skip_reason}` : "跳过了") : st === "done" ? "Checked in." : over ? "" : hidden ? (clue ? `线索：${s.clue ?? ""}` : `Opens at ${s.time ?? ""}`) : st === "now" ? "Your ticket is ready." : `Opens at ${s.time ?? ""}`;
  return (
    <Animated.View style={[{ position: "absolute", left: 0, top: y, width: W, height: SEG, opacity: st === "skipped" ? 0.45 : 1 }, shakeSt]}>
      <Pressable onPress={press} style={{ flex: 1 }} accessibilityLabel={`第 ${i + 1} 站`}>
        {st === "now" ? <NowGlow color={P.big.c} /> : null}
        <Text style={{ position: "absolute", left: 16, top: 20, fontFamily: FF.pf9, fontSize: 30, color: locked && hidden ? rgba(P.sh, 0.32) : P.deep }}>{two(i)}</Text>
        <Text style={{ position: "absolute", left: 18, top: 58, width: 56, fontFamily: FF.pf7, fontSize: 6.5, lineHeight: 10.4, letterSpacing: 1.4, color: P.ink, opacity: 0.7 }}>{kindLineNarrow(s)}</Text>
        <View style={{ position: "absolute", left: 80, top: 18, width: 172 }}>
          <Text style={{ fontFamily: FF.pf7, fontSize: 21, lineHeight: 22, color: P.ink }}>{s.time ?? "—"}</Text>
          <Text numberOfLines={1} style={{ marginTop: 6, fontFamily: FF.serif7, fontSize: 14, lineHeight: 19, letterSpacing: hidden ? 7 : 0.6, color: hidden ? rgba(P.sh, 0.42) : P.ink }}>{hidden ? "? ? ?" : placeName(s)}</Text>
          <Text numberOfLines={1} style={{ marginTop: 5, fontFamily: hidden && clue ? FF.serif5 : FF.pf7I, fontSize: hidden && clue ? 12 : 11, lineHeight: 15, color: P.deep }}>{sub}</Text>
        </View>
        {hidden && !clue && s.clue ? (
          <View style={{ position: "absolute", left: 200, top: 80 }}>
            <DotLink onPress={onClue} color={P.deep} label="看线索" style={{ fontFamily: FF.serif5, fontSize: 10.5, letterSpacing: 1.3 }}>线索 ›</DotLink>
          </View>
        ) : null}
        {st === "now" ? (
          <View style={{ position: "absolute", left: 200, top: 80 }}>
            <FoilLine w={42} h={15} />
            <Text style={{ position: "absolute", left: 0, width: 42, top: 3, textAlign: "center", fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: "#5A3F12" }}>NOW</Text>
          </View>
        ) : null}
        <Dots h={SEG - 20} color={rgba(P.sh, 0.35)} style={{ left: SX, top: 10 }} />
        <View style={{ position: "absolute", left: SX + 9, right: 9, top: 10, bottom: 10, overflow: "hidden", backgroundColor: locked && hidden ? undefined : c.bg }}>
          {locked && hidden ? (
            <>
              {/* 还没到的站:盖一枚封存章 */}
              <SvgBox xml={stampXml(`SEALED · ${s.time ?? ""} · SEALED · `, "", P.deep, 56)} w={56} h={56} style={{ left: 34 - 28, top: 46 - 28 - 4, opacity: 0.8, transform: [{ rotate: `${i % 2 ? 9 : -11}deg` }] }} />
            </>
          ) : <StopArt s={s} color={c.art} inv style={{ left: -14, right: -14, top: -14, height: 120 }} />}
        </View>
        {(st === "done" || over) && st !== "skipped" ? (
          <>
            {st === "done" ? <View style={{ position: "absolute", left: SX - 4, top: 0, width: 88, height: SEG }} pointerEvents="none"><Mark paper={paper} c={c} title={title} /></View> : null}
            <View style={{ position: "absolute", left: 152, top: 70 }}>
              <DotLink onPress={photo ? undefined : onPhoto} plain={!!photo} color={P.deep} label="放一张照片" style={{ fontFamily: FF.serif5, fontSize: 10.5, letterSpacing: 1.3 }}>
                {photo === "kept" ? "照片已封好 ♥" : photo === "skip" ? "这一站没放照片" : "放一张照片 ›"}
              </DotLink>
            </View>
          </>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

/** 当前这一格:底色亮起 + 一圈白边呼吸(原型 .seg.now::after segGlow 2.4s) */
export function LoadErr({ P, msg }: { P: Skin; msg: string }) {
  return <Text style={{ position: "absolute", left: 30, right: 30, top: 300, textAlign: "center", fontFamily: FF.serif5, fontSize: 13, color: P.ink, opacity: 0.7 }}>{`没拉到 · ${msg}`}</Text>;
}

function NowGlow({ color }: { color: string }) {
  const g = useSharedValue(0);
  useEffect(() => { g.value = withRepeat(withTiming(1, { duration: 1200 }), -1, true); }, [g]);
  const st = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * g.value }));
  return (
    <>
      <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: color, opacity: 0.75 }} />
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.7)" }, st]} />
    </>
  );
}

/** How tall the ticket sheet needs to be for each paper: the sheet's top (58) + the ticket's foot, with a little room
 *  (cinema: the stub at the foot, 18 + 690; shop 18 + 620; dinner 30 + 470; train 40 + 420; walk 20 + 400 and his note) */
const TICKET_NEED: Record<Paper4, number> = { cinema: 770, shop: 700, dinner: 562, train: 522, walk: 600 };
/** The sheet's need: the paper's, or lower when his note reaches further down (noteFoot: its foot in the ticket box). */
export const ticketNeed = (p: Paper4, noteFoot = 0) => Math.max(TICKET_NEED[p], noteFoot ? 58 + noteFoot + 16 : 0);
/** The ticket on a shorter screen is scaled to show whole, his note included (1 = it fits). Pure, tested. */
export const ticketFit = (H: number, p: Paper4, noteFoot = 0) => Math.min(1, H / ticketNeed(p, noteFoot));

function TicketSheet({ plan, i, done, P, skin, onClose, onCheck }: { plan: Plan; i: number; done: boolean; P: Skin; skin: SkinKey; onClose: () => void; onCheck: () => void }) {
  const { s: sc, top, H } = useStage();
  const t = useSharedValue(0);
  useEffect(() => { t.value = withTiming(1, calm()); }, [t]);
  const st = useAnimatedStyle(() => ({ opacity: Math.min(1, t.value * 1.5), transform: [{ translateY: 60 * (1 - t.value) }, { scale: 0.9 + 0.1 * t.value }] }));
  const s = plan.stops[i];
  const [noteFoot, setNoteFoot] = useState(0);
  const paper = paperOf(s);
  return (
    <TicketFoot.Provider value={setNoteFoot}>
    <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 40 }}>
      <Pressable onPress={onClose} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.45) }} accessibilityLabel="收起" />
      <View style={{ position: "absolute", left: 0, top, width: 390, height: H, transform: [{ scale: sc }], transformOrigin: "top left" }} pointerEvents="box-none">
        {/* 矮屏(手机浏览器带着工具栏)整张票缩到放得下,不滚:电影票的副券在票脚、要往下撕,
            放在滚动页里既看不到也撕不动(手指往下拖被页面拿去滚) */}
        <View testID="ticket-fit" style={{ position: "absolute", left: 0, top: 0, width: 390, height: Math.max(H, ticketNeed(paper, noteFoot)), transform: [{ scale: ticketFit(H, paper, noteFoot) }], transformOrigin: "top center" }} pointerEvents="box-none">
          <Animated.View style={[{ position: "absolute", left: 34, top: 58, width: 322, height: 690 }, st]} pointerEvents="box-none">
            <Ticket plan={plan} s={s} i={i} done={done} P={P} skin={skin} onCheck={onCheck} paper={paper} />
          </Animated.View>
        </View>
        <Pressable onPress={onClose} style={{ position: "absolute", right: 14, top: 52, width: 40, height: 40, alignItems: "center", justifyContent: "center" }} accessibilityLabel="关上">
          <Text style={{ fontFamily: FF.pf, fontSize: 30, color: "#fff" }}>×</Text>
        </Pressable>
      </View>
    </View>
    </TicketFoot.Provider>
  );
}
