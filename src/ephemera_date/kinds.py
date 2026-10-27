"""Stop kinds: 19 top-level kinds, each with suggested subtypes (single source for engine, tools and page).

- kind code = KIND_TABLE key; zh = Chinese label; en = small English caption; subtypes = suggestions
  (every kind except "moment" also accepts a custom subtype, ≤ SUBTYPE_MAX chars, single line, stored as-is).
- moment (一件事) ⇔ the stop has no fixed place (no_place=1) and no subtype.
- Mapping provider place types (Google / AMap / OSM) onto these kinds lives in the place adapters, not here.
"""
from __future__ import annotations

import re

SUBTYPE_MAX = 12
MOMENT = "moment"
DINNER = "dinner"
# dinner 按这一站的 time 显示「午餐」/「晚餐」;分界常量唯一一处
DINNER_SPLIT_HM = "16:30"
_HM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

# 大类(页面照此顺序列)
KIND_TABLE: tuple[dict, ...] = (
    {"kind": "train", "zh": "集合", "en": "MEETING POINT", "subtypes": ("车站", "地铁站", "巴士站", "路口", "店门口")},
    {"kind": "dinner", "zh": "晚餐", "en": "DINNER",
     "subtypes": ("餐馆", "拉面", "寿司", "烤肉", "居酒屋", "定食", "意大利菜", "法餐", "中餐", "韩餐")},
    {"kind": "cafe", "zh": "咖啡", "en": "CAFÉ", "subtypes": ("咖啡馆", "茶馆", "喫茶店", "早午餐")},
    {"kind": "sweets", "zh": "甜品·面包", "en": "SWEETS", "subtypes": ("甜品店", "面包店", "冰淇淋", "和果子", "蛋糕店")},
    {"kind": "bar", "zh": "酒吧", "en": "BAR", "subtypes": ("酒吧", "红酒吧", "精酿", "居酒屋二次会", "夜景酒廊")},
    {"kind": "cinema", "zh": "电影", "en": "SCREENING", "subtypes": ("电影院", "迷你影院")},
    {"kind": "live", "zh": "演出·Live", "en": "LIVE", "subtypes": ("Live house", "剧场", "音乐会", "演唱会", "落语·曲艺")},
    {"kind": "museum", "zh": "看展", "en": "MUSEUM", "subtypes": ("美术馆", "博物馆", "画廊", "特展", "科学馆")},
    {"kind": "aquarium", "zh": "水族馆·动物园", "en": "AQUARIUM & ZOO",
     "subtypes": ("水族馆", "动物园", "植物园", "猫咖·动物咖啡")},
    {"kind": "amusement", "zh": "游乐园", "en": "AMUSEMENT PARK", "subtypes": ("主题乐园", "游乐园", "摩天轮")},
    {"kind": "play", "zh": "玩乐", "en": "PLAY", "subtypes": ("卡拉OK", "游戏厅", "保龄球", "密室逃脱", "桌游")},
    {"kind": "walk", "zh": "散步", "en": "WALK", "subtypes": ("街道", "河边", "海边", "商店街")},
    {"kind": "park", "zh": "公园", "en": "PARK", "subtypes": ("公园", "庭园", "赏花", "赏枫")},
    {"kind": "viewpoint", "zh": "展望台", "en": "VIEWPOINT", "subtypes": ("展望台", "夜景", "观景塔")},
    {"kind": "shrine", "zh": "神社", "en": "SHRINE", "subtypes": ("神社", "寺庙", "教会")},
    {"kind": "shopping", "zh": "买东西", "en": "SHOPPING",
     "subtypes": ("商场", "服装", "眼镜店", "书店", "文具", "杂货", "花店", "超市")},
    {"kind": "onsen", "zh": "温泉", "en": "HOT SPRING", "subtypes": ("温泉", "钱汤", "SPA", "桑拿")},
    {"kind": "stay", "zh": "住宿", "en": "STAY", "subtypes": ("酒店", "旅馆", "民宿")},
    {"kind": MOMENT, "zh": "一件事", "en": "SOMETHING WE DID", "subtypes": ()},
)
KINDS: dict[str, str] = {k["kind"]: k["zh"] for k in KIND_TABLE}
KINDS_EN: dict[str, str] = {k["kind"]: k["en"] for k in KIND_TABLE}
SUBTYPES: dict[str, tuple[str, ...]] = {k["kind"]: k["subtypes"] for k in KIND_TABLE}


def dinner_zh_en(time_hhmm: str | None) -> tuple[str, str]:
    """dinner 这一站按 time 显示「午餐」还是「晚餐」(同一类,不加新类)。
    早于 16:30 = 午餐/LUNCH;16:30 及以后、没写时间、或时间格式不对(默认档,不猜)= 晚餐/DINNER。"""
    if isinstance(time_hhmm, str) and _HM_RE.match(time_hhmm) and time_hhmm < DINNER_SPLIT_HM:
        return "午餐", "LUNCH"
    return "晚餐", "DINNER"


def kinds_payload() -> dict:
    """页面读的只读表(GET /api/dates/kinds)。dinner 这一项 zh/en 写两档 + by_time 告诉 页面怎么按
    这一站的 time 分(同一类,不加新类;分界常量见 dinner_zh_en/DINNER_SPLIT_HM)。"""
    def row(k: dict) -> dict:
        r = {"kind": k["kind"], "zh": k["zh"], "en": k["en"], "subtypes": list(k["subtypes"]),
             "custom": k["kind"] != MOMENT, "no_place": k["kind"] == MOMENT}
        if k["kind"] == DINNER:
            lunch_zh, lunch_en = dinner_zh_en("00:00")
            dinner_zh, dinner_en = dinner_zh_en(DINNER_SPLIT_HM)
            r["zh"], r["en"] = f"{lunch_zh} / {dinner_zh}", f"{lunch_en} / {dinner_en}"
            r["by_time"] = {"before": DINNER_SPLIT_HM, "zh": lunch_zh, "en": lunch_en,
                            "else_zh": dinner_zh, "else_en": dinner_en}
        return r
    return {"kinds": [row(k) for k in KIND_TABLE], "subtype_max": SUBTYPE_MAX}


def label(kind: str | None, subtype: str | None = None, time: str | None = None) -> str:
    """「大类·细类」;没有细类只写大类;一件事不带细类。dinner 按 time 显示「午餐/晚餐」(见 dinner_zh_en)。
    认不得的代码原样。"""
    if not kind:
        return ""
    zh = dinner_zh_en(time)[0] if kind == DINNER else KINDS.get(kind, kind)
    return f"{zh}·{subtype}" if subtype and kind != MOMENT else zh
