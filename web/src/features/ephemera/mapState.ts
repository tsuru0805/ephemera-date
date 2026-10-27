// 地图页 / 海报共用:每站可见与否、到了没有、下一站是哪站(纯函数)
import type { Plan } from "../../lib/ephemeraApi";

/** over=这次约会已经结束(done):每站都算到过、没有「现在 / 下一站」 */
/** noDay=她补记的约会(从没寄出过):没有当天、没有检票,结束了就全算走过 */
export type MapState = { vis: boolean[]; arrived: boolean[]; next: number; here: number; over: boolean; noDay: boolean };
export function mapState(plan: Plan, nowSec: number): MapState {
  const vis = plan.stops.map((s) => !!s.place);
  const over = plan.status === "done";
  // 结束了=每站都到过(她补记的约会没有 arrive_at,也一样算走过)
  const arrived = plan.stops.map((s) => over || (typeof s.arrive_at === "number" && nowSec >= s.arrive_at));
  // 下一站=第一个还没到、也没被跳过的站(跳过的站不当「现在 / 下一站」)
  const next = over ? -1 : plan.stops.findIndex((s) => !s.skipped && !(typeof s.arrive_at === "number" && nowSec >= s.arrive_at));
  // 当前站=下一站之前最近一个没跳过的站
  const before = (k: number) => { for (let j = k; j >= 0; j--) if (!plan.stops[j].skipped) return j; return -1; };
  const here = before(next < 0 ? plan.stops.length - 1 : next - 1);
  return { vis, arrived, next, here, over, noDay: plan.sent_at == null };
}

