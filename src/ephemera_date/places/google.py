"""谷歌地点服务：Places API (New) 文本搜索 + Geocoding API；可选 Routes API 步行。

每次调用都按谷歌计费（使用者自己的钥匙 EPHEMERA_GOOGLE_MAPS_KEY）。适配层不缓存结果。

条款：Places 结果显示在地图上时须是 Google 地图；内容不许预取/缓存/存储，例外是地点 ID 可长期存、
经纬度最多临时缓存 30 个连续日历日（Google Maps Platform 服务专用条款）。把坐标长期存进约会并画在 OSM 底图上，
在通用条款下未另获授权时不允许——由使用者自行确认或另获授权。

请求/响应格式：
- Text Search (New) https://developers.google.com/maps/documentation/places/web-service/text-search
  POST https://places.googleapis.com/v1/places:searchText ，X-Goog-FieldMask 决定计费档（这里只取 Pro 档字段）
- Geocoding https://developers.google.com/maps/documentation/geocoding/requests-geocoding
  GET https://maps.googleapis.com/maps/api/geocode/json
- Place Details (New) https://developers.google.com/maps/documentation/places/web-service/place-details
  GET https://places.googleapis.com/v1/places/{PLACE_ID} ，X-Goog-FieldMask: id,location（只取坐标：坐标缓存过期后
  按条款允许长期存的地点 ID 重新取，不按地址重新搜）
- Routes computeRoutes https://developers.google.com/maps/documentation/routes/compute_route_directions
  POST https://routes.googleapis.com/directions/v2:computeRoutes
"""
from __future__ import annotations

from . import coords, kinds
from .base import (CRS_WGS84, MAX_ITEMS, TERMS, Capabilities, HttpResponse, Place, PlaceError, PlaceList, Transport,
                   WalkResult, bad_reply, call, check_point, clean_query, classify_http, parse_json, urllib_transport)
from .config import PlacesConfig

NAME = "google"
PLACES_TEXT = "https://places.googleapis.com/v1/places:searchText"
GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json"
ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes"
PLACE_DETAILS = "https://places.googleapis.com/v1/places/"
DETAILS_FIELDS = "id,location"
FIELDS = ("places.id,places.displayName,places.formattedAddress,places.location,"
          "places.primaryType,places.types")
NEAR_RADIUS_M = 3000.0
ATTRIBUTION = "Google"


class GoogleProvider:
    name = NAME

    def __init__(self, cfg: PlacesConfig | None = None, *, transport: Transport | None = None):
        self.cfg = cfg or PlacesConfig.from_env()
        self.transport = transport or urllib_transport

    def capabilities(self) -> Capabilities:
        return Capabilities(
            name=NAME, supports_autocomplete=True, supports_walk=True, may_cache=False,
            long_term_coords_ok=False, attribution=ATTRIBUTION,
            terms_note=("谷歌条款：内容不许缓存/存储（地点 ID 可长期存，经纬度最多临时缓存 30 天），"
                        "Places 结果显示在地图上时须是 Google 地图。存坐标并画在 OSM 底图上需使用者自行确认或另获授权。"
                        "每次调用按谷歌计费。"))

    def _key(self) -> str:
        if not self.cfg.google_key:
            raise PlaceError(503, "not_configured", "谷歌地点搜索没有配置钥匙（EPHEMERA_GOOGLE_MAPS_KEY），可以先手写地址",
                             NAME)
        return self.cfg.google_key

    def search(self, q: str, near: tuple[float, float] | None = None, limit: int = MAX_ITEMS) -> PlaceList:
        q = clean_query(q, NAME)
        near = check_point(near, "附近位置", NAME) if near is not None else None
        limit = max(1, min(int(limit), MAX_ITEMS))
        body: dict = {"textQuery": q, "languageCode": self.cfg.lang, "pageSize": limit}
        if self.cfg.google_region:
            body["regionCode"] = self.cfg.google_region.upper()
        if near:
            body["locationBias"] = {"circle": {"center": {"latitude": near[0], "longitude": near[1]},
                                               "radius": NEAR_RADIUS_M}}
        hdr = {"X-Goog-Api-Key": self._key(), "X-Goog-FieldMask": FIELDS}
        r = call(self.transport, NAME, "POST", PLACES_TEXT, headers=hdr, json_body=body)
        _check_new_api(r)
        j = parse_json(r, NAME)
        # 零结果时官方回 {}；其它形状（列表、places 不是列表）= 看不懂
        if not isinstance(j, dict) or not isinstance(j.get("places", []), list):
            raise bad_reply(NAME)
        out = PlaceList(source=NAME)
        for p in j.get("places", []):
            if not isinstance(p, dict):
                raise bad_reply(NAME)
            loc = p.get("location") or {}
            try:
                lat, lng = float(loc["latitude"]), float(loc["longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            title = str((p.get("displayName") or {}).get("text") or "").strip()
            if not title:
                continue
            types = tuple(t for t in (p.get("types") or []) if isinstance(t, str))
            kind, sub = kinds.classify_google(p.get("primaryType"), types)
            raw = tuple(dict.fromkeys(([p["primaryType"]] if p.get("primaryType") else []) + list(types)))
            out.append(Place(title=title[:80], lat=lat, lng=lng, address=(p.get("formattedAddress") or None),
                             kind=kind, subtype=sub, source=NAME, crs_original=CRS_WGS84, original=(lat, lng),
                             provider_id=p.get("id"), raw_types=raw, region=coords.geo_region(lat, lng),
                             region_source="geometry", **TERMS[NAME]))
        del out[limit:]
        return out

    def geocode(self, addr: str) -> PlaceList:
        addr = clean_query(addr, NAME)
        params = {"address": addr, "language": self.cfg.lang, "key": self._key()}
        if self.cfg.google_region:
            params["region"] = self.cfg.google_region.lower()
        r = call(self.transport, NAME, "GET", GEOCODE, params=params)
        if r.status != 200:
            raise classify_http(r.status, NAME, "谷歌地址转坐标")
        j = parse_json(r, NAME)
        if not isinstance(j, dict) or not isinstance(j.get("results", []), list):
            raise bad_reply(NAME)
        st = j.get("status")
        if st == "ZERO_RESULTS":
            return PlaceList(source=NAME)
        if st == "REQUEST_DENIED":
            raise PlaceError(502, "auth", "谷歌拒绝了请求：钥匙不对或没开 Geocoding API", NAME)
        if st in ("OVER_QUERY_LIMIT", "OVER_DAILY_LIMIT"):
            raise PlaceError(429, "over_quota", "谷歌查询次数超了配额，稍后再试，或者先手写地址", NAME)
        if st == "INVALID_REQUEST":
            raise PlaceError(400, "bad_query", "这个地址查不了，换个写法试试", NAME)
        if st != "OK" or not j.get("results"):
            raise PlaceError(502, "upstream", "谷歌地址转坐标出错了，稍后再试", NAME)
        r0 = j["results"][0]
        loc = ((r0 or {}).get("geometry") or {}).get("location") or {}
        try:
            lat, lng = float(loc["lat"]), float(loc["lng"])
        except (KeyError, TypeError, ValueError):
            raise bad_reply(NAME) from None
        types = tuple(t for t in (r0.get("types") or []) if isinstance(t, str))
        kind, sub = kinds.classify_google(None, types)
        title = str(r0.get("formatted_address") or addr)
        return PlaceList([Place(title=title[:80], lat=lat, lng=lng, address=r0.get("formatted_address") or None,
                                kind=kind, subtype=sub, source=NAME, crs_original=CRS_WGS84, original=(lat, lng),
                                provider_id=r0.get("place_id"), raw_types=types, region=coords.geo_region(lat, lng),
                                region_source="geometry", **TERMS[NAME])], source=NAME)

    def details(self, place_id: str) -> PlaceList:
        """按地点 ID 取坐标（Place Details (New)，字段只要 id,location）。0 或 1 个；ID 失效 = 空（带 source）。"""
        pid = str(place_id or "").strip()
        if not pid or len(pid) > 200 or not all(c.isalnum() or c in "-_" for c in pid):
            raise PlaceError(400, "bad_query", "谷歌地点 ID 不对", NAME)
        hdr = {"X-Goog-Api-Key": self._key(), "X-Goog-FieldMask": DETAILS_FIELDS}
        r = call(self.transport, NAME, "GET", PLACE_DETAILS + pid, headers=hdr)
        if r.status == 404:
            return PlaceList(source=NAME)
        _check_new_api(r)
        j = parse_json(r, NAME)
        loc = (j.get("location") if isinstance(j, dict) else None) or {}
        try:
            lat, lng = float(loc["latitude"]), float(loc["longitude"])
        except (KeyError, TypeError, ValueError):
            raise bad_reply(NAME) from None
        return PlaceList([Place(title=pid, lat=lat, lng=lng, source=NAME, crs_original=CRS_WGS84, original=(lat, lng),
                                provider_id=j.get("id") or pid, region=coords.geo_region(lat, lng),
                                region_source="geometry", **TERMS[NAME])], source=NAME)

    def walk(self, origin, dest) -> WalkResult:
        o, d = check_point(origin, "起点", NAME), check_point(dest, "终点", NAME)
        body = {"origin": {"location": {"latLng": {"latitude": o[0], "longitude": o[1]}}},
                "destination": {"location": {"latLng": {"latitude": d[0], "longitude": d[1]}}},
                "travelMode": "WALK", "languageCode": self.cfg.lang}
        hdr = {"X-Goog-Api-Key": self._key(), "X-Goog-FieldMask": "routes.duration,routes.distanceMeters"}
        r = call(self.transport, NAME, "POST", ROUTES, headers=hdr, json_body=body)
        _check_new_api(r)
        j = parse_json(r, NAME)
        if not isinstance(j, dict) or not isinstance(j.get("routes", []), list):
            raise bad_reply(NAME)
        routes = j.get("routes") or []
        if not routes:
            return WalkResult(None, None, NAME, "no_route", "谷歌没算出这两点之间的步行路线")
        r0 = routes[0]
        try:
            sec = float(str(r0.get("duration") or "0s").rstrip("s"))
            meters = int(r0.get("distanceMeters") or 0)
        except ValueError:
            raise PlaceError(502, "bad_reply", "地点服务回的数据看不懂", NAME) from None
        return WalkResult(max(1, round(sec / 60)), meters, NAME)


def _check_new_api(r: HttpResponse) -> None:
    """Places (New) / Routes 的错误：HTTP 状态码 + {"error": {"status": ...}}。"""
    if r.status != 200:
        raise classify_http(r.status, NAME, "谷歌地点服务")
