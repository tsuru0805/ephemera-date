import pytest

from ephemera_date.places.base import PlaceError, TransportTimeout
from ephemera_date.places.config import PlacesConfig
from ephemera_date.places.google import FIELDS, PLACES_TEXT, GoogleProvider

from .conftest import FakeTransport, load, resp


def make(t, key="test-key", **kw):
    cfg = PlacesConfig.from_env()
    cfg.google_key = key
    for k, v in kw.items():
        setattr(cfg, k, v)
    return GoogleProvider(cfg, transport=t)


def test_search_parses_and_classifies():
    t = FakeTransport(resp(load("google_places_searchtext.json")))
    out = make(t).search("ramen", near=(43.74, 7.42))
    assert [p.title for p in out] == ["Example Ramen", "Sample Coffee"]       # 没坐标的丢掉
    assert (out[0].kind, out[0].subtype) == ("dinner", "拉面")
    assert (out[1].kind, out[1].subtype) == ("cafe", "咖啡馆")
    assert out[0].provider_id == "ChIJexample-ramen-0001" and out[0].source == "google"
    assert out[0].crs_original == "WGS84" and out[0].original == (out[0].lat, out[0].lng)


def test_search_request_shape():
    t = FakeTransport(resp(load("google_places_searchtext.json")))
    make(t, google_region="mc").search("ramen", near=(43.74, 7.42), limit=3)
    c = t.calls[0]
    assert c["method"] == "POST" and c["url"] == PLACES_TEXT
    assert c["headers"]["X-Goog-Api-Key"] == "test-key" and c["headers"]["X-Goog-FieldMask"] == FIELDS
    assert c["json"]["textQuery"] == "ramen" and c["json"]["pageSize"] == 3 and c["json"]["regionCode"] == "MC"
    assert c["json"]["locationBias"]["circle"]["center"] == {"latitude": 43.74, "longitude": 7.42}


def test_field_mask_stays_in_pro_tier():
    # 只取名字/地址/坐标/类型/ID；评分、营业时间等会升档的字段不取
    assert not any(f in FIELDS for f in ("rating", "openingHours", "priceLevel", "reviews"))


def test_no_key_means_not_configured_and_no_call():
    t = FakeTransport(resp({}))
    with pytest.raises(PlaceError) as e:
        make(t, key="").search("x")
    assert e.value.code == "not_configured" and t.calls == []


@pytest.mark.parametrize("status,code", [(403, "auth"), (401, "auth"), (429, "over_quota"), (400, "bad_query"),
                                         (404, "bad_query"), (500, "upstream"), (503, "upstream")])
def test_new_api_errors(status, code):
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp(load("google_error_403.json"), status))).search("x")
    assert e.value.code == code


def test_timeout():
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(TransportTimeout())).search("x")
    assert e.value.code == "timeout"


def test_geocode_ok_zero_denied():
    t = FakeTransport(resp(load("google_geocode_ok.json")))
    res = make(t).geocode("Place du Casino")
    g = res[0]
    assert res.source == "google" and g.lat == 43.7397 and g.provider_id == "ChIJexample-geocode-0004"
    assert t.calls[0]["params"]["key"] == "test-key" and t.calls[0]["params"]["language"] == "zh-CN"
    zero = make(FakeTransport(resp(load("google_geocode_zero.json")))).geocode("nowhere")
    assert list(zero) == [] and zero.source == "google"
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp(load("google_geocode_denied.json")))).geocode("x")
    assert e.value.code == "auth"


def test_walk():
    t = FakeTransport(resp(load("google_routes_walk.json")))
    r = make(t).walk((43.74, 7.42), (43.73, 7.42))
    assert (r.minutes, r.meters, r.source) == (11, 812, "google")
    assert t.calls[0]["json"]["travelMode"] == "WALK"
    r2 = make(FakeTransport(resp({"routes": []}))).walk((43.74, 7.42), (43.73, 7.42))
    assert r2.minutes is None and r2.reason == "no_route"


def test_capabilities_flag_terms():
    c = make(FakeTransport(resp({}))).capabilities()
    assert c.may_cache is False and c.long_term_coords_ok is False and "30" in c.terms_note


@pytest.mark.parametrize("status,code", [(400, "bad_query"), (404, "bad_query"), (403, "auth"), (429, "over_quota"),
                                         (500, "upstream")])
def test_geocode_http_status_classified(status, code):
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp({}, status))).geocode("x")
    assert e.value.code == code


@pytest.mark.parametrize("body", [[], {"places": {}}, {"places": [1]}, "x"])
def test_http_200_wrong_structure_is_bad_reply(body):
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp(body))).search("x")
    assert e.value.code == "bad_reply"


def test_zero_results_is_empty_with_source():
    out = make(FakeTransport(resp({}))).search("nothing")
    assert list(out) == [] and out.source == "google"


def test_places_carry_terms_as_data():
    p = make(FakeTransport(resp(load("google_places_searchtext.json")))).search("ramen")[0]
    assert p.long_term_store_ok is False and p.long_term_fields == ("provider_id",)
    assert p.coords_cache_max_days == 30 and p.must_display_on == "google_maps"
    d = p.to_dict()
    assert d["long_term_store_ok"] is False and d["must_display_on"] == "google_maps"


def test_to_storable_keeps_only_place_id_and_meta():
    p = make(FakeTransport(resp(load("google_places_searchtext.json")))).search("ramen")[0]
    st = p.to_storable()
    assert st["restricted"] is True and st["provider_id"] == "ChIJexample-ramen-0001" and st["source"] == "google"
    for k in ("title", "lat", "lng", "address", "original", "kind", "subtype", "raw_types"):
        assert k not in st
    full = p.to_dict()                                   # 完整序列化保留（内存里用）
    assert full["title"] == "Example Ramen" and full["lat"] == p.lat



def test_google_places_carry_geometry_region_kept_in_storable():
    p = make(FakeTransport(resp(load("google_places_searchtext.json")))).search("ramen")[0]
    assert (p.region, p.region_source) == ("out", "geometry")          # 样例坐标在摩纳哥
    st = p.to_storable()
    assert (st["region"], st["region_source"]) == ("out", "geometry")


# ── 按地点 ID 取坐标(Place Details (New);坐标缓存过期后重新取用)────────────────────────
def test_details_by_place_id():
    from ephemera_date.places.google import DETAILS_FIELDS, PLACE_DETAILS
    body = {k: v for k, v in load("google_place_details.json").items() if not k.startswith("_")}
    t = FakeTransport(resp(body))
    out = make(t).details("ChIJexample-ramen-0001")
    assert out.source == "google" and len(out) == 1
    assert (out[0].lat, out[0].lng, out[0].provider_id, out[0].source) == (43.7384, 7.4246, "ChIJexample-ramen-0001",
                                                                            "google")
    assert out[0].long_term_store_ok is False and out[0].coords_cache_max_days == 30
    c = t.calls[0]
    assert c["method"] == "GET" and c["url"] == PLACE_DETAILS + "ChIJexample-ramen-0001"
    assert c["headers"]["X-Goog-FieldMask"] == DETAILS_FIELDS == "id,location"     # 只要坐标


def test_details_errors():
    assert make(FakeTransport(resp({"error": {"code": 404, "status": "NOT_FOUND"}}, 404))).details("ChIJgone") == []
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp({}))).details("../x")
    assert e.value.code == "bad_query"
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp({})), key="").details("ChIJx")
    assert e.value.code == "not_configured"
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp({"id": "ChIJx"}))).details("ChIJx")                # 没有 location = 看不懂
    assert e.value.code == "bad_reply"
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp({}, 403))).details("ChIJx")
    assert e.value.code == "auth"


def test_fallback_provider_details_only_asks_primary():
    from ephemera_date.places import FallbackProvider
    from ephemera_date.places.nominatim import NominatimProvider
    fp = FallbackProvider(make(FakeTransport(resp({}))), NominatimProvider(PlacesConfig.from_env(),
                                                                           transport=FakeTransport(resp([]))))
    assert hasattr(fp, "details")
    with pytest.raises(PlaceError):
        fp.details("ChIJx")                                                          # 回包看不懂:不改问 OSM
    assert not hasattr(FallbackProvider(fp.fallback, fp.fallback), "details")
