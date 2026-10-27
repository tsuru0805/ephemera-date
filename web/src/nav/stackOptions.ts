// Page transitions inside the package: the old page fades, the new one rises from below (the prototype's go());
// m=1 in the link = something flies over from the previous page (flight layer), so the page only fades in.
export function ephemeraStackOptions(name: string, params?: unknown): { animation: "fade_from_bottom" | "fade"; animationDuration: number } | null {
  if (!name.startsWith("ephemera")) return null;
  const morph = !!params && typeof params === "object" && (params as Record<string, unknown>).m === "1";
  return morph ? { animation: "fade", animationDuration: 380 } : { animation: "fade_from_bottom", animationDuration: 420 };
}
