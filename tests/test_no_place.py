""":一站也可以是一件事、没有固定地点(no_place)。

验收:他建 no_place 站 → 不报缺地址、前后不要求路段、能寄出、到点公开;给它写路段 → 拒并带原因;
她的投影带 no_place;她补记里不带坐标的站能存;地图范围不含 no_place 站;他的详情地址行换成固定一句。
全部临时库(conftest)、假时钟、禁网络。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime

import pytest

from conftest import local_client, local_tools
from ephemera_date import config
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from conftest import TZ

NOW = datetime(2026, 10, 23, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"
SENTENCE = "一站也可以是一件事、没有固定地点（no_place）：比如一起买一束花。这种站不填地址和坐标，不进地图、不算路段，时间照写，到点照样公开给她。"


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    assert str(tmp_path) in config.db_path()
    clock = {"now": NOW}
    monkeypatch.setattr(dt, "_now", lambda: clock["now"])
    monkeypatch.setattr(dp, "_now", lambda: clock["now"])

    dp._connect().close()
    yield clock


TOOLS = local_tools()


def call(name, **args):
    out = TOOLS[name](args)
    if asyncio.iscoroutine(out):
        out = asyncio.run(out)
    return out


def ok(r):
    assert r["ok"], r["errors"]
    return r


def fail(r, code):
    assert not r["ok"], r
    assert code in [e["code"] for e in r["errors"]], r["errors"]
    return r


def stops(pid):
    return dp.snapshot(pid, now=NOW)["state"]["stops"]


FLOWER = dict(kind="moment", time="20:00", title="一起买一束花", clue="你挑颜色", no_place=True)


def plan_with_flower():
    """集合 19:00(17:30 公开)→ 一件事 20:00(买花,没有固定地点)→ 晚餐 20:30(路段从集合站出发)。"""
    pid = ok(dp.open_plan("Flowers", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="青石区1", clue="改札",
                                        reveal_at="17:30", lat=35.644, lng=139.699), now=NOW))
    ok(dp.edit(pid, "add_stop", FLOWER, now=NOW))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="20:30", title="Le Petit Pot", address="青石区2",
                                        clue="河边", lat=35.642, lng=139.700), now=NOW))
    s1, s2, s3 = [s["id"] for s in stops(pid)]
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="walk", minutes=6, depart_time="20:20"), now=NOW))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    return pid, (s1, s2, s3)


# ── 他建 no_place 站 ──────────────────────────────────────────────────────────────────
def test_no_place_stop_needs_no_address_or_leg_and_can_be_sent_and_revealed():
    pid, (s1, s2, s3) = plan_with_flower()
    snap = dp.snapshot(pid, now=NOW)
    assert snap["check"] == {"errors": [], "missing": []}            # 不报缺地址、不要求路段
    lg = next(x for x in snap["state"]["legs"] if x["to_stop_id"] == s3)
    assert lg["from_stop_id"] == s1 and not lg["stale"]              # 路段从上一个有地点的站出发
    assert dp.leg_to(snap["state"], s2) is None
    ok(dp.send(pid, now=NOW))
    st = dp.snapshot(pid, now=NOW)["state"]
    abs_ = dp.timeline(st)["abs"]
    s2d = next(s for s in st["stops"] if s["id"] == s2)
    assert dp.reveal_time(st, s2d, abs_) == abs_[s2]                 # 默认公开=到达时刻(没有路段)
    before = dp.her_plan(pid, now=T(10, 28, 19, 59))["stops"][1]
    assert before["no_place"] is True and before["place"] is None    # 没到点:看不到是什么事
    after = dp.her_plan(pid, now=T(10, 28, 20, 0))["stops"][1]
    assert after["place"]["title"] == "一起买一束花" and after["place"]["address"] is None
    assert after["place"]["lat"] is None and after["place"]["leg"] is None
    assert [x["no_place"] for x in dp.her_plan(pid, now=T(10, 28, 20, 0))["stops"]] == [False, True, False]
    # 提醒:没有路段 → 按到达前 15 分
    rem = [r for r in dp.reminder_plan(st, NOW) if r["stop_id"] == s2]
    assert len(rem) == 1 and rem[0]["basis"] == "arrival"


def test_inserting_or_removing_no_place_stop_keeps_neighbour_legs_valid_after_send():
    pid = ok(dp.open_plan("Walk", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="駅", address="a", clue="c",
                                        reveal_at="17:30"), now=NOW))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="20:30", title="店", address="b", clue="c"), now=NOW))
    s1, s3 = [s["id"] for s in stops(pid)]
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="walk", minutes=6, depart_time="20:20"), now=NOW))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(pid, now=NOW))
    ok(dp.edit(pid, "add_stop", {**FLOWER, "position": 2}, now=NOW))   # 寄出后插进来,不用重写路段
    st = dp.snapshot(pid, now=NOW)
    assert st["check"]["missing"] == [] and not any(lg["stale"] for lg in st["state"]["legs"])
    s2 = st["state"]["stops"][1]["id"]
    ok(dp.edit(pid, "remove_stop", {"stop_id": s2}, now=NOW))
    assert not any(lg["stale"] for lg in dp.snapshot(pid, now=NOW)["state"]["legs"])


FIRST_TXT = "第 1 站是你们集合的地方，要有固定地点，不能标 no_place"


def _first_fail(r):
    r = fail(r, "first_no_place")
    assert r["errors"][0]["text"] == FIRST_TXT
    return r


def test_first_stop_cannot_be_no_place_on_every_path():
    """他写的约会第 1 站是集合的地方,必须有固定地点。加站/改站/删站/挪站让第 1 站变成 no_place 一律拒。"""
    pid = ok(dp.open_plan("Home", DAY, "rose", now=NOW))["plan_id"]
    _first_fail(dp.edit(pid, "add_stop", dict(FLOWER), now=NOW))                    # 空约会加的第一站
    pid, (s1, s2, s3) = plan_with_flower()
    _first_fail(dp.edit(pid, "add_stop", {**FLOWER, "time": "18:30", "position": 1}, now=NOW))
    _first_fail(dp.edit(pid, "update_stop", dict(stop_id=s1, no_place=True, address="", lat=None, lng=None),
                        now=NOW))
    _first_fail(dp.edit(pid, "remove_stop", dict(stop_id=s1), now=NOW))          # 删掉集合站,一件事顶上来
    _first_fail(dp.edit(pid, "move_stop", dict(stop_id=s2, to=1), now=NOW))
    _first_fail(dp.edit(pid, "move_stop", dict(stop_id=s1, to=3), now=NOW))
    t, err = call("date_edit", plan=pid, op="move_stop", stop_id=s2, to=1)
    assert err and FIRST_TXT in t
    assert [s["id"] for s in stops(pid)] == [s1, s2, s3]                              # 都没生效
    ok(dp.send(pid, now=NOW))
    _first_fail(dp.edit(pid, "remove_stop", dict(stop_id=s1), now=NOW))


def test_check_flags_legacy_no_place_first_stop_and_send_refuses():
    pid, (s1, s2, s3) = plan_with_flower()
    c = sqlite3.connect(config.db_path())                     # 兜底:库里已经是 no_place 首站(规则之前的数据)
    c.execute("UPDATE date_stops SET no_place=1, address=NULL, lat=NULL, lng=NULL WHERE id=?", (s1,))
    c.execute("UPDATE date_legs SET deleted_at=1 WHERE plan_id=?", (pid,))
    c.commit()
    c.close()
    miss = dp.snapshot(pid, now=NOW)["check"]["missing"]
    assert any(m["code"] == "first_no_place" and m["text"] == FIRST_TXT for m in miss)
    ok(dp.edit(pid, "set_card", dict(text="别的修改不被它挡"), now=NOW))
    t, err = call("date_send", plan=pid)
    assert err and t.startswith("没寄出：还缺") and FIRST_TXT in t


def test_backfill_and_her_patch_may_start_with_no_place():
    """分叉:她补记的约会是已结束的、不寄出,没有公开时间的问题,第 1 站可以是「一件事」;她的 PATCH 同理。"""
    v = dp.her_backfill({"client_id": "f-1", "date": "2026-05-03", "title_en": "Home", "color": "sky", "stops": [
        {"kind": "cafe", "time": "09:00", "title": "一起做早饭", "no_place": True},
        {"kind": "cinema", "time": "13:00", "title": "小影院", "lat": 35.7, "lng": 139.7}]}, now=NOW)
    assert [s["no_place"] for s in v["stops"]] == [True, False]
    v = dp.her_edit(v["id"], [{"op": "add_stop", "position": 1, "kind": "walk", "time": "08:00",
                               "title": "一起散步出门", "no_place": True}], now=NOW)
    assert [s["no_place"] for s in v["stops"]] == [True, True, False]


def test_her_no_place_clears_walk_path_with_event():
    his = ok(dp.open_plan("Walk", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(his, "add_stop", dict(kind="train", time="19:00", title="駅", address="a", clue="c",
                                        reveal_at="17:30", lat=35.64, lng=139.69), now=NOW))
    ok(dp.edit(his, "add_stop", dict(kind="walk", time="19:30", title="川沿い", address="b", clue="c",
                                        walk_path=[[35.64, 139.69], [35.65, 139.70]]), now=NOW))
    ok(dp.edit(his, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    s1, s2 = [s["id"] for s in stops(his)]
    # 他:带散步路线改 no_place = 拒,回执写明要先清散步路线
    r = fail(dp.edit(his, "update_stop", dict(stop_id=s2, no_place=True, address=""), now=NOW), "no_place_place")
    assert "散步路线" in r["errors"][0]["text"] and "walk_path 传空" in r["errors"][0]["text"]
    ok(dp.send(his, now=NOW))
    ok(dp.close(his, "好", now=T(10, 28, 22)))
    v = dp.her_edit(his, [{"op": "update_stop", "stop_id": s2, "no_place": True}], now=T(10, 29, 9))
    assert v["stops"][1]["no_place"] is True and v["stops"][1]["place"]["walk_path"] is None
    ev = {d["field"]: (t, d) for t, d in _her_events(his)}
    assert ev["walk_path"][1]["before"] == "有散步路线" and ev["walk_path"][1]["after"] == "无"
    assert ev["walk_path"][0] == "她清掉了第 2 站的散步路线"
    assert set(ev) == {"address", "walk_path", "no_place"}


def test_insert_remove_no_place_before_public_leg_live():
    pid, (s1, s2, s3) = plan_with_flower()
    ok(dp.send(pid, now=NOW))
    later = T(10, 28, 20, 25)                                   # 第 3 站与通往它的路段已公开
    assert dp.her_plan(pid, now=later)["stops"][2]["place"]["leg"] is not None
    ok(dp.edit(pid, "add_stop", dict(kind="moment", time="20:28", title="一起喝一口水", clue="c", no_place=True,
                                        position=3), now=later))
    st = dp.snapshot(pid, now=later)
    assert not any(lg["stale"] for lg in st["state"]["legs"]) and st["check"]["missing"] == []
    new_id = st["state"]["stops"][2]["id"]
    ok(dp.edit(pid, "remove_stop", dict(stop_id=new_id), now=later))
    assert not any(lg["stale"] for lg in dp.snapshot(pid, now=later)["state"]["legs"])
    # 已公开的一件事站(第 2 站 20:00 已到点)照「她已经看到的站不能删」的原规则
    fail(dp.edit(pid, "remove_stop", dict(stop_id=s2), now=later), "public_stop")


def test_consecutive_no_place_stops():
    pid = ok(dp.open_plan("Many", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="18:00", title="駅", address="a", clue="c",
                                        reveal_at="17:30"), now=NOW))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="21:00", title="店", address="b", clue="c"), now=NOW))
    a, b = [s["id"] for s in stops(pid)]
    ok(dp.edit(pid, "set_leg", dict(to_stop=b, mode="walk", minutes=5, depart_time="20:50"), now=NOW))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(pid, now=NOW))
    for pos, (t, title) in ((2, ("19:00", "一起买花")), (3, ("19:30", "一起写卡片")), (4, ("20:00", "一起拍照"))):
        ok(dp.edit(pid, "add_stop", dict(kind="moment", time=t, title=title, clue="c", no_place=True,
                                            position=pos), now=NOW))
    st = dp.snapshot(pid, now=NOW)
    assert st["check"]["missing"] == [] and not any(lg["stale"] for lg in st["state"]["legs"])
    lg = next(x for x in st["state"]["legs"] if x["to_stop_id"] == b)
    assert lg["from_stop_id"] == a
    mid = st["state"]["stops"][2]["id"]
    ok(dp.edit(pid, "remove_stop", dict(stop_id=mid), now=NOW))
    assert not any(lg["stale"] for lg in dp.snapshot(pid, now=NOW)["state"]["legs"])
    view = dp.her_plan(pid, now=T(10, 28, 22))


def test_cross_midnight_insert_remove_reveal_and_reminders():
    pid = ok(dp.open_plan("Late", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="23:00", title="駅", address="a", clue="c",
                                        reveal_at="22:30"), now=NOW))
    ok(dp.edit(pid, "add_stop", dict(kind="viewpoint", time="00:40", title="展望台", address="b", clue="c"), now=NOW))
    a, b = [s["id"] for s in stops(pid)]
    ok(dp.edit(pid, "set_leg", dict(to_stop=b, mode="taxi", minutes=15, depart_time="00:20"), now=NOW))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(pid, now=NOW))

    def plan_state():
        st = dp.snapshot(pid, now=NOW)["state"]
        return st, dp.timeline(st)["abs"]
    st, abs0 = plan_state()
    ok(dp.edit(pid, "add_stop", dict(kind="moment", time="23:50", title="一起买夜宵", clue="c", no_place=True,
                                        position=2), now=NOW))
    st, abs_ = plan_state()
    np_ = st["stops"][1]
    assert abs_[np_["id"]] == T(10, 28, 23, 50) and abs_[b] == abs0[b] == T(10, 29, 0, 40)
    assert dp.reveal_time(st, np_, abs_) == T(10, 28, 23, 50)
    sb = next(s for s in st["stops"] if s["id"] == b)
    assert dp.reveal_time(st, sb, abs_) == T(10, 29, 0, 20)        # 第 3 站仍按路段出发公开
    rem = {r["stop_id"]: r for r in dp.reminder_plan(st, NOW) if r["kind"] == "stop"}
    assert rem[np_["id"]]["basis"] == "arrival" and rem[np_["id"]]["fire_at"] == T(10, 28, 23, 35)
    # 第 3 站地点 00:20(路段出发)才公开,出发前 15 分 00:05 她还看不到 → 按到达(原规则,防露路程长短)
    assert rem[b]["basis"] == "arrival" and rem[b]["fire_at"] == T(10, 29, 0, 25)
    ok(dp.edit(pid, "remove_stop", dict(stop_id=np_["id"]), now=NOW))
    st, abs_ = plan_state()
    assert abs_[b] == T(10, 29, 0, 40) and not any(lg["stale"] for lg in st["legs"])
    rem = {r["stop_id"]: r for r in dp.reminder_plan(st, NOW) if r["kind"] == "stop"}
    assert set(rem) == {a, b} and rem[b]["fire_at"] == T(10, 29, 0, 25)


def test_old_db_without_no_place_column_migrates(tmp_path):
    db = str(tmp_path / "old.db")
    cols = [c for c in dp._TABLES["date_stops"]["cols"] if c[0] != "no_place"]
    body = ",\n  ".join([f"{c} {decl}" for c, decl, _ in cols] + dp._TABLES["date_stops"]["extra"])
    c = sqlite3.connect(db)
    c.execute(f"CREATE TABLE date_stops (\n  {body}\n)")
    c.execute("INSERT INTO date_stops (plan_id, ord, kind, title) VALUES (1, 1, 'cafe', '旧站')")
    c.commit()
    assert "no_place" not in {r[1] for r in c.execute("PRAGMA table_info(date_stops)")}
    c.close()
    conn = dp._connect(db)
    try:
        assert "no_place" in {r[1] for r in conn.execute("PRAGMA table_info(date_stops)")}
        assert [tuple(r) for r in conn.execute("SELECT no_place FROM date_stops")] == [(0,)]
        dp.ensure_schema(conn)                                  # 再跑一遍无副作用
    finally:
        conn.close()


# ── 拒绝 ─────────────────────────────────────────────────────────────────────────────
def test_leg_on_no_place_rejected_with_reason():
    pid, (s1, s2, s3) = plan_with_flower()
    r = fail(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="walk", minutes=3), now=NOW), "no_place_leg")
    assert "没有固定地点，不算路段" in r["errors"][0]["text"]
    fail(dp.edit(pid, "add_stop", dict(kind="moment", time="21:00", title="x", clue="c", no_place=True,
                                          legs=[{"to_stop": s2, "mode": "walk"}]), now=NOW), "no_place_leg")
    t, err = call("date_edit", plan=pid, op="set_leg", to_stop=s2, mode="walk", minutes=3)
    assert err and t.startswith("没改成：") and "不算路段" in t


def test_no_place_with_address_or_coords_rejected_not_silently_cleared():
    pid, (s1, s2, s3) = plan_with_flower()
    for extra in (dict(address="花屋"), dict(lat=35.6, lng=139.7), dict(walk_path=[[35.6, 139.7]])):
        r = fail(dp.edit(pid, "update_stop", dict(stop_id=s2, **extra), now=NOW), "no_place_place")
        assert "还留着" in r["errors"][0]["text"] and "或者去掉 no_place" in r["errors"][0]["text"], extra
    fail(dp.edit(pid, "add_stop", dict(kind="moment", time="21:00", title="x", clue="c", address="y", no_place=True),
                 now=NOW), "no_place_place")
    # 把有地址的站改成 no_place:不一起清地址=拒;一起清=行
    fail(dp.edit(pid, "update_stop", dict(stop_id=s1, no_place=True), now=NOW), "first_no_place")   # 集合站优先拦
    # 通往它的路段还在 → 拒并说先 remove_leg
    r = fail(dp.edit(pid, "update_stop", dict(stop_id=s3, no_place=True, address="", lat=None, lng=None), now=NOW),
             "no_place_leg")
    assert "remove_leg" in r["errors"][0]["text"]
    ok(dp.edit(pid, "remove_leg", dict(to_stop=s3), now=NOW))
    ok(dp.edit(pid, "update_stop", dict(stop_id=s3, no_place=True, address="", lat=None, lng=None), now=NOW))
    assert dp.snapshot(pid, now=NOW)["check"]["missing"] == []
    fail(dp.edit(pid, "update_stop", dict(stop_id=s3, no_place="yes"), now=NOW), "bad_no_place")


def test_switching_public_leg_stop_to_no_place_drops_its_leg_after_send():
    """寄出后把一站改成没有固定地点,通往它的路段(她看到过也一样)系统直接撤掉,不再拦。"""
    pid, (s1, s2, s3) = plan_with_flower()
    ok(dp.send(pid, now=NOW))
    later = T(10, 28, 20, 25)                                     # 第 3 站与路段已公开
    ok(dp.edit(pid, "update_stop", dict(stop_id=s3, no_place=True, address="", lat=None, lng=None), now=later))
    assert dp.leg_to(dp.snapshot(pid, now=later)["state"], s3) is None


# ── 地图 / 她那边 ─────────────────────────────────────────────────────────────────────────
def test_her_backfill_and_edit_accept_no_place():
    body = {"client_id": "np-1", "date": "2026-05-03", "title_en": "Spring", "color": "sky", "stops": [
        {"kind": "train", "time": "13:00", "title": "南山站", "lat": 35.71, "lng": 139.77},
        {"kind": "shopping", "time": "14:00", "title": "一起买一束花", "no_place": True},
        {"kind": "cafe", "time": "15:00", "title": "没坐标的喫茶"},              # 不传 no_place、没坐标:照旧能存
    ]}
    v = dp.her_backfill(body, now=NOW)
    pid = v["id"]
    assert [s["no_place"] for s in v["stops"]] == [False, True, False]
    assert v["stops"][2]["place"]["lat"] is None
    with pytest.raises(dp.HerEditError) as e:
        dp.her_backfill({**body, "client_id": "np-2",
                         "stops": [{"kind": "cafe", "title": "x", "no_place": True, "address": "y"}]}, now=NOW)
    assert e.value.code == "no_place_place"
    with pytest.raises(dp.HerEditError) as e:
        dp.her_backfill({**body, "client_id": "np-3", "stops": [{"kind": "cafe", "title": "x", "no_place": 1}]}, now=NOW)
    assert e.value.field == "no_place"
    st = dp.snapshot(pid, now=NOW)["state"]["stops"]
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": st[2]["id"], "no_place": True},
                          {"op": "add_stop", "kind": "walk", "time": "16:00", "title": "一起走回家", "no_place": True}],
                    now=NOW)
    assert [s["no_place"] for s in v["stops"]] == [False, True, True, True]
    texts = [r[0] for r in sqlite3.connect(config.db_path()).execute(
        "SELECT text FROM date_events WHERE plan_id=? AND kind='her_edit' ORDER BY id", (pid,))]
    #  她自己补的站选「一件事」= 种类也跟着变成一件事(各落一条)
    assert texts[:2] == ["她把第 3 站种类从 咖啡 改成 一件事", "她把第 3 站改成了一件事、没有固定地点"]
    # 「一件事」和地址/坐标同一项一起传 = 拒(含 null),说清原因
    for extra in ({"lat": None, "lng": None}, {"address": "x"}):
        with pytest.raises(dp.HerEditError) as e:
            dp.her_edit(pid, [{"op": "update_stop", "stop_id": st[0]["id"], "no_place": True, **extra}], now=NOW)
        assert e.value.code == "no_place_place" and "自动清掉" in e.value.text


def _her_events(pid):
    c = sqlite3.connect(config.db_path())
    try:
        return [(t, json.loads(d)) for t, d in c.execute(
            "SELECT text, detail_json FROM date_events WHERE plan_id=? AND kind='her_edit' ORDER BY id", (pid,))]
    finally:
        c.close()


def test_her_pick_no_place_clears_old_place_and_picking_a_place_reverts():
    """页面只传 {title, no_place:true} → 原地址坐标清空、落改前改后;再选候选地点(address+lat+lng)→ no_place 自动回 0。
    他写的站她也能这样改(在她能改时间地点的范围内)。"""
    his = ok(dp.open_plan("Night", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(his, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="青石区1", clue="c",
                                        reveal_at="17:30", lat=35.644, lng=139.699), now=NOW))
    ok(dp.edit(his, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(his, now=NOW))
    ok(dp.close(his, "那天很好", now=T(10, 28, 23)))
    sid = stops(his)[0]["id"]
    later = T(10, 29, 9)
    v = dp.her_edit(his, [{"op": "update_stop", "stop_id": sid, "title": "一起买一束花", "no_place": True}], now=later)
    p = v["stops"][0]
    assert p["no_place"] is True and p["place"] is not None              # place 仍是对象,不是 null
    assert p["place"]["title"] == "一起买一束花" and p["place"]["address"] is None and p["place"]["lat"] is None
    ev = _her_events(his)
    assert [d["field"] for _, d in ev] == ["title", "address", "coord", "no_place"]
    assert ev[1][1]["before"] == "青石区1" and ev[1][1]["after"] is None
    assert ev[2][1]["before"] == [35.644, 139.699] and ev[2][1]["after"] == [None, None]
    assert ev[3][0] == "她把第 1 站改成了一件事、没有固定地点"
    v = dp.her_edit(his, [{"op": "update_stop", "stop_id": sid, "title": "花屋", "address": "青石区3",
                           "lat": 35.641, "lng": 139.701}], now=later)
    p = v["stops"][0]
    assert p["no_place"] is False and p["place"]["address"] == "青石区3" and p["place"]["lat"] == 35.641
    assert _her_events(his)[-1][0] == "她给第 1 站改回了固定地点"
    t, err = call("date_view", plan=his)
    assert not err and "没有固定地点 是 → 否" in t


# ── 他看到的 ─────────────────────────────────────────────────────────────────────────
def test_detail_shows_fixed_line_instead_of_address():
    pid, (s1, s2, s3) = plan_with_flower()
    t, err = call("date_view", plan=pid)
    assert not err
    lines = t.splitlines()
    i = next(k for k, l in enumerate(lines) if l.startswith("第 2 站"))
    assert lines[i + 1] == "  一件事 · 没有固定地点"
    assert lines[i + 2].startswith("  公开：")
    assert not any(l.startswith("  地址：") for l in lines[i + 1:i + 3])
    assert sum(1 for l in lines if l.startswith("  地址：")) == 2


def test_tool_takes_no_place_and_description_verbatim():
    d = next(x for x in dt.tool_schemas() if x["name"] == "date_edit")
    assert SENTENCE in d["description"]
    assert d["input_schema"]["properties"]["no_place"] == {"type": "boolean"}
    pid = ok(dp.open_plan("Tool", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="駅", address="a", clue="c"), now=NOW))
    t, err = call("date_edit", plan=pid, op="add_stop", kind="moment", time="20:00", title="一起买一束花",
                  clue="c", no_place=True)
    assert not err, t
    assert dp.snapshot(pid, now=NOW)["state"]["stops"][1]["no_place"] == 1


def test_migration_adds_no_place_idempotently():
    conn = dp._connect()
    try:
        dp.ensure_schema(conn)
        dp.ensure_schema(conn)
        assert "no_place" in {r[1] for r in conn.execute("PRAGMA table_info(date_stops)")}
    finally:
        conn.close()


def _make_legacy_first(pid, s1):
    c = sqlite3.connect(config.db_path())       # 规则之前就已经是 no_place 首站的旧数据
    c.execute("UPDATE date_stops SET no_place=1, address=NULL, lat=NULL, lng=NULL WHERE id=?", (s1,))
    c.commit()
    c.close()


def test_legacy_sent_no_place_first_stop_does_not_block_edits_or_close():
    """已寄出、首站已是 no_place 的旧约会——别的修改与当天结束照做;缺项照样列给他看;寄出前提仍拦。"""
    pid, (s1, s2, s3) = plan_with_flower()
    ok(dp.send(pid, now=NOW))
    _make_legacy_first(pid, s1)
    ok(dp.edit(pid, "set_card", dict(text="照样能写"), now=NOW))
    t, err = call("date_view", plan=pid)
    assert not err and "第 1 站的固定地点" in t                   # 缺项照样列出
    ok(dp.close(pid, "那天很好", now=T(10, 28, 23)))
    assert dp.snapshot(pid, now=T(10, 28, 23, 5))["phase"] == "done"


def test_legacy_draft_still_cannot_be_sent_and_new_cases_still_rejected_after_send():
    pid, (s1, s2, s3) = plan_with_flower()
    _make_legacy_first(pid, s1)
    fail(dp.send(pid, now=NOW), "send_first_no_place")
    pid2, (a1, a2, a3) = plan_with_flower()
    ok(dp.send(pid2, now=NOW))
    fail(dp.edit(pid2, "move_stop", dict(stop_id=a2, to=1), now=NOW), "first_no_place")


def test_done_first_stop_no_place_her_ok_his_rejected():
    pid, (s1, s2, s3) = plan_with_flower()
    ok(dp.send(pid, now=NOW))
    ok(dp.close(pid, "好", now=T(10, 28, 23)))
    later = T(10, 29, 9)
    r = dp.edit(pid, "update_stop", dict(stop_id=s1, no_place=True, address="", lat=None, lng=None), now=later)
    assert not r["ok"] and "只能写 note" in r["errors"][0]["text"]     # 他结束后照旧改不了站
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": s1, "no_place": True}], now=later)
    assert v["stops"][0]["no_place"] is True and v["stops"][0]["place"]["address"] is None
