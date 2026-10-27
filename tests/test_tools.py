"""The AI's date tools: receipts, idempotency, versions, date_route through the ports, the to-do tail.

tmp databases, fake clock (tools._now), fake adapters (ports.install); no network.
"""
from __future__ import annotations

import asyncio
import re
import sqlite3
import threading
from datetime import datetime

import pytest

from conftest import TZ
from ephemera_date import config, ports
from ephemera_date import plan as dp
from ephemera_date import tools as dt

NOW0 = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"
TAIL_RE = re.compile(r"\n\n（约会待办 (\d+) 件(，用 date_inbox 查看)?）$")


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    assert str(tmp_path) in config.db_path()
    clock = {"now": NOW0}
    monkeypatch.setattr(dt, "_now", lambda: clock["now"])
    dp._connect().close()   # 先建表(raw 直查用)
    yield clock


def call(name, **args):
    """→ (回执去掉末尾待办数, is_error);末尾待办数必须在(拉通道)。"""
    text, err = asyncio.run(dt.call(name, args))
    if name != "date_inbox":
        m = TAIL_RE.search(text)
        assert m, text
        text = text[:m.start()]
    return text, err


def ok(res):
    text, err = res
    assert not err, text
    return text


def bad(res):
    text, err = res
    assert err, text
    return text


def raw(sql, args=()):
    c = sqlite3.connect(config.db_path())
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def stop_ids(pid):
    return [s["id"] for s in dp.snapshot(pid, now=NOW0)["state"]["stops"]]


def build(send=False, stop1_reveal="17:30", prep=True, ticket=True):
    """标准三站约会,返回 (plan_id, [s1,s2,s3])。"""
    t = ok(call("date_open", title_en="The Evening\nScreening", date=DAY, color="rose"))
    pid = int(t.split("约会 #")[1].split("。")[0])
    ok(call("date_edit", plan=pid, op="add_stop", kind="train", time="19:00", title="梧桐站",
            address="青石区梧桐路3", clue="从改札出来，右手边", reveal_at=stop1_reveal,
            note="我会比你早到，不用跑。"))
    ok(call("date_edit", plan=pid, op="add_stop", kind="dinner", time="19:30", stay_until="20:45",
            title="Le Petit Pot", address="青石区柳岸1", clue="河边的小门"))
    ok(call("date_edit", plan=pid, op="add_stop", kind="cinema", time="21:00", title="小影院",
            address="南湖区2", clue="红色的门"))
    s = stop_ids(pid)
    ok(call("date_edit", plan=pid, op="set_leg", to_stop=s[1], mode="walk", minutes=6, depart_time="19:20",
            summary="出站右转沿河往南"))
    ok(call("date_edit", plan=pid, op="set_leg", to_stop=s[2], mode="train", minutes=6, depart_time="20:52",
            arrive_time="20:58", needs_ticket=ticket, ticket_note="交通卡留够", summary="环线往河西",
            official_url="https://roote.ekispert.net/x"))
    if prep:
        ok(call("date_edit", plan=pid, op="set_prep", items=[{"section": "bring", "text": "一把伞"}]))
    if send:
        ok(call("date_send", plan=pid))
    return pid, s


# ── schema 面 ────────────────────────────────────────────────────────────────────
def test_schemas_verbatim_and_names_configurable(monkeypatch):
    sch = {t["name"]: t for t in dt.tool_schemas()}
    assert set(sch) == set(dt.TOOLS)
    assert sch["date_send"]["description"] == (
        "寄出邀请。寄出前会检查必填项，缺什么会列出来，不会寄。寄出后她收到信封，能看到名字、日期、准备清单，"
        "以及到了公开时间的内容。")
    assert "Asia/Shanghai 时间" in sch["date_open"]["description"]
    for t in sch.values():
        assert "{her}" not in t["description"] and "{him}" not in t["description"] and "{art}" not in t["description"]
        for gone in ("hide", "found", "藏一封信", "駅すぱあと", "思考会被遮住"):
            assert gone not in t["description"]
    assert "art_hint（画面描述" not in sch["date_edit"]["description"]      # 没配生成图:那一句不说
    monkeypatch.setenv("EPHEMERA_HER", "小满")
    monkeypatch.setenv("EPHEMERA_HIM", "阿树")
    d = {t["name"]: t["description"] for t in dt.tool_schemas()}
    assert d["date_send"].startswith("寄出邀请。寄出前会检查必填项，缺什么会列出来，不会寄。寄出后小满收到信封")
    assert "写好的回信阿树能一直改" in d["date_edit"] and "她" not in d["date_send"]


def test_art_sentence_only_with_generator():
    class Gen:
        async def generate(self, job):
            return b"i", b"v"
    ports.install("art", Gen())
    d = {t["name"]: t["description"] for t in dt.tool_schemas()}["date_edit"]
    assert "站可以写 art_hint（画面描述，40 字以内），她那边这一站的小画会照着现画；构思中只画写了它的站，寄出后每站都画。" in d


# ── 回执文字 ─────────────────────────────────────────────────────────────────────
def test_open_receipt_and_header():
    t = ok(call("date_open", title_en="The Evening\nScreening", date=DAY, color="rose", next="先想第一站"))
    assert t.startswith("开好了：约会 #1。\n\n约会 #1 「The Evening Screening」 · 10/28 周三 · 构思中 · 颜色：粉 · v1")
    assert "她现在能看到：准备进度（日期、几站、各部分写没写、还缺几样、你上次动笔的时间），名字、颜色和内容看不到" in t
    assert "还缺：站、准备清单" in t
    assert t.endswith("下一步（你上次留的）：先想第一站")
    t = bad(call("date_open", title_en="X", date="2026-10-01", color="rose"))
    assert t == "没开成：日期不能早于今天。"


def test_detail_render_matches_finalized_shape(_env):
    pid, (s1, s2, s3) = build(send=True)
    _env["now"] = datetime(2026, 10, 28, 19, 25, tzinfo=TZ)
    t = ok(call("date_view", plan=pid))
    lines = t.split("\n")
    assert lines[0] == f"约会 #{pid} 「The Evening Screening」 · 10/28 周三 · 当天 · 纸面编号 No.1028 · 颜色：粉 · v8"
    assert f"第 1 站 [stop {s1}] 19:00 到 · 集合（train）· 梧桐站" in t
    assert "  地址：青石区梧桐路3 · 地点公开：17:30（她已能看到）" in t
    assert "  线索：从改札出来，右手边（她随时能点开）" in t
    assert "  到站给她的话：我会比你早到，不用跑。（她已能看到）" in t
    assert "  ↓ 怎么去第 2 站：步行约 6 分钟 · 出站右转沿河往南 · 19:20 出发（她已能看到）" in t
    assert f"第 2 站 [stop {s2}] 19:30 到，待到 20:45 · 晚餐（dinner）· Le Petit Pot" in t
    assert "（你手写的）" not in t and "核对过" not in t
    assert "（第 3 站地点公开后她能看到）" in t and "    官方路线页：已附（她点开看）" in t
    assert "  提前准备：去第 3 站的车票（交通卡留够）" in t
    assert "契约书：没写" in t and "小卡：没写" in t and "电报：还没有" in t
    assert "她现在能看到：名字、日期、准备清单、第 1 站地点与怎么来、第 2 站地点与怎么去、第 1 站给她的话、全部线索" in t
    assert "\n\n准备清单" not in t   # 定稿:准备清单紧跟站点,不空行
    assert t.endswith("还缺：无\n下一步（你上次留的）：（没留）")


def test_list_summary_and_missing_plan():
    pid, _ = build(send=True)
    assert ok(call("date_view")) == f"#{pid} The Evening Screening · 10/28 · 已寄出 · 还缺：无"
    t = bad(call("date_view", plan=9))
    assert t == f"没有约会 #9。\n\n#{pid} The Evening Screening · 10/28 · 已寄出 · 还缺：无"
    t = bad(call("date_edit", plan=9, op="set_card", text="x"))
    assert t.startswith("没有约会 #9。")
    assert ok(call("date_view")) != "" and dp.list_plans(now=NOW0)


def test_send_missing_receipt_exact():
    pid, _ = build(stop1_reveal=None, prep=False, ticket=False)
    t = bad(call("date_send", plan=pid))
    assert t.startswith("没寄出：还缺 2 项——第 1 站没写地点公开时间；准备清单是空的。\n\n约会 #")
    assert raw("SELECT status FROM date_plans WHERE id=?", (pid,)) == [("draft",)]


def test_finalized_failure_sentences(_env):
    pid, (s1, s2, s3) = build()
    t = bad(call("date_edit", plan=pid, op="update_stop", stop_id=s3, reveal_at="21:00"))
    assert t.startswith("没改成：第 3 站的地点公开时间 21:00 晚于出发时间 20:52。\n\n")
    ok(call("date_edit", plan=pid, op="remove_leg", to_stop=s2))
    ok(call("date_edit", plan=pid, op="update_stop", stop_id=s3, reveal_at="17:00"))
    ok(call("date_send", plan=pid))
    _env["now"] = datetime(2026, 10, 28, 18, 0, tzinfo=TZ)
    ok(call("date_edit", plan=pid, op="remove_stop", stop_id=s2))       # 寄出后删站不再因路线已公开被拒


def test_auto_telegram_note_and_delete():
    pid, (s1, s2, s3) = build(send=True)
    t = ok(call("date_edit", plan=pid, op="update_stop", stop_id=s3, time="21:30"))
    assert t.startswith("改好了。\n已自动给她发了电报：「第 3 站时间改了：21:00 → 21:30」\n\n")
    assert "电报（1 封，1 封她还没读）：10/20 第 3 站时间改了：21:00 → 21:30" in t
    p2, _ = build()
    assert ok(call("date_edit", plan=p2, op="delete_plan")).startswith(f"删掉了约会 #{p2}。")


def test_live_ops_and_close_receipts(_env):
    pid, (s1, s2, s3) = build(send=True)
    ok(call("date_live", plan=pid, op="telegram", text="记得带伞"))
    t = ok(call("date_view", plan=pid))
    assert "10/20 「记得带伞」" in t
    _env["now"] = datetime(2026, 10, 28, 18, 0, tzinfo=TZ)
    assert ok(call("date_live", plan=pid, op="shift", from_stop=s2, minutes=30)).startswith("挪好了，已自动给她发了电报。")
    assert ok(call("date_live", plan=pid, op="open_stop", stop_id=s3)).startswith("提前公开了。")
    t = bad(call("date_close", plan=pid, quote=""))
    assert t.startswith("没改成：那一句话不能空着。")
    assert ok(call("date_close", plan=pid, quote="今天很好")).startswith("结束了，收进纪念盒。")


# ── 幂等 / 版本 / 写后渲染失败 ────────────────────────────────────────────────────────
def test_request_id_repeat_does_not_rewrite():
    pid, _ = build()
    a = dict(plan=pid, op="add_stop", kind="walk", time="23:00", request_id="r1")
    ok(call("date_edit", **a))
    t = ok(call("date_edit", **a))
    assert t.startswith("这个请求已经做过了，下面是现在的样子。")
    assert len(stop_ids(pid)) == 4
    t = bad(call("date_edit", **{**a, "time": "23:30"}))
    assert t.startswith("没改成：request_id r1 已经用在另一次不同的操作上了，换一个编号。")
    assert len(stop_ids(pid)) == 4
    # 同号的寄出也不重发信封
    ok(call("date_edit", plan=pid, op="remove_stop", stop_id=stop_ids(pid)[-1]))
    ok(call("date_send", plan=pid, request_id="s1"))
    ok(call("date_send", plan=pid, request_id="s1"))
    assert raw("SELECT COUNT(*) FROM date_events WHERE plan_id=? AND kind='envelope'", (pid,))[0][0] == 1


def test_request_id_concurrent_only_one_write():
    pid, _ = build()
    res, bar = [], threading.Barrier(2)

    def go():
        bar.wait()
        res.append(call("date_edit", plan=pid, op="add_stop", kind="walk", time="23:00", request_id="rx"))
    th = [threading.Thread(target=go) for _ in range(2)]
    [x.start() for x in th]
    [x.join() for x in th]
    assert all(not err for _, err in res)
    assert len(stop_ids(pid)) == 4


def test_expect_version_stale():
    pid, _ = build()
    t = bad(call("date_edit", plan=pid, op="set_card", text="x", expect_version=1))
    assert "已经被改过了（现在是 v7，你拿的是 v1），先看最新的再改" in t


def test_render_failure_after_commit_still_success(monkeypatch):
    pid, _ = build()
    monkeypatch.setattr(dp, "snapshot", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    t = ok(call("date_edit", plan=pid, op="set_card", text="惊喜"))
    assert t == "改好了。\n\n（详情暂时读不出来，用 date_view 再看一眼）"
    assert raw("SELECT card_text FROM date_plans WHERE id=?", (pid,)) == [("惊喜",)]


def test_string_numbers_accepted_and_bad_version_refused():
    pid, _ = build()
    assert ok(call("date_view", plan=str(pid))).startswith(f"约会 #{pid}")
    t = bad(call("date_edit", plan=str(pid), op="set_card", text="x", expect_version="v1"))
    assert t == "没改成：expect_version 要写整数。"
    t = bad(call("date_edit", plan=str(pid), op="set_card", text="x", expect_version="1"))
    assert "已经被改过了" in t


# ── date_route(走 ports:地点服务 + 步行路线服务;接口同 ephemera_date.places / ephemera_date.maps)──────────────
class FakePlaces:
    name = "fake"

    def __init__(self, table=None, err=None):
        self.table, self.err, self.calls = table or {}, err, []

    def capabilities(self):
        return ports.Capabilities("fake", False, False, False, True, "© fake", "")

    def search(self, q, near=None, limit=8):
        return ports.PlaceList(source="fake")

    def geocode(self, q):
        self.calls.append(q)
        if self.err:
            raise self.err
        pt = self.table.get(q)
        return ports.PlaceList([ports.Place(q, *pt, source="osm")] if pt else [], source="fake")


class FakeWalk:
    def __init__(self, minutes=6, dist=452, err=None, reason=None, reason_text=None, unverified=None):
        self.minutes, self.dist, self.err, self.calls = minutes, dist, err, []
        self.reason, self.reason_text, self.unverified = reason, reason_text, unverified

    def walk(self, o, d):
        self.calls.append((o, d))
        if self.err:
            raise self.err
        if self.reason:
            return ports.WalkResult(None, None, "local", self.reason, self.reason_text)
        return ports.WalkResult(self.minutes, self.dist, "local", unverified_connector_m=self.unverified)


def _usage(kind):
    r = raw("SELECT count FROM date_route_usage WHERE kind=?", (kind,))
    return r[0][0] if r else 0


def test_route_walk_success():
    places, walk = FakePlaces({"梧桐站": (31.2, 121.4)}), FakeWalk()
    ports.install("places", places)
    ports.install("walk", walk)
    t = ok(call("date_route", mode="walk", **{"from": "梧桐站", "to": "31.205,121.41"}))
    assert t == ("步行：梧桐站 → 31.205,121.41 大约 6 分钟，450 米。"
                 "确认后用 date_edit 的 set_leg 写进去（核对过可以写 source=checked）。")
    assert places.calls == ["梧桐站"] and walk.calls == [((31.2, 121.4), (31.205, 121.41))]
    assert _usage("walk") == 1
    assert raw("SELECT COUNT(*) FROM date_plans")[0][0] == 0


def test_route_walk_notes_unverified_connector():
    ports.install("walk", FakeWalk(minutes=9, dist=1520, unverified=140))
    t = ok(call("date_route", mode="walk", **{"from": "31.2,121.4", "to": "31.21,121.41"}))
    assert t.startswith("步行：31.2,121.4 → 31.21,121.41 大约 9 分钟，1.5 公里（有一段 140 米没有核实能走）。")


def test_route_walk_unconfigured_no_road_and_notfound(monkeypatch):
    monkeypatch.setenv("EPHEMERA_WALK_ADAPTER", "none")
    assert bad(call("date_route", mode="walk", **{"from": "a", "to": "b"})) == "步行时间查不了：步行路线服务没有配置。"
    monkeypatch.delenv("EPHEMERA_WALK_ADAPTER")
    monkeypatch.setenv("EPHEMERA_PLACES_ADAPTER", "none")
    ports.install("walk", FakeWalk())
    assert bad(call("date_route", mode="walk", **{"from": "a", "to": "31.2,121.4"})) == \
        "步行时间查不了：地点服务没有配置，from / to 写「纬度,经度」。"
    ports.install("places", FakePlaces())
    assert bad(call("date_route", mode="walk", **{"from": "不存在的地方", "to": "31.7,121.7"})) == \
        "找不到「不存在的地方」这个地方。"
    ports.install("places", FakePlaces(err=ports.PlaceError(429, "over_quota", "查询次数超了限额", "fake")))
    assert bad(call("date_route", mode="walk", **{"from": "某处", "to": "31.7,121.7"})) == \
        "步行时间查不了：查询次数超了限额。"
    ports.install("walk", FakeWalk(err=ports.NoRoadData()))
    assert bad(call("date_route", mode="walk", **{"from": "31.6,121.6", "to": "31.7,121.7"})) == \
        "步行时间查不了：31.6,121.6 到 31.7,121.7 这段没有路网数据。"     # 不退直线冒充
    ports.install("walk", FakeWalk(err=ports.PortUnavailable("限流了，过一会儿再查")))
    assert bad(call("date_route", mode="walk", **{"from": "31.6,121.6", "to": "31.7,121.7"})) == \
        "步行时间查不了：限流了，过一会儿再查。"


@pytest.mark.parametrize("reason", ["out_of_coverage", "no_network", "disconnected", "no_basemap"])
def test_route_walk_reasons_pass_through(reason):
    from ephemera_date.maps import REASONS
    ports.install("walk", FakeWalk(reason=reason, reason_text=REASONS[reason]))
    t = bad(call("date_route", mode="walk", **{"from": "31.6,121.6", "to": "31.7,121.7"}))
    assert REASONS[reason].rstrip("。") in t and "分钟" not in t
    if REASONS[reason].startswith("这段"):
        assert t == f"步行时间查不了：31.6,121.6 到 31.7,121.7 {REASONS[reason]}。"


def test_route_walk_default_is_local_network_without_basemap():
    """不设 env:步行默认走本地路网;还没建底图 = 明说,不报错堆栈。"""
    t = bad(call("date_route", mode="walk", **{"from": "31.6,121.6", "to": "31.7,121.7"}))
    assert t == "步行时间查不了，还没有建底图：先用建底图脚本建这个城市的底图库。"


def test_route_transit_mode_gone():
    assert bad(call("date_route", mode="transit", **{"from": "a", "to": "b"})) == "查不了：mode 只能是 walk。"


# ── 待办通道:回执末尾的数 + date_inbox ─────────────────────────────────────────────
def test_tail_counts_open_todos_and_inbox_list_claim_done(_env):
    from ephemera_date import inbox
    text, _ = asyncio.run(dt.call("date_view", {}))
    assert text.endswith("（约会待办 0 件）")
    inbox.deliver("reminder", "[约会提醒] 约会 #1 明天（10/28 周三）。", "reminder:k1", plan_ids=[1], now=NOW0)
    inbox.deliver("reminder", "[约会提醒] 约会 #1 明天（10/28 周三）。", "reminder:k1", plan_ids=[1], now=NOW0)
    text, _ = asyncio.run(dt.call("date_view", {}))
    assert text.endswith("（约会待办 1 件，用 date_inbox 查看）")
    a = ok(call("date_inbox"))
    assert a.startswith("约会待办 1 件：\n[待办 1] 10/20 10:00 · 约会提醒（可领取）\n    [约会提醒] 约会 #1 明天")
    assert "（可领取）" in ok(call("date_inbox", op="list"))              # 只看不领:看几次都还是可领

    def inbox_call(session, **args):
        text, err = asyncio.run(dt.call("date_inbox", args, session=session, label="同一个应用"))
        return text, err
    t, err = inbox_call("s-1", op="done", ids=[1])
    assert err and "还没领取，先用 op=claim 领取：待办 1" in t                  # 要先领取
    t, err = inbox_call("s-1", op="claim", ids=[1])
    assert not err and t.startswith("领取了：待办 1。") and "（你领取了，到 10/20 10:30）" in t
    t, err = inbox_call("s-2", op="claim", ids=[1])                      # 同名应用的另一个会话:领不走
    assert err and t.startswith("别人在处理，领不走：待办 1（同一个应用）。")
    t, err = inbox_call("s-2", op="done", ids=[1])
    assert err and "别人在处理，没确认：待办 1（同一个应用）" in t
    assert bad(call("date_inbox", op="done", ids=[])).startswith("没成：ids 要写")
    t, err = inbox_call("s-1", op="done", ids=[1, 99])
    assert not err and t.startswith("确认做完：待办 1；没有这几件：99。") and t.endswith("约会待办：没有。")
    t, err = inbox_call("s-1", op="done", ids=[1])
    assert t.startswith("之前就做完或过期了：待办 1。")
    assert inbox.activity()["pull"] is not None                          # 用过工具:只记成「最近活动」


def test_new_stop_kinds_cafe_viewpoint_shopping_shrine():
    pid, (s1, s2, s3) = build()
    for k, zh in (("cafe", "咖啡"), ("viewpoint", "展望台"), ("shopping", "买东西"), ("shrine", "神社")):
        ok(call("date_edit", plan=pid, op="update_stop", stop_id=s3, kind=k))
        assert f"{zh}（{k}）" in ok(call("date_view", plan=pid))
    assert set(dp.KINDS) >= {"cafe", "viewpoint", "shopping", "shrine"}


# ── schema:取值有限的字段写 enum,set_prep 的 items 是对象 ─────────────────────────────
def test_schema_enums_come_from_the_engine():
    sch = {t["name"]: t["input_schema"]["properties"] for t in dt.tool_schemas()}
    e = sch["date_edit"]
    assert e["op"]["enum"] == list(dp.EDIT_OPS)
    assert {"set_basic", "add_stop", "update_stop", "remove_stop", "move_stop", "set_leg", "remove_leg", "set_prep",
            "set_contract", "set_card", "cancel", "delete_plan"} <= set(e["op"]["enum"])
    assert e["color"]["enum"] == list(dp.COLORS) == sch["date_open"]["color"]["enum"]
    assert e["mode"]["enum"] == list(dp.LEG_MODES) and e["source"]["enum"] == list(dp.LEG_SOURCES)
    assert sch["date_live"]["op"]["enum"] == list(dp.LIVE_OPS)
    assert sch["date_inbox"]["op"]["enum"] == ["list", "claim", "done", "release"]
    assert sch["date_memory"]["op"]["enum"] == ["find", "followup"]
    obj, plain = e["items"]["items"]["anyOf"]                    # set_prep 对象 / set_contract 旧写法字符串
    assert plain["type"] == "string"
    item = obj
    assert item["type"] == "object" and item["required"] == ["section", "text"]
    assert item["properties"]["section"]["enum"] == list(dp.PREP_SECTIONS) == ["book", "wear", "bring", "weather"]
    assert set(item["properties"]) == set(dt._PREP_ITEM)
    for op in dp.EDIT_OPS:                                       # 每个 enum 值引擎都认(没有写错的 op)
        assert op in dt._OP_FIELDS[dt.TOOL_EDIT], op


def test_readme_minimal_example_runs(_env):
    """docs/GUIDE.md「接 AI」里的最小示例,原样跑通:开 → 两站 → 准备清单 → 寄出 → 当天提前开第 2 站 → 结束。"""
    t = call("date_open", title_en="A Quiet\nRiver Walk", date=DAY, color="sky")[0]
    plan = int(re.search(r"#(\d+)", t).group(1))
    assert not call("date_edit", plan=plan, op="add_stop", kind="cafe", time="15:00", title="转角咖啡",
                    address="滨河路 18 号", clue="门口有一棵银杏", reveal_at="12:00")[1]
    assert not call("date_edit", plan=plan, op="add_stop", kind="walk", time="16:30", title="沿河步道",
                    address="河堤", clue="把今天走完")[1]
    assert not call("date_edit", plan=plan, op="set_prep",
                    items=[{"section": "wear", "text": "一双走得久的鞋"}, {"section": "bring", "text": "一件薄外套"}])[1]
    sent, err = call("date_send", plan=plan)
    assert not err and "寄出了" in sent, sent
    view = call("date_view", plan=plan)[0]
    stop2 = int(re.findall(r"\[stop (\d+)\]", view)[1])
    _env["now"] = datetime(2026, 10, 28, 14, 0, tzinfo=TZ)
    assert not call("date_live", plan=plan, op="open_stop", stop_id=stop2)[1]
    _env["now"] = datetime(2026, 10, 28, 21, 0, tzinfo=TZ)
    assert not call("date_close", plan=plan, quote="Good company, a good day")[1]


def test_send_without_first_reveal_names_it():
    t = call("date_open", title_en="No\nReveal", date=DAY, color="rose")[0]
    plan = int(re.search(r"#(\d+)", t).group(1))
    call("date_edit", plan=plan, op="add_stop", kind="cafe", time="15:00", title="转角咖啡", address="滨河路",
         clue="银杏")
    call("date_edit", plan=plan, op="set_prep", items=[{"section": "wear", "text": "鞋"}])
    sent, err = call("date_send", plan=plan)
    assert err and "第 1 站没写地点公开时间" in sent
