// Links that leave the package (maps, official routes): embedded → the host opens them (openExternal),
// standalone → a new browser tab. The page itself never navigates away.
import { tell } from "./host";
import { isEmbedded } from "./session";

export function openExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (isEmbedded()) { tell("openExternal", { url }); return; }
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
}
