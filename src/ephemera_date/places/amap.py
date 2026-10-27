"""高德地点服务：Web 服务 POI 搜索 2.0（v5）+ 地理编码（v3）；可选步行路线规划 2.0（v5）。

坐标：高德境内返回 GCJ-02。本适配层在边界处换成 WGS-84 再交出去，结果带 crs_original="GCJ-02" 与原坐标。
换不换先看回包 adcode（大陆码=换，港澳台码=默认不换），没有 adcode 才用几何判定（境外不换、国界附近 ambiguous
不换并标 crs_ambiguous），见 normalize()。调用高德步行路线时，把 WGS-84 输入反向换回 GCJ-02。

条款：高德服务协议 3.5 不得直接存储、缓存本服务内部数据；4.12.4 不能脱离本服务单独使用或展示相关内容。
适配层不缓存结果；把坐标长期存进约会并画在 OSM 底图上，在通用条款下未另获授权时不允许——由使用者自行确认或另获授权。

请求/响应格式：
- 搜索 POI 2.0 https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch
  GET https://restapi.amap.com/v5/place/text （关键字）/ v5/place/around （周边，location=经度,纬度）
- 地理编码 https://lbs.amap.com/api/webservice/guide/api/georegeo  GET https://restapi.amap.com/v3/geocode/geo
- 步行 2.0 https://lbs.amap.com/api/webservice/guide/api/newroute  GET https://restapi.amap.com/v5/direction/walking
- 错误码 https://lbs.amap.com/api/webservice/guide/tools/info
"""
from __future__ import annotations

from . import coords, kinds
from .base import (CRS_GCJ02, CRS_WGS84, MAX_ITEMS, TERMS, Capabilities, HttpResponse, Place, PlaceError, PlaceList,
                   Transport, WalkResult, bad_reply, call, check_point, check_region, clean_query, classify_http,
                   parse_json, urllib_transport)
from .config import PlacesConfig

NAME = "amap"
TEXT = "https://restapi.amap.com/v5/place/text"
AROUND = "https://restapi.amap.com/v5/place/around"
GEO = "https://restapi.amap.com/v3/geocode/geo"
WALK = "https://restapi.amap.com/v5/direction/walking"
NEAR_RADIUS_M = 5000
ATTRIBUTION = "高德地图"

# 错误码（infocode）按官方错误码表归类
_AUTH = {"10001", "10002", "10005", "10006", "10007", "10008", "10009", "10012", "10013", "10026", "10041",
         "20011"}                                  # 20011=查询点在海外但钥匙没有海外权限
_QUOTA = {"10003", "10004", "10010", "10014", "10019", "10020", "10021", "10029", "10044", "10045"}
_PARAM = {"20000", "20001", "20002", "20012"}


class AmapProvider:
    name = NAME

    def __init__(self, cfg: PlacesConfig | None = None, *, transport: Transport | None = None):
        self.cfg = cfg or PlacesConfig.from_env()
        self.transport = transport or urllib_transport

    def capabilities(self) -> Capabilities:
        return Capabilities(
            name=NAME, supports_autocomplete=True, supports_walk=True, may_cache=False,
            long_term_coords_ok=False, attribution=ATTRIBUTION,
            terms_note=("高德服务协议：不得存储、缓存服务内部数据，不能脱离高德服务单独展示相关内容。"
                        "存坐标并画在 OSM 底图上需使用者自行确认或另获授权（协议里有提交工单咨询合作的路径）。"))

    def _key(self) -> str:
        if not self.cfg.amap_key:
            raise PlaceError(503, "not_configured", "高德地点搜索没有配置钥匙（EPHEMERA_AMAP_KEY），可以先手写地址", NAME)
        return self.cfg.amap_key

    def _get(self, url: str, params: dict) -> dict:
        params = {**params, "key": self._key(), "output": "json"}
        r = call(self.transport, NAME, "GET", url, params=params)
        return _check(r)

    def search(self, q: str, near: tuple[float, float] | None = None, limit: int = MAX_ITEMS) -> PlaceList:
        q = clean_query(q, NAME)
        near_region = check_region(near, "附近位置", NAME) if near is not None else None
        near = check_point(near, "附近位置", NAME) if near is not None else None
        limit = max(1, min(int(limit), MAX_ITEMS))
        params: dict = {"keywords": q, "page_size": limit, "page_num": 1}
        if near:
            glat, glng, _ = coords.to_gcj_for_amap(*near, near_region)   # 送进高德前换回 GCJ-02（按地区）
            params.update(location=_fmt(glat, glng), radius=NEAR_RADIUS_M, sortrule="distance")
            j = self._get(AROUND, params)
        else:
            if self.cfg.amap_city:
                params["region"] = self.cfg.amap_city
            j = self._get(TEXT, params)
        pois = j.get("pois", [])
        if not isinstance(pois, list):
            raise bad_reply(NAME)
        out = PlaceList(source=NAME)
        for p in pois:
            if not isinstance(p, dict):
                raise bad_reply(NAME)
            pl = self._place(p)
            if pl:
                out.append(pl)
        del out[limit:]
        return out

    def geocode(self, addr: str) -> PlaceList:
        addr = clean_query(addr, NAME)
        params = {"address": addr}
        if self.cfg.amap_city:
            params["city"] = self.cfg.amap_city
        j = self._get(GEO, params)
        geos = j.get("geocodes", [])
        if not isinstance(geos, list):
            raise bad_reply(NAME)
        for g in geos:
            pt = _parse_loc(g.get("location")) if isinstance(g, dict) else None
            if not pt:
                continue
            lat, lng, crs, amb, reg, rsrc = normalize(*pt, _s(g.get("adcode")))
            fa = _s(g.get("formatted_address")) or addr
            return PlaceList([Place(title=fa[:80], lat=lat, lng=lng, address=fa or None, source=NAME,
                                    crs_original=crs, original=pt, crs_ambiguous=amb, region=reg,
                                    region_source=rsrc,
                                    raw_types=(f"level={_s(g.get('level'))}",) if _s(g.get("level")) else (),
                                    **TERMS[NAME])], source=NAME)
        return PlaceList(source=NAME)

    def walk(self, origin, dest) -> WalkResult:
        o, d = check_point(origin, "起点", NAME), check_point(dest, "终点", NAME)
        ro, rd = check_region(origin, "起点", NAME), check_region(dest, "终点", NAME)
        go, gd = coords.to_gcj_for_amap(*o, ro)[:2], coords.to_gcj_for_amap(*d, rd)[:2]   # 按地区换回 GCJ-02
        j = self._get(WALK, {"origin": _fmt(*go), "destination": _fmt(*gd), "show_fields": "cost"})
        route = j.get("route") or {}
        paths = route.get("paths", []) if isinstance(route, dict) else None
        if not isinstance(paths, list):
            raise bad_reply(NAME)
        if not paths:
            return WalkResult(None, None, NAME, "no_route", "高德没算出这两点之间的步行路线")
        p0 = paths[0]
        try:
            meters = int(float(p0.get("distance") or 0))
            dur = (p0.get("cost") or {}).get("duration")
            sec = float(dur) if dur not in (None, "", []) else None
        except (TypeError, ValueError):
            raise PlaceError(502, "bad_reply", "地点服务回的数据看不懂", NAME) from None
        if sec is None:
            return WalkResult(None, meters, NAME, "no_duration", "高德没给步行耗时")
        return WalkResult(max(1, round(sec / 60)), meters, NAME)

    def _place(self, p: dict) -> Place | None:
        pt = _parse_loc(p.get("location"))
        title = _s(p.get("name"))
        if not pt or not title:
            return None
        lat, lng, crs, amb, reg, rsrc = normalize(*pt, _s(p.get("adcode")))
        kind, sub = kinds.classify_amap(_s(p.get("typecode")))
        addr = "".join(x for x in (_s(p.get("pname")), _s(p.get("cityname")), _s(p.get("adname")),
                                   _s(p.get("address"))) if x)
        return Place(title=title[:80], lat=lat, lng=lng, address=addr or None, kind=kind, subtype=sub,
                     source=NAME, crs_original=crs, original=pt, provider_id=_s(p.get("id")) or None,
                     raw_types=tuple(x for x in _s(p.get("typecode")).split("|") if x), crs_ambiguous=amb,
                     region=reg, region_source=rsrc, **TERMS[NAME])


def normalize(lat: float, lng: float, adcode=None) -> tuple[float, float, str, bool, str | None, str | None]:
    """高德原始坐标 → (WGS-84 纬度, 经度, 原坐标系, 不确定, 地区, 地区来源)。

    先看回包里的 adcode（行政区划码；POI 2.0 的 pois[].adcode「poi 所属区域编码」，默认返回，
    https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch ；地理编码的 geocodes[].adcode「区域编码」，
    https://lbs.amap.com/api/webservice/guide/api/georegeo ）：
    - 大陆码（前两位为大陆省级代码）→ 确定是 GCJ-02，直接按公式换算，覆盖几何判定（含国界附近的 ambiguous）；
    - 港澳台码（71/81/82）→ 按 EPHEMERA_GCJ_REGIONS 是否选中，默认不换；
    - 没有 adcode / 格式不对 / 境外码 → 回落到几何判定（coords.gcj02_to_wgs84_checked）。"""
    reg = coords.adcode_region(adcode)
    if reg is not None:
        if coords.region_uses_gcj(reg):
            wl, wg = coords.gcj02_to_wgs84_formula(lat, lng)
            return wl, wg, CRS_GCJ02, False, reg, "adcode"
        return lat, lng, CRS_WGS84, False, reg, "adcode"
    wl, wg, changed, amb = coords.gcj02_to_wgs84_checked(lat, lng)
    return wl, wg, (CRS_GCJ02 if changed else CRS_WGS84), amb, (None if amb else coords.geo_region(wl, wg)), "geometry"


def _s(v) -> str:
    """高德空字段有时给 [] 而不是 ""。"""
    if v is None or isinstance(v, (list, dict)):
        return ""
    return str(v).strip()


def _fmt(lat: float, lng: float) -> str:
    return f"{lng:.6f},{lat:.6f}"


def _parse_loc(s) -> tuple[float, float] | None:
    """高德 "经度,纬度" → (纬度, 经度)。"""
    try:
        lng, lat = (float(x) for x in _s(s).split(","))
    except ValueError:
        return None
    return lat, lng


def _check(r: HttpResponse) -> dict:
    if r.status != 200:
        raise classify_http(r.status, NAME, "高德地点服务")
    j = parse_json(r, NAME)
    if not isinstance(j, dict) or "status" not in j:
        raise bad_reply(NAME)
    if str(j.get("status")) == "1":
        return j
    code = str(j.get("infocode") or "")
    if code in _AUTH:
        raise PlaceError(502, "auth", f"高德拒绝了请求：钥匙不对或没开权限（{j.get('info')}）", NAME)
    if code in _QUOTA:
        raise PlaceError(429, "over_quota", "高德查询次数或频率超了限额，稍后再试，或者先手写地址", NAME)
    if code in _PARAM:
        raise PlaceError(400, "bad_query", "这个地名搜不了，换个写法试试", NAME)
    raise PlaceError(502, "upstream", "高德地点服务出错了，稍后再试，或者先手写地址", NAME)
