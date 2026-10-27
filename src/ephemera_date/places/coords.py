"""GCJ-02 ⇄ WGS-84（只在高德适配层边界用）。

- 正向 WGS-84 → GCJ-02 用公开流传的偏移公式（多个开源实现一致，例如
  https://github.com/googollee/eviltransform 、https://github.com/wandergis/coordtransform ）；
  本文件为独立实现，测试的对照点取自上述两个仓公开的测试/示例数据。
- 反向 GCJ-02 → WGS-84 没有解析解，用不动点迭代（误差 < 1e-7 度，约 1 厘米）。
- 是否在使用 GCJ-02 的范围内：用 Natural Earth 1:10m 国界多边形（公有领域，见 _boundary_data.py）做点在多边形判定。
  旧的矩形判定（单一大矩形或多矩形组）会把加德满都、首尔、大阪等境外点误判成境内，已弃用。
  精度：Natural Earth 10m 本身 + 简化容差约 110 米。海岸线概括到约 1 公里（厦门岛的环只有 30 个点，思明区中心、
  岛东岸都被画到了海里），所以加了 2 公里海岸容差（见 in_china）。陆地国界两侧不保证：例如越南芒街
  （Wikidata Q33204 的坐标）在 Natural Earth 原始多边形里就落在中国一侧——所以离国界 ≤3 公里一律 ambiguous。
- 港澳台默认**不算**：依据是测绘法等大陆法律不适用于港澳（https://en.wikipedia.org/wiki/Restrictions_on_geographic_data_in_China
  「Under One Country Two Systems, legislation in mainland China does not apply in Hong Kong and Macau SARs」），
  台湾同理。**高德在港澳台返回的坐标是否加偏，没有找到高德官方的公开说明，也没有钥匙实测——候核**；
  环境变量 EPHEMERA_GCJ_REGIONS=mainland,hk,mo,tw 可把它们算进来。
- 正反向用同一原点判定：正向看 WGS 点是否在范围内；反向先用公式求出 WGS 候选点，再看**候选点**是否在范围内
  （与正向同一判定），因此任何境内 WGS 点 w 都有 gcj02_to_wgs84(wgs84_to_gcj02(w)) ≈ w。
  离邻国陆地国界 ≤3 公里的点一律 ambiguous（china_status），原点或候选点任一 ambiguous、或两者判定不一致时，
  gcj02_to_wgs84_checked() 不换算、原样返回并带 ambiguous=True，上层（高德适配层）标进 Place.crs_ambiguous。

防重复换算：只有声明为 GCJ-02 的坐标才会被换；适配层出口统一是 WGS-84，库里记 crs_original，
手填坐标按 WGS-84 处理（to_wgs84(lat, lng, "WGS84") 原样返回）。
"""
from __future__ import annotations

import math
import os

from .base import CRS_GCJ02, CRS_WGS84

_A = 6378245.0                      # 克拉索夫斯基椭球长半轴（公式约定值）
_EE = 0.00669342162296594323        # 偏心率平方

_REGION_NAMES = {"mainland": "MAINLAND", "hk": "HONG_KONG", "mo": "MACAU", "tw": "TAIWAN"}


def _regions() -> tuple[str, ...]:
    raw = os.getenv("EPHEMERA_GCJ_REGIONS") or "mainland"
    names = tuple(sorted({x.strip().lower() for x in raw.split(",") if x.strip()}))
    bad = [x for x in names if x not in _REGION_NAMES]
    if bad:
        raise ValueError(f"EPHEMERA_GCJ_REGIONS 不认识: {', '.join(bad)}（可选 mainland,hk,mo,tw）")
    return names


COAST_TOL_M = 2000         # 海岸容差：多边形外、离本方边界 ≤2 公里且比离任何他方边界更近 → 算境内
_TIE_MARGIN_M = 50         # 陆地国界两侧边界线重合（简化误差内）时判「不算」
_CELL = 0.05               # 边界线段网格索引的格子（度）
_index_cache: dict[tuple[str, ...], dict] = {}


def _ring_pts(flat, scale):
    return [(flat[i] / scale, flat[i + 1] / scale) for i in range(0, len(flat), 2)]


def _with_bbox(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(ys), max(ys), min(xs), max(xs), pts)


def _index(names: tuple[str, ...]) -> dict:
    """选中区域的环（判在内）、未选中的港澳台环（判在外）、边界线段网格（标本方 True / 他方 False）。"""
    if names not in _index_cache:
        from . import _boundary_data as bd
        sel, excl, grid = [], [], {}

        def add_seg(x1, y1, x2, y2, mine):
            for gx in range(math.floor(min(x1, x2) / _CELL), math.floor(max(x1, x2) / _CELL) + 1):
                for gy in range(math.floor(min(y1, y2) / _CELL), math.floor(max(y1, y2) / _CELL) + 1):
                    grid.setdefault((gx, gy), []).append((x1, y1, x2, y2, mine))
        for key, attr in _REGION_NAMES.items():
            mine = key in names
            for flat in getattr(bd, attr):
                pts = _ring_pts(flat, bd.SCALE)
                (sel if mine else excl).append(_with_bbox(pts))
                for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                    add_seg(x1, y1, x2, y2, "in" if mine else "sar")
        nb = bd.NEIGHBOR_SEGMENTS
        for i in range(0, len(nb), 4):
            add_seg(nb[i] / bd.SCALE, nb[i + 1] / bd.SCALE, nb[i + 2] / bd.SCALE, nb[i + 3] / bd.SCALE, "nb")
        _index_cache[names] = {"sel": sel, "excl": excl, "grid": grid}
    return _index_cache[names]


def _rings(names: tuple[str, ...]) -> list:
    """[(minlat, maxlat, minlng, maxlng, [(lng, lat)...]) ...]：选中区域的环。"""
    return _index(names)["sel"]


def _seg_dist_m(lat, lng, x1, y1, x2, y2) -> float:
    kx = math.cos(math.radians(lat)) * 111320
    ax, ay = (x1 - lng) * kx, (y1 - lat) * 110540
    bx, by = (x2 - lng) * kx, (y2 - lat) * 110540
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
    return math.hypot(ax + t * dx, ay + t * dy)


def _nearest_boundaries(lat, lng, grid) -> dict:
    """→ {"in": 离选中区域边界米数, "sar": 离未选中港澳台边界, "nb": 离邻国陆地国界}，只看周围 3×3 格
    （格子 0.05 度，任何纬度下都大于 3 公里）。"""
    gx, gy = math.floor(lng / _CELL), math.floor(lat / _CELL)
    d = {"in": math.inf, "sar": math.inf, "nb": math.inf}
    for i in (-1, 0, 1):
        for j in (-1, 0, 1):
            for x1, y1, x2, y2, kind in grid.get((gx + i, gy + j), ()):
                v = _seg_dist_m(lat, lng, x1, y1, x2, y2)
                if v < d[kind]:
                    d[kind] = v
    return d


def _in_ring(lat, lng, pts) -> bool:
    inside = False
    x0, y0 = pts[-1]
    for x1, y1 in pts:
        if (y1 > lat) != (y0 > lat) and lng < (x0 - x1) * (lat - y1) / (y0 - y1) + x1:
            inside = not inside
        x0, y0 = x1, y1
    return inside


def _in_any(lat, lng, rings) -> bool:
    return any(la0 <= lat <= la1 and lo0 <= lng <= lo1 and _in_ring(lat, lng, pts) for la0, la1, lo0, lo1, pts in rings)


IN, OUT, AMBIGUOUS = "in", "out", "ambiguous"
BORDER_AMBIGUOUS_M = 3000  # 离邻国陆地国界 ≤3 公里：Natural Earth 精度不够定内外 → 不确定


def china_status(lat: float, lng: float, names: tuple[str, ...] | None = None) -> str:
    """→ "in" / "out" / "ambiguous"（是否落在使用 GCJ-02 的范围内；默认=中国大陆）。

    1. 落在未选中的港澳台多边形里 → out；
    2. 离邻国陆地国界（NEIGHBOR_SEGMENTS）≤ BORDER_AMBIGUOUS_M → ambiguous（不论多边形怎么说：Natural Earth
       在口岸一带会把境外点包进中国多边形，例如越南芒街）；
    3. 落在选中区域的任一环里 → in（各环都是外环，取并集）；
    4. 海岸容差：多边形外（多为海边、码头、近岸小岛；Natural Earth 10m 海岸线概括到约 1 公里，厦门岛、沿海城区
       会被画到海里）、离选中区域边界 ≤ COAST_TOL_M、且比离未选中港澳台边界近 _TIE_MARGIN_M 以上 → in；
    5. 其余 → out。
    names 缺省 = EPHEMERA_GCJ_REGIONS 选中的区域。
    """
    if not (0.8 <= lat <= 55.9 and 72.0 <= lng <= 137.9):        # 快速排除
        return OUT
    idx = _index(names or _regions())
    if _in_any(lat, lng, idx["excl"]):
        return OUT
    d = _nearest_boundaries(lat, lng, idx["grid"])
    if d["nb"] <= BORDER_AMBIGUOUS_M:
        return AMBIGUOUS
    if _in_any(lat, lng, idx["sel"]):
        return IN
    if d["in"] <= COAST_TOL_M and d["in"] + _TIE_MARGIN_M < d["sar"]:
        return IN
    return OUT


REGIONS = ("mainland", "hk", "mo", "tw", "out")


def geo_region(lat: float, lng: float) -> str | None:
    """几何判定地区：→ "mainland" / "hk" / "mo" / "tw" / "out"；国界附近不确定 → None。与选中区域无关。
    先看港澳台多边形，再按大陆的三态判定，最后港澳台的海岸容差（海边点落在多边形外时）。"""
    for key in ("hk", "mo", "tw"):
        if _in_any(lat, lng, _index((key,))["sel"]):
            return key
    st = china_status(lat, lng, ("mainland",))
    if st == IN:
        return "mainland"
    if st == AMBIGUOUS:
        return None
    for key in ("hk", "mo", "tw"):
        if china_status(lat, lng, (key,)) == IN:
            return key
    return "out"


def region_uses_gcj(region: str | None) -> bool | None:
    """地区 → 高德那边是否用 GCJ-02：mainland=True；hk/mo/tw=是否在 EPHEMERA_GCJ_REGIONS 里选中；out=False；None=不知道。"""
    if region is None:
        return None
    if region not in REGIONS:
        raise ValueError(f"未知地区: {region}（可选 {', '.join(REGIONS)}）")
    if region == "out":
        return False
    return region in _regions()


def to_gcj_for_amap(lat: float, lng: float, region: str | None = None) -> tuple[float, float, bool]:
    """发往高德前的坐标换算。→ (纬度, 经度, ambiguous)。
    region 已知（来自 adcode 或调用方）→ 按它决定换不换；未知 → 几何判定（国界附近不确定就不换，ambiguous=True）。"""
    use = region_uses_gcj(region)
    if use is None:
        st = china_status(lat, lng)
        if st == IN:
            d1, d2 = _delta(lat, lng)
            return lat + d1, lng + d2, False
        return lat, lng, st == AMBIGUOUS
    if use:
        d1, d2 = _delta(lat, lng)
        return lat + d1, lng + d2, False
    return lat, lng, False


def in_china(lat: float, lng: float) -> bool:
    """只有确定在范围内才是 True；ambiguous 也是 False（不确定就不换算，宁可不换也不错换）。"""
    return china_status(lat, lng) == IN


def _t_lat(x, y):
    r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    r += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    r += (160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return r


def _t_lng(x, y):
    r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    r += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    r += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return r


def _delta(lat, lng):
    dlat = _t_lat(lng - 105.0, lat - 35.0)
    dlng = _t_lng(lng - 105.0, lat - 35.0)
    rad = lat / 180.0 * math.pi
    magic = 1 - _EE * math.sin(rad) ** 2
    sq = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sq) * math.pi)
    dlng = (dlng * 180.0) / (_A / sq * math.cos(rad) * math.pi)
    return dlat, dlng


def wgs84_to_gcj02(lat: float, lng: float) -> tuple[float, float]:
    if not in_china(lat, lng):
        return lat, lng
    d1, d2 = _delta(lat, lng)
    return lat + d1, lng + d2


def _inverse_formula(lat: float, lng: float) -> tuple[float, float]:
    """不看范围，按公式迭代求 WGS 候选点（使 公式正向(候选) = 输入）。"""
    wl, wg = lat, lng
    for _ in range(30):
        d1, d2 = _delta(wl, wg)
        el, eg = wl + d1 - lat, wg + d2 - lng
        wl, wg = wl - el, wg - eg
        if abs(el) < 1e-10 and abs(eg) < 1e-10:
            break
    return wl, wg


def gcj02_to_wgs84_formula(lat: float, lng: float) -> tuple[float, float]:
    """不做任何范围判定，直接按公式反解（调用方已另有依据确定这是 GCJ-02，例如高德回包的大陆 adcode）。"""
    return _inverse_formula(lat, lng)


# 行政区划代码（GB/T 2260）前两位：大陆 31 个省级行政区；71=台湾、81=香港、82=澳门
MAINLAND_ADCODE_PREFIXES = frozenset({
    "11", "12", "13", "14", "15", "21", "22", "23", "31", "32", "33", "34", "35", "36", "37",
    "41", "42", "43", "44", "45", "46", "50", "51", "52", "53", "54", "61", "62", "63", "64", "65"})
SAR_ADCODE_REGION = {"71": "tw", "81": "hk", "82": "mo"}


def adcode_region(adcode) -> str | None:
    """高德 adcode → "mainland" / "hk" / "mo" / "tw" / None（空、格式不对、境外码等 = None，交给几何判定）。"""
    code = str(adcode or "").strip()
    if len(code) != 6 or not code.isdigit():
        return None
    if code[:2] in MAINLAND_ADCODE_PREFIXES:
        return "mainland"
    return SAR_ADCODE_REGION.get(code[:2])


def adcode_is_gcj(adcode) -> bool | None:
    """这条高德结果是否确定是 GCJ-02：True/False = 由 adcode 决定；None = 没有可用的 adcode。
    大陆码 → True；港澳台码 → 按 EPHEMERA_GCJ_REGIONS 是否选中（默认不选 = False）。"""
    reg = adcode_region(adcode)
    if reg is None:
        return None
    return reg in _regions()


def gcj02_to_wgs84_checked(lat: float, lng: float) -> tuple[float, float, bool, bool]:
    """→ (纬度, 经度, 换了没有, ambiguous)。

    换不换由 WGS 候选点决定（与正向同一原点）。原点或候选点任一为 ambiguous、或两者判定不一致（一个在内
    一个在外）→ ambiguous：**不换算，原样返回**，由上层标出来（宁可不换也不错换）。"""
    if not (0.0 <= lat <= 57.0 and 71.0 <= lng <= 139.0):
        return lat, lng, False, False
    cand = _inverse_formula(lat, lng)
    sc, sg = china_status(*cand), china_status(lat, lng)
    if AMBIGUOUS in (sc, sg) or sc != sg:
        return lat, lng, False, True
    if sc == IN:
        return cand[0], cand[1], True, False
    return lat, lng, False, False


def gcj02_to_wgs84(lat: float, lng: float) -> tuple[float, float]:
    la, lo, _, _ = gcj02_to_wgs84_checked(lat, lng)
    return la, lo


def to_wgs84(lat: float, lng: float, crs: str) -> tuple[float, float]:
    """按声明的坐标系归一化。只有 GCJ-02 会被换算；WGS-84 原样（手填坐标、已入库坐标不会被重复换）。"""
    if crs == CRS_GCJ02:
        return gcj02_to_wgs84(lat, lng)
    if crs == CRS_WGS84:
        return lat, lng
    raise ValueError(f"未知坐标系: {crs}")


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))
