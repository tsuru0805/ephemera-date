// Ephemera ① 首页(原型 home()):上面一张下一次约会的大票 + 一排历史票根(各是各的颜色)
// + Hidden Plans 一信封一纸包。
// 「把约会做成……」副标题已删。
import { type Href, useFocusEffect, useRouter } from "../../nav/router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Plan } from "../../lib/ephemeraApi";
import { TILT_DEPTHS } from "./aliveHome";
import { Art, Caps, FitLine, FoilText, GoldFrame, NAV_H, NavBar, Paper, Stage, Svg, Tilt, TiltProvider, useStage } from "./components";
import { ART_OF, dateParts, kindOf, paperNo, quoteParts, titleLines } from "./format";
import { mainKind } from "./icons";
import { perf, bigTicket, stampXml } from "./shapes";
import { keptPlans, nextPlan, syncOpened, usePlan, usePlans, usePreparing, useSkin } from "./store";
import { HiddenPlans } from "./HiddenPlans";
import { ScrapPage, ScrapRow } from "./EmptyHome";
import { PrepCard } from "./PrepCard";
import { DRAFT_ROW_H, DraftPage, DraftRow } from "./Preparing";
import { PrepPop } from "./SealScreen";
import { FF, planCol, rgba } from "./theme";
import { fly } from "./flight";

export function EphemeraHomeScreen() {
  const router = useRouter();
  const { P } = useSkin();
  const { plans, error } = usePlans();
  const { body } = useStage();
  const next = plans ? nextPlan(plans) : null;
  const kept = plans ? keptPlans(plans) : [];
  const unread = (plans ?? []).reduce((n, p) => n + (p.unread ?? 0), 0);
  const [opened, setOpened] = useState(false);
  // 纸包要她在这次约会上打过的勾;没有下一次约会时传 NaN,store 不发请求
  const cur = usePlan(next ? next.id : NaN);
  const curPlan = next && cur.plan?.id === next.id ? cur.plan : null;
  const [prep, setPrep] = useState(false);
  // 准备中:他还在写的约会,只看得到进度;明信片=给他留一句话
  const drafts = usePreparing();
  const writing = drafts.items ?? [];
  const rowTop = 728 + 42 + 124 + 52;
  // 每次回到首页都重读(从请柬按返回回来时,拆过信封要算数,不重播拆信封)
  // 引擎记下的也算(换手机);本机拆过引擎没记=补报一次
  useFocusEffect(useCallback(() => { if (next) syncOpened(next).then(setOpened); }, [next?.id, next?.opened_at])); // eslint-disable-line react-hooks/exhaustive-deps
  // 大请柬变信封(没拆)/ 变请柬(拆过)
  const openNext = () => next && fly(`bigT:${next.id}`, opened ? `invite:${next.id}` : `env:${next.id}`,
    () => router.push((opened ? `/ephemera-invite?id=${next.id}&m=1` : `/ephemera-seal?id=${next.id}&m=1`) as Href), { dur: 780, lift: 20 });
  const dateHref = next ? (`/ephemera-day?id=${next.id}` as Href) : null;

  return (
    <TiltProvider>
    <Stage P={P} overlay={<>
      <NavBar on="Home" P={P} dateHref={dateHref} />
      {prep && curPlan ? (
        <Pressable style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.4), zIndex: 45 }} onPress={() => setPrep(false)}>
          <PrepPop onClose={() => setPrep(false)}>
            <PrepCard plan={curPlan} her={cur.her} P={P} live onToggle={(k, on) => { cur.mark(k, on).catch(() => {}); }} />
          </PrepPop>
        </Pressable>
      ) : null}
    </>}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ width: 390, height: body }} contentContainerStyle={{ height: Math.max(894 + NAV_H + 64 + (next && writing.length ? DRAFT_ROW_H : 0), body) }} showsVerticalScrollIndicator={false}>
        <Text style={{ position: "absolute", left: 22, top: 44, fontFamily: FF.pf9, fontSize: 48, lineHeight: 46, color: P.deep, letterSpacing: -0.5 }}>Invitation Box</Text>
        <Text style={{ position: "absolute", left: 26, top: 100, fontFamily: FF.script, paddingRight: 8, fontSize: 19, color: P.deep }}>Good dates, better people</Text>
        <View style={{ position: "absolute", left: 232, top: 112, width: 136, height: 1, backgroundColor: P.deep, opacity: 0.6 }} />

        {next ? <BigTicket plan={next} onOpen={openNext} /> : error ? (
          <View style={{ position: "absolute", left: 16, top: 140, width: 360, height: 300, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontFamily: FF.serif5, fontSize: 12, color: P.ink, opacity: 0.7 }}>没拉到 · {error}</Text>
          </View>
        ) : plans ? (writing.length ? <DraftPage items={writing} onSend={(id, t) => drafts.note(id, t)} error={drafts.error} /> : <>
          <ScrapPage />
          {drafts.error ? <Text style={{ position: "absolute", left: 30, top: 440, fontFamily: FF.serif5, fontSize: 11, color: P.ink, opacity: 0.7 }}>准备中的约会没拉到 · {drafts.error}</Text> : null}
        </>) : null}

        <Text style={{ position: "absolute", left: 22, top: 470, fontFamily: FF.pf7, fontSize: 20, color: P.deep }}>Past Collections</Text>
        <View style={{ position: "absolute", left: 182, top: 484, width: 40, height: 1, backgroundColor: P.deep }} />
        <Pressable onPress={() => router.push("/ephemera-shelf" as Href)} hitSlop={8} style={{ position: "absolute", right: 22, top: 480 }}>
          <Text style={{ fontFamily: FF.corm6, fontSize: 10, letterSpacing: 2.6, color: P.ink, opacity: 0.8 }}>SEE ALL ›</Text>
        </Pressable>
        {plans && !kept.length ? <ScrapRow /> : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ position: "absolute", left: 0, top: 520, width: 390, height: 240 }} contentContainerStyle={{ width: 16 + kept.length * 112 + 8, height: 220 }}>
          {kept.map((p, k) => <PastTicket key={p.id} plan={p} k={k} onPress={() => fly(`stamp:${p.id}`, `box:${p.id}`, () => router.push(`/ephemera-box?id=${p.id}&m=1&from=stamp` as Href), { dur: 820, lift: 30 })} />)}
        </ScrollView>

        <HiddenPlans P={P} top={728} plan={curPlan} her={cur.her} unread={unread}
          onTelegrams={() => router.push("/ephemera-telegrams" as Href)} onPrep={() => setPrep(true)} />
        {next && writing.length ? <DraftRow items={writing} onSend={(id, t) => drafts.note(id, t)} top={rowTop} error={drafts.error} /> : null}
        {next && !writing.length && drafts.error ? (
          <Text style={{ position: "absolute", left: 22, top: rowTop, fontFamily: FF.serif5, fontSize: 11, color: P.ink, opacity: 0.7 }}>准备中的约会没拉到 · {drafts.error}</Text>
        ) : null}
      </ScrollView>
    </Stage>
    </TiltProvider>
  );
}

function BigTicket({ plan, onOpen }: { plan: Plan; onOpen: () => void }) {
  const { P } = useSkin();
  const B = P.big, bw = 360, bh = 300;
  const [t1, t2] = titleLines(plan);
  const dp = dateParts(plan.date);
  const first = plan.stops[0];
  return (
    // 手机倾斜,大请柬跟着纸片远近错开一点(原型 DEPTH 量级,比纸堆里的纸更稳一点)
    <Tilt depth={8} flight={`bigT:${plan.id}`} style={{ position: "absolute", left: 16, top: 140, width: bw, height: bh }}>
    <Pressable onPress={onOpen} style={{ width: bw, height: bh }} accessibilityLabel="打开邀请">
      <Paper w={bw} h={bh} d={bigTicket(bw, bh)} fill={B.c} sh={P.sh} edge />
      <Paper w={14} h={bh} d={bigTicket(bw, bh)} fill={B.l} sh={P.sh} shadow="none" texture={0} style={{ opacity: 0.9, overflow: "hidden" }} />
      <GoldFrame x={24} y={10} w={bw - 34} h={bh - 20} />
      <Caps color={B.l} style={{ position: "absolute", left: 36, top: 24, lineHeight: 13.6 }}>{"A SPECIAL EVENING\nJUST FOR US"}</Caps>
      {/* 右边 214 起是画框:名字每行宽到 206 为止,放不下按比例缩、到下限截短 */}
      <View style={{ position: "absolute", left: 34, top: 64, width: 214 - 34 - 8 }}>
        {[t1, t2].filter(Boolean).map((t, q) => <FitLine key={q} style={{ fontFamily: FF.pf9, fontSize: 29, lineHeight: 28, color: B.l, letterSpacing: -0.3 }}>{t}</FitLine>)}
      </View>
      <Text style={{ position: "absolute", left: 36, top: 142, fontFamily: FF.pf7I, fontSize: 13, color: B.l }}>A private date invitation</Text>
      <View style={{ position: "absolute", left: 36, top: 168, width: 156, height: 1, backgroundColor: B.l }} />
      <View style={{ position: "absolute", left: 36, top: 176 }}>
        <Caps color={B.l}>Date</Caps>
        <Text style={{ fontFamily: FF.pf7, fontSize: 22, color: B.l, marginTop: 2 }}>{dp.slash}</Text>
      </View>
      <View style={{ position: "absolute", left: 114, top: 176, borderLeftWidth: 1, borderLeftColor: B.l, paddingLeft: 12 }}>
        <Caps color={B.l}>Time</Caps>
        <Text style={{ fontFamily: FF.pf7, fontSize: 22, color: B.l, marginTop: 2 }}>{first?.time ?? "—"}</Text>
      </View>
      <View style={{ position: "absolute", left: 214, top: 26, width: 128, height: 190, backgroundColor: B.panel, overflow: "hidden" }}>
        <Art name="sc_tonight" color={B.art} inv style={{ left: -46, top: 0, width: 226, height: 190 }} />
      </View>
      <FoilText text={`No. ${paperNo(plan)}`} size={10.5} style={{ position: "absolute", left: 220, top: 32 }} />
      <Svg xml={stampXml("SEALED · FOR A BETTER TOMORROW · ", "", B.l, 74)} w={74} h={74} style={{ left: 286, top: 168, transform: [{ rotate: "-14deg" }] }} />
      <Pressable onPress={onOpen} style={{ position: "absolute", left: 40, right: 30, top: 234, height: 44, borderRadius: 22, backgroundColor: B.l, alignItems: "center", justifyContent: "center",
        borderWidth: 1.5, borderColor: P.bg, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 8 } }}>
        <Text style={{ fontFamily: FF.pf7I, fontSize: 16, letterSpacing: 0.6, color: "#fff" }}>Open Invitation  →</Text>
      </Pressable>
    </Pressable>
    </Tilt>
  );
}

function PastTicket({ plan, k, onPress }: { plan: Plan; k: number; onPress: () => void }) {
  const { P } = useSkin();
  const c = planCol(plan.color), w = 102, h = 184, x = 16 + k * 112;
  const [t1, t2] = titleLines(plan);
  const dp = dateParts(plan.date);
  const tag = quoteParts(plan.quote);
  const art = ART_OF[mainKind(plan.stops.map(kindOf))];
  return (
    // 手机倾斜,历史票根跟着错开(每张深度不同,错落感用 k 取 TILT_DEPTHS 的不同下标)
    <Tilt depth={TILT_DEPTHS[k % TILT_DEPTHS.length]} flight={`stamp:${plan.id}`} style={{ position: "absolute", left: x, top: 4, width: w, height: h }}>
    <Pressable onPress={onPress} style={{ width: w, height: h }} accessibilityLabel={`${t1} ${t2}`}>
      <Paper w={w} h={h} d={perf(w, h)} fill={c.c} sh={P.sh} />
      <View style={{ position: "absolute", left: 8, top: 8, right: 8, bottom: 8, borderWidth: 1, borderColor: c.t, opacity: 0.85 }} />
      <FoilText text={`No. ${paperNo(plan)}`} size={9} width={w} align="center" style={{ position: "absolute", left: 0, top: 13 }} />
      <View style={{ position: "absolute", left: 10, right: 10, top: 27 }}>
        {[t1, t2].filter(Boolean).map((t, q) => <FitLine key={q} style={{ textAlign: "center", fontFamily: FF.pf7I, fontSize: 17, lineHeight: 16, color: c.t }}>{t}</FitLine>)}
      </View>
      <View style={{ position: "absolute", left: 12, right: 12, top: 66, height: 76, overflow: "hidden", backgroundColor: c.inv ? c.panel : undefined }}>
        <Art name={art} color={c.art} inv={c.inv} style={{ left: -6, right: -6, top: -22, height: 118 }} />
      </View>
      <Text numberOfLines={2} style={{ position: "absolute", left: 6, right: 6, top: 148, textAlign: "center", fontFamily: FF.pf7, fontSize: 6.5, lineHeight: 9.8, letterSpacing: 1, color: c.t }}>
        {tag.slice(0, 2).join("\n").toUpperCase()}
      </Text>
      <Text style={[{ position: "absolute", left: 0, right: 0, top: 168, textAlign: "center", fontFamily: FF.mono, fontSize: 9, color: c.t }]}>{`${dp.slash} / ${dp.y}`}</Text>
    </Pressable>
    </Tilt>
  );
}

