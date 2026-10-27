// Ephemera 电报列表(原型没有这一页,派单范围内新加):信封与电报一张张按时间排,新的在上;
// 纸样=电报纸(TelegramCard),点开跳到那次约会对应的那一页。
// 打开这页即把看到的标已读(引擎 events/read)。
import { type Href, useRouter } from "../../nav/router";
import { useFocusEffect } from "../../nav/router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { DateEventCard, type DatePlanBrief } from "./TelegramCard";
import { type DateEvent, ephemeraApi, type Plan } from "../../lib/ephemeraApi";
import { onResume } from "../../runtime/host";
import { tzOffset } from "../../lib/tz";
import { BackKey, NavBar, Stage, useStage } from "./components";
import { eventHref, nextPlan, useSkin } from "./store";
import { FF } from "./theme";

const dayOf = (sec: number) => { const d = new Date((sec + tzOffset(sec)) * 1000); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };

export function EphemeraTelegramsScreen() {
  const router = useRouter();
  const { P } = useSkin();
  const { body } = useStage();
  const [events, setEvents] = useState<DateEvent[] | null>(null);
  const [plans, setPlans] = useState<Map<number, Plan>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [next, setNext] = useState<Plan | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => onResume(() => setGen((n) => n + 1)), []);   // events missed while in the background
  useFocusEffect(useCallback(() => {
    let alive = true;
    (async () => {
      try {
        const [evs, list] = await Promise.all([ephemeraApi.events(), ephemeraApi.plans()]);
        const m = new Map(list.map((p) => [p.id, p]));
        // 取消的约会不在列表里,按 id 补取(电报还要写约会名)
        for (const id of new Set(evs.map((e) => e.plan_id))) if (!m.has(id)) { try { m.set(id, await ephemeraApi.plan(id)); } catch { /* 拿不到就只显正文 */ } }
        if (!alive) return;
        setEvents([...evs].reverse()); setPlans(m); setNext(nextPlan(list)); setErr(null);
        const unread = evs.filter((e) => e.read_at == null).map((e) => e.id);
        if (unread.length) ephemeraApi.markRead(unread).then(() => {
          if (alive) setEvents((cur) => cur && cur.map((e) => (unread.includes(e.id) ? { ...e, read_at: Date.now() / 1000 } : e)));
        }).catch(() => {});
      } catch (e) { if (alive) setErr((e as Error).message); }
    })();
    return () => { alive = false; };
  }, [gen]));

  const open = async (ev: DateEvent) => {
    const h = await eventHref(ev, plans.get(ev.plan_id));
    if (h) router.push(h);
  };

  let lastDay = "";
  return (
    <Stage P={P} overlay={<NavBar on="Home" below P={P} dateHref={next ? (`/ephemera-day?id=${next.id}` as Href) : null} />}>
      <BackKey color={P.deep} top={40} onPress={() => router.back()} />
      <Text style={{ position: "absolute", left: 48, top: 44, fontFamily: FF.pf9, fontSize: 38, color: P.deep }}>Telegrams</Text>
      <ScrollView style={{ position: "absolute", left: 0, top: 104, width: 390, height: body - 104 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {err ? <Text style={{ marginTop: 20, fontFamily: FF.serif5, fontSize: 12, color: P.ink, opacity: 0.7 }}>没拉到 · {err}</Text> : null}
        {events && !events.length ? <Text style={{ marginTop: 30, fontFamily: FF.script, paddingRight: 8, fontSize: 26, color: P.deep, opacity: 0.6 }}>No telegrams yet</Text> : null}
        {(events ?? []).map((ev) => {
          const d = dayOf(ev.created_at), head = d !== lastDay;
          lastDay = d;
          const p = plans.get(ev.plan_id);
          const brief: DatePlanBrief | undefined = p ? { id: p.id, paper_no: p.paper_no, title_en: p.title_en, date: p.date } : undefined;
          return (
            <View key={ev.id}>
              {head ? <Text style={{ marginTop: 14, marginBottom: 2, textAlign: "right", fontFamily: FF.monoR, fontSize: 9, color: P.ink, opacity: 0.5 }}>{d}</Text> : null}
              <DateEventCard ev={ev} plan={brief} onOpen={() => open(ev)} />
            </View>
          );
        })}
      </ScrollView>
    </Stage>
  );
}
