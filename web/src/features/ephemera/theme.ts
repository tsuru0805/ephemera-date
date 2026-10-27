// Ephemera 配色(数值逐个取自原型,不加新色)。
// 四套皮肤在 Me 页切换,整套一起换;地图页那套 MAPPAL 跟着皮肤走。
// 一次约会自己的颜色(他从固定色组挑)只上历史票根、书脊、盒盖——不随外壳皮肤变(原型 PAST_COL 注释)。
import { F } from "../../fonts";

export type SkinKey = "ivory" | "blue" | "warm" | "bright";
export const SKIN_ORDER: SkinKey[] = ["ivory", "blue", "warm", "bright"];

export type Skin = {
  name: string;
  bg: string; ink: string; deep: string; btn: string; sh: string; // sh = 阴影用的 "r,g,b"
  big: { c: string; l: string; panel: string; art: string };
  paper: string; paper2: string;
  envPaper: string; envBack: string; seal: string; sealHi: string; tag: string; tagT: string;
  pack: string; // 首页 Hidden Plans 绳子捆的小纸包(原型 hidden[1])
};

export const SKINS: Record<SkinKey, Skin> = {
  ivory: { name: "奶白底", bg: "#FBF6EF", ink: "#3B2F3B", deep: "#D92662", btn: "#D92662", sh: "90,60,70",
    big: { c: "#F9C4D3", l: "#D92662", panel: "#3FA1C6", art: "#FFF6F2" }, paper: "#FFFDF9", paper2: "#F2E8DE",
    envPaper: "#F8D6DE", envBack: "#EFC3CE", seal: "#D92662", sealHi: "#FFD9E3", tag: "#3FA1C6", tagT: "#fff", pack: "#E3EEF3" },
  blue: { name: "粉蓝撞色", bg: "#F5F8FA", ink: "#22364A", deep: "#D92662", btn: "#2C86AE", sh: "40,70,100",
    big: { c: "#C7E3EE", l: "#1F6F95", panel: "#E9789F", art: "#FFF6F2" }, paper: "#FFFFFF", paper2: "#E4EEF3",
    envPaper: "#CFE4ED", envBack: "#B9D7E4", seal: "#D92662", sealHi: "#FFD9E3", tag: "#E9789F", tagT: "#fff", pack: "#F9DCE4" },
  warm: { name: "暖奶油", bg: "#F6EFE6", ink: "#46302B", deep: "#C8475F", btn: "#C8475F", sh: "90,60,45",
    big: { c: "#F3DDD2", l: "#C8475F", panel: "#C8475F", art: "#FBEFE6" }, paper: "#FFFAF4", paper2: "#EADCCB",
    envPaper: "#EEDFD0", envBack: "#E3CFBC", seal: "#C8475F", sealHi: "#F6C9D1", tag: "#8DB6CB", tagT: "#fff", pack: "#E2ECEF" },
  bright: { name: "原来的粉", bg: "#FFF2F5", ink: "#6B2140", deep: "#D92662", btn: "#D92662", sh: "120,30,70",
    big: { c: "#F9BFD0", l: "#D92662", panel: "#3FA1C6", art: "#FFF6F2" }, paper: "#FFFAF8", paper2: "#FCE3EA",
    envPaper: "#F7D3DC", envBack: "#EFC2CD", seal: "#D92662", sealHi: "#FFD9E3", tag: "#3FA1C6", tagT: "#fff", pack: "#BFE0EC" },
};

// 地图页 / 路线页 / 纪念盒(--m-*)
export type MapPal = { page: string; land: string; street: string; water: string; park: string; ink: string; title: string;
  route: string; card: string; chip: string; chipDone: string; chipLock: string };
export const MAPPAL: Record<SkinKey, MapPal> = {
  ivory: { page: "#F6E6E1", land: "#F8EDE6", street: "#E7B7C3", water: "#A6C8D0", park: "#C8D6C7", ink: "#634458", title: "#A8435F", route: "#C15772", card: "#FBF4EF", chip: "#F3D9DE", chipDone: "#E3EBE2", chipLock: "#EDE2E0" },
  blue: { page: "#E8EFF3", land: "#F3F7F9", street: "#C3D8E4", water: "#8FC0D6", park: "#CFE0D6", ink: "#22364A", title: "#1F6F95", route: "#D92662", card: "#FAFCFD", chip: "#F9DCE4", chipDone: "#DCEAE2", chipLock: "#E4EAEE" },
  warm: { page: "#EFE3D6", land: "#F6EDE2", street: "#E6C7B6", water: "#A9C3CE", park: "#CDD3BE", ink: "#46302B", title: "#A93E52", route: "#C8475F", card: "#FBF5EE", chip: "#F1D7D2", chipDone: "#E2E4D6", chipLock: "#EADFD5" },
  bright: { page: "#FCE6EC", land: "#FFF2F5", street: "#F4B9CB", water: "#AFD8E8", park: "#D3E4D2", ink: "#6B2140", title: "#C2185B", route: "#D92662", card: "#FFF8FA", chip: "#FBD3DF", chipDone: "#E0EDE0", chipLock: "#F3E2E7" },
};

// 当天连票:右侧副券跳色,每格不同,随皮肤换 [底, 插画, 检票章]
const SEGCOLS: Record<SkinKey, Array<[string, string, string]>> = {
  ivory: [["#3FA1C6", "#FFF6F2", "#D92662"], ["#E9789F", "#FFF6F2", "#3F2F4A"], ["#7E8FD6", "#FFF6F2", "#D92662"], ["#D92662", "#FFF6F2", "#2E3F66"]],
  bright: [["#3FA1C6", "#FFF6F2", "#D92662"], ["#E9789F", "#FFF6F2", "#3F2F4A"], ["#7E8FD6", "#FFF6F2", "#D92662"], ["#D92662", "#FFF6F2", "#2E3F66"]],
  blue: [["#E9789F", "#FFF6F2", "#1F6F95"], ["#3FA1C6", "#FFF6F2", "#D92662"], ["#F2A8C1", "#B0234F", "#1F6F95"], ["#1F6F95", "#FFF6F2", "#D92662"]],
  warm: [["#9EC4D6", "#24485C", "#C8475F"], ["#E28AA0", "#FFF6F2", "#46302B"], ["#B9A7C9", "#3E2F52", "#C8475F"], ["#C8475F", "#FBEFE6", "#24485C"]],
};
export const segC = (skin: SkinKey, i: number) => {
  const [bg, art, stamp] = SEGCOLS[skin][i % 4];
  return { bg, art, stamp };
};

// 一次约会自己的颜色:他从五个里挑(引擎 COLORS),每个对应原型里一种历史票根配色
// (原型 PAST_COL + 下一次大票色;inv=插画用反相那张,panel=插画底)
export type PlanColor = "blush" | "rose" | "cream" | "sky" | "berry";
export type TicketCol = { c: string; t: string; art: string; inv?: boolean; panel?: string };
export const PLAN_COLORS: Record<PlanColor, TicketCol> = {
  blush: { c: "#F9C4D3", t: "#D92662", art: "#D92662" },
  rose: { c: "#E9789F", t: "#FFF6F2", art: "#FFF6F2", inv: true, panel: "#3FA1C6" },
  cream: { c: "#FFF8EF", t: "#C8475F", art: "#C8475F" },
  sky: { c: "#3FA1C6", t: "#FFF6F2", art: "#FFF6F2" },
  berry: { c: "#D92662", t: "#FFF6F2", art: "#FFF6F2" },
};
export const planCol = (c: string | null | undefined): TicketCol => PLAN_COLORS[(c as PlanColor) in PLAN_COLORS ? (c as PlanColor) : "rose"];

export const rgba = (sh: string, a: number) => `rgba(${sh},${a})`;

/** 两色按比例混(原型 color-mix(in srgb, A p%, B)) */
export function mix(a: string, b: string, p: number): string {
  const pa = hex(a), pb = hex(b);
  const m = pa.map((v, i) => Math.round(v * p + pb[i] * (1 - p)));
  return `#${m.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
function hex(h: string): [number, number, number] {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const alpha = (h: string, a: number) => {
  const [r, g, b] = hex(h);
  return `rgba(${r},${g},${b},${a})`;
};

// 字体:用打包字体时不写 fontWeight(字重靠换文件选)。拉丁字体里出现中文 → 改用思源宋
const CJK400 = "NotoSerifSC-Regular-app", CJK500 = F.ephSerif500, CJK700 = "NotoSerifSC-Bold-app", CJK900 = F.ephSerif900;
// web: every Latin face is a stack ending in the Chinese serif of the same weight, so a Chinese character in a
// Latin line is drawn in the serif, never in the browser's default sans
const stack = (latin: string, cjk: string) => `${latin}, ${cjk}`;
export const FF = {
  serif: CJK400, // 400
  serif5: CJK500, // 500
  serif7: CJK700, // 700
  serif9: CJK900, // 900
  pf: stack(F.playfairRegular, CJK400), // 400
  pfI: stack(F.playfairRegularItalic, CJK400), // 400 italic
  pf7: stack(F.playfair, CJK700), // 700
  pf7I: stack(F.playfairItalic, CJK700), // 700 italic
  pf9: stack(F.playfairBlack, CJK900), // 900
  script: stack(F.script, CJK500),
  corm: stack(F.cormorant, CJK500), // 500
  corm6: stack(F.cormorantSemi, CJK500), // 600
  mono: stack(F.type, CJK700), // Courier Prime 700
  monoR: stack(F.typeRegular, CJK400), // 400
} as const;

const CJK = /[¥　-〿぀-ヿ㐀-鿿豈-﫿＀-￯]/;
export const hasCJK = (s: string | null | undefined) => !!s && CJK.test(s);
/** 拉丁字体排的字里要是有中日文,整段换成对应字重的思源宋(不让 iOS 退到苹方黑体) */
export function ff(text: string | null | undefined, latin: string, cjk: string = FF.serif7): string {
  return hasCJK(text) ? cjk : latin;
}
