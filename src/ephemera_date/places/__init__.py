"""地点服务适配层：谷歌 / 高德 / OSM（Nominatim 或 Photon）同一接口。

公开接口（引擎 ports.py 直接按这套接口调用，默认接线 = make_provider()）
------------------------------------------------
数据类（base.py）::

    Place(title: str, lat: float, lng: float, address: str | None, kind: str | None, subtype: str | None,
          source: str, crs_original: str, original: tuple[float, float] | None,
          provider_id: str | None, raw_types: tuple[str, ...], crs_ambiguous: bool,
          long_term_store_ok: bool, long_term_fields: tuple[str, ...], coords_cache_max_days: int | None,
          must_display_on: str | None, fallback_from: str | None, fallback_code: str | None,
          region: str | None, region_source: str | None)
        # region = mainland/hk/mo/tw/out（None=国界附近不确定），region_source = adcode（高德回包）/ geometry
        # lat/lng 恒为 WGS-84。条款约束是数据（TERMS），引擎落库前据此拒绝/限制；本层不做产品决定（怎么存由引擎按 EPHEMERA_PLACES_STORE_POLICY 定）
        # .to_dict() = 完整（只在内存/一次请求内用）；.to_storable() = 按条款裁剪，长期落库只能用它
    PlaceList(list[Place]) .source .fallback_from .fallback_code .meta()   # 空结果也带 source
    WalkResult(minutes: int | None, meters: int | None, source: str,
               reason: str | None, reason_text: str | None, pts: tuple)   # minutes 为空时 reason 必有
    Capabilities(name, supports_autocomplete: bool, supports_walk: bool, may_cache: bool,
                 long_term_coords_ok: bool, attribution: str, terms_note: str)
    PlaceError(status: int, code: str, text: str, provider: str)        # code 见 base.PlaceError

协议（每家适配器都实现）::

    class PlaceProvider(Protocol):
        name: str
        def capabilities(self) -> Capabilities
        def search(self, q: str, near: tuple[float, float] | None = None, limit: int = 8) -> PlaceList
        def geocode(self, addr: str) -> PlaceList            # 0 或 1 个；找不到 = 空（带 source）；出错 = PlaceError
        def walk(self, origin: tuple[float, float], dest: tuple[float, float]) -> WalkResult

    点（near / origin / dest）可以是 (lat, lng)、(lat, lng, region) 或 Place；高德按 region 决定发出前换不换
    GCJ-02（coords.to_gcj_for_amap），region 未知才走几何判定。
    同步实现；引擎在异步上下文里用 asyncio.to_thread 调用。HTTP 传输层可注入（transport=），测试零真实调用。
    谷歌另有：details(place_id) -> PlaceList（按地点 ID 取坐标，坐标缓存过期后重新取用；FallbackProvider 只转主服务）。
    OSM 另有：search(..., bulk=True)、search_many()、nominatim.bulk_requests() 上下文（长时/定期任务用）。

工厂::

    make_provider(name: str | None = None, cfg: PlacesConfig | None = None, *, transport=None) -> PlaceProvider
        name 缺省取 EPHEMERA_PLACES_PROVIDER，再缺省 = config.DEFAULT_PROVIDER（"osm"）。
        主服务是 google / amap 且 EPHEMERA_PLACES_FALLBACK=osm（默认）时，主服务出 FALLBACK_ON 里的错误 → 用 OSM 兜底；
        结果（PlaceList 与每个 Place）带 fallback_from/fallback_code，并记 WARNING 日志。

站类别::

    kinds.classify_google(primary_type, types) / kinds.classify_amap(typecode) / kinds.classify_osm(cls, type)
        -> (大类代码 | None, 细类 | None)

坐标::

    coords.gcj02_to_wgs84(lat, lng) / coords.wgs84_to_gcj02(lat, lng) / coords.in_china(lat, lng)
    coords.to_wgs84(lat, lng, crs)      # 只有 crs="GCJ-02" 才换（防手填坐标重复换算）

页面约定：capabilities().supports_autocomplete 为 False 时，只能在用户点「搜索」时调用 search（不边输边搜）；
页面必须显示 capabilities().attribution。
"""
from __future__ import annotations

import logging
from dataclasses import replace

from .base import (CRS_GCJ02, CRS_WGS84, TERMS, Capabilities, HttpResponse, Place, PlaceError, PlaceList, PlaceProvider,
                   WalkResult)
from .config import DEFAULT_PROVIDER, PlacesConfig

log = logging.getLogger("ephemera_date.places")
PROVIDERS = ("google", "amap", "osm")
# 主服务的这些错误会转去兜底（配置/鉴权/配额/超时/连不上/5xx/回包看不懂）；
# 输入问题（empty / too_long / bad_query，即 4xx 里鉴权与配额以外的）不兜底
FALLBACK_ON = frozenset({"not_configured", "auth", "over_quota", "timeout", "unreachable", "upstream", "bad_reply"})


def _one(name: str, cfg: PlacesConfig, transport):
    if name == "google":
        from .google import GoogleProvider
        return GoogleProvider(cfg, transport=transport)
    if name == "amap":
        from .amap import AmapProvider
        return AmapProvider(cfg, transport=transport)
    if name in ("osm", "nominatim", "photon"):
        from .nominatim import NominatimProvider
        return NominatimProvider(cfg, transport=transport)
    raise ValueError(f"未知地点服务: {name}（可选 {', '.join(PROVIDERS)}）")


class FallbackProvider:
    """主服务 + 兜底服务。搜索/地址转坐标：主服务出可兜底的错误时改用兜底；步行不兜底（OSM 不算步行）。

    每次兜底都逐请求可见：返回的 PlaceList 带 fallback_from/fallback_code，里面每个 Place 也带；
    并记一行 WARNING 日志（logger "ephemera_date.places"）。不用共享状态，并发安全。
    """

    def __init__(self, primary, fallback):
        self.primary, self.fallback = primary, fallback
        self.name = primary.name

    def capabilities(self) -> Capabilities:
        p, f = self.primary.capabilities(), self.fallback.capabilities()
        return Capabilities(
            name=f"{p.name}+{f.name}",
            supports_autocomplete=p.supports_autocomplete and f.supports_autocomplete,
            supports_walk=p.supports_walk, may_cache=p.may_cache or f.may_cache,
            long_term_coords_ok=p.long_term_coords_ok and f.long_term_coords_ok,
            attribution=f"{p.attribution} / {f.attribution}", terms_note=f"{p.terms_note}\n{f.terms_note}")

    def _try(self, op: str, *a) -> PlaceList:
        try:
            return getattr(self.primary, op)(*a)
        except PlaceError as e:
            if e.code not in FALLBACK_ON:
                raise
            log.warning("[places] %s %s 失败（%s），改用 %s 兜底", self.primary.name, op, e.code, self.fallback.name)
            res = getattr(self.fallback, op)(*a)
            return PlaceList([replace(p, fallback_from=self.primary.name, fallback_code=e.code) for p in res],
                             source=res.source or self.fallback.name, fallback_from=self.primary.name,
                             fallback_code=e.code)

    def search(self, q, near=None, limit=8) -> PlaceList:
        return self._try("search", q, near, limit)

    def geocode(self, addr) -> PlaceList:
        return self._try("geocode", addr)

    def walk(self, origin, dest):
        return self.primary.walk(origin, dest)

    def __getattr__(self, attr):
        # 主服务独有的方法（例如谷歌的 details）只走主服务，不兜底：兜底回来的不是同一家的结果
        if attr in ("details",):
            return getattr(self.primary, attr)
        raise AttributeError(attr)


def make_provider(name: str | None = None, cfg: PlacesConfig | None = None, *, transport=None):
    cfg = cfg or PlacesConfig.from_env()
    name = (name or cfg.provider or DEFAULT_PROVIDER).strip().lower()
    primary = _one(name, cfg, transport)
    if cfg.fallback in ("osm", "nominatim", "photon") and name not in ("osm", "nominatim", "photon"):
        return FallbackProvider(primary, _one("osm", cfg, transport))
    return primary


__all__ = ["Place", "PlaceList", "WalkResult", "Capabilities", "PlaceError", "PlaceProvider", "PlacesConfig",
           "HttpResponse", "FallbackProvider", "make_provider", "PROVIDERS", "DEFAULT_PROVIDER", "CRS_WGS84", "CRS_GCJ02",
           "TERMS", "FALLBACK_ON"]
