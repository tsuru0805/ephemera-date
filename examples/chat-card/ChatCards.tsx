// Reference chat cards for Ephemera events: an envelope (a date was sent to her) and a telegram (something changed,
// a stop was skipped, the date was cancelled / kept in the box / written up afterwards), the reminder card for the
// AI's reminder turn, and the sealed page over the thinking of the turn in which the AI wrote a date (opened only
// after she confirms). React Native (works with React Native Web); react-native-svg for the drawn parts.
//
// Not part of the web package: copy it into your chat, give it the event and the date's brief, and send her to the
// page the card points at (navigateFor). Colours are the page's default skin; fonts are yours to give (see README).
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";

// ── what the engine gives ───────────────────────────────────────────────────────────
/** GET /api/dates/events → events[] (docs/API.md). */
export type DateEventKind = "envelope" | "telegram_manual" | "telegram_auto" | "cancel" | "close" | "late_written";
export interface DateEvent {
  id: number;
  plan_id: number;
  kind: DateEventKind | string;   // unknown kinds render as a telegram
  /** the sentence for her, frozen when the event was written */
  text: string;
  created_at: number;             // epoch seconds
  read_at: number | null;
  /** the stop the event is about (a skipped stop's telegram): its number, and its name once that is shown to her */
  ref_stop?: { n: number; title?: string } | null;
}
/** The few fields of a date the cards show (from GET /api/dates or /api/dates/{id}). */
export interface DatePlanBrief { id: number; paper_no: string | null; title_en: string; date: string }

/** The user-event webhook body (EPHEMERA_EVENT_WEBHOOK). */
export interface EventWebhook {
  type: "event"; kind: DateEventKind | string; title: string; body: string;
  plan_id: number; event_id: number; navigate: NavigateTarget;
}
/** The event a webhook announces, as the cards take it (created_at: when it arrived). */
export function eventFromWebhook(w: EventWebhook, receivedAt = Date.now() / 1000): DateEvent {
  return { id: w.event_id, plan_id: w.plan_id, kind: w.kind, text: w.title, created_at: receivedAt, read_at: null };
}

// ── where a card goes ───────────────────────────────────────────────────────────────
/** Same targets as the page's navigate{page} (docs/EMBED.md) and the engine's webhook navigate: the envelope opens
 *  the seal of that date, a telegram the telegrams list (no date: it lists them all), kept / written up the box. */
export type NavigateTarget = { page: "seal" | "telegrams" | "box"; planId: number | null };
export function navigateFor(ev: Pick<DateEvent, "kind" | "plan_id">): NavigateTarget {
  if (ev.kind === "envelope") return { page: "seal", planId: ev.plan_id };
  if (ev.kind === "close" || ev.kind === "late_written") return { page: "box", planId: ev.plan_id };
  return { page: "telegrams", planId: null };
}

// ── looks ───────────────────────────────────────────────────────────────────────────
export const CARD_COLORS = {
  page: "#F6E6E1", card: "#FBF4EF", ink: "#634458", title: "#A8435F", route: "#C15772",
  seal: "#D92662", sealHi: "#FFD9E3", envPaper: "#F8D6DE",
} as const;
/** Font families. Bundle the faces and pass their names; anything left out falls back to the system face. */
export interface CardFonts {
  display?: string;       // a heavy display serif (Playfair Display Black)   — TELEGRAM, CANCELLED
  displayBold?: string;   // its bold                                         — small caps, numbers
  italic?: string;        // its italic                                       — the date line, the footer
  script?: string;        // a script face (Pinyon Script)                    — "Ephemera" on the envelope
  typewriter?: string;    // a typewriter face (Courier Prime)                — Latin-only telegram text, the time
  serif?: string;         // a CJK serif (Noto Serif SC)                      — Chinese text, links
  serifBold?: string;     // its bold                                         — the envelope's title
}
/** Words on the cards that are not the engine's (change them for another language). */
export const CARD_WORDS = {
  open: "拆开 ›", look: "去看看 ›", newTelegram: "有一封新电报", aTelegram: "有一封电报", cancelled: "CANCELLED",
  reminder: "A REMINDER", reminderZh: "约会提醒",
  // the sealed thinking (him: what she calls the one who writes the dates; see SealedThinking)
  sealedTurn: "这一轮在写约会", sealedSecret: " · 内容保密", reveal: "揭开看看 ›",
  revealAsk: (him: string) => `揭开会看到${him}写的约会内容，确定吗？`, revealYes: "揭开", revealNo: "先不看",
};

const hasCJK = (s: string) => /[㐀-鿿　-〿＀-￯]/.test(s);
const fmtMd = (iso: string) => { const [, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}`; };
/** "10/28 19:05" in the device's zone (pass formatAt to use the engine's zone, EPHEMERA_TZ). */
export const fmtAtLocal = (sec: number) => {
  const d = new Date(sec * 1000), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

type Common = { fonts?: CardFonts; words?: Partial<typeof CARD_WORDS>; formatAt?: (sec: number) => string };

/**
 * One card per event, in the order they happened. envelope → a small envelope with a wax seal and 「拆开 ›」;
 * every other kind → telegram paper: the event's own sentence; cancel adds a CANCELLED stamp, close a box seal.
 */
export function DateEventCard({ event, plan, onOpen, fonts = {}, words = {}, formatAt = fmtAtLocal }:
  { event: DateEvent; plan?: DatePlanBrief; onOpen?: (to: NavigateTarget) => void } & Common) {
  const w = { ...CARD_WORDS, ...words };
  const f = fonts;
  const open = onOpen ? () => onOpen(navigateFor(event)) : undefined;
  const name = plan ? `「${plan.title_en.replace(/\n/g, " ")}」` : "";
  if (event.kind === "envelope") {
    return (
      <Pressable style={st.envRow} onPress={open} accessibilityRole="button" testID="date-envelope-card">
        <View style={st.env}>
          <View style={st.envV1} />
          <View style={st.envV2} />
          <View style={st.envWax} pointerEvents="none"><SvgXml xml={waxXml()} width={36} height={36} /></View>
          <Text style={[st.envScript, { fontFamily: f.script }]}>Ephemera</Text>
          {plan?.paper_no ? <Text style={[st.envNo, { fontFamily: f.displayBold }]}>NO. {plan.paper_no}</Text> : null}
        </View>
        <View style={st.envTx}>
          <Text style={[st.envTitle, { fontFamily: f.serifBold }]}>{event.text}</Text>
          {plan ? <Text style={[st.envSub, { fontFamily: f.italic }]}>Ephemera · {fmtMd(plan.date)}</Text> : null}
          <Text style={[st.link, { marginTop: 14, fontFamily: f.serif }]}>{w.open}</Text>
        </View>
      </Pressable>
    );
  }
  const line = event.kind === "close" ? name : event.kind === "cancel" ? w.aTelegram : w.newTelegram;
  const foot = event.kind === "close" ? (plan?.paper_no ? `No. ${plan.paper_no}` : "") : name;
  return (
    <Pressable style={st.tele} onPress={open} accessibilityRole="button" testID={`date-telegram-${event.kind}`}>
      <View style={st.teleTop}>
        <Text style={[st.teleBrand, { fontFamily: f.display }]}>TELEGRAM</Text>
        <Text style={[st.teleAt, { fontFamily: f.typewriter }]}>{formatAt(event.created_at)}</Text>
      </View>
      <View style={st.teleTop2} />
      {line ? <Text style={[st.teleLine, { fontFamily: f.serif }]}>{line}</Text> : null}
      <View style={st.teleMsgWrap}>
        {/* a typewriter face has no Chinese: a telegram with Chinese is set all in the serif (one face, no gaps) */}
        <Text style={[st.teleMsg, { fontFamily: hasCJK(event.text) ? f.serif : f.typewriter }]}>{event.text}</Text>
      </View>
      <View style={st.teleFt}>
        <Text style={[st.teleFoot, { fontFamily: f.italic }]}>{foot}</Text>
        <Text style={[st.link, { fontFamily: f.serif }]}>{w.look}</Text>
      </View>
      {event.kind === "cancel" ? (
        <View style={st.void} pointerEvents="none"><Text style={[st.voidT, { fontFamily: f.display }]}>{w.cancelled}</Text></View>
      ) : null}
      {event.kind === "close" ? (
        <View style={st.boxSeal} pointerEvents="none"><SvgXml xml={boxSealXml()} width={56} height={56} /></View>
      ) : null}
    </Pressable>
  );
}

/**
 * The thinking of the turn in which the AI wrote a date (a planning tool was called in it), sealed: the chat shows
 * this page in place of the thinking block until she lifts it. 「揭开看看 ›」 asks first; 「揭开」 hands the place back
 * to the thinking block as the chat draws it (renderOpen), 「先不看」 leaves it sealed.
 *  - sealed: whether this turn's thinking is sealed (your backend decides which turns — see README, docs/SECRECY.md);
 *    false = renderOpen() at once.
 *  - onReveal: called once when she confirms (e.g. to remember the turn as opened); the card opens either way.
 *  - renderOpen: the thinking block the chat would have shown.
 *  - him: what she calls the one who wrote the date, in the question (default 「他」).
 */
export function SealedThinking({ sealed, onReveal, renderOpen, him = "他", fonts = {}, words = {} }:
  { sealed: boolean; onReveal?: () => void; renderOpen: () => React.ReactNode; him?: string } & Omit<Common, "formatAt">) {
  const w = { ...CARD_WORDS, ...words };
  const f = fonts;
  const [state, setState] = useState<"sealed" | "asking" | "open">("sealed");
  if (!sealed || state === "open") return <>{renderOpen()}</>;
  return (
    <View style={st.sealWrap} testID="date-sealed-thinking">
      <View style={st.seal}>
        <View style={st.sealIn}>
          <View style={st.sealCap}>
            <Text style={[st.capsXs, { fontFamily: f.displayBold }]}>THIS TURN · SEALED</Text>
            <Text style={[st.capsXs, { fontFamily: f.displayBold }]}>EPHEMERA</Text>
          </View>
          {state === "sealed" ? (
            <>
              <Text style={[st.sealSay, { fontFamily: f.serif }]}>
                <Text style={[st.sealSayB, { fontFamily: f.serifBold }]}>{w.sealedTurn}</Text>{w.sealedSecret}
              </Text>
              <Pressable onPress={() => setState("asking")} hitSlop={8} accessibilityRole="button" testID="date-sealed-reveal">
                <Text style={[st.link, { fontFamily: f.serif }]}>{w.reveal}</Text>
              </Pressable>
            </>
          ) : (
            <View style={st.ask}>
              <Text style={[st.askText, { fontFamily: f.serif }]}>{w.revealAsk(him)}</Text>
              <View style={st.askRow}>
                <Pressable onPress={() => { setState("open"); onReveal?.(); }} style={st.askYes} accessibilityRole="button" testID="date-sealed-yes">
                  <Text style={[st.askYesT, { fontFamily: f.serif }]}>{w.revealYes}</Text>
                </Pressable>
                <Pressable onPress={() => setState("sealed")} style={st.askNo} accessibilityRole="button" testID="date-sealed-no">
                  <Text style={[st.askNoT, { fontFamily: f.serif }]}>{w.revealNo}</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </View>
      {/* the seal: a round ink stamp, SEALED */}
      <View style={st.inkSeal} pointerEvents="none"><SvgXml xml={inkSealXml(f.displayBold, f.display)} width={72} height={72} /></View>
    </View>
  );
}

/**
 * The AI's reminder turn (an ai_todo of kind "reminder" woke it; what it says to her goes in head / sub):
 * a stamped card with the time. at: the time line, e.g. "19:00"; stampDate: the postmark's date, e.g. "OCT 28".
 */
export function DateRemindCard({ head, sub, at, stampDate, fonts = {}, words = {} }:
  { head: string; sub?: string; at: string; stampDate: string } & Common) {
  const w = { ...CARD_WORDS, ...words };
  const f = fonts;
  const long = [...head].reduce((n, ch) => n + (hasCJK(ch) ? 1 : 0.55), 0) > 8;   // long: one size down, no waves
  return (
    <View style={st.remind} testID="date-remind-card">
      <View style={st.remindHd}>
        <View style={{ flex: 1.4 }}>
          <Text style={[st.remindBrand, { fontFamily: f.displayBold }]}>Ephemera</Text>
          <Text style={[st.capsXs, { fontFamily: f.displayBold }]}>{w.reminder}</Text>
        </View>
        <View style={st.remindHdR}>
          <Text style={[st.capsZh, { fontFamily: f.serif }]}>{w.reminderZh}</Text>
          <Text style={[st.remindAt, { fontFamily: f.typewriter }]}>{at}</Text>
        </View>
      </View>
      <View style={st.remindBd}>
        <Text style={[st.remindHead, { fontFamily: f.serifBold }, long && { fontSize: 20 }]}>{head}</Text>
        {sub ? <Text style={[st.remindSub, { fontFamily: f.serif }]}>{sub}</Text> : null}
      </View>
      <View style={[st.remindPm, long && { right: -26, top: 44 }]} pointerEvents="none">
        <SvgXml xml={postmarkXml(stampDate, !long, f.displayBold)} width={150} height={84} />
      </View>
    </View>
  );
}

// ── drawn parts ─────────────────────────────────────────────────────────────────────
function waxXml(): string {
  const pts = Array.from({ length: 28 }, (_, k) => {
    const a = (k / 28) * Math.PI * 2, r = k % 2 ? 16.2 : 17.6;
    return `${k ? "L" : "M"}${(18 + r * Math.cos(a)).toFixed(2)} ${(18 + r * Math.sin(a)).toFixed(2)}`;
  }).join("");
  return `<svg viewBox="0 0 36 36" width="36" height="36"><path d="${pts}Z" fill="${CARD_COLORS.seal}"/>
    <circle cx="18" cy="18" r="11.5" fill="none" stroke="${CARD_COLORS.sealHi}" stroke-width=".9" opacity=".8"/>
    <path d="M18 23.5 C12.5 19.5 13.2 14.2 18 16.8 C22.8 14.2 23.5 19.5 18 23.5Z" fill="${CARD_COLORS.sealHi}"/></svg>`;
}
function inkSealXml(bold?: string, black?: string): string {
  const size = 84, c = size / 2, r = size * 0.38, col = CARD_COLORS.route;
  const fb = bold ? ` font-family="${bold}"` : "", fk = black ? ` font-family="${black}"` : "";
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <g fill="none" stroke="${col}" stroke-width="1.6"><circle cx="${c}" cy="${c}" r="${size * 0.46}"/><circle cx="${c}" cy="${c}" r="${size * 0.3}"/></g>
    <defs><path id="sl" d="M${c},${c} m-${r},0 a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 -${2 * r},0"/></defs>
    <text${fb} font-size="${size * 0.1}" letter-spacing="${size * 0.03}" fill="${col}"><textPath href="#sl">THIS TURN · SEALED · EPHEMERA ·</textPath></text>
    <text x="${c}" y="${c + 4}" text-anchor="middle"${fk} font-size="${size * 0.13}" letter-spacing="1" fill="${col}">SEALED</text></svg>`;
}
function boxSealXml(): string {
  const pts = Array.from({ length: 24 }, (_, k) => {
    const a = (k / 24) * Math.PI * 2, r = k % 2 ? 26 : 29;
    return `${k ? "L" : "M"}${(30 + r * Math.cos(a)).toFixed(1)} ${(30 + r * Math.sin(a)).toFixed(1)}`;
  }).join("");
  return `<svg viewBox="0 0 60 60" width="56" height="56"><path d="${pts}Z" fill="${CARD_COLORS.route}"/>
    <circle cx="30" cy="30" r="20" fill="none" stroke="#fff" stroke-width=".8" stroke-dasharray="1.5 2"/>
    <path d="M30 38 C22 32 23 24 30 28 C37 24 38 32 30 38Z" fill="#fff"/></svg>`;
}
function postmarkXml(date: string, waves: boolean, family?: string): string {
  const size = 84, c = size / 2, r = size * 0.38, col = CARD_COLORS.title, ff = family ? ` font-family="${family}"` : "";
  const wave = waves
    ? `<g fill="none" stroke="${col}" stroke-width="1.1">${[0, 1, 2, 3].map((k) => `<path d="M0 ${24 + k * 9} q8 -5 16 0 t16 0 t16 0 t16 0 t16 0"/>`).join("")}</g>`
    : "";
  return `<svg viewBox="0 0 150 84" width="150" height="84">${wave}<g transform="translate(66 0)">
    <g fill="none" stroke="${col}" stroke-width="1.6"><circle cx="${c}" cy="${c}" r="${size * 0.46}"/><circle cx="${c}" cy="${c}" r="${size * 0.3}"/></g>
    <defs><path id="pm" d="M${c},${c} m-${r},0 a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 -${2 * r},0"/></defs>
    <text${ff} font-size="${size * 0.105}" letter-spacing="${size * 0.025}" fill="${col}"><textPath href="#pm">EPHEMERA · DATE REMINDER · </textPath></text>
    <path d="M${c} ${c + size * 0.11} C${c - size * 0.2} ${c - size * 0.02} ${c - size * 0.1} ${c - size * 0.17} ${c} ${c - size * 0.06} C${c + size * 0.1} ${c - size * 0.17} ${c + size * 0.2} ${c - size * 0.02} ${c} ${c + size * 0.11}Z" fill="${col}"/>
    <text x="${c}" y="${c + size * 0.24}" text-anchor="middle"${ff} font-size="${size * 0.08}" letter-spacing="1" fill="${col}">${date}</text></g></svg>`;
}

const C = CARD_COLORS;
const hair = "rgba(99,68,88,0.45)";
const shadow = { shadowColor: "#502832", shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: 0, height: 7 } };
const st = StyleSheet.create({
  capsXs: { fontSize: 6, letterSpacing: 1.6, color: C.ink, opacity: 0.8 },
  capsZh: { fontSize: 7.5, letterSpacing: 1.5, color: C.ink, opacity: 0.85 },
  link: { fontSize: 11.5, letterSpacing: 1.4, color: C.route, textDecorationLine: "underline", textDecorationStyle: "dotted" },
  // envelope
  envRow: { height: 128, marginTop: 16, marginBottom: 12, flexDirection: "row" },
  env: { width: 176, height: 112, marginLeft: 6, marginTop: 6, backgroundColor: C.envPaper, transform: [{ rotate: "-3deg" }], overflow: "hidden", ...shadow },
  envV1: { position: "absolute", left: -10, top: -38, width: 120, height: 3, backgroundColor: "rgba(255,255,255,0.6)", transform: [{ rotate: "33deg" }, { translateY: 70 }] },
  envV2: { position: "absolute", right: -10, top: -38, width: 120, height: 3, backgroundColor: "rgba(255,255,255,0.6)", transform: [{ rotate: "-33deg" }, { translateY: 70 }] },
  envWax: { position: "absolute", left: 70, top: 44 },
  envScript: { position: "absolute", left: 12, bottom: 6, fontSize: 19, color: C.title },
  envNo: { position: "absolute", right: 10, bottom: 11, fontSize: 6, letterSpacing: 1.5, color: C.ink, opacity: 0.8 },
  envTx: { marginLeft: 18, marginTop: 20 },
  envTitle: { fontSize: 15, letterSpacing: 0.9, color: C.title },
  envSub: { marginTop: 6, fontSize: 12, color: C.ink, opacity: 0.8 },
  // telegram
  tele: { alignSelf: "center", width: 322, marginVertical: 14, paddingBottom: 12, backgroundColor: C.card, ...shadow, shadowOpacity: 0.18 },
  teleTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginHorizontal: 12, paddingTop: 11, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: C.ink },
  teleTop2: { marginHorizontal: 12, height: 0, borderBottomWidth: 0.6, borderBottomColor: C.ink, marginTop: 1.6 },
  teleBrand: { fontSize: 17, letterSpacing: 5.8, color: C.title },
  teleAt: { fontSize: 9, color: C.ink, opacity: 0.75 },
  teleLine: { marginTop: 9, marginHorizontal: 12, fontSize: 11, letterSpacing: 1.1, color: C.ink, opacity: 0.75 },
  teleMsgWrap: { marginTop: 6, marginHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "rgba(99,68,88,0.22)" },
  teleMsg: { fontSize: 13.5, lineHeight: 21, color: C.ink },
  teleFt: { marginTop: 8, marginHorizontal: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  teleFoot: { fontSize: 11, color: C.ink, opacity: 0.85 },
  void: { position: "absolute", right: 16, top: 44, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1.6, borderColor: C.route, transform: [{ rotate: "-9deg" }], opacity: 0.82 },
  voidT: { fontSize: 13, letterSpacing: 2.8, color: C.route },
  boxSeal: { position: "absolute", right: 12, top: 36, transform: [{ rotate: "8deg" }] },
  // sealed thinking
  sealWrap: { marginTop: 10, marginBottom: 26, marginLeft: 2, width: 304 },
  seal: { backgroundColor: C.card, borderWidth: 0.6, borderColor: hair, padding: 3.5, ...shadow, shadowOpacity: 0.18 },
  sealIn: { borderWidth: 1, borderColor: C.ink, paddingHorizontal: 15, paddingTop: 12, paddingBottom: 13 },
  sealCap: { flexDirection: "row", justifyContent: "space-between", paddingBottom: 7, borderBottomWidth: 0.6, borderBottomColor: hair },
  sealSay: { marginTop: 11, fontSize: 13, lineHeight: 21, letterSpacing: 0.5, color: C.ink },
  sealSayB: { color: C.title },
  ask: { marginTop: 10 },
  askText: { fontSize: 12, lineHeight: 19, color: C.ink, marginBottom: 10 },
  askRow: { flexDirection: "row", gap: 10 },
  askYes: { backgroundColor: C.route, paddingVertical: 5, paddingHorizontal: 16 },
  askYesT: { fontSize: 12, letterSpacing: 1.6, color: "#fff" },
  askNo: { borderWidth: 0.8, borderColor: C.ink, paddingVertical: 4.2, paddingHorizontal: 15 },
  askNoT: { fontSize: 12, letterSpacing: 1.6, color: C.ink },
  inkSeal: { position: "absolute", right: 14, bottom: -14, opacity: 0.8, transform: [{ rotate: "12deg" }] },
  // reminder
  remind: { alignSelf: "center", width: 326, marginVertical: 16, backgroundColor: C.page, borderWidth: 0.7, borderColor: hair, overflow: "hidden", ...shadow },
  remindHd: { flexDirection: "row", marginHorizontal: 12, marginTop: 10, borderTopWidth: 1, borderTopColor: C.ink, borderBottomWidth: 0.6, borderBottomColor: hair, paddingTop: 7, paddingBottom: 6 },
  remindHdR: { flex: 1, paddingLeft: 9, borderLeftWidth: 0.6, borderLeftColor: "rgba(99,68,88,0.35)" },
  remindBrand: { fontSize: 14, color: C.title },
  remindAt: { fontSize: 11, color: C.ink, marginTop: 2 },
  remindBd: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 14 },
  remindHead: { fontSize: 25, lineHeight: 30, color: C.title },
  remindSub: { marginTop: 7, fontSize: 12, letterSpacing: 1.4, color: C.ink, opacity: 0.75 },
  remindPm: { position: "absolute", right: -18, top: 38, opacity: 0.8 },
});
