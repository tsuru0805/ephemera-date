"""地点服务与地图的配置（全部走环境变量，默认值在用户数据目录）。

EPHEMERA_DATA_DIR              数据目录（默认：macOS ~/Library/Application Support/ephemera；
                               Linux $XDG_DATA_HOME/ephemera 或 ~/.local/share/ephemera；Windows %APPDATA%/ephemera）
EPHEMERA_PLACES_PROVIDER       用哪家地点服务：google / amap / osm / none（默认 osm；none = 关掉地点搜索）
EPHEMERA_PLACES_FALLBACK       选 google / amap 时主服务用不了的兜底：osm / none（默认 osm；主服务本身是 osm 时没有兜底）
EPHEMERA_PLACES_LANG           结果语言（默认 zh-CN）
EPHEMERA_PLACES_CACHE          地点查询缓存库路径（默认 <数据目录>/places_cache.sqlite；只有 OSM 结果会进缓存）
EPHEMERA_GOOGLE_MAPS_KEY       谷歌钥匙（Places API (New) / Geocoding / Routes）
EPHEMERA_GOOGLE_REGION         谷歌 regionCode（可空）
EPHEMERA_AMAP_KEY              高德 Web 服务钥匙
EPHEMERA_AMAP_CITY             高德搜索默认城市（可空；城市名/adcode/citycode）
EPHEMERA_NOMINATIM_URL         OSM 搜索端点（默认 https://nominatim.openstreetmap.org；可换自建 Nominatim 或 Photon）
EPHEMERA_OSM_FLAVOR            nominatim / photon（默认 nominatim）
EPHEMERA_NOMINATIM_UA          User-Agent（公共 Nominatim 要求能识别出应用；默认见 DEFAULT_UA，建议改成自己的）
EPHEMERA_NOMINATIM_EMAIL       可选，附在请求里的联系邮箱（Nominatim 政策建议大量使用时提供）
EPHEMERA_OSM_CACHE_DAYS        OSM 查询缓存保留天数（默认 30）
EPHEMERA_MAP_DIR               底图库目录（默认 <数据目录>/maps；里面每个 *.sqlite 是一个城市的底图库）
EPHEMERA_WALK_SPEED_KMH        步行速度（默认 4.5）
EPHEMERA_FERRY_MIN_PER_KM      轮渡（底图里 route=ferry 的航线）坐船时间：每公里几分钟（默认 4；不按步行速度算）
EPHEMERA_FERRY_WAIT_MIN        每坐一段轮渡另算的等船时间（分钟，默认 10；可以是 0）
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PROVIDER = "osm"             # 不设 EPHEMERA_PLACES_PROVIDER 时用这一家（OSM 默认；谷歌/高德由使用者自行开启）
PUBLIC_NOMINATIM = "https://nominatim.openstreetmap.org"
DEFAULT_UA = "ephemera-date/0.1 (self-hosted; set EPHEMERA_NOMINATIM_UA to identify your instance)"
DEFAULT_WALK_SPEED_KMH = 4.5
DEFAULT_FERRY_MIN_PER_KM = 4.0
DEFAULT_FERRY_WAIT_MIN = 10.0


def default_data_dir() -> Path:
    env = os.getenv("EPHEMERA_DATA_DIR")
    if env:
        return Path(env).expanduser()
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "ephemera"
    if os.name == "nt":
        return Path(os.getenv("APPDATA") or home / "AppData" / "Roaming") / "ephemera"
    return Path(os.getenv("XDG_DATA_HOME") or home / ".local" / "share") / "ephemera"


def _float(name: str, default: float) -> float:
    try:
        v = float(os.getenv(name, "") or default)
    except ValueError:
        return default
    return v if v > 0 else default


@dataclass
class PlacesConfig:
    provider: str = DEFAULT_PROVIDER
    fallback: str = "osm"
    lang: str = "zh-CN"
    cache_path: Path | None = None
    google_key: str = ""
    google_region: str = ""
    amap_key: str = ""
    amap_city: str = ""
    nominatim_url: str = PUBLIC_NOMINATIM
    osm_flavor: str = "nominatim"
    user_agent: str = DEFAULT_UA
    email: str = ""
    osm_cache_days: float = 30.0
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "PlacesConfig":
        data = default_data_dir()
        return cls(
            provider=(os.getenv("EPHEMERA_PLACES_PROVIDER") or DEFAULT_PROVIDER).strip().lower(),
            fallback=(os.getenv("EPHEMERA_PLACES_FALLBACK") or "osm").strip().lower(),
            lang=os.getenv("EPHEMERA_PLACES_LANG") or "zh-CN",
            cache_path=Path(os.getenv("EPHEMERA_PLACES_CACHE") or data / "places_cache.sqlite").expanduser(),
            google_key=(os.getenv("EPHEMERA_GOOGLE_MAPS_KEY") or "").strip(),
            google_region=(os.getenv("EPHEMERA_GOOGLE_REGION") or "").strip(),
            amap_key=(os.getenv("EPHEMERA_AMAP_KEY") or "").strip(),
            amap_city=(os.getenv("EPHEMERA_AMAP_CITY") or "").strip(),
            nominatim_url=(os.getenv("EPHEMERA_NOMINATIM_URL") or PUBLIC_NOMINATIM).rstrip("/"),
            osm_flavor=(os.getenv("EPHEMERA_OSM_FLAVOR") or "nominatim").strip().lower(),
            user_agent=(os.getenv("EPHEMERA_NOMINATIM_UA") or DEFAULT_UA).strip(),
            email=(os.getenv("EPHEMERA_NOMINATIM_EMAIL") or "").strip(),
            osm_cache_days=_float("EPHEMERA_OSM_CACHE_DAYS", 30.0),
        )


def map_dir() -> Path:
    return Path(os.getenv("EPHEMERA_MAP_DIR") or default_data_dir() / "maps").expanduser()


def walk_speed_kmh() -> float:
    return _float("EPHEMERA_WALK_SPEED_KMH", DEFAULT_WALK_SPEED_KMH)


def ferry_min_per_km() -> float:
    return _float("EPHEMERA_FERRY_MIN_PER_KM", DEFAULT_FERRY_MIN_PER_KM)


def ferry_wait_min() -> float:
    try:
        v = float(os.getenv("EPHEMERA_FERRY_WAIT_MIN", "") or DEFAULT_FERRY_WAIT_MIN)
    except ValueError:
        return DEFAULT_FERRY_WAIT_MIN
    return v if v >= 0 else DEFAULT_FERRY_WAIT_MIN
