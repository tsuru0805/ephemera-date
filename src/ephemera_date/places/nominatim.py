"""OSM 地点搜索（Nominatim，端点可配；也可换 Photon）。免费，但必须遵守公共服务的使用政策：

政策 https://operations.osmfoundation.org/policies/nominatim/ ，本适配层的落实：
- 不做边输边搜：capabilities().supports_autocomplete = False，页面只在用户点「搜索」时调用；
- 全应用每秒最多 1 次：ratelimit.default_limiter() 按主机限速并排队，锁文件在数据目录下，跨进程成立
  （同一时刻全机最多一个请求在途）；
- 自定义 User-Agent：EPHEMERA_NOMINATIM_UA（默认值能识别出本应用，建议改成自己的实例名+联系方式）；
- 本地缓存同一查询：cache.QueryCache（SQLite，默认 <数据目录>/places_cache.sqlite），命中不发请求；
  拿到限速锁后再查一次缓存（并发的同一查询只外发一次）；
- 批量查询单线程排队，长时/定期任务每分钟最多 4 次：调用级参数 bulk=True、search_many()，或在
  `with bulk_requests():` 里调用（contextvars，按线程/协程隔离，并发安全；经兜底包装器调用也生效）；
- 署名：ATTRIBUTION，页面必须显示。
量大时请自建 Nominatim（https://nominatim.org/release-docs/latest/admin/Installation/）
或 Photon（https://github.com/komoot/photon），把 EPHEMERA_NOMINATIM_URL 指过去。

响应格式：
- Nominatim search jsonv2 https://nominatim.org/release-docs/latest/api/Search/ 、
  https://nominatim.org/release-docs/latest/api/Output/
- Photon https://github.com/komoot/photon#search-api （GeoJSON FeatureCollection）
"""
from __future__ import annotations

import contextvars
from contextlib import contextmanager

from . import coords, kinds
from .base import (CRS_WGS84, MAX_ITEMS, TERMS, Capabilities, HttpResponse, Place, PlaceError, PlaceList, Transport,
                   WalkResult, bad_reply, call, check_point, clean_query, classify_http, parse_json,
                   urllib_transport)
from .cache import QueryCache
from .config import PUBLIC_NOMINATIM, PlacesConfig, default_data_dir
from .ratelimit import FileLimiter, default_limiter

_BULK: contextvars.ContextVar[bool] = contextvars.ContextVar("ephemera_osm_bulk", default=False)


@contextmanager
def bulk_requests():
    """这段里发出的 OSM 查询都按批量规则限速（每分钟最多 4 次）。长时/定期任务（例如 AI 的定时整理）用。"""
    token = _BULK.set(True)
    try:
        yield
    finally:
        _BULK.reset(token)

NAME = "osm"
ATTRIBUTION = "© OpenStreetMap contributors（ODbL 1.0，https://www.openstreetmap.org/copyright）"
NEAR_BOX_DEG = 0.05      # near 框半边（纬度约 5.5 公里）：给了 near 就只搜这个框里


class NominatimProvider:
    name = NAME

    def __init__(self, cfg: PlacesConfig | None = None, *, transport: Transport | None = None,
                 limiter: FileLimiter | None = None, cache: QueryCache | None = None, bulk: bool = False):
        self.cfg = cfg or PlacesConfig.from_env()
        self.base = (self.cfg.nominatim_url or PUBLIC_NOMINATIM).rstrip("/")
        self.flavor = self.cfg.osm_flavor if self.cfg.osm_flavor in ("nominatim", "photon") else "nominatim"
        self.transport = transport or urllib_transport
        self.limiter = limiter or default_limiter()
        if cache is None:
            path = self.cfg.cache_path or default_data_dir() / "places_cache.sqlite"
            cache = QueryCache(path, ttl_s=self.cfg.osm_cache_days * 86400)
        self.cache = cache
        self.default_bulk = bool(bulk)          # 构造时定死（例如专给定时任务用的实例），之后不改
        self.requests_sent = 0

    def capabilities(self) -> Capabilities:
        return Capabilities(
            name=NAME, supports_autocomplete=False, supports_walk=False, may_cache=True,
            long_term_coords_ok=True, attribution=ATTRIBUTION,
            terms_note=("OSM 数据可存可画，条件是署名；公共 Nominatim 全应用每秒最多一次、不许边输边搜、"
                        "批量任务单线程单机器、长时任务每分钟最多 4 次。量大请自建 Nominatim 或 Photon。"))

    # ── 公开接口 ────────────────────────────────────────────────────────────────
    def search(self, q: str, near: tuple[float, float] | None = None, limit: int = MAX_ITEMS, *,
               bulk: bool = False) -> PlaceList:
        q = clean_query(q, NAME)
        near = check_point(near, "附近位置", NAME) if near is not None else None
        limit = max(1, min(int(limit), MAX_ITEMS))
        rows = self._query(q, near, limit, bulk)
        return PlaceList([p for p in (self._place(r) for r in rows) if p][:limit], source=NAME)

    def geocode(self, addr: str, *, bulk: bool = False) -> PlaceList:
        addr = clean_query(addr, NAME)
        for r in self._query(addr, None, 1, bulk):
            p = self._place(r)
            if p:
                return PlaceList([p], source=NAME)
        return PlaceList(source=NAME)

    def bbox(self, name: str) -> tuple[float, float, float, float] | None:
        """地名 → 范围 (minlat, maxlat, minlon, maxlon)。建底图脚本用（一次调用，走缓存）。"""
        name = clean_query(name, NAME)
        for r in self._query(name, None, 1, False):
            bb = _row_bbox(r)
            if bb:
                return bb
        return None

    def search_many(self, queries: list[str], near: tuple[float, float] | None = None) -> list[PlaceList]:
        """批量查询：单线程顺序发，按批量规则限速（缓存命中不占次数）。"""
        return [self.search(q, near, bulk=True) for q in queries]

    def walk(self, origin, dest) -> WalkResult:
        return WalkResult(None, None, NAME, "unsupported", "OSM 地点服务不算步行；步行时间用本地路网（ephemera_date.maps）")

    # ── 内部 ────────────────────────────────────────────────────────────────────
    def _query(self, q: str, near, limit: int, bulk: bool) -> list[dict]:
        bulk = bulk or self.default_bulk or _BULK.get()
        near = (round(near[0], 3), round(near[1], 3)) if near else None    # 约 100 米内的 near 视为同一查询
        url, params = self._request(q, near, limit)
        # 缓存键 = 真实请求：端点 + 全部参数原值（不改大小写）+ 语言头
        key = QueryCache.key(NAME, url, sorted((k, str(v)) for k, v in params.items()), self.cfg.lang)
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        headers = {"User-Agent": self.cfg.user_agent or "", "Accept": "application/json"}
        if self.flavor == "nominatim" and self.cfg.lang:
            headers["Accept-Language"] = self.cfg.lang
        if not headers["User-Agent"].strip():
            raise PlaceError(503, "not_configured", "OSM 地点搜索需要设置 User-Agent（EPHEMERA_NOMINATIM_UA）", NAME)
        with self.limiter.slot(self.base, bulk=bulk) as ticket:
            hit = self.cache.get(key)            # 排队期间别的线程/进程可能已经查过同一个
            if hit is not None:
                return hit
            ticket.wait()
            r = call(self.transport, NAME, "GET", url, params=params, headers=headers)
            self.requests_sent += 1
            rows = self._parse(r)
            self.cache.put(key, rows)            # 锁内写缓存，后面排队的同一查询直接命中
        return rows

    def _request(self, q: str, near, limit: int) -> tuple[str, dict]:
        if self.flavor == "photon":
            params: dict = {"q": q, "limit": limit}
            lang = (self.cfg.lang or "")[:2].lower()
            if lang in ("en", "de", "fr", "it"):        # 公共 Photon 只认这几种，别的不传（默认=当地语言）
                params["lang"] = lang
            if near:
                params["lat"], params["lon"] = f"{near[0]:.5f}", f"{near[1]:.5f}"
            return f"{self.base}/api", params
        params = {"q": q, "format": "jsonv2", "limit": limit}
        if self.cfg.email:
            params["email"] = self.cfg.email
        if near:
            la, lo = near
            params["viewbox"] = f"{lo - NEAR_BOX_DEG:.5f},{la + NEAR_BOX_DEG:.5f},{lo + NEAR_BOX_DEG:.5f},{la - NEAR_BOX_DEG:.5f}"
            params["bounded"] = 1      # 只偏置（bounded=0）时笼统词会搜到全世界，实测；改成限定在附近框内
        return f"{self.base}/search", params

    def _parse(self, r: HttpResponse) -> list[dict]:
        if r.status == 403:
            raise PlaceError(502, "auth", "公共 Nominatim 拒绝了请求（多半是 User-Agent 不合规或用量超了政策），"
                                          "请设置 EPHEMERA_NOMINATIM_UA 或自建服务", NAME)
        if r.status != 200:
            raise classify_http(r.status, NAME, "OSM 地点搜索")
        j = parse_json(r, NAME)
        if self.flavor == "photon":
            if not isinstance(j, dict) or not isinstance(j.get("features"), list):
                raise bad_reply(NAME)
            return [_photon_row(f) for f in j["features"] if isinstance(f, dict)]
        if isinstance(j, dict) and j.get("error"):
            raise PlaceError(502, "upstream", "OSM 地点搜索出错了，稍后再试，或者先手写地址", NAME)
        if not isinstance(j, list) or not all(isinstance(x, dict) for x in j):
            raise bad_reply(NAME)
        return j

    @staticmethod
    def _place(r: dict) -> Place | None:
        try:
            lat, lng = float(r["lat"]), float(r["lon"])
        except (KeyError, TypeError, ValueError):
            return None
        cls = r.get("category") or r.get("class") or ""
        typ = r.get("type") or ""
        disp = str(r.get("display_name") or "")
        title = str(r.get("name") or "").strip() or disp.split(",")[0].strip()
        if not title:
            return None
        kind, sub = kinds.classify_osm(cls, typ)
        ot, oid = str(r.get("osm_type") or ""), r.get("osm_id")
        pid = f"{ot[:1].upper()}{oid}" if ot and oid is not None else None
        return Place(title=title[:80], lat=lat, lng=lng, address=disp[:200] or None, kind=kind, subtype=sub,
                     source=NAME, crs_original=CRS_WGS84, original=(lat, lng), provider_id=pid,
                     raw_types=(f"{cls}={typ}",) if cls else (), region=coords.geo_region(lat, lng),
                     region_source="geometry", **TERMS[NAME])


def _row_bbox(r: dict):
    bb = r.get("boundingbox")
    try:
        if bb and len(bb) == 4:
            a, b, c, d = (float(x) for x in bb)       # Nominatim: [minlat, maxlat, minlon, maxlon]
            return a, b, c, d
    except (TypeError, ValueError):
        return None
    return None


def _photon_row(f: dict) -> dict:
    """Photon 的 GeoJSON feature 转成 Nominatim 行的形状（后面同一套解析）。"""
    pr = f.get("properties") or {}
    coords = (f.get("geometry") or {}).get("coordinates") or [None, None]
    parts = [pr.get(k) for k in ("name", "street", "housenumber", "district", "city", "state", "country")]
    row = {"lat": coords[1], "lon": coords[0], "name": pr.get("name") or "",
           "display_name": ", ".join(str(x) for x in parts if x),
           "category": pr.get("osm_key") or "", "type": pr.get("osm_value") or "",
           "osm_type": {"N": "node", "W": "way", "R": "relation"}.get(str(pr.get("osm_type") or ""), ""),
           "osm_id": pr.get("osm_id")}
    ext = pr.get("extent")              # Photon: [minlon, maxlat, maxlon, minlat]
    if isinstance(ext, list) and len(ext) == 4:
        row["boundingbox"] = [ext[3], ext[1], ext[0], ext[2]]
    return row

