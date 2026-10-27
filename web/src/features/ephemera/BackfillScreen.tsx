// 补记过往约会:外形=路线页的空白待写态。
// 头部同路线页「The Way We Went」;下面那条=日期 / 书脊上的名字 / 五本迷你书脊选颜色;
// 每站:地点类型一排 → 时间(没敲的淡显)→ 地名(边输边搜,候选从下面滑出)→ 她的一句话(小爱心 + 细线)→ 右侧卡套放照片;
// 末尾淡编号=加一站(点编号章两下=删这一站);底部火漆 SEAL & KEEP=存好,回书架,新盒子出现。
// 防重发:client_id 本页面会话固定一个;报错原样显示。请柬/契约书/小卡这里不出现(默认请他写)。
import { type Href, useRouter } from "../../nav/router";
import { useEffect, useRef, useState } from "react";
import { Image, Keyboard, Pressable, Text, View } from "react-native";
import { AbsKeyboardScroll } from "../../components/AbsKeyboardScroll";
import Svg, { Path } from "react-native-svg";
import { type EphemeraError, ephemeraApi, type Plan, type Stop } from "../../lib/ephemeraApi";
import { BackKey, NavBar, PaperTex, SEAL_BOW, Stage, useStage } from "./components";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getDraftPhoto, putDraftPhoto, deleteDraftPhotos, clearDraftPhotos } from "../../lib/draftPhotos";
import { blobOf, rememberBlob } from "../../lib/pickedBlobs";
import { applyHit, BACKFILL_DRAFT_KEY, PHOTO_LOST_TEXT, restoreDraftPhotos, blankStop, pickKind, buildBackfill, CJK_TITLE_EN, draftHasContent, enNameError, type Draft, type DraftStop, MAX_STOPS, maskParts, newClientId, newDraft, parseSavedBackfill, type SavedBackfill, stopsLabel } from "./backfill";
import { CaretInput, FieldHint, HerLine, HINT, KindChip, KindPicker, RowErr, MaskInput, PlaceSlips, placeKbGap, RtStamp, SearchKey, SpineBand, usePlaceSearch } from "./BackfillParts";
import { paperOf } from "./format";
import { PhotoFlow } from "./PhotoFlow";
import { pickMany, Polaroid } from "./Keepsakes";
import { PhotoPeek, RouteSleeve } from "./Sleeves";
import { nextPlan, usePlans, useSkin, useTimers } from "./store";
import { FF } from "./theme";
import { FlightSpot } from "./flight";

export const BF_TOP = 330, BF_RT = 214;

/** 草稿里的一站 → 卡套/照片流要的 Stop 形状(只拿来画纸,不发给引擎) */
export function draftAsStop(s: DraftStop, i: number): Stop {
  return { n: i + 1, stop_id: -1 - i, kind: s.kind, time: s.time ? maskParts(s.time, "00:00")[0] : null, stay_until: null, clue: null, note: null,
    place: s.title ? { title: s.title, address: s.address, lat: s.lat, lng: s.lng, how_to_get: null, walk_path: null, leg: null } : null };
}

export function EphemeraBackfillScreen() {
  const router = useRouter();
  const { key: skin, P, M } = useSkin();
  const { plans } = usePlans();
  const { body } = useStage();
  const next = plans ? nextPlan(plans) : null;
  const [draft, setDraft] = useState<Draft>(() => newDraft());
  const [clientId, setClientId] = useState(newClientId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [photoAt, setPhotoAt] = useState<number | null>(null);
  const [searchAt, setSearchAt] = useState<string | null>(null);
  const uploaded = useRef(new Set<string>()); // 已传上去的照片(按站 key;重点火漆时不重传)
  const everUploaded = useRef(new Set<string>()); // 传上去过的站(之后换照片/改小字再传=换掉旧那张)
  // 盒子建成后把「草稿行 → stop_id」钉死:照片失败重试时按它挂,不再按序号猜;之后再点火漆只补照片,不再改站
  const created = useRef<{ id: number; sid: Record<string, number> } | null>(null);
  const [kept, setKept] = useState(false);
  // photos a reload could not bring back (no bytes stored): that row / the day photos say it, until a new one is chosen
  const [lost, setLost] = useState<Record<string, true>>({});
  const [dayLost, setDayLost] = useState(false);
  // ── 草稿──────────────────────────
  // 进页先读回上次没收完的(含已建成的盒子与站映射:回来接着补照片,不建第二盒);读回前她已动过任何一格(含年份)=不盖。
  // 每次改动停手 400ms 存;离开页面时还没存的立刻存;全部收好(盒子建成+照片传完)才清。
  const [loaded, setLoaded] = useState(false);
  const initialDraft = useRef(draft);
  const restored = useRef<Draft | null>(null);
  const touched = useRef(false);
  const finished = useRef(false);
  const latest = useRef({ draft, clientId });
  latest.current = { draft, clientId };
  useEffect(() => { if (draft !== initialDraft.current && draft !== restored.current) touched.current = true; }, [draft]);
  const persist = () => {
    if (finished.current) return;
    const { draft: d, clientId: cid } = latest.current;
    const empty = !draftHasContent(d) && d.year === initialDraft.current.year && !created.current;
    if (empty) void clearDraftPhotos();   // nothing left in the draft: no orphan photo bytes either
    const op = empty ? AsyncStorage.removeItem(BACKFILL_DRAFT_KEY)
      : AsyncStorage.setItem(BACKFILL_DRAFT_KEY, JSON.stringify({ v: 1, draft: d, clientId: cid, box: created.current, at: Date.now(),
        up: [...uploaded.current], ever: [...everUploaded.current] } satisfies SavedBackfill));
    op.catch((e) => console.warn("[BackfillDraft] 存草稿没成", e));
  };
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(BACKFILL_DRAFT_KEY).then((raw) => {
      if (!alive) return;
      const saved = parseSavedBackfill(raw);
      // 存下来的都是她动过的(含只改了年份,review):读回前她没动过就整份恢复
      if (saved && !touched.current) {
        restored.current = saved.draft;
        setDraft(saved.draft); setClientId(saved.clientId);
        // photos: the saved addresses died with the last page; take the bytes back from the browser's store
        restoreDraftPhotos(saved, getDraftPhoto, (b) => { const u = URL.createObjectURL(b); rememberBlob(u, b); return u; }).then((r) => {
          if (!alive || touched.current) return;
          restored.current = r.draft;
          setDraft(r.draft);
          setLost(Object.fromEntries(r.lost.map((k) => [k, true])));
          setDayLost(r.dayLost);
        }).catch((e) => console.warn("[BackfillDraft] 照片没接回来", e));
        if (saved.box) { created.current = saved.box; setKept(true); }   // 盒子已建成:只补照片
        (saved.up ?? []).forEach((k) => uploaded.current.add(k));        // 已传上去的不重传
        (saved.ever ?? []).forEach((k) => everUploaded.current.add(k));  // 传过的站之后换照片=按「换掉」传
      }
    }).catch((e) => console.warn("[BackfillDraft] 读草稿没成", e)).finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);
  const pendingSave = useRef(false);
  useEffect(() => {
    if (!loaded || (!touched.current && !restored.current)) return;
    pendingSave.current = true;
    const t = setTimeout(() => { pendingSave.current = false; persist(); }, 400);
    return () => clearTimeout(t);
  }, [draft, clientId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (pendingSave.current || (touched.current && !loaded)) persist(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [upload, setUpload] = useState<string | null>(null); // 封火漆后传照片:火漆下面写进度
  const [gwNameErr, setGwNameErr] = useState<{ name: string; text: string } | null>(null);
  const later = useTimers();
  // 失焦后候选再留 250ms;这段时间里又回到某一格=取消收起(不让旧计时把刚出来的候选收掉)
  const searchT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchFocus = (k: string, on: boolean) => {
    if (searchT.current) { clearTimeout(searchT.current); searchT.current = null; }
    if (on) setSearchAt(k); else searchT.current = later(() => setSearchAt((x) => (x === k ? null : x)), 250);
  };
  const search = usePlaceSearch();
  const n = draft.stops.length;

  const patch = (key: string, p: Partial<DraftStop>) => setDraft((d) => ({ ...d, stops: d.stops.map((s) => (s.key === key ? { ...s, ...p } : s)) }));
  const tapStamp = (key: string) => {
    if (armed !== key) { setArmed(key); later(() => setArmed((a) => (a === key ? null : a)), 2600); return; }
    setArmed(null);
    setDraft((d) => ({ ...d, stops: d.stops.length > 1 ? d.stops.filter((s) => s.key !== key) : [blankStop()] }));
  };
  const add = () => { Keyboard.dismiss(); if (n < MAX_STOPS) setDraft((d) => ({ ...d, stops: [...d.stops, blankStop()] })); };

  const seal = async () => {
    if (busy) return;
    Keyboard.dismiss();
    const nameErr = !created.current ? enNameError(draft.name) : null;
    if (nameErr) { setErr(`没存好 · ${nameErr}`); return; } // 英文名那格写了中文:不发,原话在那一行和火漆下面
    // 一盒最多 60 张(每站的 + 这次的照片):盒子建成前就拦下(建成后这一页锁住,删不了多出来的,review)
    const total = (draft.dayPhotos?.length ?? 0) + draft.stops.filter((x) => x.photo).length;
    if (!created.current && total > DAY_MAX) { setErr(`没存好 · 这一盒最多放 ${DAY_MAX} 张照片,现在 ${total} 张,先拿掉 ${total - DAY_MAX} 张`); return; }
    setBusy(true); setErr(null);
    // 她离开这页以后:已经发出去的那一笔让它在后台传完,但不再 setState、不再开始下一张照片、不再导航(否则会把她现在的页面退掉)
    const live = () => mounted.current;
    try {
      let box = created.current;
      if (!box) {
        const { body: req, sent } = buildBackfill(draft, clientId);
        const plan = await ephemeraApi.backfill(req);
        box = { id: plan.id, sid: boxStopMap(sent, plan) };
        created.current = box;
        persist();     // 盒子建成:草稿里记下盒子与站映射(照片没传完就离开,回来接着补,不建第二盒)
        if (!live()) return;
        setKept(true);
      }
      // 照片(她补记的约会照样可以传):按钉死的映射挂
      for (const s of draft.stops) {
        const ph = s.photo, sid = box.sid[s.key];
        if (!ph || sid == null || uploaded.current.has(s.key)) continue;
        if (!live()) return;
        setUpload(`照片上传中 · 第 ${draft.stops.indexOf(s) + 1} 站`);
        // 这一站传上去过又换了/改了小字 → 按「换掉」传(引擎把旧那张记删除),不留两张
        await ephemeraApi.uploadPhoto(box.id, sid, { uri: ph.uri, mimeType: ph.mimeType, fileName: ph.fileName }, ph.caption, ph.clientId,
          (f) => { if (live()) setUpload(`照片上传中 · 第 ${draft.stops.indexOf(s) + 1} 站 ${Math.round(f * 100)}%`); }, everUploaded.current.has(s.key));
        uploaded.current.add(s.key); everUploaded.current.add(s.key);
        persist();     // 传上去一张记一张:中途离开,回来不重传、不多出一张
        if (!live()) return;
        setUpload(null);
      }
      // 「这次的照片」:挂在整次约会上(不挂站),按 clientId 记已传(重点火漆不重传;引擎也按 clientId 认重发)
      const day = draft.dayPhotos ?? [];
      for (const [k, ph] of day.entries()) {
        const key = `day:${ph.clientId}`;
        if (uploaded.current.has(key)) continue;
        if (!live()) return;
        setUpload(`照片上传中 · 这次的照片 第 ${k + 1} / ${day.length} 张`);
        await ephemeraApi.uploadPhoto(box.id, null, { uri: ph.uri, mimeType: ph.mimeType, fileName: ph.fileName }, ph.caption, ph.clientId,
          (f) => { if (live()) setUpload(`照片上传中 · 这次的照片 第 ${k + 1} / ${day.length} 张 ${Math.round(f * 100)}%`); });
        uploaded.current.add(key);
        persist();
        if (!live()) return;
        setUpload(null);
      }
      finished.current = true;      // 全部收好:草稿用完了
      AsyncStorage.removeItem(BACKFILL_DRAFT_KEY).catch((e) => console.warn("[BackfillDraft] 清草稿没成", e));
      void clearDraftPhotos();
      if (!live()) return;
      if (router.canGoBack()) router.back(); else router.replace("/ephemera-shelf" as Href);
    } catch (e) {
      console.warn("[PhotoFlow] 补记封火漆或照片上传没成", e);
      if (!mounted.current) return;
      // 引擎拒英文名(cjk_title_en):原话挂在英文格那一行下面(她改了这一格就清)
      if ((e as EphemeraError).code === CJK_TITLE_EN) setGwNameErr({ name: draft.name, text: (e as Error).message });
      setUpload(null);
      setErr(`${created.current ? "照片没收好" : "没存好"} · ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const dayY = BF_TOP + n * BF_RT + (n < MAX_STOPS ? 60 : 20);
  const day = draft.dayPhotos ?? [];
  const dayH = dayPhotosHeight(day.length + (kept ? 0 : 1));
  const H = dayY + dayH + 30 + 200;
  const addDay = async () => {
    if (kept) return;
    Keyboard.dismiss();
    const room = DAY_MAX - day.length - draft.stops.filter((x) => x.photo).length;
    if (room <= 0) { setErr(`这一盒最多放 ${DAY_MAX} 张照片`); return; }
    try {
      const got = await pickMany(room);
      if (got.length) {
        const add = got.map((a, k) => ({ uri: a.uri, mimeType: a.mimeType, fileName: a.fileName, caption: "",
          clientId: `day-${Date.now().toString(36)}-${k}-${Math.random().toString(36).slice(2, 8)}` }));
        add.forEach((ph, k) => { const b = got[k].file ?? blobOf(ph.uri); if (b) void putDraftPhoto(ph.clientId, b); });
        setDayLost(false);
        setDraft((d) => ({ ...d, dayPhotos: [...(d.dayPhotos ?? []), ...add] }));
      }
    } catch (e) { setErr((e as Error).message); }
  };
  const [dayArmed, setDayArmed] = useState<string | null>(null);
  const tapDay = (cid: string) => {
    if (kept) return;
    if (dayArmed !== cid) { setDayArmed(cid); later(() => setDayArmed((a) => (a === cid ? null : a)), 2600); return; }
    setDayArmed(null);
    setDraft((d) => ({ ...d, dayPhotos: (d.dayPhotos ?? []).filter((x) => x.clientId !== cid) }));
    void deleteDraftPhotos([cid]);
  };
  const thick = BF_TOP + (n - 1) * BF_RT + 18;
  return (
    <Stage P={P} bg={M.page} overlay={
      <>
        {photoAt != null && draft.stops[photoAt] ? (
          <PhotoFlow s={draftAsStop(draft.stops[photoAt], photoAt)} i={photoAt} P={P} skin={skin} onClose={() => setPhotoAt(null)} onSkip={() => setPhotoAt(null)}
            // already uploaded but its bytes are gone after a reload: say so (not "正在取照片" forever); 换一张 still works
            existing={draft.stops[photoAt].photo ? { source: draft.stops[photoAt].photo!.uri ? { uri: draft.stops[photoAt].photo!.uri } : null, caption: draft.stops[photoAt].photo!.caption,
              error: draft.stops[photoAt].photo!.uri ? null : PHOTO_LOST_TEXT } : null}
            onCaption={draft.stops[photoAt].photo ? async (caption) => {
              const key = draft.stops[photoAt].key, had = draft.stops[photoAt].photo!;
              uploaded.current.delete(key);
              // 新的一次提交:换 clientId,否则引擎按旧编号原样回执、小字不变
              const ncid = `${had.clientId}-c${Date.now().toString(36)}`;
              const b = blobOf(had.uri);
              if (b) void putDraftPhoto(ncid, b);
              patch(key, { photo: { ...had, caption, clientId: ncid } });
              setPhotoAt(null);
            } : undefined}
            onDone={async (file, caption, cid) => {
              const key = draft.stops[photoAt].key;
              uploaded.current.delete(key);
              const b = file.file ?? blobOf(file.uri);
              if (b) void putDraftPhoto(cid, b);
              setLost((m) => { if (!m[key]) return m; const x = { ...m }; delete x[key]; return x; });
              patch(key, { photo: { uri: file.uri, mimeType: file.mimeType, fileName: file.fileName, caption, clientId: cid } });
              setPhotoAt(null);
            }} />
        ) : null}
        <NavBar on="Archive" below P={P} dateHref={next ? (`/ephemera-day?id=${next.id}` as Href) : null} />
      </>
    }>
      <FlightSpot k="backfill-page" bg={M.page} style={{ position: "absolute", left: 0, top: 0, width: 390, height: body }}>
        <PaperTex />
        <AbsKeyboardScroll height={Math.max(H, body)} bottomOffset={searchAt != null ? placeKbGap(search.hits.length, !!search.errOf(searchAt)) : 40}>
          <BackKey color={M.title} top={30} onPress={() => router.back()} />
          <RouteHead M={M} md={draft.md} n={n} />
          <View style={{ position: "absolute", left: 0, top: 0, right: 0, height: BF_TOP }} pointerEvents={kept ? "none" : "box-none"}>
          <SpineBand M={M} year={draft.year} md={draft.md} name={draft.name} nameZh={draft.nameZh ?? ""} color={draft.color} nameErr={enNameError(draft.name) ?? (gwNameErr && gwNameErr.name === draft.name ? gwNameErr.text : null)}
            onYear={(year) => setDraft((d) => ({ ...d, year }))} onMd={(md) => setDraft((d) => ({ ...d, md }))}
            onName={(name) => setDraft((d) => ({ ...d, name }))} onNameZh={(nameZh) => setDraft((d) => ({ ...d, nameZh }))}
            onColor={(color) => setDraft((d) => ({ ...d, color }))} />
          </View>
          <Svg style={{ position: "absolute", left: 0, top: 0 }} width={60} height={BF_TOP + (n + 1) * BF_RT} pointerEvents="none">
            {n > 1 ? <Path d={`M36 ${BF_TOP + 18} V${thick}`} stroke={M.land} strokeWidth={6.5} strokeLinecap="round" /> : null}
            {n > 1 ? <Path d={`M36 ${BF_TOP + 18} V${thick}`} stroke={M.route} strokeWidth={2.5} strokeLinecap="round" /> : null}
            {n < MAX_STOPS ? <Path d={`M36 ${thick + 12} V${BF_TOP + n * BF_RT + 10}`} stroke={M.route} strokeWidth={1} strokeLinecap="round" opacity={0.3} /> : null}
          </Svg>
          {draft.stops.map((s, i) => (
            <DraftRow key={s.key} s={s} i={i} M={M} armed={armed === s.key} searching={searchAt === s.key} search={search} locked={kept}
              onStamp={() => tapStamp(s.key)} onPatch={(p) => patch(s.key, p)} onPhoto={() => { Keyboard.dismiss(); setPhotoAt(i); }}
              onSearchFocus={(on) => searchFocus(s.key, on)} err={lost[s.key] ? PHOTO_LOST_TEXT : null} />
          ))}
          {n < MAX_STOPS && !kept ? <View style={{ position: "absolute", left: 0, right: 0, top: BF_TOP + n * BF_RT, height: 40 }}><RtStamp n={n + 1} M={M} faint onPress={add} /></View> : null}
          {/* 这次的照片(小样 backView 末尾):一次可放多张;点一张两下=拿掉;盒子建成后只等它们传完 */}
          <View testID="bf-day" style={{ position: "absolute", left: 22, right: 22, top: dayY, height: dayH, borderTopWidth: 0.8, borderTopColor: M.ink }}>
            <Text style={{ position: "absolute", left: 0, top: 10, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.6, color: M.title }}>PHOTOS OF THE DAY · 这次的照片</Text>
            {dayLost ? <Text testID="bf-day-lost" style={{ position: "absolute", right: 0, top: 8, fontFamily: FF.serif5, fontSize: 11, color: M.ink, opacity: 0.8 }}>{PHOTO_LOST_TEXT}</Text> : null}
            {day.map((ph, k) => {
              const [x, y, r] = daySlot(k);
              return (
                <Pressable key={ph.clientId} onPress={() => tapDay(ph.clientId)} disabled={kept} testID={`bf-day-${k}`} accessibilityLabel={dayArmed === ph.clientId ? "再点一下拿掉" : "这次的照片"}
                  style={{ position: "absolute", left: x, top: y, transform: [{ rotate: `${r}deg` }], zIndex: k + 1 }}>
                  <Polaroid w={96} h={118} src={ph.uri ? { uri: ph.uri } : null} P={P}>
                    {dayArmed === ph.clientId ? <Text style={{ position: "absolute", left: 6, right: 4, bottom: 8, fontFamily: FF.serif5, fontSize: 9.5, color: P.deep }}>再点一下拿掉</Text> : null}
                  </Polaroid>
                </Pressable>
              );
            })}
            {!kept ? (() => {
              const [x, y, r] = daySlot(day.length);
              return (
                <Pressable onPress={addDay} testID="bf-day-add" accessibilityLabel="放这次的照片" style={{ position: "absolute", left: x, top: y, transform: [{ rotate: `${r}deg` }] }}>
                  <View style={{ width: 96, height: 118, backgroundColor: "#FFFEFB", shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.22, shadowRadius: 5, shadowOffset: { width: 0, height: 3 } }}>
                    <View style={{ position: "absolute", left: 7, right: 7, top: 7, bottom: 30, borderWidth: 1, borderStyle: "dashed", borderColor: M.route, opacity: 0.7 }} />
                    <Text style={{ position: "absolute", left: 0, right: 0, top: 26, textAlign: "center", fontFamily: FF.corm, fontSize: 30, color: M.route }}>+</Text>
                  </View>
                </Pressable>
              );
            })() : null}
          </View>
          <View style={{ position: "absolute", left: 0, right: 0, top: dayY + dayH + 20, alignItems: "center" }}>
            <Pressable onPress={seal} disabled={busy} style={{ alignItems: "center", opacity: busy ? 0.5 : 1 }} accessibilityLabel="SEAL & KEEP" testID="bf-seal">
              <Image source={SEAL_BOW} style={{ width: 62, height: 62, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 4 } }} />
              <Text style={{ marginTop: 8, fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: M.title }}>{"SEAL & KEEP"}</Text>
            </Pressable>
            {upload ? <Text testID="bf-upload" style={{ marginTop: 12, width: 300, textAlign: "center", fontFamily: FF.serif5, fontSize: 12, lineHeight: 18, color: M.ink, opacity: 0.8 }}>{upload}</Text> : null}
            {err ? <Text style={{ marginTop: 12, width: 300, textAlign: "center", fontFamily: FF.serif5, fontSize: 12, lineHeight: 18, color: M.ink, opacity: 0.8 }} testID="bf-err">{err}</Text> : null}
          </View>
        </AbsKeyboardScroll>
      </FlightSpot>
    </Stage>
  );
}

/** 这次的照片:一行五张(步 62,宽 96),行距 130;角度按位置轮换 */
const DAY_MAX = 60;
const DAY_R = [-6, 3, -2, 4, -3];
export function daySlot(k: number): [number, number, number] {
  return [(k % 5) * 62, 36 + Math.floor(k / 5) * 130 + [6, 0, 10, 2, 8][k % 5], DAY_R[k % 5]];
}
export const dayPhotosHeight = (slots: number) => 36 + Math.max(1, Math.ceil(slots / 5)) * 130 + 24;

/** 盒子建成那一刻:发出去的草稿行(与引擎回的站同序)→ stop_id,之后一律按它挂照片 */
export function boxStopMap(sent: DraftStop[], plan: Pick<Plan, "stops">): Record<string, number> {
  const m: Record<string, number> = {};
  sent.forEach((s, i) => { const sid = plan.stops[i]?.stop_id; if (sid != null) m[s.key] = sid; });
  return m;
}

/** 路线页头(同纪念盒路线页 rtHead):No. 月日 · 月.日 · N STOPS / The Way We Went / 那天走过的路 */
export function RouteHead({ M, md, n, no, children }: { M: ReturnType<typeof useSkin>["M"]; md: string; n: number; no?: string; children?: React.ReactNode }) {
  const [typed, rest] = maskParts(md, "00.00");
  const dot = typed + rest;
  return (
    <View style={{ position: "absolute", left: 22, right: 22, top: 70, paddingTop: 10, borderTopWidth: 1, borderTopColor: M.ink }}>
      <Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.8, color: M.ink, opacity: 0.8 }}>{`NO. ${no ?? dot.replace(".", "")} · ${dot} · ${stopsLabel(n)}`}</Text>
      <Text style={{ marginTop: 10, fontFamily: FF.pf9, fontSize: 40, lineHeight: 38, letterSpacing: -0.8, color: M.title }}>{"The Way\nWe Went"}</Text>
      <Text style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 12, letterSpacing: 3.6, color: M.ink, opacity: 0.7 }}>那天走过的路</Text>
      {children}
    </View>
  );
}

/** 一站(写的时候):类型一排 / 时间 / 地名(搜)/ 她的一句话 / 右侧卡套 */
export function DraftRow({ s, i, M, armed, searching, search, onStamp, onPatch, onPhoto, onSearchFocus, top = BF_TOP, onTitleCommit, err, locked, onRetry }: {
  s: DraftStop; i: number; M: ReturnType<typeof useSkin>["M"]; armed: boolean; searching: boolean; search: ReturnType<typeof usePlaceSearch>;
  onStamp: () => void; onPatch: (p: Partial<DraftStop>) => void; onPhoto: () => void; onSearchFocus: (on: boolean) => void; top?: number;
  onTitleCommit?: (picked: boolean, s: DraftStop) => void;
  /** 这一行的报错/缺项(引擎原话或「还缺类型/地名」) */ err?: string | null;
  /** 盒子已建成:站不再改,只能补照片 */ locked?: boolean;
  /** 点报错那一行=原地重试 */ onRetry?: () => void;
}) {
  const [titleFocus, setTitleFocus] = useState(false);
  const [picking, setPicking] = useState(false);
  const picked = useRef(false); // 选了候选会顺带收键盘(失焦);那次失焦不再按手写的地名再提交一遍——只对当前这个焦点周期有效
  const focused = useRef(false);
  const y = top + i * BF_RT, r = [-3, 2.5, -2, 3, -2.5, 2][i % 6];
  const st = draftAsStop(s, i);
  return (
    <View style={{ position: "absolute", left: 0, right: 0, top: y, height: BF_RT, zIndex: searching ? 5 : 1 }}>
      <RtStamp n={i + 1} M={M} armed={armed} onPress={locked ? undefined : onStamp} />
      {/* 当前类别(图标 + 「中文名 · 细类」),可能比文字栏(128)宽、右端压在卡套上:单独一层放在卡套之上,否则 iOS 点不到栏外那截 */}
      <View style={{ position: "absolute", left: 62, top: 2, width: 171, zIndex: 3 }} pointerEvents={locked ? "none" : "box-none"}>
        <KindChip kind={s.kind} subtype={s.subtype ?? null} time={s.time} M={M} onPress={locked ? undefined : () => setPicking(true)} testID={`bf-kind-${i}`} />
      </View>
      <KindPicker visible={picking} kind={s.kind} subtype={s.subtype ?? null} M={M} onClose={() => setPicking(false)}
        onPick={(k, sub) => { setPicking(false); onPatch(pickKind(s, k, sub)); }} />
      <View style={{ position: "absolute", left: 62, top: 2 + 23, width: 128 }} pointerEvents={locked ? "none" : "auto"}>
        <View style={{ marginTop: 3 }}>
          <MaskInput value={s.time} onChange={(time) => onPatch({ time })} template="00:00" example={HINT.time} caret={M.route} testID={`bf-time-${i}`}
            style={{ fontFamily: FF.pf9, fontSize: 27, lineHeight: 30, color: M.ink }} />
        </View>
        <View style={{ marginTop: 7 }}>
          <FieldHint show={!s.title} text={HINT.place} M={M} testID="bf-place-hint" />
        <CaretInput caret={M.route} value={s.title} testID={`bf-title-${i}`} maxLength={30} autoCorrect={false} accessibilityLabel="地名" multiline blurOnSubmit
          onChangeText={(v) => { const title = v.replace(/\n/g, ""); onPatch({ title, address: null, lat: null, lng: null }); search.query(title, s.key); }}
          onFocus={() => { focused.current = true; picked.current = false; setTitleFocus(true); onSearchFocus(true); }}
          onBlur={() => { focused.current = false; setTitleFocus(false); onSearchFocus(false); if (picked.current) picked.current = false; else onTitleCommit?.(false, s); }}
          onSubmitEditing={() => search.submit(s.key)}
          style={{ padding: 0, paddingBottom: 2, fontFamily: FF.serif7, fontSize: 14.5, lineHeight: 19.5, color: M.ink,
            borderBottomWidth: titleFocus || !s.title ? 0.6 : 0, borderBottomColor: M.ink }} />
        <SearchKey search={search} k={s.key} M={M} testID={`bf-search-${i}`} />
        </View>
        <HerLine value={s.herLine} onChange={(herLine) => onPatch({ herLine })} M={M} editable marginTop={12} testID={`bf-line-${i}`} />
        {!searching ? <RowErr text={search.errOf(s.key)} M={M} testID={`row-search-err-${s.key}`} /> : null}
        <RowErr text={err} M={M} testID={`row-err-${i}`} onPress={onRetry} />
      </View>
      {searching ? <PlaceSlips hits={search.hits} err={search.errOf(s.key)} notice={search.notice} M={M} onPick={(h) => { const nx = applyHit(s, h); picked.current = focused.current; onPatch(nx); search.clear(); Keyboard.dismiss(); onTitleCommit?.(true, nx); }} /> : null}
      <Pressable onPress={onPhoto} style={{ position: "absolute", left: 196, top: 6, width: 172, height: 168, transform: [{ rotate: `${r}deg` }], opacity: s.photo ? 1 : 0.5 }} accessibilityLabel={`第 ${i + 1} 站的卡套`}>
        {s.photo ? <PhotoPeek testID={`bf-peek-${i}`} /> : null}
        <RouteSleeve paper={paperOf(st)} s={st} i={i} M={M} opening={false} seen={false} />
      </Pressable>
    </View>
  );
}
