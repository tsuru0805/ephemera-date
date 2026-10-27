// Ephemera 纸品形状(原型 index.html 的 perf/bigTicket/stripPath/deckle/nodeClip/stampSVG… 逐个照搬,
// 原型返回 CSS path(),这里返回 SVG 的 d 串;印章返回 SVG 字符串给 SvgXml)。纯函数,有单测。

/** 齿孔票:四周一圈半圆缺口 */
export function perf(w: number, h: number, r = 4.5, gap = 13): string {
  const n = (len: number) => Math.max(2, Math.round(len / gap));
  const arc = (x: number, y: number, dx: number, dy: number) => `L${x - dx * r} ${y - dy * r} A${r} ${r} 0 0 0 ${x + dx * r} ${y + dy * r}`;
  let d = "M0 0";
  const nx = n(w), ny = n(h);
  for (let k = 1; k < nx; k++) d += arc((k * w) / nx, 0, 1, 0);
  d += `L${w} 0`;
  for (let k = 1; k < ny; k++) d += arc(w, (k * h) / ny, 0, 1);
  d += `L${w} ${h}`;
  for (let k = nx - 1; k > 0; k--) d += arc((k * w) / nx, h, -1, 0);
  d += `L0 ${h}`;
  for (let k = ny - 1; k > 0; k--) d += arc(0, (k * h) / ny, 0, -1);
  return d + "Z";
}

/** 大票:左侧一排齿孔 + 右侧中间缺口 + 右上切角 */
export function bigTicket(w: number, h: number): string {
  const r = 5, gap = 15, n = Math.round(h / gap);
  let p = `M0 0 L${w - 16} 0 L${w} 16 L${w} ${h * 0.5 - 12} A12 12 0 0 0 ${w} ${h * 0.5 + 12} L${w} ${h} L0 ${h}`;
  for (let k = n - 1; k > 0; k--) {
    const y = (k * h) / n;
    p += `L0 ${y + r} A${r} ${r} 0 0 0 0 ${y - r}`;
  }
  return p + " Z";
}

/** 连票:上下齿孔 + 每格分界两侧半圆缺口 */
export function stripPath(w: number, h: number, seps: number[], r = 8, tr = 4, gap = 12): string {
  const n = Math.round(w / gap);
  let d = "M0 0";
  for (let k = 1; k < n; k++) { const x = (k * w) / n; d += `L${x - tr} 0 A${tr} ${tr} 0 0 0 ${x + tr} 0`; }
  d += `L${w} 0`;
  seps.forEach((y) => { d += `L${w} ${y - r} A${r} ${r} 0 0 0 ${w} ${y + r}`; });
  d += `L${w} ${h}`;
  for (let k = n - 1; k > 0; k--) { const x = (k * w) / n; d += `L${x + tr} ${h} A${tr} ${tr} 0 0 0 ${x - tr} ${h}`; }
  d += `L0 ${h}`;
  [...seps].reverse().forEach((y) => { d += `L0 ${y + r} A${r} ${r} 0 0 0 0 ${y - r}`; });
  return d + "Z";
}

/** 毛边纸:四周小幅随机起伏(确定性伪随机,同尺寸每次一样) */
export function deckle(w: number, h: number, amp = 2.2, step = 5): string {
  const r = (k: number) => (((Math.sin(k * 12.9898) * 43758.5453) % 1) + 1) % 1;
  let d = "", k = 0;
  const pt = (x: number, y: number) => { d += (d ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1); };
  for (let x = 0; x <= w; x += step) pt(x, amp * r(k++));
  for (let y = 0; y <= h; y += step) pt(w - amp * r(k++), y);
  for (let x = w; x >= 0; x -= step) pt(x, h - amp * r(k++));
  for (let y = h; y >= 0; y -= step) pt(amp * r(k++), y);
  return d + "Z";
}

/** 小卡袋的锯齿边 */
export function zig(w: number, h: number, z = 4): string {
  let d = `M0 ${z}`;
  for (let x = 0; x <= w; x += z * 2) d += ` L${x + z} 0 L${Math.min(w, x + z * 2)} ${z}`;
  d += ` L${w} ${h - z}`;
  for (let x = w; x >= 0; x -= z * 2) d += ` L${x - z} ${h} L${Math.max(0, x - z * 2)} ${h - z}`;
  return d + " Z";
}

/** 地图页票券:两侧中间小三角缺口 */
export function sideNotch(w: number, h: number, n = 6): string {
  return `M0 0 L${w} 0 L${w} ${h / 2 - n} L${w - n} ${h / 2} L${w} ${h / 2 + n} L${w} ${h} L0 ${h} L0 ${h / 2 + n} L${n} ${h / 2} L0 ${h / 2 - n} Z`;
}

/** 圆形邮戳章(外圈文字绕一圈 + 中间小爱心),原型 stampSVG */
/** sw=圈线粗(按倍数真排版时跟着放大,不然比原来放大位图时显得细) */
export function stampXml(txt1: string, txt2: string, col: string, size = 90, font = "EphemeraDisplay-Bold", sw = 1.6): string {
  const c = size / 2, r = size * 0.38, id = `sp${size}_${hashId(txt1 + col)}`;
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><g fill="none" stroke="${col}" stroke-width="${sw}"><circle cx="${c}" cy="${c}" r="${size * 0.46}"/><circle cx="${c}" cy="${c}" r="${size * 0.3}"/></g>
    <defs><path id="${id}" d="M${c},${c} m-${r},0 a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 -${2 * r},0"/></defs>
    <text font-family="${font}" font-size="${size * 0.105}" letter-spacing="${size * 0.025}" fill="${col}"><textPath href="#${id}">${esc(txt1)}</textPath></text>
    <path d="M${c} ${c + size * 0.11} C${c - size * 0.2} ${c - size * 0.02} ${c - size * 0.1} ${c - size * 0.17} ${c} ${c - size * 0.06} C${c + size * 0.1} ${c - size * 0.17} ${c + size * 0.2} ${c - size * 0.02} ${c} ${c + size * 0.11}Z" fill="${col}"/>
    <text x="${c}" y="${c + size * 0.24}" text-anchor="middle" font-family="${font}" font-size="${size * 0.08}" letter-spacing="1" fill="${col}">${esc(txt2)}</text></svg>`;
}

/** TOP SECRET 双框章 */
export function secretXml(col: string): string {
  return `<svg viewBox="0 0 150 64" width="150" height="64"><rect x="3" y="3" width="144" height="58" rx="6" fill="none" stroke="${col}" stroke-width="2.4"/><rect x="9" y="9" width="132" height="46" rx="3" fill="none" stroke="${col}" stroke-width="1"/>
    <text x="75" y="42" text-anchor="middle" font-family="EphemeraDisplay-Black" font-size="17" letter-spacing="1.5" fill="${col}">TOP SECRET</text></svg>`;
}

/** 指纹:同心椭圆断开的弧线(确定性),原型 fpSVG */
export function fingerprintXml(col: string): string {
  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const P2 = (rx: number, ry: number, a: number) => [30 + rx * Math.cos((a * Math.PI) / 180), 38 + ry * Math.sin((a * Math.PI) / 180)];
  let p = "";
  for (let k = 0; k < 10; k++) {
    const rx = 3.2 + k * 2.35, ry = 4.4 + k * 2.95, a0 = 160 - k * 4 + rnd() * 14, a1 = 380 + k * 4 - rnd() * 14;
    const cut = a0 + (a1 - a0) * (0.3 + rnd() * 0.4), gap = 6 + rnd() * 10;
    for (const [s0, s1] of [[a0, cut], [cut + gap, a1]]) {
      let d = "";
      for (let a = s0; a <= s1; a += 6) { const [x, y] = P2(rx, ry, a); d += (d ? " L" : "M") + x.toFixed(1) + " " + y.toFixed(1); }
      p += `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.15" stroke-linecap="round"/>`;
    }
  }
  return `<svg viewBox="0 0 60 72" width="58" height="70">${p}</svg>`;
}

/** 金线小花饰(信封页「拆开」上面那道) */
export function foilRuleXml(): string {
  return `<svg width="220" height="14" viewBox="0 0 220 14"><defs><linearGradient id="fg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="220" y2="0"><stop offset="0" stop-color="#8C6A30"/><stop offset=".5" stop-color="#E9CF8E"/><stop offset="1" stop-color="#8C6A30"/></linearGradient></defs>
    <path d="M6 7 H92 M128 7 H214" stroke="url(#fg)" stroke-width="1"/><path d="M110 1 L116 7 L110 13 L104 7Z M96 7 L100 4.5 L100 9.5Z M124 7 L120 4.5 L120 9.5Z" fill="url(#fg)"/></svg>`;
}

/** 同一页里多个 SvgXml 的 defs id 不撞:按内容取短摘要(确定性,快照/单测稳定) */
export function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
