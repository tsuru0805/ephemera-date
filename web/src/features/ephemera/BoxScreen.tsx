// Ephemera ⑥ 纪念盒(原型 archView):盒盖(扇边封标压接缝,点开先揭封标再掀盖)→ 小册子四页:
// 平铺(请柬当主角,信封/火漆/连票/契约书/小卡袋/准备清单围着压,点了翻到各自页;请柬点了拿起来看)/
// 路线(左路线脊 + 编号章、时间站名线索、右侧按地点类型的卡套,翻开以后才是照片)/ 契约书(按指印)/ 限定小卡(撕袋→滑出→翻面)。
// 契约书、小卡有才出。这页不用溶图。
import { type Href, useLocalSearchParams, useNavigation, useRouter } from "../../nav/router";
import { usePreventRemove } from "@react-navigation/native"; // expo-router 自带的导航库(同一份;native-stack 据此在 iOS 拦住右滑返回)
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Image, Keyboard, Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { AbsKeyboardScroll } from "../../components/AbsKeyboardScroll";
import Animated, { Easing, runOnJS, type SharedValue, useAnimatedProps, useAnimatedReaction, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { calm } from "./calm";
import Svg, { Path, SvgXml } from "react-native-svg";
import { type DateEvent, type EphemeraError, ephemeraApi, type HerOp, type HerPhoto, type Plan, type Stop } from "../../lib/ephemeraApi";
import { Art, BackKey, CRINKLE, FitLine, FoilLine, FoilText, NavBar, Paper, PaperTex, PLAYFAIR_BLACK_FILE, pressIn, SEAL_BOW, Stage, Svg as SvgBox, TallScroll, useEphToast, useStage, FitText, naturalWidth, shapeShadow } from "./components";
import { addStopOp, blankStop, CJK_TITLE_EN, dateValue, enNameError, type DraftStop, invitePaper, isBlank, lateStamps, lineOp, MAX_STOPS, mdDigits, missingLabel, neverSent, planOp, removeOp, type Seed, seedFromDiff, splitTitle, stopsLabel, timeDigits, timeOp, timeValue,
  type Eq, type Field, type FieldEv, fieldDirty, fieldInit, fieldShouldSend, fieldStep, type PlaceVal, envelopeFrom, placeEq, placeFieldOp, placeOfStop, type KindVal, kindEditableOf, kindEq, kindFieldOp, kindOpCarriesPlace, placeForKind } from "./backfill";
import { CaretInput, FieldHint, HerLine, HINT, KindChip, KindPicker, MaskInput, PlaceSlips, placeKbGap, RowErr, RtStamp, SearchKey, SpineBand, usePlaceSearch } from "./BackfillParts";
import { BF_TOP, DraftRow } from "./BackfillScreen";
import { LateInviteMini, LateInvitePop } from "./LateInvite";
import { PhotoFlow } from "./PhotoFlow";
import { FlatKeepsakes, LetterEditor, LetterPage, memorySolo, PenNib, PhotosPage, pickMany, stackPhotos, STACK_MAX, StackPhotoPop, useStackUploads, writableFirst, WriteFirstPop } from "./Keepsakes";
import { dateParts, kindOf, paperNo, paperOf, placeName, quoteParts, stopsMain, titleLines, titleOne, titleZh, fitZh, two, walkKmText } from "./format";
import { kindLine } from "./kinds";
import { boxMarkXml } from "./icons";
import { ASK_NOTE_FLY_MS, ASK_STAMP_MS, depthShift, lidDragY, lidOpenDecision, lightboxDimOpacity, lightboxDragRotate, lightboxDragScale, lightboxShouldClose, PAGE_DEPTH, pageOffset, routeDrawn, sleeveSlideFrom, sleeveSlideT, stampRevealed, textSlideFrom } from "./boxMotion";
import { LoadErr } from "./DayScreen";
import { PrepCard } from "./PrepCard";
import { PhotoPeek, RouteSleeve } from "./Sleeves";
import { StopArt } from "./StopArt";
import { deckle, fingerprintXml, perf, stampXml, stripPath, zig } from "./shapes";
import { has, nextPlan, usePlan, usePlans, useSkin } from "./store";
import { alpha, FF, ff, hasCJK, planCol, rgba, segC, type MapPal, type PlanColor, type Skin, type SkinKey } from "./theme";
import { FlightSpot, fly, flyMany } from "./flight";
import { STACK_FAN_V } from "./boxMotion";
import { DepthKids, PageDepth } from "./depth";
import { herEn, herName, himEn, himName } from "../../runtime/session";
import { tzOffset } from "../../lib/tz";

const NO_PHOTO = "这一站没留照片"; // 兜底句

const AScrollView = Animated.createAnimatedComponent(ScrollView);

export function EphemeraBoxScreen() {
  const sp = useLocalSearchParams<{ id: string; from?: string }>();
  const id = Number(sp.id);
  const from = sp.from === "stamp" || sp.from === "spine" ? sp.from : null;   // 从哪样东西变出来的(返回时变回去)
  const router = useRouter();
  const { key: skin, P, M } = useSkin();
  const { plan, her, mark, error, reload, replace, refreshHer } = usePlan(id);
  const { plans } = usePlans();
  const { body } = useStage();
  const toast = useEphToast(P);
  const book = useRef<ScrollView>(null);
  const scrollX = useSharedValue(0); // 翻页纸片远近用(PageParallax)
  const scrollHandler = useAnimatedScrollHandler((e) => { scrollX.value = e.contentOffset.x; });
  const [pg, setPg] = useState(0);
  // the page number follows the scroll as well: React Native Web sends no onMomentumScrollEnd (it stayed at 01)
  useAnimatedReaction(() => Math.round(scrollX.value / 390), (k, prev) => { if (k !== prev) runOnJS(setPg)(k); });
  const [pop, setPop] = useState<null | "invite" | "prep">(null);
  const [photo, setPhoto] = useState<{ i: number } | null>(null);
  const [walkKm, setWalkKm] = useState<string | null>(null);
  const [events, setEvents] = useState<DateEvent[]>([]);
  // 编辑态(只在已结束的约会):钢笔尖进出;加照片走当天那套放照片流程
  const [editing, setEditing] = useState(false);
  const [addPhoto, setAddPhoto] = useState<{ i: number } | null>(null);
  // 一叠照片 + 她的信:点开的那张 / 写信 / 我先写一样
  const [stackPop, setStackPop] = useState<HerPhoto | null>(null);
  const [popFlown, setPopFlown] = useState(false);
  const [letterLand, setLetterLand] = useState(0);
  const [letterEd, setLetterEd] = useState(false);
  const [writeFirst, setWriteFirst] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false); // 写信 / 我先写一样 弹层里有没收好的字
  const herNow = () => { refreshHer().catch((e) => toast.show(`照片列表没刷新 · ${(e as Error).message} · 往下拉一下或重新进来`, 3000)); };
  const stack = useStackUploads(id, herNow);
  const pagesRef = useRef<string[]>([]);
  const goPhotos = useRef(false); // 第一次放照片:照片页这一轮才出现,等它出现再翻过去
  useEffect(() => {
    if (!goPhotos.current) return;
    const i = pagesRef.current.indexOf("photos");
    if (i >= 0) { goPhotos.current = false; book.current?.scrollTo({ x: i * 390, animated: true }); }
  }, [stack.ups.length]);
  // 她的改动一次只发一笔(串行):旧回执晚到不会盖掉新的。投影里没有 version,带不了 expect_version,串行即保证先后
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // 离开纪念盒的每条路(返回键 / iOS 右滑返回 / 底部导航)在编辑态都先问路线页:有没存上的就停在原地(翻页不拦,路线页一直挂着,草稿不丢;
  // 进后台再回来同一次挂载,草稿也在)
  const leaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const navigation = useNavigation();
  const [pendingLeave, setPendingLeave] = useState<{ type: string } | null>(null);
  /** 照片还在传 / 写的还没收好:先拦下说明白。
   *  没传上的可以不要:再点一次离开就放行 */
  const dropArmed = useRef(false);
  const hold = async (): Promise<boolean> => {
    if (draftDirty) { toast.show("写的还没收好:点 Keep 收好,或者在纸外面点两下不要了", 3000); return false; }
    const live = stack.ups.filter((u) => u.err == null).length, failed = stack.ups.length - live;
    if (live) {
      toast.show(`照片还在传(还剩 ${live} 张),传完再走`, 2600);
      const i = pagesRef.current.indexOf("photos");
      if (i >= 0) book.current?.scrollTo({ x: i * 390, animated: true });
      return false;
    }
    if (failed && !dropArmed.current) {
      dropArmed.current = true;
      setTimeout(() => { dropArmed.current = false; }, 3000);
      toast.show(`有 ${failed} 张照片没传上:点那张再传一次;再点一次就不要它们了`, 3000);
      return false;
    }
    if (failed) stack.drop();
    return true;
  };
  const [released, setReleased] = useState(false);
  const guard = async (): Promise<boolean> => {
    if (!(await hold())) return false;
    if (!editing) return true;
    const ok = (await leaveRef.current?.()) ?? true;
    if (!ok) book.current?.scrollTo({ x: 390, animated: true }); // 路线页在第 2 页:翻回去让她看到是哪一行
    return ok;
  };
  // 放行只走一次:正在问的时候再来的离开(连按返回、右滑又点导航)一律不另起
  const leaving = useRef(false);
  const requestLeave = async (action: { type: string }) => {
    if (leaving.current) return;
    leaving.current = true;
    const ok = await guard();
    if (ok) { setReleased(true); setPendingLeave(action); } else leaving.current = false;
  };
  const navGuard = async () => {
    if (leaving.current) return false;
    leaving.current = true;
    const ok = await guard();
    leaving.current = false;
    return ok;
  };
  usePreventRemove((editing || stack.ups.length > 0 || draftDirty) && !released, ({ data }) => { requestLeave(data.action); });
  useEffect(() => { if (pendingLeave && !editing && released) { setPendingLeave(null); leaving.current = false; navigation.dispatch(pendingLeave as never); } }, [pendingLeave, editing, navigation]);
  // 没有记下的路(她补记的约会没有站到站怎么走)=walk_m 0 → 不显示「走了多少公里」那一格
  useEffect(() => { if (plan) ephemeraApi.map(plan.id).then((m) => { setWalkKm(walkKmText(m)); }).catch(() => {}); }, [plan?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 迟到的请柬的「写信那天」邮戳:取这一盒的 late_written 事件
  // 读不到不打扰她:邮戳退回 closed_at,只记一笔 warn
  useEffect(() => { if (plan?.invite) ephemeraApi.events(plan.id).then(setEvents).catch((e) => console.warn("[ephemera] 迟到请柬读事件失败,邮戳用 closed_at", e)); }, [plan?.id, plan?.invite]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = plans ? nextPlan(plans) : null;
  if (!plan || !her) return <Stage P={P}><BackKey color={P.deep} top={34} onPress={() => router.back()} />{error ? <LoadErr P={P} msg={error} /> : null}</Stage>;
  const late = lateStamps(plan, events);
  /** 她的一笔改动:排队串行发;成了=引擎回的投影直接换上;被拒=抛出(引擎原话),由那一行留着草稿并显示 */
  const runOps = (ops: HerOp[]): Promise<Plan> => {
    const job = queue.current.then(() => ephemeraApi.herEdit(plan.id, ops)).then((p) => { replace(p); return p; });
    queue.current = job.catch(() => undefined);
    return job;
  };
  /** 队列安静下来(每一笔都有超时,不会永远等;回执触发的补发也一起等完) */
  const idle = async () => { for (;;) { const q = queue.current; await q; await new Promise((r) => setTimeout(r, 30)); if (q === queue.current) return; } };
  const kept = stackPhotos(her.photos);
  const pages: Array<"flat" | "route" | "photos" | "letter" | "contract" | "card"> = ["flat", "route",
    ...(kept.length || stack.ups.length ? ["photos" as const] : []), ...(plan.letter || plan.reply ? ["letter" as const] : []),
    ...(plan.contract ? ["contract" as const] : []), ...(plan.card ? ["card" as const] : [])];
  pagesRef.current = pages;
  const N = pages.length, ph = body;
  const toPage = (k: string) => { const i = pages.indexOf(k as never); if (i >= 0) book.current?.scrollTo({ x: i * 390, animated: true }); };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => setPg(Math.round(e.nativeEvent.contentOffset.x / 390));
  const photoOf = (s: Stop) => latestPhoto(her.photos, s.stop_id);
  /** 往那一叠里放照片(一次可选多张);replaceId=换掉那一叠里指名的一张。上限按整盒(挂站 + 不挂站)算 */
  const addPhotos = async (replaceId?: number) => {
    const room = replaceId != null ? 1 : STACK_MAX - her.photos.length - stack.ups.length;
    if (room <= 0) { toast.show(`这一盒最多放 ${STACK_MAX} 张照片`); return; }
    try {
      const got = await pickMany(room);
      if (got.length) { if (replaceId == null) goPhotos.current = true; stack.add(got, replaceId); }
    } catch (e) { toast.show((e as Error).message, 3000); }
  };
  /** 钢笔尖(平铺页):整盒一起进退编辑态;退出时路线页有没存上的=不退,翻到路线页让她看到是哪一行 */
  const penFlat = async () => { if (!editing) { setEditing(true); return; } await guard(); };

  return (
    <Stage P={P} overlay={
      <>
        {pop === "invite" && invitePaper(plan) === "late" ? <LateInvitePop plan={plan} P={P} posted={late.posted} to={late.to} onClose={() => setPop(null)} />
          : pop ? <PopPaper P={P} onClose={() => setPop(null)} kind={pop} plan={plan} her={her} /> : null}
        {stackPop ? <StackPhotoPop plan={plan} photo={stackPop} P={P} editing={editing} flown={popFlown}
          onClose={() => { const p = stackPop; fly(`pop:${p.id}`, `pp:${p.id}`, () => { setStackPop(null); setPopFlown(false); }, { dur: 520, pre: { dy: 0, ms: 0 } }); }}
          onChanged={(h) => refreshHer(h)}
          swapping={stack.ups.some((u) => u.replaceId === stackPop.id)}
          onSwap={() => { const pid = stackPop.id; setStackPop(null); addPhotos(pid); }} /> : null}
        {letterEd ? <LetterEditor plan={plan} P={P} onSaved={replace} onDirty={setDraftDirty} onClose={() => { setDraftDirty(false); setLetterEd(false); }} /> : null}
        {writeFirst ? <WriteFirstPop plan={plan} P={P} onWritten={replace} onDirty={setDraftDirty} onClose={() => { setDraftDirty(false); setWriteFirst(false); }} /> : null}
        {photo ? <PhotoPop P={P} plan={plan} i={photo.i} ph={photoOf(plan.stops[photo.i])} onClose={() => setPhoto(null)} /> : null}
        {addPhoto && plan.stops[addPhoto.i] ? (
          <StopPhotoFlow planId={plan.id} s={plan.stops[addPhoto.i]} i={addPhoto.i} ph={photoOf(plan.stops[addPhoto.i])} P={P} skin={skin}
            onClose={() => setAddPhoto(null)} onSaved={() => { setAddPhoto(null); herNow(); }} />
        ) : null}
        {toast.node}
        <NavBar on="Archive" below P={P} dateHref={next ? (`/ephemera-day?id=${next.id}` as Href) : null} guard={navGuard} />
      </>
    }>
      <FlightSpot k={has(her, "lid") ? `box:${plan.id}` : null} style={{ position: "absolute", left: 0, top: 0, width: 390, height: ph }}>
      <AScrollView ref={book} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={onScroll}
        onScroll={scrollHandler} scrollEventThrottle={16} style={{ position: "absolute", left: 0, top: 0, width: 390, height: ph }}>
        {pages.map((k, idx) => {
          // the pages laid out at fixed places scroll on a short screen; the others scroll by themselves
          const fixed = FIXED_PAGES.has(k), need = boxPageNeed(k), pph = fixed ? Math.max(ph, need) : ph;
          const Wrap = !fixed ? PlainPage : k === "card" ? FitPage : TallScroll;
          return (
          <View key={k} style={{ width: 390, height: ph, overflow: "hidden" }}>
            <Wrap have={ph} need={need} testID={k === "card" ? "box-page-fit-card" : `box-page-scroll-${k}`}>
            <PageDepth scrollX={scrollX} index={idx}>
            {k === "flat" ? <Flat plan={plan} P={P} skin={skin} onGo={toPage} onPop={setPop} late={late}
              onAsk={async () => { replace(await ephemeraApi.requestWrite(plan.id, `rw-${plan.id}-${Date.now().toString(36)}`)); }}
              onWriteFirst={() => setWriteFirst(true)} /> : null}
            {k === "flat" && plan.status === "done" ? (
              <>
                <FlatKeepsakes plan={plan} photos={kept} ups={stack.ups} P={P} solo={memorySolo(plan, !!invitePaper(plan))} ph={pph} editing={editing}
                  onPhotos={() => toPage("photos")} onAddPhotos={() => { if (stack.ups.length) toPage("photos"); else addPhotos(); }}
                  onLetter={(write) => { if (write) setLetterEd(true); else toPage("letter"); }}
                  onFlyPhotos={(f) => flyMany(kept.slice(0, 3).map((p, k) => ({ from: `kp:${p.id}`, to: `pp:${p.id}`,
                    adjust: (b) => ({ ...b, rot: b.rot + STACK_FAN_V[k][2] * f }) })),
                    () => toPage("photos"), { dur: 1000, stagger: 80, lift: 60, settle: 380, pre: { dy: -26, ms: 380 } })}
                  onFlyLetter={() => (setLetterLand(-1), fly(`fl:${plan.id}`, `lp:${plan.id}`, () => toPage("letter"), { dur: 1000, lift: 50, settle: 380, pre: { dy: -26, ms: 380 } }).then(() => setLetterLand(Date.now())))} />
                <PenNib on={editing} M={M} P={P} onPress={penFlat} style={{ right: 88, top: pph - 36 }} />
              </>
            ) : null}
            {k === "photos" ? <PhotosPage plan={plan} photos={kept} ups={stack.ups} P={P} M={M} ph={ph} editing={editing}
              onOpen={(p) => { setPopFlown(true); fly(`pp:${p.id}`, `pop:${p.id}`, () => setStackPop(p), { dur: 580, lift: 16 }); }}
              onAdd={() => addPhotos()} onRetry={stack.retry} /> : null}
            {k === "letter" ? <LetterPage plan={plan} P={P} M={M} ph={ph} editing={editing} onEdit={() => setLetterEd(true)} landKey={letterLand} /> : null}
            {k === "route" ? <RoutePage plan={plan} her={her} M={M} ph={ph} walkKm={walkKm} editing={editing} setEditing={setEditing} onRun={runOps} idle={idle} leaveRef={leaveRef} hold={hold}
              onOpen={(i) => { if (editing) { Keyboard.dismiss(); setAddPhoto({ i }); return; } mark(`sleeve:${plan.stops[i].stop_id}`).catch(() => {}); setPhoto({ i }); }}
              onUploadNew={async (sid, ph, onProgress) => { await ephemeraApi.uploadPhoto(plan.id, sid, ph, ph.caption, ph.clientId, onProgress); herNow(); }} /> : null}
            {k === "contract" ? <Contract plan={plan} P={P} done={has(her, "contract_fp")} onPress={() => mark("contract_fp").catch(() => {})} /> : null}
            {k === "card" ? <CardPage plan={plan} P={P} torn={has(her, "card_torn")} onTear={() => mark("card_torn").catch(() => {})} ph={pph} /> : null}
            </PageDepth>
            </Wrap>
          </View>
          );
        })}
      </AScrollView>
      </FlightSpot>
      <BackKey color={P.deep} chip={P.paper} top={34} onPress={async () => {
        Keyboard.dismiss();
        // 从邮票/书脊变出来的,返回时这一页缩回那张邮票/那本书脊
        // 照片还在传 / 信没收好时会被拦下(usePreventRemove):先过拦,放行了才飞(否则整页先缩回邮票又被拦回来;review)
        const blocked = (stack.ups.length > 0 || draftDirty) && !released;   // 与 usePreventRemove 同一判据
        if (!editing) { if (from && !blocked) fly(`box:${plan.id}`, `${from}:${plan.id}`, () => router.back(), { dur: 720, back: true }); else router.back(); return; }
        await requestLeave({ type: "GO_BACK" });
      }} />
      <View style={{ position: "absolute", right: 14, top: ph - 10 - 22, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10, backgroundColor: alpha(P.paper, 0.88), flexDirection: "row", alignItems: "baseline", opacity: 0.85 }} pointerEvents="none">
        <Text testID="box-page-no" style={{ fontFamily: FF.pf9, fontSize: 15, color: P.deep }}>{String(pg + 1).padStart(2, "0")}</Text>
        <Text style={{ fontFamily: FF.pf7, fontSize: 8, letterSpacing: 2.5, color: P.ink }}>{`  / ${String(N).padStart(2, "0")}`}</Text>
      </View>
      {!has(her, "lid") ? <Lid plan={plan} P={P} M={M} ph={ph} onOpen={() => mark("lid").catch(() => {})} /> : null}
    </Stage>
  );
}

/** Box pages laid out at fixed places (the others — photos, letter, route — scroll by themselves) */
const FIXED_PAGES = new Set(["flat", "contract", "card"]);
/** What those pages need (their lowest controls: the prep list from 582, the card to 616, the fingerprint to ~606;
 *  the papers below run under the bar by design): a shorter page scrolls (TallScroll) */
export const BOX_PAGE_MIN_H = 720;
/** The contract page's content: the paper from 226, 580 tall, turned -3° (its corners reach lower), and a margin —
 *  the page scrolls to the paper's foot and both lower corners (as the home app, 850) */
export const CONTRACT_H = 850;
/** The card page: the card (265..567, turned) and its shadow; the big numbers below run under the bar by design */
export const CARD_PAGE_H = 600;
export const boxPageNeed = (k: string) => (k === "contract" ? CONTRACT_H : k === "card" ? CARD_PAGE_H : BOX_PAGE_MIN_H);
/** How much the card page is scaled to show the card whole on a shorter screen (1 = it fits). Pure, tested. */
export const fitScale = (have: number, need: number) => (have >= need || need <= 0 ? 1 : have / need);
/** The card page on a screen shorter than the card needs: scaled down to show it whole, not scrolled. The card's back
 *  scrolls inside the card; inside a scrolling page iOS Safari gave the drag to the page, never to the card's text
 *  (measured: the page moved, the text did not; with the page not scrolling, the text scrolls). */
function FitPage({ have, need, testID, children }: { have: number; need: number; testID?: string; children: React.ReactNode }) {
  const k = fitScale(have, need);
  return <View testID={testID} style={{ position: "absolute", left: 0, top: 0, width: 390, height: Math.max(have, need), transform: [{ scale: k }], transformOrigin: "top center" }}>{children}</View>;
}
function PlainPage({ children }: { have: number; need: number; testID?: string; children: React.ReactNode }) { return <>{children}</>; }

/** 竖排小字:文字框按中心转 -90°,左下角落在 (left, bottom)(原型 .vcap) */
function VCap({ left, bottom, len, style, children }: { left: number; bottom: number; len: number; style: object; children: React.ReactNode }) {
  const hh = 14;
  return <Text numberOfLines={1} style={[{ position: "absolute", width: len, height: hh, lineHeight: hh, left: left + hh / 2 - len / 2, top: bottom - len / 2 - hh / 2, transform: [{ rotate: "-90deg" }] }, style]}>{children}</Text>;
}

// ── 盒盖 ───────────────────────────────────────────────────────────────────────────
/** 跳过的站在路线页上的淡度(同当天页) */
export const SKIP_DIM = 0.45;
const skipDim = (s: Pick<Stop, "skipped">) => (s.skipped ? { opacity: SKIP_DIM } : null);
/** 盒盖英文名:一行能缩到 LID_MIN 以内放下=一行(下限 LID_MIN);放不下且有空格=在最靠中间的空格折成两行;
 *  他自己写了两行(带换行)=照他的两行。natW=这一行按原字号的实际宽(没量出来之前先按一行画) */
export const LID_MIN = 0.7;
/** 两行时(他写的两行,或一行放不下折成的两行)每行最小缩到 0.5,再放不下才截短(她 10-25 拍) */
export const LID_MIN2 = 0.5;
const LID_W1 = 390 - 36 - 24;
export function lidLines(n1: string, n2: string | null | undefined, natW: number | null, avail = LID_W1, min = LID_MIN): [string, string | null] {
  if (n2) return [n1, n2];
  if (natW == null || natW * min <= avail) return [n1, null];
  const sp = [...n1.matchAll(/ /g)].map((m) => m.index!);
  if (!sp.length) return [n1, null];
  const mid = n1.length / 2;
  const at = sp.reduce((b, i) => (Math.abs(i - mid) < Math.abs(b - mid) ? i : b), sp[0]);
  return [n1.slice(0, at).trim(), n1.slice(at + 1).trim()];
}
/** 中文名单行的宽度预算(放不下按比例缩、到下限截短「⋯」;fitZh 有单测) */
export const ZH_FIT = {
  lid: { base: 18, min: 12, k: 0.4, width: 270 },     // 盒盖:left 96 到右边留 24
  mini: { base: 11, min: 9, k: 0.35, width: 196 },    // 平铺页迷你请柬:236 宽两侧各让 20
} as const;

/** The lid on a short screen: 「打开 / BREAK THE SEAL」 (72 tall, at seam − 136 so it ends 8 above the seal, which
 *  starts 56 above the seam) must stay clear of the title block (150..430, the block's foot + 10 below it). The block
 *  first moves up (lift, at most 130: its first line then starts at 20), then on a still shorter screen is also made
 *  smaller (k, about its top centre, not under 0.6). As designed when seam ≥ 576. Pure, tested. */
export function lidTitle(seam: number): { lift: number; k: number } {
  const lift = Math.max(0, Math.min(130, 440 + 72 + 8 + 56 - seam));
  const k = Math.max(0.6, Math.min(1, (seam - 136 - 10 - 150 + lift) / 280));
  return { lift, k };
}
/** Where 「打开」 sits: under the title block's foot (+10), and above the seal when there is room (pure, tested). */
export const lidOpenTop = (seam: number) => { const { lift, k } = lidTitle(seam); return Math.max(150 + 280 * k + 10 - lift, Math.min(500, seam - 56 - 80)); };

function Lid({ plan, P, M, ph, onOpen }: { plan: Plan; P: Skin; M: MapPal; ph: number; onOpen: () => void }) {
  const zhLid = titleZh(plan) ? fitZh(titleZh(plan)!, ZH_FIT.lid.base, ZH_FIT.lid.min, ZH_FIT.lid.k, ZH_FIT.lid.width) : null;
  const c = planCol(plan.color), ink = c.t, seam = Math.min(664, ph - 116), title = lidTitle(seam);
  const [n1, n2] = titleLines(plan);
  // 一行英文名按原字号的实际宽(网页上用 canvas 按页面字体实测;字体到之前量不出=先按一行)
  const natW = n2 ? null : naturalWidth(n1, FF.script, 118);
  const [t1, t2] = lidLines(n1, n2, natW);
  const dp = dateParts(plan.date);
  // 盒盖按住往上推跟手;推不够落回去;点一下=揭封贴再掀)
  const drag = useSharedValue(0);
  const movedSV = useSharedValue(0);
  const peel = useSharedValue(0), up = useSharedValue(0);
  const [gone, setGone] = useState(false);
  const busy = useRef(false);
  const open = () => {
    if (busy.current) return; busy.current = true;
    peel.value = withTiming(1, { duration: 500, easing: Easing.bezier(0.5, 0, 0.3, 1) });
    up.value = withDelay(520, withTiming(1, { duration: 1150, easing: Easing.bezier(0.6, 0, 0.2, 1) }));
    drag.value = withTiming(0, { duration: 1 });
    setTimeout(() => { setGone(true); onOpen(); }, 1750);
  };
  const snapBack = () => {
    if (busy.current) return;
    drag.value = withSpring(0, { damping: 14, stiffness: 170 });
    peel.value = withTiming(0, { duration: 260 });
  };
  const tapOpen = () => {
    if (busy.current) return;
    peel.value = withTiming(1, { duration: 120 });
    setTimeout(open, 480); // 原型:点一下先揭封标,停 480ms 再整体掀开
  };
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .onBegin(() => { movedSV.value = 0; })
        .onUpdate((e) => {
          if (Math.abs(e.translationY) > 6) movedSV.value = 1;
          drag.value = lidDragY(e.translationY);
          peel.value = 1;
        })
        .onEnd((e) => {
          if (movedSV.value === 0) { runOnJS(tapOpen)(); return; }
          if (lidOpenDecision(drag.value, e.velocityY)) runOnJS(open)();
          else runOnJS(snapBack)();
        }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const lidSt = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value + -ph * 1.04 * up.value }, { rotate: `${drag.value / ph * 3 + -3 * up.value}deg` }] }));
  const sealSt = useAnimatedStyle(() => ({ opacity: 1 - peel.value, transform: [{ translateX: 60 * peel.value }, { translateY: -90 * peel.value }, { rotate: `${-6 + 40 * peel.value}deg` }, { scale: 1 - 0.1 * peel.value }] }));
  if (gone) return null;
  return (
    <FlightSpot k={`box:${plan.id}`} style={[{ position: "absolute", left: 0, top: 0, width: 390, height: ph, zIndex: 20 }, lidSt]}>
      {/* 点一下单独一个 Tap(纯点击时 Pan 不进入激活态,onEnd 不来——模拟器实测点了不开) */}
      <GestureDetector gesture={Gesture.Race(pan, Gesture.Tap().maxDuration(500).onEnd(() => { runOnJS(tapOpen)(); }))}>
      <View style={{ flex: 1, backgroundColor: c.c }} accessibilityLabel="打开纪念盒" testID="box-lid">
        <PaperTex opacity={0.6} />
        <View style={{ position: "absolute", left: 0, right: 0, top: seam, bottom: 0, backgroundColor: rgba(P.sh, 0.1), borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.6)" }} />
        <View style={{ position: "absolute", left: 9, right: 9, top: 9, height: seam - 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.55)" }} />
        <VCap left={26} bottom={Math.min(560, seam - 40)} len={420} style={{ fontFamily: FF.pf7, fontSize: 8, letterSpacing: 3.2, color: ink }}>{`NO. ${paperNo(plan)}  ·  A KEEPSAKE BOX  ·  ${dp.dot}`}</VCap>
        {/* 标题区一整块:矮屏先上移、再缩小(lidTitle),给「打开」让出封标上沿之上的位置 */}
        <View testID="lid-title" pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: 390, height: 440, transform: [{ translateY: -title.lift }, { scale: title.k }], transformOrigin: "195px 150px" }}>
          {/* 英文名每行单行:盒盖右边留 24,放不下按比例缩、到下限截短(FitLine) */}
          {/* 英文名:先一行缩到原字号的 LID_MIN,还放不下就在词边界折成两行(用原设计的两行位置),两行时每行最小 LID_MIN2,最后才截短 */}
          <FitLine testID="lid-t1" minScale={t2 ? LID_MIN2 : LID_MIN} style={[{ position: "absolute", left: 36, top: 150, width: LID_W1, fontFamily: FF.script, paddingRight: 8, fontSize: 118, lineHeight: 120, color: ink }, pressIn]}>{t1}</FitLine>
          {t2 ? <FitLine testID="lid-t2" minScale={LID_MIN2} style={[{ position: "absolute", left: 92, top: 262, width: 390 - 92 - 24, fontFamily: FF.script, paddingRight: 8, fontSize: 118, lineHeight: 120, color: ink }, pressIn]}>{t2}</FitLine> : null}
          {/* 中文名:英文花体大字照旧,中文小字在下面(小样 archLid:宋体 500 18,字距 .4em) */}
          {zhLid ? <Text testID="lid-zh" numberOfLines={1} style={[{ position: "absolute", left: 96, top: 372, width: 270, fontFamily: FF.serif5, fontSize: zhLid.size, letterSpacing: zhLid.size * 0.4, color: ink }, pressIn]}>{zhLid.text}</Text> : null}
          <View style={{ position: "absolute", left: 50, top: 408, width: 150, height: 1, backgroundColor: ink, opacity: 0.6 }} />
          <Text style={{ position: "absolute", left: 50, top: 420, fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 2.2, color: ink }}>KEPT BY THE TWO OF US</Text>
        </View>
        {/* 「打开 / BREAK THE SEAL」跟着封口走:封口贴纸在 seam 上下各 56,整块(约 72 高)收在贴纸上沿之上(矮屏原来被贴纸盖住) */}
        {/* 下限 440:不往上撞标题区(英文名两行到 382、横线与 KEPT BY 在 408-430);矮屏标题区整块上移 lift,让出封标上沿之上的位置 */}
        <View testID="lid-open" style={{ position: "absolute", left: 95, right: 95, top: lidOpenTop(seam), alignItems: "center" }}>
          <Text style={[{ fontFamily: FF.serif9, fontSize: 28, letterSpacing: 19.6, marginLeft: 19.6, color: ink }, pressIn]}>打开</Text>
          <FoilLine w={140} style={{ position: "absolute", top: 44 }} />
          <Text style={{ marginTop: 14, fontFamily: FF.pf7, fontSize: 8, letterSpacing: 3.4, color: ink, opacity: 0.85 }}>BREAK THE SEAL</Text>
        </View>
        <Animated.View style={[{ position: "absolute", left: 195 - 56, top: seam - 56, width: 112, height: 112, ...shapeShadow("#000", 0.18, 3, 2) }, sealSt]} pointerEvents="none">
          <SvgXml xml={boxMarkXml({ no: paperNo(plan), d: dp.dot, kinds: stopsMain(plan) }, 112, true, M)} width={112} height={112} />
        </Animated.View>
      </View>
      </GestureDetector>
    </FlightSpot>
  );
}

// ── 平铺页 ──────────────────────────────────────────────────────────────────────────
function MiniStrip({ plan, P, skin }: { plan: Plan; P: Skin; skin: SkinKey }) {
  const W = 140, SEG = 92, n = plan.stops.length, H = 56 + SEG * n, seps = plan.stops.map((_, k) => 56 + SEG * k);
  return (
    <View style={{ width: W, height: H }}>
      <Paper w={W} h={H} d={stripPath(W, H, seps, 6, 3, 10)} fill={P.paper} sh={P.sh} texture={0.6} />
      <FitText numberOfLines={1} adjustsFontSizeToFit style={{ position: "absolute", left: 6, right: 6, top: 16, textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 17, color: P.deep }}>{titleOne(plan)}</FitText>
      {plan.stops.map((s, i) => {
        const y = 56 + SEG * i, c = segC(skin, i);
        return (
          <View key={s.stop_id} style={{ position: "absolute", left: 0, right: 0, top: y, height: SEG }}>
            <Text style={{ position: "absolute", left: 10, top: 12, fontFamily: FF.pf9, fontSize: 20, color: P.deep }}>{two(i)}</Text>
            {/* 平铺页小条:栏宽只有 66,只写英文大类(细类写在路线页/当天页/地图页);长的一类(SOMETHING WE DID)缩字不折行 */}
            <FitText numberOfLines={1} adjustsFontSizeToFit style={{ position: "absolute", left: 11, top: 38, width: 66, fontFamily: FF.pf7, fontSize: 5, letterSpacing: 1, color: P.ink, opacity: 0.7 }}>{kindLine({ kind: s.kind, time: s.time })}</FitText>
            <Text style={{ position: "absolute", left: 12, top: 56, fontFamily: FF.pf7, fontSize: 11, color: P.ink }}>{s.time}</Text>
            <View style={{ position: "absolute", left: 80, right: 7, top: 7, bottom: 7, backgroundColor: c.bg, overflow: "hidden" }}>
              <StopArt s={s} color={c.art} inv style={{ left: -10, right: -10, top: -8, height: 96 }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** k=放大倍数(平铺页那张 1;拿起来看 1.42):按 k 倍真排版,不靠 transform 放大位图(iOS 放大后文字是拉伸的糊位图;她 10-26「字糊很久」同类) */
function MiniInvite({ plan, P, k = 1 }: { plan: Plan; P: Skin; k?: number }) {
  const W = 236 * k, H = 392 * k, u = (n: number) => n * k;
  const [t1, t2] = titleLines(plan);
  const s0 = plan.stops[0];
  const bring = plan.prep.filter((p) => p.section === "bring").map((p) => p.text).join(" · ");
  const rows: Array<[string, string]> = [["Time", s0?.time ? `${s0.time} 〜` : "—"], ["Meet", s0 ? placeName(s0) : "—"], ["Stops", `${plan.stops.length} 站`], ...(bring ? [["Bring", bring] as [string, string]] : [])];
  const zhRaw = titleZh(plan), dz = zhRaw ? 18 : 0; // 有中文名:标题下多一行小字,下面的表往下让
  const zh = zhRaw ? fitZh(zhRaw, ZH_FIT.mini.base, ZH_FIT.mini.min, ZH_FIT.mini.k, ZH_FIT.mini.width) : null;
  return (
    <View style={{ width: W, height: H }}>
      <Paper w={W} h={H} d={deckle(W, H, 1.8 * k, 4 * k)} fill={P.paper} sh={P.sh} texture={0.6} />
      <View style={{ position: "absolute", left: u(9), top: u(9), right: u(9), bottom: u(9), borderWidth: 1.1 * k, borderColor: P.deep }} />
      <View style={{ position: "absolute", left: u(12), top: u(12), right: u(12), bottom: u(12), borderWidth: 0.5 * k, borderColor: P.deep }} />
      <Art name="florals" color={P.deep} style={{ right: u(10), top: u(10), width: u(60), height: u(60), opacity: 0.4, transform: [{ scaleX: -1 }] }} />
      <View style={{ position: "absolute", left: 0, right: 0, top: u(34), alignItems: "center" }}>
        <Text style={{ fontFamily: FF.script, paddingRight: u(8), fontSize: u(22), color: P.deep }}>{"You're invited"}</Text>
        <FitLine style={{ marginTop: u(8), width: u(ZH_FIT.mini.width), textAlign: "center", fontFamily: FF.pf9, fontSize: u(24), lineHeight: u(24), letterSpacing: u(0.7), color: P.deep }}>{t1.toUpperCase()}</FitLine>
        {t2 ? <FitLine style={{ width: u(ZH_FIT.mini.width), textAlign: "center", fontFamily: FF.pf9, fontSize: u(24), lineHeight: u(24), letterSpacing: u(0.7), color: P.deep }}>{t2.toUpperCase()}</FitLine> : null}
        {zh ? <Text testID="invite-zh" numberOfLines={1} style={{ marginTop: u(6), marginLeft: u(zh.size * 0.35), maxWidth: u(ZH_FIT.mini.width), fontFamily: FF.serif5, fontSize: u(zh.size), lineHeight: u(14), letterSpacing: u(zh.size * 0.35), color: P.deep }}>{zh.text}</Text> : null}
        <Text style={{ marginTop: u(14), fontFamily: FF.pf7, fontSize: u(16), color: P.ink }}>{dateParts(plan.date).long}</Text>
      </View>
      <View style={{ position: "absolute", left: u(24), right: u(24), top: u(176 + dz) }}>
        {rows.map(([key, v]) => (
          <View key={key} style={{ flexDirection: "row", borderTopWidth: 0.6 * k, borderTopColor: rgba(P.sh, 0.3), paddingVertical: u(7) }}>
            <Text style={{ width: u(62), paddingTop: u(2), fontFamily: FF.pf7, fontSize: u(6), letterSpacing: u(1.3), color: P.deep }}>{key.toUpperCase()}</Text>
            <Text numberOfLines={2} style={{ flex: 1, fontFamily: FF.serif5, fontSize: u(10), lineHeight: u(15), color: P.ink }}>{v}</Text>
          </View>
        ))}
      </View>
      <Text style={{ position: "absolute", left: u(24), bottom: u(22), fontFamily: FF.script, paddingRight: u(8), fontSize: u(15), color: P.deep, transform: [{ rotate: "-6deg" }] }}>Good company makes a good day.</Text>
      <SvgBox xml={stampXml(`OPENED · KEPT · ${dateParts(plan.date).dot} · `, "", P.deep, u(66), undefined, 1.6 * k)} w={u(66)} h={u(66)} style={{ right: u(18), bottom: u(52), opacity: 0.8, transform: [{ rotate: "-12deg" }] }} />
    </View>
  );
}

function PackBody({ plan, P, W, H, mini }: { plan: Plan; P: Skin; W: number; H: number; mini?: boolean }) {
  const f = mini ? 0.58 : 1;
  const [t1, t2] = titleLines(plan);
  return (
    <View style={{ width: W, height: H, ...shapeShadow(`rgb(${P.sh})`, 0.3, 10, 8) }}>
      <Paper w={W} h={H} d={zig(W, H)} fill={P.ink} sh={P.sh} shadow="none" texture={0} />
      <View style={{ position: "absolute", left: 0, top: 0, width: W, height: H, overflow: "hidden" }}>
        <Image source={CRINKLE} resizeMode="repeat" style={{ position: "absolute", left: 0, top: 0, width: W, height: H, opacity: 0.22, mixBlendMode: "screen" } as never} />
      </View>
      <View style={{ position: "absolute", left: 12 * f, right: 12 * f, top: 44 * f }}>
        {[t1, t2].map((t, q) => <FitLine key={q} style={{ textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 30 * f, lineHeight: 26 * f, color: P.deep }}>{t}</FitLine>)}
      </View>
      <View style={{ position: "absolute", left: W / 2 - 40 * f, top: 118 * f, width: 80 * f, height: 100 * f, borderRadius: 999, borderWidth: 1, borderColor: P.deep }} />
      <Svg style={{ position: "absolute", left: W / 2 - 16 * f, top: 142 * f }} width={32 * f} height={28 * f} viewBox="0 0 32 28"><Path d="M16 27 C6 19 0 13 0 7.5 C0 3 3.5 0 8 0 C11.5 0 14.5 2.5 16 5 C17.5 2.5 20.5 0 24 0 C28.5 0 32 3 32 7.5 C32 13 26 19 16 27Z" fill={P.deep} /></Svg>
      <Text style={{ position: "absolute", left: 0, right: 0, top: 178 * f, textAlign: "center", fontFamily: FF.pf9, fontSize: 13 * f, color: P.deep }}>{`Nº ${paperNo(plan)}`}</Text>
      <Text style={{ position: "absolute", left: 0, right: 0, top: 228 * f, textAlign: "center", fontFamily: FF.pf7, fontSize: 6.5 * f, letterSpacing: 1.3, color: P.deep }}>LIMITED · ONE OF ONE</Text>
    </View>
  );
}

/** 「请他补寄」能请的几样(给她看的名字;事件卡后续 wb_after 一并请,但不列给她) */
const ASK_SHOWN: Record<string, string> = { invite: "迟到的请柬", contract: "契约书", card: "小卡", quote: "那一句话", reply: "回信" };
export const askLines = (names: string[]) => [names.slice(0, 2), names.slice(2, 4)].filter((x) => x.length).map((x) => x.join(" · ")).join("\n");
export const askShown = (pending: string[] | undefined) => (pending ?? []).filter((w) => w in ASK_SHOWN).map((w) => ASK_SHOWN[w]);

/** 平铺页上一张还没写的小卡——他还没写的几样 +「请他补寄」;按一次全部请,马上叫醒他一轮。
 *  请过=「已经请他了」;叫醒没成=写明、可再请一次。没有可请的=不出现 */
function AskSlip({ plan, P, onAsk, onWriteFirst }: { plan: Plan; P: Skin; onAsk: () => Promise<void>; onWriteFirst: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wr = plan.write_request;
  const names = askShown(wr?.pending);
  const askedNow = !!wr && (wr.state === "queued" || wr.state === "sent");
  // 请成功(asked 从没有变有)那一拍——盖一个邮戳,一张折好的小卡飞出去,那一行文字跟着换
  const stampT = useSharedValue(0);
  const note = useSharedValue(0);
  const [noteOn, setNoteOn] = useState(false);
  const everAsked = useRef(askedNow);
  useEffect(() => {
    if (askedNow && !everAsked.current) {
      stampT.value = 0;
      stampT.value = withTiming(1, { duration: ASK_STAMP_MS, easing: Easing.bezier(0.55, 0, 0.8, 0.2) });
      setNoteOn(true);
      note.value = 0;
      note.value = withTiming(1, { duration: ASK_NOTE_FLY_MS, easing: Easing.bezier(0.45, 0.05, 0.4, 1) }, (fin) => { if (fin) runOnJS(setNoteOn)(false); });
    }
    everAsked.current = askedNow;
  }, [askedNow]); // eslint-disable-line react-hooks/exhaustive-deps
  const stampSt = useAnimatedStyle(() => ({ opacity: stampT.value, transform: [{ scale: 2.2 - 1.2 * Math.min(1, stampT.value / 0.78) }, { rotate: `${-34 + 22 * Math.min(1, stampT.value / 0.78)}deg` }] }));
  const noteSt = useAnimatedStyle(() => {
    const t = note.value;
    // 原型 ask.onclick 三段位移:slip 口 → 抬起一点 → 飞出右上角
    const x = t < 0.35 ? 40 * (t / 0.35) : 40 + (390 - 40) * ((t - 0.35) / 0.65);
    const y = t < 0.35 ? -70 * (t / 0.35) : -70 - 60 * ((t - 0.35) / 0.65);
    return { opacity: t < 0.35 ? t / 0.35 : 0.9, transform: [{ translateX: x }, { translateY: y }, { rotate: `${8 + 18 * t}deg` }, { scale: 1 - 0.38 * t }] };
  });
  // "please write" only when at least one path reaches the AI (engine: write_request.available); writing it yourself stays
  const canAsk = wr?.available !== false;
  if (plan.status !== "done" || !wr || !names.length) return null;
  if (!canAsk && !writableFirst(wr.pending).length) return null;
  const asked = askedNow;
  const failed = wr.state === "failed";
  const go = async () => {
    if (busy || asked) return;
    setBusy(true); setErr(null);
    try { await onAsk(); } catch (e) { setErr(`没请成 · ${(e as Error).message}`); } finally { setBusy(false); }
  };
  // 「我先写一样」:他还没写的迟到的请柬 / 契约书 / 小卡,她可以先写(请过他以后也可以)
  const self = writableFirst(wr.pending).length > 0;
  const W = 196, H = self ? 148 : 132;
  return (
    <Pressable onPress={go} disabled={busy || asked || !canAsk} testID="ask-slip" accessibilityLabel={asked ? `已经请${himName()}了` : `请${himName()}补寄`}
      // 有请柬的盒子压在请柬上面
      style={{ position: "absolute", ...(invitePaper(plan) ? { left: 150, top: 470 } : { left: 34, top: 330 }), width: W, height: H, transform: [{ rotate: "-4deg" }], zIndex: invitePaper(plan) ? 6 : 4, opacity: busy ? 0.6 : 1 }}>
      <Paper w={W} h={H} d={deckle(W, H, 1.6, 4)} fill={P.paper} sh={P.sh} texture={0.6} />
      <View style={{ position: "absolute", left: 9, top: 9, right: 9, bottom: 9, borderWidth: 0.8, borderColor: P.deep, borderStyle: "dashed", opacity: 0.55 }} />
      <Text style={{ position: "absolute", left: 20, top: 20, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.6, color: P.ink, opacity: 0.8 }}>NOT YET WRITTEN</Text>
      <Text style={{ position: "absolute", left: 20, top: 32, fontFamily: FF.script, paddingRight: 8, fontSize: 22, color: P.deep }}>{asked ? "On its way" : "Write me back"}</Text>
      {/* 两样一行,不让「那一句话」这种在字中间被折开 */}
      <Text numberOfLines={2} style={{ position: "absolute", left: 20, right: 14, top: 66, fontFamily: FF.serif5, fontSize: 10.5, lineHeight: 15, color: P.ink }}>{askLines(names)}</Text>
      {canAsk ? <Text testID="ask-slip-action" style={{ position: "absolute", left: 20, bottom: self ? 34 : 18, fontFamily: FF.serif7, fontSize: 12, letterSpacing: 2.4, color: P.deep, opacity: asked ? 0.6 : 1 }}>
        {asked ? `已经请${himName()}了` : failed ? `没叫醒${himName()} · 再请一次 ›` : `请${himName()}补寄 ›`}
      </Text> : null}
      {self ? (
        <Pressable onPress={onWriteFirst} hitSlop={6} testID="ask-slip-self" accessibilityLabel="我先写一样" style={{ position: "absolute", left: 20, bottom: 12 }}>
          <Text style={{ fontFamily: FF.serif5, fontSize: 10.5, letterSpacing: 1.7, color: P.ink, opacity: 0.75 }}>我先写一样 ›</Text>
        </Pressable>
      ) : null}
      {err ? <Text testID="ask-slip-err" style={{ position: "absolute", left: 4, right: 4, top: H + 8, fontFamily: FF.serif5, fontSize: 11, lineHeight: 16, color: P.ink }}>{err}</Text> : null}
      {askedNow ? (
        <Animated.View testID="ask-slip-stamp" pointerEvents="none" style={[{ position: "absolute", right: 8, bottom: 6, width: 66, height: 66 }, stampSt]}>
          <SvgXml xml={stampXml("WRITE ME BACK", dateParts(plan.date).dot, P.deep, 66)} width={66} height={66} />
        </Animated.View>
      ) : null}
      {noteOn ? (
        <Animated.View testID="ask-slip-note" pointerEvents="none" style={[{ position: "absolute", left: W - 30, bottom: 2, width: 58, height: 40, backgroundColor: P.paper, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 4 }, noteSt]}>
          <Svg style={{ position: "absolute", left: 0, top: 0 }} width={58} height={40} viewBox="0 0 58 40"><Path d="M1 1 L29 22 L57 1" fill="none" stroke={P.deep} strokeWidth={0.8} opacity={0.7} /></Svg>
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

function Flat({ plan, P, skin, onGo, onPop, late, onAsk, onWriteFirst }: { plan: Plan; P: Skin; skin: SkinKey; onGo: (k: string) => void; onPop: (k: "invite" | "prep") => void; late: { posted: string | null; to: string }; onAsk: () => Promise<void>; onWriteFirst: () => void }) {
  const router = useRouter();
  const inv = invitePaper(plan);
  return (
    <View style={{ flex: 1, backgroundColor: P.paper2 }}>
      <PaperTex opacity={0.7} />
      <DepthKids>
      <Text style={{ position: "absolute", right: 22, top: 40, textAlign: "right", fontFamily: FF.script, paddingRight: 8, fontSize: 56, lineHeight: 52, color: P.deep }}>Kept<Text style={{ fontSize: 30 }}>,</Text></Text>
      <Text style={{ position: "absolute", right: 24, top: 100, fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: P.ink }}>{`EVERYTHING FROM ${dateParts(plan.date).dot}`}</Text>
      {/* 在一起的第 N 天(引擎算,起点同「和他的第 N 天」) */}
      {plan.together_day ? <Text testID="flat-together-day" style={{ position: "absolute", right: 24, top: 116, fontFamily: FF.serif5, fontSize: 9, letterSpacing: 1.8, color: P.ink, opacity: 0.8 }}>{`在一起的第 ${plan.together_day} 天`}</Text> : null}
      {!plan.contract && plan.quote ? <Text style={{ position: "absolute", left: 28, top: 668, width: 210, fontFamily: ff(plan.quote, FF.pf7I, FF.serif5), fontSize: 12, lineHeight: 19, color: P.deep, zIndex: 6 }}>{`“${plan.quote}”`}</Text> : null}
      {/* 信封 */}
      <View style={{ position: "absolute", left: -64, top: 96, width: 270, height: 178, transform: [{ rotate: "-10deg" }] }}>
        <Svg style={{ position: "absolute", left: 0, top: -96 }} width={270} height={98}><Path d="M0 98 L135 0 L270 98 Z" fill={P.envBack} /></Svg>
        <Paper w={270} h={178} fill={P.envPaper} sh={P.sh} />
        <Text style={{ position: "absolute", right: 26, top: 84, fontFamily: FF.serif5, fontSize: 11, color: P.deep }}><Text style={{ fontFamily: FF.corm }}>TO : </Text>{herEn()}</Text>
        <Text style={{ position: "absolute", right: 30, bottom: 18, fontFamily: FF.script, paddingRight: 8, fontSize: 24, color: P.deep }} testID="flat-env-from">{envelopeFrom(plan)}</Text>
        {/* 邮票(齿孔纸 + 车站小画)+ 几道波浪邮戳;原型贴纸判不搭 */}
        <Svg style={{ position: "absolute", right: 48, top: 18 }} width={44} height={30} pointerEvents="none">
          {[0, 1, 2].map((k) => <Path key={k} d={`M1 ${7 + k * 8} q5.5 -4 11 0 t11 0 t11 0 t10 0`} fill="none" stroke={P.deep} strokeWidth={1.1} strokeLinecap="round" opacity={0.6} />)}
        </Svg>
        <View style={{ position: "absolute", right: 16, top: 10, width: 42, height: 52, transform: [{ rotate: "4deg" }] }}>
          <Paper w={42} h={52} d={perf(42, 52, 2.5, 8)} fill={P.big.c} sh={P.sh} shadow="paper" />
          <View style={{ position: "absolute", left: 5, right: 5, top: 5, bottom: 5, backgroundColor: P.big.panel, overflow: "hidden" }}>
            <Art name="sc_station" color={P.big.art} inv style={{ left: -2, top: -6, width: 36, height: 54 }} />
          </View>
        </View>
      </View>
      {/* 请他补寄:他还没写的几样;请柬位置空着时放在它下面 */}
      <AskSlip plan={plan} P={P} onAsk={onAsk} onWriteFirst={onWriteFirst} />
      {/* 拆开的火漆 */}
      <Image source={SEAL_BOW} style={{ position: "absolute", left: 118, top: 244, width: 54, height: 54, transform: [{ rotate: "-24deg" }], zIndex: 2 }} />
      {/* 连票 → 路线页 */}
      <Pressable onPress={() => onGo("route")} style={{ position: "absolute", left: 262, top: 150, transform: [{ rotate: "5deg" }], zIndex: 3 }} accessibilityLabel="路线">
        <MiniStrip plan={plan} P={P} skin={skin} />
      </Pressable>
      {/* 契约书 → 契约书页 */}
      {plan.contract ? (
        <Pressable onPress={() => onGo("contract")} style={{ position: "absolute", left: -34, top: 548, width: 220, height: 300, transform: [{ rotate: "9deg" }], zIndex: 3 }} accessibilityLabel="契约书">
          <Paper w={220} h={300} d={deckle(220, 300, 1.8, 4)} fill={P.paper} sh={P.sh} texture={0.6} />
          <View style={{ position: "absolute", left: 10, top: 10, right: 10, bottom: 10, borderWidth: 1.1, borderColor: P.deep }} />
          <Text style={{ position: "absolute", left: 0, right: 0, top: 26, textAlign: "center", fontFamily: FF.pf9, fontSize: 15, letterSpacing: 0.9, color: P.deep }}>DATE AGREEMENT</Text>
          <Text style={{ position: "absolute", left: 0, right: 0, top: 47, textAlign: "center", fontFamily: FF.serif5, fontSize: 8, letterSpacing: 4, color: P.ink }}>约 会 契 约 书</Text>
          {[0, 1, 2, 3].map((k) => <View key={k} style={{ position: "absolute", left: 26, right: 44 + k * 14, top: 74 + k * 14, borderTopWidth: 0.6, borderTopColor: rgba(P.sh, 0.35) }} />)}
        </Pressable>
      ) : null}
      {/* 请柬:点了拿起来看。他写了迟到的请柬=那张;从没寄出过、他也还没写=这个位置空着 */}
      {inv ? (
        <Pressable onPress={() => onPop("invite")} style={{ position: "absolute", left: 30, top: 188, transform: [{ rotate: "-4deg" }], zIndex: 4 }} accessibilityLabel="请柬" testID={`flat-invite-${inv}`}>
          {inv === "late" ? <LateInviteMini plan={plan} P={P} posted={late.posted} to={late.to} /> : <MiniInvite plan={plan} P={P} />}
        </Pressable>
      ) : null}
      {/* 准备清单 */}
      {plan.prep.length ? (
        <Pressable onPress={() => onPop("prep")} style={{ position: "absolute", left: 118, top: 582, width: 169, height: 300, transform: [{ rotate: "-7deg" }], zIndex: 3 }} accessibilityLabel="准备清单">
          {/* 直接按半尺寸画(原来整张 338 宽缩一半=字糊) */}
          <PrepCard plan={plan} her={null} P={P} live={false} k={0.5} />
        </Pressable>
      ) : null}
      {/* 小卡袋 → 小卡页 */}
      {plan.card ? (
        <Pressable onPress={() => onGo("card")} style={{ position: "absolute", left: 236, top: 560, transform: [{ rotate: "15deg" }], zIndex: 5 }} accessibilityLabel="限定小卡">
          <PackBody plan={plan} P={P} W={104} H={156} mini />
        </Pressable>
      ) : null}
      </DepthKids>
    </View>
  );
}

// ── 路线页 ──────────────────────────────────────────────────────────────────────────
// 已结束的约会右上角钢笔尖 → 编辑态(小样 archEditPatch):时间/地名下出细线可改(地名能搜)、线索下是她那一句、
// 末尾淡编号=补一站、点编号章两下=删这一站(引擎只许删她补的,他写的站回原因);他写的字不可点。
// 头部那条日期/名字/书脊(set_plan)只在从没寄出过的那一盒(她补记的)编辑态出现;非编辑态她的一句话照常显示(小爱心 + 字)。
// 她输入的东西不许悄悄丢:被拒=草稿留在那一行 + 引擎原话;补的站没填完/没存上/照片没传上=钢笔尖点了也不退出,那一行写明缺什么。
const RT_ROW = 214;
type NewPhoto = { uri: string; mimeType?: string | null; fileName?: string | null; caption: string; clientId: string };
const errText = (e: unknown) => `没改成 · ${(e as Error).message}`;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// 路线脊线:往下划才画出来(原型 archView upd() 的 drawn/strokeDasharray)
const RoutePathA = Animated.createAnimatedComponent(Path);
/** 每一站:章缩放/透明度随「画到没画到」弹跳过渡(原型 CSS `.rtStamp{transition:scale .55s 弹性,opacity .3s}`);
 * 卡套/文字的滑入位移跟 scrollY 直接走,不加过渡(原型没给这部分转场)。children 是 render-prop,
 * 这样行内原来一大段依赖 RoutePage 自身状态闭包的 JSX 不用拆成另一个顶层组件也能用上这里的 useAnimatedStyle。 */
function RowReveal({ scrollY, ph, top, i, totalLen, children }: {
  scrollY: SharedValue<number>; ph: number; top: number; i: number; totalLen: number;
  children: (stampStyle: object, slideStyle: object, textStyle: object) => React.ReactNode;
}) {
  const y0 = top + 18;
  // 章只在「亮/不亮」翻转那一下起动画(在 mapper 里每次滚动都新起 withTiming=带过冲的曲线每帧从头来,滑的时候章发颤;review)
  const sc = useSharedValue(0.3), op = useSharedValue(0.25);
  useAnimatedReaction(() => stampRevealed(routeDrawn(scrollY.value, ph, y0, totalLen), i, RT_ROW), (on, prev) => {
    if (on === prev) return;
    sc.value = withTiming(on ? 1 : 0.3, calm(550));
    op.value = withTiming(on ? 1 : 0.25, { duration: 300 });
  });
  const stampStyle = useAnimatedStyle(() => ({ transform: [{ scale: sc.value }], opacity: op.value }));
  const slideStyle = useAnimatedStyle(() => {
    const t = sleeveSlideT(scrollY.value, ph, top, i);
    const { dx, dy, rotateDeg, opacity } = sleeveSlideFrom(t);
    return { opacity, transform: [{ translateX: dx }, { translateY: dy }, { rotate: `${rotateDeg}deg` }] };
  });
  const textStyle = useAnimatedStyle(() => {
    const t = sleeveSlideT(scrollY.value, ph, top, i);
    const { dx, opacity } = textSlideFrom(t);
    return { opacity, transform: [{ translateX: dx }] };
  });
  return <>{children(stampStyle, slideStyle, textStyle)}</>;
}

/** 只在值真的变了(不含首次挂载)时跑:引擎那份某个字段变了,只同步那个字段的草稿 */
function useOnChange<T>(v: T, fn: () => void) {
  const prev = useRef(v);
  useEffect(() => { if (prev.current !== v) { prev.current = v; fn(); } }); // eslint-disable-line react-hooks/exhaustive-deps
}

function RoutePage({ plan, her, M, ph, walkKm, onOpen, editing, setEditing, onRun, idle, onUploadNew, leaveRef, hold }: {
  plan: Plan; her: NonNullable<ReturnType<typeof usePlan>["her"]>; M: MapPal; ph: number; walkKm: string | null; onOpen: (i: number) => void;
  editing: boolean; setEditing: (on: boolean) => void; onRun: (ops: HerOp[]) => Promise<Plan>; idle: () => Promise<void>;
  onUploadNew: (stopId: number, p: NewPhoto, onProgress?: (frac: number) => void) => Promise<void>;
  /** 外面(返回键 / 右滑返回 / 底部导航)要离开时问这里:true=可以走(已退出编辑态),false=停在原地、出事的行已写明 */
  leaveRef: { current: (() => Promise<boolean>) | null };
  /** 整盒的其余东西(照片还在传 / 写的没收好)能不能退出编辑态 */
  hold: () => Promise<boolean>;
}) {
  const n = plan.stops.length, canEdit = plan.status === "done", ed = editing && canEdit;
  const liveN = plan.stops.filter((s) => !s.skipped).length;   // 跳过的站不算进页头「N STOPS」与底下的「NN stops」
  // 头部那条(名字/日期/颜色,set_plan)只给从没寄出过的那一盒(她补记的);他写的盒子编辑态不出这条,站也不往下让
  const band = ed && neverSent(plan);
  const top = band ? BF_TOP : 214;
  // 往下划,路线跟着画出来,画到哪站哪站的章才亮,卡套从右边滑进来站好(倒划退回)
  const scrollY = useSharedValue(0);
  const onRouteScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => { scrollY.value = e.nativeEvent.contentOffset.y; };
  const [drafts, setDraftsState] = useState<DraftStop[]>([]);
  const draftsRef = useRef<DraftStop[]>([]);
  const setDrafts = (fn: (ds: DraftStop[]) => DraftStop[]) => { draftsRef.current = fn(draftsRef.current); setDraftsState(draftsRef.current); };
  const adding = useRef(new Map<string, Promise<void>>()); // 正在发 add_stop 的行(同一行只发一次;退出前等它落地)
  const [errs, setErrs] = useState<Record<string, string>>({}); // 行键(s<stop_id> / 草稿 key / band)→ 报错或缺项
  const setRowErr = (k: string, v: string | null) => setErrs((m) => { const x = { ...m }; if (v) x[k] = v; else delete x[k]; return x; });
  const dirty = useRef(new Set<string>()); // 有没存上的草稿的行
  const markDirty = (k: string, on: boolean) => { if (on) dirty.current.add(k); else dirty.current.delete(k); };
  const [seeds, setSeeds] = useState<Record<number, Seed>>({}); // 补的站建好后要补交的在途内容
  const [pending, setPendingState] = useState<Record<number, NewPhoto>>({}); // 补的站的照片:传成功前一直留着(可原地重试)
  const pendingRef = useRef<Record<number, NewPhoto>>({});
  const setPending = (fn: (m: Record<number, NewPhoto>) => Record<number, NewPhoto>) => { pendingRef.current = fn(pendingRef.current); setPendingState(pendingRef.current); };
  const [armed, setArmed] = useState<string | null>(null);
  const [searchAt, setSearchAt] = useState<string | null>(null);
  // 失焦后候选再留 250ms(让那一下点得到);这段时间里又回到某一格=取消收起,不然旧计时会把刚出来的候选收掉
  const searchT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchFocus = (k: string, on: boolean) => {
    if (searchT.current) { clearTimeout(searchT.current); searchT.current = null; }
    if (on) setSearchAt(k); else searchT.current = setTimeout(() => setSearchAt((x) => (x === k ? null : x)), 250);
  };
  const [newPhotoAt, setNewPhotoAt] = useState<string | null>(null);
  const search = usePlaceSearch();
  const rows = n + (ed ? drafts.length : 0);
  const addY = top + rows * RT_ROW;
  const bandY = ed ? addY + 60 : top + n * RT_ROW + 6;
  const H = bandY + 76 + 150;
  const kept = plan.stops.filter((s) => her.photos.some((p) => p.stop_id === s.stop_id)).length;
  const [opening, setOpening] = useState<number | null>(null);
  const arm = (key: string, go: () => void) => {
    if (armed !== key) { setArmed(key); setTimeout(() => setArmed((a) => (a === key ? null : a)), 2600); return; }
    setArmed(null); go();
  };
  /** 补的那一站的照片:传;失败=照片和目标站都留着,那一行写原话,点卡套原地重试 */
  const uploading = useRef(new Set<number>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const uploadPending = async (sid: number) => {
    const ph = pendingRef.current[sid];
    if (!ph || uploading.current.has(sid)) return;
    uploading.current.add(sid);
    setRowErr(`p${sid}`, "照片上传中");  // 状态提示:那一行写在等什么
    try {
      await onUploadNew(sid, ph, (f) => { if (mounted.current && uploading.current.has(sid)) setRowErr(`p${sid}`, `照片上传中 ${Math.round(f * 100)}%`); });
      if (!mounted.current) return;
      setPending((m) => { const x = { ...m }; delete x[sid]; return x; });
      setRowErr(`p${sid}`, null);
    } catch (e) {
      console.warn("[PhotoFlow] 补站照片上传没成", e);
      if (mounted.current) setRowErr(`p${sid}`, `没收好 · ${(e as Error).message} · 点卡套再试一次`);
    } finally {
      uploading.current.delete(sid);
    }
  };
  const tap = (i: number) => {
    const sid = plan.stops[i].stop_id;
    if (ed && pendingRef.current[sid]) { uploadPending(sid); return; }
    if (ed) { onOpen(i); return; }
    setOpening(i); setTimeout(() => { onOpen(i); setOpening(null); }, 620);
  };
  /** 补的那一站:类型和地名都有了才发 add_stop。在途期间她接着写的(时间/一句话/地名/类型)交给建好的那一站补交,照片留到传成功 */
  const tryAdd = (key: string) => {
    const d = draftsRef.current.find((x) => x.key === key);
    if (!d || !d.kind || !d.title.trim() || adding.current.has(key)) return;
    setRowErr(key, null);
    const job = (async () => {
      let p: Plan;
      try { p = await onRun([addStopOp(d)]); } catch (e) { setRowErr(key, errText(e)); return; }
      const sid = p.stops[p.stops.length - 1]?.stop_id;
      const cur = draftsRef.current.find((x) => x.key === key) ?? d;
      if (sid == null) return;
      const seed = seedFromDiff(d, cur);
      if (seed) setSeeds((m) => ({ ...m, [sid]: seed }));
      if (cur.photo) setPending((m) => ({ ...m, [sid]: cur.photo! }));
      setDrafts((ds) => ds.filter((x) => x.key !== key));
      if (cur.photo) await uploadPending(sid);
    })().finally(() => adding.current.delete(key));
    adding.current.set(key, job);
  };
  const patchDraft = (key: string, part: Partial<DraftStop>) => {
    setDrafts((ds) => ds.map((x) => (x.key === key ? { ...x, ...part } : x)));
    if (part.kind || part.title !== undefined) setRowErr(key, null);
  };
  /** 钢笔尖:进编辑态;退出时先让失焦提交跑完,有没填完/没存上/照片没传上的就不退出,那一行写明缺什么 */
  /** 能不能离开编辑态:先让失焦提交和在途补站落地;没填完的补站/没存上的改动/没传上的照片=不能,出事的行写明缺什么 */
  const settle = async (): Promise<boolean> => {
    Keyboard.dismiss();
    await tick();
    await idle();
    await Promise.all([...adding.current.values()]);
    await idle();
    await tick();
    setDrafts((ds) => ds.filter((d) => !isBlank(d))); // 点了加一站又什么都没写的空行:没东西可丢,直接收掉
    const left = draftsRef.current;
    for (const d of left) setRowErr(d.key, missingLabel(d) ?? errsRef.current[d.key] ?? "没改成");
    if (left.length || dirty.current.size || Object.keys(pendingRef.current).length) return false;
    setErrs({}); setArmed(null); search.clear(); setSeeds({});
    setEditing(false);
    return true;
  };
  const pen = async () => { if (!ed) { setEditing(true); return; } if (await hold()) await settle(); };
  leaveRef.current = async () => (ed ? settle() : true);
  const errsRef = useRef(errs);
  errsRef.current = errs;
  const routeLen = rows > 1 ? (rows - 1) * RT_ROW : 0; // 脊线总长(往下划要画到这么长)
  const spineY0 = top + 18;
  const spineAnimatedProps = useAnimatedProps(() => {
    const drawn = routeDrawn(scrollY.value, ph, spineY0, routeLen);
    return { strokeDasharray: [routeLen, routeLen], strokeDashoffset: routeLen - drawn, strokeOpacity: drawn < 2 ? 0 : 1 };
  });
  // 底下那条粗的描边线一起画(原型两条 path 同进同退;没画到时连圆头也不露)
  const landAnimatedProps = useAnimatedProps(() => {
    const drawn = routeDrawn(scrollY.value, ph, spineY0, routeLen);
    return { strokeDasharray: [routeLen, routeLen], strokeDashoffset: routeLen - drawn, strokeOpacity: drawn < 2 ? 0 : 1 };
  });
  const scroll = (
    <>
      <DepthKids>
      <View style={{ position: "absolute", left: 22, right: 22, top: 70, paddingTop: 10, borderTopWidth: 1, borderTopColor: M.ink }}>
        <Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.8, color: M.ink, opacity: 0.8 }}>{`NO. ${paperNo(plan)} · ${dateParts(plan.date).dot} · ${stopsLabel(liveN)}`}</Text>
        <Text style={{ marginTop: 10, fontFamily: FF.pf9, fontSize: 40, lineHeight: 38, letterSpacing: -0.8, color: M.title }}>{"The Way\nWe Went"}</Text>
        <Text style={{ marginTop: 8, fontFamily: FF.serif5, fontSize: 12, letterSpacing: 3.6, color: M.ink, opacity: 0.7 }}>那天走过的路</Text>
        {canEdit ? (
          <Pressable onPress={pen} hitSlop={8} style={{ position: "absolute", right: 0, top: 12, width: 30, height: 30, borderRadius: 15, backgroundColor: M.route, alignItems: "center", justifyContent: "center" }} accessibilityLabel="编辑" accessibilityState={{ selected: ed }} testID="box-pen">
            <Svg width={15} height={15} viewBox="0 0 24 24"><Path d="M4 20 L7 13 L15 5 L19 9 L11 17 Z M15 5 L19 9" fill="none" stroke={M.card} strokeWidth={1.6} strokeLinejoin="round" /><Path d="M10.7 14.5 a1.2 1.2 0 1 1 -2.4 0 a1.2 1.2 0 1 1 2.4 0" fill={M.card} /></Svg>
          </Pressable>
        ) : null}
      </View>
      </DepthKids>
      {band ? <PlanBand plan={plan} M={M} onRun={onRun} err={errs.band} setErr={(v) => setRowErr("band", v)} onDirty={(on) => markDirty("band", on)} /> : null}
      <Svg style={{ position: "absolute", left: 0, top: 0 }} width={60} height={H} pointerEvents="none">
        {rows > 1 ? <RoutePathA d={`M36 ${top + 18} V${top + (rows - 1) * RT_ROW + 18}`} stroke={M.land} strokeWidth={6.5} strokeLinecap="round" animatedProps={landAnimatedProps} /> : null}
        {rows > 1 ? (
          <RoutePathA d={`M36 ${top + 18} V${top + (rows - 1) * RT_ROW + 18}`} stroke={M.route} strokeWidth={2.5} strokeLinecap="round" animatedProps={spineAnimatedProps} />
        ) : null}
        {ed && rows < MAX_STOPS ? <Path d={`M36 ${top + (rows - 1) * RT_ROW + 30} V${addY + 10}`} stroke={M.route} strokeWidth={1} strokeLinecap="round" opacity={0.3} /> : null}
      </Svg>
      {/* 翻页远近:每一站一层(编辑态不包——地点候选纸条要跨行压在上面) */}
      {((rowsEl: React.ReactNode) => (ed ? rowsEl : <DepthKids>{rowsEl}</DepthKids>))(plan.stops.map((s, i) => {
        const y = top + i * RT_ROW, r = [-3, 2.5, -2, 3, -2.5, 2][i % 6], k = `s${s.stop_id}`;
        return (
          <RowReveal key={s.stop_id} scrollY={scrollY} ph={ph} top={top} i={i} totalLen={routeLen}>
            {(stampStyle, slideStyle, textStyle) => (
              <View style={{ position: "absolute", left: 0, right: 0, top: y, height: RT_ROW, zIndex: searchAt === k ? 5 : 1 }}>
                <RtStamp n={i + 1} M={M} armed={armed === k} reveal={ed ? undefined : stampStyle} onPress={ed ? () => arm(k, () => { setRowErr(k, null); onRun([removeOp(s.stop_id)]).catch((e) => setRowErr(k, errText(e))); }) : undefined} />
                {ed ? (
                  <EditStop s={s} M={M} search={search} searching={searchAt === k} onRun={onRun} err={errs[k]} kindEditable={kindEditableOf(s, plan)}
                    photoErr={errs[`p${s.stop_id}`]} onPhotoRetry={() => uploadPending(s.stop_id)}
                    seed={seeds[s.stop_id]} onDirty={(on) => markDirty(k, on)}
                    onSearchFocus={(on) => searchFocus(k, on)} />
                ) : (
                  <Animated.View style={[{ position: "absolute", left: 62, top: 2, width: 128 }, textStyle]}>
                    <Text style={[{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.5, color: M.title }, skipDim(s)]}>{kindLine(s)}</Text>
                    {s.skipped ? <Text numberOfLines={2} style={{ marginTop: 2, fontFamily: FF.serif5, fontSize: 9.5, lineHeight: 13, color: M.title }}>{`跳过了${s.skip_reason ? `：${s.skip_reason}` : ""}`}</Text> : null}
                    {/* 跳过的站:时间、站名、线索一起变淡(同当天页 0.45);「跳过了：原因」那行不淡 */}
                    <Text testID={s.skipped ? `route-skipped-time-${s.stop_id}` : undefined} style={[{ marginTop: 3, fontFamily: FF.pf9, fontSize: 27, color: M.ink }, skipDim(s)]}>{s.time}</Text>
                    <Text numberOfLines={2} style={[{ marginTop: 7, fontFamily: FF.serif7, fontSize: 14.5, lineHeight: 19.5, color: M.ink }, skipDim(s)]}>{placeName(s)}</Text>
                    {s.clue ? <Text style={{ marginTop: 12, paddingLeft: 9, borderLeftWidth: 1.5, borderLeftColor: M.route, fontFamily: ff(s.clue, FF.pfI, FF.serif), fontSize: 12, lineHeight: 19, color: M.ink, opacity: s.skipped ? 0.85 * SKIP_DIM : 0.85 }}>{`“${s.clue}”`}</Text> : null}
                    <HerLine value={s.her_line ?? ""} M={M} editable={false} marginTop={10} />
                  </Animated.View>
                )}
                <Pressable onPress={() => tap(i)} style={{ position: "absolute", left: 196, top: 6, width: 172, height: 168, transform: [{ rotate: `${r}deg` }] }} accessibilityLabel={`打开第 ${i + 1} 站的卡套`} testID={`box-sleeve-${s.stop_id}`}>
                  <Animated.View style={ed ? undefined : slideStyle}>
                    {latestPhoto(her.photos, s.stop_id) ? <PhotoPeek testID={`box-peek-${s.stop_id}`} /> : null}
                    <RouteSleeve paper={paperOf(s)} s={s} i={i} M={M} opening={opening === i} seen={has(her, `sleeve:${s.stop_id}`)} />
                  </Animated.View>
                </Pressable>
              </View>
            )}
          </RowReveal>
        );
      }))}
      {ed ? drafts.map((d, j) => (
        <DraftRow key={d.key} s={d} i={n + j} M={M} top={top} armed={armed === d.key} searching={searchAt === d.key} search={search} err={errs[d.key]}
          onStamp={() => arm(d.key, () => { setDrafts((ds) => ds.filter((x) => x.key !== d.key)); setRowErr(d.key, null); })}
          onPatch={(part) => { patchDraft(d.key, part); if (part.kind) tryAdd(d.key); }}
          onTitleCommit={() => tryAdd(d.key)} onRetry={() => tryAdd(d.key)}
          onPhoto={() => { Keyboard.dismiss(); setNewPhotoAt(d.key); }}
          onSearchFocus={(on) => searchFocus(d.key, on)} />
      )) : null}
      {ed && rows < MAX_STOPS ? (
        <View style={{ position: "absolute", left: 0, right: 0, top: addY, height: 40 }}>
          <RtStamp n={rows + 1} M={M} faint onPress={() => { Keyboard.dismiss(); setDrafts((ds) => [...ds, blankStop()]); }} />
        </View>
      ) : null}
      <View style={{ position: "absolute", left: 22, right: 22, top: bandY, height: 76, flexDirection: "row", backgroundColor: M.card, borderWidth: 1, borderColor: alpha(M.ink, 0.4) }}>
        {[[String(liveN).padStart(2, "0"), "stops"], ...(walkKm ? [[walkKm, "km walked"]] : []), [String(kept), "photos kept"]].map(([b, l], q) => (
          <View key={l} style={{ flex: 1, alignItems: "center", justifyContent: "center", borderLeftWidth: q ? 1.2 : 0, borderLeftColor: alpha(M.ink, 0.3) }}>
            <Text testID={`route-band-${l.replace(/ /g, "-")}`} style={{ fontFamily: FF.pf9, fontSize: 24, color: M.route }}>{b}</Text>
            <Text style={{ marginTop: 4, fontFamily: FF.pf7, fontSize: 6.5, letterSpacing: 1.3, color: M.ink }}>{l.toUpperCase()}</Text>
          </View>
        ))}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", borderLeftWidth: 1.2, borderLeftColor: alpha(M.ink, 0.3) }}>
          <Text style={{ fontFamily: FF.pf7, fontSize: 8, letterSpacing: 0.8, color: M.ink }}>{`${plan.stops[0]?.time ?? ""} — ${plan.stops[n - 1]?.time ?? ""}`}</Text>
        </View>
      </View>
    </>
  );
  const photoDraft = newPhotoAt ? drafts.find((d) => d.key === newPhotoAt) : null;
  return (
    <View style={{ flex: 1, backgroundColor: M.page }}>
      <PaperTex />
      <AbsKeyboardScroll height={Math.max(H, ph)} bottomOffset={searchAt != null ? placeKbGap(search.hits.length, !!search.errOf(searchAt)) : 40}
        onScroll={onRouteScroll} scrollEventThrottle={16}>
        {scroll}
      </AbsKeyboardScroll>
      {photoDraft ? <DraftPhoto d={photoDraft} i={n + drafts.indexOf(photoDraft)} onClose={() => setNewPhotoAt(null)}
        onDone={(photo) => { patchDraft(photoDraft.key, { photo }); setNewPhotoAt(null); }} /> : null}
    </View>
  );
}

/** 一站有多张时(换照片前的旧数据)以最新那张为准 */
export function latestPhoto(photos: HerPhoto[], stopId: number): HerPhoto | null {
  let best: HerPhoto | null = null;
  for (const p of photos) if (p.stop_id === stopId && (!best || p.created_at > best.created_at || (p.created_at === best.created_at && p.id > best.id))) best = p;
  return best;
}

/** 已结束约会编辑态点卡套:这一站放过照片 → 打开就显示那张(可改小字 / 换一张);没放过=照常选图 */
function StopPhotoFlow({ planId, s, i, ph, P, skin, onClose, onSaved }: {
  planId: number; s: Stop; i: number; ph: HerPhoto | null; P: Skin; skin: SkinKey; onClose: () => void; onSaved: () => void;
}) {
  const [src, setSrc] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  const [srcErr, setSrcErr] = useState<string | null>(null);
  useEffect(() => {
    if (ph) ephemeraApi.photoSource(planId, ph.id).then(setSrc).catch((e) => { console.warn("[PhotoFlow] 已放的照片没取到", e); setSrcErr((e as Error).message || "取不到"); });
  }, [ph?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <PhotoFlow s={s} i={i} P={P} skin={skin} onClose={onClose} onSkip={onClose}
      existing={ph ? { source: src, caption: ph.caption ?? "", error: srcErr } : null}
      onCaption={ph ? async (caption) => { await ephemeraApi.photoCaption(planId, ph.id, caption); onSaved(); } : undefined}
      onDone={async (file, caption, cid, onProgress) => {
        await ephemeraApi.uploadPhoto(planId, s.stop_id, file, caption, cid, onProgress, !!ph);
        onSaved();
      }} />
  );
}

/** 补的那一站在发出去之前选的照片:先留在这一行,站建好了再传。已经选过=打开就显示那张(本地,改小字/换一张都只改草稿) */
function DraftPhoto({ d, i, onClose, onDone }: { d: DraftStop; i: number; onClose: () => void; onDone: (p: NewPhoto) => void }) {
  const { key: skin, P } = useSkin();
  const st: Stop = { n: i + 1, stop_id: -1, kind: d.kind, time: timeValue(d.time) || null, stay_until: null, clue: null, note: null, place: null };
  const had = d.photo ?? null;
  return <PhotoFlow s={st} i={i} P={P} skin={skin} onClose={onClose} onSkip={onClose}
    existing={had ? { source: { uri: had.uri }, caption: had.caption } : null}
    onCaption={had ? async (caption) => onDone({ ...had, caption }) : undefined}
    onDone={async (file, caption, clientId) => onDone({ uri: file.uri, mimeType: file.mimeType, fileName: file.fileName, caption, clientId })} />;
}

const hasCoords = (p: PlaceVal | null | undefined): p is PlaceVal => !!p && typeof p.lat === "number" && typeof p.lng === "number";

/** 一个可编辑字段的本地状态(草稿/最近确认的引擎值/在途),规则在 backfill.ts fieldStep(纯函数,有单测)。
 *  send(v) 发出去并回引擎那份这个字段的值;回执后草稿若在途期间又改过、和最新 base 不同,就再发一次(ready 不过的半截值不自动发) */
function useField<T>(server: T, eq: Eq<T>, send: (v: T, base: T) => Promise<T>, onErr: (e: unknown | null) => void, opts: { init?: T; ready?: (v: T) => boolean; block?: (v: T) => boolean } = {}) {
  const ref = useRef<Field<T>>(fieldInit(server, opts.init === undefined ? server : opts.init));
  const [, force] = useReducer((x: number) => x + 1, 0);
  const step = (ev: FieldEv<T>) => { ref.current = fieldStep(ref.current, ev, eq); force(); };
  const prev = useRef(server);
  useEffect(() => { if (!eq(prev.current, server)) { prev.current = server; step({ t: "server", v: server }); } });
  const commit = () => {
    const f = ref.current;
    if (!fieldShouldSend(f, eq)) return;
    // block:这个值一律不发(所有发送路径都走这里:失焦、重试、回执后的自动补发);草稿留着,没存上=离开照样拦
    if (opts.block?.(f.draft)) return;
    const v = f.draft, base = f.base; // base=这一刻最近确认的引擎值(回执后的自动补发也按回执后的值组包,不用投影里的旧值)
    step({ t: "send" });
    onErr(null);
    send(v, base).then((nv) => {
      prev.current = nv;
      step({ t: "ack", v: nv });
      const g = ref.current;
      if (fieldShouldSend(g, eq) && (opts.ready?.(g.draft) ?? true)) commit();
    }).catch((e) => { step({ t: "fail" }); onErr(e); });
  };
  const f = ref.current;
  return { value: f.draft, set: (v: T) => step({ t: "edit", v }), commit, unsettled: f.inflight || fieldDirty(f, eq), now: () => ref.current };
}

/** 编辑态头部那条(小样 backView 的日期 / 名字 / 书脊):三个字段各一份草稿,改了就发 set_plan;被拒=草稿留着 + 原话(点一下重试) */
type DateVal = { year: string; md: string };
const dateEq: Eq<DateVal> = (a, b) => dateValue(a.year, a.md) === dateValue(b.year, b.md);
const nameEq: Eq<string> = (a, b) => splitTitle(a) === splitTitle(b);
function PlanBand({ plan, M, onRun, err, setErr, onDirty }: {
  plan: Plan; M: MapPal; onRun: (ops: HerOp[]) => Promise<Plan>; err?: string; setErr: (v: string | null) => void; onDirty: (on: boolean) => void;
}) {
  const [ferr, setFerr] = useState<Record<string, string>>({}); // 每个字段自己的报错(别的字段成功不会把它抹掉)
  const errFor = (f: string) => (e: unknown | null) => setFerr((m) => { const x = { ...m }; if (e) x[f] = errText(e); else delete x[f]; return x; });
  useEffect(() => setErr(Object.values(ferr)[0] ?? null), [ferr]); // eslint-disable-line react-hooks/exhaustive-deps
  const serverDate = useMemo(() => ({ year: plan.date.slice(0, 4), md: mdDigits(plan.date) }), [plan.date]);
  const date = useField<DateVal>(serverDate, dateEq, (v) => onRun([planOp(v)]).then((p) => ({ year: p.date.slice(0, 4), md: mdDigits(p.date) })), errFor("date"),
    { ready: (v) => v.year.length === 4 && v.md.length === 4 });
  // 引擎拒英文名(cjk_title_en):原话挂在英文格那一行下面,不进头部那条的总报错
  const [gwNameErr, setGwNameErr] = useState<{ name: string; text: string } | null>(null);
  const name = useField<string>(titleOne(plan), nameEq, (v) => onRun([planOp({ name: v })]).then((p) => titleOne(p)),
    (e) => { if (e && (e as EphemeraError).code === CJK_TITLE_EN) { setGwNameErr({ name: name.value, text: (e as Error).message }); errFor("name")(null); } else errFor("name")(e); },
    { block: (v) => !!enNameError(v) }); // 英文名那格写了中文:任何路径都不发,那一行写明
  const color = useField<string>(plan.color, Object.is, (v) => onRun([planOp({ color: v as PlanColor })]).then((p) => p.color), errFor("color"));
  // 中文名一格:走 set_plan title_zh(空=删)
  const zh = useField<string>(titleZh(plan) ?? "", (a, b) => a.trim() === b.trim(), (v) => onRun([planOp({ nameZh: v })]).then((p) => titleZh(p) ?? ""), errFor("zh"));
  const nameErr = enNameError(name.value) ?? (gwNameErr && gwNameErr.name === name.value ? gwNameErr.text : null);
  const unsettled = date.unsettled || name.unsettled || color.unsettled || zh.unsettled;
  useEffect(() => onDirty(unsettled));
  useEffect(() => () => onDirty(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => { date.commit(); name.commit(); color.commit(); zh.commit(); };
  return (
    <>
      <SpineBand M={M} year={date.value.year} md={date.value.md} name={name.value} nameZh={zh.value} color={color.value as PlanColor} nameErr={nameErr}
        onYear={(year) => date.set({ ...date.value, year })} onMd={(md) => date.set({ ...date.value, md })} onName={name.set} onNameZh={zh.set}
        onColor={(c) => { color.set(c); setTimeout(color.commit, 0); }}
        onDateBlur={date.commit} onNameBlur={name.commit} onNameZhBlur={zh.commit} />
      {err ? <View style={{ position: "absolute", left: 22, top: 308, width: 346 }}><RowErr text={err} M={M} style={{ marginTop: 0, width: 346 }} testID="band-err" onPress={retry} /></View> : null}
    </>
  );
}

/** 编辑态的一站:种类小字照旧;时间、地名下出细线可改(地名能搜);他的线索原样不可点;下面是她那一句。
 *  时间 / 地点(地名+地址+坐标)/ 一句话 / 类型 各一份草稿;seed=补的站在途期间她写的,挂上就补交;
 * 被拒或超时=草稿留着 + 原话,点那一行重试;没存上的都算「没存上」,离开一律拦 */
function EditStop({ s, M, search, searching, onRun, onSearchFocus, err, seed, onDirty, photoErr, onPhotoRetry, kindEditable }: {
  s: Stop; M: MapPal; search: ReturnType<typeof usePlaceSearch>; searching: boolean; onRun: (ops: HerOp[]) => Promise<Plan>; onSearchFocus: (on: boolean) => void;
  /** 这一站整站的报错(删站被拒) */ err?: string; seed?: Seed; onDirty: (on: boolean) => void;
  /** 补的站照片没传上:原话 + 点一下重传 */ photoErr?: string; onPhotoRetry: () => void;
  /** 种类能不能改:按站的 kind_editable(见 kindEditableOf) */ kindEditable?: boolean;
}) {
  const key = `s${s.stop_id}`;
  const [ferr, setFerr] = useState<Record<string, string>>({}); // 每个字段自己的报错(别的字段成功不会把它抹掉)
  const errFor = (f: string) => (e: unknown | null) => setFerr((m) => { const x = { ...m }; if (e) x[f] = errText(e); else delete x[f]; return x; });
  const mine = (p: Plan) => p.stops.find((x) => x.stop_id === s.stop_id);
  const serverPlace = useMemo(() => placeOfStop(s), [s.place?.title, s.place?.address, s.place?.lat, s.place?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  const time = useField<string>(timeDigits(s.time), (a, b) => timeValue(a) === timeValue(b),
    (v) => onRun([timeOp(s.stop_id, v)]).then((p) => timeDigits(mine(p)?.time)), errFor("time"),
    { init: seed?.t, ready: (v) => v.length === 0 || v.length === 4 });
  const place = useField<PlaceVal>(serverPlace, placeEq, (v) => onRun([placeFieldOp(s.stop_id, v)]).then((p) => { const x = mine(p); return x ? placeOfStop(x) : v; }), errFor("place"),
    { init: seed?.title !== undefined ? { title: seed.title, address: seed.hit?.address ?? null, lat: seed.hit?.lat ?? null, lng: seed.hit?.lng ?? null } : undefined });
  const line = useField<string>(s.her_line ?? "", (a, b) => a.trim() === b.trim(), (v) => onRun([lineOp(s.stop_id, v)]).then((p) => mine(p)?.her_line ?? ""), errFor("line"), { init: seed?.line });
  // 地点那格此刻的草稿(选候选那一下同步写进来;改种类离开「一件事」那一笔要带上它)
  const placeNow = useRef<PlaceVal>(serverPlace);
  // 这一站最近一次有坐标的地点(本次编辑里见过的):选「一件事」会被引擎清掉地点,随后又改回别的种类时,
  // 地点那格若没再选候选,就带它——离开一件事的那一笔必须带地点
  const lastPlaced = useRef<PlaceVal | null>(hasCoords(serverPlace) ? serverPlace : null);
  const serverKind = useMemo<KindVal>(() => ({ kind: s.kind, subtype: s.subtype ?? null }), [s.kind, s.subtype]);
  // 组包按字段状态里最近确认的种类(base),不用投影里的 s.kind:快速「普通 → 一件事 → 普通」时,回执后自动补发的那一笔
  // base 已是一件事,得带上地点
  const kind = useField<KindVal>(serverKind, kindEq, (v, base) => {
    const op = kindFieldOp(s.stop_id, v, base.kind, placeForKind(placeNow.current, lastPlaced.current));
    return onRun([op]).then((p) => { const x = mine(p); if (kindOpCarriesPlace(op)) errFor("place")(null); return x ? { kind: x.kind, subtype: x.subtype ?? null } : v; });
  }, errFor("kind"), { init: seed?.kind !== undefined || seed?.subtype !== undefined ? { kind: seed.kind ?? s.kind, subtype: seed.subtype !== undefined ? seed.subtype : (s.subtype ?? null) } : undefined });
  placeNow.current = place.value;
  if (hasCoords(place.value)) lastPlaced.current = place.value;
  /** 种类改成别的、还停在「一件事」上(引擎要同一笔补地点):地点那格的提交改走种类那一笔 */
  // 按字段实时状态判断(在途那一笔是「变成一件事」也算:回执后补发的那一笔就是离开一件事)
  const leavingMoment = () => {
    const f = kind.now();
    return (f.base.kind === "moment" || f.sent?.kind === "moment") && !!f.draft.kind && f.draft.kind !== "moment" && !kindEq(f.draft, f.base);
  };
  const commitPlace = () => (leavingMoment() ? kind.commit() : place.commit());
  const [picking, setPicking] = useState(false);
  const unsettled = time.unsettled || place.unsettled || line.unsettled || kind.unsettled;
  useEffect(() => onDirty(unsettled));
  useEffect(() => () => onDirty(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => { time.commit(); commitPlace(); line.commit(); if (!leavingMoment()) kind.commit(); };
  useEffect(() => { if (seed) retry(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = useRef(false);
  const focused = useRef(false);
  return (
    <>
      {kindEditable ? (
        <>
          {/* 当前类别(同补记页那一行):点开种类表;选「一件事」=地点清掉;从一件事改成别的=要选地点(同一笔发) */}
          <View style={{ position: "absolute", left: 62, top: 2, width: 171, zIndex: 3 }} pointerEvents="box-none">
            <KindChip kind={kind.value.kind} subtype={kind.value.subtype} time={time.value} M={M} onPress={() => setPicking(true)} testID={`edit-kind-${s.stop_id}`} />
          </View>
          <KindPicker visible={picking} kind={kind.value.kind} subtype={kind.value.subtype} M={M} onClose={() => setPicking(false)}
            onPick={(k, sub) => { setPicking(false); kind.set({ kind: k, subtype: k === "moment" ? null : sub }); setTimeout(kind.commit, 0); }} />
        </>
      ) : null}
      <View style={{ position: "absolute", left: 62, top: kindEditable ? 2 + 23 : 2, width: 128 }}>
        {kindEditable ? null : <Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.5, color: M.title }}>{kindLine(s)}</Text>}
        <View style={{ marginTop: 3, alignSelf: "flex-start", borderBottomWidth: 0.6, borderBottomColor: M.ink, paddingBottom: 1 }}>
          <MaskInput value={time.value} template="00:00" example={HINT.time} caret={M.route} testID={`edit-time-${s.stop_id}`}
            onChange={(v) => { time.set(v); if (v.length === 4) setTimeout(time.commit, 0); }}
            onBlur={time.commit}
            style={{ fontFamily: FF.pf9, fontSize: 27, lineHeight: 30, color: M.ink }} />
        </View>
        <View style={{ marginTop: 7 }}>
          <FieldHint show={!place.value.title} text={HINT.place} M={M} testID="edit-place-hint" />
        <CaretInput caret={M.route} value={place.value.title} maxLength={30} autoCorrect={false} multiline blurOnSubmit testID={`edit-title-${s.stop_id}`} accessibilityLabel="地名"
          onChangeText={(v) => { const title = v.replace(/\n/g, ""); place.set({ title, address: null, lat: null, lng: null }); search.query(title, key); }}
          onFocus={() => { focused.current = true; picked.current = false; onSearchFocus(true); }}
          onBlur={() => { focused.current = false; onSearchFocus(false); if (picked.current) { picked.current = false; return; } commitPlace(); }}
          onSubmitEditing={() => search.submit(key)}
          style={{ padding: 0, paddingBottom: 2, fontFamily: FF.serif7, fontSize: 14.5, lineHeight: 19.5, color: M.ink, borderBottomWidth: 0.6, borderBottomColor: M.ink }} />
        <SearchKey search={search} k={key} M={M} testID={`edit-search-${s.stop_id}`} />
        </View>
        {s.clue ? <Text style={{ marginTop: 12, paddingLeft: 9, borderLeftWidth: 1.5, borderLeftColor: M.route, fontFamily: ff(s.clue, FF.pfI, FF.serif), fontSize: 12, lineHeight: 19, color: M.ink, opacity: 0.85 }}>{`“${s.clue}”`}</Text> : null}
        <HerLine value={line.value} onChange={line.set} M={M} editable marginTop={10} testID={`edit-line-${s.stop_id}`} onBlur={line.commit} />
        {!searching ? <RowErr text={search.errOf(key)} M={M} testID={`row-search-err-${key}`} /> : null}
        <RowErr text={err ?? Object.values(ferr)[0]} M={M} testID={`row-err-${key}`} onPress={retry} />
        <RowErr text={photoErr} M={M} testID={`row-photo-err-${key}`} onPress={onPhotoRetry} />
      </View>
      {searching ? <PlaceSlips hits={search.hits} err={search.errOf(key)} notice={search.notice} M={M} onPick={(h) => {
        // 「跳过下一次失焦提交」的标记只对这一个焦点周期有效:输入框还在焦点上=接下来那次失焦不再按手写的提交;
        // 已经失焦(候选还留着那 250ms 里点的)=不会再有失焦,不设标记,直接提交这个候选
        picked.current = focused.current;
        const v = { title: h.title, address: h.address ?? null, lat: h.lat ?? null, lng: h.lng ?? null, source: h.source ?? null, ref: h.provider_id ?? null };
        place.set(v); placeNow.current = v; if (hasCoords(v)) lastPlaced.current = v; search.clear(); Keyboard.dismiss(); setTimeout(commitPlace, 0);
      }} /> : null}
    </>
  );
}

// ── 契约书 ──────────────────────────────────────────────────────────────────────────
/** The quote's line height for a Chinese line (glyph body of a 44 CJK serif fits) */
export const QUOTE_ZH_LH = 56;
function Contract({ plan, P, done, onPress }: { plan: Plan; P: Skin; done: boolean; onPress: () => void }) {
  const q = quoteParts(plan.quote);
  const at = plan.stops[0]?.arrive_at;
  const eff = typeof at === "number" ? (() => { const d = new Date((at + tzOffset(at)) * 1000); return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; })() : dateParts(plan.date).long;
  const fp = useSharedValue(done ? 1 : 0);
  useEffect(() => { fp.value = withTiming(done ? 1 : 0, { duration: 350, easing: Easing.bezier(0.6, -0.4, 0.7, 1.4) }); }, [done, fp]);
  const fpSt = useAnimatedStyle(() => ({ opacity: 0.85 * fp.value, transform: [{ scale: 1.4 - 0.4 * fp.value }, { rotate: "-16deg" }] }));
  const lab = useAnimatedStyle(() => ({ opacity: 1 - fp.value }));
  return (
    <View style={{ flex: 1, backgroundColor: P.bg }}>
      <DepthKids>
      <VCap left={20} bottom={470} len={400} style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.8, color: P.deep, opacity: 0.85 }}>{`TERMS OF A GOOD DAY  ·  NO. ${paperNo(plan)}`}</VCap>
      <View testID="contract-paper" style={{ position: "absolute", left: 40, top: 226, width: 330, height: 580, transform: [{ rotate: "-3deg" }], zIndex: 2 }}>
        <Paper w={330} h={580} d={deckle(330, 580, 1.8, 4)} fill={P.paper} sh={P.sh} texture={0.6} />
        <View style={{ position: "absolute", left: 10, top: 10, right: 10, bottom: 10, borderWidth: 1.1, borderColor: P.deep }} />
        <View style={{ position: "absolute", left: 13, top: 13, right: 13, bottom: 13, borderWidth: 0.5, borderColor: P.deep }} />
        <Text style={{ position: "absolute", left: 0, right: 0, top: 30, textAlign: "center", fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: P.ink }}>{`NO. ${paperNo(plan)} · BETWEEN THE TWO OF US`}</Text>
        <Text style={{ position: "absolute", left: 0, right: 0, top: 48, textAlign: "center", fontFamily: FF.pf9, fontSize: 25, letterSpacing: 1.5, color: P.deep }}>DATE AGREEMENT</Text>
        <Text style={{ position: "absolute", left: 0, right: 0, top: 80, textAlign: "center", fontFamily: FF.serif5, fontSize: 10, letterSpacing: 6, color: P.ink }}>约 会 契 约 书</Text>
        <View style={{ position: "absolute", left: 34, right: 34, top: 106, borderTopWidth: 1, borderBottomWidth: 1, borderColor: P.deep }}>
          {[["Party A", himName()], ["Party B", herName()], ["Effective", eff]].map(([k, v], j) => (
            <View key={k} style={{ flexDirection: "row", alignItems: "baseline", paddingVertical: 6, borderTopWidth: j ? 0.6 : 0, borderTopColor: rgba(P.sh, 0.3) }}>
              <Text style={{ width: 80, fontFamily: FF.pf7, fontSize: 7.5, letterSpacing: 1.8, color: P.deep }}>{k.toUpperCase()}</Text>
              <Text style={{ fontFamily: FF.serif5, fontSize: 12, color: P.ink }}>{v}</Text>
            </View>
          ))}
        </View>
        <View style={{ position: "absolute", left: 34, right: 34, top: 200 }}>
          {(plan.contract ?? []).map((t, j) => (
            <View key={j} style={{ flexDirection: "row", marginBottom: 7 }}>
              <Text style={{ width: 48, fontFamily: FF.serif7, fontSize: 10.5, lineHeight: 17, color: P.deep }}>{`第${"一二三四五"[j]}条`}</Text>
              <Text style={{ flex: 1, fontFamily: FF.serif5, fontSize: 10.5, lineHeight: 17, color: P.ink }}>{t}</Text>
            </View>
          ))}
        </View>
        <View style={{ position: "absolute", left: 34, top: 322 + Math.max(0, (plan.contract?.length ?? 0) - 3) * 24, width: 140 }}>
          <Text style={{ marginLeft: 6, fontFamily: FF.script, paddingRight: 8, fontSize: 36, color: P.ink, transform: [{ rotate: "-6deg" }] }}>{himEn()}</Text>
          <Text style={{ borderTopWidth: 0.8, borderTopColor: P.ink, marginTop: 2, paddingTop: 4, fontFamily: FF.serif5, fontSize: 8.5, letterSpacing: 2.5, color: P.ink }}>甲方 · 签字</Text>
        </View>
        <Pressable onPress={done ? undefined : onPress} style={{ position: "absolute", left: 212, top: 310 + Math.max(0, (plan.contract?.length ?? 0) - 3) * 24, width: 70, height: 70, borderRadius: 35, borderWidth: 0.8, borderStyle: "dashed", borderColor: P.ink, alignItems: "center", justifyContent: "center" }} accessibilityLabel="按指印">
          <Animated.Text style={[{ fontFamily: FF.serif5, fontSize: 9, lineHeight: 13.5, letterSpacing: 1.8, textAlign: "center", color: P.ink }, lab]}>{"乙方\n按印"}</Animated.Text>
          <Animated.View style={[{ position: "absolute", left: 6, top: -2 }, fpSt]} pointerEvents="none"><SvgXml xml={fingerprintXml(P.deep)} width={58} height={70} /></Animated.View>
        </Pressable>
      </View>
      <View style={{ position: "absolute", left: 26, top: 96, width: 350, zIndex: 3 }} pointerEvents="none">
        {q.map((t, j) => {
          // a Chinese line at line height 45 is shorter than its glyphs: iOS cut their tops. Chinese at 56, moved up half
          // the difference (the glyphs stay where they were). As the home app
          const zh = hasCJK(t);
          return <Text key={j} style={{ paddingLeft: [0, 40, 150][j] ?? 0, fontFamily: ff(t, FF.script, FF.serif5), fontSize: 44, lineHeight: zh ? QUOTE_ZH_LH : 45, marginTop: zh && j === 0 ? -(QUOTE_ZH_LH - 45) / 2 : 0, color: P.deep }}>{`${t}${j < q.length - 1 ? "," : ""}`}</Text>;
        })}
      </View>
      </DepthKids>
    </View>
  );
}

// ── 限定小卡 ─────────────────────────────────────────────────────────────────────────
/** 小卡最后的大小(原 150×232 再放大 1.3 倍的那个大小,直接按它画) */
const CW = 195, CH = 302, CARD_S = 150 / CW;
/** 卡背的字按字数定大小:短的大、长的(最多 200 字)也排得下 */
export function cardTextSize(t: string | null): { fontSize: number; lineHeight: number; fits: boolean } {
  // 按估出来的行数挑(换行也算一行,review:只数字数,一字一行的二十行会被裁);都放不下=最小号 + 卡里可以滑
  const paras = (t ?? "").split("\n");
  const SIZES = [{ fontSize: 16, lineHeight: 26 }, { fontSize: 14, lineHeight: 23 }, { fontSize: 12.5, lineHeight: 20 }, { fontSize: 11.5, lineHeight: 17.5 }];
  for (const z of SIZES) {
    const per = Math.max(1, Math.floor(CARD_TEXT_W / z.fontSize));
    const lines = paras.reduce((n, x) => n + Math.max(1, Math.ceil(Array.from(x).length / per)), 0);
    if (lines * z.lineHeight <= CARD_TEXT_H) return { ...z, fits: true };
  }
  return { ...SIZES[SIZES.length - 1], fits: false };
}
const CARD_TEXT_W = CW - 44, CARD_TEXT_H = CH - 44;
/** The back scrolls when the text laid out is taller than its box (measured, not estimated). Pure, tested. */
export const cardOverflows = (box: number, content: number) => box > 0 && content > box + 1;

function CardPage({ plan, P, torn, onTear, ph }: { plan: Plan; P: Skin; torn: boolean; onTear: () => void; ph: number }) {
  const W = 180, H = 270;
  const [t1, t2] = titleLines(plan);
  const tear = useSharedValue(torn ? 1 : 0), rise = useSharedValue(torn ? 2 : 0), flip = useSharedValue(0);
  const [phase, setPhase] = useState<"sealed" | "out">(torn ? "out" : "sealed");
  const [back, setBack] = useState(false);
  const doTear = () => {
    if (phase !== "sealed") return;
    tear.value = withTiming(1, { duration: 700, easing: Easing.bezier(0.3, 0, 0.3, 1) });
    rise.value = withDelay(420, withTiming(1, { duration: 1000, easing: Easing.bezier(0.5, 0, 0.2, 1) }, () => { rise.value = withTiming(2, { duration: 1000, easing: Easing.bezier(0.5, 0, 0.2, 1) }); }));
    setTimeout(() => setPhase("out"), 1420);
    onTear();
  };
  const turn = () => { if (phase !== "out") return; const b = !back; setBack(b); flip.value = withTiming(b ? 1 : 0, { duration: 900, easing: Easing.bezier(0.4, 0, 0.2, 1) }); };
  const topSt = useAnimatedStyle(() => ({ opacity: tear.value > 0.6 ? 1 - (tear.value - 0.6) / 0.4 : 1, transform: [{ translateX: 110 * tear.value }, { translateY: -140 * tear.value }, { rotate: `${34 * tear.value}deg` }] }));
  const packSt = useAnimatedStyle(() => { const g = Math.max(0, rise.value - 1); return { opacity: 1 - g, transform: [{ translateY: 260 * g }, { rotate: `${-7 - 8 * g}deg` }] }; });
  const cardSt = useAnimatedStyle(() => {
    const a = Math.min(1, rise.value), b = Math.max(0, rise.value - 1);
    // 「拆开之后的卡片特别糊」:原来按 150 宽画好再放大 1.3 倍(叠着翻面的 3D)=先按小尺寸出图再拉大,字发虚。
    // 改为按最后的大小(195×302)画,滑出来时从 0.77 倍长到 1 倍,停下来正好是原尺寸
    return { opacity: a > 0 ? 1 : 0, transform: [{ translateX: -6 * b }, { translateY: -150 * a + 110 * b }, { rotate: `${-4 * a + 7 * b}deg` }, { scale: CARD_S + (1 - CARD_S) * b }] };
  });
  const front = useAnimatedStyle(() => ({ transform: [{ perspective: 1200 }, { rotateY: `${180 * flip.value}deg` }], opacity: flip.value < 0.5 ? 1 : 0 }));
  // turned and still: no 3D (perspective + rotateY) left on the back — a layer with perspective takes the finger at the
  // wrong place (iOS), the text on the back got no scrolling. As the home app
  const backSt = useAnimatedStyle(() => (flip.value >= 1 ? { transform: [], opacity: 1 } : { transform: [{ perspective: 1200 }, { rotateY: `${180 * flip.value - 180}deg` }], opacity: flip.value >= 0.5 ? 1 : 0 }));
  const cardText = cardTextSize(plan.card);
  // whether the back scrolls: by the height the text really takes (the estimate by characters came out short for
  // Japanese and punctuation: the end of the text could not be reached)
  const [textBox, setTextBox] = useState({ box: 0, content: 0 });
  const overflow = cardOverflows(textBox.box, textBox.content);
  const side = (children: React.ReactNode) => (
    <View style={{ position: "absolute", left: 0, top: 0, width: CW, height: CH, borderRadius: 9, overflow: "hidden", backgroundColor: P.paper }}>
      <PaperTex />
      <View style={{ position: "absolute", left: 10, top: 10, right: 10, bottom: 10, borderWidth: 1, borderColor: P.deep, borderRadius: 4 }} />
      {children}
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: P.bg }}>
      <DepthKids>
      <FoilText text="1" size={330} file={PLAYFAIR_BLACK_FILE} style={{ position: "absolute", left: -6, top: 30 }} />
      <Text style={{ position: "absolute", left: 226, top: 396, fontFamily: FF.pf9, fontSize: 330, lineHeight: 330, color: P.deep, opacity: 0.14 }}>1</Text>
      <View style={{ position: "absolute", left: 96, top: Math.min(690, ph - 60), width: 360, height: 1.5, transform: [{ rotate: "-58deg" }], transformOrigin: "left top" }}><FoilLine w={360} h={1.5} /></View>
      <Pressable onPress={turn} pointerEvents={phase === "out" ? "auto" : "none"} style={{ position: "absolute", left: 195 - CW / 2, top: 416 - CH / 2, width: CW, height: CH, zIndex: 3 }} accessibilityLabel="小卡">
        <Animated.View style={[{ width: CW, height: CH, shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 8 } }, cardSt]}>
          <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: CW, height: CH, backfaceVisibility: "hidden" }, front]}>
            {side(
              <>
                <View style={{ position: "absolute", left: 10, right: 10, top: 47 }}>
                  {[t1, t2].map((t, q) => <FitLine key={q} style={{ textAlign: "center", fontFamily: FF.script, paddingRight: 8, fontSize: 34, lineHeight: 30, color: P.deep }}>{t}</FitLine>)}
                </View>
                <Text style={{ position: "absolute", left: 0, right: 0, top: 140, textAlign: "center", fontFamily: FF.pf9, fontSize: 39, color: P.ink }}>1<Text style={{ fontFamily: FF.pf7, fontSize: 18 }}>  of  </Text>1</Text>
                <Text style={{ position: "absolute", left: 0, right: 0, top: 192, textAlign: "center", fontFamily: FF.pf7, fontSize: 8.5, letterSpacing: 1.7, color: P.ink }}>LIMITED EDITION</Text>
                <View style={{ position: "absolute", left: 39, right: 39, top: 218, borderTopWidth: 0.6, borderTopColor: P.deep }} />
                <Text style={{ position: "absolute", left: 0, right: 0, top: 234, textAlign: "center", fontFamily: FF.pf7, fontSize: 9, letterSpacing: 1.8, color: P.deep }}>{`NO. ${paperNo(plan)} · ${dateParts(plan.date).dot}`}</Text>
              </>,
            )}
          </Animated.View>
          <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: CW, height: CH, backfaceVisibility: "hidden" }, backSt]}>
            {/* 「图文无关」:背面原来是按第一站种类挑的固定插图,和他写的字没关系 → 只放他写的字,字放大、不再半透明 */}
            {side(
              <ScrollView style={{ position: "absolute", left: 22, right: 22, top: 22, bottom: 22 }} contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
                onLayout={(e) => { const h = e.nativeEvent.layout.height; setTextBox((b) => (b.box === h ? b : { ...b, box: h })); }}
                onContentSizeChange={(_w, h) => setTextBox((b) => (b.content === h ? b : { ...b, content: h }))}
                // always enabled on the web: the browser scrolls only what really overflows, and a scroll view that
                // started disabled (before the text was measured) and was enabled after did not take a finger in iOS
                // Safari (measured in the simulator: scrollTop stayed 0 with the text overflowing)
                scrollEnabled showsVerticalScrollIndicator={overflow} nestedScrollEnabled testID="card-back-scroll">
                {/* a tap on the text turns the card back, a drag scrolls it: the tap is inside the scrolling part (the whole
                    card's tap outside took the touch first and the text did not scroll) */}
                <Pressable onPress={turn} accessibilityLabel="翻回正面"><Text testID="card-back-text" style={{ textAlign: "center", fontFamily: FF.serif5, fontSize: cardText.fontSize, lineHeight: cardText.lineHeight, color: P.ink }}>{plan.card}</Text></Pressable>
              </ScrollView>,
            )}
          </Animated.View>
        </Animated.View>
      </Pressable>
      {phase === "sealed" ? (
        <Animated.View style={[{ position: "absolute", left: 195 - W / 2, top: 290, width: W, height: H, zIndex: 2 }, packSt]}>
          <PackBody plan={plan} P={P} W={W} H={H} />
          <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: W, height: 28, transformOrigin: "right bottom" }, topSt]}>
            <Pressable onPress={doTear} style={{ flex: 1 }} hitSlop={14} accessibilityLabel="撕开袋口">
              <Svg width={W} height={28}><Path d={`M0 4 ${Array.from({ length: W / 4 }, (_, k) => `L${k * 4} ${k % 2 ? 0 : 4}`).join(" ")} L${W} 28 L0 28 Z`} fill={P.ink} /></Svg>
              <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, borderStyle: "dashed", borderTopColor: "rgba(255,255,255,0.35)" }} />
            </Pressable>
          </Animated.View>
          <Text style={{ position: "absolute", right: 10, top: 30, fontFamily: FF.pf7, fontSize: 7, letterSpacing: 1.7, color: P.deep }}>◂ TEAR</Text>
        </Animated.View>
      ) : null}
      <Text style={{ position: "absolute", right: 24, top: 88, textAlign: "right", fontFamily: FF.serif7, fontSize: 7.5, lineHeight: 13.5, letterSpacing: 1.6, color: P.deep, zIndex: 3 }}>{`LIMITED\nONE OF ONE\nFOR ${herEn().toUpperCase()}`}</Text>
      </DepthKids>
    </View>
  );
}

// ── 弹出来看:请柬 / 准备清单;照片显影 ─────────────────────────────────────────────────
function PopPaper({ P, kind, plan, her, onClose }: { P: Skin; kind: "invite" | "prep"; plan: Plan; her: ReturnType<typeof usePlan>["her"]; onClose: () => void }) {
  const { s: sc, top, H } = useStage();
  const t = useSharedValue(0);
  useEffect(() => { t.value = withTiming(1, calm()); }, [t]);
  const st = useAnimatedStyle(() => ({ opacity: Math.min(1, t.value * 2), transform: [{ translateX: -60 * (1 - t.value) }, { rotate: `${-4 + 3 * t.value}deg` }, { scale: kind === "invite" ? Math.min(1, (0.6 + 0.82 * t.value) / 1.42) : 0.6 + 0.4 * t.value }] }));
  return (
    <Pressable onPress={onClose} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.35), zIndex: 15 }} accessibilityLabel="放下">
      <View style={{ position: "absolute", left: 0, top, width: 390, height: H, transform: [{ scale: sc }], transformOrigin: "top left" }}>
        {/* a screen shorter than the paper scrolls it (a tap anywhere still puts it down; a drag scrolls) */}
        <ScrollView testID="pop-paper-scroll" style={{ flex: 1 }} contentContainerStyle={{ minHeight: H, alignItems: "center", justifyContent: "center", paddingVertical: 28 }} showsVerticalScrollIndicator={false}>
          <Animated.View style={[shapeShadow("#000", 0.3, 20, 24), st]} pointerEvents="none">
            {/* 请柬按 1.42 倍真排版,弹层缩放终点=1(不放大位图,字一直清楚) */}
            {kind === "invite" ? <MiniInvite plan={plan} P={P} k={1.42} /> : <PrepCard plan={plan} her={her} P={P} live={false} k={0.95} />}
          </Animated.View>
        </ScrollView>
      </View>
    </Pressable>
  );
}

function PhotoPop({ P, plan, i, ph, onClose }: { P: Skin; plan: Plan; i: number; ph: HerPhoto | null; onClose: () => void }) {
  const { s: sc, top, H } = useStage();
  const s = plan.stops[i];
  const [src, setSrc] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  useEffect(() => { if (ph) ephemeraApi.photoSource(plan.id, ph.id).then(setSrc).catch(() => {}); }, [ph?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = useSharedValue(0), dev = useSharedValue(0), cap = useSharedValue(0);
  useEffect(() => {
    t.value = withTiming(1, calm());
    dev.value = withDelay(600, withTiming(1, { duration: 2400 }));
    cap.value = withDelay(2200, withTiming(1, { duration: 800 }));
  }, [t, dev, cap]);
  const box = useAnimatedStyle(() => ({ opacity: Math.min(1, t.value * 2), transform: [{ scale: 0.3 + 0.7 * t.value }, { rotate: `${i % 2 ? 2.5 : -2.5}deg` }] }));
  const devSt = useAnimatedStyle(() => ({ opacity: dev.value }));
  const fog = useAnimatedStyle(() => ({ opacity: 1 - dev.value }));
  const capSt = useAnimatedStyle(() => ({ opacity: 0.9 * cap.value }));
  const caption = ph?.caption || placeName(s);
  return (
    <Pressable onPress={onClose} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: rgba(P.sh, 0.35), zIndex: 15 }} accessibilityLabel="收回">
      <View style={{ position: "absolute", left: 0, top, width: 390, height: H, transform: [{ scale: sc }], transformOrigin: "top left" }} pointerEvents="none">
        {ph ? (
          <Animated.View style={[{ position: "absolute", left: 75, top: 150, width: 240, height: 292, backgroundColor: "#FFFEFB", paddingTop: 14, paddingHorizontal: 14, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: { width: 0, height: 24 } }, box]}>
            <View style={{ height: 212, overflow: "hidden", backgroundColor: "#EFE8DD" }}>
              {src ? (
                <>
                  <Animated.View style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, fog]}><Image source={src} blurRadius={6} style={{ width: "100%", height: "100%", opacity: 0.5 }} resizeMode="cover" /></Animated.View>
                  <Animated.View style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, devSt]}><Image source={src} style={{ width: "100%", height: "100%" }} resizeMode="cover" /></Animated.View>
                </>
              ) : null}
            </View>
            <Animated.Text numberOfLines={1} style={[{ marginTop: 12, textAlign: "center", fontFamily: ff(caption, FF.script, FF.serif5), fontSize: 23, color: P.ink }, capSt]}>{caption}</Animated.Text>
          </Animated.View>
        ) : (
          <Animated.View style={[{ position: "absolute", left: 65, top: 300, width: 260, paddingVertical: 26, paddingHorizontal: 20, alignItems: "center", backgroundColor: P.paper, shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 20 } }, box]}>
            <Text style={{ fontFamily: FF.pf7, fontSize: 7, letterSpacing: 2.1, color: P.deep }}>{`${two(i)} · ${s.time ?? ""} · ${kindLine(s)}`}</Text>
            <Text style={{ marginTop: 10, fontFamily: FF.serif5, fontSize: 15, letterSpacing: 1.8, color: P.ink }}>{NO_PHOTO}</Text>
          </Animated.View>
        )}
      </View>
    </Pressable>
  );
}
