/// <reference types="jest" />
// The chat-card reference example (examples/chat-card, outside the web package) renders and points each event
// to the page the engine's webhook names.
import { act, create } from "react-test-renderer";
// (required, not imported: the example lives outside this package and is type-checked on its own — see its README)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DateEventCard, DateRemindCard, SealedThinking, eventFromWebhook, navigateFor } = require("../../examples/chat-card/ChatCards");
type DateEvent = { id: number; plan_id: number; kind: string; text: string; created_at: number; read_at: number | null };

const plan = { id: 7, paper_no: "0007", title_en: "A Quiet\nRiver Walk", date: "2026-10-28" };
const ev = (kind: string, text: string): DateEvent => ({ id: 1, plan_id: 7, kind, text, created_at: 1793000000, read_at: null });
const texts = (r: ReturnType<typeof create>) => r.root.findAll((n) => typeof n.type === "string" && typeof n.props.children === "string").map((n) => n.props.children as string);

describe("chat-card example", () => {
  it("each event kind renders, and goes to the page the engine names", () => {
    const cases: Array<[string, string, string]> = [
      ["envelope", "你收到一封信", "seal"], ["telegram_manual", "第 3 站跳过了：太晚了", "telegrams"],
      ["telegram_auto", "第 2 站的路线写好了", "telegrams"], ["cancel", "这次约会取消了", "telegrams"],
      ["close", "这次约会收进纪念盒了", "box"], ["late_written", "他补写好了", "box"],
    ];
    for (const [kind, text, page] of cases) {
      const go = jest.fn();
      let r!: ReturnType<typeof create>;
      act(() => { r = create(<DateEventCard event={ev(kind, text)} plan={plan} onOpen={go} formatAt={() => "10/28 19:05"} />); });
      expect(texts(r)).toContain(text);
      const card = r.root.findAll((n) => typeof n.props.onPress === "function")[0];
      act(() => { card.props.onPress(); });
      const to = { page, planId: page === "telegrams" ? null : 7 };   // as the engine's webhook navigate
      expect(go).toHaveBeenCalledWith(to);
      expect(navigateFor(ev(kind, text))).toEqual(to);
      act(() => r.unmount());
    }
  });
  it("cancel carries the CANCELLED stamp; close the date's name and paper number", () => {
    let r!: ReturnType<typeof create>;
    act(() => { r = create(<DateEventCard event={ev("cancel", "取消了")} plan={plan} />); });
    expect(texts(r)).toContain("CANCELLED");
    act(() => { r.update(<DateEventCard event={ev("close", "收进纪念盒了")} plan={plan} />); });
    expect(texts(r)).toContain("「A Quiet River Walk」");
    expect(texts(r)).toContain("No. 0007");
  });
  it("a webhook body becomes the event the cards take; the reminder card renders", () => {
    const e = eventFromWebhook({ type: "event", kind: "envelope", title: "你收到一封信", body: "Ephemera · 10/28", plan_id: 7, event_id: 9, navigate: { page: "seal", planId: 7 } }, 100);
    expect(e).toEqual({ id: 9, plan_id: 7, kind: "envelope", text: "你收到一封信", created_at: 100, read_at: null });
    let r!: ReturnType<typeof create>;
    act(() => { r = create(<DateRemindCard head="今晚七点见" sub="河畔车站 · 东口" at="19:00" stampDate="OCT 28" />); });
    expect(texts(r)).toEqual(expect.arrayContaining(["今晚七点见", "河畔车站 · 东口", "19:00"]));
  });
  it("the sealed thinking: sealed → asks first (his name in it) → 揭开 gives the place back to the thinking block", () => {
    const { Text } = require("react-native");
    const reveal = jest.fn();
    const open = () => <Text testID="thinking">the thinking block</Text>;
    const byId = (r: ReturnType<typeof create>, id: string) => r.root.findAll((n) => typeof n.type === "string" && n.props.testID === id);
    let r!: ReturnType<typeof create>;
    act(() => { r = create(<SealedThinking sealed onReveal={reveal} renderOpen={open} him="阿远" />); });
    const said = r.root.findAll((n) => typeof n.type === "string" && Array.isArray(n.props.children))
      .map((n) => (n.props.children as unknown[]).map((c) => (typeof c === "string" ? c : "")).join(""));
    expect(texts(r)).toContain("这一轮在写约会");
    expect(said).toContain(" · 内容保密");
    expect(texts(r)).toEqual(expect.arrayContaining(["THIS TURN · SEALED", "EPHEMERA", "揭开看看 ›"]));
    expect(byId(r, "thinking")).toHaveLength(0);
    const press = (id: string) => act(() => { r.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function")[0].props.onPress(); });
    press("date-sealed-reveal");
    expect(texts(r)).toContain("揭开会看到阿远写的约会内容，确定吗？");
    press("date-sealed-no");                                    // 先不看: sealed again, nothing reported
    expect(texts(r)).toContain("揭开看看 ›");
    expect(reveal).not.toHaveBeenCalled();
    press("date-sealed-reveal");
    press("date-sealed-yes");
    expect(byId(r, "thinking")).toHaveLength(1);
    expect(byId(r, "date-sealed-thinking")).toHaveLength(0);
    expect(reveal).toHaveBeenCalledTimes(1);
    // not sealed: the thinking block at once; the default name in the question is 他
    act(() => { r.update(<SealedThinking sealed={false} renderOpen={open} />); });
    expect(byId(r, "thinking")).toHaveLength(1);
    act(() => { r.unmount(); r = create(<SealedThinking sealed renderOpen={open} />); });
    press("date-sealed-reveal");
    expect(texts(r)).toContain("揭开会看到他写的约会内容，确定吗？");
    act(() => r.unmount());
  });
});
