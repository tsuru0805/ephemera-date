"""Every test runs against its own tmp data directory and a fixed time zone; no network, no real data dir.

No network: every test runs with a guard that refuses any connection that is not to this machine (name
lookups and socket connects), so the default place adapters (Google / AMap / OSM) can never be reached.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).parent))

TZ_NAME = "Asia/Shanghai"
TZ = ZoneInfo(TZ_NAME)

# import time: nothing may resolve the user data dir before the per-test fixture runs
os.environ["EPHEMERA_DATA_DIR"] = "/nonexistent/ephemera-test-guard"
os.environ["EPHEMERA_TZ"] = TZ_NAME

_CLEAR = ("EPHEMERA_HER_TOKEN", "EPHEMERA_AI_TOKEN", "EPHEMERA_EVENT_WEBHOOK", "EPHEMERA_AI_WEBHOOK",
          "EPHEMERA_WEBHOOK_SECRET", "EPHEMERA_AI_CHANNELS", "EPHEMERA_QUIET_HOURS", "EPHEMERA_ART_GENERATOR",
          "EPHEMERA_PLACE_PROVIDER", "EPHEMERA_WALK_ROUTER", "EPHEMERA_MAP_RENDERER", "EPHEMERA_TOGETHER_SINCE",
          "EPHEMERA_PLACES_ADAPTER", "EPHEMERA_WALK_ADAPTER", "EPHEMERA_MAP_ADAPTER", "EPHEMERA_ART_ADAPTER",
          "EPHEMERA_ALLOWED_ORIGINS",
          "EPHEMERA_HIM", "EPHEMERA_HER", "EPHEMERA_HIM_EN", "EPHEMERA_HER_EN", "EPHEMERA_ART_DAILY_MAX",
          "EPHEMERA_WEB_DIR", "EPHEMERA_EMBED_ORIGINS", "EPHEMERA_WEB_CONNECT_SRC",
          "EPHEMERA_CARDS_DIR", "EPHEMERA_MEMORY_EXPORT_DIR",
          "EPHEMERA_PLACES_PROVIDER", "EPHEMERA_PLACES_FALLBACK", "EPHEMERA_PLACES_STORE_POLICY", "EPHEMERA_PLACES_CACHE",
          "EPHEMERA_GOOGLE_MAPS_KEY", "EPHEMERA_GOOGLE_REGION", "EPHEMERA_AMAP_KEY", "EPHEMERA_AMAP_CITY",
          "EPHEMERA_NOMINATIM_URL", "EPHEMERA_OSM_FLAVOR", "EPHEMERA_NOMINATIM_UA", "EPHEMERA_NOMINATIM_EMAIL",
          "EPHEMERA_MAP_DIR", "EPHEMERA_WALK_SPEED_KMH", "EPHEMERA_FERRY_MIN_PER_KM", "EPHEMERA_FERRY_WAIT_MIN")
_LOCAL_HOSTS = ("127.0.0.1", "::1", "localhost", "testserver", "testclient")


def _is_local(host) -> bool:
    h = host.decode() if isinstance(host, bytes) else str(host or "")
    return h in _LOCAL_HOSTS or h.startswith("127.") or h == ""


PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy",
              "no_proxy")


def clear_proxies(monkeypatch) -> None:
    """A proxy in the environment would turn a "local" connection into an outside one: drop all of them."""
    for k in PROXY_VARS:
        monkeypatch.delenv(k, raising=False)
    import urllib.request                # macOS/Windows 没有代理变量时 urllib 会读系统代理设置,一并关掉
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {})


def _addr_host(addr):
    return addr[0] if isinstance(addr, tuple) and addr else None


def install_network_guard(monkeypatch) -> None:
    """Any lookup / connection / datagram to somewhere other than this machine raises AssertionError."""
    import socket
    real_gai, real_cc = socket.getaddrinfo, socket.create_connection
    real_connect, real_connect_ex, real_sendto = socket.socket.connect, socket.socket.connect_ex, socket.socket.sendto

    def refuse(host):
        raise AssertionError(f"测试里不许连外网: {host}")

    def gai(host, *a, **k):
        return real_gai(host, *a, **k) if _is_local(host) else refuse(host)

    def connect(self, addr):
        h = _addr_host(addr)
        return refuse(h) if h is not None and not _is_local(h) else real_connect(self, addr)

    def connect_ex(self, addr):
        h = _addr_host(addr)
        return refuse(h) if h is not None and not _is_local(h) else real_connect_ex(self, addr)

    def sendto(self, data, *rest):
        h = _addr_host(rest[-1]) if rest else None
        return refuse(h) if h is not None and not _is_local(h) else real_sendto(self, data, *rest)

    def cc(addr, *a, **k):
        return real_cc(addr, *a, **k) if _is_local(addr[0]) else refuse(addr[0])
    monkeypatch.setattr(socket, "getaddrinfo", gai)
    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
    monkeypatch.setattr(socket.socket, "sendto", sendto)
    monkeypatch.setattr(socket, "create_connection", cc)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    clear_proxies(monkeypatch)
    install_network_guard(monkeypatch)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("EPHEMERA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("EPHEMERA_TZ", TZ_NAME)
    for k in _CLEAR:
        monkeypatch.delenv(k, raising=False)
    from ephemera_date import config, ports
    assert str(tmp_path) in config.db_path(), "test database must be in tmp"
    for kind in ("places", "walk", "map", "art"):
        ports.install(kind, None)
    yield
    for kind in ("places", "walk", "map", "art"):
        ports.install(kind, None)


HER_TOKEN, AI_TOKEN = "her-token", "ai-token"


def H(tok=HER_TOKEN):
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture()
def api(monkeypatch):
    """Her-side HTTP client with a fake clock (api.clock["now"])."""
    from starlette.applications import Starlette
    from starlette.testclient import TestClient

    from ephemera_date import her as date_her
    from ephemera_date import http
    from ephemera_date import plan as dp
    monkeypatch.setenv("EPHEMERA_HER_TOKEN", HER_TOKEN)
    monkeypatch.setenv("EPHEMERA_AI_TOKEN", AI_TOKEN)
    clock = {"now": None}
    real_now = dp._now
    monkeypatch.setattr(dp, "_now", lambda: clock["now"] or real_now())
    monkeypatch.setattr(date_her, "_now", lambda: clock["now"] or real_now())
    c = TestClient(Starlette(routes=http.routes()))
    c.clock = clock
    return c


TAIL_RE = __import__("re").compile(r"\n\n（约会待办 (\d+) 件(，用 date_inbox 查看)?）$")


def local_tools():
    """name → fn(args) -> (receipt without the to-do tail, is_error); the tail must be there."""
    import asyncio

    from ephemera_date import tools as dt

    def mk(name):
        def run(args):
            text, err = asyncio.run(dt.call(name, args))
            if name != "date_inbox":
                m = TAIL_RE.search(text)
                assert m, text
                text = text[:m.start()]
            return text, err
        return run
    return {n: mk(n) for n in dt.TOOLS}


def local_client():
    from starlette.applications import Starlette
    from starlette.testclient import TestClient

    from ephemera_date import http
    return TestClient(Starlette(routes=http.routes()), base_url="http://localhost")
