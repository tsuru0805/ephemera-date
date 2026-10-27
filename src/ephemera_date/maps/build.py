"""建底图：从 Geofabrik 的 OSM 区域包（.osm.pbf）裁出一个城市范围 → 本地只读 SQLite 底图库。

流程（内存友好：先裁剪再建，建库时的节点坐标索引只覆盖裁剪后的小文件）：
  1. 范围：bbox，或城市名 → bbox（Nominatim 一次查询，走本地缓存）；四周再加缓冲带（默认 2 公里）防边界截断。
  2. 下载（可选）：只从 Geofabrik（或使用者指定的镜像）下载一次区域包，带 .md5 校验，已下载就复用；
     不用 OSM 官方 API 批量下载。
  3. 裁剪 crop()：几何相交（顶点在框内、线段穿框、闭合路或多边形关系把框整个包住都算）的路整条保留，连同它用到的
     全部节点；水面/绿地多边形关系补齐全部成员——范围边上的路与面不被截断。规模超上限明确报错。
  4. 建库 build()：库格式见下，meta 记 bbox（不含缓冲）、缓冲米数、来源、许可证。
  5. 海面 add_sea()（可选）：OSM 的海是海岸线不是面，区域包里拼不出来；从 osmdata.openstreetmap.de 的
     water-polygons-split-4326（OSM 官方拼好的海面，ODbL）里只取本库范围内的块写成 cls=water。

库结构（ephemera_date.maps.render 是唯一读者，两边同改）::

  meta(k, v)                          name / bbox / buffer_m / source / built_at / attribution / license / format
  way(id, cls, flags, name, pts)      cls=major/minor/tiny/motor/rail/river/water/park/ferry
                                      flags: 1=可步行 2=可开车 4=隧道/地下 8=地铁 16=人行道（只进路网不画）
                                      32=轮渡（cls=ferry：route=ferry 的路，或 route=ferry 关系的成员路；
                                      步行路网里的特殊边，时间按坐船+等船算，不按步行速度）
                                      pts=小端打包 (int64 节点号, int32 纬度e7, int32 经度e7) 序列；
                                      面（water/park）的多个环之间用节点号 -1 分隔，节点号恒 0
  way_rt  R*Tree(id, minlat, maxlat, minlon, maxlon)
  station(id, name, name_en, lat, lon) + station_rt

数据许可：底图库由 OpenStreetMap 数据建出，属 ODbL 1.0（https://opendatacommons.org/licenses/odbl/1-0/）；
使用时必须署名「© OpenStreetMap contributors」。仓里不分发完整库，使用者自己建。
OSM 在国内小地方的地名与路网都可能缺，建出来的库覆盖不到的路段，地图会明确标「这段没有路网数据」。

依赖：pyosmium（osmium）、pyshp（只补海面时用），见 pyproject 的 [map-build] 可选依赖。
"""
from __future__ import annotations

import hashlib
import math
import os
import sqlite3
import struct
import sys
import time
import urllib.request
from pathlib import Path

try:
    import osmium
except ImportError:      # 只补海面（add_sea）或只用 render 时用不到
    osmium = None

ATTRIBUTION = "© OpenStreetMap contributors"
LICENSE = "ODbL-1.0"
LICENSE_NOTE = ("本库由 OpenStreetMap 数据建出，属 ODbL 1.0（https://opendatacommons.org/licenses/odbl/1-0/），"
                "使用时须署名「© OpenStreetMap contributors」。")
GEOFABRIK = "https://download.geofabrik.de"
DEFAULT_BUFFER_M = 2000
FORMAT = "1"

MAJOR = {"trunk", "primary", "secondary", "tertiary", "trunk_link", "primary_link",
         "secondary_link", "tertiary_link"}
MOTOR = {"motorway", "motorway_link"}
MINOR = {"residential", "unclassified", "living_street", "road"}
TINY = {"service", "pedestrian", "footway", "path", "steps", "cycleway", "track"}
RAIL = {"rail", "subway", "light_rail", "monorail", "tram", "narrow_gauge"}
PARK_LEISURE = {"park", "garden", "playground"}
PARK_LANDUSE = {"grass", "recreation_ground", "cemetery", "forest"}
AREA_ID_BASE = 1 << 40           # 面的行号从这里起，避开线的 way 号
SEA_ID_BASE = 1 << 41
PT = struct.Struct("<qii")
SEP = PT.pack(-1, 0, 0)


class BuildError(Exception):
    pass


def _need_osmium():
    if osmium is None:
        raise BuildError("建底图需要 pyosmium：pip install 'ephemera-date[map-build]'")


# ── 范围 ──────────────────────────────────────────────────────────────────────
def parse_bbox(s: str) -> tuple[float, float, float, float]:
    """"minlon,minlat,maxlon,maxlat"（与 osmium/Geofabrik 习惯一致）→ (minlat, maxlat, minlon, maxlon)。"""
    try:
        lo0, la0, lo1, la1 = (float(x) for x in s.split(","))
    except ValueError:
        raise BuildError("bbox 要写成 最小经度,最小纬度,最大经度,最大纬度") from None
    if not (-180 <= lo0 < lo1 <= 180 and -90 <= la0 < la1 <= 90):
        raise BuildError("bbox 范围不对（最小值要小于最大值，经纬度在合法范围内）")
    return la0, la1, lo0, lo1


def bbox_for_name(name: str, provider=None, *, transport=None) -> tuple[float, float, float, float]:
    """城市名 → bbox（Nominatim 一次查询；走数据目录下的默认缓存与跨进程限速，遵守 1 次/秒与 User-Agent 政策）。"""
    if provider is None:
        from ..places.config import PlacesConfig
        from ..places.nominatim import NominatimProvider
        provider = NominatimProvider(PlacesConfig.from_env(), transport=transport)
    bb = provider.bbox(name)
    if not bb:
        raise BuildError(f"找不到「{name}」的范围，换个写法或直接给 bbox")
    return bb


def buffered(bb, buffer_m: float):
    la0, la1, lo0, lo1 = bb
    dy = buffer_m / 110540
    dx = buffer_m / (math.cos(math.radians((la0 + la1) / 2)) * 111320)
    return la0 - dy, la1 + dy, lo0 - dx, lo1 + dx


# ── 下载 ──────────────────────────────────────────────────────────────────────
def download(region: str, dest_dir: str | Path, base: str = GEOFABRIK, user_agent: str | None = None) -> Path:
    """region 例："asia/china/shanghai" → <dest_dir>/shanghai-latest.osm.pbf（已存在且 md5 对得上就不重下）。"""
    from ..places.config import DEFAULT_UA
    region = region.strip("/").removesuffix("-latest.osm.pbf")
    url = f"{base.rstrip('/')}/{region}-latest.osm.pbf"
    dest = Path(dest_dir) / (region.split("/")[-1] + "-latest.osm.pbf")
    dest.parent.mkdir(parents=True, exist_ok=True)
    hdr = {"User-Agent": user_agent or os.getenv("EPHEMERA_NOMINATIM_UA") or DEFAULT_UA}

    def _get(u: str) -> bytes:
        with urllib.request.urlopen(urllib.request.Request(u, headers=hdr), timeout=60) as r:
            return r.read()

    want = _get(url + ".md5").decode().split()[0].strip()
    if dest.exists() and _md5(dest) == want:
        return dest
    tmp = dest.with_suffix(".part")
    with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=60) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    if _md5(tmp) != want:
        tmp.unlink()
        raise BuildError(f"下载校验失败（md5 对不上）：{url}")
    os.replace(tmp, dest)
    return dest


def _md5(p: Path) -> str:
    h = hashlib.md5()
    with open(p, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


# ── 裁剪 ──────────────────────────────────────────────────────────────────────
def _area_tags(t) -> bool:
    return bool(t.get("natural") in ("water", "wood") or t.get("waterway") == "riverbank"
                or t.get("landuse") in ("reservoir", "basin", *PARK_LANDUSE) or t.get("water")
                or t.get("leisure") in PARK_LEISURE)


def _way_wanted(t) -> bool:
    """建库会用到的线/面（其余如建筑轮廓不进裁剪结果，省空间）。车站画成面/线的也要（取质心当车站点）。
    轮渡航线（route=ferry）也要：步行路网靠它过江过海。"""
    return bool(t.get("highway") or t.get("railway") or t.get("waterway") in ("river", "canal", "riverbank")
                or _area_tags(t) or t.get("public_transport") == "station" or t.get("route") == "ferry")


def _is_ferry_rel(t) -> bool:
    """轮渡航线关系（type=route + route=ferry）：成员路不一定自己带 route=ferry，按关系认。"""
    return t.get("type") == "route" and t.get("route") == "ferry"


def _is_station(t) -> bool:
    return bool((t.get("railway") == "station" or t.get("public_transport") == "station") and t.get("name"))


class _Limits:
    """裁剪的规模上限：超了明确报错（BuildError），不悄悄吃光内存。"""

    def __init__(self, max_nodes: int, max_kept: int, max_memory_mb: int):
        self.max_nodes, self.max_kept, self.max_memory_mb = max_nodes, max_kept, max_memory_mb

    def rss_mb(self) -> float:
        import resource
        r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return r / (1 << 20) if sys.platform == "darwin" else r / 1024      # macOS 是字节，Linux 是 KB

    def check(self, n_nodes: int, n_kept: int, phase: str):
        """phase = 哪个阶段（关系预扫描 / 裁剪 / 建库 / 车站关系），写进报错，方便看是哪一步超的。"""
        if self.max_nodes and n_nodes > self.max_nodes:
            raise BuildError(f"节点数超过上限（>{self.max_nodes:,}，阶段：{phase}）：换更小的区域包，或调高 --max-nodes"
                             f"（坐标索引约占 节点数×16 字节）")
        if self.max_kept and n_kept > self.max_kept:
            raise BuildError(f"保留对象数超过上限（>{self.max_kept:,}，阶段：{phase}）：缩小范围，或调高 --max-kept")
        if self.max_memory_mb and self.rss_mb() > self.max_memory_mb:
            raise BuildError(f"建底图占用内存超过上限（>{self.max_memory_mb} MB，阶段：{phase}）：缩小范围、"
                             f"换更小的区域包，或调高 --max-memory-mb")


DEFAULT_MAX_NODES = 400_000_000       # 约一个大省/小国的区域包；坐标索引约 6.4GB
DEFAULT_MAX_KEPT = 20_000_000
DEFAULT_MAX_MEMORY_MB = 8192


def _seg_hits_box(la1, lo1, la2, lo2, bb) -> bool:
    """线段（端点经纬度）是否与范围框相交（Liang–Barsky）。"""
    la0, la1b, lo0, lo1b = bb
    dx, dy = lo2 - lo1, la2 - la1
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, lo1 - lo0), (dx, lo1b - lo1), (-dy, la1 - la0), (dy, la1b - la1)):
        if pk == 0:
            if qk < 0:
                return False
            continue
        t = qk / pk
        if pk < 0:
            if t > t1:
                return False
            t0 = max(t0, t)
        else:
            if t < t0:
                return False
            t1 = min(t1, t)
    return t0 <= t1


def _crosses_ray(la1, lo1, la2, lo2, lat, lon) -> bool:
    """射线法的一条边：从 (lat, lon) 向东的射线是否穿过这条边。"""
    return (la1 > lat) != (la2 > lat) and lon < (lo2 - lo1) * (lat - la1) / (la2 - la1) + lo1


def _geom_hits(coords, bb, center, closed: bool) -> tuple[bool, int]:
    """一条路的坐标序列与范围框：→ (相交?, 射线穿越次数)。相交=有顶点在框内或有线段穿框；
    闭合路另外用射线法看是否把框整个包住（大湖、大公园四个角都在框外）。"""
    la0, la1, lo0, lo1 = bb
    hits = any(la0 <= la <= la1 and lo0 <= lo <= lo1 for la, lo in coords)
    cross = 0
    for (a, b), (c_, d) in zip(coords, coords[1:]):
        if not hits and _seg_hits_box(a, b, c_, d, bb):
            hits = True
        if _crosses_ray(a, b, c_, d, *center):
            cross += 1
    if not hits and closed and cross % 2 == 1:
        hits = True
    return hits, cross


def crop(src: str | Path, bb, out: str | Path, *, max_nodes: int = DEFAULT_MAX_NODES,
         max_kept: int = DEFAULT_MAX_KEPT, max_memory_mb: int = DEFAULT_MAX_MEMORY_MB,
         location_storage: str = "sparse_mem_array") -> dict:
    """按范围裁剪区域包（几何相交，不只看顶点）：

    - 路：建库用得到的（道路/铁路/河流/水面/绿地），只要有顶点在框内、或有线段穿过框、或（闭合路）把框整个包住，
      就整条保留，连同它用到的全部节点（范围外的也带上，边界不截断）；
    - 多边形关系（type=multipolygon 且是水面/绿地）：任一成员路与框几何相交，或全部成员合起来把框包住（射线法
      对成员路逐段累计穿越次数），就保留关系与全部成员；
    - 成员里有关系（嵌套）的多边形关系：OSM 规范不允许（multipolygon 成员只能是路），不支持，跳过并在统计里报
      skipped_nested_relations；
    - 车站：范围内带名字的车站节点；画成面/线的车站（railway=station 或 public_transport=station 的路）按路的
      规则保留；车站关系（同样标签的 relation）任一成员节点在框内或成员路与框相交就保留，连同全部成员（不递归）。
    - 轮渡：route=ferry 的路按路的规则保留；轮渡航线关系（type=route + route=ferry）任一成员路与框相交就保留关系
      与全部成员路（建库时据关系认出成员路是轮渡）。

    三遍顺序读：①关系（无坐标）→ ②带坐标读节点与路（坐标索引按 location_storage，默认 sparse_mem_array，
    约 16 字节/节点）→ ③写出。规模上限：max_nodes（区域包节点数）、max_kept（保留对象数）、
    max_memory_mb（进程峰值内存），超了 BuildError，不悄悄吃光内存。
    """
    _need_osmium()
    lim = _Limits(max_nodes, max_kept, max_memory_mb)
    la0, la1, lo0, lo1 = bb
    center = ((la0 + la1) / 2, (lo0 + lo1) / 2)
    out = Path(out)
    if out.exists():
        out.unlink()
    t0 = time.time()
    # ① 关系预扫描：候选多边形关系与它们的成员路；车站关系与它们的成员
    rel_members: dict[int, list[int]] = {}
    st_rels: dict[int, tuple[list[int], list[int]]] = {}       # 车站关系 → (成员路, 成员节点)
    ferry_rels: dict[int, list[int]] = {}                      # 轮渡航线关系 → 成员路
    skipped_nested = n_rel = n_members = 0
    for o in osmium.FileProcessor(str(src), osmium.osm.RELATION):
        n_rel += 1
        if n_rel % 100_000 == 0:
            lim.check(0, n_members, "关系预扫描")
        if _is_station(o.tags):
            members = list(o.members)
            st_rels[o.id] = ([m.ref for m in members if m.type == "w"], [m.ref for m in members if m.type == "n"])
            n_members += len(members)
            continue
        if _is_ferry_rel(o.tags):
            ferry_rels[o.id] = [m.ref for m in o.members if m.type == "w"]
            n_members += len(ferry_rels[o.id])
            continue
        if o.tags.get("type") != "multipolygon" or not _area_tags(o.tags):
            continue
        members = list(o.members)
        if any(m.type == "r" for m in members):
            skipped_nested += 1
            continue
        rel_members[o.id] = [m.ref for m in members if m.type == "w"]
        n_members += len(rel_members[o.id])
    member_ways = ({w for ws in rel_members.values() for w in ws} | {w for ws, _ in st_rels.values() for w in ws}
                   | {w for ws in ferry_rels.values() for w in ws})
    st_member_nodes = {n for _, ns in st_rels.values() for n in ns}
    lim.check(0, len(member_ways) + len(st_member_nodes), "关系预扫描")
    # ② 带坐标读：范围内节点；与框相交的路；成员路的相交情况与射线穿越次数
    inside: set[int] = set()
    kept_ways: set[int] = set()
    need_nodes: set[int] = set()
    member_hit: set[int] = set()
    member_cross: dict[int, int] = {}
    member_nodes: dict[int, list[int]] = {}
    n_seen = 0
    for o in osmium.FileProcessor(str(src), osmium.osm.NODE | osmium.osm.WAY).with_locations(location_storage):
        n_seen += 1
        if n_seen % 1_000_000 == 0:
            lim.check(n_seen, len(kept_ways) + len(need_nodes), "裁剪")
        if o.is_node():
            loc = o.location
            if loc.valid() and la0 <= loc.lat <= la1 and lo0 <= loc.lon <= lo1:
                inside.add(o.id)
            continue
        wanted, is_member = _way_wanted(o.tags), o.id in member_ways
        if not wanted and not is_member:
            continue
        coords = [(n.location.lat, n.location.lon) for n in o.nodes if n.location.valid()]
        if len(coords) < 2:
            continue
        refs = [n.ref for n in o.nodes]
        closed = refs[0] == refs[-1]
        hits, cross = _geom_hits(coords, bb, center, closed)
        if wanted and hits:
            kept_ways.add(o.id)
            need_nodes.update(refs)
        if is_member:
            member_cross[o.id] = cross
            member_nodes[o.id] = refs
            if hits:
                member_hit.add(o.id)
    lim.check(n_seen, len(kept_ways) + len(need_nodes), "裁剪")
    # 关系：任一成员相交，或成员合起来包住框（总穿越次数为奇数）
    rels: set[int] = set()
    rel_ways: set[int] = set()
    for rid, ws in rel_members.items():
        if any(w in member_hit for w in ws) or sum(member_cross.get(w, 0) for w in ws) % 2 == 1:
            rels.add(rid)
            for w in ws:
                if w in member_nodes:
                    rel_ways.add(w)
                    need_nodes.update(member_nodes[w])
    # 车站关系：任一成员节点在框内，或任一成员路与框相交
    for rid, (ws, ns) in st_rels.items():
        if any(n in inside for n in ns) or any(w in member_hit for w in ws):
            rels.add(rid)
            need_nodes.update(ns)
            for w in ws:
                if w in member_nodes:
                    rel_ways.add(w)
                    need_nodes.update(member_nodes[w])
    # 轮渡航线关系：任一成员路与框相交就保留关系与全部成员路
    for rid, ws in ferry_rels.items():
        if any(w in member_hit for w in ws):
            rels.add(rid)
            for w in ws:
                if w in member_nodes:
                    rel_ways.add(w)
                    need_nodes.update(member_nodes[w])
    del member_nodes, member_cross
    lim.check(n_seen, len(kept_ways) + len(rel_ways) + len(need_nodes), "裁剪")
    # ③ 写出
    n_nodes = n_ways = n_rels = 0
    with osmium.SimpleWriter(str(out)) as w:
        for o in osmium.FileProcessor(str(src)):
            if o.is_node():
                if o.id in need_nodes or (o.id in inside and _is_station(o.tags)):
                    w.add_node(o)
                    n_nodes += 1
            elif o.is_way():
                if o.id in kept_ways or o.id in rel_ways:
                    w.add_way(o)
                    n_ways += 1
            elif o.is_relation() and o.id in rels:
                w.add_relation(o)
                n_rels += 1
    return {"nodes": n_nodes, "ways": n_ways, "relations": n_rels, "skipped_nested_relations": skipped_nested,
            "source_objects": n_seen, "peak_rss_mb": round(lim.rss_mb()), "seconds": round(time.time() - t0, 1),
            "bytes": out.stat().st_size}


# ── 建库 ──────────────────────────────────────────────────────────────────────
def _flags_for_highway(hw: str, tags) -> int:
    f = 0
    access = tags.get("access")
    if hw not in MOTOR and access not in ("private", "no") and tags.get("foot") != "no":
        f |= 1
    if hw in MAJOR | MOTOR | MINOR or hw == "service":
        if access not in ("private", "no"):
            f |= 2
    if tags.get("tunnel") in ("yes", "building_passage") or tags.get("layer", "0").startswith("-"):
        f |= 4
    return f


CHECK_EVERY = 50_000            # 建库各循环每处理这么多项检查一次规模上限
STATION_WAY_BASE = 1 << 42      # 画成面/线的车站：车站表 id = 这个 + 路号
STATION_REL_BASE = 1 << 43      # 车站关系：车站表 id = 这个 + 关系号
FLAG_FERRY = 32


class _Builder(osmium.SimpleHandler if osmium else object):
    def __init__(self, conn: sqlite3.Connection, lim: "_Limits | None" = None, ferry_ways: set | None = None):
        super().__init__()
        self.c = conn
        self.lim = lim
        self.ferry_ways = ferry_ways or set()       # 轮渡航线关系的成员路号
        self.n_ferry = 0
        self.n_node = self.n_obj = 0
        self.n_way = self.n_area = self.n_sta = 0
        self.batch: list = []
        self.batch_rt: list = []

    def _flush(self, force=False):
        if len(self.batch) >= 20000 or (force and self.batch):
            self.c.executemany("INSERT OR REPLACE INTO way VALUES (?,?,?,?,?)", self.batch)
            self.c.executemany("INSERT OR REPLACE INTO way_rt VALUES (?,?,?,?,?)", self.batch_rt)
            self.batch.clear()
            self.batch_rt.clear()

    def _add(self, rid, cls, flags, name, pts_blob, bb):
        self.batch.append((rid, cls, flags, name, pts_blob))
        self.batch_rt.append((rid, bb[0], bb[1], bb[2], bb[3]))
        self._flush()

    def _check(self):
        if self.lim is not None:
            self.lim.check(self.n_node, self.n_way + self.n_area + self.n_sta, "建库")

    def _tick(self):
        """节点、路、面回调都计数，每 CHECK_EVERY 项查一次上限（路/面多的区域也不会等到最后才查）。"""
        self.n_obj += 1
        if self.n_obj % CHECK_EVERY == 0:
            self._check()

    def station(self, sid, name, name_en, la, lo):
        self.c.execute("INSERT OR REPLACE INTO station VALUES (?,?,?,?,?)", (sid, name, name_en, la, lo))
        self.c.execute("INSERT OR REPLACE INTO station_rt VALUES (?,?,?,?,?)", (sid, la, la, lo, lo))
        self.n_sta += 1

    def node(self, n):
        self.n_node += 1
        self._tick()
        t = n.tags
        if _is_station(t):
            if not n.location.valid():
                return
            self.station(n.id, t.get("name"), t.get("name:en"), n.location.lat, n.location.lon)

    def way(self, w):
        self._tick()
        t = w.tags
        if _is_station(t):                    # 画成面/线的车站：顶点平均当车站点
            pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
            if pts:
                self.station(STATION_WAY_BASE + w.id, t.get("name"), t.get("name:en"),
                             sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
        hw, rw, ww = t.get("highway"), t.get("railway"), t.get("waterway")
        cls = flags = None
        if hw and t.get("area") != "yes":
            if t.get("footway") == "sidewalk":
                cls = "tiny"      # 人行道不画（会把路画成三道），但要进步行路网
                flags = _flags_for_highway(hw, t) | 16
            elif hw in MAJOR:
                cls = "major"
            elif hw in MOTOR:
                cls = "motor"
            elif hw in MINOR:
                cls = "minor"
            elif hw in TINY:
                cls = "tiny"
            if cls and flags is None:
                flags = _flags_for_highway(hw, t)
        elif rw in RAIL and t.get("service") is None:
            cls = "rail"
            flags = 0
            if t.get("tunnel") == "yes" or rw == "subway":
                flags |= 4
            if rw == "subway":
                flags |= 8
        elif ww in ("river", "canal"):
            cls = "river"
            flags = 0
        elif t.get("route") == "ferry" or w.id in self.ferry_ways:
            cls = "ferry"
            flags = 1 | FLAG_FERRY            # 步行路网的特殊边：时间按坐船+等船算（render 里）
        if cls is None:
            return
        buf = bytearray()
        la0 = lo0 = 1e9
        la1 = lo1 = -1e9
        for nd in w.nodes:
            if not nd.location.valid():
                continue
            la, lo = nd.location.lat, nd.location.lon
            buf += PT.pack(nd.ref, round(la * 1e7), round(lo * 1e7))
            la0, la1, lo0, lo1 = min(la0, la), max(la1, la), min(lo0, lo), max(lo1, lo)
        if len(buf) < PT.size * 2:
            return
        self._add(w.id, cls, flags, t.get("name"), bytes(buf), (la0, la1, lo0, lo1))
        self.n_way += 1
        if cls == "ferry":
            self.n_ferry += 1

    def area(self, a):
        self._tick()
        t = a.tags
        if (t.get("natural") == "water" or t.get("waterway") == "riverbank"
                or t.get("landuse") in ("reservoir", "basin") or t.get("water")):
            cls = "water"
        elif (t.get("leisure") in PARK_LEISURE or t.get("landuse") in PARK_LANDUSE
              or t.get("natural") == "wood"):
            cls = "park"
        else:
            return
        buf = bytearray()
        la0 = lo0 = 1e9
        la1 = lo1 = -1e9
        try:
            for outer in a.outer_rings():
                for ring in [outer, *a.inner_rings(outer)]:
                    if buf:
                        buf += SEP
                    for nd in ring:
                        la, lo = nd.lat, nd.lon
                        buf += PT.pack(0, round(la * 1e7), round(lo * 1e7))
                        la0, la1, lo0, lo1 = min(la0, la), max(la1, la), min(lo0, lo), max(lo1, lo)
        except osmium.InvalidLocationError:
            return
        if len(buf) < PT.size * 3:
            return
        self._add(AREA_ID_BASE + a.id, cls, 0, t.get("name"), bytes(buf), (la0, la1, lo0, lo1))
        self.n_area += 1


def _station_relations(src, b: "_Builder", lim: "_Limits") -> None:
    """车站关系（railway=station / public_transport=station 的 relation）：成员节点与成员路顶点的平均点当车站点。
    成员里的关系不递归（只取节点与路）。"""
    rels: dict[int, tuple] = {}
    want_w: set[int] = set()
    want_n: set[int] = set()
    n_rel = 0
    for o in osmium.FileProcessor(str(src), osmium.osm.RELATION):
        n_rel += 1
        if n_rel % CHECK_EVERY == 0:
            lim.check(0, len(rels) + len(want_w) + len(want_n), "车站关系预扫描")
        if _is_station(o.tags):
            ws = [m.ref for m in o.members if m.type == "w"]
            ns = [m.ref for m in o.members if m.type == "n"]
            rels[o.id] = (o.tags.get("name"), o.tags.get("name:en"), ws, ns)
            want_w.update(ws)
            want_n.update(ns)
    if not rels:
        return
    lim.check(0, len(rels) + len(want_w) + len(want_n), "车站关系预扫描")
    loc_n: dict[int, tuple] = {}
    pts_w: dict[int, list] = {}
    n_seen = n_pts = 0
    for o in osmium.FileProcessor(str(src), osmium.osm.NODE | osmium.osm.WAY).with_locations():
        n_seen += 1
        if n_seen % CHECK_EVERY == 0:          # 坐标索引与成员顶点积累期间也查
            lim.check(n_seen, len(rels) + len(loc_n) + n_pts, "车站关系坐标")
        if o.is_node():
            if o.id in want_n and o.location.valid():
                loc_n[o.id] = (o.location.lat, o.location.lon)
        elif o.id in want_w:
            sl = so = 0.0
            k = 0
            for n in o.nodes:
                if n.location.valid():
                    sl += n.location.lat
                    so += n.location.lon
                    k += 1
            pts_w[o.id] = (sl, so, k)            # 只留和与个数：不展开顶点列表，内存与成员路数成正比
            n_pts += k                           # 计入已读的成员路顶点数（上限按对象数算）
    lim.check(n_seen, len(rels) + len(loc_n) + n_pts, "车站关系坐标")
    for i, (rid, (name, name_en, ws, ns)) in enumerate(rels.items(), 1):
        if i % CHECK_EVERY == 0:                # 汇总写车站期间也查
            lim.check(n_seen, len(rels) + len(loc_n) + n_pts, "车站关系汇总")
        sl = so = 0.0
        k = 0
        for n in ns:                            # 逐个累加，不建完整点列表
            if n in loc_n:
                sl += loc_n[n][0]
                so += loc_n[n][1]
                k += 1
        for w in ws:
            wl, wo, wk = pts_w.get(w, (0.0, 0.0, 0))
            sl += wl
            so += wo
            k += wk
        if k:
            b.station(STATION_REL_BASE + rid, name, name_en, sl / k, so / k)


def _ferry_member_ways(src) -> set[int]:
    """轮渡航线关系（type=route + route=ferry）的成员路号（成员路自己不一定带 route=ferry）。"""
    out: set[int] = set()
    for o in osmium.FileProcessor(str(src), osmium.osm.RELATION):
        if _is_ferry_rel(o.tags):
            out.update(m.ref for m in o.members if m.type == "w")
    return out


def build(src: str | Path, out: str | Path, *, bbox=None, buffer_m: float = 0, name: str | None = None,
          source: str | None = None, max_nodes: int = 0, max_kept: int = 0, max_memory_mb: int = 0) -> dict:
    """(裁剪后的) .osm.pbf → 底图库。先写 <out>.building，建完改名，中途失败不留半张库。
    max_nodes / max_kept / max_memory_mb 与 crop() 同义（0 = 不限），建库阶段也检查，超了 BuildError。"""
    _need_osmium()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(out) + ".building")
    if tmp.exists():
        tmp.unlink()
    c = sqlite3.connect(tmp)
    c.executescript("""
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
        CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE way(id INTEGER PRIMARY KEY, cls TEXT NOT NULL, flags INTEGER NOT NULL,
                         name TEXT, pts BLOB NOT NULL);
        CREATE VIRTUAL TABLE way_rt USING rtree(id, minlat, maxlat, minlon, maxlon);
        CREATE TABLE station(id INTEGER PRIMARY KEY, name TEXT, name_en TEXT, lat REAL, lon REAL);
        CREATE VIRTUAL TABLE station_rt USING rtree(id, minlat, maxlat, minlon, maxlon);
    """)
    t0 = time.time()
    lim = _Limits(max_nodes, max_kept, max_memory_mb)
    try:
        c.execute("BEGIN")
        b = _Builder(c, lim, _ferry_member_ways(src))
        b.apply_file(str(src), locations=True, idx="flex_mem")
        b._flush(force=True)
        b._check()
        _station_relations(src, b, lim)
        b._check()
    except BaseException:
        c.close()
        tmp.unlink(missing_ok=True)
        raise
    meta = {"name": name or out.stem, "source": source or Path(src).name, "built_at": str(int(time.time())),
            "attribution": ATTRIBUTION, "license": LICENSE, "license_note": LICENSE_NOTE, "format": FORMAT,
            "buffer_m": str(int(buffer_m))}
    if bbox:
        meta["bbox"] = ",".join(f"{x:.7f}" for x in bbox)
    c.executemany("INSERT INTO meta VALUES (?,?)", list(meta.items()))
    c.execute("COMMIT")
    c.execute("CREATE INDEX ix_station_name ON station(name)")
    c.execute("ANALYZE")
    c.close()
    os.replace(tmp, out)
    return {"ways": b.n_way, "areas": b.n_area, "stations": b.n_sta, "ferries": b.n_ferry,
            "seconds": round(time.time() - t0, 1),
            "bytes": out.stat().st_size, "out": str(out)}


def add_sea(shp: str | Path, db: str | Path) -> int:
    """往已建好的库里补海面（可重复跑：先删旧的海面行）。只取与库范围（含缓冲）相交的块。→ 块数。"""
    import shapefile   # pyshp
    c = sqlite3.connect(db)
    try:
        meta = {k: v for k, v in c.execute("SELECT k, v FROM meta")}
        if meta.get("bbox"):
            la0, la1, lo0, lo1 = buffered(tuple(float(x) for x in meta["bbox"].split(",")),
                                          float(meta.get("buffer_m") or 0))
        else:
            la0, la1, lo0, lo1 = c.execute("SELECT MIN(minlat), MAX(maxlat), MIN(minlon), MAX(maxlon)"
                                           " FROM way_rt WHERE id < ?", (SEA_ID_BASE,)).fetchone()
        c.execute("BEGIN")
        c.execute("DELETE FROM way_rt WHERE id >= ?", (SEA_ID_BASE,))
        c.execute("DELETE FROM way WHERE id >= ?", (SEA_ID_BASE,))
        r = shapefile.Reader(str(shp))
        n = 0
        for sr in r.iterShapes(bbox=[lo0, la0, lo1, la1]):     # 只解析与范围相交的块（按 .shp 头里的外接框筛）
            x0, y0, x1, y1 = sr.bbox
            if x1 < lo0 or x0 > lo1 or y1 < la0 or y0 > la1:
                continue
            buf = bytearray()
            parts = list(sr.parts) + [len(sr.points)]
            for a, b in zip(parts, parts[1:]):
                if buf:
                    buf += SEP
                for lo, la in sr.points[a:b]:
                    buf += PT.pack(0, round(la * 1e7), round(lo * 1e7))
            rid = SEA_ID_BASE + n
            c.execute("INSERT INTO way VALUES (?,?,?,?,?)", (rid, "water", 0, "sea", bytes(buf)))
            c.execute("INSERT INTO way_rt VALUES (?,?,?,?,?)", (rid, y0, y1, x0, x1))
            n += 1
        c.execute("INSERT OR REPLACE INTO meta VALUES ('sea', ?)", (Path(shp).name,))
        c.execute("COMMIT")
    finally:
        c.close()
    return n


def build_city(pbf: str | Path, out: str | Path, bb, *, buffer_m: float = DEFAULT_BUFFER_M,
               workdir: str | Path | None = None, sea_shp: str | Path | None = None, name: str | None = None,
               **limits) -> dict:
    """一条龙：裁剪（范围+缓冲）→ 建库 → 可选补海面。→ 各步统计。limits 透传给 crop()（max_nodes 等）。"""
    if buffer_m < 0:
        raise BuildError("缓冲带不能是负数（负缓冲会把覆盖范围里的数据裁掉）")
    pbf, out = Path(pbf), Path(out)
    workdir = Path(workdir) if workdir else out.parent
    workdir.mkdir(parents=True, exist_ok=True)
    cut = workdir / f"{out.stem}.crop.osm.pbf"
    t0 = time.time()
    limits = {"max_nodes": DEFAULT_MAX_NODES, "max_kept": DEFAULT_MAX_KEPT, "max_memory_mb": DEFAULT_MAX_MEMORY_MB,
              **limits}
    st_crop = crop(pbf, buffered(bb, buffer_m), cut, **limits)
    st_build = build(cut, out, bbox=bb, buffer_m=buffer_m, name=name or out.stem, source=pbf.name,
                     **{k: v for k, v in limits.items() if k in ("max_nodes", "max_kept", "max_memory_mb")})
    sea = add_sea(sea_shp, out) if sea_shp else None
    return {"crop": st_crop, "build": st_build, "sea_polygons": sea, "seconds": round(time.time() - t0, 1),
            "bytes": out.stat().st_size, "out": str(out), "attribution": ATTRIBUTION, "license": LICENSE}
