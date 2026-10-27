import pytest

from ephemera_date.places import coords
from ephemera_date.places.amap import AROUND, TEXT, WALK, AmapProvider, normalize
from ephemera_date.places.base import PlaceError
from ephemera_date.places.config import PlacesConfig

from .conftest import FakeTransport, load, resp

TOL_M = 1.0


def make(t, key="amap-key", city=""):
    cfg = PlacesConfig.from_env()
    cfg.amap_key, cfg.amap_city = key, city
    return AmapProvider(cfg, transport=t)


def _lnglat(s):
    lng, lat = (float(x) for x in s.split(","))
    return lat, lng


def test_search_normalizes_gcj_to_wgs_at_boundary():
    fx = load("amap_place_text.json")
    t = FakeTransport(resp(fx))
    out = make(t, city="上海").search("上海博物馆")
    assert t.calls[0]["url"] == TEXT and t.calls[0]["params"]["region"] == "上海"
    assert [p.title for p in out] == ["上海博物馆", "示例咖啡"]          # 坏坐标的丢掉
    for p in out:
        truth = fx["_wgs84_truth"][p.title]
        assert coords.haversine_m(p.lat, p.lng, *truth) < TOL_M
        assert p.crs_original == "GCJ-02" and p.source == "amap"
        assert coords.haversine_m(*p.original, p.lat, p.lng) > 100     # 原坐标保留（确实是偏移过的）
    assert (out[0].kind, out[0].subtype) == ("museum", "博物馆")
    assert (out[1].kind, out[1].subtype) == ("cafe", "咖啡馆")
    assert out[1].address == "上海市上海市黄浦区"                          # address 为 [] 时不炸


def test_near_is_sent_as_gcj_to_around():
    t = FakeTransport(resp(load("amap_place_text.json")))
    wgs = (31.2301577, 121.4709998)
    make(t).search("咖啡", near=wgs)
    c = t.calls[0]
    assert c["url"] == AROUND and c["params"]["keywords"] == "咖啡"
    sent = _lnglat(c["params"]["location"])
    assert coords.haversine_m(*sent, *coords.wgs84_to_gcj02(*wgs)) < 0.2
    assert coords.haversine_m(*sent, *wgs) > 100


def test_geocode():
    t = FakeTransport(resp(load("amap_geocode.json")))
    res = make(t).geocode("上海市黄浦区人民大道201号")
    g = res[0]
    assert g.crs_original == "GCJ-02" and res.source == "amap"
    assert coords.haversine_m(g.lat, g.lng, 31.2301577, 121.4709998) < TOL_M
    none = make(FakeTransport(resp({"status": "1", "count": "0", "geocodes": []}))).geocode("没有")
    assert list(none) == [] and none.source == "amap"


def test_walk_converts_inputs_back_to_gcj():
    t = FakeTransport(resp(load("amap_walk.json")))
    o, d = (31.2280, 121.4750), (31.2370, 121.4940)
    r = make(t).walk(o, d)
    assert (r.minutes, r.meters, r.source) == (31, 2310, "amap")
    p = t.calls[0]["params"]
    assert t.calls[0]["url"] == WALK and p["show_fields"] == "cost"
    assert coords.haversine_m(*_lnglat(p["origin"]), *coords.wgs84_to_gcj02(*o)) < 0.2
    assert coords.haversine_m(*_lnglat(p["destination"]), *coords.wgs84_to_gcj02(*d)) < 0.2


def test_overseas_result_not_converted():
    body = {"status": "1", "info": "OK", "infocode": "10000", "count": "1",
            "pois": [{"name": "Overseas", "location": "7.424600,43.738400", "typecode": "050500", "id": "X1"}]}
    p = make(FakeTransport(resp(body))).search("cafe")[0]
    assert (p.lat, p.lng, p.crs_original) == (43.7384, 7.4246, "WGS84")
    assert normalize(43.7384, 7.4246) == (43.7384, 7.4246, "WGS84", False, "out", "geometry")
    assert (p.region, p.region_source) == ("out", "geometry")


@pytest.mark.parametrize("fx,code", [("amap_error_key.json", "auth"), ("amap_error_quota.json", "over_quota")])
def test_errors(fx, code):
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp(load(fx)))).search("x")
    assert e.value.code == code


def test_no_key():
    t = FakeTransport(resp({}))
    with pytest.raises(PlaceError) as e:
        make(t, key="").geocode("x")
    assert e.value.code == "not_configured" and t.calls == []


def test_key_sent_and_caps():
    t = FakeTransport(resp(load("amap_place_text.json")))
    a = make(t)
    a.search("x")
    assert t.calls[0]["params"]["key"] == "amap-key"
    assert a.capabilities().may_cache is False and a.capabilities().long_term_coords_ok is False


@pytest.mark.parametrize("status,code", [(400, "bad_query"), (404, "bad_query"), (403, "auth"), (429, "over_quota"),
                                         (500, "upstream"), (502, "upstream")])
def test_http_status_classified(status, code):
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp({}, status))).search("x")
    assert e.value.code == code


@pytest.mark.parametrize("body", [[], {"info": "OK"}, {"status": "1", "pois": {}}, {"status": "1", "pois": ["x"]}])
def test_http_200_wrong_structure_is_bad_reply(body):
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp(body))).search("x")
    assert e.value.code == "bad_reply"


def test_places_carry_terms_as_data():
    p = make(FakeTransport(resp(load("amap_place_text.json")))).search("x")[0]
    assert p.long_term_store_ok is False and p.long_term_fields == ()
    assert p.coords_cache_max_days == 0 and p.must_display_on == "amap"


@pytest.mark.parametrize("lng,lat", [(85.3147, 27.71864), (126.99778, 37.56829), (114.18306, 22.30693),
                                     (121.56833, 25.03583)])
def test_border_and_sar_results_not_converted_by_default(lng, lat):
    """加德满都、首尔、香港、台北：默认不换（港澳台见 coords 模块说明，候核）。"""
    body = {"status": "1", "info": "OK", "infocode": "10000",
            "pois": [{"name": "P", "location": f"{lng:.6f},{lat:.6f}", "typecode": "050500", "id": "X"}]}
    p = make(FakeTransport(resp(body))).search("x")[0]
    assert (p.lat, p.lng, p.crs_original) == (lat, lng, "WGS84")


def test_border_ambiguous_poi_is_flagged_and_not_converted():
    """芒街（Wikidata Q33204）：离国界 ≤3 公里 → 不换算，crs_original=WGS84，crs_ambiguous=True。"""
    body = {"status": "1", "info": "OK", "infocode": "10000",
            "pois": [{"name": "P", "location": "107.967948,21.529809", "typecode": "050500", "id": "X"}]}
    p = make(FakeTransport(resp(body))).search("x")[0]
    assert (p.lat, p.lng) == (21.529809, 107.967948) and p.crs_original == "WGS84" and p.crs_ambiguous is True


def test_to_storable_drops_all_provider_content():
    p = make(FakeTransport(resp(load("amap_place_text.json")))).search("x")[0]
    st = p.to_storable()
    assert st["restricted"] is True and st["source"] == "amap" and st["must_display_on"] == "amap"
    assert "provider_id" not in st and "title" not in st and "lat" not in st and "original" not in st


# ── adcode 决定换不换 ─────────────────────────────────────────────────────────────────
# adcode 取自高德官方城市编码表 https://a.amap.com/lbs/static/code_resource/AMap_adcode_citycode.zip
# （经 https://lbs.amap.com/api/webservice/download ）；城市坐标取自 Wikidata（Q 号见名字）。
# adcode 在回包里的位置：POI 2.0 pois[].adcode（默认返回）
# https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch ；地理编码 geocodes[].adcode
# https://lbs.amap.com/api/webservice/guide/api/georegeo
BORDER_CITIES = [("丹东 Q75110 / 元宝区", 40.116667, 124.383333, "210602"),
                 ("东兴 Q1241481 / 东兴市", 21.583333, 108.05, "450681"),
                 ("瑞丽 Q1355911 / 瑞丽市", 24.01151, 97.85798, "533102")]


def _gcj(lat, lng):
    d1, d2 = coords._delta(lat, lng)               # 纯公式正向（不看范围），模拟高德给的 GCJ-02
    return lat + d1, lng + d2


def _poi(lat, lng, adcode=None):
    p = {"name": "P", "location": f"{lng:.7f},{lat:.7f}", "typecode": "050500", "id": "X"}
    if adcode is not None:
        p["adcode"] = adcode
    return {"status": "1", "info": "OK", "infocode": "10000", "pois": [p]}


@pytest.mark.parametrize("name,lat,lng,adcode", BORDER_CITIES, ids=[b[0] for b in BORDER_CITIES])
def test_mainland_adcode_overrides_border_ambiguity(name, lat, lng, adcode):
    assert coords.china_status(lat, lng) in (coords.AMBIGUOUS, coords.IN)   # 丹东、瑞丽几何上=不确定；东兴=境内
    g = _gcj(lat, lng)
    p = make(FakeTransport(resp(_poi(*g, adcode)))).search("x")[0]
    assert p.crs_original == "GCJ-02" and p.crs_ambiguous is False
    assert coords.haversine_m(p.lat, p.lng, lat, lng) < TOL_M


AMBIG_CITIES = [b for b in BORDER_CITIES if coords.china_status(b[1], b[2]) == coords.AMBIGUOUS]


def test_ambiguous_border_cities_present():
    assert {b[0][:2] for b in AMBIG_CITIES} == {"丹东", "瑞丽"}


@pytest.mark.parametrize("name,lat,lng,adcode", AMBIG_CITIES, ids=[b[0] for b in AMBIG_CITIES])
def test_border_point_without_adcode_stays_ambiguous(name, lat, lng, adcode):
    g = _gcj(lat, lng)
    for body in (_poi(*g), _poi(*g, ""), _poi(*g, [])):
        p = make(FakeTransport(resp(body))).search("x")[0]
        assert p.crs_ambiguous is True and p.crs_original == "WGS84" and (p.lat, p.lng) == pytest.approx(g)


@pytest.mark.parametrize("adcode,lat,lng", [("810001", 22.2833, 114.1500), ("820000", 22.19, 113.54),
                                            ("710000", 25.03583, 121.56833)])
def test_sar_and_taiwan_adcodes_not_converted(adcode, lat, lng):
    p = make(FakeTransport(resp(_poi(lat, lng, adcode)))).search("x")[0]
    assert (p.lat, p.lng) == pytest.approx((lat, lng)) and p.crs_original == "WGS84" and p.crs_ambiguous is False


def test_sar_adcode_converted_when_region_opted_in(monkeypatch):
    monkeypatch.setenv("EPHEMERA_GCJ_REGIONS", "mainland,hk")
    w = (22.2833, 114.1500)
    p = make(FakeTransport(resp(_poi(*_gcj(*w), "810001")))).search("x")[0]
    assert p.crs_original == "GCJ-02" and coords.haversine_m(p.lat, p.lng, *w) < TOL_M


def test_geocode_uses_adcode_too():
    lat, lng, adcode = BORDER_CITIES[0][1:]
    g = _gcj(lat, lng)
    body = {"status": "1", "info": "OK", "infocode": "10000", "count": "1",
            "geocodes": [{"formatted_address": "辽宁省丹东市元宝区", "adcode": adcode, "location": f"{g[1]:.7f},{g[0]:.7f}"}]}
    p = make(FakeTransport(resp(body))).geocode("丹东")[0]
    assert p.crs_original == "GCJ-02" and coords.haversine_m(p.lat, p.lng, lat, lng) < TOL_M


@pytest.mark.parametrize("adcode,want", [("210602", "mainland"), ("110101", "mainland"), ("650100", "mainland"),
                                         ("810001", "hk"), ("820000", "mo"), ("710000", "tw"),
                                         ("", None), (None, None), ("900000", None), ("12345", None), ("abcdef", None)])
def test_adcode_region(adcode, want):
    assert coords.adcode_region(adcode) == want



# ── 地区标记 region：结果带上，发往高德时按它换 ─────────────────────────────────────────
DANDONG = BORDER_CITIES[0][1:3]          # Wikidata Q75110；几何判定=不确定（国界 3 公里内）
HK = (22.2833, 114.1500)                 # 香港中西区一带（高德编码表 810001 中西区）


def _around_loc(t):
    c = t.calls[-1]
    assert c["url"] == AROUND
    return _lnglat(c["params"]["location"])


def test_result_region_from_adcode_and_geometry():
    g = _gcj(*DANDONG)
    p = make(FakeTransport(resp(_poi(*g, "210602")))).search("x")[0]
    assert (p.region, p.region_source) == ("mainland", "adcode")
    q = make(FakeTransport(resp(_poi(*g)))).search("x")[0]
    assert (q.region, q.region_source) == (None, "geometry") and q.crs_ambiguous
    h = make(FakeTransport(resp(_poi(*HK, "810001")))).search("x")[0]
    assert (h.region, h.region_source) == ("hk", "adcode")


@pytest.mark.parametrize("near", [(*DANDONG, "mainland"), "place"])
def test_near_with_mainland_region_is_sent_as_gcj(near):
    if near == "place":                 # 一个带 region 的 Place（例如上次高德结果）当附近位置
        from ephemera_date.places.base import Place
        near = Place(title="丹东", lat=DANDONG[0], lng=DANDONG[1], source="amap", region="mainland",
                     region_source="adcode")
    t = FakeTransport(resp(load("amap_place_text.json")))
    make(t).search("咖啡", near=near)
    assert coords.haversine_m(*_around_loc(t), *_gcj(*DANDONG)) < 0.2


def test_near_without_region_at_border_is_not_converted():
    t = FakeTransport(resp(load("amap_place_text.json")))
    make(t).search("咖啡", near=DANDONG)
    assert _around_loc(t) == pytest.approx(DANDONG)


def test_walk_uses_regions_of_both_ends():
    t = FakeTransport(resp(load("amap_walk.json")))
    other = (40.13, 124.39)
    make(t).walk((*DANDONG, "mainland"), (*other, "mainland"))
    prm = t.calls[0]["params"]
    assert coords.haversine_m(*_lnglat(prm["origin"]), *_gcj(*DANDONG)) < 0.2
    assert coords.haversine_m(*_lnglat(prm["destination"]), *_gcj(*other)) < 0.2
    t2 = FakeTransport(resp(load("amap_walk.json")))
    make(t2).walk(DANDONG, other)                                   # 没有 region：国界附近不换
    assert _lnglat(t2.calls[0]["params"]["origin"]) == pytest.approx(DANDONG)


def test_hk_region_not_converted_by_default(monkeypatch):
    t = FakeTransport(resp(load("amap_place_text.json")))
    make(t).search("咖啡", near=(*HK, "hk"))
    assert _around_loc(t) == pytest.approx(HK)
    monkeypatch.setenv("EPHEMERA_GCJ_REGIONS", "mainland,hk")
    t2 = FakeTransport(resp(load("amap_place_text.json")))
    make(t2).search("咖啡", near=(*HK, "hk"))
    assert coords.haversine_m(*_around_loc(t2), *_gcj(*HK)) < 0.2


def test_bad_region_rejected():
    with pytest.raises(PlaceError) as e:
        make(FakeTransport(resp({}))).search("x", near=(*DANDONG, "moon"))
    assert e.value.code == "bad_query"


def test_to_storable_keeps_region():
    p = make(FakeTransport(resp(_poi(*_gcj(*DANDONG), "210602")))).search("x")[0]
    st = p.to_storable()
    assert st["restricted"] is True and (st["region"], st["region_source"]) == ("mainland", "adcode")
