import sqlite3
import sys
from pathlib import Path

import pytest

from ephemera_date.maps import build as B

from .conftest import CORE_BBOX, gid

ROOT = Path(__file__).resolve().parents[2]


def _ids(path):
    import osmium
    nodes, ways, rels = set(), set(), set()
    for o in osmium.FileProcessor(str(path)):
        (nodes if o.is_node() else ways if o.is_way() else rels).add(o.id)
    return nodes, ways, rels


def test_crop_keeps_complete_ways_and_relation_members(osm_xml, tmp_path):
    out = tmp_path / "cut.osm.pbf"
    st = B.crop(osm_xml, CORE_BBOX, out)
    nodes, ways, rels = _ids(out)
    assert 303 in ways and 7101 in nodes             # 伸出范围外的路整条保留，范围外的节点也带上
    assert 304 not in ways and 7201 not in nodes     # 完全在范围外的丢掉
    assert 305 not in ways                           # 建筑轮廓不进（建库用不到）
    assert 900 in rels and 307 in ways               # 水面关系 + 成员
    assert {7501, 7502, 7503, 7504} <= nodes         # 成员外环的节点（一半在范围外）补齐
    assert {5000, 5010} <= nodes                     # 车站
    assert st["ways"] == len(ways) and st["bytes"] > 0


def test_build_meta_and_contents(basemap):
    c = sqlite3.connect(basemap)
    meta = dict(c.execute("SELECT k, v FROM meta"))
    assert meta["attribution"] == "© OpenStreetMap contributors" and meta["license"] == "ODbL-1.0"
    assert "ODbL" in meta["license_note"] and meta["format"] == "1" and meta["name"] == "synthetic"
    assert [float(x) for x in meta["bbox"].split(",")] == pytest.approx(list(CORE_BBOX))
    cls = dict(c.execute("SELECT cls, COUNT(*) FROM way GROUP BY cls"))
    assert cls["minor"] >= 27 and cls["rail"] == 1 and cls["river"] == 1
    assert cls["park"] == 3 and cls["water"] == 2       # 公园 + 大公园 + 林地关系；水面关系 + 带岛的湖
    assert cls.get("major") == 2                        # Out Road（tertiary）+ Through Road（primary）
    st = {r[0] for r in c.execute("SELECT name_en FROM station")}
    assert st == {"Alpha", "Beta", "Gamma", "Delta"}
    assert not Path(str(basemap) + ".building").exists()


def test_build_failure_leaves_no_half_db(tmp_path):
    out = tmp_path / "x.sqlite"
    bad = tmp_path / "bad.osm"
    bad.write_text("not osm", encoding="utf-8")
    with pytest.raises(Exception):
        B.build(bad, out)
    assert not out.exists()


def test_add_sea_is_repeatable(basemap, tmp_path):
    import shapefile
    db = tmp_path / "sea.sqlite"
    db.write_bytes(Path(basemap).read_bytes())
    shp = tmp_path / "water_polygons"
    w = shapefile.Writer(str(shp), shapeType=shapefile.POLYGON)
    w.field("x", "N")
    w.poly([[[20.005, 9.990], [20.030, 9.990], [20.030, 10.000], [20.005, 10.000], [20.005, 9.990]]])
    w.record(1)
    w.poly([[[30.0, 30.0], [31.0, 30.0], [31.0, 31.0], [30.0, 31.0], [30.0, 30.0]]])   # 范围外，不取
    w.record(2)
    w.close()
    assert B.add_sea(str(shp) + ".shp", db) == 1
    assert B.add_sea(str(shp) + ".shp", db) == 1
    c = sqlite3.connect(db)
    assert c.execute("SELECT COUNT(*) FROM way WHERE name='sea'").fetchone()[0] == 1


@pytest.mark.parametrize("s", ["1,2,3", "a,b,c,d", "20,10,19,11", "200,0,201,1"])
def test_parse_bbox_rejects_bad(s):
    with pytest.raises(B.BuildError):
        B.parse_bbox(s)


def test_parse_bbox_order():
    assert B.parse_bbox("20,10,21,11") == (10, 11, 20, 21)


def test_bbox_for_name_uses_provider():
    class P:
        def bbox(self, name):
            return (1.0, 2.0, 3.0, 4.0) if name == "Somewhere" else None
    assert B.bbox_for_name("Somewhere", P()) == (1.0, 2.0, 3.0, 4.0)
    with pytest.raises(B.BuildError):
        B.bbox_for_name("Nowhere", P())


def test_buffer_expands_bbox():
    la0, la1, lo0, lo1 = B.buffered((10.0, 10.01, 20.0, 20.01), 1000)
    assert la0 < 10.0 - 0.008 and la1 > 10.01 + 0.008 and lo0 < 20.0 - 0.008 and lo1 > 20.01 + 0.008


def test_cli_builds_and_prints_odbl(osm_xml, tmp_path, capsys):
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        import build_basemap
    finally:
        sys.path.pop(0)
    out = tmp_path / "cli.sqlite"
    rc = build_basemap.main(["--pbf", str(osm_xml), "--bbox", "19.9995,9.9965,20.0415,10.0415", "--buffer-m", "0",
                             "--out", str(out), "--workdir", str(tmp_path)])
    assert rc == 0 and out.exists()
    text = capsys.readouterr().out
    assert "© OpenStreetMap contributors" in text and "ODbL" in text
    rc = build_basemap.main(["--pbf", str(osm_xml), "--bbox", "1,2,3", "--out", str(out)])
    assert rc == 1


def test_grid_node_ids_present(basemap):
    from ephemera_date.maps.render import _decode
    c = sqlite3.connect(basemap)
    blob = c.execute("SELECT pts FROM way WHERE name='Row 0'").fetchone()[0]
    assert [n for n, _, _ in _decode(blob)[0]][:2] == [gid(0, 0), gid(0, 1)]


# ── 几何相交 / 嵌套关系 / 规模上限 / 负缓冲 ──────────────────────────────────────────
def test_crop_keeps_way_crossing_box_without_vertices_inside(osm_xml, tmp_path):
    out = tmp_path / "cut.osm.pbf"
    B.crop(osm_xml, CORE_BBOX, out)
    nodes, ways, _ = _ids(out)
    assert 310 in ways and {7601, 7602} <= nodes      # 两端都在框外的穿框路


def test_crop_keeps_areas_enclosing_the_box(osm_xml, tmp_path):
    out = tmp_path / "cut.osm.pbf"
    B.crop(osm_xml, CORE_BBOX, out)
    nodes, ways, rels = _ids(out)
    assert 311 in ways                                # 包住整个框的闭合公园
    assert 902 in rels and {312, 313} <= ways         # 包住框、成员全在框外的多边形关系
    assert {7801, 7802, 7803, 7804} <= nodes


def test_crop_rejects_nested_relation_and_reports(osm_xml, tmp_path):
    out = tmp_path / "cut.osm.pbf"
    st = B.crop(osm_xml, CORE_BBOX, out)
    _, _, rels = _ids(out)
    assert 903 not in rels and st["skipped_nested_relations"] == 1


def test_crop_keeps_lake_with_island(osm_xml, tmp_path):
    out = tmp_path / "cut.osm.pbf"
    B.crop(osm_xml, CORE_BBOX, out)
    _, ways, rels = _ids(out)
    assert 904 in rels and {314, 315} <= ways


@pytest.mark.parametrize("kw", [{"max_nodes": 10}, {"max_kept": 5}, {"max_memory_mb": 1}])
def test_crop_limits_raise_clear_error(osm_xml, tmp_path, kw):
    with pytest.raises(B.BuildError) as e:
        B.crop(osm_xml, CORE_BBOX, tmp_path / "x.osm.pbf", **kw)
    assert "上限" in str(e.value)


def test_negative_buffer_rejected(osm_xml, tmp_path, capsys):
    with pytest.raises(B.BuildError):
        B.build_city(osm_xml, tmp_path / "n.sqlite", CORE_BBOX, buffer_m=-10, workdir=tmp_path)
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        import build_basemap
    finally:
        sys.path.pop(0)
    rc = build_basemap.main(["--pbf", str(osm_xml), "--bbox", "19.9995,9.9965,20.0415,10.0415", "--buffer-m", "-1",
                             "--out", str(tmp_path / "n.sqlite")])
    assert rc == 1 and "负数" in capsys.readouterr().err


def test_bbox_for_name_default_provider_uses_data_dir_cache(tmp_path, monkeypatch):
    import json as _json

    from ephemera_date.places.base import HttpResponse
    monkeypatch.setenv("EPHEMERA_DATA_DIR", str(tmp_path / "dd"))
    fx = _json.loads((ROOT / "tests" / "places" / "fixtures" / "nominatim_geocode_huangpu.json").read_text("utf-8"))
    calls = []

    def transport(method, url, **kw):
        calls.append(url)
        return HttpResponse(200, _json.dumps(fx["body"]).encode())
    a = B.bbox_for_name("黄浦区, 上海", transport=transport)
    b = B.bbox_for_name("黄浦区, 上海", transport=transport)
    assert a == b and len(calls) == 1
    assert (tmp_path / "dd" / "places_cache.sqlite").exists()
    assert list((tmp_path / "dd" / "ratelimit").glob("*.lock"))



# ── 车站面/线/关系、各阶段规模上限 ───────────────────────────────────────────────────
def test_station_way_and_relation_become_station_points(basemap):
    c = sqlite3.connect(basemap)
    rows = {r[0]: r[1:] for r in c.execute("SELECT name_en, id, lat, lon FROM station")}
    gid_, glat, glon = rows["Gamma"]
    assert gid_ >= B.STATION_WAY_BASE and glat == pytest.approx(10.0130, abs=1e-4) and glon == pytest.approx(20.005, abs=1e-4)
    did, dlat, dlon = rows["Delta"]
    assert did >= B.STATION_REL_BASE and dlat == pytest.approx(10.01307, abs=1e-4) and dlon == pytest.approx(20.008, abs=1e-4)


def test_crop_keeps_station_relation_with_members(osm_xml, tmp_path):
    out = tmp_path / "cut.osm.pbf"
    B.crop(osm_xml, CORE_BBOX, out)
    nodes, ways, rels = _ids(out)
    assert 905 in rels and 331 in ways and {8111, 8112, 8113} <= nodes and 330 in ways


def test_crop_limit_checked_in_relation_prescan(osm_xml, tmp_path):
    with pytest.raises(B.BuildError) as e:
        B.crop(osm_xml, CORE_BBOX, tmp_path / "x.osm.pbf", max_kept=1)
    assert "关系预扫描" in str(e.value)


@pytest.mark.parametrize("kw", [{"max_nodes": 10}, {"max_kept": 3}, {"max_memory_mb": 1}])
def test_build_phase_limits(osm_xml, tmp_path, kw):
    out = tmp_path / "b.sqlite"
    with pytest.raises(B.BuildError) as e:
        B.build(osm_xml, out, **kw)
    assert "建库" in str(e.value) and "上限" in str(e.value)
    assert not out.exists() and not Path(str(out) + ".building").exists()


def test_build_city_passes_limits_to_build(osm_xml, tmp_path, monkeypatch):
    seen = {}
    real = B.build

    def spy(*a, **k):
        seen.update(k)
        return real(*a, **k)
    monkeypatch.setattr(B, "build", spy)
    B.build_city(osm_xml, tmp_path / "c.sqlite", CORE_BBOX, buffer_m=0, workdir=tmp_path, max_memory_mb=99999)
    assert seen["max_memory_mb"] == 99999 and seen["max_nodes"] == B.DEFAULT_MAX_NODES


# ── 建库各循环周期检查上限 ────────────────────────────────────────────────────────────
N_WAYS, N_AREAS, N_STREL = 400, 100, 120


@pytest.fixture(scope="module")
def many_osm(tmp_path_factory):
    """路多、面多、车站关系多的合成数据（虚构坐标，北纬 30 度、东经 40 度附近）。"""
    nodes, ways, rels = [], [], []
    nid = 1

    def node(lat, lon, tags=None):
        nonlocal nid
        t = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in (tags or {}).items())
        nodes.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">{t}</node>')
        nid += 1
        return nid - 1
    wid = 1
    for i in range(N_WAYS):
        a, b = node(30 + i * 1e-4, 40.0), node(30 + i * 1e-4, 40.001)
        ways.append(f'<way id="{wid}" version="1"><nd ref="{a}"/><nd ref="{b}"/><tag k="highway" v="residential"/></way>')
        wid += 1
    for i in range(N_AREAS):
        ring = [node(30 + i * 1e-4, 40.01), node(30 + i * 1e-4, 40.01005), node(30 + i * 1e-4 + 5e-5, 40.01005),
                node(30 + i * 1e-4 + 5e-5, 40.01)]
        nd = "".join(f'<nd ref="{r}"/>' for r in ring + ring[:1])
        ways.append(f'<way id="{wid}" version="1">{nd}<tag k="leisure" v="park"/></way>')
        wid += 1
    for i in range(N_STREL):
        n1, n2 = node(30 + i * 1e-4, 40.02), node(30 + i * 1e-4, 40.0201)
        p1, p2 = node(30 + i * 1e-4, 40.0202), node(30 + i * 1e-4, 40.0203)
        ways.append(f'<way id="{wid}" version="1"><nd ref="{p1}"/><nd ref="{p2}"/><tag k="railway" v="platform"/></way>')
        rels.append(f'<relation id="{i + 1}" version="1"><member type="node" ref="{n1}" role="stop"/>'
                    f'<member type="node" ref="{n2}" role="stop"/><member type="way" ref="{wid}" role="platform"/>'
                    f'<tag k="public_transport" v="station"/><tag k="name" v="S{i}"/></relation>')
        wid += 1
    p = tmp_path_factory.mktemp("many") / "many.osm"
    p.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6">\n' + "\n".join(nodes + ways + rels)
                 + "\n</osm>\n", encoding="utf-8")
    return p


@pytest.fixture
def spy_checks(monkeypatch):
    calls = []
    real = B._Limits.check

    def spy(self, n_nodes, n_kept, phase):
        calls.append((phase, n_nodes, n_kept))
        return real(self, n_nodes, n_kept, phase)
    monkeypatch.setattr(B._Limits, "check", spy)
    monkeypatch.setattr(B, "CHECK_EVERY", 25)
    return calls


def test_build_checks_periodically_during_ways_and_areas(many_osm, tmp_path, spy_checks):
    B.build(many_osm, tmp_path / "m.sqlite", max_nodes=10**9, max_kept=10**9, max_memory_mb=10**6)
    kept = [k for ph, _, k in spy_checks if ph == "建库"]
    mids = [k for k in kept if 0 < k < N_WAYS + N_AREAS]
    assert len(mids) >= 5 and mids == sorted(mids)          # 路/面处理途中就在查，不是只在最后


def test_build_way_area_phase_limit_aborts_midway(many_osm, tmp_path, spy_checks):
    out = tmp_path / "m.sqlite"
    with pytest.raises(B.BuildError) as e:
        B.build(many_osm, out, max_kept=200)
    assert "建库" in str(e.value)
    last = [k for ph, _, k in spy_checks if ph == "建库"][-1]
    assert 200 < last < N_WAYS + N_AREAS                     # 路/面还没处理完就停了
    assert not out.exists() and not Path(str(out) + ".building").exists()


def test_station_relation_phases_checked_periodically(many_osm, tmp_path, spy_checks):
    B.build(many_osm, tmp_path / "m.sqlite", max_nodes=10**9, max_kept=10**9, max_memory_mb=10**6)
    coord = [k for ph, _, k in spy_checks if ph == "车站关系坐标"]
    assert len(coord) >= 5 and coord == sorted(coord) and coord[0] < coord[-1]
    assert any(ph == "车站关系预扫描" for ph, _, _ in spy_checks)
    summ = [ph for ph, _, _ in spy_checks if ph == "车站关系汇总"]
    assert len(summ) >= 4                                     # 120 个关系、CHECK_EVERY=25：汇总写车站期间也在查


def test_station_relation_coordinate_phase_limit_aborts(many_osm, tmp_path, spy_checks):
    # 建库阶段对象数 = 路 400 + 面 100 = 500；车站关系坐标阶段 = 关系 120 + 成员节点 240 + 成员路顶点 240 = 600
    out = tmp_path / "m.sqlite"
    with pytest.raises(B.BuildError) as e:
        B.build(many_osm, out, max_kept=550)
    assert "车站关系坐标" in str(e.value)
    assert not out.exists() and not Path(str(out) + ".building").exists()
