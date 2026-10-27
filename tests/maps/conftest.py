"""地图测试：用手写的小块合成 OSM 数据（.osm XML）跑「裁剪 → 建库 → 渲染」全链路，不联网、不碰真实数据。

合成区域（纬度 10 度、经度 20 度附近的虚构网格，不对应任何真实地点）：
- 12×12 的住宅路网格（间距 0.001 度，约 110 米），全部连通；
- 网格北边一条铁路，两个车站 Alpha / Beta；一条河；一个公园（闭合路）；
- 一个水面多边形关系，外环有一部分伸到裁剪范围外（测成员补齐）；
- 网格东北远处一段孤立的人行道（测「路网不连通」）；
- 一条从网格伸出范围外的路（测整条保留）、一条完全在范围外的路与一栋建筑（测被丢掉）；
- 一条两端都在范围外、中间穿过范围的路（测几何相交）；
- 一个把整个范围包住的闭合公园、一个把范围包住且成员路全在范围外的多边形关系（测「包围」）；
- 一个成员里套关系的多边形关系（测「嵌套关系明确拒绝」）；
- 一个带岛的湖（多边形关系，外环 + 内环，测孔洞）；
- 东北一段 U 形路：两脚相距约 110 米，顶上的连接段在 1.2 公里外（测寻路窗口扩大重试）；
- 铁路边上两个不是节点的车站：Gamma 画成闭合路（railway=station），Delta 是车站关系（站台路 + 停车点节点）。
"""
from __future__ import annotations

import urllib.request
from pathlib import Path

import pytest

LAT0, LON0, STEP = 10.0, 20.0, 0.001
N = 12
CORE_BBOX = (LAT0 - 0.0035, LAT0 + 0.0415, LON0 - 0.0005, LON0 + 0.0415)   # (minlat, maxlat, minlon, maxlon)
U_A, U_B = (10.025, 20.030), (10.025, 20.031)      # U 形路两脚：只有绕到 1.2 公里外才连通


def gid(i, j):
    return 1000 + i * 100 + j          # i=行（纬度方向），j=列（经度方向）


def gpt(i, j):
    return LAT0 + i * STEP, LON0 + j * STEP


def _osm_xml() -> str:
    nodes, ways, rels = [], [], []

    def node(nid, lat, lon, tags=None):
        t = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in (tags or {}).items())
        nodes.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">{t}</node>')

    def way(wid, refs, tags):
        nd = "".join(f'<nd ref="{r}"/>' for r in refs)
        t = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags.items())
        ways.append(f'<way id="{wid}" version="1">{nd}{t}</way>')

    for i in range(N):
        for j in range(N):
            node(gid(i, j), *gpt(i, j))
    # 铁路与车站（网格北边一行，i=13）
    for j in range(N):
        tags = {}
        if j == 0:
            tags = {"railway": "station", "name": "Alpha站", "name:en": "Alpha"}
        if j == 10:
            tags = {"railway": "station", "name": "Beta", "name:en": "Beta"}
        node(5000 + j, LAT0 + 13 * STEP, LON0 + j * STEP, tags)
    # 河（网格南边）
    for j in range(N):
        node(6000 + j, LAT0 - 0.0003, LON0 + j * STEP)
    # 孤立人行道（东北远处）
    node(7001, 10.0200, 20.0200)
    node(7002, 10.0200, 20.0210)
    # 伸出范围外的路：从网格角 (11,11) 往北到 10.05
    node(7101, 10.0500, LON0 + 11 * STEP)
    # 完全在范围外的路
    node(7201, 10.2000, 20.2000)
    node(7202, 10.2010, 20.2000)
    # 建筑（范围内，应被丢掉）
    for k, (a, b) in enumerate([(0.0015, 0.0015), (0.0015, 0.0025), (0.0025, 0.0025), (0.0025, 0.0015)]):
        node(7301 + k, LAT0 + a, LON0 + b)
    # 公园（闭合路）
    for k, (a, b) in enumerate([(0.004, 0.004), (0.004, 0.006), (0.006, 0.006), (0.006, 0.004)]):
        node(7401 + k, LAT0 + a, LON0 + b)
    # 水面多边形关系：外环一半在范围外（经度 19.99 在 minlon 19.9995 之外）
    for k, (a, b) in enumerate([(0.008, -0.010), (0.008, 0.002), (0.010, 0.002), (0.010, -0.010)]):
        node(7501 + k, LAT0 + a, LON0 + b)

    wid = 100
    for i in range(N):
        way(wid, [gid(i, j) for j in range(N)], {"highway": "residential", "name": f"Row {i}"})
        wid += 1
    for j in range(N):
        way(wid, [gid(i, j) for i in range(N)], {"highway": "residential", "name": f"Col {j}"})
        wid += 1
    way(300, [5000 + j for j in range(N)], {"railway": "rail", "name": "Line A"})
    way(301, [6000 + j for j in range(N)], {"waterway": "river", "name": "River"})
    way(302, [7001, 7002], {"highway": "footway"})
    way(303, [gid(11, 11), 7101], {"highway": "tertiary", "name": "Out Road"})
    way(304, [7201, 7202], {"highway": "residential", "name": "Far Road"})
    way(305, [7301, 7302, 7303, 7304, 7301], {"building": "yes"})
    way(306, [7401, 7402, 7403, 7404, 7401], {"leisure": "park", "name": "Park"})
    way(307, [7501, 7502, 7503, 7504, 7501], {})            # 多边形外环本身不带标签
    rels.append('<relation id="900" version="1"><member type="way" ref="307" role="outer"/>'
                '<tag k="type" v="multipolygon"/><tag k="natural" v="water"/></relation>')
    # 穿框的路：两端都在范围外
    node(7601, 10.0300, 19.9900)
    node(7602, 10.0300, 20.0600)
    way(310, [7601, 7602], {"highway": "primary", "name": "Through Road"})
    # 包住整个范围的闭合公园
    for k, (a, b) in enumerate([(9.90, 19.90), (9.90, 20.10), (10.10, 20.10), (10.10, 19.90)]):
        node(7701 + k, a, b)
    way(311, [7701, 7702, 7703, 7704, 7701], {"leisure": "park", "name": "Big Park"})
    # 包住范围的多边形关系，两段成员路都在范围外
    for k, (a, b) in enumerate([(9.95, 19.95), (9.95, 20.05), (10.05, 20.05), (10.05, 19.95)]):
        node(7801 + k, a, b)
    way(312, [7801, 7802, 7803], {})
    way(313, [7803, 7804, 7801], {})
    rels.append('<relation id="902" version="1"><member type="way" ref="312" role="outer"/>'
                '<member type="way" ref="313" role="outer"/>'
                '<tag k="type" v="multipolygon"/><tag k="natural" v="wood"/></relation>')
    # 嵌套：成员里有关系
    rels.append('<relation id="903" version="1"><member type="relation" ref="902" role="outer"/>'
                '<member type="way" ref="307" role="outer"/>'
                '<tag k="type" v="multipolygon"/><tag k="natural" v="water"/></relation>')
    # 带岛的湖
    for k, (a, b) in enumerate([(10.002, 20.013), (10.002, 20.019), (10.008, 20.019), (10.008, 20.013)]):
        node(7901 + k, a, b)
    for k, (a, b) in enumerate([(10.004, 20.015), (10.004, 20.017), (10.006, 20.017), (10.006, 20.015)]):
        node(7911 + k, a, b)
    way(314, [7901, 7902, 7903, 7904, 7901], {})
    way(315, [7911, 7912, 7913, 7914, 7911], {})
    rels.append('<relation id="904" version="1"><member type="way" ref="314" role="outer"/>'
                '<member type="way" ref="315" role="inner"/>'
                '<tag k="type" v="multipolygon"/><tag k="natural" v="water"/><tag k="name" v="Island Lake"/></relation>')
    # U 形路
    node(8001, *U_A)
    node(8002, 10.036, U_A[1])
    node(8003, *U_B)
    node(8004, 10.036, U_B[1])
    way(320, [8001, 8002], {"highway": "residential", "name": "U West"})
    way(321, [8003, 8004], {"highway": "residential", "name": "U East"})
    way(322, [8002, 8004], {"highway": "residential", "name": "U Top"})
    # 画成面的车站 Gamma（铁路 j=5 附近）
    for k, (a, b) in enumerate([(0.0132, 0.0048), (0.0132, 0.0052), (0.0128, 0.0052), (0.0128, 0.0048)]):
        node(8101 + k, LAT0 + a, LON0 + b)
    way(330, [8101, 8102, 8103, 8104, 8101], {"railway": "station", "name": "Gamma站", "name:en": "Gamma"})
    # 车站关系 Delta（铁路 j=8 附近）：站台路 + 停车点
    node(8111, LAT0 + 0.0131, LON0 + 0.0078)
    node(8112, LAT0 + 0.0131, LON0 + 0.0082)
    node(8113, LAT0 + 0.0130, LON0 + 0.0080, {"public_transport": "stop_position", "railway": "stop"})
    way(331, [8111, 8112], {"railway": "platform"})
    rels.append('<relation id="905" version="1"><member type="way" ref="331" role="platform"/>'
                '<member type="node" ref="8113" role="stop"/>'
                '<tag k="public_transport" v="station"/><tag k="name" v="Delta"/><tag k="name:en" v="Delta"/>'
                '</relation>')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="ephemera-tests">\n'
            + "\n".join(nodes + ways + rels) + "\n</osm>\n")


@pytest.fixture(scope="session")
def osm_xml(tmp_path_factory) -> Path:
    p = tmp_path_factory.mktemp("osm") / "synthetic.osm"
    p.write_text(_osm_xml(), encoding="utf-8")
    return p


@pytest.fixture(scope="session")
def basemap(osm_xml, tmp_path_factory) -> Path:
    from ephemera_date.maps import build as B
    d = tmp_path_factory.mktemp("maps")
    out = d / "synthetic.sqlite"
    B.build_city(osm_xml, out, CORE_BBOX, buffer_m=0, workdir=d, name="synthetic")
    return out


@pytest.fixture(autouse=True)
def _no_network(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise AssertionError("测试里不许发真实网络请求")
    monkeypatch.setattr(urllib.request, "urlopen", boom)
    monkeypatch.setenv("EPHEMERA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("EPHEMERA_MAP_DIR", raising=False)
    monkeypatch.delenv("EPHEMERA_WALK_SPEED_KMH", raising=False)
