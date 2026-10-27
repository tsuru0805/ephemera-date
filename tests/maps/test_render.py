import math

import pytest

from ephemera_date.maps import REASONS, MapStore, MapUnavailable, build_map, minutes_for, walk_between
from ephemera_date.maps import render as R

from .conftest import LAT0, LON0, STEP, gpt


def stop(n, pt, leg=None, **kw):
    place = {"lat": pt[0], "lng": pt[1]}
    if leg:
        place["leg"] = leg
    place.update(kw)
    return {"n": n, "place": place}


@pytest.fixture
def store(basemap):
    R._cache.clear()
    return MapStore(basemap.parent)


def row_m(cols):
    return cols * STEP * math.cos(math.radians(LAT0)) * 111320


def test_walk_minutes_from_network_distance(store):
    m = build_map({"stops": [stop(1, gpt(0, 0)), stop(2, gpt(0, 10), {"mode": "walk"})]}, store)
    leg = m["legs"][0]
    assert leg["kind"] == "walk" and leg["reason"] is None
    assert leg["meters"] == pytest.approx(row_m(10), rel=0.01)
    assert leg["minutes"] == math.ceil(leg["meters"] / 75)          # 4.5 km/h = 75 m/分
    assert m["stats"]["walk_minutes"] == leg["minutes"] and m["stats"]["speed_kmh"] == 4.5


def test_walk_follows_grid_not_straight_line(store):
    m = build_map({"stops": [stop(1, gpt(0, 0)), stop(2, gpt(5, 5), {"mode": "walk"})]}, store)
    leg = m["legs"][0]
    straight = R._hav(*gpt(0, 0), *gpt(5, 5))
    assert leg["meters"] > straight * 1.3                              # 走格子，不是直线
    assert leg["meters"] == pytest.approx(row_m(5) + 5 * STEP * 110540, rel=0.02)


def test_speed_is_configurable(store, monkeypatch):
    monkeypatch.setenv("EPHEMERA_WALK_SPEED_KMH", "3")
    m = build_map({"stops": [stop(1, gpt(0, 0)), stop(2, gpt(0, 10), {"mode": "walk"})]}, store)
    assert m["legs"][0]["minutes"] == math.ceil(m["legs"][0]["meters"] / 50)
    m2 = build_map({"stops": [stop(1, gpt(0, 0)), stop(2, gpt(0, 10), {"mode": "walk"})]}, store, speed_kmh=6)
    assert m2["legs"][0]["minutes"] == math.ceil(m2["legs"][0]["meters"] / 100)


def test_minutes_for():
    assert minutes_for(1, 4.5) == 1 and minutes_for(75, 4.5) == 1 and minutes_for(76, 4.5) == 2


def test_disconnected_network_reports_reason_no_fake_minutes(store):
    m = build_map({"stops": [stop(1, gpt(0, 0)), stop(2, (10.0200, 20.0205), {"mode": "walk"})]}, store)
    leg = m["legs"][0]
    assert leg["kind"] == "straight" and leg["minutes"] is None and leg["meters"] is None
    assert leg["reason"] == "disconnected" and leg["reason_text"] == REASONS["disconnected"]
    assert leg["straight_m"] > 0 and len(leg["pts"]) == 2           # 直线只作示意
    assert m["stats"]["walk_legs_without_network"] == 1 and m["stats"]["walk_minutes"] == 0


def test_no_network_nearby(store):
    m = build_map({"stops": [stop(1, gpt(0, 0)), stop(2, (10.0200, 20.0050), {"mode": "walk"})]}, store)
    assert m["legs"][0]["reason"] == "no_network" and m["legs"][0]["reason_text"] == "这段没有路网数据"
    assert m["legs"][0]["minutes"] is None


def test_out_of_coverage(store):
    far = (10.0500, LON0 + 11 * STEP)              # 有路（Out Road 的端点），但在底图范围外
    m = build_map({"stops": [stop(1, gpt(0, 0)), stop(2, far, {"mode": "walk"})]}, store)
    assert m["legs"][0]["reason"] == "out_of_coverage" and m["legs"][0]["minutes"] is None
    assert [s["covered"] for s in m["stops"]] == [True, False]
    assert store.coverage(*far)["covered"] is False and store.coverage(*gpt(1, 1))["covered"] is True


def test_no_basemap_and_all_outside(tmp_path, store):
    empty = MapStore(tmp_path / "nothing")
    with pytest.raises(MapUnavailable) as e:
        build_map({"stops": [stop(1, gpt(0, 0))]}, empty)
    assert e.value.code == "no_basemap"
    assert empty.coverage(1, 2)["reason"] == "no_basemap"
    with pytest.raises(MapUnavailable) as e:
        build_map({"stops": [stop(1, (40.0, 40.0))]}, store)
    assert e.value.code == "out_of_coverage"


def test_walk_between(store):
    r = walk_between(gpt(0, 0), gpt(0, 10), store)
    assert r.source == "local" and r.minutes == math.ceil(r.meters / 75) and r.pts
    r2 = walk_between(gpt(0, 0), (10.0200, 20.0205), store)
    assert r2.minutes is None and r2.reason == "disconnected"
    r3 = walk_between((40, 40), (40.01, 40.01), store)
    assert r3.minutes is None and r3.reason == "out_of_coverage"
    r4 = walk_between(gpt(0, 0), (10.05, LON0 + 11 * STEP), store)
    assert r4.reason == "out_of_coverage"


def test_transit_leg_follows_rail_between_named_stations(store):
    a, b = (LAT0 + 13 * STEP, LON0), (LAT0 + 13 * STEP, LON0 + 10 * STEP)
    m = build_map({"stops": [stop(1, a), stop(2, b, {"mode": "train",
                                                    "steps": [{"board": "Alpha", "alight": "Beta", "line": "Line A"}]})]},
                  store)
    leg = m["legs"][0]
    assert leg["kind"] == "transit" and leg["meters"] == pytest.approx(row_m(10), rel=0.02)
    assert leg["minutes"] is None and leg["reason"] == "not_walk"
    assert m["stats"]["transit_legs"] == 1


def test_output_shape_layers_and_attribution(store):
    m = build_map({"stops": [stop(1, gpt(2, 2)), {"n": 2, "no_place": True, "place": None},
                             stop(3, gpt(6, 6), {"mode": "walk"}, walk_path=[list(gpt(6, 6)), list(gpt(6, 8))])]},
                  store)
    assert set(m["layers"]) == {"major", "minor", "tiny", "motor", "rail", "river", "water", "park", "ferry"}
    assert m["layers"]["minor"] and m["layers"]["park"] and m["layers"]["water"]
    assert m["attribution"] == "© OpenStreetMap contributors" and m["basemap"] == "synthetic"
    assert [s["n"] for s in m["stops"]] == [1, 3]                       # 「一件事」不进地图
    assert m["legs"][0]["n"] == 3                                        # 起点=往前第一个有地点的站
    assert m["walk_paths"][0]["minutes"] == math.ceil(m["walk_paths"][0]["meters"] / 75)
    assert m["area"] == "ALPHA"                                          # 最近车站英文名
    assert set(m) == {"W", "H", "layers", "stops", "legs", "walk_paths", "stats", "area", "attribution", "basemap",
                      "fill_rule"}
    assert m["fill_rule"] == "evenodd"
    assert m["W"] >= R.MIN_SPAN_M and m["H"] >= R.MIN_SPAN_M


def test_unpublished_stops_are_not_drawn(store):
    m = build_map({"stops": [stop(1, gpt(0, 0)), {"n": 2, "place": None}]}, store)
    assert [s["n"] for s in m["stops"]] == [1] and m["legs"] == []


def test_empty_view():
    assert build_map({"stops": []}, MapStore([]))["empty"] is True


def test_db_path_with_spaces(basemap, tmp_path):
    d = tmp_path / "Application Support" / "maps"
    d.mkdir(parents=True)
    (d / "a b.sqlite").write_bytes(basemap.read_bytes())
    R._cache.clear()
    st = MapStore(d)
    assert st.maps and build_map({"stops": [stop(1, gpt(0, 0))]}, st)["basemap"] == "synthetic"


def test_default_store_uses_env_map_dir(basemap, monkeypatch):
    monkeypatch.setenv("EPHEMERA_MAP_DIR", str(basemap.parent))
    assert MapStore().maps and MapStore().maps[0].name == "synthetic"


# ── 裁剪 / 孔洞 / 吸附 / 障碍 / 窗口重试 / 示意 ───────────────────────────────────────
from .conftest import U_A, U_B  # noqa: E402


def test_clip_line_keeps_segment_crossing_box_without_vertices():
    assert R._clip_line([(-10, 5), (20, 5)], (0, 0, 10, 10)) == [[(0.0, 5.0), (10.0, 5.0)]]
    # 进框、出框、再进框：两段
    runs = R._clip_line([(-5, 5), (5, 5), (5, 15), (8, 15), (8, 5), (15, 5)], (0, 0, 10, 10))
    assert runs == [[(0.0, 5.0), (5.0, 5.0), (5.0, 10.0)], [(8.0, 10.0), (8.0, 5.0), (10.0, 5.0)]]
    assert R._clip_line([(-5, -5), (-1, -1)], (0, 0, 10, 10)) == []


def test_through_road_is_drawn(store):
    m = build_map({"stops": [stop(1, (10.030, 20.020))]}, store)
    assert m["layers"]["major"]                         # Through Road：地图范围内没有它的顶点


def test_lake_with_island_is_one_evenodd_path(store):
    m = build_map({"stops": [stop(1, (10.005, 20.012))]}, store)
    holed = [d for d in m["layers"]["water"] if d.count("M") == 2 and d.count("Z") == 2]
    assert holed and m["fill_rule"] == "evenodd"


def test_snap_projects_onto_segment_not_nearest_node(store):
    # U 形路西脚（一条长 1.2 公里、只有两端两个节点的路）东侧约 33 米的两点：按最近节点吸附会绕到端点
    kx = math.cos(math.radians(10.027)) * 111320
    off = 0.0003 * kx
    p1, p2 = (10.027, U_A[1] + 0.0003), (10.029, U_A[1] + 0.0003)
    r = walk_between(p1, p2, store)
    assert r.meters == pytest.approx(2 * off + 0.002 * 110540, abs=3) and r.unverified_connector_m is None


def test_within_90m_counts_as_connected(store):
    r = walk_between((10.0055, 20.0055), gpt(0, 0), store)
    assert r.minutes is not None and r.unverified_connector_m is None


def test_river_200m_across_is_not_connected(store):
    south = (LAT0 - 0.0018, LON0 + 0.005)               # 河南岸约 200 米；最近的路在河北岸
    r = walk_between(south, gpt(5, 5), store)
    assert r.minutes is None and r.reason == "no_network"
    m = build_map({"stops": [stop(1, gpt(5, 5)), stop(2, south, {"mode": "walk"})]}, store)
    assert m["legs"][0]["minutes"] is None and m["legs"][0]["reason"] == "no_network"
    assert m["legs"][0]["schematic"] is True
    taxi = build_map({"stops": [stop(1, gpt(5, 5)), stop(2, south, {"mode": "taxi"})]}, store)
    assert taxi["legs"][0]["kind"] == "straight" and taxi["legs"][0]["reason"] == "no_network"   # 车行同规


def test_unobstructed_90_to_300m_connects_but_is_flagged(store):
    east = (10.005, 20.0125)                            # 网格最东一列以东约 164 米，中间无障碍
    r = walk_between(east, gpt(5, 5), store)
    assert r.minutes is not None
    assert r.unverified_connector_m == pytest.approx(0.0015 * math.cos(math.radians(10.005)) * 111320, abs=3)
    m = build_map({"stops": [stop(1, gpt(5, 5)), stop(2, east, {"mode": "walk"})]}, store)
    assert m["legs"][0]["unverified_connector_m"] == r.unverified_connector_m


def test_beyond_300m_is_no_network(store):
    r = walk_between((10.0105, 20.0145), gpt(5, 5), store)   # 网格东北约 380 米外(不在水面上)
    assert r.minutes is None and r.reason == "no_network"


def test_point_in_lake_without_road_says_on_water(store):
    r = walk_between((10.005, 20.0145), gpt(5, 5), store)   # 湖里,离路约 380 米
    assert r.minutes is None and r.reason == "on_water"
    assert r.reason_text == "起点在水面上（可能是坐标偏了，比如把国内地图的坐标当成了 GPS 坐标），找不到能走的路"


def test_window_expands_once_for_long_detour(store):
    r = walk_between(U_A, U_B, store)
    detour = 2 * (10.036 - 10.025) * 110540 + row_m(1)
    assert r.minutes is not None and r.meters == pytest.approx(detour, rel=0.02)
    m = build_map({"stops": [stop(1, U_A), stop(2, U_B, {"mode": "walk"})]}, store)
    assert m["legs"][0]["kind"] == "walk" and m["legs"][0]["search_margin_m"] == R.ROUTE_MARGIN_RETRY_M


def test_disconnected_after_expanded_window(store):
    m = build_map({"stops": [stop(1, gpt(0, 0)), stop(2, (10.0200, 20.0205), {"mode": "walk"})]}, store)
    leg = m["legs"][0]
    assert leg["reason"] == "disconnected" and "搜索范围" in leg["reason_text"]
    assert leg["search_margin_m"] == R.ROUTE_MARGIN_RETRY_M


def test_transit_without_rail_route_is_schematic(store):
    m = build_map({"stops": [stop(1, (LAT0 + 13 * STEP, LON0)),
                             stop(2, gpt(5, 5), {"mode": "train", "steps": [{"board": "Alpha", "alight": "Nowhere"}]})]},
                  store)
    leg = m["legs"][0]
    assert leg["kind"] == "transit" and leg["schematic"] is True and leg["minutes"] is None
    ok = build_map({"stops": [stop(1, (LAT0 + 13 * STEP, LON0)),
                              stop(2, (LAT0 + 13 * STEP, LON0 + 10 * STEP),
                                   {"mode": "train", "steps": [{"board": "Alpha", "alight": "Beta"}]})]}, store)
    assert ok["legs"][0]["schematic"] is False



@pytest.mark.parametrize("alight,pt", [("Gamma", (LAT0 + 0.0130, LON0 + 0.0050)), ("Delta", (LAT0 + 0.0131, LON0 + 0.0080))])
def test_transit_to_area_or_relation_station_is_not_schematic(store, alight, pt):
    m = build_map({"stops": [stop(1, (LAT0 + 13 * STEP, LON0)),
                             stop(2, pt, {"mode": "train", "steps": [{"board": "Alpha", "alight": alight}]})]}, store)
    leg = m["legs"][0]
    assert leg["kind"] == "transit" and leg["schematic"] is False


def test_island_in_lake_is_not_water(basemap):
    """带岛湖：湖面上的点算水面，岛上的点不算（同一个面的环按 evenodd）。"""
    import sqlite3
    c = sqlite3.connect(basemap)
    c.row_factory = sqlite3.Row
    try:
        assert R._on_water(c, (10.003, 20.014)) is True      # 湖面
        assert R._on_water(c, (10.005, 20.016)) is False     # 湖中岛
    finally:
        c.close()
