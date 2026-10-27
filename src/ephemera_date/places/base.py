"""地点服务的公共类型：结果数据类、能力位、错误、HTTP 传输层。

所有坐标在离开适配层时都是 WGS-84（高德的 GCJ-02 在 amap.py 边界处换算，见 coords.py）。
"""
from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Protocol

Q_MAX = 80            # 查询串最多字数（超出直接拒，不发给地点服务）
MAX_ITEMS = 8         # 一次搜索最多返回几个候选
TIMEOUT_S = 10.0

CRS_WGS84 = "WGS84"
CRS_GCJ02 = "GCJ-02"


@dataclass(frozen=True)
class Place:
    """一个地点候选。lat/lng 恒为 WGS-84。

    source        哪家给的：google / amap / osm
    crs_original  这家原始返回的坐标系：WGS84 / GCJ-02（只有高德境内结果是 GCJ-02）
    original      原始返回的 (lat, lng)，未换算；与 lat/lng 相同时表示没换
    kind/subtype  站类别（kinds.py 的大类代码 / 细类中文），对不上 = None
    provider_id   该家的地点 ID（谷歌 place id / 高德 POI id / OSM "N123"、"W45"、"R6"）
    raw_types     该家的原始类型（谷歌 types / 高德 typecode / OSM "class=type"），便于排查
    crs_ambiguous 高德结果落在国界几百米内、换不换坐标不确定（见 coords.gcj02_to_wgs84_checked）
    region        地区："mainland" / "hk" / "mo" / "tw" / "out"；None = 不确定（国界附近、几何判定拿不准）
    region_source region 从哪来："adcode"（高德回包的行政区划码）/ "geometry"（国界多边形判定）/ None
                  之后把这个点发往高德（周边搜索、步行）时，按 region 决定换不换 GCJ-02（见 point_parts）

    条款约束（可执行的数据，引擎落库前据此判断；本层不做产品决定，怎么存由引擎按 EPHEMERA_PLACES_STORE_POLICY 定）：
    long_term_store_ok     该家通用条款是否允许把这条结果（坐标等内容）长期存储。谷歌/高德=False，OSM=True
    long_term_fields       即便 long_term_store_ok=False，也允许长期存的字段名（谷歌=("provider_id",)，高德=()）
    coords_cache_max_days  坐标最多可临时缓存几天（谷歌=30；高德=0 不许缓存；OSM=None 不限）
    must_display_on        结果显示在地图上时必须用哪家的地图（谷歌="google_maps"，高德="amap"，OSM=None）

    兜底（FallbackProvider 填）：fallback_from = 原本要用的服务名，fallback_code = 它的错误码。
    """

    title: str
    lat: float
    lng: float
    address: str | None = None
    kind: str | None = None
    subtype: str | None = None
    source: str = ""
    crs_original: str = CRS_WGS84
    original: tuple[float, float] | None = None
    provider_id: str | None = None
    raw_types: tuple[str, ...] = ()
    crs_ambiguous: bool = False
    long_term_store_ok: bool = True
    long_term_fields: tuple[str, ...] = ()
    coords_cache_max_days: int | None = None
    must_display_on: str | None = None
    fallback_from: str | None = None
    fallback_code: str | None = None
    region: str | None = None
    region_source: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["original"] = list(self.original) if self.original else None
        d["raw_types"] = list(self.raw_types)
        d["long_term_fields"] = list(self.long_term_fields)
        return d

    # 不属于服务商内容、长期存也不受条款限制的字段（来源、我们自己的标记与约束本身）
    _META_FIELDS = ("source", "crs_original", "crs_ambiguous", "long_term_store_ok", "long_term_fields",
                    "coords_cache_max_days", "must_display_on", "fallback_from", "fallback_code",
                    "region", "region_source")

    def to_storable(self) -> dict:
        """按条款裁剪的序列化——引擎**长期落库**时用它，不要用 to_dict()。

        long_term_store_ok=True（OSM）：与 to_dict() 相同，另带 restricted=False。
        long_term_store_ok=False（谷歌/高德）：只留 long_term_fields 里的字段（谷歌=provider_id；高德=无）
        加上 _META_FIELDS，并带 restricted=True。标题、地址、坐标、类型等服务商内容一律不留——
        需要显示时按 provider_id 重新查询（谷歌），或在条款允许的期限内临时缓存（coords_cache_max_days）。"""
        full = self.to_dict()
        if self.long_term_store_ok:
            return {**full, "restricted": False}
        keep = set(self._META_FIELDS) | set(self.long_term_fields)
        return {**{k: v for k, v in full.items() if k in keep}, "restricted": True}


# 各家条款约束（Place 上的那几个字段从这里取，适配器不各写一份）
TERMS = {
    "google": {"long_term_store_ok": False, "long_term_fields": ("provider_id",), "coords_cache_max_days": 30,
               "must_display_on": "google_maps"},
    "amap": {"long_term_store_ok": False, "long_term_fields": (), "coords_cache_max_days": 0,
             "must_display_on": "amap"},
    "osm": {"long_term_store_ok": True, "long_term_fields": (), "coords_cache_max_days": None,
            "must_display_on": None},
}


class PlaceList(list):
    """search()/geocode() 的返回：就是 Place 列表，另带这次请求实际由谁回答。空结果也带。

    source          实际回答的服务名
    fallback_from   主服务名（只有兜底时才有）
    fallback_code   主服务的错误码（只有兜底时才有）
    """

    def __init__(self, items=(), source: str = "", fallback_from: str | None = None,
                 fallback_code: str | None = None):
        super().__init__(items)
        self.source, self.fallback_from, self.fallback_code = source, fallback_from, fallback_code

    def meta(self) -> dict:
        return {"source": self.source, "fallback_from": self.fallback_from, "fallback_code": self.fallback_code}


@dataclass(frozen=True)
class WalkResult:
    """两点之间步行。minutes/meters 为 None 时 reason/reason_text 说明为什么没有。

    source = local（本地 OSM 路网）/ google / amap。
    """

    minutes: int | None
    meters: int | None
    source: str
    reason: str | None = None
    reason_text: str | None = None
    pts: tuple[tuple[float, float], ...] = ()
    unverified_connector_m: int | None = None   # 本地路网：两端吸附里未核实（90–300 米）连线的米数
    ferry: tuple[dict, ...] = ()                 # 本地路网：路线里的轮渡段，每段 {meters, minutes}（minutes 含等船）

    def to_dict(self) -> dict:
        d = asdict(self)
        d["pts"] = [list(p) for p in self.pts]
        return d


@dataclass(frozen=True)
class Capabilities:
    """页面与 AI 工具据此决定交互方式与提示。

    supports_autocomplete  False = 只能点「搜索」才查（Nominatim 政策禁止边输边搜）
    supports_walk          这家能不能算步行（OSM 适配层不算，步行走本地路网）
    may_cache              适配层是否会把结果存进本地缓存
    long_term_coords_ok    该家通用条款是否允许把坐标长期存进约会（谷歌/高德=否，见 terms_note）
    attribution            页面要显示的署名
    terms_note             给使用者看的条款提示（中文）
    """

    name: str
    supports_autocomplete: bool
    supports_walk: bool
    may_cache: bool
    long_term_coords_ok: bool
    attribution: str
    terms_note: str

    def to_dict(self) -> dict:
        return asdict(self)


class PlaceError(Exception):
    """适配层统一错误。code 为机读代码，text 为给用户看的一句话，status 为建议的 HTTP 状态码。

    code: empty / too_long / not_configured / auth / over_quota / bad_query / timeout /
          unreachable / upstream / bad_reply
    """

    def __init__(self, status: int, code: str, text: str, provider: str = ""):
        super().__init__(text)
        self.status, self.code, self.text, self.provider = status, code, text, provider

    def to_dict(self) -> dict:
        return {"status": self.status, "code": self.code, "text": self.text, "provider": self.provider}


class PlaceProvider(Protocol):
    name: str

    def capabilities(self) -> Capabilities: ...

    def search(self, q: str, near: tuple[float, float] | None = None, limit: int = MAX_ITEMS) -> "PlaceList": ...

    def geocode(self, addr: str) -> "PlaceList": ...      # 0 或 1 个；找不到 = 空列表（仍带 source）

    def walk(self, origin: tuple[float, float], dest: tuple[float, float]) -> WalkResult: ...


def clean_query(q: str, provider: str = "") -> str:
    q = " ".join(str(q or "").split())
    if not q:
        raise PlaceError(400, "empty", "要输入地名再搜", provider)
    if len(q) > Q_MAX:
        raise PlaceError(400, "too_long", f"地名最多 {Q_MAX} 个字", provider)
    return q


def point_parts(p) -> tuple[object, object, str | None]:
    """点 → (纬度, 经度, 地区|None)。接受 Place、(lat, lng)、(lat, lng, region)、[lat, lng]。"""
    if isinstance(p, Place):
        return p.lat, p.lng, p.region
    if isinstance(p, (tuple, list)) and len(p) == 3:
        return p[0], p[1], p[2]
    try:
        return p[0], p[1], None
    except (TypeError, IndexError, KeyError):
        return None, None, None


def check_point(p, what: str = "坐标", provider: str = "") -> tuple[float, float]:
    """→ (纬度, 经度)。p 可以是 Place / (lat, lng) / (lat, lng, region)。"""
    la, lo, _ = point_parts(p)
    try:
        lat, lng = float(la), float(lo)
    except (TypeError, ValueError):
        raise PlaceError(400, "bad_query", f"{what}要是 [纬度, 经度]", provider) from None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise PlaceError(400, "bad_query", f"{what}超出范围", provider)
    return lat, lng


def check_region(p, what: str = "坐标", provider: str = "") -> str | None:
    region = point_parts(p)[2]
    if region is not None and region not in ("mainland", "hk", "mo", "tw", "out"):
        raise PlaceError(400, "bad_query", f"{what}的地区只能是 mainland/hk/mo/tw/out", provider)
    return region


# ── HTTP 传输层（可注入，测试用录好的响应，零真实调用） ─────────────────────────────
@dataclass
class HttpResponse:
    status: int
    body: bytes
    headers: dict = field(default_factory=dict)

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


class TransportTimeout(Exception):
    pass


class TransportError(Exception):
    pass


Transport = Callable[..., HttpResponse]


def urllib_transport(method: str, url: str, *, params: dict | None = None, headers: dict | None = None,
                     json_body: Any = None, timeout: float = TIMEOUT_S) -> HttpResponse:
    """标准库实现（不引第三方依赖）。超时 → TransportTimeout；连不上 → TransportError。"""
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    data = None
    hdr = dict(headers or {})
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        hdr.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return HttpResponse(r.status, r.read(), dict(r.headers))
    except urllib.error.HTTPError as e:
        return HttpResponse(e.code, e.read() or b"", dict(e.headers or {}))
    except (socket.timeout, TimeoutError):
        raise TransportTimeout() from None
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)):
            raise TransportTimeout() from None
        raise TransportError(str(e.reason)) from None
    except OSError as e:
        raise TransportError(str(e)) from None


def call(transport: Transport, provider: str, method: str, url: str, **kw) -> HttpResponse:
    """调传输层，把超时/断网翻成 PlaceError。"""
    try:
        return transport(method, url, **kw)
    except TransportTimeout:
        raise PlaceError(504, "timeout", "地点服务没有应答（超时），稍后再试，或者先手写地址", provider) from None
    except TransportError:
        raise PlaceError(502, "unreachable", "连不上地点服务（断网或服务地址不对），稍后再试，或者先手写地址",
                         provider) from None


def parse_json(r: HttpResponse, provider: str) -> Any:
    try:
        return r.json()
    except Exception:  # noqa: BLE001
        raise PlaceError(502, "bad_reply", "地点服务回的数据看不懂", provider) from None


def classify_http(status: int, provider: str, what: str = "地点服务") -> PlaceError:
    """非 200 的 HTTP 状态 → PlaceError。4xx（鉴权/配额以外）= 输入问题 bad_query，不兜底；
    401/403 = auth；429 = over_quota；5xx 及其它 = upstream（服务故障，可兜底）。"""
    if status in (401, 403):
        return PlaceError(502, "auth", f"{what}拒绝了请求：钥匙不对或没开对应权限", provider)
    if status == 429:
        return PlaceError(429, "over_quota", f"{what}查询次数或频率超了限额，稍后再试，或者先手写地址", provider)
    if 400 <= status < 500:
        return PlaceError(400, "bad_query", "这个地名搜不了，换个写法试试", provider)
    return PlaceError(502, "upstream", f"{what}出错了，稍后再试，或者先手写地址", provider)


def bad_reply(provider: str) -> PlaceError:
    return PlaceError(502, "bad_reply", "地点服务回的数据看不懂", provider)
