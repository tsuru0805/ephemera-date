"""Adapter interfaces the engine calls but does not implement itself.

The shapes are the ones of the built-in adapters (``ephemera_date.places`` and ``ephemera_date.maps``); both are
synchronous, and the engine calls them from async code through ``acall`` (``asyncio.to_thread``; an
adapter written with ``async def`` is awaited directly).

- places: ``places.PlaceProvider`` — ``search(q, near=None, limit=8) -> PlaceList``,
  ``geocode(addr) -> PlaceList`` (0 or 1 Place), ``capabilities() -> Capabilities``; errors = ``PlaceError``.
- walk:   ``walk(origin, dest) -> places.WalkResult`` — ``minutes``/``meters`` are None when there is no
  answer and ``reason``/``reason_text`` say why (never a straight-line guess).
- map:    ``build_map(view) -> dict`` — view = the her-side projection of one date (plan.her_plan); only
  what is in it may be drawn. ``maps.MapUnavailable`` / ``PortUnavailable`` when there is no map.
- art:    ``async generate(job) -> (ink_png, inv_png)`` (optional, nothing built in).

Default wiring (no env set): places = ``ephemera_date.places.make_provider()`` (EPHEMERA_PLACES_PROVIDER picks
google / amap / osm, or none = off), walk = the local road network (``maps.walk_between``), map =
``maps.build_map``; both over the basemaps in EPHEMERA_MAP_DIR, read again on every call so a newly built
basemap is used at once. A "module:attr" spec in EPHEMERA_PLACES_ADAPTER / EPHEMERA_WALK_ADAPTER /
EPHEMERA_MAP_ADAPTER / EPHEMERA_ART_ADAPTER overrides a default (the attr is the adapter itself or a
zero-argument factory); the spec "none" turns the port off. Tests install fakes with ``install()``.

Not available = the engine says so plainly (HTTP 503 / a tool receipt line), never a fake answer. A broken
configuration (unknown service, a spec that does not import, a factory that raises) is a PortUnavailable with
code "bad_config" and a readable text, never an unhandled exception.
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import threading
from dataclasses import asdict
from typing import Any, Callable, Protocol, runtime_checkable

from . import config
from .places.base import Capabilities, Place, PlaceError, PlaceList, WalkResult  # noqa: F401 — re-exported

log = logging.getLogger("ephemera_date.ports")


class PortUnavailable(Exception):
    """The adapter is not configured, or it could not answer. ``text`` is shown to the user / AI as-is."""

    def __init__(self, text: str, status: int = 503, code: str = "unavailable"):
        super().__init__(text)
        self.text, self.status, self.code = text, status, code


BAD_CONFIG = "bad_config"
_ENV_NAME = {"places": "EPHEMERA_PLACES_ADAPTER", "walk": "EPHEMERA_WALK_ADAPTER", "map": "EPHEMERA_MAP_ADAPTER",
             "art": "EPHEMERA_ART_ADAPTER"}


class NoRoadData(PortUnavailable):
    """A custom walk router may raise this instead of returning a WalkResult without minutes."""

    def __init__(self, text: str = "这段没有路网数据"):
        super().__init__(text, 404, "no_network")


@runtime_checkable
class PlaceProvider(Protocol):
    name: str

    def capabilities(self) -> Capabilities: ...

    def search(self, q: str, near=None, limit: int = 8) -> PlaceList: ...

    def geocode(self, addr: str) -> PlaceList: ...


@runtime_checkable
class WalkRouter(Protocol):
    def walk(self, origin: tuple[float, float], dest: tuple[float, float]) -> WalkResult: ...


@runtime_checkable
class MapRenderer(Protocol):
    def build_map(self, view: dict) -> dict: ...


@runtime_checkable
class ArtGenerator(Protocol):
    async def generate(self, job: dict) -> tuple[bytes, bytes]:
        """job = {stop_id, kind, title, art_hint, time, subject}. Returns (ink_png, inv_png): two
        transparent single-colour masks (line art / inverted) the page tints by theme."""
        ...


# ── built-in defaults ────────────────────────────────────────────────────────────
class LocalWalk:
    """Walking minutes over the local OSM road network (ephemera_date.maps)."""

    name = "local"

    def walk(self, origin, dest) -> WalkResult:
        from . import maps
        return maps.walk_between((origin[0], origin[1]), (dest[0], dest[1]))


class LocalMap:
    """The paper map from the local basemaps (ephemera_date.maps). No basemap at all = MapUnavailable(no_basemap),
    also for a date with nothing public yet (so the page can say "no basemap yet" before the day)."""

    name = "local"

    def build_map(self, view: dict) -> dict:
        from . import maps
        store = maps.MapStore()
        if not store.maps:
            raise maps.MapUnavailable("no_basemap")
        return maps.build_map(view, store)

    def status(self) -> dict:
        from . import maps
        store = maps.MapStore()
        if not store.maps:
            return {"ready": False, "basemaps": [], "reason": "no_basemap", "text": maps.REASONS["no_basemap"]}
        return {"ready": True, "basemaps": [m.name for m in store.maps], "reason": None, "text": None}


_ZH = {"places": "地点服务", "walk": "步行路线服务", "map": "地图", "art": "现画接口"}
_places_lock = threading.Lock()
_places_cache: dict[str, Any] = {}


def _default_places():
    from .places import PROVIDERS, PlacesConfig, make_provider
    cfg = PlacesConfig.from_env()
    choice = config.places_provider()
    if choice == "none":
        return None
    if choice not in PROVIDERS:
        raise PortUnavailable(f"地点服务配置有误：EPHEMERA_PLACES_PROVIDER 写的是 {cfg.provider!r}，"
                              f"只能是 {' / '.join(config.PLACE_SERVICES)}。", 503, BAD_CONFIG)
    cfg.provider = choice
    key = repr(sorted((k, str(v)) for k, v in asdict(cfg).items()))     # in memory only (holds keys)
    with _places_lock:
        if key not in _places_cache:
            _places_cache.clear()
            _places_cache[key] = make_provider(cfg=cfg)
        return _places_cache[key]


_DEFAULTS: dict[str, Callable[[], Any] | None] = {
    "places": _default_places,
    "walk": LocalWalk,
    "map": LocalMap,
    "art": None,
}
_SPECS: dict[str, Callable[[], str]] = {
    "places": config.place_provider_spec,
    "walk": config.walk_router_spec,
    "map": config.map_renderer_spec,
    "art": config.art_generator_spec,
}
OFF = ("none", "off")
_REQUIRED: dict[str, tuple[str, ...]] = {          # 每个端口的适配器必须有的方法
    "places": ("search", "geocode"), "walk": ("walk",), "map": ("build_map",), "art": ("generate",),
}
_installed: dict[str, Any] = {}
_loaded: dict[tuple[str, str], Any] = {}


def install(kind: str, adapter: Any | None) -> None:
    """Put an adapter in directly (tests, or an embedding program). None = back to env spec / default."""
    if kind not in _SPECS:
        raise KeyError(kind)
    if adapter is None:
        _installed.pop(kind, None)
    else:
        _installed[kind] = adapter


def _load_spec(kind: str, spec: str) -> Any:
    name = _ENV_NAME[kind]
    mod, _, attr = spec.partition(":")
    if not mod or not attr:
        hint = "；选内置地点服务用 EPHEMERA_PLACES_PROVIDER" if kind == "places" and spec.lower() in \
            config.PLACE_SERVICES else ""
        raise PortUnavailable(f"{name} 的写法要是 module:attr 或 none，现在是 {spec!r}{hint}。", 503, BAD_CONFIG)
    try:
        obj = getattr(importlib.import_module(mod), attr)
    except ImportError as e:
        raise PortUnavailable(f"{name}={spec!r}：导入不了模块 {mod}（{e}）。", 503, BAD_CONFIG) from None
    except AttributeError:
        raise PortUnavailable(f"{name}={spec!r}：模块 {mod} 里没有 {attr}。", 503, BAD_CONFIG) from None
    if callable(obj) and not hasattr(obj, "search") and not hasattr(obj, "walk") \
            and not hasattr(obj, "build_map") and not hasattr(obj, "generate"):
        try:
            obj = obj()
        except Exception as e:  # noqa: BLE001 — a factory that raises is a configuration error, said plainly
            raise PortUnavailable(f"{name}={spec!r}：创建适配器时出错（{e!r}）。", 503, BAD_CONFIG) from None
    missing = [m for m in _REQUIRED[kind] if not callable(getattr(obj, m, None))]
    if missing:                                # 能导入但不是这个端口的适配器（如 os:path）：说清楚，不 500
        raise PortUnavailable(f"{name}={spec!r}：这不是{_ZH[kind]}适配器，缺少方法 {'、'.join(missing)}。",
                              503, BAD_CONFIG)
    return obj


def get(kind: str) -> Any | None:
    """The adapter in use, or None when the port is off / has nothing to use.
    A configuration that cannot be used raises PortUnavailable(code="bad_config") with a readable text."""
    if kind in _installed:
        return _installed[kind]
    spec = _SPECS[kind]()
    if spec.lower() in OFF:
        return None
    if not spec:
        factory = _DEFAULTS[kind]
        if factory is None:
            return None
        try:
            return factory()
        except PortUnavailable:
            raise
        except Exception as e:  # noqa: BLE001 — e.g. an unreadable cache path: a readable 503, not a 500
            log.warning("[ports] default %s adapter failed to start: %r", kind, e)
            raise PortUnavailable(f"{_ZH[kind]}启动不了：{e}", 503, BAD_CONFIG) from None
    key = (kind, spec)
    if key not in _loaded:
        _loaded[key] = _load_spec(kind, spec)          # failures are not cached: fixing the env takes effect
    return _loaded[key]


def configured(kind: str) -> bool:
    if kind in _installed:
        return True
    spec = _SPECS[kind]()
    if spec.lower() in OFF:
        return False
    if not spec and kind == "places":
        return config.places_provider() != "none"
    return bool(spec) or _DEFAULTS[kind] is not None


async def aget(kind: str) -> Any | None:
    """get() from async code: the first build of a default adapter (opens its cache, reads config) runs in a thread."""
    return await asyncio.to_thread(get, kind)


async def acall(fn, *a, **kw):
    """Call an adapter method from async code: sync = in a worker thread, ``async def`` = awaited."""
    if inspect.iscoroutinefunction(fn):
        return await fn(*a, **kw)
    out = await asyncio.to_thread(fn, *a, **kw)
    return await out if inspect.isawaitable(out) else out
