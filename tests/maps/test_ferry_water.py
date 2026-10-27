"""Ferry crossings in the walking network, and "the start / end is on the water" when no route is found.

Own synthetic OSM data (a made-up spot near 30N 120E, no real place): two small street grids on either side of a
water polygon (a river); ferry A is a way tagged route=ferry from a west grid node to an east pier that is not on
the east grid (about 19 m off it); ferry B is an untagged way that is the member of a type=route + route=ferry
relation; a long footbridge loops round the north. Crop -> build -> route, no network.
"""
from __future__ import annotations

import math

import pytest

from ephemera_date.maps import MapStore, build_map, walk_between
from ephemera_date.maps import build as B
from ephemera_date.maps import render as R

LAT0, LON0, STEP = 30.0, 120.0, 0.001
WEST_LON = [LON0 + k * STEP for k in range(4)]                 # 120.000 .. 120.003
EAST_LON = [LON0 + 0.007 + k * STEP for k in range(4)]         # 120.007 .. 120.010
BBOX = (29.994, 30.009, 119.999, 120.011)
RIVER_PT = (30.001, 120.005)                                    # in the river, ~190 m from either bank


def w(i, j):
    return 1000 + i * 10 + j


def e(i, j):
    return 2000 + i * 10 + j


def _xml() -> str:
    nodes, ways, rels = [], [], []

    def node(nid, lat, lon):
        nodes.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}"/>')

    def way(wid, refs, tags):
        nd = "".join(f'<nd ref="{r}"/>' for r in refs)
        t = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags.items())
        ways.append(f'<way id="{wid}" version="1">{nd}{t}</way>')

    for i in range(4):
        for j in range(4):
            node(w(i, j), LAT0 + i * STEP, WEST_LON[j])
            node(e(i, j), LAT0 + i * STEP, EAST_LON[j])
    wid = 100
    for i in range(4):
        way(wid, [w(i, j) for j in range(4)], {"highway": "residential"})
        way(wid + 1, [e(i, j) for j in range(4)], {"highway": "residential"})
        way(wid + 2, [w(j, i) for j in range(4)], {"highway": "residential"})
        way(wid + 3, [e(j, i) for j in range(4)], {"highway": "residential"})
        wid += 4
    # the river: a closed water way between the two grids
    for k, (a, b) in enumerate([(29.995, 120.0035), (29.995, 120.0065), (30.008, 120.0065), (30.008, 120.0035)]):
        node(3001 + k, a, b)
    way(300, [3001, 3002, 3003, 3004, 3001], {"natural": "water", "name": "River"})
    # ferry A: west grid node (1, 3) -> an east pier ~19 m west of east grid node (1, 0), not on any street
    node(4001, LAT0 + 1 * STEP, EAST_LON[0] - 0.0002)
    way(400, [w(1, 3), 4001], {"route": "ferry", "name": "Ferry A"})
    # ferry B: an untagged way, member of a route=ferry relation, between two grid nodes
    node(4101, LAT0 + 2.5 * STEP, LON0 + 0.005)
    way(401, [w(2, 3), 4101, e(3, 0)], {})
    rels.append('<relation id="900" version="1"><member type="way" ref="401" role=""/>'
                '<tag k="type" v="route"/><tag k="route" v="ferry"/><tag k="name" v="Ferry B"/></relation>')
    # footbridge round the north: west (3, 0) -> up -> across -> down -> east (3, 3)
    node(5001, 30.0065, WEST_LON[0])
    node(5002, 30.0065, EAST_LON[3])
    way(500, [w(3, 0), 5001, 5002, e(3, 3)], {"highway": "footway", "bridge": "yes"})
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="ephemera-tests">\n'
            + "\n".join(nodes + ways + rels) + "\n</osm>\n")


@pytest.fixture(scope="module")
def ferry_db(tmp_path_factory):
    d = tmp_path_factory.mktemp("ferrymap")
    src = d / "ferry.osm"
    src.write_text(_xml(), encoding="utf-8")
    out = d / "ferry.sqlite"
    st = B.build_city(src, out, BBOX, buffer_m=0, workdir=d, name="ferry")
    return out, st


@pytest.fixture
def store(ferry_db):
    R._cache.clear()
    return MapStore(ferry_db[0])


def _m(lat1, lon1, lat2, lon2):
    return R._hav(lat1, lon1, lat2, lon2)


def test_build_keeps_ferry_ways_and_route_relation_members(ferry_db):
    out, st = ferry_db
    assert st["build"]["ferries"] == 2
    import sqlite3
    c = sqlite3.connect(out)
    try:
        rows = c.execute("SELECT id, flags FROM way WHERE cls='ferry' ORDER BY id").fetchall()
    finally:
        c.close()
    assert rows == [(400, 1 | B.FLAG_FERRY), (401, 1 | B.FLAG_FERRY)]


def test_walk_crosses_by_ferry_with_ride_and_wait_minutes(store):
    o, d = (LAT0 + STEP, WEST_LON[0]), (LAT0 + STEP, EAST_LON[3])
    r = walk_between(o, d, store)
    assert r.reason is None and len(r.ferry) == 1
    ride_m = _m(LAT0 + STEP, WEST_LON[3], LAT0 + STEP, EAST_LON[0] - 0.0002)
    assert r.ferry[0]["meters"] == round(ride_m)
    assert r.ferry[0]["minutes"] == math.ceil(ride_m / 1000 * 4 + 10)          # defaults: 4 min/km + 10 min wait
    walk_m = r.meters - r.ferry[0]["meters"]
    assert walk_m == pytest.approx(_m(*o, LAT0 + STEP, WEST_LON[3]) + _m(LAT0 + STEP, EAST_LON[0] - 0.0002,
                                                                           LAT0 + STEP, EAST_LON[0])
                                   + _m(LAT0 + STEP, EAST_LON[0], *d), abs=2)
    assert r.minutes == math.ceil(walk_m / 75) + r.ferry[0]["minutes"]


def test_ferry_times_follow_config(store, monkeypatch):
    monkeypatch.setenv("EPHEMERA_FERRY_MIN_PER_KM", "10")
    monkeypatch.setenv("EPHEMERA_FERRY_WAIT_MIN", "0")
    r = walk_between((LAT0 + STEP, WEST_LON[0]), (LAT0 + STEP, EAST_LON[3]), store)
    ride_m = _m(LAT0 + STEP, WEST_LON[3], LAT0 + STEP, EAST_LON[0] - 0.0002)
    assert r.ferry[0]["minutes"] == math.ceil(ride_m / 1000 * 10)


def test_ferry_only_when_faster_long_wait_takes_the_bridge(store, monkeypatch):
    monkeypatch.setenv("EPHEMERA_FERRY_WAIT_MIN", "600")
    r = walk_between((LAT0 + STEP, WEST_LON[0]), (LAT0 + STEP, EAST_LON[3]), store)
    assert r.reason is None and r.ferry == ()
    assert r.minutes == math.ceil(r.meters / 75) and r.meters > 1500           # the long way round, all on foot


def test_map_marks_the_ferry_part_of_the_leg_and_draws_ferry_layer(store):
    view = {"stops": [{"n": 1, "place": {"lat": LAT0 + STEP, "lng": WEST_LON[0]}},
                      {"n": 2, "place": {"lat": LAT0 + STEP, "lng": EAST_LON[3], "leg": {"mode": "walk"}}}]}
    m = build_map(view, store)
    assert len(m["layers"]["ferry"]) == 2
    leg = m["legs"][0]
    assert leg["kind"] == "walk" and leg["has_ferry"] is True and leg["reason"] is None
    (f,) = leg["ferry"]
    assert len(f["pts"]) >= 2 and f["minutes"] >= 11 and f["meters"] > 300
    assert leg["minutes"] == math.ceil((leg["meters"] - f["meters"]) / 75) + f["minutes"]
    assert m["stats"]["ferry_legs"] == 1 and m["stats"]["walk_minutes"] == leg["minutes"]
    same_bank = build_map({"stops": [view["stops"][0], {"n": 2, "place": {"lat": LAT0 + 3 * STEP, "lng": WEST_LON[0],
                                                                           "leg": {"mode": "walk"}}}]}, store)
    assert same_bank["legs"][0]["has_ferry"] is False and same_bank["legs"][0]["ferry"] == []


def test_end_on_water_says_which_end(store):
    land = (LAT0 + STEP, WEST_LON[0])
    r = walk_between(land, RIVER_PT, store)
    assert r.minutes is None and r.reason == "on_water"
    assert r.reason_text == "终点在水面上（可能是坐标偏了，比如把国内地图的坐标当成了 GPS 坐标），找不到能走的路"
    r = walk_between(RIVER_PT, land, store)
    assert r.reason_text.startswith("起点在水面上（")
    r = walk_between(RIVER_PT, (30.0, 120.005), store)
    assert r.reason_text.startswith("起点和终点在水面上（")


def test_end_on_water_reaches_map_legs_and_the_ai_receipt(store, monkeypatch):
    view = {"stops": [{"n": 1, "place": {"lat": LAT0 + STEP, "lng": WEST_LON[0]}},
                      {"n": 2, "place": {"lat": RIVER_PT[0], "lng": RIVER_PT[1], "leg": {"mode": "walk"}}}]}
    leg = build_map(view, store)["legs"][0]
    assert leg["kind"] == "straight" and leg["reason"] == "on_water" and leg["minutes"] is None
    assert leg["reason_text"].startswith("终点在水面上（")

    import asyncio
    from ephemera_date import tools as dt
    monkeypatch.setenv("EPHEMERA_MAP_DIR", str(store.maps[0].path.parent))     # default walk port = local network
    text, err = asyncio.run(dt.call("date_route", {"mode": "walk", "from": f"{LAT0 + STEP},{WEST_LON[0]}",
                                                   "to": f"{RIVER_PT[0]},{RIVER_PT[1]}"}))
    assert err and text.startswith("步行时间查不了，终点在水面上（可能是坐标偏了，比如把国内地图的坐标当成了 GPS 坐标），"
                                   "找不到能走的路。")
    text, err = asyncio.run(dt.call("date_route", {"mode": "walk", "from": f"{LAT0 + STEP},{WEST_LON[0]}",
                                                   "to": f"{LAT0 + STEP},{EAST_LON[3]}"}))
    assert not err and "（含轮渡 1 段，坐船加等船约 " in text and "分钟，已算进总时间；船期按你知道的核对）" in text
