// Ephemera ⑨ 地图页(原型 openMap v3):
// OpenStreetMap 真实矢量分层上色(陆地/街道三级/河/公园/铁路,不用整体滤镜);可拖动、双指缩放、回到路线;
// 路线=真实路网最短路(步行)+ 沿铁轨(电车),走过实线 / 接下来点线 / 电车虚线,未公开不画;编号章 + 平涂小图标(自动避让);
// 顶部 Ephemera / 编号 / 日期 + 邮戳;票根带(站数 + 里程 + 图例);当前站大票 + 其余站可展开票券。配色跟 Me 页皮肤整套换。
// 地图数据由引擎在服务器本地算(date_map.py),不把约会地点发给外部。
import { useLocalSearchParams, useRouter } from "../../nav/router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { openExternal } from "../../runtime/external";
import { tzOffset } from "../../lib/tz";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import Svg, { G, Path, Rect, SvgXml } from "react-native-svg";
import { type EphemeraError, ephemeraApi, type MapData, type Plan, type Stop } from "../../lib/ephemeraApi";
import { BackKey, Stage } from "./components";
import { LoadErr } from "./DayScreen";
import { addressOf, dateParts, hasPlace, kindOf, legLine, paperNo, placeName, titleOne, walkKmText } from "./format";
import { kindLine, kindZhLine } from "./kinds";
import { icon } from "./icons";
import { esc, sideNotch } from "./shapes";
import { mapState, type MapState } from "./mapState";
import { has, usePlan, useSkin } from "./store";
import { alpha, FF, ff, type MapPal } from "./theme";

const MW = 362, MH = 430;
type Full = Exclude<MapData, { empty: true }>;
type View_ = { s: number; tx: number; ty: number };

export function EphemeraMapScreen() {
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const router = useRouter();
  const { P, M } = useSkin();
  const { plan, her, now, error } = usePlan(id, { poll: true });
  const [map, setMap] = useState<MapData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const placesKey = plan ? plan.stops.map((s) => (s.place ? `${s.place.lat},${s.place.lng}` : "-")).join("|") : "";
  useEffect(() => {
    if (!plan) return;
    ephemeraApi.map(plan.id).then((m) => { setMap(m); setErr(null); }).catch((e: EphemeraError) => {
      console.warn("[ephemera] map", e.code, e.message);   // the engine's own words (setup hints) go to the log only
      setErr(mapErrorText(e.code));
    });
  }, [plan?.id, placesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!plan) return <Stage P={P} bg={M.page}><BackKey color={M.route} top={34} onPress={() => router.back()} />{error ? <LoadErr P={P} msg={error} /> : null}</Stage>;
  const nowSec = now();
  const st = mapState(plan, nowSec);
  const focus = st.next >= 0 && st.vis[st.next] ? st.next : st.here >= 0 ? st.here : 0;
  const dp = dateParts(plan.date);
  const book = plan.prep.filter((p) => p.section === "book").map((p) => `${p.text}${p.detail ? `（${p.detail}）` : ""}`).join(" · ");
  const checked = (s: Stop) => has(her, `checkin:${s.stop_id}`);
  const full = map && !map.empty ? (map as Full) : null;
  const walkKm = full ? walkKmText(full) : null;

  return (
    <Stage P={P} bg={M.page}>
      <ScrollView style={{ width: 390, height: "100%" }} contentContainerStyle={{ paddingTop: 34, paddingHorizontal: 14, paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        {/* 抬头 */}
        <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: M.ink, borderBottomWidth: 0.6, borderBottomColor: alpha(M.ink, 0.45), paddingVertical: 9 }}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ width: 26 }} accessibilityLabel="返回"><Text style={{ fontFamily: FF.pf, fontSize: 26, lineHeight: 28, color: M.route }}>‹</Text></Pressable>
          <View style={{ flex: 1.25, paddingLeft: 10, borderLeftWidth: 0.6, borderLeftColor: alpha(M.ink, 0.35) }}>
            <Text style={{ fontFamily: FF.pf7, fontSize: 19, color: M.title }}>Ephemera</Text>
            <Text style={{ marginTop: 4, fontFamily: FF.pf7, fontSize: 6.5, lineHeight: 10.4, letterSpacing: 1.4, color: M.ink, opacity: 0.8 }}>{"A COLLECTION\nOF OUR DATES"}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 8, paddingLeft: 10, borderLeftWidth: 0.6, borderLeftColor: alpha(M.ink, 0.35) }}>
            <Text style={{ fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.4, color: M.ink, opacity: 0.8 }}>DATE MAP</Text>
            <Text style={{ marginVertical: 3, fontFamily: FF.pf7, fontSize: 15, color: M.ink }}>{`No. ${paperNo(plan)}`}</Text>
          </View>
          <View style={{ flex: 0.8, marginLeft: 8, paddingLeft: 10, borderLeftWidth: 0.6, borderLeftColor: alpha(M.ink, 0.35) }}>
            <Text style={{ fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.4, color: M.ink, opacity: 0.8 }}>{dp.y}</Text>
            <Text style={{ marginVertical: 3, fontFamily: FF.pf7, fontSize: 15, color: M.ink }}>{`${dp.mm}/${dp.dd}`}</Text>
            <Text style={{ fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.4, color: M.ink, opacity: 0.8 }}>{dp.dow.toUpperCase()}</Text>
          </View>
        </View>
        {/* 标题 + 邮戳 */}
        {/* 右边让出邮戳的整宽(邮戳 132 宽、右 -6 → 占 126;原来只让 92,名字稍长就压到邮戳上) */}
        <View style={{ paddingTop: 14, paddingBottom: 12, paddingRight: 130, borderBottomWidth: 0.6, borderBottomColor: alpha(M.ink, 0.35) }}>
          <Text style={{ fontFamily: FF.pf9, fontSize: 31, lineHeight: 33, letterSpacing: -0.6, color: M.title }}>{titleOne(plan)}</Text>
          <View style={{ position: "absolute", right: -6, top: 6, width: 132, height: 88, opacity: 0.78 }} pointerEvents="none">
            <SvgXml xml={postmark(M, full?.area ?? null, dp.mon.toUpperCase(), String(dp.d), dp.y, full?.basemap ?? null)} width={132} height={88} />
          </View>
        </View>
        {/* 地图 */}
        <View style={{ marginTop: 12, width: MW, height: MH, borderWidth: 1, borderColor: M.ink, backgroundColor: M.land, overflow: "hidden" }}>
          {full ? <MapBox data={full} plan={plan} st={st} M={M} /> : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontFamily: FF.pf7I, fontSize: 13, color: M.ink, opacity: 0.6 }}>{err ? err : map?.empty ? emptyMapLabel(st) : "…"}</Text>
            </View>
          )}
          <View style={{ position: "absolute", left: -2, top: 6, width: 22, height: 44, opacity: 0.9 }} pointerEvents="none"><SvgXml xml={icon("tulip", M)} width={22} height={44} /></View>
          <Text style={{ position: "absolute", right: 10, bottom: 34, fontFamily: ff(map?.attribution, FF.pf, FF.serif), fontSize: 6, color: M.ink, opacity: 0.5 }} pointerEvents="none">{map?.attribution || "© OpenStreetMap contributors"}</Text>
        </View>
        {/* public stops the map could not draw, each with the engine's reason (coordinates not storable, lookup failed …) */}
        {full?.unplotted?.length ? (
          <View testID="map-unplotted" style={{ marginTop: 8, gap: 3 }}>
            {full.unplotted.map((u) => (
              <Text key={u.n} style={{ fontFamily: FF.serif5, fontSize: 10, lineHeight: 15, color: M.ink, opacity: 0.7 }}>{`第 ${u.n} 站没画在地图上${u.text ? ` · ${u.text}` : ""}`}</Text>
            ))}
          </View>
        ) : null}
        {/* 票根带 */}
        <Band plan={plan} M={M} walkKm={walkKm} transit={full?.stats.transit_legs ?? 0} />
        {/* 当前站 + 全部站点 */}
        {/* 结束了的约会没有「现在 / 下一站」:不出当前站那一块,全部站点按顺序列(状态都是已完成) */}
        {st.over ? null : <>
          <Text testID="map-now-label" style={{ marginBottom: 8, fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 1.8, color: M.title }}>{mapNowLabel(st)}</Text>
          <MapTicket s={plan.stops[focus]} i={focus} st={st} M={M} big checked={checked(plan.stops[focus])} />
        </>}
        <Text style={{ marginTop: st.over ? 0 : 18, marginBottom: 8, fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 1.8, color: M.title }}>ALL STOPS · 全部站点</Text>
        {plan.stops.map((s, i) => !st.over && i === focus ? null : (
          <MapTicket key={s.stop_id} s={s} i={i} st={st} M={M} open={open === i} checked={checked(s)} onPress={() => setOpen(open === i ? null : i)} />
        ))}
        {book ? (
          <Text style={{ marginTop: 14, paddingTop: 10, borderTopWidth: 0.6, borderTopColor: alpha(M.ink, 0.35), fontFamily: FF.serif, fontSize: 10, lineHeight: 17, color: M.ink, opacity: 0.65 }}>{`提前准备：${book}`}</Text>
        ) : null}
      </ScrollView>
    </Stage>
  );
}

/** What she sees when the map cannot be drawn (no base map built for the area, map off, anything else). */
export const MAP_ERR = {
  no_basemap: "这一带的地图还没准备好，地点和路线照常能看",
  not_configured: "地图没有打开，地点和路线照常能看",
  other: "地图暂时打不开，地点和路线照常能看",
} as const;
export const mapErrorText = (code?: string) => (code === "no_basemap" ? MAP_ERR.no_basemap : code === "not_configured" ? MAP_ERR.not_configured : MAP_ERR.other);

function postmark(M: MapPal, area: string | null, mon: string, day: string, y: number, city: string | null): string {
  const waves = [0, 1, 2, 3].map((k) => `<path d="M2 ${35 + k * 9} q6 -4 12 0 t12 0 t12 0 t12 0 t12 0"/>`).join("");
  return `<svg viewBox="0 0 150 100"><g fill="none" stroke="${M.title}" stroke-width="1.6" stroke-linecap="round">${waves}</g>
    <g transform="translate(98 50) rotate(-9)">
      <circle r="42" fill="${M.page}" stroke="${M.title}" stroke-width="2.2"/><circle r="36.5" fill="none" stroke="${M.title}" stroke-width=".9"/><circle r="23" fill="none" stroke="${M.title}" stroke-width=".9"/>
      <defs><path id="pmT" d="M-30 0 a30 30 0 1 1 60 0"/><path id="pmB" d="M-30.5 0 a30.5 30.5 0 1 0 61 0"/></defs>
      ${area ? `<text font-family="EphemeraDisplay-Bold" font-size="7.6" letter-spacing="1.6" fill="${M.title}" text-anchor="middle"><textPath href="#pmT" startOffset="50%">${esc(area)}</textPath></text>` : ""}
      <text font-family="EphemeraDisplay-Bold" font-size="7.6" letter-spacing="2.4" fill="${M.title}" text-anchor="middle" dy="6.5"><textPath href="#pmB" startOffset="50%">${city ? `${esc(city.toUpperCase())} · ` : ""}${y}</textPath></text>
      <text y="-4" text-anchor="middle" font-family="EphemeraDisplay-Bold" font-size="7" letter-spacing="2" fill="${M.title}">${mon}</text>
      <text y="13" text-anchor="middle" font-family="EphemeraDisplay-Black" font-size="19" fill="${M.title}">${day}</text>
      <circle cx="-33" cy="0" r="1.6" fill="${M.title}"/><circle cx="33" cy="0" r="1.6" fill="${M.title}"/></g></svg>`;
}

// ── 地图本体:拖动 / 双指缩放 / 回到路线 ────────────────────────────────────────────────
function clampV(v: View_, d: Full): View_ {
  const minS = Math.max(MW / d.W, MH / d.H);
  const s = Math.max(minS, Math.min(v.s, 2.2));
  const tx = Math.min(0, Math.max(MW - d.W * s, v.tx)), ty = Math.min(0, Math.max(MH - d.H * s, v.ty));
  return { s, tx, ty };
}
function homeView(d: Full): View_ {
  const pts: Array<[number, number]> = [];
  d.stops.forEach((s) => pts.push([s.x, s.y]));
  d.legs.forEach((l) => { if (l.n > 1) pts.push(...l.pts); });
  d.walk_paths.forEach((w) => pts.push(...w.pts));
  if (!pts.length) return clampV({ s: 0, tx: 0, ty: 0 }, d);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = 46;
  const s = Math.min((MW - pad * 2) / Math.max(x1 - x0, 300), (MH - pad * 2) / Math.max(y1 - y0, 300), 1.1);
  return clampV({ s, tx: MW / 2 - ((x0 + x1) / 2) * s, ty: MH / 2 - ((y0 + y1) / 2) * s }, d);
}

function MapBox({ data, plan, st, M }: { data: Full; plan: Plan; st: MapState; M: MapPal }) {
  const [v, setV] = useState<View_>(() => homeView(data));
  useEffect(() => { setV(homeView(data)); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const k = useSharedValue(1), fx = useSharedValue(0), fy = useSharedValue(0), dx = useSharedValue(0), dy = useSharedValue(0);
  const pinching = useSharedValue(0); // 双指时平移与缩放只在缩放结束时一起提交一次(两个 onEnd 都提交=缩放乘两遍)
  const commit = useCallback((kk: number, ffx: number, ffy: number, ddx: number, ddy: number) => {
    setV((o) => clampV({ s: o.s * kk, tx: ffx - (ffx - o.tx) * kk + ddx, ty: ffy - (ffy - o.ty) * kk + ddy }, data));
    k.value = 1; dx.value = 0; dy.value = 0; fx.value = 0; fy.value = 0;
  }, [data, k, dx, dy, fx, fy]);
  const gesture = useMemo(() => {
    const pan = Gesture.Pan().averageTouches(true)
      .onUpdate((e) => { dx.value = e.translationX; dy.value = e.translationY; })
      .onEnd(() => { if (pinching.value === 0) runOnJS(commit)(1, 0, 0, dx.value, dy.value); });
    const pinch = Gesture.Pinch()
      .onStart((e) => { pinching.value = 1; fx.value = e.focalX; fy.value = e.focalY; })
      .onUpdate((e) => { k.value = e.scale; })
      .onEnd(() => { runOnJS(commit)(k.value, fx.value, fy.value, dx.value, dy.value); })
      .onFinalize(() => { pinching.value = 0; });
    const dbl = Gesture.Tap().numberOfTaps(2).onEnd((e) => { runOnJS(commit)(1.6, e.x, e.y, 0, 0); });
    return Gesture.Race(dbl, Gesture.Simultaneous(pan, pinch));
  }, [commit, k, fx, fy, dx, dy, pinching]);
  const live = useAnimatedStyle(() => ({
    transform: [{ translateX: dx.value + fx.value }, { translateY: dy.value + fy.value }, { scale: k.value }, { translateX: -fx.value }, { translateY: -fy.value }],
  }));

  const L = data.layers, j = (a: string[]) => a.join("");
  const ns = "non-scaling-stroke" as const;
  const marks = useMemo(() => layoutMarks(data, plan, st, v), [data, plan, st, v]);
  const scaleM = [50, 100, 200, 250, 500, 1000, 2000].find((m) => m * v.s >= 46) ?? 2000;
  const cur = st.over ? -1 : st.next >= 0 && st.vis[st.next] ? st.next : st.here; // 结束了的约会没有「现在这站」,不画光圈
  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width: MW, height: MH }} collapsable={false}>
        <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: MW, height: MH }, live]}>
          <Svg width={MW} height={MH}>
            <G transform={`translate(${v.tx.toFixed(2)} ${v.ty.toFixed(2)}) scale(${v.s.toFixed(5)})`}>
              <Rect x={-400} y={-400} width={data.W + 800} height={data.H + 800} fill={M.land} />
              <Path d={j(L.park)} fill={M.park} fillRule="evenodd" />
              <Path d={j(L.water)} fill={M.water} fillRule="evenodd" />
              <Path d={j(L.river)} fill="none" stroke={M.water} strokeWidth={20} strokeLinecap="round" strokeLinejoin="round" />
              <Path d={j(L.tiny)} fill="none" stroke={M.street} strokeOpacity={0.5} strokeWidth={0.6} vectorEffect={ns} strokeLinecap="round" />
              <Path d={j(L.minor)} fill="none" stroke={M.street} strokeWidth={1.3} vectorEffect={ns} strokeLinecap="round" strokeLinejoin="round" />
              <Path d={j(L.major) + j(L.motor)} fill="none" stroke={M.street} strokeWidth={3.2} vectorEffect={ns} strokeLinecap="round" strokeLinejoin="round" />
              <Path d={j(L.major)} fill="none" stroke={M.land} strokeOpacity={0.7} strokeWidth={1} vectorEffect={ns} strokeLinecap="round" />
              <Path d={j(L.rail)} fill="none" stroke={M.ink} strokeOpacity={0.38} strokeWidth={1.4} strokeDasharray="4 2.5" vectorEffect={ns} />
              {/* ferry lines of the base map: the rail dash, in the water colour's ink */}
              {L.ferry?.length ? <Path d={j(L.ferry)} fill="none" stroke={M.ink} strokeOpacity={0.3} strokeWidth={1.2} strokeDasharray="4 2.5" vectorEffect={ns} /> : null}
              {[...data.legs.map((l) => ({ n: l.n, pts: l.pts, transit: l.kind === "transit" })), ...data.walk_paths.map((w) => ({ n: w.n, pts: w.pts, transit: false })),
                // a walk that crosses water by ferry: those pieces are drawn like a ride (the transit dash), over the walk
                ...data.legs.flatMap((l) => (l.ferry ?? []).map((x) => ({ n: l.n, pts: x.pts, transit: true })))].map((l, q) => {
                const d = "M" + l.pts.map(([x, y]) => `${x} ${y}`).join("L"), done = st.arrived[l.n - 1];
                return (
                  <G key={q}>
                    <Path d={d} fill="none" stroke={M.land} strokeWidth={6.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect={ns} />
                    {l.transit
                      ? <Path d={d} fill="none" stroke={M.ink} strokeWidth={2.6} strokeDasharray="7 3.5" strokeLinejoin="round" vectorEffect={ns} />
                      : <Path d={d} fill="none" stroke={M.route} strokeWidth={2.5} strokeDasharray={done ? undefined : "0.1 5.5"} strokeLinecap="round" strokeLinejoin="round" vectorEffect={ns} />}
                  </G>
                );
              })}
            </G>
          </Svg>
          {marks.map((m) => {
            const s = plan.stops[m.i];
            return (
              <View key={m.i} pointerEvents="none" style={{ position: "absolute", left: 0, top: 0 }}>
                <View style={{ position: "absolute", left: m.x - 9.5, top: m.y - 9.5, width: 19, height: 19, borderRadius: 10, backgroundColor: M.route, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: M.land }}>
                  <Text style={{ fontFamily: FF.pf7, fontSize: 10, lineHeight: 12, color: M.card }}>{m.i + 1}</Text>
                </View>
                {m.i === cur ? <Halo x={m.x} y={m.y} color={M.route} /> : null}
                <View style={{ position: "absolute", left: m.ic[0], top: m.ic[1], width: 30, height: 30 }}><SvgXml xml={icon(kindOf(s), M)} width={30} height={30} /></View>
                <View style={{ position: "absolute", left: m.tx[0], top: m.tx[1], width: m.tx[2] - m.tx[0], alignItems: m.right ? "flex-end" : "flex-start" }}>
                  <Text style={{ fontFamily: FF.pf7, fontSize: 8, letterSpacing: 1.1, color: M.route, textShadowColor: M.land, textShadowRadius: 3 }}>{s.time}</Text>
                  <Text numberOfLines={1} style={{ fontFamily: ff(placeName(s), FF.pf7I, FF.serif7), fontSize: 12.5, color: M.ink, textShadowColor: M.land, textShadowRadius: 3 }}>{placeName(s)}</Text>
                </View>
              </View>
            );
          })}
        </Animated.View>
        <View style={{ position: "absolute", right: 12, top: 10 }} pointerEvents="none">
          <Svg width={12} height={18} viewBox="0 0 20 30"><Path d="M10 2 L14 18 L10 15 L6 18Z" fill={M.ink} /></Svg>
          <Text style={{ textAlign: "center", fontFamily: FF.pf7, fontSize: 6, color: M.ink }}>N</Text>
        </View>
        <View style={{ position: "absolute", left: 12, bottom: 10, flexDirection: "row", alignItems: "flex-end", gap: 6 }} pointerEvents="none">
          <View style={{ width: scaleM * v.s, height: 5, borderWidth: 1, borderTopWidth: 0, borderColor: M.ink }} />
          <Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 0.7, color: M.ink }}>{scaleM >= 1000 ? `${scaleM / 1000} km` : `${scaleM} m`}</Text>
        </View>
        <Pressable onPress={() => setV(homeView(data))} style={{ position: "absolute", right: 10, bottom: 9, paddingVertical: 4, paddingHorizontal: 9, backgroundColor: alpha(M.land, 0.92), borderWidth: 0.8, borderColor: alpha(M.ink, 0.5) }} accessibilityLabel="回到路线">
          <Text style={{ fontFamily: FF.serif5, fontSize: 10, letterSpacing: 1, color: M.ink }}>回到路线</Text>
        </Pressable>
      </View>
    </GestureDetector>
  );
}

function Halo({ x, y, color }: { x: number; y: number; color: string }) {
  return <View style={{ position: "absolute", left: x - 16.5, top: y - 16.5, width: 33, height: 33, borderRadius: 17, borderWidth: 1, borderColor: color, opacity: 0.6 }} />;
}

type Box = [number, number, number, number];
/** 标注避让:编号章固定在站点上;图标和站名按候选位置试,选不压别的、不出框的(原型 layoutMarks) */
function layoutMarks(d: Full, plan: Plan, st: MapState, v: View_) {
  const boxes: Box[] = [];
  const hit = (a: Box, b: Box) => !(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]);
  const free = (r: Box) => (r[0] < 4 || r[1] < 4 || r[2] > MW - 4 || r[3] > MH - 22 ? 40 : 0) + boxes.reduce((c, b) => c + (hit(r, b) ? 12 : 0), 0);
  const pos = (n: number) => { const s = d.stops.find((x) => x.n === n); return s ? [s.x * v.s + v.tx, s.y * v.s + v.ty] : null; };
  const idx = markable(plan, d.stops, st.vis);
  idx.forEach((i) => { const [x, y] = pos(i + 1)!; boxes.push([x - 10, y - 10, x + 10, y + 10]); });
  return idx.map((i) => {
    const [x, y] = pos(i + 1)!, nm = placeName(plan.stops[i]), tw = Math.max(nm.length * 12.5, 40) + 4, th = 30, iw = 30;
    const I: Box[] = [[x - iw - 8, y - iw - 6], [x + 8, y - iw - 6], [x - iw - 12, y - iw / 2], [x + 12, y - iw / 2], [x - iw / 2, y + 13]].map(([a, b]) => [a, b, a + iw, b + iw]);
    const T: Box[] = [[x + 13, y - th / 2], [x - 13 - tw, y - th / 2], [x - tw / 2, y + 13], [x - tw / 2, y - th - 13]].map(([a, b]) => [a, b, a + tw, b + th]);
    let best: [number, Box, Box] | null = null;
    for (const a of I) for (const b of T) { const c = free(a) + free(b) + (hit(a, b) ? 30 : 0); if (!best || c < best[0]) best = [c, a, b]; }
    boxes.push(best![1], best![2]);
    return { i, x, y, ic: best![1], tx: best![2], right: best![2][0] < x };
  });
}

// ── 票根带 ─────────────────────────────────────────────────────────────────────────
function Band({ plan, M, walkKm, transit }: { plan: Plan; M: MapPal; walkKm: string | null; transit: number }) {
  const lg = (dash?: string, col = M.route) => (
    <Svg width={30} height={8} viewBox="0 0 30 8"><Path d="M2 4H28" stroke={M.land} strokeWidth={6.5} strokeLinecap="round" /><Path d="M2 4H28" stroke={col} strokeWidth={2.5} strokeDasharray={dash} strokeLinecap="round" /></Svg>
  );
  const sub = [walkKm ? `步行 ${walkKm} km` : null, transit ? `电车 ${transit} 段` : null].filter(Boolean).join(" · ");
  return (
    <View style={{ marginVertical: 18, height: 80, flexDirection: "row", backgroundColor: M.card, borderWidth: 1, borderColor: alpha(M.ink, 0.4) }}>
      <View style={{ position: "absolute", left: 3, top: 3, right: 3, bottom: 3, borderWidth: 0.6, borderColor: alpha(M.route, 0.45) }} pointerEvents="none" />
      <View style={{ width: 182, flexDirection: "row", alignItems: "center", gap: 9, paddingLeft: 16 }}>
        <Text style={{ fontFamily: FF.pf9, fontSize: 46, lineHeight: 50, letterSpacing: -1.4, color: M.route }}>{String(plan.stops.length).padStart(2, "0")}</Text>
        <View>
          <Text style={{ fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.4, color: M.ink, opacity: 0.8 }}>{routeBandLabel(plan)}</Text>
          <Text style={{ marginTop: 1, fontFamily: FF.pf7I, fontSize: 19, color: M.ink }}>stops</Text>
          {sub ? <Text style={{ marginTop: 5, fontFamily: FF.serif5, fontSize: 9, color: M.ink, opacity: 0.7 }}>{sub}</Text> : null}
        </View>
      </View>
      <View style={{ position: "absolute", left: 182, top: 9, bottom: 9, width: 1.4 }}><DotsV color={alpha(M.ink, 0.55)} h={62} /></View>
      <View style={{ flex: 1, justifyContent: "center", gap: 2, paddingLeft: 16 }}>
        {[["走过", lg()], ["接下来", lg("0.1 5.5")], ["电车", lg("7 3.5", M.ink)]].map(([t, el]) => (
          <View key={t as string} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>{el}<Text style={{ fontFamily: FF.serif5, fontSize: 10.5, color: M.ink }}>{t}</Text></View>
        ))}
      </View>
      <View style={{ width: 40, marginVertical: 10, marginRight: 10, flexDirection: "row", gap: 1.2, opacity: 0.75 }}>
        {[1, 2, 0.6, 1, 2, 0.6, 1.4, 0.6, 2, 1, 0.6, 1.6].map((w, q) => <View key={q} style={{ width: w, backgroundColor: M.ink }} />)}
      </View>
    </View>
  );
}
function DotsV({ color, h }: { color: string; h: number }) {
  return <Svg width={1.4} height={h}><Path d={`M0.7 0.7 V${h}`} stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeDasharray="0.01 3" /></Svg>;
}

// ── 站点票券 ────────────────────────────────────────────────────────────────────────
function MapTicket({ s, i, st, M, big, open, checked, onPress }: { s: Stop; i: number; st: MapState; M: MapPal; big?: boolean; open?: boolean; checked: boolean; onPress?: () => void }) {
  const vis = !!s.place, expanded = big || open;
  const status = ticketStatus(s, i, st, checked);
  const [k, lab] = status;
  const chipBg = k === "done" ? M.chipDone : k === "now" ? M.route : k === "lock" ? M.chipLock : M.chip;
  const leg = s.place?.leg;
  const how = legLine(leg, s.place?.how_to_get);
  const [h, setH] = useState(0);
  return (
    <Pressable onPress={big ? undefined : onPress} disabled={big || (!vis && !s.reveal_at)} onLayout={(e) => setH(e.nativeEvent.layout.height)} style={{ marginBottom: 8, flexDirection: "row" }}>
      {h ? <View style={{ position: "absolute", left: 0, top: 0 }}><Svg width={362} height={h}><Path d={sideNotch(362, h)} fill={M.card} stroke={alpha(M.ink, 0.35)} strokeWidth={0.8} /></Svg></View> : null}
      <View style={{ width: 52, alignItems: "center", paddingVertical: 12, gap: 6, borderRightWidth: 1, borderRightColor: alpha(M.ink, 0.35), borderStyle: "dashed" }}>
        <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: k === "lock" ? "transparent" : M.route, borderWidth: k === "lock" ? 1 : 0, borderColor: alpha(M.ink, 0.5) }}>
          <Text style={{ fontFamily: FF.pf7, fontSize: 10.5, color: k === "lock" ? M.ink : M.card }}>{i + 1}</Text>
        </View>
        <View style={{ width: 26, height: 26, opacity: k === "lock" ? 0.35 : 1 }}><SvgXml xml={icon(kindOf(s), M)} width={26} height={26} /></View>
      </View>
      <View style={{ flex: 1, paddingVertical: 11, paddingLeft: 12, paddingRight: 14 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 1.2, color: M.title }}>{`${s.time ?? ""} · ${kindLine(s)}`}</Text>
          <View style={{ paddingVertical: 2, paddingHorizontal: 8, backgroundColor: chipBg, opacity: k === "lock" ? 0.85 : 1 }}>
            <Text style={{ fontFamily: FF.serif5, fontSize: 10, letterSpacing: 0.6, color: k === "now" ? M.card : M.ink }}>{k === "done" ? `✓${lab}` : lab}</Text>
          </View>
        </View>
        <Text style={{ marginTop: 5, fontFamily: FF.serif7, fontSize: big ? 18 : 15, letterSpacing: vis ? 0.3 : 4.5, color: M.ink, opacity: vis ? 1 : 0.5 }}>{vis ? s.place!.title : "当天公开"}</Text>
        {expanded && vis ? (
          <View style={{ marginTop: 9, paddingTop: 9, borderTopWidth: 0.6, borderTopColor: alpha(M.ink, 0.35) }}>
            <Text style={{ fontFamily: FF.serif5, fontSize: 10.5, letterSpacing: 2, color: M.title }}>{kindZhLine(s.kind, s.subtype, s.time)}</Text>
            {s.note ? <Text style={{ marginTop: 5, fontFamily: FF.serif, fontSize: 13, lineHeight: 22.75, color: M.ink }}>{s.note}</Text> : null}
            {how ? <Text style={{ marginTop: 6, fontFamily: FF.serif5, fontSize: 12, lineHeight: 19, color: M.ink }}>{`怎么去：${how}`}</Text> : null}
            {addressOf(s) ? <Text style={{ fontFamily: FF.serif, fontSize: 11.5, color: M.ink, opacity: 0.65 }}>{addressOf(s)}</Text> : null}
            {s.place?.coords_note && s.place.lat == null ? <Text testID="coords-note" style={{ marginTop: 3, fontFamily: FF.serif, fontSize: 10.5, color: M.ink, opacity: 0.6 }}>{s.place.coords_note}</Text> : null}
            {mapLinkOf(s) || leg?.official_url ? (
              <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
                {mapLinkOf(s) ? <OpenLink label="在地图里打开 ↗" color={M.route} url={mapLinkOf(s)!} /> : null}
                {leg?.official_url ? <OpenLink label="官方路线 ↗" color={M.route} url={leg.official_url} /> : null}
              </View>
            ) : null}
          </View>
        ) : open && !vis && s.reveal_at ? (
          <View style={{ marginTop: 9, paddingTop: 9, borderTopWidth: 0.6, borderTopColor: alpha(M.ink, 0.35) }}>
            <Text style={{ fontFamily: FF.serif, fontSize: 13, lineHeight: 22.75, color: M.ink }}>{`这一站 ${hm(s.reveal_at)} 公开，到时候这里会出现地点和路线。`}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
/** epoch seconds → HH:MM in the engine's time zone */
export function hm(sec: number): string {
  const d = new Date((sec + tzOffset(sec)) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/** 地图空着时那一行:还有没公开的站=「Sealed until the day」;全公开了、只是没有能落点的地点(都是一件事)=不写字,留空白地图 */
/** 票根带抬头:结束了的约会=THE ROUTE WE TOOK;进行中照旧 */
export const routeBandLabel = (p: Pick<Plan, "status">) => (p.status === "done" ? "THE ROUTE WE TOOK" : "TODAY'S ROUTE");
/** 当前站那一块的抬头(进行中的约会才有;结束了的不出) */
export const mapNowLabel = (st: Pick<MapState, "next" | "vis">) => (st.next < 0 ? "NOW · 今天最后一站" : st.vis[st.next] ? "NEXT · 接下来" : "NOW · 现在");
/** 站点票券的状态字(按阶段):检过票的已完成(与当天页同一口径),时间过了没检票=没检票;她补记的结束了算已完成;
 *  进行中:现在这站进行中 / 下一站 / 稍后;没公开=锁 */
export function ticketStatus(s: Pick<Stop, "place" | "reveal_at" | "skipped">, i: number, st: MapState, checked: boolean): ["done" | "lock" | "now" | "soon", string] {
  if (s.skipped) return ["lock", "跳过了"];   // 他跳过的站(先于检票)
  // 以检票为准(当天页同一口径,结束后也不例外);她补记的约会没有当天可检票,结束了算已完成
  if (checked || (st.over && st.noDay)) return ["done", "已完成"];
  if (st.over || (st.arrived[i] && i < st.here)) return ["soon", "没检票"];
  if (!s.place) return ["lock", s.reveal_at ? `${hm(s.reveal_at)} 公开` : "当天公开"];
  return i === st.here ? ["now", "进行中"] : i === st.next ? ["now", "下一站"] : ["soon", "稍后"];
}
export function emptyMapLabel(st: Pick<MapState, "vis">): string {
  return st.vis.some((v) => !v) ? "Sealed until the day" : "";
}
/** 「在地图里打开」:有坐标才给;没有地点的站(一件事)不给(拿「买了一束花」去搜地图=假地点) */
export function mapLinkOf(s: Pick<Stop, "place" | "no_place">): string | null {
  if (!hasPlace(s)) return null;
  const p = s.place!;
  return `https://maps.apple.com/?q=${encodeURIComponent(p.title ?? p.address ?? "")}&ll=${p.lat},${p.lng}`;
}
/** 地图上能落点的站:引擎给了这一站的点、且这一站有地点(没有地点的站即使给了点也不画,不画假点) */
export function markable(plan: Pick<Plan, "stops">, pts: Array<{ n: number }>, vis: boolean[]): number[] {
  return plan.stops.map((_, i) => i).filter((i) => vis[i] && hasPlace(plan.stops[i]) && pts.some((x) => x.n === i + 1));
}
function OpenLink({ label, color, url }: { label: string; color: string; url: string }) {
  return (
    <Pressable onPress={() => openExternal(url)} hitSlop={8}>
      <Text style={{ fontFamily: FF.serif5, fontSize: 12, letterSpacing: 1.4, color, textDecorationLine: "underline", textDecorationStyle: "dotted" }}>{label}</Text>
    </Pressable>
  );
}

