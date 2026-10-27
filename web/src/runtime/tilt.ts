// Phone tilt for the foil glint and the paper depth, from the browser's DeviceOrientation events.
// iOS asks for permission, and only from a tap: the first tap anywhere on the page asks once. No permission,
// no sensor (desktop) = available stays false and the pages fall back to their slow sway.
import { makeMutable } from "react-native-reanimated";

const DEG = Math.PI / 180;
export const roll = makeMutable(0);       // left/right tilt (radians), gamma
export const pitch = makeMutable(0);      // front/back tilt relative to how the phone was first held (radians), beta
export const available = makeMutable(false);

let base: number | null = null;
let started = false;

/** One DeviceOrientation reading → roll/pitch in radians (pitch relative to the first reading). Pure, tested. */
export function readingToTilt(beta: number | null, gamma: number | null, baseline: number | null): { roll: number; pitch: number; baseline: number | null } | null {
  if (beta == null || gamma == null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const b0 = baseline ?? beta;
  return { roll: gamma * DEG, pitch: (beta - b0) * DEG, baseline: b0 };
}

function onOrientation(e: DeviceOrientationEvent) {
  const t = readingToTilt(e.beta, e.gamma, base);
  if (!t) return;
  base = t.baseline;
  roll.value = t.roll;
  pitch.value = t.pitch;
  if (!available.value) available.value = true;
}

type DOE = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };

export function startTilt() {
  if (started || typeof window === "undefined" || typeof window.DeviceOrientationEvent === "undefined") return;
  started = true;
  const D = window.DeviceOrientationEvent as DOE;
  const listen = () => window.addEventListener("deviceorientation", onOrientation);
  if (typeof D.requestPermission === "function") {
    const ask = () => {
      window.removeEventListener("pointerup", ask, true);
      D.requestPermission!().then((r) => { if (r === "granted") listen(); }).catch(() => { /* stays on the slow sway */ });
    };
    window.addEventListener("pointerup", ask, true);
  } else {
    listen();
  }
}

/** Same reading for every page (one listener). */
export function useDeviceRotation() {
  startTilt();
  return { roll, pitch, available };
}
