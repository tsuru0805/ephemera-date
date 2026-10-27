"""Backfilling a past date + her additions after the date + the AI side (tools / ledger / late writes) + place search.

Her read API carries no provenance markers; backfilled stops queue generated art (with a generator configured),
the AI's own close does not. tmp data dir, fake clock, fake adapters (ports.install); no network.
"""
from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from datetime import datetime, timedelta

import pytest

from conftest import local_client, local_tools
from ephemera_date import config
from ephemera_date import art as date_art
from ephemera_date import ports
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from conftest import TZ

NOW = datetime(2026, 10, 22, 15, 0, tzinfo=TZ)
HIDDEN_KEYS = ("origin", "added_by", "edited_by_her_at", "written_by_her", "her_seen_upto", "client_id")


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    assert str(tmp_path) in config.db_path() and str(tmp_path) in dp.art_dir()
    clock = {"now": NOW}
    monkeypatch.setattr(dt, "_now", lambda: clock["now"])
    monkeypatch.setattr(dp, "_now", lambda: clock["now"])
    ports.install("art", FakeGen())                       # 配了生成图接口:每站现画的排队行为照旧
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "pull")
    dp._connect().close()
    yield clock


class FakeGen:
    async def generate(self, job):
        return b"ink", b"inv"


TOOLS = local_tools()


def call(name, **args):
    out = TOOLS[name](args)
    if asyncio.iscoroutine(out):
        out = asyncio.run(out)
    return out


def raw(sql, args=()):
    c = sqlite3.connect(config.db_path())
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def ok(r):
    assert r["ok"], r["errors"]
    return r


def _client():
    return local_client()


BODY = {
    "client_id": "c-1", "date": "2026-05-03", "title_en": "Rainy Hill\nAfternoon", "color": "sky",
    "stops": [
        {"kind": "train", "time": "13:00", "title": "南山站 公園口", "her_line": "你迟到了五分钟"},
        {"kind": "viewpoint", "time": "14:00", "title": "镜湖", "address": "青石区镜湖公园2",
         "lat": 35.7120, "lng": 139.7700},
        {"kind": "cafe", "time": "15:30", "title": "喫茶 古城"},
        {"kind": "dinner", "time": "18:00", "title": "とんかつ", "her_line": "最好吃的一次"},
    ],
}


def backfill(body=None, **over):
    b = json.loads(json.dumps(body or BODY))
    b.update(over)
    return dp.her_backfill(b, now=NOW)


def stops_of(pid):
    return dp.snapshot(pid, now=NOW)["state"]["stops"]


def _keys_deep(o):
    if isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from _keys_deep(v)
    elif isinstance(o, list):
        for v in o:
            yield from _keys_deep(v)


def his_done_plan():
    """他写的、已结束的约会(两站,契约书小卡都写了)。"""
    p = ok(dp.open_plan("Night", "2026-10-28", "rose", now=T(10, 20, 10)))["plan_id"]
    for st in (dict(kind="train", time="19:00", title="梧桐站", address="a", clue="改札右手", reveal_at="17:30"),
               dict(kind="dinner", time="19:30", title="Le Petit Pot", address="b", clue="河边")):
        ok(dp.edit(p, "add_stop", st, now=T(10, 20, 10)))
    ok(dp.edit(p, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=T(10, 20, 10)))
    ok(dp.edit(p, "set_card", dict(text="电影票其实是两张"), now=T(10, 20, 10)))
    ok(dp.send(p, now=T(10, 20, 10)))
    ok(dp.close(p, "那天很好", now=T(10, 28, 23)))
    return p


# ═════  补记 ═════════════════════════════════════════════════════════════════════
def test_backfill_lands_on_shelf_unmarked_with_asks_and_art():
    v = backfill()
    pid = v["id"]
    assert v["status"] == "done" and v["paper_no"] == "0503" and v["title_en"] == "Rainy Hill\nAfternoon"
    # 书架出现(按日期排,与他写的同一个读口)
    shelf = dp.her_plans(now=NOW)
    assert [p["id"] for p in shelf] == [pid]
    # 读口不带任何标记字段(她要「不加标记」:连接口都不带)
    for view in (v, shelf[0], dp.her_plan(pid, now=NOW)):
        keys = set(_keys_deep(view))
        for k in HIDDEN_KEYS:
            assert k not in keys, k
    # 她的一句话读得到;他还没写的几页不出现
    assert [s["her_line"] for s in v["stops"]] == ["你迟到了五分钟", None, None, "最好吃的一次"]
    assert v["invite"] is None and v["card"] is None and v["contract"] is None and v["quote"] is None
    # 库里:origin=her、站 added_by=her、全部公开
    assert raw("SELECT origin, status FROM date_plans WHERE id=?", (pid,)) == [("her", "done")]
    assert {r[0] for r in raw("SELECT added_by FROM date_stops WHERE plan_id=?", (pid,))} == {"her"}
    assert all(s["place"] is not None for s in v["stops"])
    # 四样 ask 建好(她没写的:请柬/契约书/小卡/那一句话)
    assert sorted(r[0] for r in raw("SELECT what FROM date_asks WHERE plan_id=? AND done_at IS NULL", (pid,))) \
        == ["card", "contract", "invite", "quote"]
    # 四站排现画
    rows = raw("SELECT status FROM date_art WHERE plan_id=?", (pid,))
    assert len(rows) == 4 and {r[0] for r in rows} == {"pending"}
    # her_backfill 事件只给他:不进她的事件列表、不推送、不算未读
    assert raw("SELECT kind, push_state FROM date_events WHERE plan_id=?", (pid,)) == [("her_backfill", "skipped")]
    assert dp.her_events(now=NOW) == [] and shelf[0]["unread"] == 0


def test_backfill_art_survives_void_and_gets_drawn_but_his_close_unchanged():
    his = his_done_plan()                                  # 他收尾:原行为=done 不排画,结束前排着的作废
    assert raw("SELECT status FROM date_art WHERE plan_id=?", (his,)) == [("pending",), ("pending",)]
    pid = backfill()["id"]
    later = NOW + timedelta(minutes=5)
    job = date_art._claim(later, None)
    assert job is not None and job["plan_id"] == pid      # 补记的站排得上、能被挑去画
    assert {r[0] for r in raw("SELECT status FROM date_art WHERE plan_id=?", (his,))} == {"failed"}
    # 他收尾那一笔不排画(原行为):结束后他补写也不排
    ok(dp.edit(his, "update_stop", {"stop_id": stops_of(his)[0]["id"], "note": "等你"}, now=later))
    assert {r[0] for r in raw("SELECT status FROM date_art WHERE plan_id=?", (his,))} == {"failed"}


def test_backfill_her_written_pieces_skip_asks_and_show():
    v = backfill(client_id="c-2", invite_text="给那天的我们", card="其实那天我很紧张", contract=["下雨也要去"])
    pid = v["id"]
    assert v["invite"] == "给那天的我们" and v["card"] == "其实那天我很紧张" and v["contract"] == ["下雨也要去"]
    assert [r[0] for r in raw("SELECT what FROM date_asks WHERE plan_id=?", (pid,))] == ["quote"]


@pytest.mark.parametrize("day", ["2026-10-22", "2026-10-23"])
def test_backfill_today_or_future_rejected_with_reason(day):
    with pytest.raises(dp.HerEditError) as e:
        backfill(date=day)
    assert e.value.status == 400 and "早于今天" in e.value.text and e.value.field == "date"
    assert raw("SELECT COUNT(*) FROM date_plans") == [(0,)]


def test_backfill_dedupe_and_field_rejections():
    a = backfill()
    b = backfill()
    assert b["id"] == a["id"] and b.get("duplicate") and raw("SELECT COUNT(*) FROM date_plans") == [(1,)]
    for bad, field in ((dict(quote="x"), "quote"), (dict(stops=[{"kind": "cafe", "title": "x", "clue": "y"}]), "clue"),
                       (dict(stops=[{"kind": "cafe", "title": "x", "foo": 1}]), "foo")):
        with pytest.raises(dp.HerEditError) as e:
            backfill(client_id="c-bad", **bad)
        assert e.value.field == field and e.value.text, bad
    with pytest.raises(dp.HerEditError) as e:
        backfill(client_id="c-bad", stops=[{"kind": "cafe", "title": "x", "lat": 35.0}])
    assert "一起写" in e.value.text
    with pytest.raises(dp.HerEditError) as e:
        backfill(client_id="c-bad", stops=[{"kind": "cafe", "time": t, "title": "x"} for t in
                                           ("20:00", "01:00", "00:30")])
    assert "午夜" in e.value.text
    assert raw("SELECT COUNT(*) FROM date_plans") == [(1,)]   # 拒绝=整笔不生效


def test_backfill_route_contract():
    c = _client()
    r = c.post("/api/dates/backfill", json=BODY)
    assert r.status_code == 200, r.text
    v = r.json()
    for k in HIDDEN_KEYS:
        assert k not in set(_keys_deep(v))
    r = c.post("/api/dates/backfill", json={**BODY, "client_id": "x", "date": "2026-10-22"})
    assert r.status_code == 400 and "早于今天" in r.json()["detail"]["text"]
    assert c.get("/api/dates").json()["plans"][0]["id"] == v["id"]


# ═════  结束后她的编辑 ══════════════════════════════════════════════════════════════
def _events(pid, kind="her_edit"):
    return [(t, json.loads(d)) for t, d in raw("SELECT text, detail_json FROM date_events WHERE plan_id=? AND kind=?"
                                                " ORDER BY id", (pid, kind))]


def test_her_edit_line_time_place_add_remove_with_events():
    pid = backfill()["id"]
    s = stops_of(pid)
    v0 = raw("SELECT version FROM date_plans WHERE id=?", (pid,))[0][0]
    v = dp.her_edit(pid, [
        {"op": "set_line", "stop_id": s[1]["id"], "her_line": "鸭子追着你"},
        {"op": "update_stop", "stop_id": s[1]["id"], "time": "14:20", "address": "青石区镜湖公园3"},
        {"op": "add_stop", "position": 3, "kind": "shopping", "time": "15:00", "title": "アメ横", "her_line": "买了草莓"},
    ], now=NOW)
    assert [x["her_line"] for x in v["stops"]][:3] == ["你迟到了五分钟", "鸭子追着你", "买了草莓"]
    assert v["stops"][1]["time"] == "14:20" and v["stops"][1]["place"]["address"] == "青石区镜湖公园3"
    assert len(v["stops"]) == 5 and v["stops"][2]["place"]["title"] == "アメ横"
    for k in HIDDEN_KEYS:
        assert k not in set(_keys_deep(v))
    ev = _events(pid)
    texts = [t for t, _ in ev]
    assert texts == ["她给第 2 站加了一句话", "她把第 2 站时间从 14:00 改成 14:20",
                     "她把第 2 站地址从「青石区镜湖公园2」改成「青石区镜湖公园3」", "她补了一站：第 3 站「アメ横」 15:00"]
    det = {d["field"]: d for _, d in ev if d.get("field")}
    assert det["time"]["before"] == "14:00" and det["time"]["after"] == "14:20"
    assert det["address"]["before"] == "青石区镜湖公园2"
    st = stops_of(pid)
    assert st[1]["edited_by_her_at"] is not None and st[0]["edited_by_her_at"] is None
    assert st[2]["added_by"] == "her"
    assert raw("SELECT version FROM date_plans WHERE id=?", (pid,))[0][0] == v0 + 1
    # 删她补的站
    v = dp.her_edit(pid, [{"op": "remove_stop", "stop_id": st[2]["id"]}], now=NOW)
    assert len(v["stops"]) == 4 and _events(pid)[-1][0] == "她删了她补的第 3 站「アメ横」"
    # 补的站排了现画、删的站撤了
    assert raw("SELECT COUNT(*) FROM date_art WHERE stop_id=?", (st[2]["id"],)) == [(0,)]


def test_her_edit_on_his_done_plan():
    pid = his_done_plan()
    s = stops_of(pid)
    v = dp.her_edit(pid, [{"op": "update_stop", "stop_id": s[1]["id"], "time": "19:45", "title": "Le Petit Pot 2F"},
                          {"op": "set_line", "stop_id": s[0]["id"], "her_line": "你早到了"}], now=NOW)
    assert v["stops"][1]["time"] == "19:45" and v["stops"][0]["her_line"] == "你早到了"
    assert v["stops"][0]["clue"] == "改札右手" and v["card"] == "电影票其实是两张"     # 他的字原样
    # 改了地名=按签名重排现画(她改的,结束后照排)
    assert raw("SELECT status FROM date_art WHERE stop_id=?", (s[1]["id"],)) == [("pending",)]
    # 他写的站:不能删、不能改种类;他的字一律拒并说清
    cases = [
        ({"op": "remove_stop", "stop_id": s[0]["id"]}, 403, "他写的"),
        ({"op": "update_stop", "stop_id": s[0]["id"], "kind": "cafe"}, 403, "种类是他定的"),
        ({"op": "update_stop", "stop_id": s[0]["id"], "clue": "x"}, 403, "线索"),
        ({"op": "update_stop", "stop_id": s[0]["id"], "note": "x"}, 403, "他给你的话"),
        ({"op": "set_line", "stop_id": s[0]["id"], "card": "x"}, 403, "小卡"),
        ({"op": "update_stop", "stop_id": s[0]["id"], "title_en": "x"}, 403, "名字"),
        ({"op": "update_stop", "stop_id": s[0]["id"], "quote": "x"}, 403, "那一句话"),
        ({"op": "nope"}, 400, "op 只能是"),
        ({"op": "update_stop", "stop_id": 99999, "time": "10:00"}, 404, "没有这一站"),
    ]
    before = raw("SELECT COUNT(*) FROM date_events WHERE plan_id=?", (pid,))
    for op, status, word in cases:
        with pytest.raises(dp.HerEditError) as e:
            dp.her_edit(pid, [{"op": "set_line", "stop_id": s[1]["id"], "her_line": "先改这个"}, op], now=NOW)
        assert e.value.status == status and word in e.value.text and e.value.op == 1, (op, e.value.text)
    # 整笔不生效:第一项也没落
    assert raw("SELECT COUNT(*) FROM date_events WHERE plan_id=?", (pid,)) == before
    assert dp.her_plan(pid, now=NOW)["stops"][1]["her_line"] is None


def test_her_edit_rejected_before_done_with_reason():
    p = ok(dp.open_plan("Soon", "2026-10-28", "rose", now=NOW))["plan_id"]
    ok(dp.edit(p, "add_stop", dict(kind="train", time="19:00", title="駅", address="a", clue="c",
                                      reveal_at="17:30"), now=NOW))
    ok(dp.edit(p, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    sid = stops_of(p)[0]["id"]
    with pytest.raises(dp.HerEditError) as e:                      # 构思中=对她不存在
        dp.her_edit(p, [{"op": "set_line", "stop_id": sid, "her_line": "x"}], now=NOW)
    assert e.value.status == 404
    ok(dp.send(p, now=NOW))
    with pytest.raises(dp.HerEditError) as e:                      # 寄出后到当天:他的惊喜,不碰
        dp.her_edit(p, [{"op": "set_line", "stop_id": sid, "her_line": "x"}], now=NOW)
    assert e.value.status == 409 and "收进纪念盒以后才能改" in e.value.text and "已寄出" in e.value.text
    with pytest.raises(dp.HerEditError) as e:
        dp.her_write(p, "card", "x", now=NOW)
    assert e.value.status == 409


def test_patch_route_detail_shape():
    pid = backfill()["id"]
    s = stops_of(pid)
    c = _client()
    r = c.patch(f"/api/dates/{pid}/her", json={"ops": [{"op": "set_line", "stop_id": s[2]["id"], "her_line": "好香"}]})
    assert r.status_code == 200 and r.json()["stops"][2]["her_line"] == "好香"
    r = c.patch(f"/api/dates/{pid}/her", json={"ops": [{"op": "update_stop", "stop_id": s[2]["id"], "clue": "x"}]})
    assert r.status_code == 403
    d = r.json()["detail"]
    assert d["op_index"] == 0 and d["field"] == "clue" and "他写的" in d["text"]
    r = c.patch(f"/api/dates/{pid}/her", json={"ops": [], "foo": 1})
    assert r.status_code == 400 and r.json()["detail"]["field"] == "foo"
    r = c.patch(f"/api/dates/{pid}/her", json={"ops": [{"op": "set_line", "stop_id": s[2]["id"], "her_line": "y"}],
                                                 "expect_version": 1})
    assert r.status_code == 409 and "刷新" in r.json()["detail"]["text"]


def test_her_write_first_then_he_cannot_and_invite_rules():
    pid = backfill()["id"]
    v = dp.her_write(pid, "card", "那天的雨很好听", now=NOW)
    assert v["card"] == "那天的雨很好听"
    assert raw("SELECT done_at IS NOT NULL FROM date_asks WHERE plan_id=? AND what='card'", (pid,)) == [(1,)]
    assert raw("SELECT text FROM date_events WHERE plan_id=? AND kind='her_wrote'", (pid,)) == [("她自己写了小卡",)]
    dp.her_write(pid, "card", "那天的雨很好听。", now=NOW)                # 她自己写的可以改
    # 他写了的,她不能先写
    ok(dp.edit(pid, "set_contract", {"items": ["每年都去一次"]}, now=NOW))
    with pytest.raises(dp.HerEditError) as e:
        dp.her_write(pid, "contract", items=["x"], now=NOW)
    assert e.value.status == 409 and e.value.text == "他已经写了"
    # 他写的约会没有迟到的请柬
    his = his_done_plan()
    with pytest.raises(dp.HerEditError) as e:
        dp.her_write(his, "invite", "x", now=NOW)
    assert e.value.status == 409 and "请柬" in e.value.text
    c = _client()
    r = c.put(f"/api/dates/{pid}/her/write", json={"what": "invite", "text": "寄往五月三日"})
    assert r.status_code == 200 and r.json()["invite"] == "寄往五月三日"
    r = c.put(f"/api/dates/{pid}/her/write", json={"what": "quote", "text": "x"})
    assert r.status_code == 400 and r.json()["detail"]["field"] == "what"


# ═════  他那一侧 ════════════════════════════════════════════════════════════════════
def test_ledger_sections_appear_dedupe_and_seen():
    assert dt.ledger_block(NOW) == ("", "")                   # 没有就整段不出
    pid = backfill()["id"]
    text, key = dt.ledger_block(NOW)
    assert text.startswith(dt.LEDGER_HEADER)
    assert "她补记 / 加的（你上次看之后）：\n· 5/3 「Rainy Hill Afternoon」 她补记了这次约会（4 站）" in text
    assert "她在等你写" not in text             #  门控:没按「请写」之前,不提醒他
    # 她按一次「请写」:四样一起排上,立刻列进待写段
    dp.her_request_write(pid, "req-1", now=NOW)
    text, key = dt.ledger_block(NOW)
    assert "她在等你写：\n· 5/3 「Rainy Hill Afternoon」：迟到的请柬、契约书、小卡、那一句话" in text
    assert "书架：1 次（最近：「Rainy Hill Afternoon」5/3）" in text
    _, key2 = dt.ledger_block(NOW + timedelta(minutes=9))
    assert key2 == key                                       # 内容不变=不重注(生成时刻不进键)
    s = stops_of(pid)
    dp.her_edit(pid, [{"op": "set_line", "stop_id": s[1]["id"], "her_line": "x"},
                      {"op": "update_stop", "stop_id": s[1]["id"], "time": "15:00"}], now=NOW)
    text, key3 = dt.ledger_block(NOW)
    assert key3 != key and "她给第 2 站加了一句话" in text and "她把第 2 站时间从 14:00 改成 15:00" in text
    # 他 date_view 打开过 → 不再列;待写与书架照旧
    t, err = call("date_view", plan=pid)
    assert not err
    text, _ = dt.ledger_block(NOW)
    assert "她补记 / 加的" not in text and "她在等你写" in text and "书架：1 次" in text
    # 都写完 → 待写段消失;只剩书架
    for op, a in (("set_invite", {"text": "寄往那天"}), ("set_contract", {"contract": ["下雨也去"]}),
                  ("set_card", {"text": "伞是故意只带一把"}), ("set_quote", {"text": "下次还去"})):
        t, err = call("date_edit", plan=pid, op=op, **a)
        assert not err, t
    # 都写完 + 看过 → 只剩书架:书架单独不出账
    assert dt.ledger_block(NOW) == ("", "")
    # card_after(事件卡模块调)也会列——但这是她补记的约会(origin=her): 门控同样管它,
    # 加出来还没请不列,她再按一次「请写」才列
    assert dp.add_ask(pid, "card_after") and not dp.add_ask(pid, "card_after")
    assert "事件卡的「后续」段" not in dt.ledger_block(NOW)[0]
    dp.her_request_write(pid, "req-2", now=NOW)
    assert "事件卡的「后续」段" in dt.ledger_block(NOW)[0]
    assert dp.complete_ask(pid, "card_after") and not dp.complete_ask(pid, "card_after")
    assert not dp.add_ask(pid, "card_after")                     # 写完的不会被重新打开


def test_date_view_done_detail_marks_provenance_and_her_edits():
    his = his_done_plan()
    s = stops_of(his)
    dp.her_edit(his, [{"op": "update_stop", "stop_id": s[1]["id"], "time": "19:45"},
                      {"op": "add_stop", "kind": "cafe", "time": "21:00", "title": "喫茶", "her_line": "加一站"}],
                now=NOW)
    t, err = call("date_view", plan=his)
    assert not err
    lines = t.splitlines()
    assert any(l.startswith("第 1 站") and l.endswith("（你写的）") for l in lines)
    assert any(l.startswith("第 3 站") and "喫茶" in l and l.endswith("（她后来加的）") for l in lines)
    assert "  她写的一句话：「加一站」（她后来写的）" in lines
    assert any("她把第 2 站时间从 19:30 改成 19:45" in l for l in lines)
    assert "那一句话：那天很好（你写的）" in lines and "她在等你写：无" in lines
    pid = backfill()["id"]
    t, _ = call("date_view", plan=pid)
    assert "她补记的约会" in t.splitlines()[0]
    assert any(l.startswith("第 1 站") and l.endswith("（她补记的）") for l in t.splitlines())
    assert "  她写的一句话：「你迟到了五分钟」（她补记时写的）" in t
    #  门控:她没按「请写」之前,四样显示「没写」,不说「她在等你写」
    assert "迟到的请柬：没写" in t and "她在等你写：无" in t
    dp.her_request_write(pid, "req-1", now=NOW)
    t, _ = call("date_view", plan=pid)
    assert "迟到的请柬：还没写（她在等你写）" in t and "她在等你写：迟到的请柬、契约书、小卡、那一句话" in t
    # 列表摘要带书架
    t, _ = call("date_view")
    assert "书架（已结束 2 次）：" in t and f"#{pid} Rainy Hill Afternoon · 5/3（她补记的）" in t


def test_he_writes_late_pieces_she_reads_them_asks_done():
    pid = backfill()["id"]
    t, err = call("date_edit", plan=pid, op="set_invite", text="寄往五月三日的你")
    assert not err and t.startswith("写好了：迟到的请柬")
    t, err = call("date_edit", plan=pid, op="set_card", text="伞是故意只带一把的")
    assert not err
    sid = stops_of(pid)[2]["id"]
    t, err = call("date_edit", plan=pid, op="update_stop", stop_id=sid, note="你点了两份布丁")
    assert not err and "这一站你给她的话" in t
    v = dp.her_plan(pid, now=NOW)
    assert v["invite"] == "寄往五月三日的你" and v["card"] == "伞是故意只带一把的"
    assert v["stops"][2]["note"] == "你点了两份布丁"
    assert sorted(r[0] for r in raw("SELECT what FROM date_asks WHERE plan_id=? AND done_at IS NULL", (pid,))) \
        == ["contract", "quote"]


def test_he_late_write_rejections_say_why():
    pid = backfill(invite_text=None, card="她先写的小卡")["id"]
    s = stops_of(pid)
    cases = [
        (dict(op="set_card", text="x"), "小卡她已经写了"),
        (dict(op="update_stop", stop_id=s[0]["id"], time="10:00"), "只能写 note"),
        (dict(op="update_stop", stop_id=s[0]["id"], title="x"), "只能写 note"),
        (dict(op="set_prep", items=[{"section": "bring", "text": "x"}]), "结束后只能补写"),
        (dict(op="set_quote", text="x" * 81), "最多 80 字"),
    ]
    for args, word in cases:
        t, err = call("date_edit", plan=pid, **args)
        assert err and t.startswith("没改成：") and word in t, (args, t)
    ok(dp.edit(pid, "update_stop", {"stop_id": s[0]["id"], "note": "第一次"}, now=NOW))
    t, err = call("date_edit", plan=pid, op="update_stop", stop_id=s[0]["id"], note="第二次")
    assert err and "已经写了" in t
    his = his_done_plan()
    t, err = call("date_edit", plan=his, op="set_invite", text="x")
    assert err and "只有她补记的约会才有" in t
    t, err = call("date_edit", plan=his, op="set_quote", text="x")
    assert err and "那一句话你已经写了" in t
    t, err = call("date_edit", plan=pid, op="set_invite", invite="x")       # 写错字段名:说清用 text
    assert err and "用 text" in t and "迟到的请柬正文" in t


def test_tool_description_has_her_sentence_verbatim():
    d = next(t for t in dt.tool_schemas() if t["name"] == "date_edit")["description"]
    assert "迟到的请柬：这次约会已经发生过，是她后来补记的；请柬写成寄往那一天的、迟到的邀请。" in d


# ═════ 地点搜索(走地点服务适配器;引擎只转交、错误原样带原因)═══════════════════════════════════
class FakePlaces:
    """同步适配器(与 ephemera_date.places 的真实接口同形)。"""
    name = "fake"

    def __init__(self, hits=None, err=None, fallback_from=None):
        self.hits, self.err, self.qs, self.fallback_from = hits or [], err, [], fallback_from

    def capabilities(self):
        return ports.Capabilities("fake", False, False, False, True, "© fake", "")

    def search(self, q, near=None, limit=8):
        self.qs.append(q)
        if self.err:
            raise self.err
        return ports.PlaceList(self.hits, source="fake", fallback_from=self.fallback_from,
                               fallback_code="auth" if self.fallback_from else None)

    def geocode(self, q):
        return ports.PlaceList(source="fake")


def test_place_search_ok():
    fp = FakePlaces([ports.Place("镜湖", 35.712, 139.770, address="台东区镜湖公园2", kind="viewpoint", source="osm",
                                 provider_id="N12")])
    ports.install("places", fp)
    r = _client().get("/api/dates/place_search", params={"q": " 镜湖 "})
    assert r.status_code == 200
    assert r.json() == {"items": [{"title": "镜湖", "address": "台东区镜湖公园2", "lat": 35.712, "lng": 139.77,
                                   "kind": "viewpoint", "subtype": None, "source": "osm", "provider_id": "N12",
                                   "region": None, "fallback_from": None, "coords_storable": True}],
                        "source": "fake", "fallback_from": None, "fallback_code": None, "notice": None}
    assert fp.qs == ["镜湖"]


@pytest.mark.parametrize("status,code,text", [
    (503, "off", "地点搜索关着"), (429, "limited", "今天的查询用完了"), (502, "upstream", "地点搜索出错了"),
    (504, "timeout", "地点搜索超时了"),
])
def test_place_search_adapter_errors_have_text(status, code, text):
    ports.install("places", FakePlaces(err=ports.PlaceError(status, code, text, "fake")))
    r = _client().get("/api/dates/place_search", params={"q": "南山"})
    assert r.status_code == status and r.json()["detail"] == {"code": code, "text": text}
    ports.install("places", FakePlaces(err=ports.PortUnavailable(text, status, code)))
    r = _client().get("/api/dates/place_search", params={"q": "南山"})
    assert r.status_code == status and r.json()["detail"] == {"code": code, "text": text}


def test_place_search_unconfigured_and_empty(monkeypatch):
    monkeypatch.setenv("EPHEMERA_PLACES_ADAPTER", "none")
    r = _client().get("/api/dates/place_search", params={"q": "南山"})      # 关掉了:不出网
    assert r.status_code == 503 and "没有配置" in r.json()["detail"]["text"]
    r = _client().get("/api/dates/place_search", params={"q": "  "})
    assert r.status_code == 400 and r.json()["detail"]["text"]


def test_migration_idempotent():
    conn = dp._connect()
    try:
        dp.ensure_schema(conn)
        dp.ensure_schema(conn)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(date_plans)")}
    finally:
        conn.close()
    assert {"origin", "invite_text", "written_by_her", "her_seen_upto", "client_id"} <= cols


# ═════ 补记写口的边界:client_id、受保护字段、类型、事件账本、set_plan ══════════════
def test_backfill_client_id_required():
    for cid in (None, "", "  ", 5, "x" * 65):
        with pytest.raises(dp.HerEditError) as e:
            backfill(client_id=cid)
        assert e.value.status == 400 and e.value.field == "client_id" and "必填" in e.value.text
    b = {k: v for k, v in BODY.items() if k != "client_id"}
    r = _client().post("/api/dates/backfill", json=b)
    assert r.status_code == 400 and r.json()["detail"]["field"] == "client_id"
    assert raw("SELECT COUNT(*) FROM date_plans") == [(0,)]


def test_protected_fields_rejected_even_when_empty():
    pid = backfill()["id"]
    sid = stops_of(pid)[1]["id"]
    for extra in ({"note": None}, {"note": ""}, {"clue": None}, {"card": ""}, {"foo": None}):
        with pytest.raises(dp.HerEditError) as e:
            dp.her_edit(pid, [{"op": "set_line", "stop_id": sid, "her_line": "x", **extra}], now=NOW)
        k = next(iter(extra))
        assert e.value.field == k and e.value.status in (400, 403) and e.value.text, extra
    assert dp.her_plan(pid, now=NOW)["stops"][1]["her_line"] is None           # 整笔没生效
    for bad in ({"quote": None}, {"stops": [{"kind": "cafe", "title": "x", "clue": ""}]}):
        with pytest.raises(dp.HerEditError) as e:
            backfill(client_id="c-9", **bad)
        assert e.value.field in ("quote", "clue")
    c = _client()
    for body, field in (({"what": "card", "text": "x", "note": None}, "note"),
                        ({"what": "card", "text": "x", "items": ["y"]}, "items"),
                        ({"what": "contract", "text": "x", "items": ["y"]}, "text"),
                        ({"what": "card", "text": "x", "items": None}, "items"),         # 显式 null 也拒
                        ({"what": "invite", "text": "x", "items": None}, "items"),
                        ({"what": "contract", "items": ["y"], "text": None}, "text")):
        r = c.put(f"/api/dates/{pid}/her/write", json=body)
        assert r.status_code == 400 and r.json()["detail"]["field"] == field, (body, r.text)
    assert dp.her_plan(pid, now=NOW)["card"] is None


def test_wrong_types_are_4xx_with_field():
    pid = backfill()["id"]
    sid = stops_of(pid)[1]["id"]
    c = _client()
    for ops, field in (([{"op": {}}], "op"), ([{"op": []}], "op"), ([{"op": "set_line", "stop_id": "x"}], "stop_id"),
                       ([{"op": "update_stop", "stop_id": sid, "time": 5}], "time"),
                       ([{"op": "add_stop", "kind": [], "title": "x"}], "kind"),
                       ([{"op": "set_line", "stop_id": sid, "her_line": {"a": 1}}], "her_line"),
                       ([{"op": "set_plan", "color": []}], "color"),
                       ([{"op": "set_plan", "date": 20260501}], "date"),
                       (["x"], None)):
        r = c.patch(f"/api/dates/{pid}/her", json={"ops": ops})
        assert 400 <= r.status_code < 500, (ops, r.text)
        if field:
            assert r.json()["detail"]["field"] == field, (ops, r.text)
    for body in ([1, 2], "x"):
        assert c.patch(f"/api/dates/{pid}/her", json=body).status_code == 400
        assert c.post("/api/dates/backfill", json=body).status_code == 400
    for bad, field in ((dict(color=[]), "color"), (dict(stops=[{"kind": [], "title": "x"}]), "kind"),
                       (dict(title_en=["x"]), "title_en"), (dict(date=5), "date"),
                       (dict(stops=[{"kind": "cafe", "title": "x", "lat": [1]}]), "lat")):
        r = c.post("/api/dates/backfill", json={**BODY, "client_id": "t-1", **bad})
        assert r.status_code == 400, (bad, r.text)
        if field:
            assert r.json()["detail"]["field"] == field
    for body, field in (({"what": 1}, "what"), ({"what": "card", "text": 5}, "text"),
                        ({"what": "contract", "items": "x"}, "items"), ({}, "what")):
        r = c.put(f"/api/dates/{pid}/her/write", json=body)
        assert r.status_code == 400 and r.json()["detail"]["field"] == field, (body, r.text)
    assert raw("SELECT COUNT(*) FROM date_plans") == [(1,)]


def test_ledger_key_changes_for_same_text_events():
    pid = backfill()["id"]
    sid = stops_of(pid)[1]["id"]
    dp.her_edit(pid, [{"op": "set_line", "stop_id": sid, "her_line": "一"}], now=NOW)
    call("date_view", plan=pid)
    dp.her_edit(pid, [{"op": "set_line", "stop_id": sid, "her_line": "二"}], now=NOW)
    t1, k1 = dt.ledger_block(NOW)
    call("date_view", plan=pid)
    dp.her_edit(pid, [{"op": "set_line", "stop_id": sid, "her_line": "三"}], now=NOW)
    t2, k2 = dt.ledger_block(NOW + timedelta(minutes=3))
    assert "她改了第 2 站她写的那句话" in t1
    assert dt._LEDGER_STAMP_RE.sub("", t1, count=1) == dt._LEDGER_STAMP_RE.sub("", t2, count=1)   # 正文一样
    assert k1 != k2                                                             # 键不同 → 会再带一次


def test_ledger_shelf_only_is_empty_but_rides_along():
    his = his_done_plan()
    assert dt.ledger_block(NOW) == ("", "")                     # 只有已结束的约会、没新事件没待写 → 不出账
    pid = backfill()["id"]
    text, _ = dt.ledger_block(NOW)
    assert text and text.splitlines()[-1] == ("书架：2 次（最近：「Night」10/28、「Rainy Hill Afternoon」5/3）")
    call("date_view", plan=pid)
    for op, a in (("set_invite", {"text": "a"}), ("set_contract", {"contract": ["b"]}), ("set_card", {"text": "c"}),
                  ("set_quote", {"text": "d"})):
        assert not call("date_edit", plan=pid, op=op, **a)[1]
    assert dt.ledger_block(NOW) == ("", "")
    # 有进行中的约会时,书架行附在末尾
    ok(dp.open_plan("Next", "2026-11-01", "rose", now=NOW))
    text, _ = dt.ledger_block(NOW)
    assert "进行中 1 个" in text.splitlines()[0] and text.splitlines()[-1].startswith("书架：2 次")
    assert his


def test_set_plan_only_for_backfill():
    pid = backfill()["id"]
    v = dp.her_edit(pid, [{"op": "set_plan", "title_en": "Hill\nin the Rain", "date": "2026-05-04", "color": "berry"}],
                    now=NOW)
    assert (v["title_en"], v["date"], v["color"], v["paper_no"]) == ("Hill\nin the Rain", "2026-05-04", "berry", "0504")
    texts = [t for t, _ in _events(pid)]
    assert texts == ["她把名字从「Rainy Hill Afternoon」改成「Hill in the Rain」", "她把日期从 5/3 改成 5/4",
                     "她把颜色从 蓝 改成 深玫红"]
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(pid, [{"op": "set_plan", "date": "2026-10-22"}], now=NOW)
    assert e.value.field == "date" and "早于今天" in e.value.text
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(pid, [{"op": "update_stop", "stop_id": stops_of(pid)[0]["id"], "title_en": "x"}], now=NOW)
    assert "set_plan" in e.value.text
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(pid, [{"op": "set_plan", "title_en": "x" * 30}], now=NOW)
    assert e.value.field == "title_en"
    his = his_done_plan()
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(his, [{"op": "set_plan", "color": "sky"}], now=NOW)
    assert e.value.status == 403 and "他写的" in e.value.text
    assert dp.her_plan(his, now=NOW)["color"] == "rose"


def test_detail_lists_before_after_including_coords():
    his = his_done_plan()
    s = stops_of(his)
    dp.her_edit(his, [{"op": "update_stop", "stop_id": s[1]["id"], "lat": 35.64, "lng": 139.7,
                       "address": "青石区2", "time": "19:45", "title": "小酒馆"}], now=NOW)
    t, err = call("date_view", plan=his)
    assert not err
    line = next(l for l in t.splitlines() if l.startswith("  她改过："))
    for part in ("时间 19:30 → 19:45", "地名 「Le Petit Pot」 → 「小酒馆」", "地址 「b」 → 「青石区2」",
                 "位置 （没写） → 35.64000,139.70000"):
        assert part in line, (part, line)


def test_photo_counts_only_tolerates_missing_table():
    pid = backfill()["id"]
    assert dp.snapshot(pid, now=NOW)["photos"] == {}                     # 表还没建 = 没有照片
    c = sqlite3.connect(config.db_path())
    c.execute("CREATE TABLE date_her_photos (id INTEGER PRIMARY KEY, plan_id INTEGER, stop_id INTEGER)")
    c.commit()
    c.close()
    with pytest.raises(sqlite3.OperationalError):                           # 缺列 = 真坏了,不许吞
        dp.snapshot(pid, now=NOW)


# ═════ 显式 null、整笔回滚、纸号、他晚写 ═════════════════════════════════════════════
def test_her_write_null_misplaced_rejected_but_absent_ok():
    pid = backfill()["id"]
    with pytest.raises(dp.HerEditError) as e:
        dp.her_write(pid, "card", "x", None, now=NOW)
    assert e.value.field == "items"
    with pytest.raises(dp.HerEditError) as e:
        dp.her_write(pid, "contract", None, ["y"], now=NOW)
    assert e.value.field == "text"
    assert dp.her_plan(pid, now=NOW)["card"] is None and dp.her_plan(pid, now=NOW)["contract"] is None
    c = _client()                                               # 没传(不是 null)照常
    assert c.put(f"/api/dates/{pid}/her/write", json={"what": "card", "text": "x"}).status_code == 200
    assert c.put(f"/api/dates/{pid}/her/write", json={"what": "contract", "items": ["y"]}).status_code == 200


def test_set_plan_rolls_back_whole_batch():
    pid = backfill()["id"]
    v0 = raw("SELECT title_en, date, color, paper_no, version FROM date_plans WHERE id=?", (pid,))
    for ops in ([{"op": "set_plan", "title_en": "New Name", "color": "nope"}],
                [{"op": "set_plan", "title_en": "New Name"}, {"op": "set_plan", "date": "2026-12-01"}],
                [{"op": "set_plan", "date": "2026-05-01"}, {"op": "update_stop", "stop_id": 1, "clue": "x"}]):
        with pytest.raises(dp.HerEditError):
            dp.her_edit(pid, ops, now=NOW)
    assert raw("SELECT title_en, date, color, paper_no, version FROM date_plans WHERE id=?", (pid,)) == v0
    assert _events(pid) == []


def test_set_plan_date_paper_no_follows_numbering_rule():
    a = backfill(client_id="a")["id"]                                   # 5/3 → 0503
    b = backfill(client_id="b", date="2026-05-04")["id"]               # 5/4 → 0504
    c = backfill(client_id="c", date="2025-05-03")["id"]               # 别的年份同 MMDD 不算冲突
    assert [raw("SELECT paper_no FROM date_plans WHERE id=?", (x,))[0][0] for x in (a, b, c)] == ["0503", "0504", "0503"]
    v = dp.her_edit(b, [{"op": "set_plan", "date": "2026-05-03"}], now=NOW)
    assert v["paper_no"] == "0503-2"                                    # 同年同日已有 → 加 -2(同寄出规则)
    v = dp.her_edit(b, [{"op": "set_plan", "color": "rose"}], now=NOW)
    assert v["paper_no"] == "0503-2"                                    # 日期没变不重排
    dp.her_edit(a, [{"op": "set_plan", "date": "2026-05-05"}], now=NOW)
    assert raw("SELECT paper_no FROM date_plans WHERE id=?", (a,)) == [("0505",)]
    v = dp.her_edit(b, [{"op": "set_plan", "date": "2026-05-04"}], now=NOW)
    assert v["paper_no"] == "0504"
    v = dp.her_edit(b, [{"op": "set_plan", "date": "2026-05-03"}], now=NOW)
    assert v["paper_no"] == "0503"                                      # 原 0503 已挪走,不再冲突



def test_he_late_write_tells_her_event_push_and_route():
    """他写好了要告诉她——电报列表有、推送有文案、点开落到那一盒。"""
    from ephemera_date import outlet
    pid = backfill()["id"]
    t, err = call("date_edit", plan=pid, op="set_card", text="伞是故意只带一把的")
    assert not err
    rows = raw("SELECT kind, text, push_state FROM date_events WHERE plan_id=? AND kind='late_written'", (pid,))
    assert rows == [("late_written", "他写好了小卡", "pending")]
    evs = dp.her_events(pid)
    assert any(e["kind"] == "late_written" and e["text"] == "他写好了小卡" for e in evs)
    assert outlet.push_text("late_written", {"title_en": "First Rain", "text": "他写好了小卡"}) == \
        ("他写好了小卡", "「First Rain」")
    assert outlet.page_of("late_written", pid) == {"page": "box", "planId": pid}
