import pytest

from ephemera_date.places import kinds

def _all_targets():
    yield from (("google", k, v) for k, v in kinds.GOOGLE_TYPE_MAP.items())
    yield from (("amap", k, v) for k, v in kinds.AMAP_TYPE_MAP.items() if v)
    yield from (("osm", k, v) for k, v in kinds.OSM_TYPE_MAP.items())


def test_every_mapping_targets_an_existing_kind_and_subtype():
    bad = [(src, k, v) for src, k, v in _all_targets()
           if v[0] not in kinds.SUBTYPES or (v[1] is not None and v[1] not in kinds.SUBTYPES[v[0]])]
    assert bad == []


def test_moment_is_never_a_classification_target():
    assert all(v[0] != kinds.MOMENT for _, _, v in _all_targets())


@pytest.mark.parametrize("primary,types,want", [
    ("restaurant", ["ramen_restaurant", "restaurant"], ("dinner", "拉面")),
    ("japanese_restaurant", ["japanese_restaurant", "restaurant"], ("dinner", "餐馆")),
    ("sushi_restaurant", [], ("dinner", "寿司")),
    ("cafe", ["cafe", "coffee_shop"], ("cafe", "咖啡馆")),
    ("train_station", [], ("train", "车站")),
    ("shinto_shrine", [], ("shrine", "神社")),
    ("tourist_attraction", ["point_of_interest"], (None, None)),
    (None, None, (None, None)),
])
def test_google_classify(primary, types, want):
    assert kinds.classify_google(primary, types) == want


def test_subtypes_copy_matches_the_engine_table():
    from ephemera_date import kinds as engine_kinds
    assert kinds.SUBTYPES == engine_kinds.SUBTYPES


def test_amap_codes_are_wellformed():
    """编码键：6 位数字，两位一层；中间一层是 00 时最后一层也是 00（整段兜底）。值是 (大类, 细类) 或 None。"""
    for code, v in kinds.AMAP_TYPE_MAP.items():
        assert len(code) == 6 and code.isdigit(), code
        assert code[:2] != "00", code
        if code[2:4] == "00":
            assert code[4:] == "00", code
        assert v is None or (isinstance(v, tuple) and len(v) == 2), code
    # 按编码抽查几条映射
    assert kinds.AMAP_TYPE_MAP["080302"] == ("play", "卡拉OK")
    assert kinds.AMAP_TYPE_MAP["150500"] == ("train", "地铁站")
    assert kinds.AMAP_TYPE_MAP["050500"] == ("cafe", "咖啡馆")


@pytest.mark.parametrize("code,want", [
    ("050117", ("dinner", "中餐")),         # 中式餐馆下的子码 → 回退到 050100
    ("050501", ("cafe", "咖啡馆")),          # 咖啡连锁子码 → 回退到 050500
    ("050202", ("dinner", None)),           # 日本料理：不猜细类
    ("080601", ("cinema", "电影院")),
    ("080302", ("play", "卡拉OK")),
    ("110104", ("aquarium", "水族馆")),
    ("150501", ("train", "地铁站")),          # 地铁站下的子码 → 回退到 150500
    ("150205", (None, None)),               # 火车站里的窗口子码：明确不分类，不回退到火车站
    ("060411", ("shopping", None)),         # 单独登记的子码：不回退成超市
    ("100105", ("stay", "酒店")),
    ("050999", ("sweets", "甜品店")),         # 没登记的 6 位编码 → 前 4 位 + 00
    ("059999", ("dinner", None)),           # 前 4 位也没登记 → 前 2 位 + 0000
    ("190000", (None, None)),               # 整段没登记：不分类
    ("150205|050500", ("cafe", "咖啡馆")),    # 多个编码：第一个不分类就看下一个
    ("", (None, None)), (None, (None, None)), ("abc", (None, None)),
])
def test_amap_classify(code, want):
    assert kinds.classify_amap(code) == want


@pytest.mark.parametrize("cls,typ,want", [
    ("amenity", "cafe", ("cafe", "咖啡馆")),
    ("tourism", "museum", ("museum", "博物馆")),
    ("railway", "station", ("train", "车站")),
    ("shop", "books", ("shopping", "书店")),
    ("shop", "bicycle", ("shopping", None)),       # shop 整类兜底
    ("highway", "residential", (None, None)),
    ("amenity", "parking", (None, None)),
    (None, None, (None, None)),
])
def test_osm_classify(cls, typ, want):
    assert kinds.classify_osm(cls, typ) == want
