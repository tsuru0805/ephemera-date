// Pops, turns and lights on the date pages come to rest without overshooting: a spring or an overshooting curve
// grows past the end and springs back ("bouncing"). easeOutQuint: fast, then slow, and stops at the end. As the home app.
// Taken by a function each time: the reanimated stand-ins of the page tests may not have Easing.bezier at load.
import { Easing } from "react-native-reanimated";

export const POP_MS = 420;
/** The curve: cubic-bezier(0.22, 1, 0.36, 1) — it never passes 1. */
export const CALM_CURVE = [0.22, 1, 0.36, 1] as const;
/** A worklet: the route page lights its stop numbers from a useAnimatedReaction (the UI thread). */
export function calm(duration: number = POP_MS) {
  "worklet";
  return { duration, easing: Easing.bezier(0.22, 1, 0.36, 1) };
}
