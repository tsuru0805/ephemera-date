import pytest

from ephemera_date.places import DEFAULT_PROVIDER, FallbackProvider, PlaceError, make_provider
from ephemera_date.places.amap import AmapProvider
from ephemera_date.places.config import PlacesConfig
from ephemera_date.places.google import GoogleProvider
from ephemera_date.places.nominatim import NominatimProvider

from .conftest import FakeTransport, load, resp


def test_default_provider_is_osm_without_fallback():
    assert DEFAULT_PROVIDER == "osm"
    assert PlacesConfig.from_env().provider == "osm"
    p = make_provider()
    assert isinstance(p, NominatimProvider) and not isinstance(p, FallbackProvider)


def test_default_osm_has_no_fallback_even_when_fallback_is_osm(monkeypatch):
    monkeypatch.setenv("EPHEMERA_PLACES_FALLBACK", "osm")
    assert isinstance(make_provider(), NominatimProvider)
    monkeypatch.setenv("EPHEMERA_PLACES_PROVIDER", "osm")
    assert isinstance(make_provider(), NominatimProvider)


@pytest.mark.parametrize("name,cls", [("google", GoogleProvider), ("amap", AmapProvider)])
def test_opt_in_google_or_amap_keeps_osm_fallback(monkeypatch, name, cls):
    monkeypatch.setenv("EPHEMERA_PLACES_PROVIDER", name)
    p = make_provider()
    assert isinstance(p, FallbackProvider) and isinstance(p.primary, cls)
    assert isinstance(p.fallback, NominatimProvider)
    monkeypatch.setenv("EPHEMERA_PLACES_FALLBACK", "none")
    assert isinstance(make_provider(), cls)


@pytest.mark.parametrize("env,cls", [("amap", AmapProvider), ("osm", NominatimProvider), ("google", GoogleProvider)])
def test_env_selects_provider(monkeypatch, env, cls):
    monkeypatch.setenv("EPHEMERA_PLACES_PROVIDER", env)
    monkeypatch.setenv("EPHEMERA_PLACES_FALLBACK", "none")
    assert isinstance(make_provider(), cls)


def test_unknown_provider():
    with pytest.raises(ValueError):
        make_provider("bing")


def test_falls_back_to_osm_when_primary_has_no_key():
    t = FakeTransport(resp(load("nominatim_search_shanghai_museum.json")))
    p = make_provider("google", transport=t)
    out = p.search("上海博物馆")
    assert out.source == "osm" and out.fallback_from == "google" and out.fallback_code == "not_configured"
    assert all(x.source == "osm" and x.fallback_from == "google" and x.fallback_code == "not_configured" for x in out)
    assert len(t.calls) == 1 and "nominatim" in t.calls[0]["url"]
    assert not hasattr(p, "last_error")


def test_input_errors_do_not_fall_back():
    t = FakeTransport(resp([]))
    with pytest.raises(PlaceError) as e:
        make_provider("amap", transport=t).search("")
    assert e.value.code == "empty" and t.calls == []


def test_quota_falls_back():
    t = FakeTransport(resp(load("amap_error_quota.json")), resp(load("nominatim_search_shanghai_museum.json")))
    cfg = PlacesConfig.from_env()
    cfg.amap_key = "k"
    p = make_provider("amap", cfg, transport=t)
    assert p.search("上海博物馆")[0].source == "osm"


def test_chain_capabilities_forbid_autocomplete_when_osm_may_answer():
    caps = make_provider("google").capabilities()
    assert caps.supports_autocomplete is False and caps.long_term_coords_ok is False
    assert "OpenStreetMap" in caps.attribution


def _cfg(**kw):
    c = PlacesConfig.from_env()
    for k, v in kw.items():
        setattr(c, k, v)
    return c


@pytest.mark.parametrize("status", [400, 404, 422])
def test_4xx_input_errors_do_not_fall_back(status):
    t = FakeTransport(resp({}, status))
    with pytest.raises(PlaceError) as e:
        make_provider("amap", _cfg(amap_key="k"), transport=t).search("x")
    assert e.value.code == "bad_query" and len(t.calls) == 1


@pytest.mark.parametrize("first", [resp({}, 500), resp({}, 503), resp({}, 401), resp({}, 429), resp([], 200)])
def test_service_faults_fall_back_and_are_visible(first, caplog):
    t = FakeTransport(first, resp(load("nominatim_search_shanghai_museum.json")))
    with caplog.at_level("WARNING", logger="ephemera_date.places"):
        out = make_provider("google", _cfg(google_key="k"), transport=t).search("上海博物馆")
    assert out.source == "osm" and out.fallback_from == "google" and out.fallback_code
    assert any("兜底" in r.getMessage() for r in caplog.records)


def test_empty_fallback_result_still_carries_source():
    t = FakeTransport(resp([]))
    out = make_provider("google", transport=t).geocode("nowhere")
    assert list(out) == [] and out.source == "osm" and out.fallback_from == "google"


def test_fallback_markers_are_per_request_under_concurrency():
    import threading
    cfg = _cfg(google_key="k")
    good = load("google_places_searchtext.json")
    osm = load("nominatim_search_shanghai_museum.json")

    def tr(method, url, **kw):
        if "googleapis" in url:
            q = (kw.get("json_body") or {}).get("textQuery")
            return resp({}, 500) if q == "bad" else resp(good)
        return resp(osm)
    p = make_provider("google", cfg, transport=tr)
    res = {}

    def run(q):
        for i in range(10):
            res.setdefault(q, []).append(p.search(q))
    th = [threading.Thread(target=run, args=(q,)) for q in ("bad", "ok")]
    [x.start() for x in th]
    [x.join() for x in th]
    assert all(r.fallback_from == "google" and r.source == "osm" for r in res["bad"])
    assert all(r.fallback_from is None and r.source == "google" for r in res["ok"])
