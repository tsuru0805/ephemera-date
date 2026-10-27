// Embedding protocol v1 (docs/EMBED.md), page side: every signal, the origin checks, init failures,
// cancelled photo picks, back at the bottom of the history, background/foreground.
import { ask, hostKeyboard, hostSafeArea, installHost, lifecycle, onResume, queueNavigate, receive, setNavigateHandler, tell, __resetHost } from "./host";
import {
  asInit, parseIncoming, photoProblem, PHOTO_BAD_TYPE_TEXT, PHOTO_MAX_BYTES, PHOTO_NO_SIZE_TEXT, PHOTO_TOO_BIG_TEXT, readPickReply,
  REQUEST_TIMEOUT_MS, trustedIframeEvent,
} from "./protocol";
import { __resetSession, __setSession, detectMode, getSession, registeredHostOrigin, startSession } from "./session";
import { safeBack } from "../nav/router";

const HOST = "https://app.example.com";

type Posted = { msg: Record<string, unknown>; target: string };
function fakeIframeWindow(opts: { search?: string; ancestor?: string } = {}) {
  const listeners: Array<(e: unknown) => void> = [];
  const posted: Posted[] = [];
  const parent = { postMessage: (msg: Record<string, unknown>, target: string) => posted.push({ msg, target }) };
  const w = {
    parent,
    location: { search: opts.search ?? `?host=${encodeURIComponent(HOST)}`, ancestorOrigins: opts.ancestor ? { length: 1, 0: opts.ancestor } : undefined },
    addEventListener: (t: string, f: (e: unknown) => void) => { if (t === "message") listeners.push(f); },
    removeEventListener: (t: string, f: (e: unknown) => void) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  };
  const deliver = (data: unknown, origin = HOST, source: unknown = parent) => listeners.forEach((f) => f({ data, origin, source }));
  return { w, posted, deliver, parent };
}

const okConfig = { title: "Ephemera", tz: "Asia/Shanghai", her: "小满", him: "阿远", place_service: { supports_autocomplete: false } };
function mockFetch(status = 200, body: unknown = okConfig) {
  const f = jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);
  (global as unknown as { fetch: unknown }).fetch = f;
  return f;
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => { __resetHost(); __resetSession(); localStorage.clear(); sessionStorage.clear(); });

describe("message format", () => {
  it("accepts {v:1,id,type,payload} for host→page types only; replies by id+ok", () => {
    expect(parseIncoming({ v: 1, id: "a", type: "init", payload: {} })).toMatchObject({ kind: "message" });
    expect(parseIncoming(JSON.stringify({ v: 1, id: "a", type: "navigate", payload: { page: "home" } }))).toMatchObject({ kind: "message" });
    expect(parseIncoming({ v: 2, id: "a", type: "init" })).toBeNull();          // other version
    expect(parseIncoming({ v: 1, id: "a", type: "close" })).toBeNull();         // a page→host type coming in
    expect(parseIncoming({ v: 1, type: "init" })).toBeNull();                   // no id
    expect(parseIncoming("not json")).toBeNull();
    expect(parseIncoming({ id: "a", ok: true, result: 1 })).toMatchObject({ kind: "reply" });
  });
  it("init needs apiBase (http/https or empty = same origin) and credential", () => {
    expect(asInit({ apiBase: "https://e.example/", credential: "t" })).toMatchObject({ apiBase: "https://e.example", credential: "t" });
    expect(asInit({ apiBase: "", credential: "t" })).toMatchObject({ apiBase: "" });
    expect(asInit({ apiBase: "javascript:alert(1)", credential: "t" })).toBeNull();
    expect(asInit({ apiBase: "https://e.example" })).toBeNull();
  });
});

describe("origin checks (iframe)", () => {
  it("only the registered origin AND the direct parent window", () => {
    const parent = {};
    expect(trustedIframeEvent({ origin: HOST, source: parent }, HOST, parent)).toBe(true);
    expect(trustedIframeEvent({ origin: "https://evil.example", source: parent }, HOST, parent)).toBe(false);
    expect(trustedIframeEvent({ origin: HOST, source: {} }, HOST, parent)).toBe(false);       // another window of the same origin
    expect(trustedIframeEvent({ origin: HOST, source: parent }, null, parent)).toBe(false);   // nothing registered
  });
  it("?host= is the registered origin; a framing page cannot claim another origin than its own", () => {
    expect(registeredHostOrigin({ location: { search: `?host=${encodeURIComponent(HOST + "/path")}` } } as never)).toBe(HOST);
    expect(registeredHostOrigin({ location: { search: `?host=${encodeURIComponent(HOST)}`, ancestorOrigins: { length: 1, 0: "https://evil.example" } } } as never)).toBeNull();
    expect(registeredHostOrigin({ location: { search: "", ancestorOrigins: { length: 1, 0: HOST } } } as never)).toBe(HOST);
  });
  it("mode: iframe when framed, native when a bridge is there, demo with ?demo=1, standalone otherwise", () => {
    const self: Record<string, unknown> = { location: { search: "" } };
    self.parent = self;
    expect(detectMode(self as never, false)).toBe("standalone");
    expect(detectMode({ location: { search: "" }, parent: {} } as never, false)).toBe("iframe");
    expect(detectMode({ location: { search: "" }, parent: {}, webkit: { messageHandlers: { ephemera: {} } } } as never, false)).toBe("native");
    expect(detectMode({ location: { search: "?demo=1" }, parent: {} } as never, false)).toBe("demo");
  });
  it("messages from another origin or another window do nothing", async () => {
    const { w, deliver, posted } = fakeIframeWindow();
    const f = mockFetch();
    startSession("iframe", w as never);
    installHost(w as never);
    deliver({ v: 1, id: "x", type: "init", payload: { apiBase: "https://e.example", credential: "t" } }, "https://evil.example");
    deliver({ v: 1, id: "y", type: "init", payload: { apiBase: "https://e.example", credential: "t" } }, HOST, {});
    await flush();
    expect(f).not.toHaveBeenCalled();
    expect(getSession().phase).toBe("waiting-init");
    expect(posted.map((p) => p.msg.type)).toEqual(["ready"]);
  });
});

describe("handshake", () => {
  it("ready{v} goes to the registered origin (never *); init → config read → ok reply; credential only in memory", async () => {
    const { w, deliver, posted } = fakeIframeWindow();
    const f = mockFetch();
    startSession("iframe", w as never);
    installHost(w as never);
    expect(posted[0]).toMatchObject({ target: HOST, msg: { v: 1, type: "ready", payload: { v: 1 } } });
    expect(posted.every((p) => p.target !== "*")).toBe(true);
    deliver({ v: 1, id: "i1", type: "init", payload: { apiBase: "https://e.example", credential: "secret-1", safeArea: { top: 47, right: 0, bottom: 34, left: 0 }, theme: "blue" } });
    await flush();
    expect(f).toHaveBeenCalledWith("https://e.example/api/config", { headers: { Authorization: "Bearer secret-1" } });
    expect(getSession()).toMatchObject({ phase: "ready", credential: "secret-1", apiBase: "https://e.example", theme: "blue" });
    expect(getSession().config).toMatchObject({ her: "小满", him: "阿远", tz: "Asia/Shanghai" });
    expect(hostSafeArea.get()).toEqual({ top: 47, right: 0, bottom: 34, left: 0 });
    expect(posted.find((p) => p.msg.id === "i1")?.msg).toMatchObject({ ok: true });
    expect(JSON.stringify({ ...localStorage })).not.toContain("secret-1");
    expect(localStorage.getItem("ephemera.credential")).toBeNull();
  });
  it("init that the engine refuses: reply ok:false with the reason, page stays without data", async () => {
    const { w, deliver, posted } = fakeIframeWindow();
    mockFetch(401, { detail: "missing or wrong token" });
    startSession("iframe", w as never);
    installHost(w as never);
    deliver({ v: 1, id: "i2", type: "init", payload: { apiBase: "https://e.example", credential: "bad" } });
    await flush();
    expect(posted.find((p) => p.msg.id === "i2")?.msg).toMatchObject({ ok: false, error: "口令不对" });
    expect(getSession()).toMatchObject({ phase: "failed", credential: null });
  });
  it("init without a credential: ok:false, nothing fetched", async () => {
    const { w, deliver, posted } = fakeIframeWindow();
    const f = mockFetch();
    startSession("iframe", w as never);
    installHost(w as never);
    deliver({ v: 1, id: "i3", type: "init", payload: { apiBase: "https://e.example" } });
    await flush();
    expect(f).not.toHaveBeenCalled();
    expect(posted.find((p) => p.msg.id === "i3")?.msg).toMatchObject({ ok: false });
  });
  it("navigate before init is queued and replayed in order after init; init.route goes first", async () => {
    const { w, deliver } = fakeIframeWindow();
    mockFetch();
    startSession("iframe", w as never);
    installHost(w as never);
    const seen: string[] = [];
    setNavigateHandler((t) => seen.push(`${t.page}:${t.planId ?? ""}`));
    deliver({ v: 1, id: "n1", type: "navigate", payload: { page: "box", planId: 3 } });
    deliver({ v: 1, id: "n2", type: "navigate", payload: { page: "telegrams" } });
    await flush();
    expect(seen).toEqual([]);
    deliver({ v: 1, id: "i4", type: "init", payload: { apiBase: "", credential: "t", route: { page: "seal", planId: 2 } } });
    await flush();
    expect(seen).toEqual(["seal:2", "box:3", "telegrams:"]);
    queueNavigate({ page: "me" });
    expect(seen.at(-1)).toBe("me:");
  });
});

describe("host → page", () => {
  async function ready() {
    const env = fakeIframeWindow();
    mockFetch();
    startSession("iframe", env.w as never);
    installHost(env.w as never);
    env.deliver({ v: 1, id: "init", type: "init", payload: { apiBase: "", credential: "t" } });
    await flush();
    return env;
  }
  it("lifecycle: background stops, active refreshes (reload + missed events)", async () => {
    const { deliver } = await ready();
    const resumed = jest.fn();
    onResume(resumed);
    deliver({ v: 1, id: "l1", type: "lifecycle", payload: { state: "background" } });
    expect(lifecycle.get()).toBe("background");
    expect(resumed).not.toHaveBeenCalled();
    deliver({ v: 1, id: "l2", type: "lifecycle", payload: { state: "active" } });
    expect(lifecycle.get()).toBe("active");
    expect(resumed).toHaveBeenCalledTimes(1);
  });
  it("safeArea and keyboard update what the pages read; bad payloads are refused", async () => {
    const { deliver, posted } = await ready();
    deliver({ v: 1, id: "s1", type: "safeArea", payload: { top: 20, right: 0, bottom: 10, left: 0 } });
    expect(hostSafeArea.get()).toEqual({ top: 20, right: 0, bottom: 10, left: 0 });
    deliver({ v: 1, id: "k1", type: "keyboard", payload: { height: 336 } });
    expect(hostKeyboard.get()).toBe(336);
    deliver({ v: 1, id: "k2", type: "keyboard", payload: { height: 0 } });
    expect(hostKeyboard.get()).toBe(0);
    deliver({ v: 1, id: "l3", type: "lifecycle", payload: { state: "sleeping" } });
    expect(posted.find((p) => p.msg.id === "l3")?.msg).toMatchObject({ ok: false });
  });
  it("logout clears the credential and waits for a new init", async () => {
    const { deliver, posted } = await ready();
    expect(getSession().credential).toBe("t");
    deliver({ v: 1, id: "o1", type: "logout" });
    expect(getSession()).toMatchObject({ credential: null, phase: "waiting-init" });
    expect(posted.find((p) => p.msg.id === "o1")?.msg).toMatchObject({ ok: true });
  });
});

describe("page → host", () => {
  it("event / openExternal / close are posted to the registered origin", async () => {
    const { w, posted } = fakeIframeWindow();
    startSession("iframe", w as never);
    installHost(w as never);
    tell("event", { kind: "envelope", planId: 4 });
    tell("openExternal", { url: "https://maps.example/?q=x" });
    tell("close");
    expect(posted.slice(1).map((p) => [p.msg.type, p.target])).toEqual([["event", HOST], ["openExternal", HOST], ["close", HOST]]);
    expect(posted[1].msg).toMatchObject({ v: 1, payload: { kind: "envelope", planId: 4 } });
  });
  it("back: inside the page history = back; at the bottom = close (embedded) / home (standalone)", () => {
    const { w, posted } = fakeIframeWindow();
    startSession("iframe", w as never);
    installHost(w as never);
    const r = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() };
    safeBack(r);
    expect(r.back).toHaveBeenCalled();
    r.canGoBack.mockReturnValue(false);
    safeBack(r);
    expect(posted.at(-1)?.msg.type).toBe("close");
    expect(r.replace).not.toHaveBeenCalled();
    __setSession({ mode: "standalone" });
    safeBack(r);
    expect(r.replace).toHaveBeenCalledWith("/ephemera");
  });
  it("requests time out after 10 s as a failure", async () => {
    jest.useFakeTimers();
    const { w } = fakeIframeWindow();
    __setSession({ mode: "iframe", hostOrigin: HOST });
    installHost(w as never);
    const p = ask("openExternal" as never, {});
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1);
    await expect(p).resolves.toMatchObject({ ok: false, error: "timeout" });
    jest.useRealTimers();
  });
  it("pickPhoto: the reply with the same id resolves the request (file / cancelled / error)", async () => {
    const { w, deliver, posted } = fakeIframeWindow();
    startSession("iframe", w as never);
    installHost(w as never);
    const p = ask("pickPhoto", { max: 1 });
    const req = posted.at(-1)!.msg;
    expect(req).toMatchObject({ v: 1, type: "pickPhoto", payload: { max: 1 } });
    deliver({ id: req.id, ok: false, cancelled: true });
    await expect(p).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(readPickReply({ id: "x", ok: false, cancelled: true })).toEqual({ cancelled: true });
  });
});

describe("photo contract", () => {
  const f = { name: "a.jpg", mime: "image/jpeg", size: 1000, width: 4032, height: 3024, data: "AAAA" };
  it("jpeg/png/heic/heif/avif only, ≤ 20 MB, width/height required", () => {
    for (const mime of ["image/jpeg", "image/png", "image/heic", "image/heif", "image/avif"]) expect(photoProblem({ ...f, mime })).toBeNull();
    expect(photoProblem({ ...f, mime: "image/gif" })).toBe(PHOTO_BAD_TYPE_TEXT);
    expect(photoProblem({ ...f, size: PHOTO_MAX_BYTES })).toBeNull();
    expect(photoProblem({ ...f, size: PHOTO_MAX_BYTES + 1 })).toBe(PHOTO_TOO_BIG_TEXT);
    expect(photoProblem({ ...f, width: 0 })).toBe(PHOTO_NO_SIZE_TEXT);
  });
  it("reply shapes: {result:{file}} or a top-level file; bad files become an error; data or url required", () => {
    expect(readPickReply({ id: "1", ok: true, result: { file: f } })).toEqual({ file: { ...f, url: undefined } });
    expect(readPickReply({ id: "1", ok: true, file: { ...f, data: undefined, url: "blob:x" } })).toMatchObject({ file: { url: "blob:x" } });
    expect(readPickReply({ id: "1", ok: true, file: { ...f, size: PHOTO_MAX_BYTES + 5 } })).toEqual({ error: PHOTO_TOO_BIG_TEXT });
    expect(readPickReply({ id: "1", ok: true, file: { ...f, data: undefined } })).toEqual({ error: "选图没有成功" });
    expect(readPickReply({ id: "1", ok: false, error: "相册打不开" })).toEqual({ error: "相册打不开" });
  });
});

describe("native bridge", () => {
  it("page → host through webkit.messageHandlers.ephemera (JSON); host → page by window.ephemera.receive", async () => {
    const sent: string[] = [];
    const w: Record<string, unknown> = { webkit: { messageHandlers: { ephemera: { postMessage: (m: string) => sent.push(m) } } }, addEventListener() {}, removeEventListener() {} };
    mockFetch();
    startSession("native", w as never);
    installHost(w as never);
    expect(JSON.parse(sent[0])).toMatchObject({ v: 1, type: "ready" });
    (w.ephemera as { receive: (m: unknown) => void }).receive(JSON.stringify({ v: 1, id: "n-init", type: "init", payload: { apiBase: "https://e.example", credential: "c" } }));
    await flush();
    expect(getSession().phase).toBe("ready");
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ id: "n-init", ok: true });
  });
  it("react-native-webview bridge is used when that is what the host gives", () => {
    const sent: string[] = [];
    const w = { ReactNativeWebView: { postMessage: (m: string) => sent.push(m) }, addEventListener() {}, removeEventListener() {} };
    startSession("native", w as never);
    installHost(w as never);
    tell("close");
    expect(sent.map((m) => JSON.parse(m).type)).toEqual(["ready", "close"]);
  });
});

describe("Android bridge and a second sign-in", () => {
  it("EphemeraHost (Android addJavascriptInterface): page → host as JSON strings; init through window.ephemera.receive", async () => {
    const sent: string[] = [];
    const w: Record<string, unknown> = { EphemeraHost: { postMessage: (m: string) => sent.push(m) }, addEventListener() {}, removeEventListener() {} };
    mockFetch();
    startSession("native", w as never);
    installHost(w as never);
    expect(JSON.parse(sent[0])).toMatchObject({ v: 1, type: "ready", payload: { v: 1 } });
    (w.ephemera as { receive: (m: unknown) => void }).receive(JSON.stringify({ v: 1, id: "a1", type: "init", payload: { apiBase: "https://e.example", credential: "c" } }));
    await flush();
    expect(getSession().phase).toBe("ready");
    tell("close");
    expect(sent.map((m) => JSON.parse(m)).map((m) => m.type ?? (m.ok ? "ok" : "fail"))).toEqual(["ready", "ok", "close"]);
  });
  it("logout, then a new init: back to ready with the new credential", async () => {
    const { w, deliver, posted } = fakeIframeWindow();
    mockFetch();
    startSession("iframe", w as never);
    installHost(w as never);
    deliver({ v: 1, id: "i-a", type: "init", payload: { apiBase: "", credential: "first" } });
    await flush();
    expect(getSession()).toMatchObject({ phase: "ready", credential: "first" });
    deliver({ v: 1, id: "o", type: "logout" });
    expect(getSession()).toMatchObject({ phase: "waiting-init", credential: null });
    deliver({ v: 1, id: "i-b", type: "init", payload: { apiBase: "", credential: "second" } });
    await flush();
    expect(getSession()).toMatchObject({ phase: "ready", credential: "second" });
    expect(posted.find((p) => p.msg.id === "i-b")?.msg).toMatchObject({ ok: true });
  });
});

describe("receive() ignores replies nobody waits for", () => {
  it("no throw", () => { expect(() => receive({ id: "nobody", ok: true })).not.toThrow(); });
});
