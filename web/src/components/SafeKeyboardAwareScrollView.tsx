// A keyboard-aware scroll view for the pages. On the web the scroll view (src/shims/keyboard-controller.tsx) adds
// the keyboard's room only while the keyboard is up and removes it when it goes down, so there is no leftover
// padding to correct; this wrapper keeps the pages' import and the two pure helpers they are tested with.
import type React from "react";
import { forwardRef } from "react";
import { StyleSheet, type ViewStyle } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

type Props = React.ComponentProps<typeof KeyboardAwareScrollView> & { /** which page (diagnostics) */ probe?: string };

/** Bottom padding of the content container (paddingBottom > paddingVertical > padding). Pure. */
export function containerPadBottom(style: Props["contentContainerStyle"]): number {
  const f = (StyleSheet.flatten(style) ?? {}) as ViewStyle;
  const v = f.paddingBottom ?? f.paddingVertical ?? f.padding ?? 0;
  return typeof v === "number" ? v : 0;
}

/** With the keyboard down: how much padding is left over (minus the 1pt always there; under 2pt counts as none). */
export function residualPad(contentH: number, sentinelY: number, padBottom: number, comp: number): number {
  const extra = contentH + comp - sentinelY - padBottom - 1;
  return extra > 2 ? extra : 0;
}

export const SafeKeyboardAwareScrollView = forwardRef<React.ElementRef<typeof KeyboardAwareScrollView>, Props>(
  function SafeKeyboardAwareScrollView({ probe: _probe, ...rest }, ref) {
    return <KeyboardAwareScrollView ref={ref} {...rest} />;
  },
);
