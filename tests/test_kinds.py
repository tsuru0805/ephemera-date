""":站的种类 19 个大类 + 细类 + 按谷歌地点类型自动分类。

验收:19 类 + 细类校验;一件事 ⇔ 没有固定地点各条路径;自动分类样例;kinds 端点;她的补记/编辑收 subtype。
全部临时库、假时钟、禁网络(地点搜索走 httpx.MockTransport 假适配器)。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime

import pytest

from conftest import local_client, local_tools
from ephemera_date import config
from ephemera_date import kinds as dk
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from conftest import TZ

NOW = datetime(2026, 10, 23, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"
SENTENCE = ("kind 是大类（19 种，见枚举）；subtype 是细类（可选，可以用该大类的细类之一，也可以自己写，12 字以内）；"
            "kind=moment 表示一件事，没有固定地点，不写 subtype。")

@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    assert str(tmp_path) in config.db_path()
    monkeypatch.setattr(dt, "_now", lambda: NOW)
    monkeypatch.setattr(dp, "_now", lambda: NOW)

    dp._connect().close()
    yield


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


def plan():
    pid = ok(dp.open_plan("Kinds", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", subtype="地铁站", time="19:00", title="梧桐駅", address="a",
                                        clue="c", reveal_at="17:30"), now=NOW))
    return pid


def _client():
    return local_client()


# ── 表 ────────────────────────────────────────────────────────────────────────────────
def test_kind_table_is_her_19():
    assert list(dk.KINDS) == ["train", "dinner", "cafe", "sweets", "bar", "cinema", "live", "museum", "aquarium",
                              "amusement", "play", "walk", "park", "viewpoint", "shrine", "shopping", "onsen",
                              "stay", "moment"]
    assert dk.KINDS["sweets"] == "甜品·面包" and dk.KINDS_EN["aquarium"] == "AQUARIUM & ZOO"
    assert dk.SUBTYPES["shopping"][2] == "眼镜店" and dk.SUBTYPES["moment"] == ()
    assert dp.KINDS is dk.KINDS
    assert dk.label("dinner", "拉面") == "晚餐·拉面" and dk.label("dinner") == "晚餐" and dk.label("moment", "x") == "一件事"


# ── (dinner 同一类,不加新类;按 time 显示「午餐/晚餐」)────────────────
def test_dinner_zh_en_boundary():
    assert dk.dinner_zh_en("16:29") == ("午餐", "LUNCH")       # 边界:早于分界 → 午餐
    assert dk.dinner_zh_en("16:30") == ("晚餐", "DINNER")      # 边界:分界本身算晚餐
    assert dk.dinner_zh_en(None) == ("晚餐", "DINNER")          # 空
    assert dk.dinner_zh_en("not-a-time") == ("晚餐", "DINNER")  # 非法格式,默认档,不猜
    assert dk.dinner_zh_en("7:30") == ("晚餐", "DINNER")        # 非法格式(没补零)


def test_label_dinner_uses_time():
    assert dk.label("dinner", None, "12:00") == "午餐"
    assert dk.label("dinner", "拉面", "12:00") == "午餐·拉面"
    assert dk.label("dinner", None, "16:30") == "晚餐"
    assert dk.label("dinner", None, "19:30") == "晚餐"
    assert dk.label("dinner", None, None) == "晚餐"             # 没传 time:默认档


def test_stop_label_and_view_follow_time():
    pid = ok(dp.open_plan("Lunch Then Dinner", DAY, "rose", now=NOW))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="12:00", title="面馆一号", address="b", clue="c",
                                        reveal_at="10:00"), now=NOW))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="19:30", title="Le Petit Pot", address="d",
                                        clue="e"), now=NOW))
    s1, s2 = stops(pid)[0], stops(pid)[1]
    assert dp.stop_label(s1) == "午餐" and dp.stop_label(s2) == "晚餐"
    t, err = call("date_view", plan=pid)
    assert not err and "午餐（dinner）" in t and "晚餐（dinner）" in t
    # 跨分界的 time 编辑:电报里「类型改了」跟着一起变(与「时间改了」同一笔一起发)
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(pid, now=NOW))
    r = ok(dp.edit(pid, "update_stop", dict(stop_id=s1["id"], time="17:00"), now=NOW))
    texts = [e["text"] for e in dp.her_events(pid, now=NOW) if e["id"] in r["events"]]
    assert texts == ["集合时间改了：12:00 → 17:00；第 1 站类型改了：午餐 → 晚餐"]


def test_kinds_endpoint_shape():
    j = _client().get("/api/dates/kinds").json()
    assert j["subtype_max"] == 12 and len(j["kinds"]) == 19
    assert j["kinds"][1] == {"kind": "dinner", "zh": "午餐 / 晚餐", "en": "LUNCH / DINNER",
                             "subtypes": ["餐馆", "拉面", "寿司", "烤肉", "居酒屋", "定食", "意大利菜", "法餐", "中餐", "韩餐"],
                             "custom": True, "no_place": False,
                             "by_time": {"before": "16:30", "zh": "午餐", "en": "LUNCH",
                                         "else_zh": "晚餐", "else_en": "DINNER"}}
    assert j["kinds"][-1] == {"kind": "moment", "zh": "一件事", "en": "SOMETHING WE DID", "subtypes": [],
                              "custom": False, "no_place": True}


# ── 细类校验 ──────────────────────────────────────────────────────────────────────────────
def test_subtype_preset_custom_and_limits():
    pid = plan()
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", subtype="拉面", time="19:30", title="面馆一号", address="b",
                                        clue="c"), now=NOW))
    ok(dp.edit(pid, "add_stop", dict(kind="cafe", subtype="猫头鹰咖啡", time="20:30", title="x", address="b",
                                        clue="c"), now=NOW))                      # 自定义,原样存
    assert [s["subtype"] for s in stops(pid)] == ["地铁站", "拉面", "猫头鹰咖啡"]
    fail(dp.edit(pid, "update_stop", dict(stop_id=stops(pid)[1]["id"], subtype="字" * 13), now=NOW),
         "long_subtype")
    fail(dp.edit(pid, "update_stop", dict(stop_id=stops(pid)[1]["id"], subtype="拉\n面"), now=NOW), "bad_subtype")
    fail(dp.edit(pid, "update_stop", dict(stop_id=stops(pid)[1]["id"], kind="karaoke"), now=NOW), "bad_kind")
    ok(dp.edit(pid, "update_stop", dict(stop_id=stops(pid)[1]["id"], subtype=""), now=NOW))
    assert stops(pid)[1]["subtype"] is None


def test_tool_enum_subtype_param_and_sentence():
    e = next(x for x in dt.tool_schemas() if x["name"] == "date_edit")
    assert e["input_schema"]["properties"]["kind"]["enum"] == list(dk.KINDS)
    assert e["input_schema"]["properties"]["subtype"] == {"type": "string"}
    assert SENTENCE in e["description"]
    assert "dinner=吃饭，她那边按这一站的 time 显示「午餐」（16:30 前）或「晚餐」（16:30 起）。" in e["description"]
    pid = plan()
    t, err = call("date_edit", plan=pid, op="add_stop", kind="sweets", subtype="和果子", time="19:30", title="虎屋",
                  address="b", clue="c")
    assert not err and "甜品·面包·和果子（sweets）" in t
    t, err = call("date_view", plan=pid)
    assert "集合·地铁站（train）" in t


# ── 一件事 ⇔ 没有固定地点 ─────────────────────────────────────────────────────────────────
def test_moment_binding_his_paths():
    pid = plan()
    ok(dp.edit(pid, "add_stop", dict(kind="moment", time="19:30", title="一起买花", clue="c"), now=NOW))
    assert stops(pid)[1]["no_place"] == 1                                        # 选 moment 自动 no_place
    ok(dp.edit(pid, "add_stop", dict(no_place=True, time="20:00", title="一起写卡片", clue="c"), now=NOW))
    assert stops(pid)[2]["kind"] == "moment"                                     # 只设 no_place = 一件事
    r = fail(dp.edit(pid, "add_stop", dict(kind="cafe", no_place=True, time="20:30", title="x", clue="c"), now=NOW),
             "moment_kind")
    assert "kind=moment" in r["errors"][0]["text"]
    fail(dp.edit(pid, "add_stop", dict(kind="moment", subtype="买花", time="20:30", title="x", clue="c"), now=NOW),
         "moment_subtype")
    s2 = stops(pid)[1]["id"]
    fail(dp.edit(pid, "update_stop", dict(stop_id=s2, no_place=False), now=NOW), "moment_place")
    r = fail(dp.edit(pid, "update_stop", dict(stop_id=s2, kind="shopping"), now=NOW), "moment_needs_place")
    assert "补地点" in r["errors"][0]["text"]
    ok(dp.edit(pid, "update_stop", dict(stop_id=s2, kind="shopping", subtype="花店", address="花屋"), now=NOW))
    s = stops(pid)[1]
    assert (s["kind"], s["no_place"], s["subtype"]) == ("shopping", 0, "花店")
    # 带细类的站改成一件事:细类要一起清,地址也要清
    fail(dp.edit(pid, "update_stop", dict(stop_id=s2, kind="moment", address=""), now=NOW), "moment_subtype")
    ok(dp.edit(pid, "update_stop", dict(stop_id=s2, kind="moment", address="", subtype=""), now=NOW))
    # 第 1 站不能是一件事(集合的地方)
    fail(dp.edit(pid, "update_stop", dict(stop_id=stops(pid)[0]["id"], kind="moment", address="", subtype=""),
                 now=NOW), "first_no_place")


def test_legacy_no_place_with_other_kind_reads_as_moment_without_db_change():
    pid = plan()
    ok(dp.edit(pid, "add_stop", dict(kind="moment", time="19:30", title="一起买花", clue="c"), now=NOW))
    sid = stops(pid)[1]["id"]
    c = sqlite3.connect(config.db_path())
    c.execute("UPDATE date_stops SET kind='cafe', subtype='茶馆' WHERE id=?", (sid,))
    c.commit()
    c.close()
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(pid, now=NOW))
    v = dp.her_plan(pid, now=datetime(2026, 10, 28, 20, tzinfo=TZ))
    assert (v["stops"][1]["kind"], v["stops"][1]["subtype"]) == ("moment", None)
    t, _ = call("date_view", plan=pid)
    assert "一件事（moment）" in t
    c = sqlite3.connect(config.db_path())
    assert c.execute("SELECT kind, subtype FROM date_stops WHERE id=?", (sid,)).fetchone() == ("cafe", "茶馆")
    c.close()


# ── 她那边 ───────────────────────────────────────────────────────────────────────────────
def test_her_backfill_and_patch_subtype_and_moment():
    v = dp.her_backfill({"client_id": "k-1", "date": "2026-05-03", "title_en": "Spring", "color": "sky", "stops": [
        {"kind": "dinner", "subtype": "拉面", "time": "12:00", "title": "面馆一号", "lat": 35.7, "lng": 139.7},
        {"kind": "moment", "time": "13:00", "title": "一起买花"},
        {"kind": "cafe", "no_place": True, "time": "14:00", "title": "一起发呆"},     #  页面只传 no_place
    ]}, now=NOW)
    st = [(s["kind"], s["subtype"], s["no_place"]) for s in v["stops"]]
    assert st == [("dinner", "拉面", False), ("moment", None, True), ("moment", None, True)]
    with pytest.raises(dp.HerEditError) as e:
        dp.her_backfill({"client_id": "k-2", "date": "2026-05-03", "title_en": "X", "color": "sky",
                         "stops": [{"kind": "moment", "subtype": "买花", "title": "x"}]}, now=NOW)
    assert e.value.field == "subtype" and e.value.code == "moment_subtype"
    with pytest.raises(dp.HerEditError) as e:
        dp.her_backfill({"client_id": "k-3", "date": "2026-05-03", "title_en": "X", "color": "sky",
                         "stops": [{"kind": "cafe", "subtype": "字" * 13, "title": "x"}]}, now=NOW)
    assert e.value.field == "subtype"
    pid = v["id"]
    ids = [s["stop_id"] for s in v["stops"]]
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": ids[0], "subtype": "定食"}], now=NOW)
    assert v["stops"][0]["subtype"] == "定食"
    # 她把自己的站种类选成一件事:地址坐标、细类自动清
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": ids[0], "kind": "moment"}], now=NOW)
    assert (v["stops"][0]["kind"], v["stops"][0]["subtype"], v["stops"][0]["no_place"]) == ("moment", None, True)
    assert v["stops"][0]["place"]["lat"] is None
    # 从一件事改回别的种类:要同时选地点
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(pid, [{"op": "update_stop", "stop_id": ids[0], "kind": "dinner"}], now=NOW)
    assert e.value.code == "moment_needs_place" and e.value.field == "kind"
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": ids[0], "kind": "dinner", "subtype": "拉面",
                           "address": "x", "lat": 35.7, "lng": 139.7}], now=NOW)
    assert (v["stops"][0]["kind"], v["stops"][0]["subtype"], v["stops"][0]["no_place"]) == ("dinner", "拉面", False)
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(pid, [{"op": "update_stop", "stop_id": ids[0], "kind": "moment", "subtype": "x"}], now=NOW)
    assert e.value.code == "moment_subtype"


def test_her_cannot_change_subtype_of_his_stop():
    pid = plan()
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(pid, now=NOW))
    ok(dp.close(pid, "好", now=datetime(2026, 10, 28, 23, tzinfo=TZ)))
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(pid, [{"op": "update_stop", "stop_id": stops(pid)[0]["id"], "subtype": "车站"}],
                    now=datetime(2026, 10, 29, 9, tzinfo=TZ))
    assert e.value.status == 403 and e.value.field == "subtype"


# ── 显示 / 迁移 ────────────────────────────────────────────────────────────────────────────
def test_telegram_shows_kind_with_subtype():
    pid = plan()
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(pid, now=NOW))
    r = ok(dp.edit(pid, "update_stop", dict(stop_id=stops(pid)[0]["id"], subtype="车站"), now=NOW))
    texts = [e["text"] for e in dp.her_events(pid, now=NOW) if e["id"] in r["events"]]
    assert texts == ["第 1 站类型改了：集合·地铁站 → 集合·车站"]          # 细类对她可见,改了照样发电报


def test_art_sig_ignores_subtype_and_fixed_art_rotation():
    a = {"kind": "dinner", "title": "x", "art_hint": None, "time": "19:00", "subtype": "拉面"}
    assert dp.art_sig(a) == dp.art_sig({**a, "subtype": "寿司"})
    from ephemera_date import art as date_art
    assert set(date_art.SCENE) == set(dk.KINDS)
    # 固定画轮用:一件事按站编号在五张小事里固定挑;有备用画的种类按站轮换;同一站永远同一张
    picks = {dp.fixed_art("moment", sid) for sid in range(10)}
    assert picks == set(dp.FIXED_ART["moment"]) and len(picks) == 5
    assert dp.fixed_art("moment", 7) == dp.fixed_art("moment", 7)
    assert {dp.fixed_art("cafe", sid) for sid in range(6)} == {"cafe", "cafe_2", "cafe_3"}
    assert dp.fixed_art("museum", 4) == "museum" and dp.fixed_art(None, 1) is None
    assert set(dp.FIXED_ART) <= set(dk.KINDS)


def test_old_table_without_subtype_migrates(tmp_path):
    db = str(tmp_path / "old.db")
    cols = [c for c in dp._TABLES["date_stops"]["cols"] if c[0] != "subtype"]
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE date_stops (" + ", ".join(f"{n} {d}" for n, d, _ in cols)
              + ", " + ", ".join(dp._TABLES["date_stops"]["extra"]) + ")")
    c.execute("INSERT INTO date_stops (plan_id, ord, kind, title) VALUES (1, 1, 'cafe', '旧站')")
    c.commit()
    c.close()
    conn = dp._connect(db)
    try:
        assert [tuple(r) for r in conn.execute("SELECT kind, subtype FROM date_stops")] == [("cafe", None)]
    finally:
        conn.close()


# ═════ 一件事的兜底检查与往返 ════════════════════════════════════════════════════════
def _backfill(**over):
    body = {"client_id": "p-" + str(len(over)), "date": "2026-05-03", "title_en": "Spring", "color": "sky", "stops": [
        {"kind": "train", "time": "11:00", "title": "南山站", "lat": 35.71, "lng": 139.77},
        {"kind": "cafe", "subtype": "喫茶店", "time": "12:00", "title": "古城", "address": "南山1", "lat": 35.7,
         "lng": 139.7},
        {"kind": "moment", "time": "13:00", "title": "一起买花"}]}
    body.update(over)
    return dp.her_backfill(body, now=NOW)


def test_moment_backstop_her_single_field_bypasses_rejected():
    v = _backfill()
    pid, sid = v["id"], v["stops"][2]["stop_id"]
    for op, field, code in (({"subtype": "买花"}, "subtype", "moment_subtype"),
                            ({"no_place": False}, "no_place", "moment_place")):
        with pytest.raises(dp.HerEditError) as e:
            dp.her_edit(pid, [{"op": "update_stop", "stop_id": sid, **op}], now=NOW)
        assert (e.value.status, e.value.code, e.value.field) == (400, code, field) and e.value.text
    c = sqlite3.connect(config.db_path())
    assert c.execute("SELECT kind, no_place, subtype FROM date_stops WHERE id=?", (sid,)).fetchone() == ("moment", 1, None)
    c.close()


def test_moment_backstop_his_side_in_check():
    pid = plan()
    ok(dp.edit(pid, "add_stop", dict(kind="moment", time="19:30", title="一起买花", clue="c"), now=NOW))
    st = dp.snapshot(pid, now=NOW)["state"]
    st["stops"][1]["subtype"] = "买花"
    st["stops"][1]["no_place"] = 0
    codes = {e["code"] for e in dp.check(st, NOW)["errors"]}
    assert {"moment_subtype", "moment_place"} <= codes
    sid = stops(pid)[1]["id"]
    fail(dp.edit(pid, "update_stop", dict(stop_id=sid, subtype="买花"), now=NOW), "moment_subtype")
    fail(dp.edit(pid, "update_stop", dict(stop_id=sid, no_place=False), now=NOW), "moment_place")


def test_her_moment_roundtrip_restores_previous_kind_and_subtype():
    """旧客户端往返:把自己的站设成一件事(只传 no_place)→ 再只传地址+坐标恢复 → 回到原来的种类与细类。"""
    v = _backfill()
    pid, sid = v["id"], v["stops"][1]["stop_id"]
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": sid, "no_place": True}], now=NOW)
    assert (v["stops"][1]["kind"], v["stops"][1]["subtype"]) == ("moment", None)
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": sid, "address": "南山2", "lat": 35.71, "lng": 139.71}],
                    now=NOW)
    s = v["stops"][1]
    assert (s["kind"], s["subtype"], s["no_place"], s["place"]["address"]) == ("cafe", "喫茶店", False, "南山2")
    # 一开始就是一件事:没有「原来的种类」→ 400 说清,不猜
    msid = v["stops"][2]["stop_id"]
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(pid, [{"op": "update_stop", "stop_id": msid, "lat": 35.7, "lng": 139.7}], now=NOW)
    assert (e.value.code, e.value.field) == ("moment_kind", "kind") and "同时选种类" in e.value.text
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": msid, "kind": "shopping", "lat": 35.7, "lng": 139.7}],
                    now=NOW)
    assert (v["stops"][2]["kind"], v["stops"][2]["no_place"]) == ("shopping", False)


def test_her_roundtrip_on_his_stop_keeps_his_kind():
    pid = plan()
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.edit(pid, "add_stop", dict(kind="cafe", subtype="茶馆", time="19:30", title="茶屋", address="b",
                                        clue="c", lat=35.6, lng=139.6), now=NOW))
    ok(dp.send(pid, now=NOW))
    ok(dp.close(pid, "好", now=datetime(2026, 10, 28, 23, tzinfo=TZ)))
    later = datetime(2026, 10, 29, 9, tzinfo=TZ)
    sid = stops(pid)[1]["id"]
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": sid, "no_place": True}], now=later)
    assert (v["stops"][1]["kind"], v["stops"][1]["subtype"]) == ("moment", None)        # 显示一件事,库里种类不动
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": sid, "address": "c", "lat": 35.6, "lng": 139.6}], now=later)
    assert (v["stops"][1]["kind"], v["stops"][1]["subtype"], v["stops"][1]["no_place"]) == ("cafe", "茶馆", False)


# ═════ kind_before_moment / subtype_before_moment(内存新状态,不翻事件)═══════════════════════
def _two_stop_backfill(cid):
    v = dp.her_backfill({"client_id": cid, "date": "2026-05-03", "title_en": "Spring", "color": "sky", "stops": [
        {"kind": "cafe", "subtype": "喫茶店", "time": "12:00", "title": "古城", "lat": 35.70, "lng": 139.70},
        {"kind": "dinner", "subtype": "拉面", "time": "13:00", "title": "面馆一号", "lat": 35.71, "lng": 139.71}]},
        now=NOW)
    return v["id"], [s["stop_id"] for s in v["stops"]]


def _cols(sid):
    c = sqlite3.connect(config.db_path())
    try:
        return c.execute("SELECT kind, subtype, no_place, kind_before_moment, subtype_before_moment FROM date_stops"
                         " WHERE id=?", (sid,)).fetchone()
    finally:
        c.close()


def _ks(v):
    return [(s["kind"], s["subtype"], s["no_place"]) for s in v["stops"]]


def test_same_request_set_moment_then_restore_by_address():
    pid, (a, b) = _two_stop_backfill("bm-1")
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "no_place": True},
                          {"op": "update_stop", "stop_id": a, "address": "南山2", "lat": 35.72, "lng": 139.72}], now=NOW)
    assert _ks(v)[0] == ("cafe", "喫茶店", False)
    assert _cols(a) == ("cafe", "喫茶店", 0, None, None)                  # 恢复后两列清空


def test_two_stops_cross_switching_in_one_request_keep_own_subtypes():
    pid, (a, b) = _two_stop_backfill("bm-2")
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "no_place": True},
                          {"op": "update_stop", "stop_id": b, "no_place": True}], now=NOW)
    assert _ks(v) == [("moment", None, True), ("moment", None, True)]
    assert _cols(a)[3:] == ("cafe", "喫茶店") and _cols(b)[3:] == ("dinner", "拉面")
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": b, "lat": 35.8, "lng": 139.8},
                          {"op": "update_stop", "stop_id": a, "lat": 35.9, "lng": 139.9}], now=NOW)
    assert _ks(v) == [("cafe", "喫茶店", False), ("dinner", "拉面", False)]
    # 同一笔里四步交叉
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "no_place": True},
                          {"op": "update_stop", "stop_id": b, "no_place": True},
                          {"op": "update_stop", "stop_id": a, "lat": 35.1, "lng": 139.1},
                          {"op": "update_stop", "stop_id": b, "lat": 35.2, "lng": 139.2}], now=NOW)
    assert _ks(v) == [("cafe", "喫茶店", False), ("dinner", "拉面", False)]
    assert _cols(a)[3:] == (None, None) and _cols(b)[3:] == (None, None)


def test_multiple_roundtrips_follow_latest_kind():
    pid, (a, b) = _two_stop_backfill("bm-3")
    dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "no_place": True}], now=NOW)
    dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "lat": 35.7, "lng": 139.7}], now=NOW)
    dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "kind": "sweets", "subtype": "蛋糕店"}], now=NOW)
    dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "kind": "moment"}], now=NOW)       # 显式选一件事也记
    assert _cols(a)[3:] == ("sweets", "蛋糕店")
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "address": "x"}], now=NOW)
    assert _ks(v)[0] == ("sweets", "蛋糕店", False)


def test_explicit_kind_leaving_moment_clears_memory_and_empty_memory_rejects():
    pid, (a, b) = _two_stop_backfill("bm-4")
    dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "no_place": True}], now=NOW)
    dp.her_edit(pid, [{"op": "update_stop", "stop_id": a, "kind": "park", "lat": 35.6, "lng": 139.6}], now=NOW)
    assert _cols(a) == ("park", None, 0, None, None)
    v = dp.her_backfill({"client_id": "bm-5", "date": "2026-05-04", "title_en": "M", "color": "sky",
                         "stops": [{"kind": "moment", "time": "10:00", "title": "一起发呆"}]}, now=NOW)
    sid = v["stops"][0]["stop_id"]
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(v["id"], [{"op": "update_stop", "stop_id": sid, "lat": 35.6, "lng": 139.6}], now=NOW)
    assert (e.value.status, e.value.code, e.value.field) == (400, "moment_kind", "kind")
    assert e.value.text == "第 1 站要恢复地点请同时选种类（kind）" and "原来就是" not in e.value.text


def test_his_side_remembers_and_forgets_before_moment():
    pid = plan()
    ok(dp.edit(pid, "add_stop", dict(kind="cafe", subtype="茶馆", time="19:30", title="x", address="b", clue="c"),
               now=NOW))
    sid = stops(pid)[1]["id"]
    ok(dp.edit(pid, "update_stop", dict(stop_id=sid, kind="moment", address="", subtype=""), now=NOW))
    assert _cols(sid) == ("moment", None, 1, "cafe", "茶馆")
    ok(dp.edit(pid, "update_stop", dict(stop_id=sid, kind="cafe", address="b"), now=NOW))
    assert _cols(sid) == ("cafe", None, 0, None, None)


def test_old_table_without_before_moment_columns_migrates(tmp_path):
    db = str(tmp_path / "old2.db")
    cols = [c for c in dp._TABLES["date_stops"]["cols"] if c[0] not in ("kind_before_moment", "subtype_before_moment")]
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE date_stops (" + ", ".join(f"{n} {d}" for n, d, _ in cols)
              + ", " + ", ".join(dp._TABLES["date_stops"]["extra"]) + ")")
    c.execute("INSERT INTO date_stops (plan_id, ord, kind, title) VALUES (1, 1, 'moment', '旧')")
    c.commit()
    c.close()
    conn = dp._connect(db)
    try:
        assert [tuple(r) for r in conn.execute("SELECT kind_before_moment, subtype_before_moment FROM date_stops")] \
            == [(None, None)]
        dp.ensure_schema(conn)
    finally:
        conn.close()


# ═════ kind_editable(功能开关,与编辑口权限同一个函数)═══════════════════════════════════════
def test_kind_editable_backfill_all_true():
    pid, _ = _two_stop_backfill("ke-1")
    v = dp.her_plan(pid, now=NOW)
    assert [s["kind_editable"] for s in v["stops"]] == [True, True]
    assert "added_by" not in json.dumps(v)


def test_kind_editable_his_box_only_her_added_stops_and_not_before_done():
    pid = plan()
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    ok(dp.send(pid, now=NOW))
    assert [s["kind_editable"] for s in dp.her_plan(pid, now=NOW)["stops"]] == [False]       # 寄出后、没结束:恒 false
    ok(dp.close(pid, "好", now=datetime(2026, 10, 28, 23, tzinfo=TZ)))
    later = datetime(2026, 10, 29, 9, tzinfo=TZ)
    v = dp.her_edit(pid, [{"op": "add_stop", "kind": "cafe", "time": "23:30", "title": "她补的"}], now=later)
    assert [s["kind_editable"] for s in v["stops"]] == [False, True]
    # 与编辑口一致:false 的站改种类 403,true 的站可以改
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(pid, [{"op": "update_stop", "stop_id": v["stops"][0]["stop_id"], "subtype": "车站"}], now=later)
    assert e.value.status == 403
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": v["stops"][1]["stop_id"], "subtype": "茶馆"}], now=later)
    assert v["stops"][1]["subtype"] == "茶馆"



