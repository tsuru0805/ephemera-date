"""Per-stop art: fixed rotation by default; optional generator queue (debounce / cap / retry / supersede).

tmp data dir, fake clock, fake generator (ports.install); nothing paid, no network.
"""
from __future__ import annotations

import asyncio
import os
import sqlite3
from datetime import datetime, timedelta

import pytest

from conftest import TZ
from ephemera_date import art as date_art
from ephemera_date import config, ports
from ephemera_date import plan as dp
from ephemera_date import tools as dt

NOW0 = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


class Gen:
    def __init__(self, fail=0, during=None):
        self.calls, self.fail, self.during = [], fail, during

    async def generate(self, job):
        self.calls.append(job)
        if self.during:
            self.during()
        if self.fail:
            self.fail -= 1
            raise RuntimeError("画坏了")
        return b"INK:" + job["kind"].encode(), b"INV:" + job["kind"].encode()


@pytest.fixture(autouse=True)
def _env(tmp_path):
    assert str(tmp_path) in config.db_path() and str(tmp_path) in dp.art_dir()
    ports.install("art", Gen())
    dp._connect().close()
    yield


def ok(r):
    assert r["ok"], r["errors"]
    return r


def raw(sql, args=()):
    c = sqlite3.connect(config.db_path())
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def make_plan(send=True, hint=None):
    pid = ok(dp.open_plan("Night", DAY, "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="a", clue="c",
                                     reveal_at="17:30", art_hint=hint), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="cafe", time="19:30", title="喫茶", address="b", clue="c"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW0))
    if send:
        ok(dp.send(pid, now=NOW0))
    sids = [s["id"] for s in dp.snapshot(pid, now=NOW0)["state"]["stops"]]
    return pid, sids


def run(now, gen):
    return asyncio.run(date_art.run_once(now, generator=gen))


# ── 默认:没配生成图 = 只用固定画 ─────────────────────────────────────────────────────────
def test_without_generator_nothing_queued_and_fixed_art_in_projection():
    ports.install("art", None)
    pid, (s1, s2) = make_plan(hint="改札口的灯")
    assert raw("SELECT COUNT(*) FROM date_art") == [(0,)]
    v = dp.her_plan(pid, now=NOW0)
    assert [s["art_fixed"] for s in v["stops"]] == [dp.fixed_art("train", s1), dp.fixed_art("cafe", s2)]
    assert "画：" not in dt.render_detail(dp.snapshot(pid, now=NOW0), NOW0)
    assert asyncio.run(date_art.run_once(NOW0 + timedelta(minutes=5))) is None


# ── 排队规则 ───────────────────────────────────────────────────────────────────────────
def test_queue_rules_draft_send_change_delete():
    pid, (s1, s2) = make_plan(send=False)
    assert raw("SELECT COUNT(*) FROM date_art")[0][0] == 0                  # 构思中、没写画面描述:不排
    ok(dp.edit(pid, "update_stop", {"stop_id": s1, "art_hint": "改札口的灯"}, now=NOW0))
    assert raw("SELECT stop_id, status FROM date_art") == [(s1, "pending")]  # 写了画面描述:排这一站
    ok(dp.send(pid, now=NOW0))
    assert sorted(raw("SELECT stop_id FROM date_art")) == [(s1,), (s2,)]    # 寄出:全排
    sig1 = raw("SELECT sig FROM date_art WHERE stop_id=?", (s2,))[0][0]
    ok(dp.edit(pid, "update_stop", {"stop_id": s2, "title": "河边的喫茶"}, now=NOW0))
    assert raw("SELECT sig != ?, status FROM date_art WHERE stop_id=?", (sig1, s2)) == [(1, "pending")]
    ok(dp.edit(pid, "update_stop", {"stop_id": s2, "clue": "换个线索"}, now=NOW0))    # 跟画无关的改动不重排
    ok(dp.edit(pid, "remove_stop", {"stop_id": s2}, now=NOW0))
    assert raw("SELECT stop_id FROM date_art") == [(s1,)]


def test_art_hint_change_after_send_sends_no_telegram():
    pid, (s1, _s2) = make_plan()
    before = raw("SELECT COUNT(*) FROM date_events")[0][0]
    ok(dp.edit(pid, "update_stop", {"stop_id": s1, "art_hint": "下雨的站台"}, now=NOW0))
    assert raw("SELECT COUNT(*) FROM date_events")[0][0] == before


# ── 后台画一张 ─────────────────────────────────────────────────────────────────────────
def test_draw_debounce_and_success_writes_both_variants():
    pid, (s1, s2) = make_plan(hint="改札口的灯")
    g = Gen()
    assert run(NOW0 + timedelta(seconds=60), g) is None                    # 排队不到 2 分钟:不画
    r = run(NOW0 + timedelta(minutes=5), g)
    assert r["status"] == "done" and r["stop_id"] == s1
    job = g.calls[0]
    assert job["kind"] == "train" and "梧桐站" in job["subject"] and "改札口的灯" in job["subject"]
    fname = raw("SELECT mask_file FROM date_art WHERE stop_id=?", (s1,))[0][0]
    assert open(os.path.join(dp.art_dir(), fname + "_ink.png"), "rb").read() == b"INK:train"
    assert open(os.path.join(dp.art_dir(), fname + "_inv.png"), "rb").read() == b"INV:train"


def test_her_gets_art_only_after_place_public_and_for_current_version():
    pid, (s1, _s2) = make_plan()
    run(NOW0 + timedelta(minutes=5), Gen())
    v = dp.her_plan(pid, now=T(10, 28, 17, 0))                              # 第 1 站地点 17:30 才公开
    assert v["stops"][0]["place"] is None and "art_url" not in str(v["stops"][0])
    assert dp.her_stop_art(pid, s1, now=T(10, 28, 17, 0)) is None
    v = dp.her_plan(pid, now=T(10, 28, 17, 31))
    place = v["stops"][0]["place"]
    s8 = raw("SELECT sig FROM date_art WHERE stop_id=?", (s1,))[0][0][:8]
    assert place["art_url"] == f"/api/dates/{pid}/stops/{s1}/art?v=ink&s={s8}"
    assert place["art_inv_url"] == f"/api/dates/{pid}/stops/{s1}/art?v=inv&s={s8}"
    assert dp.her_stop_art(pid, s1, variant="inv", now=T(10, 28, 17, 31)).endswith("_inv.png")
    assert dp.her_stop_art(pid, s1, variant="../x", now=T(10, 28, 17, 31)) is None
    ok(dp.edit(pid, "update_stop", {"stop_id": s1, "title": "别的站"}, now=T(10, 28, 17, 32)))   # 改地名 → 旧画作废
    assert dp.her_plan(pid, now=T(10, 28, 17, 33))["stops"][0]["place"]["art_url"] is None


def test_failure_retries_once_then_failed_and_daily_cap(monkeypatch):
    pid, (s1, s2) = make_plan()
    g = Gen(fail=5)
    assert run(NOW0 + timedelta(minutes=5), g)["status"] == "pending"
    for m in (6, 7, 8):
        run(NOW0 + timedelta(minutes=m), g)
    assert set(dict(raw("SELECT stop_id, status FROM date_art")).values()) == {"failed"}
    assert len(g.calls) == 4                                                 # 两站各两次
    assert raw("SELECT count FROM date_route_usage WHERE kind='art'") == [(4,)]
    make_plan()
    monkeypatch.setenv("EPHEMERA_ART_DAILY_MAX", "4")                       # 今天已经开画 4 次
    assert run(NOW0 + timedelta(minutes=9), Gen()) is None


def test_his_itinerary_shows_art_state():
    pid, (s1, _s2) = make_plan()
    snap = lambda: dp.snapshot(pid, now=NOW0)  # noqa: E731
    assert "  画：排队中" in dt.render_detail(snap(), NOW0)
    run(NOW0 + timedelta(minutes=5), Gen())
    assert "  画：已画好（她看到这一站的地点时，固定画会换成它）" in dt.render_detail(snap(), NOW0)


def test_edit_during_draw_is_superseded_and_never_overwrites():
    pid, (s1, _s2) = make_plan()
    g = Gen(during=lambda: ok(dp.edit(pid, "update_stop", {"stop_id": s1, "title": "改名了"},
                                      now=NOW0 + timedelta(minutes=5))))
    r = run(NOW0 + timedelta(minutes=5), g)
    assert r["status"] == "superseded"
    assert raw("SELECT status FROM date_art WHERE stop_id=?", (s1,)) == [("pending",)]
    assert not [f for f in os.listdir(dp.art_dir()) if f.endswith(("_ink.png", "_inv.png"))]


def test_generator_returning_nothing_counts_as_failure():
    pid, (s1, _s2) = make_plan()

    class Empty:
        async def generate(self, job):
            return b"", b""
    r = run(NOW0 + timedelta(minutes=5), Empty())
    assert r["status"] == "pending" and "no image" in r["error"]


def test_stale_running_capped_and_dead_plans_voided_and_hint_removal():
    pid, (s1, s2) = make_plan()
    c = sqlite3.connect(config.db_path())
    c.execute("UPDATE date_art SET status='running', attempts=2, started_at=? WHERE stop_id=?",
              ((NOW0 - timedelta(hours=1)).timestamp(), s1))
    c.commit()
    c.close()
    run(NOW0 + timedelta(minutes=5), Gen())
    assert raw("SELECT status FROM date_art WHERE stop_id=?", (s1,)) == [("failed",)]   # 次数用完不再收回
    ok(dp.edit(pid, "cancel", {"reason": "下雨"}, now=NOW0))
    run(NOW0 + timedelta(minutes=6), Gen())
    assert set(r[0] for r in raw("SELECT status FROM date_art")) <= {"failed", "done"}
    pid2, (a1, _a2) = make_plan(send=False, hint="灯")
    assert raw("SELECT COUNT(*) FROM date_art WHERE plan_id=?", (pid2,)) == [(1,)]
    ok(dp.edit(pid2, "update_stop", {"stop_id": a1, "art_hint": None}, now=NOW0))
    assert raw("SELECT COUNT(*) FROM date_art WHERE plan_id=?", (pid2,)) == [(0,)]


def test_subject_daypart_and_sig_follows_time_bucket():
    assert date_art.build_subject("cafe", "喫茶", "窗边的灯", "15:00") == \
        "a small cafe: 喫茶. 窗边的灯. daytime, clear sky."
    assert date_art.build_subject("train", "梧桐站", None, "17:30").endswith("at dusk.")
    assert date_art.build_subject("cinema", "小影院", None, "21:00").endswith("at night.")
    assert date_art.build_subject("cinema", "小影院", None, "04:59").endswith("at night.")
    assert date_art.build_subject("walk", "河边", None, None) == "a quiet street for a walk: 河边."
    pid, (s1, _s2) = make_plan()                                             # 第 1 站 19:00 = 夜
    sig = raw("SELECT sig FROM date_art WHERE stop_id=?", (s1,))[0][0]
    ok(dp.edit(pid, "update_stop", {"stop_id": s1, "time": "19:10", "reveal_at": "17:30"}, now=NOW0))
    assert raw("SELECT sig FROM date_art WHERE stop_id=?", (s1,))[0][0] == sig    # 还是夜里:不重画
    ok(dp.edit(pid, "update_stop", {"stop_id": s1, "time": "18:40", "reveal_at": "17:30"}, now=NOW0))
    assert raw("SELECT sig FROM date_art WHERE stop_id=?", (s1,))[0][0] != sig    # 改到傍晚:重画
