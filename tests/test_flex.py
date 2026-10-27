"""A date stays flexible once sent: the AI can skip any stop (even one she has seen; the reason is required), times
can move earlier past a skipped stop, and a leg that removing or skipping a stop breaks is dropped by the engine
instead of refusing the edit. tmp data dir, fake clock, no network.

Ported from the home engine (the two commits that added skip / unskip), adapted to this package."""
from __future__ import annotations

from datetime import datetime

from conftest import TZ
from ephemera_date import config, memory
from ephemera_date import plan as dp
from ephemera_date import tools as dt

DAY = "2026-10-28"
NOW0 = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)


def T(h, mi=0):
    return datetime(2026, 10, 28, h, mi, tzinfo=TZ)


def ok(r):
    assert r["ok"], r["errors"]
    return r


def make(open_all=True):
    """Four stops: 14:00 → 14:45 → 18:00 (dinner) → 18:00 (viewpoint), walking legs; sent and opened."""
    pid = ok(dp.open_plan("Empty Stomach", DAY, "rose", now=NOW0, open_itinerary=open_all))["plan_id"]
    for k, (kind, t, title) in enumerate([("cafe", "14:00", "咖啡"), ("walk", "14:45", "散步"),
                                          ("dinner", "18:00", "晚餐"), ("viewpoint", "18:00", "展望台")]):
        ok(dp.edit(pid, "add_stop", dict(kind=kind, time=t, title=title, address=f"河岸{k}", clue="c",
                                         lat=35.70 + k * 0.001, lng=139.70,
                                         **({"reveal_at": "13:00"} if k == 0 else {})), now=NOW0))
    sids = [s["id"] for s in dp.snapshot(pid, now=NOW0)["state"]["stops"]]
    for sid in sids[1:]:
        ok(dp.edit(pid, "set_leg", dict(to_stop=sid, mode="walk", minutes=10), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    dp.her_open(pid, now=NOW0)
    return pid, sids


def test_skip_seen_stop_then_shift_earlier_and_telegrams():
    pid, (s1, s2, s3, s4) = make()
    ok(dp.live(pid, "skip", {"stop_id": s3, "reason": "太饱了，晚饭不吃了"}, now=T(15)))   # dinner already seen: still skippable
    st = dp.snapshot(pid, now=T(15))["state"]
    assert dp.is_skipped(next(s for s in st["stops"] if s["id"] == s3))
    assert all(lg["to_stop_id"] not in (s3, s4) for lg in st["legs"])  # legs to and from the skipped stop are dropped
    ok(dp.live(pid, "shift", {"from_stop": s4, "minutes": -120}, now=T(15)))   # 18:00 → 16:00, not held by dinner 18:00
    v = dp.her_plan(pid, now=T(15, 1))
    by = {x["stop_id"]: x for x in v["stops"]}
    assert by[s3]["skipped"] is True and by[s4]["time"] == "16:00" and by[s3]["time"] == "18:00"
    texts = [e["text"] for e in dp.her_events(pid, now=T(15, 2))]
    assert "第 3 站跳过了：太饱了，晚饭不吃了；怎么去第 4 站去掉了" in texts   # reason + the dropped leg, not repeated
    assert by[s3]["skip_reason"] == "太饱了，晚饭不吃了"
    assert "跳过了：太饱了，晚饭不吃了" in dt.render_detail(dp.snapshot(pid, now=T(15, 2)), T(15, 2))


def test_unskip_and_guards():
    pid, (s1, s2, s3, s4) = make()
    ok(dp.live(pid, "skip", {"stop_id": s2, "reason": "改主意了"}, now=T(13)))
    r = dp.live(pid, "skip", {"stop_id": s2, "reason": "改主意了"}, now=T(13))
    assert not r["ok"] and r["errors"][0]["code"] == "already_skipped"
    r = dp.live(pid, "shift", {"from_stop": s2, "minutes": 10}, now=T(13))
    assert not r["ok"] and r["errors"][0]["code"] == "skipped"
    ok(dp.live(pid, "unskip", {"stop_id": s2}, now=T(13)))
    assert dp.her_plan(pid, now=T(13))["stops"][1]["skipped"] is False
    r = dp.live(pid, "unskip", {"stop_id": s2}, now=T(13))
    assert not r["ok"] and r["errors"][0]["code"] == "not_skipped"
    for sid in (s1, s2, s3):                                          # skip until only the last one is left
        ok(dp.live(pid, "skip", {"stop_id": sid, "reason": "改主意了"}, now=T(13)))
    r = dp.live(pid, "skip", {"stop_id": s4, "reason": "改主意了"}, now=T(13))
    assert not r["ok"] and r["errors"][0]["code"] == "skip_all"


def test_skip_needs_sent():
    pid = ok(dp.open_plan("Draft", DAY, "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="cafe", time="14:00", title="咖啡", address="a"), now=NOW0))
    sid = dp.snapshot(pid, now=NOW0)["state"]["stops"][0]["id"]
    r = dp.live(pid, "skip", {"stop_id": sid, "reason": "改主意了"}, now=NOW0)
    assert not r["ok"] and r["errors"][0]["code"] == "phase"


def test_remove_stop_after_send_drops_broken_leg_instead_of_refusing():
    """Before: removing stop 3 broke the leg to the already public stop 4 → public_leg; now the leg is dropped."""
    pid, (s1, s2, s3, s4) = make(open_all=False)
    dp.live(pid, "open_stop", {"stop_id": s4}, now=T(15))          # she has seen stop 4 and its leg
    ok(dp.edit(pid, "remove_stop", {"stop_id": s3}, now=T(15, 1)))
    st = dp.snapshot(pid, now=T(15, 2))["state"]
    assert [s["id"] for s in st["stops"]] == [s1, s2, s4]
    assert all(lg["to_stop_id"] != s4 for lg in st["legs"])


def test_skipped_stop_marked_in_event_card_and_json():
    pid, (s1, s2, s3, s4) = make()
    ok(dp.live(pid, "skip", {"stop_id": s3, "reason": "改主意了"}, now=T(15)))
    st = dp.snapshot(pid, now=T(15))["state"]
    fields = memory.build_fields(st, {})
    line = [ln for ln in fields["what"].split("\n") if "晚餐" in ln][0]
    assert line.endswith("（跳过了：改主意了）")
    stops = memory.build_entry(st, {})["stops"]
    assert [(x["skipped"], x["skip_reason"]) for x in stops] == [(False, None), (False, None), (True, "改主意了"),
                                                                  (False, None)]


def test_skip_only_ticket_prep_not_blocked_and_all_skipped_via_remove_refused():
    """Dropping the only ticket leg empties the prep list: not blocked after sending. Skipping one stop and then
    removing the last stop not skipped = every stop skipped: refused."""
    pid = ok(dp.open_plan("Two", DAY, "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="cafe", time="14:00", title="咖啡", address="a", clue="c", reveal_at="13:00",
                                     lat=35.7, lng=139.7), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="cinema", time="16:00", title="电影", address="b", clue="c", lat=35.71,
                                     lng=139.7), now=NOW0))
    a, b = [s["id"] for s in dp.snapshot(pid, now=NOW0)["state"]["stops"]]
    ok(dp.edit(pid, "set_leg", dict(to_stop=b, mode="train", minutes=10, needs_ticket=True), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    ok(dp.live(pid, "skip", {"stop_id": b, "reason": "改主意了"}, now=T(13)))       # the only prep item goes with the leg
    ok(dp.live(pid, "unskip", {"stop_id": b}, now=T(13)))
    ok(dp.live(pid, "skip", {"stop_id": a, "reason": "改主意了"}, now=T(13)))
    r = dp.edit(pid, "remove_stop", {"stop_id": b}, now=T(13))
    assert not r["ok"] and "all_skipped" in [e["code"] for e in r["errors"]]


def test_skipped_stop_time_does_not_drift_when_others_move():
    """A skipped stop's time stays on the date's day: moving the stop before it past it does not push it to the
    next day."""
    pid, (s1, s2, s3, s4) = make()
    ok(dp.live(pid, "skip", {"stop_id": s3, "reason": "改主意了"}, now=T(13)))
    before = dp.timeline(dp.snapshot(pid, now=T(13))["state"])["abs"][s3]
    ok(dp.edit(pid, "update_stop", {"stop_id": s4, "time": "19:30"}, now=T(13)))
    ok(dp.edit(pid, "update_stop", {"stop_id": s2, "time": "18:30"}, now=T(13)))   # the stop before moves past 18:00
    after = dp.timeline(dp.snapshot(pid, now=T(13))["state"])["abs"][s3]
    assert before == after == T(18)


def test_skip_requires_reason():
    pid, (s1, s2, s3, s4) = make()
    r = dp.live(pid, "skip", {"stop_id": s3}, now=T(15))
    assert not r["ok"] and r["errors"][0]["code"] == "need_skip_reason"
    r = dp.live(pid, "skip", {"stop_id": s3, "reason": "字" * 61}, now=T(15))
    assert not r["ok"] and r["errors"][0]["code"] == "long_skip_reason"
    ok(dp.live(pid, "skip", {"stop_id": s3, "reason": "下雨"}, now=T(15)))
    ok(dp.live(pid, "unskip", {"stop_id": s3}, now=T(15)))
    assert dp.her_plan(pid, now=T(15))["stops"][2]["skip_reason"] is None


# ── open-source additions: no reminders for a skipped stop, the tool surface, the names ──────────────────────────
def test_skipped_stop_gets_no_reminders():
    pid, (s1, s2, s3, s4) = make()
    st = dp.snapshot(pid, now=T(13))["state"]
    assert any(r.get("stop_id") == s3 for r in dp.reminder_plan(st, T(13)))
    ok(dp.live(pid, "skip", {"stop_id": s3, "reason": "改主意了"}, now=T(13)))
    st = dp.snapshot(pid, now=T(13))["state"]
    assert not any(r.get("stop_id") == s3 for r in dp.reminder_plan(st, T(13)))


def test_tool_surface_for_skip(monkeypatch):
    sch = {t["name"]: t for t in dt.tool_schemas()}
    live = sch["date_live"]
    assert {"skip", "unskip"} <= set(live["input_schema"]["properties"]["op"]["enum"])
    assert live["input_schema"]["properties"]["reason"] == {"type": "string"}
    assert ("op=skip：跳过某一站（她看到过的也行），reason 写原因（必写），那一站留在记录里标「跳过了」，"
            "后面的站可以往前挪；op=unskip 撤回。") in live["description"]
    monkeypatch.setenv("EPHEMERA_HER", "小满")
    d = {t["name"]: t["description"] for t in dt.tool_schemas()}["date_live"]
    assert "（小满看到过的也行）" in d
    assert dt._OP_FIELDS[dt.TOOL_LIVE]["skip"] == ("stop_id", "reason")
    assert config.her() == "小满"


def test_skip_through_the_tool(monkeypatch):
    import asyncio
    monkeypatch.setattr(dt, "_now", lambda: T(15))
    pid, (s1, s2, s3, s4) = make()
    text, err = asyncio.run(dt.call("date_live", {"plan": pid, "op": "skip", "stop_id": s3, "reason": "下雨了"}))
    assert not err and text.startswith("跳过了，已自动给她发了电报。"), text
    text, err = asyncio.run(dt.call("date_live", {"plan": pid, "op": "skip", "stop_id": s2}))
    assert err and "跳过的原因不能空着" in text
    text, err = asyncio.run(dt.call("date_live", {"plan": pid, "op": "unskip", "stop_id": s3}))
    assert not err and text.startswith("撤回了跳过，已自动给她发了电报。"), text


def test_day_reminder_uses_the_first_stop_not_skipped():
    """The "today" reminder names the first stop not skipped (stop 1 skipped → stop 2 and its time); unskip restores
    stop 1. The eve reminder carries no stop and stays the same."""
    pid, (s1, s2, s3, s4) = make()

    def day_and_eve():
        st = dp.snapshot(pid, now=T(8))["state"]
        rs = dp.reminder_plan(st, datetime(2026, 10, 27, 12, 0, tzinfo=TZ))
        day = [r for r in rs if r["kind"] == "day"]
        eve = [r for r in rs if r["kind"] == "eve"]
        assert len(day) == 1 and len(eve) == 1
        return day[0], eve[0]

    day, eve = day_and_eve()
    assert day["line"] == f"约会 #{pid} 今天，第 1 站 14:00。" and day["expire_at"] == T(14)
    ok(dp.live(pid, "skip", {"stop_id": s1, "reason": "起晚了"}, now=T(8)))
    day2, eve2 = day_and_eve()
    assert day2["line"] == f"约会 #{pid} 今天，第 2 站 14:45。" and day2["expire_at"] == T(14, 45)
    assert eve2["line"] == eve["line"] and eve2["fire_at"] == eve["fire_at"]
    ok(dp.live(pid, "unskip", {"stop_id": s1}, now=T(8)))
    day3, _ = day_and_eve()
    assert day3["line"] == day["line"] and day3["expire_at"] == T(14)
