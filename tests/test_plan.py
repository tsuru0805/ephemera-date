"""Engine data layer: phases, time, checks, the her-side projection, shift, legs, public legs, read API, migration.

All tmp databases (conftest), fake clock (explicit now / REST patches plan._now), no network.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta

import pytest
from conftest import AI_TOKEN, H

from ephemera_date import config
from ephemera_date import plan as dp
from conftest import TZ



def T(m, d, h=12, mi=0, y=2026):
    return datetime(y, m, d, h, mi, tzinfo=TZ)


NOW0 = T(10, 20, 10, 0)          # 写约会那天
DAY = "2026-10-28"               # 约会日


@pytest.fixture(autouse=True)
def _db_in_tmp(tmp_path):
    p = config.db_path()
    assert str(tmp_path) in p, "测试库必须在 tmp(隔离失效时直接停)"
    yield p


def ok(r):
    assert r["ok"], r["errors"]
    return r


def fail(r, code=None):
    assert not r["ok"], r
    if code:
        assert code in [e["code"] for e in r["errors"]], r["errors"]
    return r


def texts(r):
    return [e["text"] for e in r["errors"]]


def snap(pid, now):
    return dp.snapshot(pid, now=now)


def stop_ids(pid, now=NOW0):
    return [s["id"] for s in snap(pid, now)["state"]["stops"]]


def events(pid, now):
    return [(e["kind"], e["text"]) for e in snap(pid, now)["events"]]


def raw(sql, args=()):
    c = sqlite3.connect(config.db_path())
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def make_plan(now=NOW0, day=DAY, send=True, *, stop3_reveal=None, leg2=True):
    """标准三站:集合 19:00(公开 17:30)→ 晚餐 19:30 待到 20:45 → 电影 21:00。
    路段:到第 2 站步行 6 分钟 19:20 出发;到第 3 站电车 20:52→20:58 要提前买票。"""
    pid = ok(dp.open_plan("The Evening\nScreening", day, "rose", now=now))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="青石区梧桐路3",
                                        clue="从改札出来，右手边", reveal_at="17:30",
                                        note="我会比你早到，不用跑。"), now=now))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="19:30", stay_until="20:45",
                                        title="Le Petit Pot", address="青石区柳岸1", clue="河边的小门",
                                        note="点你上次说想吃的", lat=35.6441, lng=139.6987,
                                        walk_path=[[35.644, 139.698], [35.645, 139.699]]), now=now))
    ok(dp.edit(pid, "add_stop", dict(kind="cinema", time="21:00", title="小影院", address="南湖区2",
                                        clue="红色的门", reveal_at=stop3_reveal, note="散场后等我"), now=now))
    s1, s2, s3 = stop_ids(pid, now)
    if leg2:
        ok(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="walk", minutes=6, depart_time="19:20",
                                           summary="出站右转沿河往南"), now=now))
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="train", minutes=6, depart_time="20:52",
                                       arrive_time="20:58", needs_ticket=True, ticket_note="交通卡留够",
                                       summary="环线往河西",
                                       official_url="https://example.com/route?secret=1"), now=now))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "一把伞"}]), now=now))
    ok(dp.edit(pid, "set_contract", dict(items=["不许看手机"]), now=now))
    ok(dp.edit(pid, "set_card", dict(text="电影票其实是两张"), now=now))
    if send:
        ok(dp.send(pid, now=now))
    return pid, (s1, s2, s3)


# ── 迁移 ─────────────────────────────────────────────────────────────────────────
def test_migration_idempotent_and_backfills_columns(tmp_path):
    p = str(tmp_path / "old.db")
    c = sqlite3.connect(p)
    c.execute("CREATE TABLE date_plans (id INTEGER PRIMARY KEY AUTOINCREMENT,"
              " title_en TEXT NOT NULL, date TEXT NOT NULL, color TEXT NOT NULL,"
              " status TEXT NOT NULL DEFAULT 'draft')")
    c.execute("INSERT INTO date_plans (title_en, date, color) VALUES ('A','2026-10-28','rose')")
    c.commit()
    dp.ensure_schema(c)
    dp.ensure_schema(c)          # 第二遍无副作用
    c.commit()
    cols = {r[1] for r in c.execute("PRAGMA table_info(date_plans)")}
    assert {"quote", "version", "paper_no", "cancel_reason"} <= cols
    assert c.execute("SELECT version, title_en FROM date_plans").fetchone() == (1, "A")
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"date_plans", "date_stops", "date_legs", "date_prep", "date_reveals", "date_events"} <= tables
    c.close()


# ── 阶段 ─────────────────────────────────────────────────────────────────────────
def test_send_then_auto_live_at_midnight_and_draft_never_live():
    pid, _ = make_plan()
    assert events(pid, NOW0) == [("envelope", "你收到一封信")]
    assert raw("SELECT paper_no, status FROM date_plans WHERE id=?", (pid,)) == [("1028", "sent")]
    assert dp.her_plan(pid, now=T(10, 27, 23, 59))["status"] == "sent"
    assert dp.her_plan(pid, now=T(10, 28, 0, 0))["status"] == "live"
    assert raw("SELECT status FROM date_plans WHERE id=?", (pid,)) == [("live",)]   # 读口结算同步
    # 构思中的到日也不进 live,对她不存在
    p2, _ = make_plan(send=False)
    assert snap(p2, T(10, 28, 20))["phase"] == "draft"
    assert dp.her_plan(p2, now=T(10, 28, 20)) is None
    assert snap(p2, T(10, 29, 1))["phase"] == "draft_expired"


def test_illegal_transitions_rejected():
    pid, _ = make_plan(send=False)
    fail(dp.close(pid, "q", now=NOW0), "phase")                         # draft→done
    fail(dp.edit(pid, "cancel", {"reason": "x"}, now=NOW0), "phase")      # draft 取消
    ok(dp.send(pid, now=NOW0))
    fail(dp.send(pid, now=NOW0), "phase")
    fail(dp.close(pid, "q", now=NOW0), "phase")                         # sent→done
    fail(dp.edit(pid, "delete_plan", now=NOW0), "phase")
    fail(dp.live(pid, "shift", {"from_stop": stop_ids(pid)[1], "minutes": 10}, now=NOW0), "phase")
    # live 改日期只能到明天以后
    fail(dp.edit(pid, "set_basic", {"date": DAY}, now=T(10, 28, 9)), "live_date")
    fail(dp.edit(pid, "set_basic", {"date": "2026-10-27"}, now=T(10, 28, 9)), "live_date")
    ok(dp.edit(pid, "cancel", {"reason": "下雨了"}, now=T(10, 28, 9)))
    for r in (dp.edit(pid, "set_card", {"text": "x"}, now=T(10, 28, 10)),
              dp.live(pid, "telegram", {"text": "x"}, now=T(10, 28, 10)),
              dp.close(pid, "q", now=T(10, 28, 10))):
        fail(r, "phase")
    p2, _ = make_plan()
    ok(dp.close(p2, "今天很好", now=T(10, 28, 23)))
    # 结束后只能补写还没写的;小卡已写=拒(late_written),其余写入照旧被阶段拒
    fail(dp.edit(p2, "set_card", {"text": "x"}, now=T(10, 28, 23, 30)), "late_written")
    fail(dp.edit(p2, "set_prep", {"items": []}, now=T(10, 28, 23, 30)), "phase")


def test_live_date_change_back_to_sent_keeps_reveals():
    pid, (s1, s2, s3) = make_plan()
    t = T(10, 28, 18)                                # 第 1 站 17:30 已公开
    assert dp.her_plan(pid, now=t)["stops"][0]["place"]["title"] == "梧桐站"
    r = ok(dp.edit(pid, "set_basic", {"date": "2026-10-30"}, now=t))
    assert snap(pid, t)["phase"] == "sent"
    view = dp.her_plan(pid, now=t)
    assert view["status"] == "sent" and view["stops"][0]["place"]["title"] == "梧桐站"
    assert view["stops"][1]["place"] is None
    assert ("telegram_auto", "日期改了：10/28 → 10/30") in events(pid, t)
    assert r["version"] == snap(pid, t)["state"]["plan"]["version"]


def test_quota_three_and_expired_revive_and_concurrency():
    a = ok(dp.open_plan("A", "2026-10-21", "rose", now=NOW0))["plan_id"]
    ok(dp.open_plan("B", DAY, "sky", now=NOW0))
    later = T(10, 22, 10)                            # A 过期 → 不占名额
    assert snap(a, later)["phase"] == "draft_expired"
    ok(dp.open_plan("C", DAY, "cream", now=later))
    ok(dp.open_plan("D", DAY, "berry", now=later))
    r = fail(dp.open_plan("E", DAY, "rose", now=later), "quota")
    assert texts(r) == ["同时进行中的约会最多 3 个，已经满了"]
    fail(dp.edit(a, "set_basic", {"date": "2026-11-01"}, now=later), "quota")   # 复活过名额
    assert raw("SELECT date FROM date_plans WHERE id=?", (a,)) == [("2026-10-21",)]


def test_quota_concurrent_two_opens_only_one_wins():
    ok(dp.open_plan("A", DAY, "rose", now=NOW0))
    ok(dp.open_plan("B", DAY, "rose", now=NOW0))
    res = []
    barrier = threading.Barrier(2)

    def go(name):
        barrier.wait()
        res.append(dp.open_plan(name, DAY, "rose", now=NOW0))

    th = [threading.Thread(target=go, args=(n,)) for n in ("C", "D")]
    [x.start() for x in th]
    [x.join() for x in th]
    assert sorted(r["ok"] for r in res) == [False, True]
    assert raw("SELECT COUNT(*) FROM date_plans")[0][0] == 3


def test_version_and_atomic():
    pid, (s1, s2, s3) = make_plan(send=False)
    v = snap(pid, NOW0)["state"]["plan"]["version"]
    fail(dp.edit(pid, "set_card", {"text": "x"}, expect_version=v - 1, now=NOW0), "version")
    ok(dp.edit(pid, "set_card", {"text": "新的"}, expect_version=v, next_note="订第三站的票", now=NOW0))
    st = snap(pid, NOW0)["state"]["plan"]
    assert (st["version"], st["card_text"], st["next_note"]) == (v + 1, "新的", "订第三站的票")
    # 失败整笔不生效:两站时间冲突的 add_stop 被拒,站数与版本不变
    fail(dp.edit(pid, "add_stop", dict(kind="walk", time="20:30", position=3), now=NOW0),
         "stay_overlap")
    assert len(stop_ids(pid)) == 3 and snap(pid, NOW0)["state"]["plan"]["version"] == v + 1
    fail(dp.edit(999, "set_card", {"text": "x"}, now=NOW0), "no_plan")


def test_delete_plan_cascades_and_paper_no_suffix():
    p1, _ = make_plan()
    p2, _ = make_plan()
    assert raw("SELECT paper_no FROM date_plans ORDER BY id") == [("1028",), ("1028-2",)]
    p3, _ = make_plan(send=False)
    ok(dp.edit(p3, "delete_plan", now=NOW0))
    for t in ("date_plans", "date_stops", "date_legs", "date_prep"):
        assert raw(f"SELECT COUNT(*) FROM {t} WHERE {'id' if t == 'date_plans' else 'plan_id'}=?",
                   (p3,))[0][0] == 0


# ── 时间 ─────────────────────────────────────────────────────────────────────────
def _plan_times(times, now=NOW0, day=DAY):
    pid = ok(dp.open_plan("Night", day, "sky", now=now))["plan_id"]
    out = []
    for t in times:
        out.append(dp.edit(pid, "add_stop", dict(kind="walk", time=t), now=now))
    return pid, out


def test_overnight_conversion_and_boundaries():
    pid, rs = _plan_times(["23:00", "00:30", "01:30"])
    assert all(r["ok"] for r in rs)
    s = snap(pid, NOW0)
    abs_ = [s["timeline"]["abs"][i] for i in stop_ids(pid)]
    assert abs_ == [T(10, 28, 23), T(10, 29, 0, 30), T(10, 29, 1, 30)]
    p2, _ = _plan_times(["23:59", "00:01"])
    a2 = snap(p2, NOW0)["timeline"]["abs"]
    assert [a2[i] for i in stop_ids(p2)] == [T(10, 28, 23, 59), T(10, 29, 0, 1)]


def test_two_midnights_and_24h_rejected():
    _, rs = _plan_times(["22:00", "01:00", "00:30"])
    assert texts(fail(rs[2], "two_midnights")) == ["行程最多跨一次午夜，第 3 站又过了一次午夜"]
    _, rs = _plan_times(["19:00", "18:00", "19:30"])
    fail(rs[2], "span_24h")


def test_reveal_at_cross_day_and_default_three_levels():
    pid, _ = _plan_times(["23:00", "00:30", "01:30", "02:30"])
    a, b, c, d = stop_ids(pid)
    ok(dp.edit(pid, "update_stop", dict(stop_id=b, reveal_at="23:45"), now=NOW0))
    ok(dp.edit(pid, "set_leg", dict(to_stop=c, mode="walk", depart_time="01:10"), now=NOW0))
    ok(dp.edit(pid, "set_leg", dict(to_stop=d, mode="taxi", minutes=20), now=NOW0))
    s = snap(pid, NOW0)
    st, abs_ = s["state"], s["timeline"]["abs"]
    rt = {x["id"]: dp.reveal_time(st, x, abs_) for x in st["stops"]}
    assert rt[b] == T(10, 28, 23, 45)            # 显式,跨日换到前一天
    assert rt[c] == T(10, 29, 1, 10)             # 默认①路段出发
    assert rt[d] == T(10, 29, 2, 10)             # 默认②到达 − minutes
    assert rt[a] == T(10, 28, 23)                # 默认③到达


# ── 校验 ─────────────────────────────────────────────────────────────────────────
def test_send_lists_every_missing_item():
    pid = ok(dp.open_plan("A", DAY, "rose", now=NOW0))["plan_id"]
    r = fail(dp.send(pid, now=NOW0))
    assert texts(r) == ["还没有站", "准备清单是空的"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站"), now=NOW0))
    r = fail(dp.send(pid, now=NOW0))
    assert texts(r) == ["第 1 站没写地址", "第 1 站没写线索", "第 1 站没写地点公开时间", "准备清单是空的"]
    miss = snap(pid, NOW0)["check"]["missing"]       # 缺项清单与寄出同一个函数
    assert [m["short"] for m in miss] == ["第 1 站的地址", "第 1 站的线索", "第 1 站的地点公开时间", "准备清单"]
    ok(dp.edit(pid, "update_stop", dict(stop_id=stop_ids(pid)[0], address="x", clue="y",
                                           reveal_at="19:00"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "wear", "text": "外套"}]), now=NOW0))
    r = fail(dp.send(pid, now=NOW0))
    assert texts(r) == ["第 1 站的地点公开时间要早于到达时间 19:00"]


def test_after_send_destructive_edits_rejected_and_data_unchanged():
    pid, (s1, s2, s3) = make_plan()
    before = snap(pid, NOW0)["state"]
    fail(dp.edit(pid, "update_stop", dict(stop_id=s1, address=None), now=NOW0), "stop_address")
    # 寄出后断掉的路段由系统撤掉、不再拦(原 stale_leg);这两笔仍被拒,只因新的第 1 站没写地点公开时间
    fail(dp.edit(pid, "move_stop", dict(stop_id=s3, to=1), now=NOW0), "first_reveal")
    fail(dp.edit(pid, "remove_stop", dict(stop_id=s1), now=NOW0), "first_reveal")
    t = T(10, 28, 19, 25)                            # 第 2 站 19:20 已公开
    fail(dp.edit(pid, "remove_stop", dict(stop_id=s2), now=t), "public_stop")
    after = snap(pid, NOW0)["state"]
    assert after["stops"] == before["stops"] and after["plan"]["version"] == before["plan"]["version"]


def test_one_stop_plan_cannot_drop_to_zero():
    pid = ok(dp.open_plan("A", DAY, "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="t", address="a", clue="c",
                                        reveal_at="18:00"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "wear", "text": "外套"}]), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    fail(dp.edit(pid, "remove_stop", dict(stop_id=stop_ids(pid)[0]), now=NOW0))
    assert len(stop_ids(pid)) == 1


# ── 公开投影 ─────────────────────────────────────────────────────────────────────
def test_projection_by_phase_and_field():
    pid, (s1, s2, s3) = make_plan()
    v = dp.her_plan(pid, now=NOW0)                    # sent,还没到公开时刻
    assert [x["time"] for x in v["stops"]] == ["19:00", "19:30", "21:00"]
    assert [x["kind"] for x in v["stops"]] == ["train", "dinner", "cinema"]
    assert [x["clue"] for x in v["stops"]] == ["从改札出来，右手边", "河边的小门", "红色的门"]
    assert all(x["place"] is None and x["note"] is None for x in v["stops"])
    assert v["contract"] is None and v["card"] is None and v["quote"] is None
    assert "next_note" not in v and "version" not in v
    assert {"section": "book", "text": "有一段路要提前准备车票", "detail": None,
            "derived": True} in [{k: x for k, x in i.items() if k != "key"} for i in v["prep"]]
    body = str(v)
    for secret in ("梧桐站", "Le Petit Pot", "小影院", "青石区", "我会比你早到", "不许看手机",
                   "两张", "环线", "交通卡留够", "散场后等我", "example.com/route", "35.64", "139.69"):
        assert secret not in body
    v = dp.her_plan(pid, now=T(10, 28, 17, 30))       # 第 1 站到公开时刻
    assert v["stops"][0]["place"]["title"] == "梧桐站" and v["stops"][0]["note"] is None
    assert v["stops"][1]["place"] is None
    v = dp.her_plan(pid, now=T(10, 28, 19, 20))       # 第 2 站默认=路段出发 19:20
    assert v["stops"][0]["note"] == "我会比你早到，不用跑。"
    assert v["stops"][1]["place"]["leg"]["summary"] == "出站右转沿河往南"
    assert v["stops"][1]["note"] is None
    v = dp.her_plan(pid, now=T(10, 28, 20, 52))
    assert v["stops"][2]["place"]["leg"]["needs_ticket"] is True
    assert {"section": "book", "text": "去第 3 站的车票", "detail": "交通卡留够", "derived": True,
            "to_stop": 3} in [{k: x for k, x in i.items() if k != "key"} for i in v["prep"]]
    ok(dp.close(pid, "今天很好", now=T(10, 28, 23)))
    v = dp.her_plan(pid, now=T(10, 28, 23))
    assert v["status"] == "done" and v["contract"] == ["不许看手机"] and v["quote"] == "今天很好"
    assert v["card"] == "电影票其实是两张" and all(x["note"] for x in v["stops"])
    assert v["stops"][1]["place"]["walk_path"] and v["stops"][1]["place"]["lat"] == 35.6441
    assert v["stops"][2]["place"]["leg"]["official_url"].startswith("https://")


def test_reveal_settled_before_edit_cannot_be_pulled_back():
    pid, (s1, s2, s3) = make_plan()
    t = T(10, 28, 17, 31)                             # 17:30 到点,中间没人读过
    assert raw("SELECT COUNT(*) FROM date_reveals WHERE plan_id=?", (pid,))[0][0] == 0
    ok(dp.edit(pid, "update_stop", dict(stop_id=s1, reveal_at="18:30"), now=t))
    assert dp.her_plan(pid, now=t)["stops"][0]["place"]["title"] == "梧桐站"


def test_open_stop_early_and_cancel_freezes():
    pid, (s1, s2, s3) = make_plan()
    ok(dp.live(pid, "open_stop", {"stop_id": s3}, now=NOW0))        # sent 提前开:地点可见,话不可见
    v = dp.her_plan(pid, now=NOW0)
    assert v["stops"][2]["place"]["title"] == "小影院" and v["stops"][2]["note"] is None
    v = dp.her_plan(pid, now=T(10, 27, 23, 59))
    assert v["stops"][2]["note"] is None                                      # sent:话还不可见
    v = dp.her_plan(pid, now=T(10, 28, 0, 1))
    assert v["stops"][2]["note"] == "散场后等我"                              # live:提前开的站话可见
    ok(dp.edit(pid, "cancel", {"reason": "下雨了"}, now=T(10, 28, 18)))
    v = dp.her_plan(pid, now=T(10, 28, 22))           # 取消后冻结,19:20 不再自动公开第 2 站
    assert v["status"] == "cancelled"
    assert v["stops"][0]["place"] is not None and v["stops"][1]["place"] is None
    assert v["contract"] is None and v["card"] is None
    assert ("cancel", "约会取消了。他写：下雨了") in events(pid, T(10, 28, 22))
    assert dp.her_plans(now=T(10, 28, 22)) == []      # 书架不出现
    assert [e["kind"] for e in dp.her_events(now=T(10, 28, 22))] == ["envelope", "cancel"]


def test_open_stop_on_day_reveals_note():
    pid, (s1, s2, s3) = make_plan()
    ok(dp.live(pid, "open_stop", {"stop_id": s2}, now=T(10, 28, 18)))
    v = dp.her_plan(pid, now=T(10, 28, 18))
    assert v["stops"][1]["note"] == "点你上次说想吃的"
    fail(dp.live(pid, "open_stop", {"stop_id": s2}, now=T(10, 28, 18, 5)), "already_open")


def test_auto_telegram_by_field_and_text_has_no_hidden_fields():
    pid, (s1, s2, s3) = make_plan()
    n0 = len(events(pid, NOW0))
    ok(dp.edit(pid, "update_stop", dict(stop_id=s3, address="北岸区9"), now=NOW0))     # 隐藏字段:静默
    ok(dp.edit(pid, "update_stop", dict(stop_id=s3, title="新小影院"), now=NOW0))
    assert len(events(pid, NOW0)) == n0
    ok(dp.edit(pid, "update_stop", dict(stop_id=s3, time="21:30"), now=NOW0))
    ok(dp.edit(pid, "update_stop", dict(stop_id=s1, time="19:15", reveal_at="17:45"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "一把伞"},
                                               {"section": "bring", "text": "一件薄外套"}]), now=NOW0))
    ok(dp.edit(pid, "update_stop", dict(stop_id=s2, clue="新线索"), now=NOW0))
    ev = events(pid, NOW0)[n0:]
    assert ev == [("telegram_auto", "第 3 站时间改了：21:00 → 21:30"),
                  ("telegram_auto", "集合时间改了：19:00 → 19:15"),
                  ("telegram_auto", "准备清单更新了：带什么 加了「一件薄外套」"),
                  ("telegram_auto", "第 2 站的线索改了")]
    for _, t in ev:
        for secret in ("北岸区", "小影院", "新线索", "17:45"):
            assert secret not in t
    # 公开后的路段改动:写明前后交通方式
    t = T(10, 28, 19, 25)
    ok(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="taxi", minutes=5, depart_time="19:22"), now=t))
    assert events(pid, t)[-1] == ("telegram_auto", "怎么去第 2 站改了：步行约 6 分钟 → 坐出租车约 5 分钟")


def test_event_text_frozen_and_ref_title_after_reveal():
    pid, (s1, s2, s3) = make_plan()
    ok(dp.edit(pid, "update_stop", dict(stop_id=s3, time="21:30"), now=NOW0))
    ev = [e for e in dp.her_events(pid, now=NOW0) if e["kind"] == "telegram_auto"][0]
    assert ev["ref_stop"] == {"n": 3}                  # 还没公开:只给站号
    ok(dp.edit(pid, "update_stop", dict(stop_id=s3, time="21:40"), now=NOW0))
    ev2 = [e for e in dp.her_events(pid, now=T(10, 28, 21)) if e["kind"] == "telegram_auto"]
    assert ev2[0]["text"] == "第 3 站时间改了：21:00 → 21:30"     # 落库即冻结
    assert ev2[0]["ref_stop"] == {"n": 3, "title": "小影院"}       # 揭晓后补上站名


# ── 顺延 ─────────────────────────────────────────────────────────────────────────
def test_shift_later_moves_following_stops_legs_and_hidden_reveals():
    pid, (s1, s2, s3) = make_plan(stop3_reveal="20:30")
    t = T(10, 28, 18)
    ok(dp.live(pid, "shift", {"from_stop": s2, "minutes": 30}, now=t))
    st = snap(pid, t)["state"]
    s = {x["id"]: x for x in st["stops"]}
    lg = {x["to_stop_id"]: x for x in st["legs"]}
    assert (s[s1]["time"], s[s1]["reveal_at"]) == ("19:00", "17:30")
    assert (s[s2]["time"], s[s2]["stay_until"]) == ("20:00", "21:15")
    assert (s[s3]["time"], s[s3]["reveal_at"]) == ("21:30", "21:00")
    assert lg[s2]["depart_time"] == "19:50"
    assert (lg[s3]["depart_time"], lg[s3]["arrive_time"]) == ("21:22", "21:28")
    assert events(pid, t)[-1] == ("telegram_auto", "后面的行程顺延 30 分钟（第 2 站起）")


def test_shift_keeps_revealed_and_not_rejected_by_reveal_rule():
    pid, (s1, s2, s3) = make_plan()
    t = T(10, 28, 18)                                  # 第 1 站已公开(17:30)
    ok(dp.live(pid, "shift", {"from_stop": s1, "minutes": 20}, now=t))
    st = snap(pid, t)["state"]
    assert st["stops"][0]["time"] == "19:20" and st["stops"][0]["reveal_at"] == "17:30"
    assert dp.her_plan(pid, now=t)["stops"][0]["place"] is not None


def test_shift_earlier_text_and_order_reject():
    pid, (s1, s2, s3) = make_plan()
    t = T(10, 28, 12)
    ok(dp.live(pid, "shift", {"from_stop": s2, "minutes": -15}, now=t))
    assert events(pid, t)[-1] == ("telegram_auto", "后面的行程提前 15 分钟（第 2 站起）")
    r = fail(dp.live(pid, "shift", {"from_stop": s2, "minutes": -45}, now=t), "shift_order")
    assert texts(r) == ["提前以后第 2 站会早于第 1 站的到达"]
    fail(dp.live(pid, "shift", {"from_stop": s2, "minutes": 241}, now=t), "bad_minutes")


def _live_plan(times, day=DAY):
    pid = ok(dp.open_plan("Night", day, "sky", now=NOW0))["plan_id"]
    for i, t in enumerate(times):
        ok(dp.edit(pid, "add_stop", dict(kind="walk", time=t, title=f"t{i}", address="a", clue="c",
                                            reveal_at=None if i else "00:00"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "wear", "text": "外套"}]), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    return pid, stop_ids(pid)


def test_shift_first_stop_past_midnight_rejected_and_nonfirst_crosses():
    pid, (a,) = _live_plan(["23:30"])
    r = fail(dp.live(pid, "shift", {"from_stop": a, "minutes": 60}, now=T(10, 28, 12)), "shift_first")
    assert texts(r) == ["第 1 站会被挪到别的日子，这种情况请用 set_basic 改日期"]
    p2, (x, y) = _live_plan(["22:00", "23:40"])
    ok(dp.live(p2, "shift", {"from_stop": y, "minutes": 40}, now=T(10, 28, 12)))
    s = snap(p2, T(10, 28, 12))
    assert s["timeline"]["abs"][y] == T(10, 29, 0, 20)


def test_shift_write_back_mismatch_rejected():
    pid, (a, b) = _live_plan(["01:00", "23:00"])
    fail(dp.live(pid, "shift", {"from_stop": b, "minutes": 240}, now=T(10, 28, 0, 30)),
         "shift_mismatch")
    assert snap(pid, T(10, 28, 0, 30))["state"]["stops"][1]["time"] == "23:00"


# ── 路段 ─────────────────────────────────────────────────────────────────────────
def test_leg_time_rules():
    pid, (s1, s2, s3) = make_plan(send=False)
    r = fail(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="walk", depart_time="18:50"), now=NOW0),
             "leg_before_prev")
    assert texts(r) == ["通往第 2 站的路段出发时间 18:50 早于第 1 站到达 19:00"]
    r = fail(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="train", depart_time="20:40"), now=NOW0))
    assert texts(r) == ["通往第 3 站的路段出发时间 20:40 早于第 2 站待到 20:45"]
    # 第 0 段跨日:第 1 站 00:30,前一天 23:50 出发合法
    p2, (a,) = _live_plan(["00:30"])
    ok(dp.edit(p2, "update_stop", dict(stop_id=a, reveal_at="23:30"), now=NOW0))
    ok(dp.edit(p2, "set_leg", dict(to_stop=a, mode="train", depart_time="23:50"), now=NOW0))
    six = [{"line": f"L{i}"} for i in range(6)]
    fail(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="train", steps=six), now=NOW0), "transfers")
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="train", steps=six[:5]), now=NOW0))
    assert len(stop_ids(pid)) == 3                     # 换乘站不成站


def test_reveal_later_than_departure_rejected_with_exact_text():
    pid, (s1, s2, s3) = make_plan(send=False)
    r = fail(dp.edit(pid, "update_stop", dict(stop_id=s3, reveal_at="21:00"), now=NOW0), "reveal_late")
    assert texts(r) == ["第 3 站的地点公开时间 21:00 晚于出发时间 20:52"]


def test_draft_structure_change_makes_leg_stale_and_blocks_send():
    pid, (s1, s2, s3) = make_plan(send=False)
    ok(dp.edit(pid, "remove_stop", dict(stop_id=s2), now=NOW0))
    s = snap(pid, NOW0)
    assert [m["text"] for m in s["check"]["missing"]] == ["第 2 站的路段起点变了，要重写"]
    v = s["her_view"]
    assert v is None
    r = fail(dp.send(pid, now=NOW0))
    assert texts(r) == ["第 2 站的路段起点变了，要重写"]
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="taxi", minutes=10), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    assert dp.prep_items(snap(pid, NOW0)["state"], None)[-1]["section"] == "bring"   # 不再要票:派生条消失


def test_stale_leg_excluded_from_derived_prep():
    pid, (s1, s2, s3) = make_plan(send=False)
    ok(dp.edit(pid, "remove_stop", dict(stop_id=s2), now=NOW0))
    items = dp.prep_items(snap(pid, NOW0)["state"], None)
    assert not any(i["derived"] for i in items)


def test_public_leg_no_longer_blocks_after_send():
    """寄出后删站/删路段/挪站不再因「路线她已经看到了」被拒,断掉的路段系统撤掉。"""
    pid, (s1, s2, s3) = make_plan(stop3_reveal="17:00", leg2=False)
    t = T(10, 28, 18)                                  # 第 3 站已公开,第 2 站(默认=到达 19:30)未公开
    ok(dp.edit(pid, "remove_leg", dict(to_stop=s3), now=t))          # 她看到过的路段也能删
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="taxi", minutes=8), now=t))
    ok(dp.edit(pid, "remove_stop", dict(stop_id=s2), now=t))          # 删站:通往第 3 站的那段断了,系统撤掉
    assert all(lg["to_stop_id"] in stop_ids(pid) for lg in snap(pid, t)["state"]["legs"])


def test_sent_remove_stop_drops_broken_leg():
    pid, (s1, s2, s3) = make_plan()
    ok(dp.edit(pid, "remove_stop", dict(stop_id=s2), now=NOW0))
    assert all(lg["to_stop_id"] != s3 for lg in snap(pid, NOW0)["state"]["legs"])   # 以第 2 站为起点的那段撤掉
    assert events(pid, NOW0)[-1][0] == "telegram_auto" and "少了一站：原来的第 2 站（19:30）" in events(pid, NOW0)[-1][1]


def test_add_stop_in_sent_telegram():
    pid, (s1, s2, s3) = make_plan()
    ok(dp.edit(pid, "add_stop", dict(kind="walk", time="23:00", title="河边", address="a", clue="c"),
               now=NOW0))
    assert events(pid, NOW0)[-1] == ("telegram_auto", "加了一站：第 4 站 23:00")


# ── 她的读口 ─────────────────────────────────────────────────────────────────────
def test_rest_auth_only_her_token(api):
    pid, _ = make_plan()
    for path in ("/api/dates", f"/api/dates/{pid}", "/api/dates/events"):
        assert api.get(path, headers=H()).status_code == 200
        for bad in ({}, H(AI_TOKEN), H("nope"), {"Authorization": "her-token"}):
            assert api.get(path, headers=bad).status_code == 401
        assert api.get(path + ("&" if "?" in path else "?") + "key=her-token").status_code == 401   # 凭据不走 URL
    assert api.post("/api/dates/events/read", json={"ids": [1]}, headers=H(AI_TOKEN)).status_code == 401


def test_rest_list_one_events_read(api):
    p1, (s1, s2, s3) = make_plan()
    p2, _ = make_plan(send=False)
    h = H()
    plans = api.get("/api/dates", headers=h).json()["plans"]
    assert [p["id"] for p in plans] == [p1] and plans[0]["unread"] == 1
    assert api.get(f"/api/dates/{p2}", headers=h).status_code == 404      # 构思中=不存在
    assert api.get("/api/dates/9999", headers=h).status_code == 404
    one = api.get(f"/api/dates/{p1}", headers=h).json()
    assert one["stops"][0]["place"] is None
    api.clock["now"] = T(10, 28, 17, 40)
    one = api.get(f"/api/dates/{p1}", headers=h).json()
    assert one["status"] == "live" and one["stops"][0]["place"]["title"] == "梧桐站"
    evs = api.get("/api/dates/events", headers=h).json()["events"]
    assert [e["text"] for e in evs] == ["你收到一封信"] and evs[0]["read_at"] is None
    r = api.post("/api/dates/events/read", json={"ids": [evs[0]["id"]]}, headers=h).json()
    assert r == {"marked": 1}
    assert api.post("/api/dates/events/read", json={"ids": [evs[0]["id"]]}, headers=h).json() == {"marked": 0}
    assert api.get("/api/dates", headers=h).json()["plans"][0]["unread"] == 0
    assert api.get(f"/api/dates/events?plan={p2}", headers=h).json()["events"] == []


# ── 补测 ────────────────────────────────────────────────────────────────
def test_failed_edit_rolls_back_settlement_status_and_events():
    pid, (s1, s2, s3) = make_plan()
    t = T(10, 28, 17, 31)                             # 此刻结算会写公开记录+把 status 同步成 live
    n_ev = raw("SELECT COUNT(*) FROM date_events WHERE plan_id=?", (pid,))[0][0]
    fail(dp.edit(pid, "update_stop", dict(stop_id=s1, address=None), now=t), "stop_address")
    assert raw("SELECT COUNT(*) FROM date_reveals WHERE plan_id=?", (pid,))[0][0] == 0
    assert raw("SELECT status, version FROM date_plans WHERE id=?", (pid,))[0][0] == "sent"
    assert raw("SELECT COUNT(*) FROM date_events WHERE plan_id=?", (pid,))[0][0] == n_ev


def test_shift_earlier_revealed_stop_exempt_from_reveal_rules():
    pid, (s1, s2, s3) = make_plan()
    t = T(10, 28, 18)                                 # 第 1 站 17:30 已公开
    ok(dp.live(pid, "shift", {"from_stop": s1, "minutes": -120}, now=t))
    st = snap(pid, t)["state"]
    assert (st["stops"][0]["time"], st["stops"][0]["reveal_at"]) == ("17:00", "17:30")   # 已公开不挪
    assert [x["time"] for x in st["stops"]] == ["17:00", "17:30", "19:00"]


def test_leg0_lower_bound_24h_and_overnight_leg_absolute():
    pid, (s1, s2, s3) = make_plan()
    t = T(10, 28, 18)
    r = fail(dp.edit(pid, "set_leg", dict(to_stop=s1, mode="train", arrive_time="19:01",
                                            depart_time="19:02"), now=t), "leg0_24h")
    assert texts(r) == ["通往第 1 站的路段出发时间 19:02 早于集合前 24 小时"]
    p2, (a, b) = _live_plan(["23:30", "00:40"])
    ok(dp.edit(p2, "set_leg", dict(to_stop=b, mode="taxi", depart_time="23:55",
                                      arrive_time="00:30"), now=NOW0))
    s = snap(p2, NOW0)
    lg = next(x for x in s["state"]["legs"] if x["to_stop_id"] == b)
    assert dp.leg_times(lg, s["timeline"]["abs"]) == (T(10, 28, 23, 55), T(10, 29, 0, 30))


def test_shift_moves_step_times_too():
    pid, (s1, s2, s3) = make_plan()
    steps = [{"line": "环线", "board": "梧桐", "alight": "桥头", "depart": "20:52",
              "arrive": "20:58"}]
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="train", minutes=6, depart_time="20:52",
                                       arrive_time="20:58", steps=steps), now=NOW0))
    ok(dp.live(pid, "shift", {"from_stop": s2, "minutes": 30}, now=T(10, 28, 18)))
    lg = next(x for x in snap(pid, NOW0)["state"]["legs"] if x["to_stop_id"] == s3)
    assert (lg["depart_time"], lg["arrive_time"]) == ("21:22", "21:28")
    assert (lg["steps"][0]["depart"], lg["steps"][0]["arrive"]) == ("21:22", "21:28")


def test_draft_date_free_to_past_and_revive_needs_quota():
    pid = ok(dp.open_plan("A", DAY, "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "set_basic", {"date": "2026-10-01"}, now=NOW0))     # draft 随便改
    assert snap(pid, NOW0)["phase"] == "draft_expired"
    ok(dp.edit(pid, "set_basic", {"date": DAY}, now=NOW0))              # 复活(名额够)
    assert snap(pid, NOW0)["phase"] == "draft"


def test_derived_ticket_counts_as_prep_for_send():
    pid, (s1, s2, s3) = make_plan(send=False)
    ok(dp.edit(pid, "set_prep", dict(items=[]), now=NOW0))
    ok(dp.send(pid, now=NOW0))                     # 只有派生的「提前准备」也算准备清单有一类


def test_deleted_stop_event_keeps_history_ref():
    pid, (s1, s2, s3) = make_plan()
    ok(dp.edit(pid, "remove_leg", dict(to_stop=s3), now=NOW0))
    ok(dp.edit(pid, "remove_stop", dict(stop_id=s3), now=NOW0))
    ev = dp.her_events(pid, now=T(10, 28, 23))[-1]
    assert ev["text"] == "少了一站：原来的第 3 站（21:00）"
    assert ev["ref_stop"] == {"n": 3}                  # 站号留着;删掉的站名永不给


def test_draft_move_marks_stale_and_moving_back_keeps_stale():
    pid = ok(dp.open_plan("A", DAY, "rose", now=NOW0))["plan_id"]
    for k in ("train", "dinner", "cinema"):
        ok(dp.edit(pid, "add_stop", dict(kind=k), now=NOW0))
    a, b, c = stop_ids(pid)
    ok(dp.edit(pid, "set_leg", dict(to_stop=b, mode="walk"), now=NOW0))
    ok(dp.edit(pid, "set_leg", dict(to_stop=c, mode="walk"), now=NOW0))
    ok(dp.edit(pid, "move_stop", dict(stop_id=c, to=1), now=NOW0))
    assert stop_ids(pid) == [c, a, b]
    ok(dp.edit(pid, "move_stop", dict(stop_id=c, to=3), now=NOW0))
    assert stop_ids(pid) == [a, b, c]
    legs = snap(pid, NOW0)["state"]["legs"]
    assert {x["to_stop_id"]: x["stale"] for x in legs} == {b: 0, c: 1}   # 失效是粘性的


def test_cancel_freezes_note_too():
    pid, (s1, s2, s3) = make_plan()
    ok(dp.edit(pid, "cancel", {"reason": "临时有事"}, now=T(10, 28, 19, 10)))
    v = dp.her_plan(pid, now=T(10, 28, 21))
    assert v["stops"][0]["note"] == "我会比你早到，不用跑。"        # 取消前已到站=已公开
    assert v["stops"][1]["note"] is None and v["stops"][1]["place"] is None


def test_delete_plan_cascade_all_tables():
    pid, _ = make_plan(send=False)
    ok(dp.edit(pid, "delete_plan", now=NOW0))
    for t in ("date_stops", "date_legs", "date_prep", "date_reveals", "date_events"):
        assert raw(f"SELECT COUNT(*) FROM {t} WHERE plan_id=?", (pid,))[0][0] == 0


# ── 更多边界 ───────────────────────────────────────────────────────────
def test_leg0_exactly_24h_allowed():
    pid, (s1, s2, s3) = make_plan(send=False)
    ok(dp.edit(pid, "update_stop", dict(stop_id=s1, reveal_at=None), now=NOW0))   # 显式公开必晚于 24h 前的出发
    ok(dp.edit(pid, "set_leg", dict(to_stop=s1, mode="train", depart_time="19:00",
                                       arrive_time="18:50"), now=NOW0))   # 前一天 19:00 = 恰好 24h
    lg = next(x for x in snap(pid, NOW0)["state"]["legs"] if x["to_stop_id"] == s1)
    assert dp.leg_times(lg, snap(pid, NOW0)["timeline"]["abs"])[0] == T(10, 27, 19, 0)


def test_shift_overnight_partial_steps():
    pid, (a, b) = _live_plan(["23:00", "00:40"])
    steps = [{"line": "A", "depart": "23:50"}, {"line": "B", "arrive": "00:25"}]
    ok(dp.edit(pid, "set_leg", dict(to_stop=b, mode="train", depart_time="23:45",
                                       arrive_time="00:30", steps=steps), now=NOW0))
    ok(dp.live(pid, "shift", {"from_stop": b, "minutes": -20}, now=T(10, 28, 12)))
    lg = next(x for x in snap(pid, NOW0)["state"]["legs"] if x["to_stop_id"] == b)
    assert (lg["depart_time"], lg["arrive_time"]) == ("23:25", "00:10")
    assert lg["steps"] == [{"line": "A", "depart": "23:30"}, {"line": "B", "arrive": "00:05"}]


def test_expired_draft_quota_boundary_today_vs_past():
    a = ok(dp.open_plan("A", "2026-10-21", "rose", now=NOW0))["plan_id"]
    later = T(10, 22, 10)
    for n in ("B", "C", "D"):
        ok(dp.open_plan(n, DAY, "rose", now=later))
    fail(dp.edit(a, "set_basic", {"date": "2026-10-22"}, now=later), "quota")   # 改到今天=占名额
    ok(dp.edit(a, "set_basic", {"date": "2026-10-15"}, now=later))              # 过去之间随便改


# ── 死锁解法(结构改动同时重写路线)+ 集合站未公开可换(B)────────────────
def test_public_leg_deadlock_resolved_by_relinking_in_same_op():
    pid, (s1, s2, s3) = make_plan(stop3_reveal="17:00", leg2=False)
    t = T(10, 28, 18)
    n0 = len(events(pid, t))
    ok(dp.edit(pid, "remove_stop", dict(stop_id=s2, legs=[dict(to_stop=s3, mode="taxi", minutes=8,
                                                                  depart_time="20:40")]), now=t))
    lg = next(x for x in snap(pid, t)["state"]["legs"] if x["to_stop_id"] == s3)
    assert (lg["from_stop_id"], lg["stale"], lg["mode"]) == (s1, 0, "taxi")
    ev = events(pid, t)[n0:]
    assert len(ev) == 1 and ev[0][0] == "telegram_auto"          # 一笔一封
    assert "少了一站：原来的第 2 站（19:30）" in ev[0][1]
    assert "怎么去第 2 站改了：坐电车约 6 分钟 → 坐出租车约 8 分钟" in ev[0][1]
    assert dp.her_plan(pid, now=t)["stops"][1]["place"]["leg"]["mode"] == "taxi"


def test_relink_bad_payload_rolls_back():
    pid, (s1, s2, s3) = make_plan(stop3_reveal="17:00", leg2=False)
    t = T(10, 28, 18)
    v0 = raw("SELECT version FROM date_plans WHERE id=?", (pid,))[0][0]
    fail(dp.edit(pid, "remove_stop", dict(stop_id=s2, legs=[dict(to_stop=s3, mode="rocket")]), now=t),
         "bad_mode")
    fail(dp.edit(pid, "remove_stop", dict(stop_id=s2, legs=[dict(to_stop=s2, mode="walk")]), now=t),
         "no_stop")                                           # 重写的是被删的站
    fail(dp.edit(pid, "remove_stop", dict(stop_id=s2, legs=[dict(to_stop=s3, mode="walk"),
                                                              dict(to_stop=s3, mode="taxi")]), now=t),
         "bad_legs")                                          # 同一站写两次
    fail(dp.edit(pid, "remove_stop", dict(stop_id=s2, legs=[dict(to_stop=[s3], mode="walk")]), now=t),
         "bad_stop")                                          # 站号类型不对:规范回执,不炸
    fail(dp.edit(pid, "update_stop", dict(stop_id={"x": 1}, title="t"), now=t), "bad_stop")
    assert stop_ids(pid) == [s1, s2, s3]
    st = snap(pid, t)["state"]
    lg = next(x for x in st["legs"] if x["to_stop_id"] == s3)
    assert (lg["from_stop_id"], lg["mode"], lg["stale"]) == (s2, "train", 0)
    assert raw("SELECT version FROM date_plans WHERE id=?", (pid,))[0][0] == v0
    assert [k for k, _ in events(pid, t)] == ["envelope"]


def test_first_stop_change_allowed_while_unrevealed():
    pid, (s1, s2, s3) = make_plan()
    n0 = len(events(pid, NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="18:30", title="咖啡馆", address="a", clue="c",
                                        reveal_at="17:00", position=1), now=NOW0))
    assert events(pid, NOW0)[n0:] == [("telegram_auto", "加了一站：第 1 站 18:30；集合时间改了：19:00 → 18:30")]
    assert dp.her_plan(pid, now=NOW0)["stops"][0]["time"] == "18:30"


def test_first_stop_change_needs_explicit_reveal():
    pid, (s1, s2, s3) = make_plan()
    r = fail(dp.edit(pid, "add_stop", dict(kind="train", time="18:30", title="咖啡馆", address="a",
                                              clue="c", position=1), now=NOW0), "first_reveal")
    assert texts(r) == ["第 1 站没写地点公开时间"]


def test_first_stop_change_rejected_after_she_saw_it():
    pid, (s1, s2, s3) = make_plan()
    t = T(10, 28, 17, 40)                                       # 集合站 17:30 已公开
    r = fail(dp.edit(pid, "add_stop", dict(kind="train", time="18:30", title="咖啡馆", address="a",
                                              clue="c", reveal_at="17:00", position=1), now=t), "first_stop")
    assert texts(r) == ["她已经看到第 1 站（集合站）了，不能再换集合站。要改它的内容用 update_stop"]


def test_revealed_stop_cannot_become_first():
    pid, (s1, s2, s3) = make_plan(stop3_reveal="17:00", leg2=False)
    t = T(10, 28, 17, 10)                                       # 第 3 站已公开,集合站(17:30)还没
    r = fail(dp.edit(pid, "move_stop", dict(stop_id=s3, to=1, legs=[dict(to_stop=s3, mode="walk"),
                                                                       dict(to_stop=s1, mode="walk")]),
                     now=t), "public_first")
    assert texts(r) == ["她已经看到第 3 站了，不能把它换成第 1 站"]
