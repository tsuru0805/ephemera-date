// Wall-clock time in the engine's zone (/api/config tz). Pages format with getUTC* on
// new Date((sec + tzOffset(sec)) * 1000), so this returns the zone's UTC offset in seconds at that instant.
import { getSession } from "../runtime/session";

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat | null {
  if (cache.has(tz)) return cache.get(tz)!;
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    cache.set(tz, f);
    return f;
  } catch { return null; }
}

export function offsetIn(tz: string, sec: number): number {
  const f = fmt(tz);
  if (!f) return 0;
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(sec * 1000))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) / 1000;
  return Math.round(asUtc - Math.floor(sec));
}

/** Offset (seconds) of the engine's time zone at epoch second `sec`. */
export const tzOffset = (sec: number) => offsetIn(getSession().config.tz || "UTC", sec);
