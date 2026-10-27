"""Engine × places × maps wiring: the default ports, the map only ever sees what she may see, walking reasons
reaching the AI, and one whole date written by the AI (tools) and read by her (HTTP).

Synthetic basemap (conftest in this directory), an OSM stand-in (the real Nominatim adapter on a recorded-format
fake transport), tmp data dir, fake clock; no network (the root conftest refuses any outside connection).
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime

import pytest

from conftest import H, TAIL_RE, TZ
from ephemera_date import config, ports
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from ephemera_date.maps import render as R
from ephemera_date.places.base import HttpResponse
from ephemera_date.places.cache import QueryCache
from ephemera_date.places.config import PlacesConfig
from ephemera_date.places.nominatim import NominatimProvider
from ephemera_date.places.ratelimit import FileLimiter

from .conftest import gpt

P1, P2 = gpt(0, 0), gpt(0, 5)          # 集合 → 晚餐:同一片街格,步行
P3 = (10.0200, 20.0205)                # 电影:往东北 2 公里多(还没公开时不许把地图拉过去)


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


NOW0 = T(10, 20, 10)


def ok(r):
    assert r["ok"], r["errors"]
    return r


@pytest.fixture
def maps_on(basemap, monkeypatch):
    R._cache.clear()
    monkeypatch.setenv("EPHEMERA_MAP_DIR", str(basemap.parent))


@pytest.fixture
def her(api, monkeypatch):
    api.clock["now"] = NOW0
    monkeypatch.setattr(dt, "_now", lambda: api.clock["now"])
    return api


def make_plan(send=True, *, flower=False, p2=P2):
    """三站:集合 19:00(17:30 公开)→ 晚餐 19:30(步行,19:20 出发)→ 电影 21:00(20:40 才公开,打车)。
    flower=True:集合与晚餐之间插一件事(没有固定地点),晚餐的路段从集合站出发。"""
    pid = ok(dp.open_plan("The Evening\nScreening", "2026-10-28", "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="北门站", address="北门路3",
                                     clue="出口右手边", reveal_at="17:30", lat=P1[0], lng=P1[1]), now=NOW0))
    if flower:
        ok(dp.edit(pid, "add_stop", dict(kind="moment", time="19:15", title="一起买一束花", clue="你挑颜色",
                                         no_place=True), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="19:30", title="小馆", address="柳岸1",
                                     clue="河边的小门", lat=p2[0], lng=p2[1]), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="cinema", time="21:00", title="小影院", address="东岸2",
                                     clue="红色的门", reveal_at="20:40", lat=P3[0], lng=P3[1]), now=NOW0))
    st = dp.snapshot(pid, now=NOW0)["state"]["stops"]
    ids = [s["id"] for s in st]
    ok(dp.edit(pid, "set_leg", dict(to_stop=ids[-2], mode="walk", minutes=6, depart_time="19:20"), now=NOW0))
    ok(dp.edit(pid, "set_leg", dict(to_stop=ids[-1], mode="taxi", minutes=8, depart_time="20:45"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "wear", "text": "好走的鞋"}]), now=NOW0))
    if send:
        ok(dp.send(pid, now=NOW0))
    return pid, ids


def her_map(her, pid):
    r = her.get(f"/api/dates/{pid}/map", headers=H())
    assert r.status_code == 200, r.text
    return r.json()


# ── 地图只用已公开的站(没公开的站不许出现在地图上)───────────────────────────────────
def test_map_only_uses_revealed_places(her, maps_on):
    pid, _ = make_plan(p2=gpt(4, 6))                                            # 斜对角:沿街格要拐弯
    m = her_map(her, pid)
    assert m["empty"] is True and m["unplotted"] == []                          # 寄出时一站都没公开
    her.clock["now"] = T(10, 28, 19, 25)                                        # 前两站公开,第 3 站没
    v = dp.her_plan(pid, now=her.clock["now"])
    assert v["stops"][2]["place"] is None
    m = her_map(her, pid)
    assert [s["n"] for s in m["stops"]] == [1, 2]
    assert [lg["n"] for lg in m["legs"]] == [2]                                  # 第 3 站的路线不画
    assert m["legs"][0]["kind"] == "walk" and m["legs"][0]["minutes"]           # 本地路网算的分钟数
    assert len(m["legs"][0]["pts"]) >= 3 and not m["legs"][0]["schematic"]      # 沿路网拐弯,不是直线
    assert m["legs"][0]["meters"] > R._hav(*P1, *gpt(4, 6)) * 1.2
    assert m["layers"]["minor"] and m["attribution"] == "© OpenStreetMap contributors"
    assert "小影院" not in json.dumps(m, ensure_ascii=False)
    # 范围只围着已公开的两站:第 3 站在东北 2 公里多,还没公开,地图不会为它拉大
    assert m["W"] <= 1600 and m["H"] <= 1600, (m["W"], m["H"])
    her.clock["now"] = T(10, 28, 20, 41)
    m2 = her_map(her, pid)
    assert [s["n"] for s in m2["stops"]] == [1, 2, 3] and [lg["n"] for lg in m2["legs"]] == [2, 3]
    assert m2["W"] > 2500 and m2["H"] > 2500


def test_map_clips_far_geometry():
    """裁剪:远处的面裁成地图框;两端都在框外的线只留框内那段(按线段裁剪)。"""
    sq = [(-5000, -5000), (6000, -5000), (6000, 6000), (-5000, 6000)]
    out = R._clip_poly(sq, (0, 0, 100, 100))
    assert sorted({(round(x), round(y)) for x, y in out}) == [(0, 0), (0, 100), (100, 0), (100, 100)]
    runs = R._clip_line([(-50, 50), (-10, 50), (10, 50), (90, 50), (200, 50), (300, 50), (400, 50), (150, 60),
                         (60, 60)], (0, 0, 100, 100))
    assert [[(round(x), round(y)) for x, y in r] for r in runs] == [[(0, 50), (10, 50), (90, 50), (100, 50)],
                                                                    [(100, 60), (60, 60)]]
    for r in runs:
        assert all(0 <= x <= 100 and 0 <= y <= 100 for x, y in r)


def test_map_range_skips_no_place(her, maps_on):
    view = {"stops": [{"n": 1, "no_place": False, "place": {"lat": P1[0], "lng": P1[1]}},
                      {"n": 2, "no_place": True, "place": {"lat": 10.0, "lng": 10.0, "title": "x"}},
                      {"n": 3, "no_place": False, "place": {"lat": P2[0], "lng": P2[1]}}]}
    assert [n for n, _ in R._visible(view)] == [1, 3]
    pid, _ = make_plan(flower=True)
    her.clock["now"] = T(10, 28, 21)
    v = dp.her_plan(pid, now=her.clock["now"])
    assert [n for n, _ in R._visible(v)] == [1, 3, 4]
    m = her_map(her, pid)
    assert [s["n"] for s in m["stops"]] == [1, 3, 4] and m["unplotted"] == []   # 一件事本来就不画,不算「未画」


def test_map_leg_origin_skips_no_place_stop(her, maps_on):
    """第 3 站的路段从第 1 站画起(中间的「一件事」不算起点);不给它点、不算距离。"""
    view = {"stops": [
        {"n": 1, "no_place": False, "place": {"lat": P1[0], "lng": P1[1], "leg": None}},
        {"n": 2, "no_place": True, "place": {"title": "一起买一束花", "lat": None, "lng": None, "leg": None}},
        {"n": 3, "no_place": False, "place": {"lat": P2[0], "lng": P2[1], "leg": {"mode": "walk"}}}]}
    assert R._prev_placed(view) == {1: None, 3: 1}
    pid, ids = make_plan(flower=True)
    her.clock["now"] = T(10, 28, 19, 25)
    m = her_map(her, pid)
    leg = next(lg for lg in m["legs"] if lg["n"] == 3)
    s1 = next(s for s in m["stops"] if s["n"] == 1)
    assert leg["kind"] == "walk" and leg["meters"] == pytest.approx(R._hav(*P1, *P2), rel=0.05)
    assert abs(leg["pts"][0][0] - s1["x"]) < 30 and abs(leg["pts"][0][1] - s1["y"]) < 30   # 从第 1 站出发
    assert 2 not in [s["n"] for s in m["stops"]]


def test_default_map_without_basemap_says_so(her, monkeypatch, tmp_path):
    monkeypatch.setenv("EPHEMERA_MAP_DIR", str(tmp_path / "no-maps"))
    pid, _ = make_plan()
    r = her.get(f"/api/dates/{pid}/map", headers=H())
    assert r.status_code == 503 and r.json()["detail"] == {"code": "no_basemap",
                                                         "text": "还没有建底图：先用建底图脚本建这个城市的底图库"}
    cfg = her.get("/api/config", headers=H()).json()
    assert cfg["map"] is True and cfg["map_status"]["ready"] is False and cfg["map_status"]["reason"] == "no_basemap"


def test_config_reports_basemaps(her, maps_on):
    st = her.get("/api/config", headers=H()).json()["map_status"]
    assert st == {"available": True, "ready": True, "basemaps": ["synthetic"], "reason": None, "text": None}


# ── 步行:默认本地路网,原因一路带到 AI 回执 ───────────────────────────────────────────
def _route(frm, to):
    text, err = asyncio.run(dt.call("date_route", {"mode": "walk", "from": frm, "to": to}))
    m = TAIL_RE.search(text)
    assert m, text
    return text[:m.start()], err


def _ll(p):
    return f"{p[0]},{p[1]}"


def test_walk_default_local_network_minutes_and_reasons(maps_on):
    t, err = _route(_ll(P1), _ll(P2))
    assert not err and t.startswith(f"步行：{_ll(P1)} → {_ll(P2)} 大约 ") and "分钟" in t and "米" in t
    t, err = _route(_ll(P1), "10.0200,20.0205")                                # 孤立的一段人行道:不连通
    assert err and t == (f"步行时间查不了：{_ll(P1)} 到 10.0200,20.0205 "
                         "这段路网在搜索范围内不连通（两端外扩 2 公里内找不到能走通的路）。")
    t, err = _route(_ll(P1), "30.0,40.0")                                      # 底图范围外
    assert err and "这段不在已建底图范围内，没有路网数据" in t and "分钟" not in t


def test_walk_receipt_names_unverified_connector(maps_on):
    """吸附 90–300 米、没穿过河/铁路的连线:能算,但回执写明那段没核实。"""
    from ephemera_date.maps import walk_between
    far = (10.005, 20.0125)                                                    # 网格最东一列以东约 164 米,中间无障碍
    probe = walk_between(far, gpt(5, 5))
    assert probe.minutes is not None and probe.unverified_connector_m, probe
    t, err = _route(_ll(far), _ll(gpt(5, 5)))
    assert not err and f"（有一段 {probe.unverified_connector_m} 米没有核实能走）" in t


# ── 端到端:AI 写约会 → 她拿地图 → 公开前不含未公开站 → 结束后 date_memory 查得到 ──────────────
def _nominatim_stub(rows: dict):
    """OSM 替身:真实 Nominatim 适配器 + 假传输层(按 q 回 jsonv2 行),零网络。"""
    calls = []

    def transport(method, url, *, params=None, headers=None, json_body=None, timeout=None):
        calls.append(dict(params or {}))
        q = (params or {}).get("q")
        hit = rows.get(q)
        body = [] if hit is None else [{"lat": str(hit[0]), "lon": str(hit[1]), "name": q, "display_name": f"{q}, 示例市",
                                        "category": "railway", "type": "station", "osm_type": "node", "osm_id": 1}]
        return HttpResponse(200, json.dumps(body, ensure_ascii=False).encode())
    return transport, calls


def _osm_provider(tmp_path, transport):
    cfg = PlacesConfig.from_env()
    cfg.provider = "osm"
    clock = {"t": 1000.0}

    def sleep(s):
        clock["t"] += s
    lim = FileLimiter(tmp_path / "rl", clock=lambda: clock["t"], sleep=sleep)
    return NominatimProvider(cfg, transport=transport, limiter=lim, cache=QueryCache(tmp_path / "pc.sqlite"))


def _tool(name, **args):
    text, err = asyncio.run(dt.call(name, args))
    assert not err, text
    return text


def test_end_to_end_ai_writes_she_reads(her, maps_on, tmp_path):
    transport, calls = _nominatim_stub({"北门站": P1, "小馆": P2})
    ports.install("places", _osm_provider(tmp_path, transport))
    t = _tool("date_open", title_en="The Evening\nScreening", date="2026-10-28", color="rose")
    pid = int(re.search(r"约会 #(\d+)", t).group(1))
    for st in (dict(kind="train", time="19:00", title="北门站", address="北门路3", clue="出口右手边", reveal_at="17:30",
                    lat=P1[0], lng=P1[1]),
               dict(kind="dinner", time="19:30", title="小馆", address="柳岸1", clue="河边的小门", lat=P2[0], lng=P2[1]),
               dict(kind="cinema", time="21:00", title="小影院", address="东岸2", clue="红色的门", reveal_at="20:40",
                    lat=P3[0], lng=P3[1])):
        _tool("date_edit", plan=pid, op="add_stop", **st)
    route = _tool("date_route", mode="walk", **{"from": "北门站", "to": "小馆"})   # 名字经 OSM 替身查坐标
    assert [c["q"] for c in calls] == ["北门站", "小馆"]
    mins = int(route.split("大约 ", 1)[1].split(" 分钟", 1)[0])
    stops = dp.snapshot(pid, now=NOW0)["state"]["stops"]
    s1, s2, s3 = [s["id"] for s in stops]
    _tool("date_edit", plan=pid, op="set_leg", to_stop=s2, mode="walk", minutes=mins, depart_time="19:20",
          source="checked")
    _tool("date_edit", plan=pid, op="set_leg", to_stop=s3, mode="taxi", minutes=8, depart_time="20:45")
    _tool("date_edit", plan=pid, op="set_prep", items=[{"section": "wear", "text": "好走的鞋"}])
    _tool("date_send", plan=pid)
    # 她那侧:寄出后一站都没公开 → 地图空;前两站公开 → 不含第 3 站;全部公开 → 三站
    assert her_map(her, pid)["empty"] is True
    her.clock["now"] = T(10, 28, 19, 25)
    m = her_map(her, pid)
    assert [s["n"] for s in m["stops"]] == [1, 2] and "小影院" not in json.dumps(m, ensure_ascii=False)
    assert m["legs"][0]["minutes"] == mins                                      # 同一套本地路网、同一速度
    her.clock["now"] = T(10, 28, 20, 41)
    assert [s["n"] for s in her_map(her, pid)["stops"]] == [1, 2, 3]
    # 结束后:date_memory 查得到(只有结束的约会)
    assert "Screening" not in _tool("date_memory")
    her.clock["now"] = T(10, 28, 23, 30)
    _tool("date_close", plan=pid, quote="那天很好")
    found = _tool("date_memory", place="小影院")
    assert f"约会 #{pid}" in found and "Screening" in found
    assert config.db_path().startswith(str(tmp_path))
