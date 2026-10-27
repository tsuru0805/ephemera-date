"""约会地图（纸质地图页的数据端）+ 本地路网步行时间。

输入 = 约会的公开投影（只用已经公开的站：没公开的站 place=None，拿不到坐标，所以地图范围、路线、站点都不会透露
还没揭晓的地方）。形状::

    {"stops": [{"n": 1, "no_place": False,
                "place": {"lat": .., "lng": .., "leg": {"mode": "walk"|"train"|"subway"|"bus"|"taxi",
                                                        "steps": [{"board", "alight", "line"}]},
                          "walk_path": [[lat, lng], ...]}}]}

数据 = 建底图脚本（ephemera_date.maps.build / scripts/build_basemap.py）从 OSM 区域包建的本地只读库；查询与路线计算
全在本机，不调任何外部地图服务，不把约会地点发出去。

输出（米坐标，原点=地图左上角，y 向下）::

    {W, H, layers:{major,minor,tiny,motor,rail,river,water,park,ferry:[path...]},
     stops:[{n, x, y, covered}],
     legs:[{n, mode, kind, pts, meters, minutes, reason, reason_text, straight_m, schematic,
            unverified_connector_m, search_margin_m, has_ferry, ferry:[{pts, meters, minutes}]}],
     walk_paths:[{n, pts, meters, minutes}],
     stats:{walk_m, walk_minutes, walk_legs_without_network, transit_legs, ferry_legs, speed_kmh},
     area, attribution, basemap, fill_rule}

面（water/park）每个是一条含全部环的路径（外环 + 孔洞），按 fill_rule="evenodd" 填充即保留湖中岛、海中岛。
线按矩形逐段裁剪（Liang–Barsky），两端都在框外但穿过地图的线段也会画。

legs[].n = 目的地站号（路段属于后一站）。kind = walk（步行路网最短路）/ transit（沿铁轨）/ road（车行路网）/
straight（找不到路网时两点直线，**只作示意**：meters 与 minutes 为空，reason 说明原因）。
schematic=True = 这段画的（全部或部分）是直线示意，不是真实路线（含铁路沿轨道找不到时的直线）。
吸附：地点接到最近路段上的投影点（不是最近节点）。≤90 米视为已接上；90–300 米只在连线不穿过河流/地面铁路/
水面时才接，并在 unverified_connector_m 里报这段未核实连线的米数；再远 = 这段没有路网数据。车行同规。
寻路窗口：两端外扩 600 米；不连通时扩到 2000 米再试一次，仍不通 = disconnected（search_margin_m 报实际窗口）。
步行分钟数 = 本地路网最短路米数 ÷ 步行速度（默认 4.5 km/h，EPHEMERA_WALK_SPEED_KMH），向上取整、至少 1 分钟。
轮渡：底图里的轮渡航线（cls=ferry）是步行路网里的特殊边，不按步行速度算：每段（连续坐的一程）=
公里数 × EPHEMERA_FERRY_MIN_PER_KM（默认 4）+ 等船 EPHEMERA_FERRY_WAIT_MIN（默认 10）分钟，向上取整；
最短路按时间比较（坐船与等船折成步行米数），所以只有真的更快时才坐船。含轮渡的步行段 has_ferry=True，
ferry[] 逐段给出坐船那一截的几何（页面画成虚线）、米数与分钟数；meters 含坐船的米数，minutes = 步行 + 轮渡。
轮渡端点没接上步行路网时，接到 150 米内最近的步行路网节点。地图层 layers.ferry = 范围内的轮渡航线。
reason：out_of_coverage（不在已建底图范围内）/ no_network（这段没有路网数据）/ disconnected（路网不连通）/
on_water（找不到路，且起点或终点落在水面/海面里，reason_text 写明是起点还是终点）/ not_walk（步行以外的路段不估时间）。
"""
from __future__ import annotations

import heapq
import json
import math
import sqlite3
import struct
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from ..places.base import WalkResult
from ..places.config import ferry_min_per_km, ferry_wait_min, map_dir, walk_speed_kmh

PT = struct.Struct("<qii")
ATTRIBUTION = "© OpenStreetMap contributors"
PAD_M = 380              # 站点外留白
MIN_SPAN_M = 1500        # 地图最小边长（只有一站时也要看得出周围）
ROUTE_MARGIN_M = 600     # 算路线时比两端多取的范围
TRANSIT_MODES = {"train", "subway"}
ROAD_MODES = {"bus", "taxi"}
_CACHE_N = 32

REASONS = {
    "no_basemap": "还没有建底图：先用建底图脚本建这个城市的底图库",
    "out_of_coverage": "这段不在已建底图范围内，没有路网数据",
    "no_network": "这段没有路网数据",
    "disconnected": "这段路网在搜索范围内不连通（两端外扩 2 公里内找不到能走通的路）",
    "not_walk": "步行以外的路段不估时间",
}
WATER_TEXT = "{which}在水面上（可能是坐标偏了，比如把国内地图的坐标当成了 GPS 坐标），找不到能走的路"
REASONS["on_water"] = WATER_TEXT.format(which="起点或终点")


class MapUnavailable(Exception):
    def __init__(self, code: str, text: str | None = None):
        super().__init__(text or REASONS.get(code, code))
        self.code, self.text = code, text or REASONS.get(code, code)


# ── 底图库与覆盖范围 ────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Basemap:
    path: Path
    bbox: tuple[float, float, float, float]      # (minlat, maxlat, minlon, maxlon)，不含建库时的缓冲带
    name: str

    def covers(self, lat: float, lng: float) -> bool:
        a, b, c, d = self.bbox
        return a <= lat <= b and c <= lng <= d


def _connect_ro(p: Path) -> sqlite3.Connection:
    c = sqlite3.connect(Path(p).resolve().as_uri() + "?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def _read_info(p: Path) -> Basemap | None:
    try:
        c = _connect_ro(p)
    except sqlite3.Error:
        return None
    try:
        meta = {r["k"]: r["v"] for r in c.execute("SELECT k, v FROM meta")}
        if meta.get("bbox"):
            bb = tuple(float(x) for x in meta["bbox"].split(","))
        else:                                   # 没记范围的库：用数据外接框
            row = c.execute("SELECT MIN(minlat), MAX(maxlat), MIN(minlon), MAX(maxlon) FROM way_rt").fetchone()
            if row[0] is None:
                return None
            bb = tuple(float(x) for x in row)
        return Basemap(Path(p), bb, meta.get("name") or Path(p).stem)
    except (sqlite3.Error, ValueError):
        return None
    finally:
        c.close()


class MapStore:
    """一个目录里的多个城市底图库（每个 *.sqlite 一个）。也可直接给文件列表。"""

    def __init__(self, src: str | Path | list | None = None):
        if src is None:
            src = map_dir()
        paths: list[Path] = []
        for s in (src if isinstance(src, (list, tuple)) else [src]):
            s = Path(s).expanduser()
            if s.is_dir():
                paths += sorted(s.glob("*.sqlite"))
            elif s.is_file():
                paths.append(s)
        self.maps = [m for m in (_read_info(p) for p in paths) if m]

    def coverage(self, lat: float, lng: float) -> dict:
        for m in self.maps:
            if m.covers(lat, lng):
                return {"covered": True, "basemap": m.name}
        return {"covered": False, "basemap": None,
                "reason": "no_basemap" if not self.maps else "out_of_coverage",
                "reason_text": REASONS["no_basemap" if not self.maps else "out_of_coverage"]}

    def pick(self, pts: list[tuple[float, float]]) -> Basemap:
        """覆盖点数最多的那个库；一个都不覆盖 → MapUnavailable。"""
        if not self.maps:
            raise MapUnavailable("no_basemap")
        best = max(self.maps, key=lambda m: sum(m.covers(*p) for p in pts))
        if pts and not any(best.covers(*p) for p in pts):
            raise MapUnavailable("out_of_coverage", "这些地点不在任何已建底图的范围内：先用建底图脚本建这个城市")
        return best


# ── 投影与几何 ─────────────────────────────────────────────────────────────────
class Proj:
    """经纬度 → 米（等距近似；城市范围几公里内误差可忽略）。原点=范围左上角。"""

    def __init__(self, lat0, lat1, lon0, lon1):
        self.lat1, self.lon0 = lat1, lon0
        self.kx = math.cos(math.radians((lat0 + lat1) / 2)) * 111320
        self.ky = 110540
        self.W = (lon1 - lon0) * self.kx
        self.H = (lat1 - lat0) * self.ky

    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (self.lat1 - lat) * self.ky)


def _bbox_m(lat, lon, half_x_m, half_y_m):
    kx = math.cos(math.radians(lat)) * 111320
    return (lat - half_y_m / 110540, lat + half_y_m / 110540, lon - half_x_m / kx, lon + half_x_m / kx)


def _decode(blob: bytes):
    """→ 环列表，每环 [(节点号, 纬度, 经度)...]；线就是只有一环。"""
    rings, cur = [], []
    for nid, la, lo in PT.iter_unpack(blob):
        if nid == -1:
            rings.append(cur)
            cur = []
            continue
        cur.append((nid, la / 1e7, lo / 1e7))
    rings.append(cur)
    return rings


def _dp(pts, eps):
    """Douglas-Peucker（迭代版，长线不爆栈）。"""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i], pts[j]
        L = math.hypot(x2 - x1, y2 - y1) or 1e-9
        k, dm = -1, eps
        for m in range(i + 1, j):
            x, y = pts[m]
            d = abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / L
            if d > dm:
                k, dm = m, d
        if k >= 0:
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [p for p, f in zip(pts, keep) if f]


def _ways(c, bb, classes):
    q = ("SELECT w.id, w.cls, w.flags, w.pts FROM way_rt r JOIN way w ON w.id=r.id"
         " WHERE r.maxlat>=? AND r.minlat<=? AND r.maxlon>=? AND r.minlon<=?"
         f" AND w.cls IN ({','.join('?' * len(classes))})")
    return c.execute(q, (bb[0], bb[1], bb[2], bb[3], *classes))


def _clip_poly(pts, r):
    """Sutherland–Hodgman：多边形按矩形 r=(x0,y0,x1,y1) 裁剪（大片水面/林地只留框里那块）。"""
    x0, y0, x1, y1 = r
    edges = ((lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
             (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
             (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
             (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1)))
    out = pts
    for inside, cross in edges:
        if not out:
            break
        src, out = out, []
        for k, cur in enumerate(src):
            prev = src[k - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
    return out


def _clip_seg(p, q, r):
    """Liang–Barsky：线段 p→q 按矩形 r=(x0,y0,x1,y1) 裁剪 → (p', q') 或 None。两端都在框外但穿框的也保留。"""
    x0, y0, x1, y1 = r
    dx, dy = q[0] - p[0], q[1] - p[1]
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, p[0] - x0), (dx, x1 - p[0]), (-dy, p[1] - y0), (dy, y1 - p[1])):
        if pk == 0:
            if qk < 0:
                return None
            continue
        t = qk / pk
        if pk < 0:
            if t > t1:
                return None
            t0 = max(t0, t)
        else:
            if t < t0:
                return None
            t1 = min(t1, t)
    if t0 > t1:
        return None
    return (p[0] + t0 * dx, p[1] + t0 * dy), (p[0] + t1 * dx, p[1] + t1 * dy)


def _clip_line(pts, r):
    """折线按矩形裁成若干段（逐段 Liang–Barsky，相邻段首尾相接的连成一条）。"""
    runs, cur = [], []
    for a, b in zip(pts, pts[1:]):
        seg = _clip_seg(a, b, r)
        if seg is None:
            if cur:
                runs.append(cur)
                cur = []
            continue
        sa, sb = seg
        if cur and cur[-1] == sa:
            cur.append(sb)
        else:
            if cur:
                runs.append(cur)
            cur = [sa, sb]
        if sb != b:                      # 线段在框内中途出框：这一段到此为止
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [x for x in runs if len(x) >= 2 and any(p != x[0] for p in x)]


def _path(ring, proj, eps, close, rect=None):
    pts = [proj.xy(la, lo) for _, la, lo in ring]
    if rect is not None:
        if close:
            pts = _clip_poly(pts, rect)
            if len(pts) < 3:
                return None
        else:
            return "".join(d for seg in _clip_line(pts, rect) if (d := _path_xy(seg, eps, False)))
    return _path_xy(pts, eps, close)


def _area_path(rings, proj, eps, rect):
    """一个面的全部环（外环 + 孔洞）合成一条路径，按 evenodd 规则填充即保留孔洞（湖中岛、海中岛）。"""
    return "".join(d for ring in rings if len(ring) >= 3 and (d := _path(ring, proj, eps, True, rect))) or None


def _path_xy(pts, eps, close):
    if close and len(pts) > 4:      # 闭合环首尾同点，整段简化会塌成一点：拆两半
        m = len(pts) // 2
        pts = _dp(pts[:m + 1], eps)[:-1] + _dp(pts[m:], eps)
    else:
        pts = _dp(pts, eps)
    if len(pts) < 2:
        return None
    return "M" + "L".join(f"{x:.0f} {y:.0f}" for x, y in pts) + ("Z" if close else "")


# ── 路网与最短路 ──────────────────────────────────────────────────────────────────
def _hav(la1, lo1, la2, lo2):
    kx = math.cos(math.radians((la1 + la2) / 2)) * 111320
    return math.hypot((lo2 - lo1) * kx, (la2 - la1) * 110540)


def _graph(c, bb, cls_list, need_flag, prefer=None):
    """路网图 → (邻接表, 节点坐标, 路段表)。prefer=线名（只给铁路用）：名字里不含它的轨道边权 ×4。
    路段表每项 (a, b, (lat_a, lon_a), (lat_b, lon_b), 权重系数)，吸附用。"""
    g, loc, edges = {}, {}, []
    for r in c.execute("SELECT w.flags, w.name, w.pts FROM way_rt r JOIN way w ON w.id=r.id"
                       " WHERE r.maxlat>=? AND r.minlat<=? AND r.maxlon>=? AND r.minlon<=?"
                       f" AND w.cls IN ({','.join('?' * len(cls_list))})", (*bb, *cls_list)):
        if need_flag and not (r["flags"] & need_flag):
            continue
        k = 4.0 if prefer and prefer not in (r["name"] or "") else 1.0
        nodes = _decode(r["pts"])[0]
        for (a, la1, lo1), (b, la2, lo2) in zip(nodes, nodes[1:]):
            if a <= 0 or b <= 0:
                continue
            loc[a] = (la1, lo1)
            loc[b] = (la2, lo2)
            d = _hav(la1, lo1, la2, lo2)
            g.setdefault(a, []).append((b, d * k, d))
            g.setdefault(b, []).append((a, d * k, d))
            edges.append((a, b, (la1, lo1), (la2, lo2), k))
    return g, loc, edges


FERRY_NODE = 1 << 50         # 轮渡边用的节点副本：id = 这个 + OSM 节点号（与步行节点分开，上下船才另算等船）
FERRY_LINK_M = 150           # 轮渡端点没接上步行路网时，接到这么远以内最近的步行节点


@dataclass(frozen=True)
class FerryCost:
    """轮渡怎么算时间：步行速度（米/分钟，用来把时间折成步行米数比较）、坐船每公里几分钟、每段等船几分钟。"""
    walk_m_per_min: float
    min_per_km: float
    wait_min: float

    @classmethod
    def from_env(cls, speed_kmh: float) -> "FerryCost":
        return cls(speed_kmh * 1000 / 60, ferry_min_per_km(), ferry_wait_min())

    def ride_minutes(self, meters: float) -> float:
        return meters / 1000 * self.min_per_km


def _add_ferry(c, bb, g, loc, cost: FerryCost) -> int:
    """把范围内的轮渡航线加进步行图：船上的边连在节点副本（FERRY_NODE + 节点号）之间，权重 = 坐船分钟折成步行米数；
    上船/下船边连副本与岸上节点，各算一半等船时间（连续坐一程只算一次等船）。上下船点 = 航线端点（不与别的航线
    相接的）与航线上本来就在步行路网里的节点；端点不在步行路网里就接到 FERRY_LINK_M 内最近的步行节点。→ 航线条数。"""
    rows = list(c.execute("SELECT w.pts FROM way_rt r JOIN way w ON w.id=r.id"
                          " WHERE r.maxlat>=? AND r.minlat<=? AND r.maxlon>=? AND r.minlon<=? AND w.cls='ferry'", bb))
    if not rows:
        return 0
    lines, end_count = [], {}
    for r in rows:
        nodes = [x for x in _decode(r["pts"])[0] if x[0] > 0]
        if len(nodes) >= 2:
            lines.append(nodes)
            for n in (nodes[0][0], nodes[-1][0]):
                end_count[n] = end_count.get(n, 0) + 1
    land = [n for n in g if 0 < n < FERRY_NODE]
    half_wait = cost.wait_min / 2 * cost.walk_m_per_min
    for nodes in lines:
        for (a, la1, lo1), (b, la2, lo2) in zip(nodes, nodes[1:]):
            fa, fb = FERRY_NODE + a, FERRY_NODE + b
            loc[fa], loc[fb] = (la1, lo1), (la2, lo2)
            d = _hav(la1, lo1, la2, lo2)
            w = cost.ride_minutes(d) * cost.walk_m_per_min
            g.setdefault(fa, []).append((fb, w, d))
            g.setdefault(fb, []).append((fa, w, d))
        for k, (a, la, lo) in enumerate(nodes):
            terminal = k in (0, len(nodes) - 1) and end_count.get(a, 0) == 1
            on_land = a in g
            if not on_land and terminal:
                near = min(land, key=lambda n: _hav(la, lo, *loc[n]), default=None)
                if near is None or _hav(la, lo, *loc[near]) > FERRY_LINK_M:
                    continue
                dd = _hav(la, lo, *loc[near])
                loc[a] = (la, lo)
                g.setdefault(a, []).append((near, dd, dd))
                g[near].append((a, dd, dd))
            elif not on_land:
                continue
            fa = FERRY_NODE + a
            g.setdefault(a, []).append((fa, half_wait, 0.0))
            g[fa].append((a, half_wait, 0.0))
    return len(lines)


def _ferry_runs(ids, loc, cost: FerryCost) -> list[dict]:
    """最短路节点序列里连续坐船的几程 → [{i, j, meters, minutes}]（i..j = ids 里船上节点的下标）。"""
    runs, i = [], 0
    while i < len(ids):
        if ids[i] >= FERRY_NODE:
            j = i
            while j + 1 < len(ids) and ids[j + 1] >= FERRY_NODE:
                j += 1
            m = sum(_hav(*loc[ids[k]], *loc[ids[k + 1]]) for k in range(i, j))
            runs.append({"i": i, "j": j, "meters": m,
                         "minutes": math.ceil(cost.ride_minutes(m) + cost.wait_min)})
            i = j + 1
        else:
            i += 1
    return runs


def _in_ring(lat, lon, ring) -> bool:
    inside = False
    for (_, la1, lo1), (_, la2, lo2) in zip(ring, ring[1:] + ring[:1]):
        if (la1 > lat) != (la2 > lat) and lon < (lo2 - lo1) * (lat - la1) / (la2 - la1) + lo1:
            inside = not inside
    return inside


def _on_water(c, P) -> bool:
    """P=(lat, lon) 是否落在水面/海面多边形里（同一个面的全部环按 evenodd：湖中岛、海中岛不算水面）。"""
    lat, lon = P
    for r in c.execute("SELECT w.pts FROM way_rt r JOIN way w ON w.id=r.id"
                       " WHERE r.maxlat>=? AND r.minlat<=? AND r.maxlon>=? AND r.minlon<=? AND w.cls='water'",
                       (lat, lat, lon, lon)):
        if sum(_in_ring(lat, lon, ring) for ring in _decode(r["pts"]) if len(ring) >= 3) % 2 == 1:
            return True
    return False


def _water_reason(c, origin, dest):
    """路段找不到路时：起点/终点落在水面上 → ("on_water", 说明)；都不在 → None。"""
    o = origin is not None and _on_water(c, origin)
    d = _on_water(c, dest)
    if not (o or d):
        return None
    return "on_water", WATER_TEXT.format(which="起点和终点" if o and d else "起点" if o else "终点")


def _near_nodes(loc, pts, limit_m, max_m=None):
    """离 pts 中任一点 limit_m 以内的节点 → {节点: 到那点的距离}；一个都没有就取最近的那一个
    （仍要在 max_m 以内，缺省 = 3 倍 limit_m）。只给铁路（按站点吸附到轨道节点）用。"""
    out, best, bd = {}, None, max_m if max_m is not None else limit_m * 3
    for n, (a, b) in loc.items():
        d = min(_hav(la, lo, a, b) for la, lo in pts)
        if d < limit_m:
            out[n] = d
        if d < bd:
            best, bd = n, d
    if not out and best is not None:
        out[best] = bd
    return out


def _dijkstra(g, srcs: dict, dsts: dict):
    """多起点多终点最短路：起点带起始代价，到达任一终点（加上终点离站的距离）即停。→ (节点序列, 真实米数) 或 None"""
    dist, prev, real, pq = {}, {}, {}, []
    for s, d0 in srcs.items():
        dist[s], real[s] = d0, 0.0
        heapq.heappush(pq, (d0, s))
    best = None
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18):
            continue
        if best is not None and d >= best[0]:
            break
        if u in dsts and (best is None or d + dsts[u] < best[0]):
            best = (d + dsts[u], u)
        for v, w, m in g.get(u, ()):
            nd = d + w
            if nd < dist.get(v, 1e18):
                dist[v], prev[v], real[v] = nd, u, real[u] + m
                heapq.heappush(pq, (nd, v))
    if best is None:
        return None
    t = best[1]
    out = [t]
    while out[-1] in prev:
        out.append(prev[out[-1]])
    return out[::-1], real[t]


# ── 吸附：地点 → 最近路段上的投影点 ─────────────────────────────────────────────────
SNAP_OK_M = 90              # 离路段 ≤ 90 米：视为已接上
SNAP_UNVERIFIED_M = 300     # 90–300 米：连线不穿过河流/铁路/水面才接，结果标 unverified_connector_m
OBSTACLE_CLASSES = ("river", "rail", "water")


def _seg_x(p1, p2, p3, p4) -> bool:
    """两线段（平面坐标）是否相交（含端点接触）。"""
    def orient(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return (v > 1e-12) - (v < -1e-12)

    def on(a, b, c):
        return min(a[0], b[0]) - 1e-12 <= c[0] <= max(a[0], b[0]) + 1e-12 and \
            min(a[1], b[1]) - 1e-12 <= c[1] <= max(a[1], b[1]) + 1e-12
    o1, o2, o3, o4 = orient(p1, p2, p3), orient(p1, p2, p4), orient(p3, p4, p1), orient(p3, p4, p2)
    if o1 != o2 and o3 != o4:
        return True
    return (o1 == 0 and on(p1, p2, p3)) or (o2 == 0 and on(p1, p2, p4)) or \
        (o3 == 0 and on(p3, p4, p1)) or (o4 == 0 and on(p3, p4, p2))


def _blocked(c, P, Q) -> bool:
    """P→Q（(lat, lon)）这条连线是否穿过已知障碍：河流线、地面铁路（隧道/地下不算）、水面（含海面）边界。"""
    bb = (min(P[0], Q[0]), max(P[0], Q[0]), min(P[1], Q[1]), max(P[1], Q[1]))
    a, b = (P[1], P[0]), (Q[1], Q[0])
    for r in c.execute("SELECT w.cls, w.flags, w.pts FROM way_rt r JOIN way w ON w.id=r.id"
                       " WHERE r.maxlat>=? AND r.minlat<=? AND r.maxlon>=? AND r.minlon<=?"
                       f" AND w.cls IN ({','.join('?' * len(OBSTACLE_CLASSES))})", (*bb, *OBSTACLE_CLASSES)):
        if r["cls"] == "rail" and r["flags"] & 4:
            continue
        for ring in _decode(r["pts"]):
            pts = [(lo, la) for _, la, lo in ring]
            if any(_seg_x(a, b, u, v) for u, v in zip(pts, pts[1:])):
                return True
    return False


def _project(P, A, B):
    """P 到线段 AB（都是 (lat, lon)）的投影 → (投影点, 距离米, t)。局部等距平面近似。"""
    kx = math.cos(math.radians(P[0])) * 111320
    ax, ay = (A[1] - P[1]) * kx, (A[0] - P[0]) * 110540
    bx, by = (B[1] - P[1]) * kx, (B[0] - P[0]) * 110540
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
    qx, qy = ax + t * dx, ay + t * dy
    return (P[0] + qy / 110540, P[1] + qx / kx), math.hypot(qx, qy), t


def _snap(c, P, edges):
    """→ [(路段, 投影点, 连接米数, 已核实?)]。≤90 米的全部算（多个起点，最短路自己挑）；
    没有就从 90–300 米里按距离找第一个连线不穿障碍的；都不行 = []。"""
    lim = SNAP_UNVERIFIED_M
    dlat = lim / 110540
    dlon = lim / (math.cos(math.radians(P[0])) * 111320)
    cand = []
    for e in edges:
        (la1, lo1), (la2, lo2) = e[2], e[3]
        if max(la1, la2) < P[0] - dlat or min(la1, la2) > P[0] + dlat or \
                max(lo1, lo2) < P[1] - dlon or min(lo1, lo2) > P[1] + dlon:
            continue
        Q, d, _ = _project(P, e[2], e[3])
        if d <= lim:
            cand.append((d, e, Q))
    cand.sort(key=lambda x: x[0])
    ok = [(e, Q, d, True) for d, e, Q in cand if d <= SNAP_OK_M]
    if ok:
        return ok
    for d, e, Q in cand:
        if not _blocked(c, P, Q):
            return [(e, Q, d, False)]
    return []


def _route_snap(c, origin, dest, cls_list, flag, margin_m, ferry: FerryCost | None = None):
    """道路（步行/车行）最短路：两端吸附到路段投影点（只吸附到道路上，不吸附到轮渡航线上）。
    ferry 给了（只有步行给）= 轮渡航线也进图，见 _add_ferry。
    → {"pts", "meters", "unverified_m", "ferry"} 或失败原因 "no_network" / "disconnected"。
    ferry = [{"i", "j", "meters", "minutes"}]，i..j 是 pts 里坐船那一截的下标。"""
    la0, la1 = min(origin[0], dest[0]), max(origin[0], dest[0])
    lo0, lo1 = min(origin[1], dest[1]), max(origin[1], dest[1])
    mx = margin_m / (math.cos(math.radians(la0)) * 111320)
    my = margin_m / 110540
    g, loc, edges = _graph(c, (la0 - my, la1 + my, lo0 - mx, lo1 + mx), cls_list, flag)
    if not g:
        return "no_network"
    sa, sb = _snap(c, origin, edges), _snap(c, dest, edges)
    if not sa or not sb:
        return "no_network"
    if ferry is not None:
        _add_ferry(c, (la0 - my, la1 + my, lo0 - mx, lo1 + mx), g, loc, ferry)
    vid = [0]
    vpos, vinfo, by_edge = {}, {}, {}

    def add(e, Q, d, verified):
        vid[0] -= 1
        v = vid[0]
        a, b, A, B, k = e
        da, db = _hav(*Q, *A), _hav(*Q, *B)
        g.setdefault(v, []).extend([(a, da * k, da), (b, db * k, db)])
        g[a].append((v, da * k, da))
        g[b].append((v, db * k, db))
        for u, Qu, ku in by_edge.get((a, b), []):          # 同一路段上的两个投影点直接相连
            duv = _hav(*Q, *Qu)
            g[v].append((u, duv * k, duv))
            g[u].append((v, duv * k, duv))
        by_edge.setdefault((a, b), []).append((v, Q, k))
        vpos[v] = Q
        vinfo[v] = (d, verified)
        return v

    srcs = {add(*x): x[2] for x in sa}
    dsts = {add(*x): x[2] for x in sb}
    r = _dijkstra(g, srcs, dsts)
    if r is None:
        return "disconnected"
    ids, m = r
    loc = {**loc, **vpos}
    d0, ok0 = vinfo[ids[0]]
    d1, ok1 = vinfo[ids[-1]]
    unverified = (0 if ok0 else d0) + (0 if ok1 else d1)
    runs = [{**x, "i": x["i"] + 1, "j": x["j"] + 1} for x in _ferry_runs(ids, loc, ferry)] if ferry else []
    return {"pts": [origin] + [loc[n] for n in ids] + [dest], "meters": m + d0 + d1, "unverified_m": unverified,
            "ferry": runs}


ROUTE_MARGIN_RETRY_M = 2000  # 第一次窗口里不连通时，扩大到这么大再试一次


def _route_road(c, origin, dest, cls_list, flag, ferry: FerryCost | None = None):
    """先按两端外扩 ROUTE_MARGIN_M 找；不连通再扩到 ROUTE_MARGIN_RETRY_M 试一次。
    → (结果 dict | 原因, 实际用的外扩米数)。"""
    r = _route_snap(c, origin, dest, cls_list, flag, ROUTE_MARGIN_M, ferry)
    if r != "disconnected":
        return r, ROUTE_MARGIN_M
    return _route_snap(c, origin, dest, cls_list, flag, ROUTE_MARGIN_RETRY_M, ferry), ROUTE_MARGIN_RETRY_M


def _route_rail(c, A, B, prefer=None, snap_m=250):
    """铁路：A、B=候选车站点列表（同名车站可能有好几个点），吸附到轨道节点。窗口不连通时同样扩大重试一次。
    → ([(lat,lon)...], 米) 或 None。"""
    allp = A + B
    la0, la1 = min(p[0] for p in allp), max(p[0] for p in allp)
    lo0, lo1 = min(p[1] for p in allp), max(p[1] for p in allp)
    for margin in (ROUTE_MARGIN_M, ROUTE_MARGIN_RETRY_M):
        mx = margin / (math.cos(math.radians(la0)) * 111320)
        my = margin / 110540
        g, loc, _ = _graph(c, (la0 - my, la1 + my, lo0 - mx, lo1 + mx), ("rail",), 0, prefer)
        if not g:
            return None
        srcs, dsts = _near_nodes(loc, A, snap_m), _near_nodes(loc, B, snap_m)
        if not srcs or not dsts:
            return None
        r = _dijkstra(g, srcs, dsts)
        if r is None:
            continue
        ids, m = r
        a = min(A, key=lambda p: _hav(*p, *loc[ids[0]]))
        b = min(B, key=lambda p: _hav(*p, *loc[ids[-1]]))
        return [a] + [loc[n] for n in ids] + [b], m + _hav(*a, *loc[ids[0]]) + _hav(*b, *loc[ids[-1]])
    return None


def _stations(c, name, near, radius_m):
    """按站名在 near 附近找车站（同名的几个点都要：大站常是每条线一个点）；名字末尾的「駅/站」去掉再试。"""
    if not name:
        return []
    names = {name.strip(), name.strip().rstrip("駅站").strip()}
    low = {n.lower() for n in names}
    bb = _bbox_m(near[0], near[1], radius_m, radius_m)
    rows = c.execute("SELECT s.name, s.name_en, s.lat, s.lon FROM station_rt r JOIN station s ON s.id=r.id"
                     " WHERE r.maxlat>=? AND r.minlat<=? AND r.maxlon>=? AND r.minlon<=?", bb).fetchall()
    hits = [r for r in rows if r["name"] in names or (r["name_en"] or "").lower() in low]
    if not hits:
        return []
    h0 = min(hits, key=lambda r: _hav(near[0], near[1], r["lat"], r["lon"]))
    # 只留离最近那个点 600 米以内的（同一个站的几条线），别把远处的同名站也算进来
    return [(r["lat"], r["lon"]) for r in hits if _hav(h0["lat"], h0["lon"], r["lat"], r["lon"]) < 600]


def minutes_for(meters: float, speed_kmh: float) -> int:
    """米 → 步行分钟（向上取整，至少 1）。"""
    return max(1, math.ceil(meters / (speed_kmh * 1000 / 60)))


WALK_CLASSES = ("major", "minor", "tiny")
ROAD_CLASSES = ("major", "minor", "tiny", "motor")


def _walk_route(c, origin, dest, ferry: FerryCost):
    return _route_road(c, origin, dest, WALK_CLASSES, 1, ferry)


def walk_minutes(r: dict, speed_kmh: float) -> int:
    """步行路线结果 → 分钟数：步行部分按步行速度，轮渡部分按坐船 + 等船。"""
    ferry_m = sum(x["meters"] for x in r.get("ferry") or ())
    if not r.get("ferry"):
        return minutes_for(r["meters"], speed_kmh)
    walk_m = max(0.0, r["meters"] - ferry_m)
    return (minutes_for(walk_m, speed_kmh) if walk_m > 0 else 0) + sum(x["minutes"] for x in r["ferry"])


def _leg_geo(c, leg, origin, dest, bm: Basemap, ferry: FerryCost | None = None):
    """一段路的几何。origin 可为 None（第 0 段：从哪出发不知道）。
    → {"kind", "pts", "meters", "reason", "reason_text", "schematic", "unverified_m", "margin_m", "ferry"}
    或 None（不画）。"""
    mode = (leg or {}).get("mode") or "walk"
    out = {"reason": None, "reason_text": None, "schematic": False, "unverified_m": 0, "margin_m": None, "ferry": []}
    if mode in TRANSIT_MODES:
        steps = [s for s in (leg.get("steps") or []) if s.get("board") or s.get("alight")]
        pts, total, cur, schematic = [], 0.0, origin, False
        for k, s in enumerate(steps):
            B = _stations(c, s.get("board"), cur or dest, 3000 if cur else 40000) or ([cur] if cur else [])
            E = _stations(c, s.get("alight"), dest, 40000) or ([dest] if k == len(steps) - 1 else [])
            if not B or not E:
                schematic = True
                continue
            r = _route_rail(c, B, E, prefer=s.get("line"))
            if r:
                seg, m = r
            else:                          # 沿轨道找不到：画两站之间的直线示意
                seg, m = [B[0], E[0]], _hav(*B[0], *E[0])
                schematic = True
            pts += seg          # 换乘：上一段的下车点直接连到这一段的上车点
            total += m
            cur = seg[-1]
        if not pts:
            if origin is None:
                return None
            return {**out, "kind": "straight", "pts": [origin, dest], "meters": None, "reason": "no_network",
                    "schematic": True}
        if origin is not None and pts[0] != origin:
            pts.insert(0, origin)
        if pts[-1] != dest:
            pts.append(dest)
        return {**out, "kind": "transit", "pts": pts, "meters": total, "schematic": schematic}
    if origin is None:
        return None
    if not (bm.covers(*origin) and bm.covers(*dest)):
        return {**out, "kind": "straight", "pts": [origin, dest], "meters": None, "reason": "out_of_coverage",
                "schematic": True}
    if mode in ROAD_MODES:
        r, margin = _route_road(c, origin, dest, ROAD_CLASSES, 2)
        kind = "road"
    else:
        r, margin = _walk_route(c, origin, dest, ferry or FerryCost.from_env(walk_speed_kmh()))
        kind = "walk"
    if isinstance(r, dict):
        return {**out, "kind": kind, "pts": r["pts"], "meters": r["meters"], "unverified_m": r["unverified_m"],
                "margin_m": margin, "ferry": r.get("ferry") or []}
    reason, text = _water_reason(c, origin, dest) or (r, REASONS[r])
    return {**out, "kind": "straight", "pts": [origin, dest], "meters": None, "reason": reason,
            "reason_text": text, "schematic": True, "margin_m": margin}


# ── 整张图 ────────────────────────────────────────────────────────────────────────
def _visible(view: dict):
    out = []
    for s in view.get("stops") or []:
        p = s.get("place")
        if s.get("no_place"):                      # 「一件事」：没有固定地点，不进地图范围
            continue
        if p and isinstance(p.get("lat"), (int, float)) and isinstance(p.get("lng"), (int, float)):
            out.append((s["n"], p))
    return out


def _prev_placed(view: dict) -> dict:
    """站号 → 路段起点的站号：往前数第一个有固定地点的站；None=第 0 段（怎么来的）。"""
    out, last = {}, None
    for s in view.get("stops") or []:
        if s.get("no_place"):
            continue
        out[s["n"]] = last
        last = s["n"]
    return out


_cache: "OrderedDict[str, dict]" = OrderedDict()


def build_map(view: dict, store: MapStore | None = None, speed_kmh: float | None = None) -> dict:
    """公开投影 → 地图 JSON。没有任何底图库 / 地点全在底图范围外 → MapUnavailable(code, text)。"""
    speed = float(speed_kmh or walk_speed_kmh())
    vis = _visible(view)
    prev_of = _prev_placed(view)
    if not vis:
        return {"empty": True, "attribution": ATTRIBUTION}
    store = store if store is not None else MapStore()
    bm = store.pick([(p["lat"], p["lng"]) for _, p in vis])
    ferry = FerryCost.from_env(speed)
    key = json.dumps([str(bm.path), speed, ferry.min_per_km, ferry.wait_min, [[n, p.get("lat"), p.get("lng"), p.get("walk_path"), p.get("leg")]
                                            for n, p in vis], sorted(prev_of.items())],
                     sort_keys=True, ensure_ascii=False)
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    c = _connect_ro(bm.path)
    try:
        out = _build(c, bm, vis, prev_of, speed, ferry)
    finally:
        c.close()
    _cache[key] = out
    while len(_cache) > _CACHE_N:
        _cache.popitem(last=False)
    return out


def walk_between(origin: tuple[float, float], dest: tuple[float, float], store: MapStore | None = None,
                 speed_kmh: float | None = None) -> WalkResult:
    """两点之间步行（本地路网）。找不到路网时 minutes/meters 为空，reason 说明原因，不退直线冒充。"""
    speed = float(speed_kmh or walk_speed_kmh())
    store = store if store is not None else MapStore()
    try:
        bm = store.pick([tuple(origin), tuple(dest)])
    except MapUnavailable as e:
        return WalkResult(None, None, "local", e.code, e.text)
    if not (bm.covers(*origin) and bm.covers(*dest)):
        return WalkResult(None, None, "local", "out_of_coverage", REASONS["out_of_coverage"])
    c = _connect_ro(bm.path)
    try:
        r, margin = _walk_route(c, tuple(origin), tuple(dest), FerryCost.from_env(speed))
        water = None if isinstance(r, dict) else _water_reason(c, tuple(origin), tuple(dest))
    finally:
        c.close()
    if not isinstance(r, dict):
        reason, text = water or (r, REASONS[r])
        return WalkResult(None, None, "local", reason, text)
    m = r["meters"]
    return WalkResult(walk_minutes(r, speed), round(m), "local", pts=tuple(tuple(p) for p in r["pts"]),
                      unverified_connector_m=round(r["unverified_m"]) or None,
                      ferry=tuple({"meters": round(x["meters"]), "minutes": x["minutes"]} for x in r["ferry"]))


def _layers(c, bb, proj, span_x, span_y):
    area_km2 = span_x * span_y / 1e6
    eps = max(1.6, max(span_x, span_y) / 1500)
    classes = ["major", "motor", "rail", "river", "water", "park", "ferry"]
    if area_km2 <= 80:
        classes.append("minor")
    if area_km2 <= 12:
        classes.append("tiny")
    layers: dict[str, list] = {k: [] for k in ("major", "minor", "tiny", "motor", "rail", "river", "water", "park",
                                               "ferry")}
    # 裁剪框：地图范围外再留一圈（拖到边上不露白），框外的线和面不下发
    mg = max(proj.W, proj.H) * 0.35
    rect = (-mg, -mg, proj.W + mg, proj.H + mg)
    for r in _ways(c, bb, classes):
        cls, fl = r["cls"], r["flags"]
        if cls == "rail" and fl & 4:
            continue                    # 地下的铁路不画
        if cls == "tiny" and fl & 16:
            continue                    # 人行道只进路网不画
        rings = _decode(r["pts"])
        if cls in ("water", "park"):          # 面：所有环（外环 + 孔洞）合成一条路径，evenodd 填充
            d = _area_path(rings, proj, eps, rect)
            if d:
                layers[cls].append(d)
            continue
        for ring in rings:
            d = _path(ring, proj, eps, False, rect)
            if d:
                layers[cls].append(d)
    return layers


def _frame(lats, lons, pad_m, min_span_m):
    latc = (min(lats) + max(lats)) / 2
    kx = math.cos(math.radians(latc)) * 111320
    span_x = max((max(lons) - min(lons)) * kx + 2 * pad_m, min_span_m)
    span_y = max((max(lats) - min(lats)) * 110540 + 2 * pad_m, min_span_m)
    lonc = (min(lons) + max(lons)) / 2
    bb = (latc - span_y / 2 / 110540, latc + span_y / 2 / 110540, lonc - span_x / 2 / kx, lonc + span_x / 2 / kx)
    return bb, span_x, span_y


def _build(c, bm: Basemap, vis, prev_of: dict, speed: float, ferry: FerryCost) -> dict:
    coord = {n: (p["lat"], p["lng"]) for n, p in vis}
    # 路段：属于后一站；起点=上一个有固定地点的站（得也已公开、有坐标），没有上一站=怎么来的（第 0 段）
    legs_geo = []
    for n, p in vis:
        leg = p.get("leg")
        if not leg:
            continue
        pn = prev_of.get(n, n - 1 if n > 1 else None)
        origin = coord.get(pn) if pn is not None else None
        if pn is not None and origin is None:
            continue
        g = _leg_geo(c, leg, origin, coord[n], bm, ferry)
        if g:
            legs_geo.append((n, leg.get("mode") or "walk", g))
    walks = [(n, [tuple(x) for x in p["walk_path"]]) for n, p in vis if p.get("walk_path")]
    # 范围：已公开的站 + 已画的路线 + 散步路线
    lats = [la for la, _ in coord.values()]
    lons = [lo for _, lo in coord.values()]
    for n, _, g in legs_geo:
        pts = g["pts"]
        if prev_of.get(n, n - 1 if n > 1 else None) is None:
            continue                    # 怎么来的那段可能从很远处过来：画出边界即可，不拉大地图
        lats += [a for a, _ in pts]
        lons += [b for _, b in pts]
    for _, pts in walks:
        lats += [a for a, _ in pts]
        lons += [b for _, b in pts]
    bb, span_x, span_y = _frame(lats, lons, PAD_M, MIN_SPAN_M)
    proj = Proj(*bb)
    layers = _layers(c, bb, proj, span_x, span_y)
    xy = lambda la, lo: [round(v, 1) for v in proj.xy(la, lo)]  # noqa: E731
    # 邮戳上的地名：离第 1 个已公开站最近的车站英文名（没有英文名用本名），2 公里内没有就不印
    area = None
    n0 = vis[0][0]
    rows = c.execute("SELECT s.name, s.name_en, s.lat, s.lon FROM station_rt r JOIN station s ON s.id=r.id"
                     " WHERE r.maxlat>=? AND r.minlat<=? AND r.maxlon>=? AND r.minlon<=?",
                     _bbox_m(*coord[n0], 2000, 2000)).fetchall()
    if rows:
        h = min(rows, key=lambda r: _hav(*coord[n0], r["lat"], r["lon"]))
        area = (h["name_en"] or h["name"] or "").upper().replace("-", "") or None
    legs_out = []
    walk_m = walk_min = missing = ferry_legs = 0
    for n, mode, g in legs_geo:
        kind, pts, m, reason = g["kind"], g["pts"], g["meters"], g["reason"]
        minutes = None
        runs = g.get("ferry") or []
        if kind == "walk":
            minutes = walk_minutes({"meters": m, "ferry": runs}, speed)
            walk_m += m - sum(x["meters"] for x in runs)
            walk_min += minutes
            ferry_legs += bool(runs)
        elif mode == "walk" or mode not in TRANSIT_MODES | ROAD_MODES:
            missing += 1                # 步行段但没有路网：时间留空
        if reason is None and kind != "walk":
            reason = "not_walk"
        straight = round(_hav(*pts[0], *pts[-1])) if kind == "straight" else None
        legs_out.append({"n": n, "mode": mode, "kind": kind,
                         "pts": [[round(x, 1), round(y, 1)] for x, y in _dp([proj.xy(a, b) for a, b in pts], 1.0)],
                         "meters": round(m) if m is not None else None, "minutes": minutes,
                         "reason": reason,
                         "reason_text": (g.get("reason_text") or REASONS.get(reason)) if reason else None,
                         "straight_m": straight, "schematic": g["schematic"],
                         "unverified_connector_m": round(g["unverified_m"]) or None,
                         "search_margin_m": g["margin_m"], "has_ferry": bool(runs),
                         "ferry": [{"pts": [[round(x, 1), round(y, 1)] for x, y in
                                            _dp([proj.xy(a, b) for a, b in pts[r["i"]:r["j"] + 1]], 1.0)],
                                    "meters": round(r["meters"]), "minutes": r["minutes"]} for r in runs]})
    walk_out = []
    for n, pts in walks:
        m = sum(_hav(*a, *b) for a, b in zip(pts, pts[1:]))
        mins = minutes_for(m, speed) if m > 0 else None
        walk_m += m
        walk_min += mins or 0
        walk_out.append({"n": n, "pts": [xy(a, b) for a, b in pts], "meters": round(m), "minutes": mins})
    return {
        "W": round(proj.W), "H": round(proj.H), "layers": layers,
        "stops": [{"n": n, "x": xy(*coord[n])[0], "y": xy(*coord[n])[1], "covered": bm.covers(*coord[n])}
                  for n, _ in vis],
        "legs": legs_out,
        "walk_paths": walk_out,
        "stats": {"walk_m": round(walk_m), "walk_minutes": walk_min, "walk_legs_without_network": missing,
                  "transit_legs": sum(1 for _, mode, _ in legs_geo if mode in TRANSIT_MODES),
                  "ferry_legs": ferry_legs, "speed_kmh": speed},
        "area": area, "attribution": ATTRIBUTION, "basemap": bm.name, "fill_rule": "evenodd",
    }
