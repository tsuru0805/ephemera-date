"""GCJ-02 换算与境内判定。

偏移公式对照点（公开测试/示例数据）：
- https://github.com/googollee/eviltransform （python/test.py、go/transform_test.go：上海、深圳、北京三点）
- https://github.com/wandergis/coordtransform （README 示例：wgs84togcj02(116.404, 39.915)）
国界两侧城市坐标：Natural Earth 1:10m Populated Places（公有领域，
https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip ，字段 latitude/longitude）。
港澳台是否偏移：默认不算（依据与「候核」说明见 coords 模块文档）。
沿海城市中心与海边点：Wikidata 的坐标（P625），按条目号标注（https://www.wikidata.org/wiki/<Q号>，2026-10-24 查）；
标「回归复现点」的两点是曾经判错过的原始坐标。标「约略」的是取整到两位小数的坐标。
"""
import random

import pytest

from ephemera_date.places import coords
from ephemera_date.places.base import CRS_GCJ02, CRS_WGS84

# (WGS 纬度, WGS 经度, GCJ 纬度, GCJ 经度)
CONTROL = [
    (31.1774276, 121.5272106, 31.17530398364597, 121.531541859215),      # 上海
    (22.543847, 113.912316, 22.540796131694766, 113.9171764808363),      # 深圳
    (39.911954, 116.377817, 39.91334545536069, 116.38404722455657),      # 北京
    (39.915, 116.404, 39.91640428150164, 116.41024449916938),            # 北京（coordtransform 示例）
]
FORWARD_TOL_DEG = 1e-6        # 正向与公开结果的允许误差（约 0.1 米）
INVERSE_TOL_M = 0.5           # 反向（迭代）回到原 WGS 点的允许误差

# 国界两侧（Natural Earth populated places 坐标）：名字, 纬度, 经度, 是否境内
BORDER = [
    ("加德满都 尼泊尔", 27.71864, 85.31470, False), ("廷布 不丹", 27.47299, 89.63901, False),
    ("拉萨", 29.64502, 91.10001, True), ("甘托克 印度", 27.33333, 88.61665, False),
    ("密支那 缅甸", 25.35963, 97.39275, False), ("昆明", 25.07193, 102.67803, True),
    ("丰沙里 老挝", 21.68330, 102.10000, False), ("河内 越南", 21.03527, 105.84807, False),
    ("谅山 越南", 21.84600, 106.75700, False), ("凭祥", 22.09737, 106.75668, True),
    ("丹东", 40.14555, 124.39164, True), ("新义州 朝鲜", 40.08586, 124.42128, False),
    ("平壤 朝鲜", 39.02139, 125.75275, False), ("延吉", 42.88230, 129.51276, True),
    ("黑河", 50.25002, 127.44601, True), ("布拉戈维申斯克 俄罗斯", 50.26661, 127.53334, False),
    ("符拉迪沃斯托克 俄罗斯", 43.13002, 131.91003, False), ("满洲里", 49.59998, 117.42998, True),
    ("二连浩特", 43.66156, 111.96546, True), ("乌兰巴托 蒙古", 47.91862, 106.91467, False),
    ("阿尔泰 蒙古", 46.39612, 95.84504, False), ("阿勒泰", 47.86660, 88.11663, True),
    ("阿拉木图 哈萨克斯坦", 43.32694, 76.91309, False), ("喀什", 39.47634, 75.96993, True),
    ("伊斯兰堡 巴基斯坦", 33.70194, 73.16469, False), ("列城 印度", 34.16156, 77.57229, False),
    ("和田", 37.09971, 79.92695, True), ("首尔", 37.56829, 126.99778, False), ("大阪", 34.75198, 135.45820, False),
    ("厦门（岛）", 24.45194, 118.07807, True), ("三亚（海南）", 18.25911, 109.50403, True),
    ("深圳", 22.55432, 114.12018, True), ("珠海", 22.27889, 113.56583, True),
    ("香港", 22.30693, 114.18306, False), ("澳门", 22.20300, 113.54505, False),
    ("台北", 25.03583, 121.56833, False), ("高雄", 22.63331, 120.26660, False),
    ("新加坡", 1.3521, 103.8198, False), ("摩纳哥", 43.7384, 7.4246, False), ("纽约", 40.7128, -74.0060, False),
]


# 沿海：名字（来源）, 纬度, 经度, 是否境内。每个城市至少一个市中心点 + 一个海边点
COAST = [
    ("厦门思明区中心（回归复现点）", 24.4798, 118.0894, True), ("厦门岛东岸（回归复现点）", 24.47, 118.17, True),
    ("厦门 Q68744", 24.479722, 118.081944, True), ("思明区 Q1374907", 24.45822, 118.07461, True),
    ("鼓浪屿 Q1025339", 24.4475, 118.061944, True),
    ("青岛市 Q170322", 36.116667, 120.4, True), ("青岛栈桥 Q8070114", 36.059594, 120.31495, True),
    ("大连市（en wiki Dalian）", 38.9, 121.6, True), ("大连星海广场 Q136542021", 38.885934, 121.579635, True),
    ("大连老虎滩 Q13722876", 38.888328, 121.680786, True),
    ("舟山定海区 Q1226419", 30.019444, 122.102778, True), ("舟山沈家门 Q11138177", 29.95763, 122.29802, True),
    ("深圳蛇口 Q3138761", 22.486, 113.911, True), ("蛇口邮轮中心 Q28416063", 22.468485, 113.913648, True),
    ("珠海拱北口岸 Q877129", 22.2186, 113.549, True), ("珠海渔女 Q15908646", 22.26539, 113.58322, True),
    ("北海市 Q210365", 21.466667, 109.1, True), ("北海银滩 Q10903667", 21.408706, 109.140308, True),
    ("海口市 Q189823", 20.02, 110.32, True), ("海口假日海滩 Q15224497", 20.079167, 110.389167, True),
    ("海口世纪大桥 Q5639139", 20.051806, 110.315556, True),
    ("汕头市 Q59100", 23.353889, 116.682222, True), ("汕头礐石 Q14343317", 23.3, 116.683333, True),
    ("汕头海湾大桥 Q7489099", 23.331883, 116.744884, True),
    # 深圳湾口岸两侧：深圳一侧 / 香港一侧
    ("深圳湾口岸 Q5972370", 22.503889, 113.944722, True), ("深圳湾公园 Q20716864", 22.52203, 113.95811, True),
    ("香港流浮山 Q6497612", 22.4678, 113.983, False), ("香港天水围 Q3135371", 22.4603, 114.003, False),
    ("香港沙头角 Q841517", 22.54569, 114.22379, False), ("香港罗湖 Q6663209", 22.5275, 114.115, False),
    # 近邻：金门、马祖（Natural Earth 里属 TWN）、澳门、朝鲜新义州
    ("金门（约略）", 24.43, 118.32, False), ("金门县 Q10726562", 24.436162, 118.317454, False),
    ("马祖（约略）", 26.16, 119.95, False), ("南竿乡 Q702125", 26.1598, 119.943164, False),
    ("澳门 en wiki Macau", 22.19, 113.54, False), ("新义州 Q156243", 40.1, 124.4, False),
    ("丹东 Q75110", 40.116667, 124.383333, True), ("东兴 Q1241481", 21.583333, 108.05, True),
]


@pytest.mark.parametrize("name,lat,lng,inside", COAST, ids=[c[0] for c in COAST])
def test_coastal_city_centers_and_seaside(name, lat, lng, inside):
    _expect(lat, lng, inside)


def test_coast_tolerance_is_bounded():
    # 厦门岛东岸往东逐步离岸：近岸算，离边界超过 2 公里（且不在金门一侧）就不算
    assert coords.in_china(24.47, 118.17)
    assert not coords.in_china(24.47, 118.26)
    # 南海里远离海岸的点
    assert not coords.in_china(21.0, 113.0)


def test_coast_tolerance_never_pulls_in_sar_with_opt_in_flipped(monkeypatch):
    monkeypatch.setenv("EPHEMERA_GCJ_REGIONS", "mainland,hk")
    assert coords.in_china(22.4603, 114.003)                     # 选中香港后，天水围算
    assert not coords.in_china(24.436162, 118.317454)           # 金门仍不算
    assert not coords.in_china(22.19, 113.54)                   # 澳门仍不算


@pytest.mark.parametrize("wlat,wlng,glat,glng", CONTROL)
def test_forward_matches_public_control_points(wlat, wlng, glat, glng):
    la, lo = coords.wgs84_to_gcj02(wlat, wlng)
    assert abs(la - glat) < FORWARD_TOL_DEG and abs(lo - glng) < FORWARD_TOL_DEG


@pytest.mark.parametrize("wlat,wlng,glat,glng", CONTROL)
def test_inverse_returns_to_wgs_within_tolerance(wlat, wlng, glat, glng):
    la, lo = coords.gcj02_to_wgs84(glat, glng)
    assert coords.haversine_m(la, lo, wlat, wlng) < INVERSE_TOL_M


def test_offset_is_hundreds_of_meters_inside_china():
    wlat, wlng, glat, glng = CONTROL[0]
    assert 100 < coords.haversine_m(wlat, wlng, glat, glng) < 1000


def _near_land_border(lat, lng):
    return coords._nearest_boundaries(lat, lng, coords._index(coords._regions())["grid"])["nb"] <= coords.BORDER_AMBIGUOUS_M


def _expect(lat, lng, inside):
    """inside=True：必须 in，离陆地国界 ≤3 公里时允许 ambiguous；False：必须 out，同理允许 ambiguous。绝不反判。"""
    st = coords.china_status(lat, lng)
    want = coords.IN if inside else coords.OUT
    assert st == want or (st == coords.AMBIGUOUS and _near_land_border(lat, lng)), st


@pytest.mark.parametrize("name,lat,lng,inside", BORDER, ids=[b[0] for b in BORDER])
def test_in_china_both_sides_of_borders(name, lat, lng, inside):
    _expect(lat, lng, inside)
    if not inside:
        assert coords.wgs84_to_gcj02(lat, lng) == (lat, lng)
        assert coords.gcj02_to_wgs84(lat, lng) == (lat, lng)


# 口岸城市中心（Wikidata 坐标）：只能是 in 或 ambiguous，绝不判 out
PORT_CITIES = [("丹东 Q75110", 40.116667, 124.383333), ("东兴 Q1241481", 21.583333, 108.05),
               ("瑞丽 Q1355911", 24.01151, 97.85798), ("满洲里 Q890671", 49.588056, 117.4525),
               ("二连浩特 Q1001036", 43.6475, 111.97667), ("河口 Q1221725", 22.51179, 103.95988),
               ("凭祥 Q1027734", 22.100556, 106.750278), ("黑河 Q349983", 50.245833, 127.488611)]
# 对面的邻国口岸（Wikidata 坐标）：只能是 out 或 ambiguous，绝不判 in
PORT_NEIGHBORS = [("芒街 越南 Q33204", 21.529809, 107.967948), ("新义州 朝鲜 Q156243", 40.1, 124.4),
                  ("木姐 缅甸 Q3124743", 23.979167, 97.904722), ("老街 越南 Q32213510", 22.485556, 103.970556),
                  ("扎门乌德 蒙古 Q2084833", 43.718056, 111.906111),
                  ("布拉戈维申斯克 俄罗斯 Q6934", 50.257778, 127.536389)]


@pytest.mark.parametrize("name,lat,lng", PORT_CITIES, ids=[p[0] for p in PORT_CITIES])
def test_port_cities_never_out(name, lat, lng):
    assert coords.china_status(lat, lng) in (coords.IN, coords.AMBIGUOUS)


@pytest.mark.parametrize("name,lat,lng", PORT_NEIGHBORS, ids=[p[0] for p in PORT_NEIGHBORS])
def test_neighbor_port_towns_never_in(name, lat, lng):
    assert coords.china_status(lat, lng) in (coords.OUT, coords.AMBIGUOUS)
    assert coords.wgs84_to_gcj02(lat, lng) == (lat, lng)
    la, lo, changed, _ = coords.gcj02_to_wgs84_checked(lat, lng)
    assert (la, lo) == (lat, lng) and not changed


def test_mong_cai_is_ambiguous_not_inside():
    """Natural Earth 把芒街包进了中国多边形；离国界 ≤3 公里 → ambiguous，不换算。"""
    lat, lng = 21.529809, 107.967948
    assert coords.china_status(lat, lng) == coords.AMBIGUOUS and not coords.in_china(lat, lng)
    assert coords.gcj02_to_wgs84_checked(lat, lng) == (lat, lng, False, True)
    assert coords.wgs84_to_gcj02(lat, lng) == (lat, lng)


def test_sar_and_taiwan_can_be_opted_in(monkeypatch):
    monkeypatch.setenv("EPHEMERA_GCJ_REGIONS", "mainland,hk,mo,tw")
    assert coords.in_china(22.30693, 114.18306) and coords.in_china(22.203, 113.54505)
    assert coords.in_china(25.03583, 121.56833)
    assert not coords.in_china(27.71864, 85.31470)
    monkeypatch.setenv("EPHEMERA_GCJ_REGIONS", "mainland,xx")
    with pytest.raises(ValueError):
        coords.in_china(30, 110)


def test_round_trip_random_points_inside_china():
    rnd = random.Random(7)
    n = 0
    for _ in range(200):
        lat, lng = rnd.uniform(22, 41), rnd.uniform(102, 121)
        if not coords.in_china(lat, lng):
            continue
        n += 1
        g = coords.wgs84_to_gcj02(lat, lng)
        back = coords.gcj02_to_wgs84(*g)
        assert coords.haversine_m(*back, lat, lng) < 0.05
    assert n > 50


@pytest.mark.parametrize("lat,lng0,lng1", [
    (40.11, 124.30, 124.50),      # 丹东—新义州（鸭绿江）
    (50.26, 127.20, 127.60),      # 黑河—布拉戈维申斯克（黑龙江；西段离江 >3 公里）
    (22.52, 114.00, 114.20),      # 深圳—香港（深圳河）
    (22.21, 113.52, 113.60),      # 珠海—澳门
])
def test_consistent_decision_across_borders(lat, lng0, lng1):
    """沿一条穿过国界的线逐点扫：
    ① 境内（in）WGS 点 w：反向(正向(w)) ≈ w，或者反向明确报 ambiguous（不换，带标记）；
    ② 反向换了 → 正向回去等于输入，且原点与候选点都判 in；没换 → 原样返回；
    ③ ambiguous 恰好在「原点或候选点 ambiguous，或两者判定不一致」时为 True。"""
    steps = 300
    seen_in = seen_other = False
    for k in range(steps + 1):
        lng = lng0 + (lng1 - lng0) * k / steps
        w = (lat, lng)
        if coords.china_status(*w) == coords.IN:
            seen_in = True
            g = coords.wgs84_to_gcj02(*w)
            la, lo, _, amb = coords.gcj02_to_wgs84_checked(*g)
            assert amb or coords.haversine_m(la, lo, *w) < 0.05
        else:
            seen_other = True
            assert coords.wgs84_to_gcj02(*w) == w
        la, lo, changed, amb = coords.gcj02_to_wgs84_checked(*w)
        sg, sc = coords.china_status(*w), coords.china_status(*coords._inverse_formula(*w))
        assert amb == (coords.AMBIGUOUS in (sg, sc) or sg != sc)
        if changed:
            assert sg == sc == coords.IN
            assert coords.haversine_m(*coords.wgs84_to_gcj02(la, lo), *w) < 0.05
        else:
            assert (la, lo) == w
    assert seen_in and seen_other


def test_to_wgs84_only_converts_declared_gcj():
    wlat, wlng, glat, glng = CONTROL[1]
    assert coords.to_wgs84(wlat, wlng, CRS_WGS84) == (wlat, wlng)          # 手填/已入库的不再换
    la, lo = coords.to_wgs84(glat, glng, CRS_GCJ02)
    assert coords.haversine_m(la, lo, wlat, wlng) < INVERSE_TOL_M
    with pytest.raises(ValueError):
        coords.to_wgs84(1, 2, "BD-09")



@pytest.mark.parametrize("lat,lng,want", [
    (39.93084, 116.38634, "mainland"), (22.30693, 114.18306, "hk"), (22.203, 113.54505, "mo"),
    (25.03583, 121.56833, "tw"), (27.71864, 85.3147, "out"), (40.116667, 124.383333, None),
    (24.4798, 118.0894, "mainland")])
def test_geo_region(lat, lng, want):
    assert coords.geo_region(lat, lng) == want


@pytest.mark.parametrize("region,converted", [("mainland", True), ("hk", False), ("mo", False), ("tw", False),
                                              ("out", False)])
def test_to_gcj_for_amap_by_region(region, converted):
    lat, lng = 40.116667, 124.383333                      # 丹东（几何上不确定）
    la, lo, amb = coords.to_gcj_for_amap(lat, lng, region)
    assert ((la, lo) != (lat, lng)) is converted and amb is False
    la, lo, amb = coords.to_gcj_for_amap(lat, lng)        # 地区未知 → 几何判定：不确定，不换
    assert (la, lo, amb) == (lat, lng, True)
