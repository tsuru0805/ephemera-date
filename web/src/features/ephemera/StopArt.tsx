// 每站现画:这一站有现画的小画(引擎投影 place.art_url / art_inv_url,地点公开且画好了才有)就用它,
// 否则用这一种站的固定画(ART_OF)。两种都是遮罩图,按皮肤染色,摆法完全一样;现画的图要带 token 取。
import { useEffect, useState } from "react";
import { type ImageStyle } from "react-native";
import { ephemeraApi, type Stop } from "../../lib/ephemeraApi";
import { onLogout } from "../../runtime/session";
import { PAINTED_SIZE } from "./artLayout";
import { Art, BoxedArt } from "./components";
import { artOf } from "./format";

const srcCache = new Map<string, { uri: string; headers: Record<string, string> }>();
onLogout(() => srcCache.clear());   // the addresses are revoked on sign-out (lib/ephemeraApi forgetPhotoUrls)

export function StopArt({ s, color, inv, style }: { s: Stop; color: string; inv?: boolean; style: ImageStyle }) {
  const url = (inv ? s.place?.art_inv_url : s.place?.art_url) ?? null;
  const [src, setSrc] = useState(url ? srcCache.get(url) ?? null : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!url) { setSrc(null); return; }
    const hit = srcCache.get(url);
    if (hit) { setSrc(hit); return; }
    let alive = true;
    ephemeraApi.authedSource(url).then((v) => { srcCache.set(url, v); if (alive) setSrc(v); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [url]);
  if (!url || failed || !src) return <Art name={artOf(s)} color={color} inv={inv} style={style} />;
  // 现画的图:2:3 竖图遮罩(引擎出 300×450),在调用方给的框里等比铺满、居中取景,不拉伸
  return <BoxedArt source={src} sw={PAINTED_SIZE.w} sh={PAINTED_SIZE.h} color={color} style={style} onError={() => setFailed(true)} />;
}
