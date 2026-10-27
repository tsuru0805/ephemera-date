// Web-only pieces: navigate targets, events reported to the host once, keyboard room, tilt, HEIC size, time zone,
// the demo engine's walk through a date, press-to-search place search.
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("expo-router", () => ({ useFocusEffect: () => undefined, useRouter: () => ({}) }));
jest.mock("../fonts", () => ({ F: new Proxy({}, { get: (_t, k) => String(k) }), usePosterFonts: () => ({ ready: true, error: null }) }));
jest.mock("@shopify/react-native-skia", () => ({}));
jest.mock("@shopify/react-native-skia/lib/module/web/LoadSkiaWeb", () => ({ LoadSkiaWeb: jest.fn(async () => undefined) }));
import { act, create } from "react-test-renderer";
import { __resetHost, installHost } from "./host";
import { NAV_GONE_TEXT, NAV_UNKNOWN_TEXT, resolveTarget } from "./navigate";
import { __resetEventsWatch, reportNewEvents } from "./eventsWatch";
import { __resetSession, __setSession, mergeConfig, startSession } from "./session";
import { readingToTilt } from "./tilt";
import { liftNeeded } from "../shims/keyboard-controller";
import { ispeSize } from "../shims/image-picker";
import { offsetIn } from "../lib/tz";
import { demoFetch, demoState, fastForward, nextStepLabel, resetDemo } from "../demo/server";

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
beforeEach(() => { __resetHost(); __resetSession(); __resetEventsWatch(); });

describe("navigate{page}", () => {
  it("pages without a date go straight; a date that is gone or cancelled lands home with a line; unknown page too", async () => {
    __setSession({ mode: "iframe", phase: "ready", apiBase: "https://e.example", credential: "t" });
    const plans: Record<number, unknown> = { 2: { id: 2, status: "done", opened_at: 1 }, 3: { id: 3, status: "cancelled" }, 4: { id: 4, status: "sent", opened_at: null } };
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (u: string) => {
      const m = /\/api\/dates\/(\d+)$/.exec(u);
      return m && plans[Number(m[1])] ? json(200, plans[Number(m[1])]) : json(404, { detail: "not found" });
    });
    await expect(resolveTarget({ page: "telegrams" })).resolves.toEqual({ href: "/ephemera-telegrams" });
    await expect(resolveTarget({ page: "box", planId: 2 })).resolves.toEqual({ href: "/ephemera-box?id=2" });
    await expect(resolveTarget({ page: "seal", planId: 2 })).resolves.toEqual({ href: "/ephemera-box?id=2" });   // already over: the box
    await expect(resolveTarget({ page: "seal", planId: 4 })).resolves.toEqual({ href: "/ephemera-seal?id=4" });  // not opened yet: the envelope
    await expect(resolveTarget({ page: "box", planId: 3 })).resolves.toEqual({ home: NAV_GONE_TEXT });
    await expect(resolveTarget({ page: "box", planId: 99 })).resolves.toEqual({ home: NAV_GONE_TEXT });
    await expect(resolveTarget({ page: "box" })).resolves.toEqual({ home: NAV_GONE_TEXT });
    await expect(resolveTarget({ page: "nowhere" })).resolves.toEqual({ home: NAV_UNKNOWN_TEXT });
  });
});

describe("event{kind, planId} to the host", () => {
  const setup = () => {
    const posted: Array<Record<string, unknown>> = [];
    const w = { parent: { postMessage: (m: Record<string, unknown>) => posted.push(m) }, location: { search: "?host=https%3A%2F%2Fapp.example.com" }, addEventListener() {}, removeEventListener() {} };
    startSession("iframe", w as never);
    installHost(w as never);
    __setSession({ phase: "ready", apiBase: "https://e.example", credential: "t" });
    return posted;
  };
  let list: Array<Record<string, unknown>> = [];
  const ev = (id: number, read: number | null = null) => ({ id, plan_id: 5, kind: "envelope", text: "", created_at: id, read_at: read });
  beforeEach(() => {
    localStorage.clear();
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => json(200, { events: list }));
  });
  it("first run: what is there is taken as known; later unread events are reported once each, also after a reopen", async () => {
    const posted = setup();
    list = [ev(1), ev(2, 3)];
    await expect(reportNewEvents()).resolves.toBe(0);           // baseline, no burst of old news
    list = [ev(1), ev(2, 3), ev(3), ev(4, 9)];
    await expect(reportNewEvents()).resolves.toBe(1);           // 3 (4 is already read)
    await expect(reportNewEvents()).resolves.toBe(0);
    __resetHost(); __resetEventsWatch(); sessionStorage.clear(); // the host opens a new web view
    setup();
    await expect(reportNewEvents()).resolves.toBe(0);
    expect(posted.filter((m) => m.type === "event").map((m) => m.payload)).toEqual([{ kind: "envelope", planId: 5 }]);
    const all = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
    expect(all.filter((k) => k.startsWith("ephemera.toldEvents."))).toHaveLength(1);
    expect(all.join("|") + all.map((k) => localStorage.getItem(k)).join("|")).not.toMatch(/\bt\b/);   // no credential stored
  });
  it("a new event about a date tells the pages showing it to read it again (read or not; not for the first look)", async () => {
    setup();
    const { onPlanEvent } = require("./eventsWatch");
    const seen: number[] = [];
    const off = onPlanEvent((id: number) => seen.push(id));
    list = [ev(1)];
    await reportNewEvents();                                     // baseline: nothing
    list = [ev(1), { ...ev(2), plan_id: 8, kind: "telegram_auto" }, { ...ev(3, 9), plan_id: 9 }];
    await reportNewEvents();
    expect(seen.sort()).toEqual([8, 9]);
    await reportNewEvents();
    expect(seen).toHaveLength(2);                                // not again
    off();
  });
  it("records are per engine + credential, and logout drops that record", async () => {
    setup();
    list = [ev(1)];
    await reportNewEvents();
    const keys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter((k) => k.startsWith("ephemera.toldEvents."));
    expect(keys()).toHaveLength(1);
    __setSession({ credential: "other" });
    await reportNewEvents();
    expect(keys()).toHaveLength(2);
    logout();
    await new Promise((r) => setTimeout(r, 20));
    expect(keys()).toHaveLength(1);
  });
});

describe("small pure pieces", () => {
  it("keyboard: how far a field must move to sit above the keyboard", () => {
    expect(liftNeeded(500, 844, 300, 40)).toBe(0);
    expect(liftNeeded(600, 844, 300, 40)).toBe(96);
  });
  it("tilt: gamma → roll, beta relative to the first reading → pitch (radians)", () => {
    const a = readingToTilt(45, 10, null)!;
    expect(a.baseline).toBe(45);
    expect(a.pitch).toBe(0);
    expect(a.roll).toBeCloseTo((10 * Math.PI) / 180);
    expect(readingToTilt(55, 0, 45)!.pitch).toBeCloseTo((10 * Math.PI) / 180);
    expect(readingToTilt(null, 1, null)).toBeNull();
  });
  it("HEIC/AVIF size from the 'ispe' box when the browser cannot decode", () => {
    const b = new Uint8Array(64);
    b.set([0, 0, 0, 20, 0x69, 0x73, 0x70, 0x65, 0, 0, 0, 0], 8);
    new DataView(b.buffer).setUint32(20, 4032);
    new DataView(b.buffer).setUint32(24, 3024);
    expect(ispeSize(b.buffer)).toEqual({ width: 4032, height: 3024 });
    expect(ispeSize(new Uint8Array(32).buffer)).toBeNull();
  });
  it("time zone offsets follow the engine's zone (no fixed +9)", () => {
    const sec = Date.UTC(2026, 0, 15, 12) / 1000;
    expect(offsetIn("UTC", sec)).toBe(0);
    expect(offsetIn("Asia/Shanghai", sec)).toBe(8 * 3600);
    expect(offsetIn("America/New_York", sec)).toBe(-5 * 3600);
    expect(offsetIn("Not/AZone", sec)).toBe(0);
  });
  it("config: names default to 她/他; place search defaults to press-to-search", () => {
    const c = mergeConfig({});
    expect([c.her, c.him, c.place_service.supports_autocomplete]).toEqual(["她", "他", false]);
    expect(mergeConfig({ her: " ", him: "阿远" })).toMatchObject({ her: "她", him: "阿远" });
  });
});

describe("demo engine", () => {
  const get = async (p: string) => (await demoFetch(p)).json();
  const post = async (p: string, body: unknown) => demoFetch(p, { method: "POST", body: JSON.stringify(body) });
  it("preparing → sent (an envelope) → the day (stops open at their time) → kept in the box", async () => {
    resetDemo();
    expect((await get("/api/dates")).plans).toEqual([]);
    expect((await get("/api/dates/preparing")).plans).toHaveLength(1);
    fastForward();
    const sent = (await get("/api/dates")).plans[0];
    expect(sent.status).toBe("sent");
    expect((await get("/api/dates/events")).events.map((e: { kind: string }) => e.kind)).toEqual(["envelope"]);
    expect((await post("/api/dates/1/her/mark", { key: "checkin:11", on: true })).status).toBe(409);   // not the day yet
    fastForward();                                          // the day, before the first stop
    expect((await post("/api/dates/1/her/mark", { key: "checkin:11", on: true })).status).toBe(409);
    fastForward();                                          // 18:00
    expect((await post("/api/dates/1/her/mark", { key: "checkin:11", on: true })).status).toBe(200);
    expect((await get("/api/dates/1")).stops[1].place).toBeNull();   // the next stop is still hidden
    while (nextStepLabel() && demoState().step !== "done") fastForward();
    const kept = await get("/api/dates/1");
    expect(kept.status).toBe("done");
    expect(kept.stops.every((s: { place: unknown }) => s.place)).toBe(true);
    expect(kept.card).toBeTruthy();
  });
});

describe("press-to-search place search (OSM default)", () => {
  it("typing sends nothing; 「搜索」 sends the last text once; the fallback notice is kept", async () => {
    __setSession({ mode: "standalone", phase: "ready", config: mergeConfig({ place_service: { supports_autocomplete: false, available: true } }) });
    const calls: string[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (u: string) => {
      calls.push(u);
      return json(200, { items: [{ title: "河边书店", address: "A 路 1 号", lat: 1, lng: 2, source: "osm", provider_id: "n1" }], notice: "没配谷歌钥匙，这次是用 OpenStreetMap 搜的" });
    });
    jest.useFakeTimers();
    const { usePlaceSearch } = require("../features/ephemera/BackfillParts");
    let s!: ReturnType<typeof usePlaceSearch>;
    function Probe() { s = usePlaceSearch(); return null; }
    act(() => { create(<Probe />); });
    act(() => { s.query("河边", "row"); s.query("河边书", "row"); jest.advanceTimersByTime(2000); });
    expect(calls).toEqual([]);
    expect(s.needsSubmit("row")).toBe(true);
    jest.useRealTimers();
    await act(async () => { s.submit("row"); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0])).toContain("q=河边书");
    expect(s.hits[0]).toMatchObject({ source: "osm", provider_id: "n1" });
    expect(s.notice).toContain("OpenStreetMap");
    expect(s.needsSubmit("row")).toBe(false);
  });
});

// ── review round: sign-out, host photo picks, links, English forms of address ─────────────────
import { __photoUrlCount, ephemeraApi } from "../lib/ephemeraApi";
import { getSession, herEn, himEn, logout } from "./session";
import { openExternal } from "./external";
import { base64Bytes, dataToBlob, fetchLimited, launchImageLibraryAsync } from "../shims/image-picker";
import { PHOTO_MAX_BYTES, PHOTO_TOO_BIG_TEXT, PHOTO_BAD_TYPE_TEXT } from "./protocol";
import { envelopeFrom } from "../features/ephemera/backfill";

describe("sign-out forgets the photos", () => {
  it("logout revokes every photo object URL and empties the cache; the next read fetches again", async () => {
    __setSession({ mode: "standalone", phase: "ready", apiBase: "", credential: "t" });
    const made: string[] = [], revoked: string[] = [];
    const U = URL as unknown as { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
    const oc = U.createObjectURL, orv = U.revokeObjectURL;
    U.createObjectURL = () => { const u = `blob:p${made.length}`; made.push(u); return u; };
    U.revokeObjectURL = (u: string) => { revoked.push(u); };
    const f = jest.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["x"]), json: async () => ({}) }) as unknown as Response);
    (global as unknown as { fetch: unknown }).fetch = f;
    const a = await ephemeraApi.photoSource(1, 7);
    await ephemeraApi.photoSource(1, 7);
    expect(f).toHaveBeenCalledTimes(1);                 // cached
    expect(__photoUrlCount()).toBe(1);
    logout();
    await Promise.resolve(); await Promise.resolve();
    expect(revoked).toEqual([a.uri]);
    expect(__photoUrlCount()).toBe(0);
    expect(getSession().credential).toBeNull();
    U.createObjectURL = oc; U.revokeObjectURL = orv;
  });
});

describe("photos from the host", () => {
  const send = (reply: Record<string, unknown>) => {
    const posted: Array<Record<string, unknown>> = [];
    const listeners: Array<(e: unknown) => void> = [];
    const parent = { postMessage: (m: Record<string, unknown>) => { posted.push(m); if (m.type === "pickPhoto") setTimeout(() => listeners.forEach((l) => l({ data: { id: m.id, ...reply }, origin: "https://h.example", source: parent })), 0); } };
    const w = { parent, location: { search: "?host=https%3A%2F%2Fh.example" }, addEventListener: (_t: string, l: (e: unknown) => void) => listeners.push(l), removeEventListener() {} };
    startSession("iframe", w as never);
    installHost(w as never);
    return posted;
  };
  const jpeg = (n: number) => Buffer.alloc(n, 1).toString("base64");
  it("a picked photo (data) becomes an asset with the host's width/height, through launchImageLibraryAsync", async () => {
    const U = URL as unknown as { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
    U.createObjectURL = () => "blob:picked"; U.revokeObjectURL = () => {};
    const posted = send({ ok: true, result: { file: { name: "a.jpg", mime: "image/jpeg", size: 30, width: 4032, height: 3024, data: jpeg(30) } } });
    const r = await launchImageLibraryAsync({});
    expect(posted.find((m) => m.type === "pickPhoto")?.payload).toEqual({ max: 1 });
    expect(r).toMatchObject({ canceled: false, assets: [{ uri: "blob:picked", width: 4032, height: 3024, mimeType: "image/jpeg", fileSize: 30 }] });
  });
  it("the host reports a type the engine does not take: a readable refusal", async () => {
    send({ ok: true, file: { name: "a.gif", mime: "image/gif", size: 30, width: 10, height: 10, data: jpeg(30) } });
    await expect(launchImageLibraryAsync({})).rejects.toThrow(PHOTO_BAD_TYPE_TEXT);
  });
  it("over 20 MB (by the host's size, or by the data itself) is refused before decoding", async () => {
    send({ ok: true, file: { name: "a.jpg", mime: "image/jpeg", size: PHOTO_MAX_BYTES + 1, width: 10, height: 10, data: "AAAA" } });
    await expect(launchImageLibraryAsync({})).rejects.toThrow(PHOTO_TOO_BIG_TEXT);
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AA==")).toBe(1);
    expect(() => dataToBlob("A".repeat(Math.ceil((PHOTO_MAX_BYTES + 3) / 3) * 4), "image/jpeg")).toThrow(PHOTO_TOO_BIG_TEXT);
  });
  it("an address from the host: only https / blob / data, read at most 20 MB", async () => {
    await expect(fetchLimited("javascript:alert(1)", "image/jpeg")).rejects.toThrow("选图没有成功");
    await expect(fetchLimited("http://x.example/a.jpg", "image/jpeg")).rejects.toThrow("选图没有成功");
    await expect(fetchLimited("file:///etc/passwd", "image/jpeg")).rejects.toThrow("选图没有成功");
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024 * 1024)); if (pulled > 40) c.close(); } });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: stream }));
    await expect(fetchLimited("https://x.example/a.jpg", "image/jpeg")).rejects.toThrow(PHOTO_TOO_BIG_TEXT);
    expect(pulled).toBeLessThanOrEqual(22);           // stopped right after the limit, not read to the end
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, headers: new Headers({ "content-length": String(PHOTO_MAX_BYTES + 1) }), body: null }));
    await expect(fetchLimited("https://x.example/a.jpg", "image/jpeg")).rejects.toThrow(PHOTO_TOO_BIG_TEXT);
    const small = await fetchLimited(`data:image/png;base64,${Buffer.from("abc").toString("base64")}`, "image/png");
    expect(small.size).toBe(3);
  });
});

describe("links leaving the package", () => {
  it("openExternal: http(s) only; javascript: and others are dropped", () => {
    const opened: string[] = [];
    (globalThis as { open?: unknown }).open = (u: string) => { opened.push(u); };
    __setSession({ mode: "standalone" });
    openExternal("javascript:alert(1)");
    openExternal("data:text/html,x");
    openExternal("https://maps.example/?q=a");
    expect(opened).toEqual(["https://maps.example/?q=a"]);
  });
});

describe("English forms of address", () => {
  it("her_en / him_en from /api/config; missing or blank → Her / Him; Chinese names stay for Chinese lines", () => {
    __setSession({ config: mergeConfig({ her: "小满", him: "阿远" }) });
    expect([herEn(), himEn()]).toEqual(["Her", "Him"]);
    expect(envelopeFrom({ sent_at: 1 })).toBe("from Him");
    __setSession({ config: mergeConfig({ her: "小满", him: "阿远", her_en: " Lin ", him_en: "Ari" }) });
    expect([herEn(), himEn()]).toEqual(["Lin", "Ari"]);
    expect(envelopeFrom({ sent_at: 1 })).toBe("from Ari");
    expect(envelopeFrom({ sent_at: null })).toBe("from us");
    __setSession({ config: mergeConfig({ her_en: "", him_en: "  " }) });
    expect([herEn(), himEn()]).toEqual(["Her", "Him"]);
  });
});

describe("host run fixes", () => {
  it("keyboard: the document is put back at the top only while the keyboard is up for a field (a browser's own scrolling is left alone)", () => {
    const { shouldUnpan, isTextField } = require("../shims/keyboard-controller");
    expect(shouldUnpan(true, true, 336)).toBe(true);       // iOS panned to the field under the keyboard
    expect(shouldUnpan(true, false, 0)).toBe(false);       // a browser with bars scrolling the page: not ours to undo
    expect(shouldUnpan(true, true, 0)).toBe(false);        // a field focused, no keyboard (a hardware keyboard)
    expect(shouldUnpan(true, false, 336)).toBe(false);     // keyboard reading, nothing focused (it is going down)
    expect(shouldUnpan(false, true, 336)).toBe(false);
    const el = (tagName: string, extra: object = {}) => ({ tagName, ...extra }) as unknown as Element;
    expect(isTextField(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTextField(el("INPUT", { type: "search" }))).toBe(true);
    expect(isTextField(el("INPUT", { type: "file" }))).toBe(false);
    expect(isTextField(el("TEXTAREA"))).toBe(true);
    expect(isTextField(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTextField(el("DIV"))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
  it("keyboard: only a real drag closes it (the page's own scroll to the field does not)", () => {
    const { isUserDrag, DRAG_DISMISS_PX } = require("../shims/keyboard-controller");
    expect(isUserDrag(null, 300)).toBe(false);          // no finger down: a scroll made by the page
    expect(isUserDrag(100, 100 + DRAG_DISMISS_PX)).toBe(false);
    expect(isUserDrag(100, 100 + DRAG_DISMISS_PX + 1)).toBe(true);
  });
  it("keyboard: visualViewport wins when it shrinks; the host's height only where it does not; never both", () => {
    const { pickKeyboardHeight } = require("../shims/keyboard-controller");
    expect(pickKeyboardHeight(336, 290, true)).toBe(290);     // WKWebView: visualViewport shrank (and knows the pan)
    expect(pickKeyboardHeight(336, 290, null)).toBe(290);
    expect(pickKeyboardHeight(336, 0, null)).toBe(0);         // host spoke first: wait for visualViewport
    expect(pickKeyboardHeight(336, 0, true)).toBe(0);
    expect(pickKeyboardHeight(336, 0, false)).toBe(336);      // adjustNothing / host keeps WebKit from adjusting
    expect(pickKeyboardHeight(null, 0, false)).toBe(0);
    expect(pickKeyboardHeight(0, 0, false)).toBe(0);
  });
  it("keyboard: a host report that arrives before visualViewport shrinks is never applied on top of it", () => {
    jest.useFakeTimers();
    const g = globalThis as unknown as { window: Record<string, unknown> };
    const saved = { ael: g.window.addEventListener, vv: g.window.visualViewport, ih: g.window.innerHeight };
    const fire: Record<string, () => void> = {};
    const vv = { height: 844, offsetTop: 0, scale: 1, addEventListener: (t: string, f: () => void) => { fire[t] = f; } };
    Object.assign(g.window, { addEventListener: () => {}, visualViewport: vv, innerHeight: 844 });
    try {
      const { hostKeyboard } = require("./host");
      const kc = require("../shims/keyboard-controller");
      kc.__resetKeyboard();
      const seen: number[] = [];
      const un = kc.__subscribeKeyboard(() => seen.push(kc.keyboardHeight()));
      hostKeyboard.set(380);                                   // keyboardWillChangeFrame: before WebKit resizes
      expect(kc.keyboardHeight()).toBe(0);
      vv.height = 844 - 336; vv.offsetTop = 120; fire.resize(); // WebKit shrinks and pans to the field
      expect(kc.keyboardHeight()).toBe(336);                    // what it covers; the pan is put back, not subtracted
      jest.advanceTimersByTime(kc.HOST_WAIT_MS + 10);
      expect(kc.keyboardHeight()).toBe(336);
      expect(seen.some((h: number) => h === 380)).toBe(false);  // the host's number never reached the pages
      hostKeyboard.set(0); vv.height = 844; vv.offsetTop = 0; fire.resize();
      expect(kc.keyboardHeight()).toBe(0);
      hostKeyboard.set(336);                                    // next time: known to track, still waits for it
      expect(kc.keyboardHeight()).toBe(0);
      un(); hostKeyboard.set(null);
      // a web view whose visualViewport never moves: the host's number after the wait
      kc.__resetKeyboard();
      const un2 = kc.__subscribeKeyboard(() => {});
      hostKeyboard.set(300);
      expect(kc.keyboardHeight()).toBe(0);
      jest.advanceTimersByTime(kc.HOST_WAIT_MS + 10);
      expect(kc.keyboardHeight()).toBe(300);
      hostKeyboard.set(0); hostKeyboard.set(280);
      expect(kc.keyboardHeight()).toBe(280);                    // learned: no wait the second time
      un2(); hostKeyboard.set(null);
      // pinch zoom shrinks the visual viewport too: not a keyboard
      kc.__resetKeyboard();
      const un3 = kc.__subscribeKeyboard(() => {});
      Object.assign(vv, { scale: 2, height: 422, offsetTop: 0 }); fire.resize();
      expect(kc.keyboardHeight()).toBe(0);
      Object.assign(vv, { scale: 1, height: 844 }); fire.resize();
      un3();
    } finally {
      Object.assign(g.window, { addEventListener: saved.ael, visualViewport: saved.vv, innerHeight: saved.ih });
      jest.useRealTimers();
    }
  });
  it("loading line: the pages' own status-line style (serif 500, 13, ink at 0.7), not a faint 12", () => {
    const { SkiaWait, LOADING_LINE } = require("./Gate");
    expect(LOADING_LINE).toEqual({ fontSize: 13, opacity: 0.7 });
    let r!: ReturnType<typeof create>;
    act(() => { r = create(<SkiaWait failed={false} />); });
    const t = r.root.findAll((n) => n.props.testID === "skia-wait" && typeof n.type === "string")[0];
    const st = Object.assign({}, ...[t.props.style].flat(5).filter(Boolean));
    expect(st.fontSize).toBe(13);
    expect(st.opacity).toBe(0.7);
    act(() => r.unmount());
  });
  it("a second init with another credential or engine first drops what the old one read (as a logout would)", async () => {
    const { connect, onLogout } = require("./session");
    const ok = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    __setSession({ mode: "iframe", phase: "ready", apiBase: "https://e", credential: "a" });
    const dropped = jest.fn();
    const off = onLogout(dropped);
    await connect("https://e", "a", false, ok);
    expect(dropped).not.toHaveBeenCalled();              // the same one again: nothing to drop
    await connect("https://e", "b", false, ok);
    expect(dropped).toHaveBeenCalledTimes(1);            // another credential
    await connect("https://other", "b", false, ok);
    expect(dropped).toHaveBeenCalledTimes(2);            // another engine
    off();
  });
  it("map: the engine's setup hint never reaches her; a readable line per case", () => {
    jest.isolateModules(() => {
      jest.doMock("../nav/router", () => ({ useLocalSearchParams: () => ({}), useRouter: () => ({}) }));
      const { mapErrorText, MAP_ERR } = require("../features/ephemera/MapScreen");
      expect(mapErrorText("no_basemap")).toBe(MAP_ERR.no_basemap);
      expect(mapErrorText("not_configured")).toBe(MAP_ERR.not_configured);
      expect(mapErrorText(undefined)).toBe(MAP_ERR.other);
      expect(Object.values(MAP_ERR).join("")).not.toMatch(/建底图|脚本/);
    });
  });
  it("events: record key is SHA-256 with a per-device salt when crypto.subtle is there; FNV otherwise", async () => {
    const { recordKey } = require("./eventsWatch");
    localStorage.clear();
    const a = await recordKey("https://e", "secret-token");
    expect(a).toMatch(/^ephemera\.toldEvents\.[0-9a-f]{24}$/);
    const salt = localStorage.getItem("ephemera.deviceSalt");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(await recordKey("https://e", "secret-token")).toBe(a);            // same salt, same key
    expect(await recordKey("https://e", "other")).not.toBe(a);
    localStorage.setItem("ephemera.deviceSalt", "another-device");
    expect(await recordKey("https://e", "secret-token")).not.toBe(a);         // another device, another key
    const saved = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    const { fingerprint } = require("./eventsWatch");
    expect(await recordKey("https://e", "secret-token")).toBe(`ephemera.toldEvents.${fingerprint("https://e", "secret-token")}`);
    Object.defineProperty(globalThis, "crypto", { value: saved, configurable: true });
  });
  it("push: the engine's Chinese sentence is kept (string or {text}); anything else is a line by status", () => {
    const { pushErrorText } = require("./webPush");
    expect(pushErrorText(400, "最多 20 个设备")).toBe("最多 20 个设备");
    expect(pushErrorText(503, { code: "x", text: "网页推送没有配置" })).toBe("网页推送没有配置");
    expect(pushErrorText(500, "Internal Server Error")).toBe("后台出错了（HTTP 500），等一下再试");
    expect(pushErrorText(502, null)).toBe("后台出错了（HTTP 502），等一下再试");
  });
  it("events: fingerprint is stable, differs per credential, does not contain it", () => {
    const { fingerprint } = require("./eventsWatch");
    expect(fingerprint("https://e", "secret-token")).toBe(fingerprint("https://e", "secret-token"));
    expect(fingerprint("https://e", "a")).not.toBe(fingerprint("https://e", "b"));
    expect(fingerprint("https://e", "secret-token")).not.toContain("secret");
  });
});
