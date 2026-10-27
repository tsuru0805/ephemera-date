// navigate{page, planId?, stopId?, key?} from the host (or a notification) → one of the package's pages.
// A date that is gone or not visible lands on the home page with one line saying so.
import type { Href } from "expo-router";
import { ephemeraApi } from "../lib/ephemeraApi";
import { eventHref } from "../features/ephemera/store";
import { HOME, safeBack } from "../nav/router";
import { showNotice } from "./notice";
import type { NavigateTarget } from "./protocol";

type R = { push: (h: Href) => void; replace: (h: Href) => void; back: () => void; canGoBack: () => boolean; dismissAll?: () => void };

export const NAV_GONE_TEXT = "这次约会找不到了";
export const NAV_UNKNOWN_TEXT = "没有这一页";

const SIMPLE: Record<string, string> = { home: HOME, telegrams: "/ephemera-telegrams", shelf: "/ephemera-shelf", me: "/ephemera-me", backfill: "/ephemera-backfill" };
const PLAN_PAGES: Record<string, string> = { invite: "/ephemera-invite", day: "/ephemera-day", map: "/ephemera-map", box: "/ephemera-box", seal: "" };

/** Where a target goes. Pure except for reading the date (to know whether it still exists and its state). */
export async function resolveTarget(t: NavigateTarget): Promise<{ href: string } | { home: string }> {
  if (SIMPLE[t.page]) return { href: SIMPLE[t.page] };
  if (!(t.page in PLAN_PAGES)) return { home: NAV_UNKNOWN_TEXT };
  if (t.planId == null) return { home: NAV_GONE_TEXT };
  let plan;
  try { plan = await ephemeraApi.plan(t.planId); } catch { return { home: NAV_GONE_TEXT }; }
  if (!plan || plan.status === "cancelled") return { home: NAV_GONE_TEXT };
  // a letter: open the envelope, or the invitation when it is already open; the box once the day is over
  if (t.page === "seal") {
    const h = await eventHref({ kind: "envelope", plan_id: plan.id }, plan);
    return h ? { href: String(h) } : { home: NAV_GONE_TEXT };
  }
  return { href: `${PLAN_PAGES[t.page]}?id=${plan.id}` };
}

export async function goTo(r: R, t: NavigateTarget) {
  if (t.page === "back") { safeBack(r); return; }
  const to = await resolveTarget(t);
  if ("home" in to) { r.replace(HOME as Href); showNotice(to.home); return; }
  if (to.href === HOME) r.replace(HOME as Href);
  else r.push(to.href as Href);
}
