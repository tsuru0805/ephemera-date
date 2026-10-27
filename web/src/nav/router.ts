// expo-router for the pages, with one change: "back" never leaves the package.
// At the bottom of the page's own history, back = tell the host to close (embedded) or go to the home page
// (opened on its own). Inside an iframe, the browser's history.back() at the first entry would move the host page.
import { useRouter as useExpoRouter, router as expoRouter } from "expo-router";
import { useMemo } from "react";
import { tell } from "../runtime/host";
import { isEmbedded } from "../runtime/session";

export * from "expo-router";

export const HOME = "/ephemera";

type R = ReturnType<typeof useExpoRouter>;
export function safeBack(r: Pick<R, "back" | "canGoBack" | "replace">) {
  if (r.canGoBack()) { r.back(); return; }
  if (isEmbedded()) tell("close");
  else r.replace(HOME as never);
}

export function useRouter(): R {
  const r = useExpoRouter();
  return useMemo(() => ({ ...r, back: () => safeBack(r) }), [r]);
}

export const router = { ...expoRouter, back: () => safeBack(expoRouter) } as typeof expoRouter;
