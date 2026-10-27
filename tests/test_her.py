"""Her side writes (prep ticks / check-in / keepsake box / photos) + the map endpoint.

tmp data dir (conftest), fake clock, no network; dates are built through the engine's public writes.
"""
from __future__ import annotations

import sqlite3
import struct
from datetime import datetime

import pytest

from conftest import AI_TOKEN, H as _H
from ephemera_date import ports

from ephemera_date import config
from ephemera_date import her as date_her
from ephemera_date import plan as dp
from conftest import TZ

JPG = b"\xff\xd8\xff\xe0" + b"0" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


NOW0 = T(10, 20, 10)


def ok(r):
    assert r["ok"], r["errors"]
    return r


def make_plan(send=True, contract=True, card=True):
    """三站:集合 19:00(17:30 公开)→ 晚餐 19:30(步行,19:20 出发)→ 电影 21:00(第 3 站地点 20:40 才公开)。"""
    pid = ok(dp.open_plan("The Evening\nScreening", "2026-10-28", "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="青石区梧桐路3",
                                        clue="改札右手边", reveal_at="17:30", note="我会早到",
                                        lat=35.6440, lng=139.6988), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="19:30", title="Le Petit Pot", address="青石区柳岸1",
                                        clue="河边的小门", note="点你想吃的", lat=35.6425, lng=139.7003), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="cinema", time="21:00", title="小影院", address="青石区2",
                                        clue="红色的门", reveal_at="20:40", note="散场后等我",
                                        lat=35.6336, lng=139.7148), now=NOW0))
    st = dp.snapshot(pid, now=NOW0)["state"]["stops"]
    s1, s2, s3 = [s["id"] for s in st]
    ok(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="walk", minutes=6, depart_time="19:20"), now=NOW0))
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="taxi", minutes=8, depart_time="20:45"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "一件薄外套"},
                                                {"section": "wear", "text": "好走的鞋"}]), now=NOW0))
    if contract:
        ok(dp.edit(pid, "set_contract", dict(items=["不许看手机"]), now=NOW0))
    if card:
        ok(dp.edit(pid, "set_card", dict(text="电影票其实是两张"), now=NOW0))
    if send:
        ok(dp.send(pid, now=NOW0))
    return pid, (s1, s2, s3)


def prep_keys(pid, now):
    return ["prep:" + date_her.prep_key(it) for it in dp.her_plan(pid, now=now)["prep"]]


def close(pid):
    ok(dp.close(pid, "那天很好", now=T(10, 28, 23, 30)))


# ── 准备清单 ─────────────────────────────────────────────────────────────────────
def test_prep_toggle_in_sent_and_live_then_frozen_after_done():
    pid, _ = make_plan()
    k1, k2 = prep_keys(pid, NOW0)
    st = date_her.set_mark(pid, k1, True, now=NOW0)
    assert set(st["marks"]) == {k1}
    date_her.set_mark(pid, k1, True, now=NOW0)                   # 重复勾=幂等
    st = date_her.set_mark(pid, k2, True, now=T(10, 28, 9))       # 当天也能勾
    assert set(st["marks"]) == {k1, k2}
    st = date_her.set_mark(pid, k1, False, now=T(10, 28, 9))      # 可以取消
    assert set(st["marks"]) == {k2}
    with pytest.raises(date_her.HerError) as e:
        date_her.set_mark(pid, "prep:bring:000000000000", True, now=NOW0)
    assert e.value.status == 404
    close(pid)
    with pytest.raises(date_her.HerError) as e:
        date_her.set_mark(pid, k1, True, now=T(10, 29))
    assert e.value.status == 409
    assert set(date_her.state(pid, now=T(10, 29))["marks"]) == {k2}   # 收进盒子时的样子保留


def test_prep_mark_drops_when_item_rewritten():
    pid, _ = make_plan()
    k1, _ = prep_keys(pid, NOW0)
    date_her.set_mark(pid, k1, True, now=NOW0)
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "一把伞"}]), now=T(10, 21)))
    assert date_her.state(pid, now=T(10, 21))["marks"] == {}


def test_prep_key_prefers_engine_key():
    assert date_her.prep_key({"key": "p:bring:伞", "section": "bring", "text": "伞"}) == "p:bring:伞"
    assert date_her.prep_key({"section": "bring", "text": "伞"}).startswith("bring:")
    assert date_her._KEY_RE.match("prep:p:bring:一件薄外套")
    for bad in ("prep:", "prep:a\nb", "checkin:x", "lid2", "sleeve:", "photo:1", "lid\n", "checkin:3\n"):
        assert not date_her._KEY_RE.fullmatch(bad), bad


# ── 检票 ─────────────────────────────────────────────────────────────────────────
def test_checkin_only_on_the_day_after_arrival_and_not_undoable():
    pid, (s1, s2, s3) = make_plan()
    with pytest.raises(date_her.HerError) as e:
        date_her.set_mark(pid, f"checkin:{s1}", True, now=NOW0)          # 还没到当天
    assert e.value.status == 409
    with pytest.raises(date_her.HerError) as e:
        date_her.set_mark(pid, f"checkin:{s3}", True, now=T(10, 28, 19))  # 第 3 站还没到
    assert e.value.status == 409
    st = date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    assert f"checkin:{s1}" in st["marks"]
    with pytest.raises(date_her.HerError) as e:
        date_her.set_mark(pid, f"checkin:{s1}", False, now=T(10, 28, 19))
    assert e.value.status == 409
    with pytest.raises(date_her.HerError) as e:
        date_her.set_mark(pid, "checkin:99999", True, now=T(10, 28, 19))
    assert e.value.status == 404


def test_checkin_uses_engine_arrive_at_when_present(monkeypatch):
    s = {"stop_id": 1, "time": "21:00", "place": {"title": "x"}, "arrive_at": T(10, 28, 21).timestamp()}
    assert not date_her._arrived(s, T(10, 28, 20, 59))       # 地点公开了也要等到点
    assert date_her._arrived(s, T(10, 28, 21))
    assert not date_her._arrived({"stop_id": 1, "place": None}, T(10, 28, 23))


# ── 照片 ─────────────────────────────────────────────────────────────────────────
def test_photo_needs_checkin_on_the_day_and_is_served_back(tmp_path):
    pid, (s1, s2, s3) = make_plan()
    with pytest.raises(date_her.HerError) as e:
        date_her.add_photo(pid, s1, JPG, "改札外", now=NOW0)
    assert e.value.status == 409
    with pytest.raises(date_her.HerError) as e:
        date_her.add_photo(pid, s1, JPG, "改札外", now=T(10, 28, 19))     # 没检票
    assert e.value.status == 409
    with pytest.raises(date_her.HerError) as e:
        date_her.set_mark(pid, f"nophoto:{s1}", True, now=T(10, 28, 19))   # 当天要先检票,同放照片
    assert e.value.status == 409
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    date_her.set_mark(pid, f"nophoto:{s1}", True, now=T(10, 28, 19))
    ph = date_her.add_photo(pid, s1, JPG, " 改札外 ", now=T(10, 28, 19, 5))
    assert ph["caption"] == "改札外"
    st = date_her.state(pid, now=T(10, 28, 19, 6))
    assert [p["stop_id"] for p in st["photos"]] == [s1]
    assert f"nophoto:{s1}" not in st["marks"]                     # 放了照片就不是「没放」
    f, mime = date_her.photo_file(pid, ph["id"], now=T(10, 28, 19, 6))
    assert f.read_bytes() == JPG and mime == "image/jpeg"
    assert str(tmp_path) in str(f)                                # 落在测试目录
    for bad, code in ((b"GIF89a....", 415), (b"", 400)):
        with pytest.raises(date_her.HerError) as e:
            date_her.add_photo(pid, s1, bad, None, now=T(10, 28, 19, 7))
        assert e.value.status == code
    with pytest.raises(date_her.HerError) as e:
        date_her.add_photo(pid, s1, PNG, "字" * 25, now=T(10, 28, 19, 7))
    assert e.value.status == 400
    close(pid)
    ph2 = date_her.add_photo(pid, s3, PNG, None, now=T(10, 29))     # 结束后补照片不用检票
    assert date_her.photo_file(pid, ph2["id"], now=T(10, 29))[1] == "image/png"


def test_photo_retry_with_same_client_id_is_stored_once(tmp_path):
    pid, (s1, _, _) = make_plan()
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    a = date_her.add_photo(pid, s1, JPG, "x", client_id="c-1", now=T(10, 28, 19))
    b = date_her.add_photo(pid, s1, JPG, "x", client_id="c-1", now=T(10, 28, 19, 1))   # 超时后重发
    assert a["id"] == b["id"]
    assert len(date_her.state(pid, now=T(10, 28, 19, 2))["photos"]) == 1
    assert len(list((tmp_path / "data" / "photos" / str(pid)).iterdir())) == 1      # 没多落一个文件
    date_her.add_photo(pid, s1, JPG, "y", client_id="c-2", now=T(10, 28, 19, 3))
    assert len(date_her.state(pid, now=T(10, 28, 19, 4))["photos"]) == 2


def test_sniff_heif_family():
    hd = lambda brand: b"\x00\x00\x00\x18ftyp" + brand + b"0" * 32
    for brand in (b"heic", b"heix", b"hevc", b"heis", b"mif1", b"msf1"):
        assert date_her._sniff(hd(brand)) == ("heic", "image/heic")
    assert date_her._sniff(hd(b"avif")) == ("avif", "image/avif")
    with pytest.raises(date_her.HerError):
        date_her._sniff(hd(b"mp42"))


def test_photo_of_other_plan_or_deleted_stop_not_served():
    pid, (s1, _, _) = make_plan()
    p2, _ = make_plan()
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    ph = date_her.add_photo(pid, s1, JPG, None, now=T(10, 28, 19))
    with pytest.raises(date_her.HerError) as e:
        date_her.photo_file(p2, ph["id"], now=T(10, 28, 19))
    assert e.value.status == 404


# ── 纪念盒 ───────────────────────────────────────────────────────────────────────
def test_archive_marks_only_after_done_and_need_content():
    pid, (s1, _, _) = make_plan()
    for k in ("lid", f"sleeve:{s1}", "card_torn", "contract_fp"):
        with pytest.raises(date_her.HerError) as e:
            date_her.set_mark(pid, k, True, now=T(10, 28, 22))
        assert e.value.status == 409
    close(pid)
    st = None
    for k in ("lid", f"sleeve:{s1}", "card_torn", "contract_fp"):
        st = date_her.set_mark(pid, k, True, now=T(10, 29))
    assert {"lid", f"sleeve:{s1}", "card_torn", "contract_fp"} <= set(st["marks"])
    p2, _ = make_plan(contract=False, card=False)
    close(p2)
    for k in ("card_torn", "contract_fp"):
        with pytest.raises(date_her.HerError) as e:
            date_her.set_mark(p2, k, True, now=T(10, 29))
        assert e.value.status == 404


def test_draft_and_missing_plans_are_404_everywhere():
    p, (s1, _, _) = make_plan(send=False)
    for fn in (lambda: date_her.state(p, now=NOW0),
               lambda: date_her.set_mark(p, "lid", True, now=NOW0),
               lambda: date_her.add_photo(p, s1, JPG, None, now=NOW0),
               lambda: date_her.state(9999, now=NOW0)):
        with pytest.raises(date_her.HerError) as e:
            fn()
        assert e.value.status == 404


# ── REST ─────────────────────────────────────────────────────────────────────────
@pytest.fixture()
def her(api):
    api.clock["now"] = NOW0
    return api


H = _H()


def test_rest_auth_only_her_token(her):
    pid, _ = make_plan()
    paths = [("get", f"/api/dates/{pid}/her", {}), ("get", f"/api/dates/{pid}/map", {}),
             ("post", f"/api/dates/{pid}/her/mark", {"json": {"key": "lid"}})]
    for m, path, kw in paths:
        for bad in ({}, {"Authorization": f"Bearer {AI_TOKEN}"}, {"Authorization": "Bearer nope"}):
            assert getattr(her, m)(path, headers=bad, **kw).status_code == 401


def test_rest_flow_checkin_photo_map(her):
    pid, (s1, s2, s3) = make_plan()
    assert her.get(f"/api/dates/{pid}/her", headers=H).json() == {"marks": {}, "photos": [], "now": NOW0.timestamp()}
    r = her.post(f"/api/dates/{pid}/her/mark", json={"key": f"checkin:{s1}"}, headers=H)
    assert r.status_code == 409 and r.json()["detail"] == "约会当天才能检票"
    her.clock["now"] = T(10, 28, 19, 1)
    assert her.post(f"/api/dates/{pid}/her/mark", json={"key": f"checkin:{s1}"}, headers=H).status_code == 200
    r = her.post(f"/api/dates/{pid}/her/photo", data={"stop_id": str(s1), "caption": "改札外"},
                 files={"file": ("a.jpg", JPG, "image/jpeg")}, headers=H)
    assert r.status_code == 200, r.text
    pid_ph = r.json()["id"]
    g = her.get(f"/api/dates/{pid}/her/photo/{pid_ph}", headers=H)
    assert g.status_code == 200 and g.content == JPG and g.headers["content-type"] == "image/jpeg"
    assert her.post(f"/api/dates/{pid}/her/mark", json={"key": "bogus"}, headers=H).status_code == 400
    # 还没建底图:明说 503 + 原因,不假装有图
    r = her.get(f"/api/dates/{pid}/map", headers=H)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "no_basemap"
    assert r.json()["detail"]["text"].startswith("还没有建底图")


# ── 地图(渲染归地图适配器;引擎只把她的投影交出去)───────────────────────────────────
class FakeMap:
    def __init__(self):
        self.views = []

    def build_map(self, view):
        self.views.append(view)
        return {"stops": [s["n"] for s in view["stops"] if s["place"]], "empty": not any(s["place"] for s in view["stops"])}


def test_map_only_gets_the_projection(her, monkeypatch):
    pid, _ = make_plan()
    monkeypatch.setenv("EPHEMERA_MAP_ADAPTER", "none")
    r = her.get(f"/api/dates/{pid}/map", headers=H)                              # 关掉地图:明说,不假装有图
    assert r.status_code == 503 and r.json()["detail"]["code"] == "not_configured"
    monkeypatch.delenv("EPHEMERA_MAP_ADAPTER")
    fm = FakeMap()
    ports.install("map", fm)
    assert her.get(f"/api/dates/{pid}/map", headers=H).json() == {"stops": [], "empty": True,
                                                                  "unplotted": []}   # 一站都没公开
    her.clock["now"] = T(10, 28, 19, 25)                                          # 前两站公开,第 3 站没
    assert her.get(f"/api/dates/{pid}/map", headers=H).json()["stops"] == [1, 2]
    v = fm.views[-1]
    assert v["stops"][2]["place"] is None and "小影院" not in str(v)            # 第 3 站的名字没交给地图
    p2, _ = make_plan(send=False)
    assert her.get(f"/api/dates/{p2}/map", headers=H).status_code == 404         # 构思中=不存在
    assert len(fm.views) == 2


def test_replace_photo_keeps_only_the_new_one(tmp_path):
    pid, (s1, s2, _) = make_plan()
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    date_her.set_mark(pid, f"checkin:{s2}", True, now=T(10, 28, 19, 40))
    old = date_her.add_photo(pid, s1, JPG, "旧的", client_id="c-1", now=T(10, 28, 19, 41))
    other = date_her.add_photo(pid, s2, JPG, "别站", client_id="c-2", now=T(10, 28, 19, 42))
    new = date_her.add_photo(pid, s1, PNG, "新的", client_id="c-3", replace=True, now=T(10, 28, 19, 45))
    ph = date_her.state(pid, now=T(10, 28, 19, 46))["photos"]
    assert {p["id"] for p in ph} == {new["id"], other["id"]}          # 同站旧的换掉,别站不动
    with pytest.raises(date_her.HerError):
        date_her.photo_file(pid, old["id"], now=T(10, 28, 19, 47))      # 换掉的那张不再给出
    again = date_her.add_photo(pid, s1, PNG, "新的", client_id="c-3", replace=True, now=T(10, 28, 19, 48))
    assert again["id"] == new["id"]                                       # 重发同一次=原样回执,不误删


def test_set_caption_only_and_reasons(tmp_path):
    pid, (s1, _, _) = make_plan()
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    a = date_her.add_photo(pid, s1, JPG, "x", client_id="c-1", now=T(10, 28, 19))
    r = date_her.set_caption(pid, a["id"], "  第二件半价 ", now=T(10, 28, 19, 1))
    assert r["caption"] == "第二件半价"
    assert date_her.state(pid, now=T(10, 28, 19, 2))["photos"][0]["caption"] == "第二件半价"
    with pytest.raises(date_her.HerError) as e:
        date_her.set_caption(pid, a["id"], "长" * (date_her.CAPTION_MAX + 1), now=T(10, 28, 19, 3))
    assert "最多" in e.value.text
    b = date_her.add_photo(pid, s1, PNG, "y", client_id="c-2", replace=True, now=T(10, 28, 19, 4))
    with pytest.raises(date_her.HerError) as e:
        date_her.set_caption(pid, a["id"], "旧那张", now=T(10, 28, 19, 5))   # 已换掉的那张:回原因
    assert e.value.status == 404 and "换掉" in e.value.text
    assert b["caption"] == "y"


def test_photo_routes_replace_and_patch(her):
    pid, (s1, _, _) = make_plan()
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    her.clock["now"] = T(10, 28, 19, 1)
    a = her.post(f"/api/dates/{pid}/her/photo", data={"stop_id": s1, "caption": "a", "client_id": "r1"},
                 files={"file": ("a.jpg", JPG, "image/jpeg")}, headers=H).json()
    b = her.post(f"/api/dates/{pid}/her/photo", data={"stop_id": s1, "caption": "b", "client_id": "r2", "replace": "1"},
                 files={"file": ("b.jpg", JPG, "image/jpeg")}, headers=H).json()
    r = her.patch(f"/api/dates/{pid}/her/photo/{b['id']}", json={"caption": "改了"}, headers=H)
    assert r.status_code == 200 and r.json()["caption"] == "改了"
    assert her.patch(f"/api/dates/{pid}/her/photo/{a['id']}", json={"caption": "x"}, headers=H).status_code == 404
    assert her.patch(f"/api/dates/{pid}/her/photo/{b['id']}", json={"caption": "x", "evil": 1}, headers=H).status_code == 400
    assert [p["id"] for p in date_her.state(pid, now=T(10, 28, 19, 2))["photos"]] == [b["id"]]
    big = b"\xff\xd8\xff" + b"0" * (date_her.PHOTO_MAX_BYTES + 1)
    assert her.post(f"/api/dates/{pid}/her/photo", data={"stop_id": s1}, files={"file": ("c.jpg", big, "image/jpeg")},
                    headers=H).status_code == 413
    assert her.post(f"/api/dates/{pid}/her/photo", data={"stop_id": s1}, files={"file": ("c.gif", b"GIF89a....", "image/gif")},
                    headers=H).status_code == 415                               # 服务端按文件头判,不信 mime


def test_caption_on_replaced_photo_is_refused_not_silently_ok(tmp_path):
    """查有效性与改动同一条语句——已换掉的那张改小字=404 原因,不假成功。"""
    pid, (s1, _, _) = make_plan()
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    a = date_her.add_photo(pid, s1, JPG, "x", client_id="c-1", now=T(10, 28, 19))
    date_her.add_photo(pid, s1, PNG, "y", client_id="c-2", replace=True, now=T(10, 28, 19, 1))
    with pytest.raises(date_her.HerError) as e:
        date_her.set_caption(pid, a["id"], "改", now=T(10, 28, 19, 2))
    assert e.value.status == 404
    c = sqlite3.connect(config.db_path())
    try:
        assert c.execute("SELECT caption FROM date_her_photos WHERE id=?", (a["id"],)).fetchone()[0] == "x"   # 没被改
    finally:
        c.close()


def test_two_replaces_in_a_row_leave_exactly_the_last_one(tmp_path):
    """插入与换掉同一个写事务,后来者赢,永远剩一张。"""
    pid, (s1, _, _) = make_plan()
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    date_her.add_photo(pid, s1, JPG, "a", client_id="c-1", now=T(10, 28, 19))
    b = date_her.add_photo(pid, s1, JPG, "b", client_id="c-2", replace=True, now=T(10, 28, 19, 1))
    c_ = date_her.add_photo(pid, s1, PNG, "c", client_id="c-3", replace=True, now=T(10, 28, 19, 2))
    ids = [p["id"] for p in date_her.state(pid, now=T(10, 28, 19, 3))["photos"]]
    assert ids == [c_["id"]] and b["id"] not in ids
