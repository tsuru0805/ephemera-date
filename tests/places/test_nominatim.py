import threading
import time

import pytest

from ephemera_date.places.base import PlaceError, TransportError, TransportTimeout
from ephemera_date.places.cache import QueryCache
from ephemera_date.places.config import DEFAULT_UA, PlacesConfig
from ephemera_date.places.nominatim import NominatimProvider, bulk_requests
from ephemera_date.places.ratelimit import BULK_INTERVAL_S, FileLimiter

from .conftest import FakeTransport, load, resp


class FakeClock:
    def __init__(self):
        self.t = 1000.0
        self.slept = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(round(s, 3))
        self.t += s


def make(transport, tmp_path, *, clock=None, flavor="nominatim", **cfg_kw):
    cfg = PlacesConfig.from_env()
    cfg.osm_flavor = flavor
    for k, v in cfg_kw.items():
        setattr(cfg, k, v)
    clock = clock or FakeClock()
    lim = FileLimiter(tmp_path / "rl", clock=clock, sleep=clock.sleep)
    return NominatimProvider(cfg, transport=transport, limiter=lim, cache=QueryCache(tmp_path / "c.sqlite")), clock


def test_recorded_search_parses_and_classifies(tmp_path):
    t = FakeTransport(resp(load("nominatim_search_shanghai_museum.json")))
    p, _ = make(t, tmp_path)
    out = p.search("上海博物馆")
    assert out and out[0].title == "上海博物馆"
    assert (out[0].kind, out[0].subtype) == ("museum", "博物馆")
    assert out[0].source == "osm" and out[0].crs_original == "WGS84"
    assert out[0].provider_id.startswith(("W", "N", "R"))
    assert 31.2 < out[0].lat < 31.3 and 121.4 < out[0].lng < 121.5


def test_request_has_user_agent_language_and_jsonv2(tmp_path):
    t = FakeTransport(resp(load("nominatim_search_shanghai_museum.json")))
    p, _ = make(t, tmp_path, user_agent="my-instance/1.0 (me@example.org)", email="me@example.org")
    p.search("上海博物馆")
    c = t.calls[0]
    assert c["url"].endswith("/search")
    assert c["headers"]["User-Agent"] == "my-instance/1.0 (me@example.org)"
    assert c["headers"]["Accept-Language"] == "zh-CN"
    assert c["params"]["format"] == "jsonv2" and c["params"]["email"] == "me@example.org"


def test_default_user_agent_is_not_a_library_default(tmp_path):
    t = FakeTransport(resp([]))
    p, _ = make(t, tmp_path)
    p.search("x")
    ua = t.calls[0]["headers"]["User-Agent"]
    assert ua == DEFAULT_UA and "python" not in ua.lower() and "ephemera" in ua


def test_blank_user_agent_refused(tmp_path):
    t = FakeTransport(resp([]))
    p, _ = make(t, tmp_path, user_agent=" ")
    with pytest.raises(PlaceError) as e:
        p.search("x")
    assert e.value.code == "not_configured" and t.calls == []


def test_near_limits_to_box_and_recorded_results_are_nearby(tmp_path):
    t = FakeTransport(resp(load("nominatim_search_cafe_near_monaco.json")))
    p, _ = make(t, tmp_path)
    out = p.search("café", near=(43.7396, 7.4269))
    prm = t.calls[0]["params"]
    assert prm["bounded"] == 1 and len(prm["viewbox"].split(",")) == 4
    assert out and all(abs(x.lat - 43.74) < 0.06 and abs(x.lng - 7.42) < 0.06 for x in out)
    assert any(x.kind == "cafe" for x in out)


def test_capabilities_forbid_autocomplete():
    caps = NominatimProvider(PlacesConfig.from_env()).capabilities()
    assert caps.supports_autocomplete is False
    assert "OpenStreetMap" in caps.attribution and caps.long_term_coords_ok is True


def test_same_query_is_served_from_cache(tmp_path):
    t = FakeTransport(resp(load("nominatim_search_shanghai_museum.json")))
    p, _ = make(t, tmp_path)
    a = p.search("上海博物馆")
    b = p.search("  上海博物馆 ")
    assert a == b and len(t.calls) == 1


def test_cache_persists_across_instances(tmp_path):
    t = FakeTransport(resp(load("nominatim_search_shanghai_museum.json")))
    make(t, tmp_path)[0].search("上海博物馆")
    t2 = FakeTransport(resp([]))
    out = make(t2, tmp_path)[0].search("上海博物馆")
    assert out and t2.calls == []


def test_default_cache_lives_in_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("EPHEMERA_DATA_DIR", str(tmp_path / "dd"))
    cfg = PlacesConfig.from_env()
    assert cfg.cache_path == tmp_path / "dd" / "places_cache.sqlite"
    NominatimProvider(cfg, transport=FakeTransport(resp([]))).search("x")
    assert (tmp_path / "dd" / "places_cache.sqlite").exists()


def test_interactive_rate_limit_one_per_second(tmp_path):
    t = FakeTransport(resp([]))
    p, clock = make(t, tmp_path)
    p.search("a")
    p.search("b")
    p.search("c")
    assert len(t.calls) == 3
    assert clock.slept == [1.0, 1.0]


def test_rate_limit_shared_across_instances(tmp_path):
    clock = FakeClock()
    t = FakeTransport(resp([]))
    cfg = PlacesConfig.from_env()
    a = NominatimProvider(cfg, transport=t, limiter=FileLimiter(tmp_path / "rl", clock=clock, sleep=clock.sleep),
                          cache=QueryCache(tmp_path / "a.sqlite"))
    b = NominatimProvider(cfg, transport=t, limiter=FileLimiter(tmp_path / "rl", clock=clock, sleep=clock.sleep),
                          cache=QueryCache(tmp_path / "b.sqlite"))
    a.search("a")
    b.search("b")                                    # 两个限速器实例，同一个锁文件 = 同一个闸
    assert clock.slept == [1.0]


def test_bulk_mode_four_per_minute(tmp_path):
    t = FakeTransport(resp([]))
    p, clock = make(t, tmp_path)
    p.search_many(["a", "b", "c", "d", "a"])          # 最后一个命中缓存，不占次数
    assert len(t.calls) == 4
    assert clock.slept == [BULK_INTERVAL_S] * 3
    assert 60 / BULK_INTERVAL_S == 4


def test_bulk_context_and_call_param(tmp_path):
    t = FakeTransport(resp([]))
    p, clock = make(t, tmp_path)
    with bulk_requests():
        p.search("a")
        p.geocode("b")
    p.search("c", bulk=True)
    p.search("d")                                    # 交互：只要离上次 ≥1 秒
    assert clock.slept == [BULK_INTERVAL_S, BULK_INTERVAL_S, 1.0]


class RecordingLimiter:
    """记录每次 slot 的 bulk 标志（并发时不串）。"""

    def __init__(self):
        self.flags, self._l = [], threading.Lock()

    def slot(self, url, bulk=False):
        import contextlib

        @contextlib.contextmanager
        def cm():
            class T:
                def wait(self_):
                    return 0
            yield T()
        with self._l:
            self.flags.append(bulk)
        return cm()


def _slow(delay=0.02):
    def f():
        time.sleep(delay)
        return resp([])
    return f


def test_concurrent_bulk_and_interactive_do_not_leak(tmp_path):
    lim = RecordingLimiter()
    p = NominatimProvider(PlacesConfig.from_env(), transport=FakeTransport(_slow()), limiter=lim,
                          cache=QueryCache(tmp_path / "c.sqlite"))
    out = {}

    def batch():
        p.search_many([f"b{i}" for i in range(5)])

    def ctx():
        with bulk_requests():
            for i in range(5):
                p.search(f"x{i}")

    def interactive():
        for i in range(5):
            out.setdefault("i", []).append(p.search(f"i{i}"))
    th = [threading.Thread(target=f) for f in (batch, ctx, interactive)]
    [x.start() for x in th]
    [x.join() for x in th]
    assert sorted(lim.flags) == [False] * 5 + [True] * 10
    assert p.default_bulk is False                     # 实例状态没被改


def test_concurrent_same_query_sent_once(tmp_path):
    t = FakeTransport(_slow(0.05))
    p = NominatimProvider(PlacesConfig.from_env(), transport=t,
                          limiter=FileLimiter(tmp_path / "rl", interval_s=0.01), cache=QueryCache(tmp_path / "c.sqlite"))
    th = [threading.Thread(target=p.search, args=("同一个地方",)) for _ in range(6)]
    [x.start() for x in th]
    [x.join() for x in th]
    assert len(t.calls) == 1                         # 拿到锁后复查缓存


def test_cache_key_keeps_parameter_case(tmp_path):
    t = FakeTransport(resp([{"lat": "1", "lon": "2", "name": "Upper", "display_name": "Upper"}]),
                      resp([{"lat": "3", "lon": "4", "name": "lower", "display_name": "lower"}]))
    p, _ = make(t, tmp_path)
    a = p.search("US")
    b = p.search("us")
    assert len(t.calls) == 2 and a[0].title == "Upper" and b[0].title == "lower"


def test_concurrent_callers_really_spaced_and_serialized(tmp_path):
    """真实等待（间隔缩短为 0.15 秒）：多线程同时搜，彼此不重叠、开始时刻间隔 ≥ 间隔。"""
    spans, lock = [], threading.Lock()

    def tr(method, url, **kw):
        t0 = time.time()
        time.sleep(0.02)
        with lock:
            spans.append((t0, time.time()))
        return resp([])
    lim = FileLimiter(tmp_path / "rl", interval_s=0.15)
    p = NominatimProvider(PlacesConfig.from_env(), transport=tr, limiter=lim, cache=QueryCache(tmp_path / "c.sqlite"))
    th = [threading.Thread(target=p.search, args=(f"q{i}",)) for i in range(5)]
    [x.start() for x in th]
    [x.join() for x in th]
    spans.sort()
    assert len(spans) == 5 and lim.sent == 5
    for (s0, e0), (s1, _) in zip(spans, spans[1:]):
        assert s1 >= e0 + 0.15 - 0.01


WORKER = r"""
import json, sys, time
sys.path.insert(0, {src!r})
from ephemera_date.places.ratelimit import FileLimiter
lim = FileLimiter({d!r}, interval_s=0.2, bulk_interval_s=0.5)
out = []
for _ in range(3):
    with lim.slot("https://nominatim.example.org/search", bulk={bulk}) as t:
        t.wait()
        s = time.time(); time.sleep(0.03); out.append([s, time.time(), {bulk}])
json.dump(out, open({o!r}, "w"))
"""


def test_cross_process_limit_really_holds(tmp_path):
    """三个独立进程同时抢同一个主机：全机同一时刻最多一个在途，间隔 ≥ 0.2 秒；批量进程之间 ≥ 0.5 秒。"""
    import json
    import subprocess
    import sys
    from pathlib import Path
    src = str(Path(__file__).resolve().parents[2] / "src")
    procs = []
    for k, bulk in enumerate([False, False, True]):
        code = WORKER.format(src=src, d=str(tmp_path / "rl"), o=str(tmp_path / f"o{k}.json"), bulk=bulk)
        procs.append(subprocess.Popen([sys.executable, "-c", code]))
    assert all(p.wait(timeout=60) == 0 for p in procs)
    spans = sorted(x for k in range(3) for x in json.load(open(tmp_path / f"o{k}.json")))
    assert len(spans) == 9
    for (s0, e0, _), (s1, _, _) in zip(spans, spans[1:]):
        assert s1 >= e0 + 0.2 - 0.02                 # 不重叠且间隔够
    bulk_starts = [s for s, _, b in spans if b]
    bulk_ends = [e for _, e, b in spans if b]
    for e0, s1 in zip(bulk_ends, bulk_starts[1:]):
        assert s1 >= e0 + 0.5 - 0.02


@pytest.mark.parametrize("status,code", [(429, "over_quota"), (403, "auth"), (400, "bad_query"), (404, "bad_query"),
                                         (500, "upstream"), (503, "upstream")])
def test_http_errors(tmp_path, status, code):
    p, _ = make(FakeTransport(resp({"error": "x"}, status)), tmp_path)
    with pytest.raises(PlaceError) as e:
        p.search("x")
    assert e.value.code == code and e.value.provider == "osm"


@pytest.mark.parametrize("exc,code", [(TransportTimeout(), "timeout"), (TransportError("down"), "unreachable")])
def test_offline_and_timeout(tmp_path, exc, code):
    p, _ = make(FakeTransport(exc), tmp_path)
    with pytest.raises(PlaceError) as e:
        p.search("x")
    assert e.value.code == code


@pytest.mark.parametrize("body", [{"x": 1}, [1, 2], "str"])
def test_wrong_structure_is_bad_reply(tmp_path, body):
    p, _ = make(FakeTransport(resp(body)), tmp_path)
    with pytest.raises(PlaceError) as e:
        p.search("x")
    assert e.value.code == "bad_reply"


def test_osm_places_carry_terms(tmp_path):
    p, _ = make(FakeTransport(resp(load("nominatim_search_shanghai_museum.json"))), tmp_path)
    x = p.search("上海博物馆")[0]
    assert x.long_term_store_ok is True and x.must_display_on is None and x.coords_cache_max_days is None


def test_bad_json(tmp_path):
    from ephemera_date.places.base import HttpResponse
    p, _ = make(FakeTransport(HttpResponse(200, b"<html>")), tmp_path)
    with pytest.raises(PlaceError) as e:
        p.search("x")
    assert e.value.code == "bad_reply"


@pytest.mark.parametrize("q,code", [("", "empty"), ("   ", "empty"), ("字" * 81, "too_long")])
def test_input_validation(tmp_path, q, code):
    t = FakeTransport(resp([]))
    p, _ = make(t, tmp_path)
    with pytest.raises(PlaceError) as e:
        p.search(q)
    assert e.value.code == code and t.calls == []


def test_geocode_and_bbox_from_recorded(tmp_path):
    t = FakeTransport(resp(load("nominatim_geocode_huangpu.json")))
    p, _ = make(t, tmp_path)
    g = p.geocode("黄浦区, 上海")
    assert len(g) == 1 and g[0].source == "osm" and g.source == "osm"
    bb = p.bbox("黄浦区, 上海")
    assert bb == pytest.approx((31.1901912, 31.2463061, 121.4522114, 121.5059585))
    assert len(t.calls) == 1                        # 同一请求，第二次走缓存


def test_geocode_not_found_is_empty_with_source(tmp_path):
    p, _ = make(FakeTransport(resp([])), tmp_path)
    g = p.geocode("nowhere at all")
    assert list(g) == [] and g.source == "osm" and g.fallback_from is None


def test_photon_flavor(tmp_path):
    t = FakeTransport(resp(load("photon_search.json")))
    p, _ = make(t, tmp_path, flavor="photon", nominatim_url="https://photon.example.org")
    out = p.search("Example Café", near=(43.74, 7.42))
    assert t.calls[0]["url"] == "https://photon.example.org/api"
    assert "lang" not in t.calls[0]["params"]                 # zh 不被公共 Photon 支持，不传
    assert out[0].title == "Example Café" and (out[0].kind, out[0].subtype) == ("cafe", "咖啡馆")
    assert out[0].provider_id == "N123456"
    assert p.bbox("Example Café") == pytest.approx((43.73, 43.74, 7.42, 7.43))


def test_walk_not_supported():
    r = NominatimProvider(PlacesConfig.from_env()).walk((1, 2), (3, 4))
    assert r.minutes is None and r.reason == "unsupported"


def test_to_storable_osm_is_full(tmp_path):
    p, _ = make(FakeTransport(resp(load("nominatim_search_shanghai_museum.json"))), tmp_path)
    x = p.search("上海博物馆")[0]
    st = x.to_storable()
    assert st["restricted"] is False and st["title"] == x.title and st["lat"] == x.lat
    assert {k: v for k, v in st.items() if k != "restricted"} == x.to_dict()
