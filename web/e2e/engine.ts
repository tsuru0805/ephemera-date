// The AI side for the end-to-end runs: writes, sends and closes a date through the engine's MCP tools.
import { Mcp } from "./mcp";

export const ENGINE = process.env.EPHEMERA_ENGINE ?? "http://127.0.0.1:18791";
export const HER_TOKEN = process.env.EPHEMERA_E2E_HER_TOKEN ?? "her-e2e-token";
export const AI_TOKEN = process.env.EPHEMERA_E2E_AI_TOKEN ?? "ai-e2e-token";
// The engine must run in this zone too (EPHEMERA_TZ). The runs put stops 10–50 minutes in the past "today":
// pick a zone where it is not just after midnight (node e2e/engine.ts prints one), or the stops land on yesterday.
export const TZ = process.env.EPHEMERA_E2E_TZ ?? "Asia/Shanghai";
export function zoneAwayFromMidnight(now = new Date()): string {
  const zones = ["Asia/Shanghai", "Europe/London", "America/New_York", "Asia/Kolkata", "Pacific/Honolulu", "Australia/Sydney"];
  const hour = (z: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", hourCycle: "h23" }).format(now));
  return zones.find((z) => hour(z) >= 3 && hour(z) <= 20) ?? zones[0];
}

/** wall-clock HH:MM and YYYY-MM-DD in the engine's zone, `min` minutes from now */
export function wall(min: number): { day: string; hm: string } {
  const d = new Date(Date.now() + min * 60_000);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(d).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

export async function ai(): Promise<Mcp> {
  const m = new Mcp(`${ENGINE}/mcp`, AI_TOKEN);
  await m.init();
  return m;
}

const idOf = (text: string) => Number(/#(\d+)/.exec(text)?.[1] ?? NaN);

/** Write a date for today whose stops started a little while ago (so every stop can be checked in now) and send it. */
export async function writeAndSend(m: Mcp, title = "A Quiet\nRiver Walk", o: { card?: string } = {}): Promise<number> {
  const today = wall(0).day;
  if (wall(-60).day !== today) throw new Error(`too close to midnight in ${TZ}: run the engine and the tests with EPHEMERA_TZ / EPHEMERA_E2E_TZ = ${zoneAwayFromMidnight()}`);
  const opened = await m.call("date_open", { title_en: title, title_zh: "沿河慢慢走", date: today, color: "sky" });
  const plan = idOf(opened);
  if (!Number.isFinite(plan)) throw new Error(`no plan id in: ${opened}`);
  const stops = [
    { kind: "train", t: -50, title: "东门车站", address: "滨河路 1 号", clue: "有钟的那个出口", lat: 31.2304, lng: 121.4737 },
    { kind: "cafe", t: -40, title: "转角咖啡", address: "滨河路 18 号", clue: "门口有一棵银杏", lat: 31.2312, lng: 121.4751 },
    { kind: "dinner", t: -25, title: "小灯餐馆", address: "桥头街 6 号", clue: "窗边会有一盏小灯", lat: 31.2325, lng: 121.4762 },
    { kind: "walk", t: -10, title: "沿河步道", address: "河堤", clue: "把今天走完", lat: 31.2338, lng: 121.4781 },
  ];
  for (const [k, s] of stops.entries()) {
    await m.call("date_edit", { plan, op: "add_stop", kind: s.kind, time: wall(s.t).hm, title: s.title, address: s.address, clue: s.clue, lat: s.lat, lng: s.lng,
      ...(k === 0 ? { reveal_at: wall(s.t - 5).hm } : {}) });
  }
  await m.call("date_edit", { plan, op: "set_prep", items: [{ section: "wear", text: "一双走得久的鞋" }, { section: "bring", text: "一件薄外套" }] }).catch(() => "");
  await m.call("date_edit", { plan, op: "set_contract", items: ["今天不看工作消息", "散步走到河的尽头"] }).catch(() => "");
  await m.call("date_edit", { plan, op: "set_card", text: o.card ?? "谢谢你陪我走完这一天。" }).catch(() => "");
  const sent = await m.call("date_send", { plan });
  if (!/寄出/.test(sent)) throw new Error(`not sent: ${sent}`);
  return plan;
}

/** Start each run clean: close what is on its day or sent, delete drafts (the engine keeps at most 3 going at once). */
export async function clearActive(m: Mcp) {
  const list = await m.call("date_view", {});
  for (const line of list.split("\n")) {
    const id = Number(/^#(\d+)/.exec(line)?.[1]);
    if (!id) continue;
    if (/· 构思中/.test(line)) await m.call("date_edit", { plan: id, op: "delete_plan" }).catch(() => "");
    else if (/· (当天|已寄出)/.test(line)) await m.call("date_edit", { plan: id, op: "cancel", reason: "测试结束" }).catch(() => m.call("date_close", { plan: id, quote: "Good company, a good day" }).catch(() => ""));
  }
}

export async function close(m: Mcp, plan: number) {
  return m.call("date_close", { plan, quote: "Good company, a good day" });
}
