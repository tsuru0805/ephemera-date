"""Place-service results on a stop under EPHEMERA_PLACES_STORE_POLICY (terms = only what each service's terms
allow long term; user = coordinates kept, the operator's call), the page-facing capability bits, the
OSM-fallback notice, and the AI receipt for a stop whose coordinates may not be kept.

tmp data dir, synthetic basemap, fake clock, fake adapters; no network.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import timedelta

import pytest

from conftest import H, TAIL_RE
from ephemera_date import config, ports
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from ephemera_date.maps import render as R
from ephemera_date.places import FallbackProvider
from ephemera_date.places.base import HttpResponse
from ephemera_date.places.cache import QueryCache
from ephemera_date.places.config import PlacesConfig
from ephemera_date.places.google import GoogleProvider
from ephemera_date.places.nominatim import NominatimProvider
from ephemera_date.places.ratelimit import FileLimiter

from .conftest import gpt
from .test_engine_wiring import NOW0

P1, P2 = gpt(0, 0), gpt(0, 5)
DAY30 = 30 * 86400


@pytest.fixture
def her(api, basemap, monkeypatch):
    R._cache.clear()
    monkeypatch.setenv("EPHEMERA_MAP_DIR", str(basemap.parent))
    api.clock["now"] = NOW0
    monkeypatch.setattr(dt, "_now", lambda: api.clock["now"])
    return api


def raw(sql, args=()):
    c = sqlite3.connect(config.db_path())
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def dump_db() -> str:
    """Every value in every table, as text (to prove a coordinate is not kept anywhere)."""
    c = sqlite3.connect(config.db_path())
    try:
        out = []
        for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table'"):
            out += [repr(r) for r in c.execute(f"SELECT * FROM {t}")]
        return "\n".join(out)
    finally:
        c.close()


def backfill(her, stops, cid="c-1"):
    body = {"client_id": cid, "date": "2026-10-01", "title_en": "Autumn", "color": "sky", "stops": stops}
    r = her.post("/api/dates/backfill", json=body, headers=H())
    assert r.status_code == 200, r.text
    return r.json()


def picked(src, ref, pt, title="小馆", address="柳岸1", **kw):
    return {"kind": "dinner", "time": "19:30", "title": title, "address": address, "lat": pt[0], "lng": pt[1],
            "place_source": src, "place_ref": ref, **kw}


HAND = {"kind": "train", "time": "19:00", "title": "北门站", "address": "北门路3", "lat": P1[0], "lng": P1[1]}


class Geo:
    """A place adapter that only geocodes (for refreshing expired coordinates)."""
    name = "fake"

    def __init__(self, table=None, err=None):
        self.table, self.err, self.qs = table or {}, err, []

    def capabilities(self):
        return ports.Capabilities("fake", True, False, False, False, "© fake", "")

    def search(self, q, near=None, limit=8):
        return ports.PlaceList(source="fake")

    def geocode(self, q):
        self.qs.append(q)
        if self.err:
            raise self.err
        pt = self.table.get(q)
        return ports.PlaceList([ports.Place(q, *pt, source="google")] if pt else [], source="google")


# ── terms(默认)──────────────────────────────────────────────────────────────────
def test_default_policy_is_terms():
    assert config.places_store_policy() == "terms"


def test_terms_google_keeps_place_id_caches_coords_30_days(her):
    v = backfill(her, [HAND, picked("google", "gp-123", P2)])
    pid = v["id"]
    s2 = v["stops"][1]
    assert s2["place"]["lat"] == P2[0] and s2["place"]["coords_status"] == "cached"
    assert s2["place"]["place_source"] == "google" and s2["place"]["coords_note"] is None
    row = raw("SELECT lat, lng, place_source, place_ref FROM date_stops WHERE id=?", (s2["stop_id"],))[0]
    assert row == (None, None, "google", "gp-123")                       # 站上不存坐标,只存地点 ID
    c = raw("SELECT lat, lng, source, expires_at - fetched_at FROM date_place_coords WHERE stop_id=?",
            (s2["stop_id"],))[0]
    assert c == (P2[0], P2[1], "google", DAY30)
    m = her.get(f"/api/dates/{pid}/map", headers=H()).json()
    assert [s["n"] for s in m["stops"]] == [1, 2] and m["unplotted"] == []
    ev = " ".join(r[0] or "" for r in raw("SELECT detail_json FROM date_events"))
    assert str(P2[1]) not in ev                                          # 事件里也不留坐标


class GoogleStub:
    """假传输层,回包按官方文档的格式手写(零真实调用):
    Place Details (New) https://developers.google.com/maps/documentation/places/web-service/place-details
      GET https://places.googleapis.com/v1/places/{PLACE_ID} + X-Goog-FieldMask: id,location
      → {"id": "...", "location": {"latitude": .., "longitude": ..}}
    Geocoding https://developers.google.com/maps/documentation/geocoding/requests-geocoding
      → {"status": "OK", "results": [{"formatted_address", "place_id", "geometry": {"location": {lat, lng}}}]}"""

    def __init__(self, pt=None, status=200):
        self.pt, self.status, self.calls = pt, status, []

    def __call__(self, method, url, *, params=None, headers=None, json_body=None, timeout=None):
        self.calls.append({"method": method, "url": url, "params": dict(params or {}), "headers": dict(headers or {})})
        if self.status != 200:
            return HttpResponse(self.status, b'{"error": {"code": 500, "status": "INTERNAL"}}')
        if url.startswith("https://places.googleapis.com/v1/places/"):
            body = {"id": url.rsplit("/", 1)[1], "location": {"latitude": self.pt[0], "longitude": self.pt[1]}}
        else:
            body = {"status": "OK", "results": [{"formatted_address": "柳岸1", "place_id": "gp-x", "types": [],
                                                 "geometry": {"location": {"lat": self.pt[0], "lng": self.pt[1]}}}]}
        return HttpResponse(200, json.dumps(body).encode())


def google(stub):
    cfg = PlacesConfig.from_env()
    cfg.google_key = "test-key"
    return GoogleProvider(cfg, transport=stub)


def expired_google_stop(her, ref="gp-123"):
    v = backfill(her, [HAND, picked("google", ref, P2)])
    pid, sid = v["id"], v["stops"][1]["stop_id"]
    her.clock["now"] = NOW0 + timedelta(days=31)
    assert dp.purge_place_coords(now=her.clock["now"]) == 1                # 调度者清掉过期的
    return pid, sid


def cache_rows():
    return raw("SELECT stop_id, source FROM date_place_coords")


def test_terms_google_expired_refetched_by_place_id(her):
    pid, sid = expired_google_stop(her)
    assert raw("SELECT COUNT(*) FROM date_place_coords")[0][0] == 0
    p = dp.her_plan(pid, now=her.clock["now"])["stops"][1]["place"]
    assert p["lat"] is None and p["coords_status"] == "expired" and p["coords_note"] == "坐标缓存已过期，打开地图时重新查询"
    stub = GoogleStub(P2)
    ports.install("places", google(stub))
    m = her.get(f"/api/dates/{pid}/map", headers=H()).json()
    assert [s["n"] for s in m["stops"]] == [1, 2] and m["unplotted"] == []
    assert [(c["method"], c["url"], c["headers"]["X-Goog-FieldMask"]) for c in stub.calls] == \
        [("GET", "https://places.googleapis.com/v1/places/gp-123", "id,location")]     # 按地点 ID 取,不按地址搜
    exp = raw("SELECT source, expires_at FROM date_place_coords WHERE stop_id=?", (sid,))[0]
    assert exp == ("google", pytest.approx(her.clock["now"].timestamp() + DAY30))
    assert raw("SELECT lat FROM date_stops WHERE id=?", (sid,))[0][0] is None


def test_expired_google_not_refreshed_by_another_service(her):
    """过期后地点服务换成了高德:不拿高德去查、不把别家的坐标记成谷歌的。"""
    pid, sid = expired_google_stop(her)

    class Amap(Geo):
        name = "amap"
    amap = Amap({"柳岸1": P2})
    ports.install("places", amap)
    m = her.get(f"/api/dates/{pid}/map", headers=H()).json()
    assert amap.qs == [] and cache_rows() == [] and [s["n"] for s in m["stops"]] == [1]
    assert m["unplotted"] == [{"n": 2, "stop_id": sid, "reason": "other_service",
                               "text": "坐标缓存已过期，现在用的地点服务不是谷歌，没法按条款重新查，未画"}]
    assert not dp.cache_place_coords(pid, sid, *P2, "amap", now=her.clock["now"])   # 写口也只认同一家
    assert not dp.cache_place_coords(pid, sid, *P2, "osm", now=her.clock["now"])
    assert cache_rows() == []


def test_expired_google_fallback_to_osm_is_not_cached(her, tmp_path):
    def osm_transport(method, url, *, params=None, headers=None, json_body=None, timeout=None):
        body = [{"lat": str(P2[0]), "lon": str(P2[1]), "name": "小馆", "display_name": "柳岸1, 示例市",
                 "category": "amenity", "type": "restaurant", "osm_type": "node", "osm_id": 5}]
        return HttpResponse(200, json.dumps(body, ensure_ascii=False).encode())
    keyless = GoogleProvider(PlacesConfig.from_env(), transport=osm_transport)      # 没钥匙 → not_configured
    ports.install("places", FallbackProvider(keyless, _osm(tmp_path, osm_transport)))
    # 有地点 ID:只问谷歌(details 不兜底),没钥匙 = 没取成
    pid, sid = expired_google_stop(her)
    m = her.get(f"/api/dates/{pid}/map", headers=H()).json()
    assert cache_rows() == [] and m["unplotted"][0]["reason"] == "lookup_failed"
    # 没有地点 ID:按地址查 → 兜底到 OSM 回答 → 不是谷歌的结果,不缓存
    v = backfill(her, [HAND, picked("google", None, P2)], cid="c-2")
    her.clock["now"] = NOW0 + timedelta(days=62)
    dp.purge_place_coords(now=her.clock["now"])
    m = her.get(f"/api/dates/{v['id']}/map", headers=H()).json()
    assert cache_rows() == []
    assert m["unplotted"] == [{"n": 2, "stop_id": v["stops"][1]["stop_id"], "reason": "other_source",
                               "text": "坐标缓存已过期，重新查到的结果不是谷歌给的，没有用，未画"}]


def test_refresh_failures_back_off(her):
    pid, sid = expired_google_stop(her)
    stub = GoogleStub(P2, status=500)
    ports.install("places", google(stub))
    t0 = her.clock["now"]

    def look(dt_s):
        her.clock["now"] = t0 + timedelta(seconds=dt_s)
        return her.get(f"/api/dates/{pid}/map", headers=H()).json()
    m = look(0)
    assert len(stub.calls) == 1 and m["unplotted"][0]["text"] == "坐标缓存已过期，重新查询没有成功，未画"
    look(1800)
    assert len(stub.calls) == 1                                       # 1 小时内不再查
    look(3601)
    assert len(stub.calls) == 2                                       # 到点再查一次,又失败 → 等 2 小时
    look(3601 + 7000)
    assert len(stub.calls) == 2
    look(3601 + 7201)
    assert len(stub.calls) == 3
    assert raw("SELECT failures FROM date_place_refresh WHERE stop_id=?", (sid,))[0][0] == 3
    c = sqlite3.connect(config.db_path())
    c.execute("UPDATE date_place_refresh SET failures=12, next_try_at=0 WHERE stop_id=?", (sid,))
    c.commit()
    c.close()
    look(100000)
    nxt = raw("SELECT next_try_at FROM date_place_refresh WHERE stop_id=?", (sid,))[0][0]
    assert nxt == pytest.approx((t0 + timedelta(seconds=100000)).timestamp() + 86400)   # 最多等 1 天
    stub.status = 200
    m = look(100000 + 86401)
    assert [s["n"] for s in m["stops"]] == [1, 2]
    assert raw("SELECT COUNT(*) FROM date_place_refresh")[0][0] == 0                 # 取到了:退避记录清掉


def _db_bytes() -> bytes:
    from pathlib import Path
    p = Path(config.db_path())
    return b"".join(f.read_bytes() for f in (p, Path(str(p) + "-wal")) if f.exists())


def _packed(*vals) -> list[bytes]:
    import struct
    return [struct.pack(">d", v) for v in vals]                        # SQLite 存 REAL = 8 字节大端


ODD = (10.000123457, 20.004987653)                                     # 不会碰巧出现在别处的坐标


def test_purged_coords_leave_no_bytes_in_db_or_wal(her):
    v = backfill(her, [HAND, picked("google", "gp-1", ODD)])
    assert any(b in _db_bytes() for b in _packed(*ODD))                   # 缓存里确实有(自检)
    her.clock["now"] = NOW0 + timedelta(days=31)
    assert dp.purge_place_coords(now=her.clock["now"]) == 1
    raw_bytes = _db_bytes()
    assert not any(b in raw_bytes for b in _packed(*ODD))
    assert dp.her_plan(v["id"], now=her.clock["now"])["stops"][1]["place"]["coords_status"] == "expired"


def test_switch_user_to_terms_takes_coords_back(her, monkeypatch):
    from ephemera_date import scheduler
    monkeypatch.setenv("EPHEMERA_PLACES_STORE_POLICY", "user")
    amap_pt = (10.000876543, 20.007654321)
    v = backfill(her, [HAND, picked("google", "gp-1", ODD), picked("amap", "B9", amap_pt, title="甜品")])
    pid = v["id"]
    s2, s3 = v["stops"][1]["stop_id"], v["stops"][2]["stop_id"]
    r = her.patch(f"/api/dates/{pid}/her", json={"ops": [{"op": "update_stop", "stop_id": s3, "lat": amap_pt[0],
                                                           "lng": amap_pt[1] + 0.001, "place_source": "amap",
                                                           "place_ref": "B10"}]}, headers=H())
    assert r.status_code == 200, r.text
    assert any(b in _db_bytes() for b in _packed(amap_pt[0]))                          # user 下确实存着(自检)
    assert dp.enforce_store_policy(now=her.clock["now"]) == {"moved": 0, "cleared": 0}   # user:什么都不做
    monkeypatch.setenv("EPHEMERA_PLACES_STORE_POLICY", "terms")
    assert dp.enforce_store_policy(now=her.clock["now"]) == {"moved": 1, "cleared": 1}
    rows = raw("SELECT id, lat, lng, place_source, place_ref FROM date_stops WHERE id IN (?, ?) ORDER BY ord", (s2, s3))
    assert rows == [(s2, None, None, "google", "gp-1"), (s3, None, None, "amap", None)]
    c = raw("SELECT lat, lng, source, expires_at FROM date_place_coords WHERE stop_id=?", (s2,))[0]
    assert c == (ODD[0], ODD[1], "google", pytest.approx(her.clock["now"].timestamp() + DAY30))
    stops = dp.her_plan(pid, now=her.clock["now"])["stops"]
    assert [x["place"]["coords_status"] for x in stops] == [None, "cached", "not_storable"]
    ev = " ".join(x[0] or "" for x in raw("SELECT detail_json FROM date_events"))
    assert "B9" not in ev and "B10" not in ev and str(amap_pt[0]) not in ev
    raw_bytes = _db_bytes()
    assert not any(b in raw_bytes for b in _packed(amap_pt[0], amap_pt[1], amap_pt[1] + 0.001))
    assert b"B10" not in raw_bytes
    assert dp.enforce_store_policy(now=her.clock["now"]) == {"moved": 0, "cleared": 0}   # 第二次无事可做
    assert "place_policy" in scheduler.tick(now=her.clock["now"])                       # 调度者每轮也跑


def test_terms_amap_keeps_no_coords_and_says_so(her):
    pt = (P2[0] + 0.0000123, P2[1] + 0.0000456)
    v = backfill(her, [HAND, picked("amap", "B0FFG", pt)])
    pid, sid = v["id"], v["stops"][1]["stop_id"]
    assert "20.0050456" not in dump_db() and "B0FFG" not in dump_db()     # 坐标与 POI ID 都不留
    p = v["stops"][1]["place"]
    assert p["lat"] is None and p["coords_status"] == "not_storable" and p["coords_note"] == "坐标不可存，未画"
    assert p["title"] == "小馆" and p["address"] == "柳岸1"                  # 用户写的标题地址照留
    m = her.get(f"/api/dates/{pid}/map", headers=H()).json()
    assert [s["n"] for s in m["stops"]] == [1]
    assert m["unplotted"] == [{"n": 2, "stop_id": sid, "reason": "not_storable", "text": "坐标不可存，未画"}]
    text, err = asyncio.run(dt.call("date_view", {"plan": pid}))
    assert not err and "  坐标：坐标不可存，未画（地点来自高德，按它的条款不存坐标，她的地图上不画这一站）" in text


def test_terms_osm_and_hand_written_coords_are_kept(her):
    v = backfill(her, [HAND, picked("osm", "N42", P2)])
    rows = raw("SELECT lat, lng, place_source, place_ref FROM date_stops ORDER BY ord")
    assert rows == [(P1[0], P1[1], None, None), (P2[0], P2[1], "osm", "N42")]
    assert [s["place"]["coords_status"] for s in v["stops"]] == [None, None]


def test_her_edit_pick_then_hand_correct(her):
    v = backfill(her, [HAND, {"kind": "dinner", "time": "19:30", "title": "小馆", "address": "柳岸1"}])
    pid, sid = v["id"], v["stops"][1]["stop_id"]
    r = her.patch(f"/api/dates/{pid}/her", json={"ops": [{"op": "update_stop", "stop_id": sid, "lat": P2[0],
                                                           "lng": P2[1], "place_source": "google",
                                                           "place_ref": "gp-9"}]}, headers=H())
    assert r.status_code == 200, r.text
    assert raw("SELECT lat, place_source, place_ref FROM date_stops WHERE id=?", (sid,))[0] == (None, "google", "gp-9")
    assert raw("SELECT COUNT(*) FROM date_place_coords WHERE stop_id=?", (sid,))[0][0] == 1
    assert r.json()["stops"][1]["place"]["lat"] == P2[0]
    texts = [x[0] for x in raw("SELECT text FROM date_events WHERE kind='her_edit'")]
    assert texts == ["她改了第 2 站的位置"]
    # 她自己手写坐标:照存,不再算谷歌的结果,临时缓存作废
    r = her.patch(f"/api/dates/{pid}/her", json={"ops": [{"op": "update_stop", "stop_id": sid, "lat": P2[0],
                                                           "lng": P2[1] + 0.0001}]}, headers=H())
    assert r.status_code == 200, r.text
    assert raw("SELECT lat, place_source, place_ref FROM date_stops WHERE id=?", (sid,))[0] == (P2[0], None, None)
    assert raw("SELECT COUNT(*) FROM date_place_coords")[0][0] == 0
    # 她补一站(高德结果):坐标不存
    r = her.patch(f"/api/dates/{pid}/her", json={"ops": [{"op": "add_stop", "kind": "cafe", "time": "21:00",
                                                           "title": "甜品", "address": "东岸2", "lat": 10.001,
                                                           "lng": 20.009, "place_source": "amap",
                                                           "place_ref": "B1"}]}, headers=H())
    assert r.status_code == 200, r.text
    assert r.json()["stops"][2]["place"]["coords_status"] == "not_storable" and "20.009" not in dump_db()


def test_her_place_fields_are_checked(her):
    body = {"client_id": "x", "date": "2026-10-01", "title_en": "Autumn", "color": "sky"}
    for stop, code in ((picked("baidu", "1", P2), "bad_place_source"),
                       ({**picked("google", "1", P2), "lat": None, "lng": None}, "place_needs_coord"),
                       ({"kind": "cafe", "time": "19:00", "title": "x", "place_ref": "1"}, "bad_place_source"),
                       (picked("google", "x" * 201, P2), "bad_place_ref")):
        r = her.post("/api/dates/backfill", json={**body, "stops": [stop]}, headers=H())
        assert r.status_code == 400 and r.json()["detail"]["code"] == code, (stop, r.text)


def test_ai_hand_coords_clear_the_place_source(her):
    pid = dp.open_plan("Night", "2026-10-28", "rose", now=NOW0)["plan_id"]
    dp.edit(pid, "add_stop", dict(kind="cafe", time="19:00", title="x", address="y", clue="z"), now=NOW0)
    sid = dp.snapshot(pid, now=NOW0)["state"]["stops"][0]["id"]
    c = sqlite3.connect(config.db_path())
    c.execute("UPDATE date_stops SET place_source='google', place_ref='gp' WHERE id=?", (sid,))
    c.execute("INSERT INTO date_place_coords VALUES (?,?,?,?,?,?,?)", (sid, pid, 1.0, 2.0, "google", 0, 9e9))
    c.commit()
    c.close()
    assert dp.edit(pid, "update_stop", dict(stop_id=sid, lat=P1[0], lng=P1[1]), now=NOW0)["ok"]
    assert raw("SELECT lat, place_source, place_ref FROM date_stops WHERE id=?", (sid,))[0] == (P1[0], None, None)
    assert raw("SELECT COUNT(*) FROM date_place_coords")[0][0] == 0


# ── user ─────────────────────────────────────────────────────────────────────────
def test_user_policy_keeps_coords_of_every_service(her, monkeypatch):
    monkeypatch.setenv("EPHEMERA_PLACES_STORE_POLICY", "user")
    v = backfill(her, [HAND, picked("google", "gp-1", P2), picked("amap", "B2", gpt(0, 8), title="甜品")])
    rows = raw("SELECT lat, lng, place_source, place_ref FROM date_stops ORDER BY ord")
    assert rows[1:] == [(P2[0], P2[1], "google", "gp-1"), (gpt(0, 8)[0], gpt(0, 8)[1], "amap", "B2")]
    assert raw("SELECT COUNT(*) FROM date_place_coords")[0][0] == 0
    assert [s["place"]["coords_status"] for s in v["stops"]] == [None, None, None]
    m = her.get(f"/api/dates/{v['id']}/map", headers=H()).json()
    assert [s["n"] for s in m["stops"]] == [1, 2, 3] and m["unplotted"] == []
    cfg = her.get("/api/config", headers=H()).json()["place_service"]
    assert cfg["store_policy"] == "user"


def test_search_items_say_whether_coords_are_kept(her, monkeypatch):
    class Prov(Geo):
        def search(self, q, near=None, limit=8):
            return ports.PlaceList([ports.Place("a", 1.0, 2.0, source="google", provider_id="g1"),
                                    ports.Place("b", 1.0, 2.0, source="osm", provider_id="N1")], source="google")
    ports.install("places", Prov())
    items = her.get("/api/dates/place_search", params={"q": "a"}, headers=H()).json()["items"]
    assert [(i["source"], i["provider_id"], i["coords_storable"]) for i in items] == [("google", "g1", False),
                                                                                     ("osm", "N1", True)]
    monkeypatch.setenv("EPHEMERA_PLACES_STORE_POLICY", "user")
    items = her.get("/api/dates/place_search", params={"q": "a"}, headers=H()).json()["items"]
    assert [i["coords_storable"] for i in items] == [True, True]


# ── 页面能力位 + 兜底标记 ─────────────────────────────────────────────────────────────
def _osm(tmp_path, transport):
    cfg = PlacesConfig.from_env()
    clock = {"t": 1000.0}
    lim = FileLimiter(tmp_path / "rl", clock=lambda: clock["t"], sleep=lambda s: clock.__setitem__("t", clock["t"] + s))
    return NominatimProvider(cfg, transport=transport, limiter=lim, cache=QueryCache(tmp_path / "pc.sqlite"))


def test_osm_fallback_is_marked_and_explained(her, tmp_path):
    calls = []

    def transport(method, url, *, params=None, headers=None, json_body=None, timeout=None):
        calls.append(url)
        body = [{"lat": "10.0", "lon": "20.0", "name": "北门站", "display_name": "北门站, 示例市",
                 "category": "railway", "type": "station", "osm_type": "node", "osm_id": 7}]
        return HttpResponse(200, json.dumps(body, ensure_ascii=False).encode())
    google = GoogleProvider(PlacesConfig.from_env(), transport=transport)         # 没钥匙 → not_configured
    ports.install("places", FallbackProvider(google, _osm(tmp_path, transport)))
    r = her.get("/api/dates/place_search", params={"q": "北门站"}, headers=H()).json()
    assert r["source"] == "osm" and r["fallback_from"] == "google" and r["fallback_code"] == "not_configured"
    assert r["notice"] == "没配谷歌钥匙，这次是用 OpenStreetMap 搜的"
    assert r["items"][0]["fallback_from"] == "google" and r["items"][0]["provider_id"] == "N7"
    assert all("google" not in u for u in calls)                                 # 谷歌没钥匙:一次也没去调


def test_fallback_notice_for_service_fault(her, tmp_path):
    def transport(method, url, *, params=None, headers=None, json_body=None, timeout=None):
        if "googleapis" in url:
            return HttpResponse(503, b"{}")
        body = [{"lat": "10.0", "lon": "20.0", "name": "北门站", "display_name": "北门站", "category": "railway",
                 "type": "station", "osm_type": "node", "osm_id": 7}]
        return HttpResponse(200, json.dumps(body, ensure_ascii=False).encode())
    cfg = PlacesConfig.from_env()
    cfg.google_key = "test-key"
    ports.install("places", FallbackProvider(GoogleProvider(cfg, transport=transport), _osm(tmp_path, transport)))
    r = her.get("/api/dates/place_search", params={"q": "北门站"}, headers=H()).json()
    assert r["fallback_code"] == "upstream"
    assert r["notice"] == "谷歌现在用不了，这次是用 OpenStreetMap 搜的，结果可能少一些"


def test_config_place_service_capabilities(her, monkeypatch):
    cfg = her.get("/api/config", headers=H()).json()
    ps = cfg["place_service"]                                    # 不设 env:OSM,没有兜底(只读能力,不出网)
    assert cfg["places"] is True
    assert ps["available"] and ps["provider"] == "osm" and ps["fallback"] is None
    assert ps["supports_autocomplete"] is False and "OpenStreetMap" in ps["attribution"]
    assert ps["store_policy"] == "terms"
    monkeypatch.setenv("EPHEMERA_PLACES_PROVIDER", "google")      # 自行开启谷歌:OSM 兜底照旧
    ps = her.get("/api/config", headers=H()).json()["place_service"]
    assert ps["provider"] == "google" and ps["fallback"] == "osm" and ps["supports_autocomplete"] is False
    monkeypatch.setenv("EPHEMERA_PLACES_PROVIDER", "amap")
    monkeypatch.setenv("EPHEMERA_PLACES_FALLBACK", "none")
    ps = her.get("/api/config", headers=H()).json()["place_service"]
    assert ps["provider"] == "amap" and ps["fallback"] is None and ps["supports_autocomplete"] is True
    assert "高德" in ps["attribution"]
    monkeypatch.setenv("EPHEMERA_PLACES_ADAPTER", "none")
    cfg = her.get("/api/config", headers=H()).json()
    assert cfg["places"] is False and cfg["place_service"]["available"] is False


def test_tool_receipt_tail_still_there(her):
    text, _ = asyncio.run(dt.call("date_view", {}))
    assert TAIL_RE.search(text)


def test_default_places_adapter_is_built_off_the_event_loop_thread(her, monkeypatch):
    seen = []

    def factory():
        try:
            asyncio.get_running_loop()
            seen.append(True)                     # 在事件循环线程里构造 = 会堵住循环
        except RuntimeError:
            seen.append(False)                    # 在工作线程里
        return Geo()
    monkeypatch.setitem(ports._DEFAULTS, "places", factory)
    assert her.get("/api/dates/place_search", params={"q": "a"}, headers=H()).status_code == 200
    asyncio.run(dt.call("date_route", {"mode": "walk", "from": "某处", "to": "10.0,20.0"}))
    assert seen and not any(seen)


def test_truncate_flag_kept_until_checkpoint_succeeds(monkeypatch):
    """截断被读者占住(busy)时不清「需要截断」标记,下一轮再试;成功后才清。"""
    from ephemera_date import plan as dp
    dp.cache_place_coords  # 引擎已建表
    conn = dp._connect(None)
    conn.close()
    with dp._tx(None) as c:
        dp._mark_coords_dirty(c, 0.0)
    calls = []
    monkeypatch.setattr(dp, "checkpoint_truncate", lambda path=None: calls.append(1) or False)
    dp.purge_place_coords(now=0.0)
    with dp._tx(None) as c:
        assert c.execute("SELECT value FROM ephemera_meta WHERE key=?", (dp._COORDS_DIRTY,)).fetchone()
    monkeypatch.setattr(dp, "checkpoint_truncate", lambda path=None: calls.append(2) or True)
    dp.purge_place_coords(now=0.0)
    with dp._tx(None) as c:
        assert c.execute("SELECT value FROM ephemera_meta WHERE key=?", (dp._COORDS_DIRTY,)).fetchone() is None
    assert calls == [1, 2]
