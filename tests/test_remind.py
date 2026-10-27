"""Ledger + reminders (four delivery states) + event outlet.

tmp databases, fake clock (explicit now), fake delivery / fake webhook (injected functions, no network).
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

import pytest

from ephemera_date import config
from ephemera_date import plan as dp
from ephemera_date import outlet
from ephemera_date import remind as date_remind
from ephemera_date import tools as dt
from conftest import TZ



def T(m, d, h=12, mi=0, y=2026):
    return datetime(y, m, d, h, mi, tzinfo=TZ)


NOW0 = T(10, 20, 10, 0)
DAY = "2026-10-28"   # 周三


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    assert str(tmp_path) in config.db_path(), "测试库必须在 tmp"
    dp._connect().close()
    yield


def ok(r):
    assert r["ok"], r["errors"]
    return r


def ids(pid, now=NOW0):
    return [s["id"] for s in dp.snapshot(pid, now=now)["state"]["stops"]]


def raw(sql, args=()):
    c = sqlite3.connect(config.db_path())
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def make_plan(now=NOW0, day=DAY, send=True, stop3_reveal=None):
    """集合 19:00(公开 17:30)→ 晚餐 19:30(步行 19:20 出发)→ 电影 21:00(电车 20:52 出发)。"""
    pid = ok(dp.open_plan("The Evening\nScreening", day, "rose", now=now))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="a",
                                        clue="c1", reveal_at="17:30", note="n1"), now=now))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="19:30", stay_until="20:45", title="Le Petit Pot",
                                        address="b", clue="c2", note="n2"), now=now))
    ok(dp.edit(pid, "add_stop", dict(kind="cinema", time="21:00", title="小影院", address="c",
                                        clue="c3", reveal_at=stop3_reveal, note="n3"), now=now))
    s1, s2, s3 = ids(pid, now)
    ok(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="walk", minutes=6, depart_time="19:20"), now=now))
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="train", minutes=6, depart_time="20:52",
                                       arrive_time="20:58"), now=now))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "一把伞"}]), now=now))
    if send:
        ok(dp.send(pid, now=now))
    return pid, (s1, s2, s3)


def plan_of(pid, now):
    with dp._tx() as conn:
        st = dp._load(conn, pid)
    return dp.reminder_plan(st, now)


# ── 提醒计划(/  定稿句)─────────────────────────────────────────────────────
def test_plan_lines_and_times_exact():
    pid, (s1, s2, s3) = make_plan()
    got = [(r["kind"], r["fire_at"], r["expire_at"], r["line"]) for r in plan_of(pid, NOW0)]
    assert got == [
        ("eve", T(10, 27, 20), T(10, 28, 0), f"约会 #{pid} 明天（10/28 周三）。"),
        ("day", T(10, 28, 9), T(10, 28, 19), f"约会 #{pid} 今天，第 1 站 19:00。"),
        ("stop", T(10, 28, 18, 45), T(10, 28, 19), f"约会 #{pid} · 第 1 站 19:00 到 · 15 分钟后。"),
        # 第 2 站默认公开 = 出发 19:20,「出发前 15 分」时还没公开 → 按到达(不泄露路程长短)
        ("stop", T(10, 28, 19, 15), T(10, 28, 19, 30), f"约会 #{pid} · 第 2 站 19:30 到 · 15 分钟后。"),
        ("stop", T(10, 28, 20, 45), T(10, 28, 21), f"约会 #{pid} · 第 3 站 21:00 到 · 15 分钟后。"),
    ]


def test_depart_basis_only_when_place_public_before_lead():
    pid, (_s1, _s2, s3) = make_plan(stop3_reveal="20:00")
    r3 = [r for r in plan_of(pid, NOW0) if r["stop_id"] == s3][0]
    assert (r3["basis"], r3["fire_at"], r3["expire_at"]) == ("depart", T(10, 28, 20, 37), T(10, 28, 20, 52))
    assert r3["line"] == f"约会 #{pid} · 去第 3 站 20:52 出发 · 15 分钟后。"


def test_early_first_stop_moves_today_reminder():
    pid = ok(dp.open_plan("Early", DAY, "sky", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="08:30", title="x", address="a", clue="c",
                                        reveal_at="07:00"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    day = [r for r in plan_of(pid, NOW0) if r["kind"] == "day"][0]
    assert (day["fire_at"], day["expire_at"]) == (T(10, 28, 8, 15), T(10, 28, 8, 30))


def test_draft_has_no_reminders_and_unfinished_only_when_live():
    pid, _ = make_plan(send=False)
    assert plan_of(pid, NOW0) == []
    pid2, _ = make_plan()
    assert not [r for r in plan_of(pid2, NOW0) if r["kind"] == "unfinished"]
    live_now = T(10, 28, 22)
    un = [r for r in plan_of(pid2, live_now) if r["kind"] == "unfinished"]
    assert [(r["fire_at"], r["expire_at"], r["line"]) for r in un] == [
        (T(10, 29, 10), T(10, 29, 23, 59), f"约会 #{pid2} 还没结束（最后一站是 10/28 21:00）。")]


# ── 调度(照待办协议)──────────────────────────────────────────────────────────────────
class Waker:
    def __init__(self, result="sent"):
        self.calls, self.result = [], result

    def __call__(self, body, meta):
        self.calls.append((meta, body))
        return self.result


def run(now, waker, busy=False, quiet=False):
    return date_remind.process_reminders(wake=waker, busy=lambda: busy, in_quiet=quiet, now=now)


def test_due_reminders_merge_into_one_round_and_never_repeat():
    pid, _ = make_plan()
    pid2, _ = make_plan()
    w = Waker()
    r = run(T(10, 27, 20, 1), w)
    assert r["woke"] == 1 and len(w.calls) == 1
    meta, body = w.calls[0]
    assert meta["plan_ids"] == [pid, pid2] and len(meta["keys"]) == 2
    assert body == (f"[约会提醒] 约会 #{pid} 明天（10/28 周三）。\n"
                    f"约会 #{pid2} 明天（10/28 周三）。")
    run(T(10, 27, 20, 2), w)
    assert len(w.calls) == 1                          # 终态不重发
    assert raw("SELECT COUNT(*) FROM date_reminders WHERE wake_result='sent'") == [(2,)]


def test_busy_and_quiet_defer_then_expire():
    pid, _ = make_plan()
    w = Waker()
    assert run(T(10, 27, 20, 1), w, busy=True)["deferred"] == 1
    assert run(T(10, 27, 20, 2), w, quiet=True)["deferred"] == 1
    assert w.calls == []
    r = run(T(10, 28, 9, 0), w, quiet=True)          # 明天提醒到 09:00 过期 → expired,今天那条顺延
    assert r["expired"] == 1
    assert raw("SELECT wake_result FROM date_reminders WHERE kind='eve'") == [("expired",)]


def test_not_sent_releases_for_retry_unknown_is_terminal():
    pid, _ = make_plan()
    w = Waker("not_sent")
    assert run(T(10, 27, 20, 1), w)["released"] == 1
    w.result = "unknown"
    run(T(10, 27, 20, 2), w)
    run(T(10, 27, 20, 3), w)
    assert len(w.calls) == 2
    assert raw("SELECT wake_result FROM date_reminders") == [("unknown",)]


def test_late_send_fires_immediately_within_validity():
    pid, _ = make_plan(send=False)
    late = T(10, 28, 9, 30)                           # 当天 09:30 才寄出:明天提醒已过期,今天提醒仍有效
    ok(dp.send(pid, now=late))
    w = Waker()
    run(late, w)
    assert w.calls and w.calls[0][1] == f"[约会提醒] 约会 #{pid} 今天，第 1 站 19:00。"


def test_edit_voids_logged_reminder_and_reschedules():
    pid, (s1, _s2, _s3) = make_plan()
    w = Waker()
    run(T(10, 28, 18, 46), w, busy=True)              # 第 1 站提醒落行但顺延
    assert raw("SELECT line, woke_at FROM date_reminders WHERE kind='stop'") == [
        (f"约会 #{pid} · 第 1 站 19:00 到 · 15 分钟后。", None)]
    # 当天把集合改到 19:15(顺延 15 分):旧键在同一笔写里作废,新键到点照发
    ok(dp.live(pid, "shift", dict(from_stop=s1, minutes=15), now=T(10, 28, 18, 47)))
    assert raw("SELECT wake_result FROM date_reminders WHERE kind='stop'") == [("void",)]
    run(T(10, 28, 19, 0), w)
    assert w.calls[-1][1] == f"[约会提醒] 约会 #{pid} · 第 1 站 19:15 到 · 15 分钟后。"


def test_cancel_voids_pending_reminders():
    pid, _ = make_plan()
    w = Waker()
    run(T(10, 27, 20, 1), w, busy=True)
    ok(dp.edit(pid, "cancel", dict(reason="下雨"), now=T(10, 27, 20, 2)))
    run(T(10, 27, 20, 3), w)
    assert w.calls == []
    assert raw("SELECT wake_result FROM date_reminders") == [("void",)]


# ── 约会账(/ )──────────────────────────────────────────────────────────────
def test_ledger_shape_and_key_ignores_stamp():
    pid, _ = make_plan()                               # 已寄出
    ok(dp.edit(pid, "set_card", dict(text="小卡"), now=NOW0, next_note="订第三站的票"))
    pid2 = ok(dp.open_plan("Moonlit Walk", "2026-11-15", "sky", now=NOW0))["plan_id"]
    pid3 = ok(dp.open_plan("Cafe Matinee", "2026-10-21", "cream", now=NOW0))["plan_id"]
    later = T(10, 22, 14, 20)                          # pid3 日期已过、没寄出
    text, key = dt.ledger_block(later)
    assert text == "\n".join([
        "# 约会账 · 约会（生成于 10/22 14:20；进行中 2 个）",
        "（进行中的约会这里只写进度，不写约会名和你写的内容；要看用 date_view 打开）",
        f"· 约会 #{pid} 10/28 周三 · 已寄出（还有 6 天）",
        "  写到：3 站齐；路段 2 段；准备清单 1 类；契约书没写；小卡已写；还缺：无",
        "  下一步：你上次留了一句（date_view 里看）",
        f"· 约会 #{pid2} 11/15 周日 · 构思中",
        "  写到：0 站；还缺：站、准备清单",
        "  下一步：没留",
        f"· 约会 #{pid3} 10/21 · 构思中（日期已过，没寄出）",
    ])
    # 进行中约会的名字与「下一步」内容不进约会账(带账的轮不再盖思考)
    for leak in ("The Evening Screening", "Moonlit Walk", "Cafe Matinee", "订第三站的票"):
        assert leak not in text
    text2, key2 = dt.ledger_block(later + timedelta(minutes=7))
    assert text2 != text and key2 == key               # 只有生成时刻变 → 去重键不变
    assert "生成于" not in key


def test_ledger_empty():
    assert dt.ledger_block(NOW0) == ("", "")
    make_plan()
    assert dt.ledger_block(NOW0)[0].startswith(dt.LEDGER_HEADER)


# ── 推送(/ )───────────────────────────────────────────────────────────────
class Sender:
    def __init__(self, ok=True):
        self.calls, self.ok = [], ok

    def __call__(self, payload):
        self.calls.append(payload)
        return "sent" if self.ok else "failed"


def test_push_fixed_texts_once_each():
    pid, (s1, _s2, _s3) = make_plan()
    ok(dp.live(pid, "telegram", dict(text="我到了"), now=T(10, 28, 18, 50)))
    ok(dp.edit(pid, "cancel", dict(reason="下雨"), now=T(10, 28, 18, 55)))
    s = Sender()
    r = outlet.sweep(s)
    assert (r["sent"], r["failed"], r["skipped"]) == (3, 0, 0)
    assert [(d["title"], d["body"]) for d in s.calls] == [
        ("你收到一封信", "Ephemera · 10/28"),
        ("有一封新电报", "「The Evening Screening」"),
        ("约会取消了", "「The Evening Screening」 · 有一封电报"),
    ]
    assert [d["navigate"] for d in s.calls] == [{"page": "seal", "planId": pid}, {"page": "telegrams", "planId": None},
                                                {"page": "telegrams", "planId": None}]
    assert all(set(d) == {"type", "kind", "title", "body", "plan_id", "event_id", "navigate"} for d in s.calls)
    for d in s.calls:                                   # 推送不带任何地点/线索/正文
        for secret in ("梧桐站", "我到了", "下雨", "c1"):
            assert secret not in str(d)
    outlet.sweep(s)
    assert len(s.calls) == 3                           # 同一事件不重推


def test_push_close_text_and_failure_not_retried():
    pid, _ = make_plan()
    outlet.sweep(Sender())                             # 先把信封推掉
    ok(dp.close(pid, "很好的一天", now=T(10, 28, 23)))
    bad = Sender(ok=False)
    assert outlet.sweep(bad)["failed"] == 1
    assert [(d["title"], d["body"]) for d in bad.calls] == [("收进纪念盒了", "「The Evening Screening」")]
    outlet.sweep(Sender())
    assert raw("SELECT kind, push_state FROM date_events ORDER BY id") == [
        ("envelope", "sent"), ("close", "failed")]


def test_push_without_webhook_marks_skipped():
    make_plan()
    assert outlet.sweep()["skipped"] == 1               # 没配 EPHEMERA_EVENT_WEBHOOK
    assert raw("SELECT push_state FROM date_events") == [("skipped",)]


def test_push_endpoint_down_keeps_pending_for_next_round():
    pid, _ = make_plan()
    ok(dp.live(pid, "telegram", dict(text="一"), now=T(10, 28, 18, 50)))
    calls = []

    def down(payload):
        calls.append(payload)
        return "not_sent"
    r = outlet.sweep(down)
    assert r["released"] == 1 and len(calls) == 1      # 一轮里第一条没送到就停,保持顺序
    assert raw("SELECT kind, push_state FROM date_events ORDER BY id") == [
        ("envelope", "pending"), ("telegram_manual", "pending")]
    s = Sender()
    outlet.sweep(s)
    assert [d["kind"] for d in s.calls] == ["envelope", "telegram_manual"]


def test_projection_arrive_at_follows_midnight_rule():
    pid = ok(dp.open_plan("Late", DAY, "berry", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="23:30", title="x", address="a", clue="c",
                                        reveal_at="22:00"), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="walk", time="00:30", title="y", address="b", clue="d"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    view = dp.her_plan(pid, now=NOW0)
    assert [s["arrive_at"] for s in view["stops"]] == [T(10, 28, 23, 30).timestamp(),
                                                       T(10, 29, 0, 30).timestamp()]


def test_prep_keys_stable_across_reveal_and_detail_edit():
    pid, (_s1, _s2, s3) = make_plan()
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="train", minutes=6, depart_time="20:52",
                                       arrive_time="20:58", needs_ticket=True, ticket_note="卡"), now=NOW0))
    before = dp.her_plan(pid, now=NOW0)["prep"]
    tick = [i for i in before if i["derived"]][0]
    assert tick["text"] == dp.TXT_DERIVED_HIDDEN and "to_stop" not in tick
    assert str(s3) not in tick["key"]                  # 键里不带目的地站号
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "一把伞", "detail": "折叠的"}]),
               now=NOW0))
    after = dp.her_plan(pid, now=T(10, 28, 21, 0))["prep"]   # 第 3 站已公开
    assert {i["key"] for i in after} == {i["key"] for i in before} == {"p:bring:一把伞", tick["key"]}
    assert [i["text"] for i in after if i["derived"]] == ["去第 3 站的车票"]


def test_long_leg_arrival_reminder_survives_reveal_settlement():
    """路段 ≥15 分,到点公开一结算,不能把依据翻成出发、让到达提醒消失。"""
    pid = ok(dp.open_plan("Long Leg", DAY, "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="x", address="a", clue="c",
                                        reveal_at="17:30"), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="20:00", title="y", address="b", clue="d"), now=NOW0))
    s2 = ids(pid)[1]
    ok(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="train", minutes=30, depart_time="19:20",
                                       arrive_time="19:50"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    dp.her_plan(pid, now=T(10, 28, 19, 21))           # 她 19:21 打开页面 → 第 2 站公开被结算记录
    w = Waker()
    run(T(10, 28, 19, 46), w)
    assert w.calls and w.calls[-1][1] == f"[约会提醒] 约会 #{pid} · 第 2 站 20:00 到 · 15 分钟后。"


def test_shift_and_back_revives_voided_reminder():
    pid, (s1, _s2, _s3) = make_plan()
    w = Waker()
    run(T(10, 28, 18, 46), w, busy=True)
    ok(dp.live(pid, "shift", dict(from_stop=s1, minutes=15), now=T(10, 28, 18, 47)))
    ok(dp.live(pid, "shift", dict(from_stop=s1, minutes=-15), now=T(10, 28, 18, 48)))
    run(T(10, 28, 18, 49), w)                         # 同轮还合着没发出去的「今天」那条
    assert f"约会 #{pid} · 第 1 站 19:00 到 · 15 分钟后。" in w.calls[-1][1].split("\n")[-1]


def test_push_crash_midway_leaves_rest_pending_and_restart_recovers():
    pid, _ = make_plan()
    ok(dp.live(pid, "telegram", dict(text="一"), now=T(10, 28, 18, 50)))

    class Crash(BaseException):
        pass

    def boom(payload):
        raise Crash()

    with pytest.raises(Crash):
        outlet.sweep(boom, now=T(10, 28, 18, 51))
    assert raw("SELECT kind, push_state FROM date_events ORDER BY id") == [
        ("envelope", "sending"), ("telegram_manual", "pending")]
    s = Sender()                                       # 「重启」:正在发的那条说不清,不重推;没轮到的照推
    outlet.sweep(s, now=T(10, 28, 19, 30))
    assert [d["kind"] for d in s.calls] == ["telegram_manual"]
    assert raw("SELECT kind, push_state FROM date_events ORDER BY id") == [
        ("envelope", "unknown"), ("telegram_manual", "sent")]


def test_tomorrow_reminder_never_fires_after_midnight():
    """前一晚顺延过了午夜就不发「明天」(当天说明天会错)。"""
    pid, _ = make_plan()
    w = Waker()
    run(T(10, 27, 20, 1), w, busy=True)
    r = run(T(10, 28, 0, 1), w)
    assert w.calls == [] and r["expired"] == 1


def test_projection_reveal_at_only_for_his_explicit_time():
    """没公开的站,他写了公开时间才给她看;默认(=出发时刻)不给,免得露路程长短。"""
    pid, (s1, s2, s3) = make_plan(stop3_reveal="20:00")
    v = dp.her_plan(pid, now=NOW0)
    by = {x["stop_id"]: x for x in v["stops"]}
    assert by[s1]["reveal_at"] == T(10, 28, 17, 30).timestamp()
    assert by[s2]["reveal_at"] is None                 # 留空走默认 → 不给
    assert by[s3]["reveal_at"] == T(10, 28, 20, 0).timestamp()
    v2 = dp.her_plan(pid, now=T(10, 28, 17, 31))       # 第 1 站已公开 → 不再给公开时刻
    assert {x["stop_id"]: x["reveal_at"] for x in v2["stops"]}[s1] is None


def test_detail_tells_him_she_sees_his_reveal_time():
    pid, (s1, s2, _s3) = make_plan()
    txt = dt.render_detail(dp.snapshot(pid, now=NOW0), NOW0)
    line1 = [l for l in txt.split("\n") if "地点公开：17:30" in l][0]
    assert line1.endswith("（到点公开；这个时间她看得到）")
    line2 = [l for l in txt.split("\n") if "按默认" in l][0]
    assert line2.endswith("（到点公开）")


def test_ledger_live_plan_no_name_or_next_note():
    """当天(live)的约会同样不带名字与「下一步」内容。"""
    pid, _ = make_plan()
    ok(dp.edit(pid, "set_card", dict(text="小卡"), now=NOW0, next_note="记得带伞"))
    text, _ = dt.ledger_block(T(10, 28, 12, 0))
    assert f"· 约会 #{pid} 10/28 周三 · 当天" in text.split("\n")
    assert "The Evening Screening" not in text and "记得带伞" not in text


def test_detail_first_stop_without_reveal_says_not_written_not_default():
    """第 1 站没写地点公开时间:回执写「（没写）」,不写「按默认」(寄出会因此拦下,两边说法一致);第 2 站照旧按默认。"""
    pid = ok(dp.open_plan("Two\nStops", "2026-10-28", "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="梧桐路3", clue="改札右手边"),
               now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="19:30", title="小馆", address="柳岸1", clue="河边"), now=NOW0))
    txt = dt.render_detail(dp.snapshot(pid, now=NOW0), NOW0)
    lines = [l for l in txt.split("\n") if "地点公开：" in l]
    assert "地点公开：（没写）" in lines[0] and "按默认" not in lines[0]
    assert "按默认" in lines[1]
    assert "第 1 站没写地点公开时间" in [m["text"] for m in dp.check(dp.snapshot(pid, now=NOW0)["state"], NOW0)["missing"]]
