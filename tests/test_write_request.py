"""Her "please write" button: one press asks for everything not yet written, delivered as one AI to-do round.

open_asks gating, her_request_write (refusals / dedupe / requeue), the HTTP route, the scheduler round
(merge / claim / four states / quiet / expiry), and: no AI path configured = the request is refused.
tmp data dir, fake clock, fake delivery.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from ephemera_date import http

from ephemera_date import config
from ephemera_date import plan as dp
from ephemera_date import remind as date_remind
from conftest import TZ

NOW = datetime(2026, 10, 22, 15, 0, tzinfo=TZ)


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    assert str(tmp_path) in config.db_path()
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "pull")     # 至少一条通 AI 的路接好了(没接好的情况单独测)
    dp._connect().close()
    yield


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
    return TestClient(Starlette(routes=http.routes()), base_url="http://localhost")   # 没配口令=只认本机


BODY = {
    "date": "2026-05-03", "title_en": "Spring", "color": "sky",
    "stops": [{"kind": "cafe", "time": "12:00", "title": "古城", "lat": 35.70, "lng": 139.70}],
}


def backfill(cid="c-1", **over):
    b = {**BODY, "client_id": cid, **over}
    return dp.her_backfill(b, now=NOW)


def his_done_plan(now=NOW):
    p = ok(dp.open_plan("Night", "2026-10-28", "rose", now=now))["plan_id"]
    ok(dp.edit(p, "add_stop", dict(kind="train", time="19:00", title="站", address="a", clue="c",
                                      reveal_at="17:30"), now=now))
    ok(dp.edit(p, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=now))
    ok(dp.send(p, now=now))
    ok(dp.close(p, "好", now=datetime(2026, 10, 28, 23, tzinfo=TZ)))
    return p


# ═════ 迁移(老库缺这些列/没有 date_write_requests 表)═══════════════════════════════════════
def test_old_date_asks_without_request_columns_migrates(tmp_path):
    db = str(tmp_path / "old.db")
    cols = [c for c in dp._TABLES["date_asks"]["cols"]
           if c[0] not in ("requested_at", "request_claimed_at", "request_woke_at", "request_wake_result")]
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE date_asks (" + ", ".join(f"{n} {d}" for n, d, _ in cols)
              + ", " + ", ".join(dp._TABLES["date_asks"]["extra"]) + ")")
    c.execute("INSERT INTO date_asks (plan_id, what, asked_at) VALUES (1, 'card', 1.0)")
    c.commit()
    c.close()
    conn = dp._connect(db)
    try:
        assert tuple(conn.execute("SELECT requested_at, request_claimed_at, request_woke_at, request_wake_result"
                                 " FROM date_asks").fetchone()) == (None, None, None, None)
        assert {r[1] for r in conn.execute("PRAGMA table_info(date_write_requests)")} == \
            {"plan_id", "client_id", "created_at"}
    finally:
        conn.close()


# ═════ open_asks 门控(直接单测;端到端场景见 test_backfill.py)══════════════════════════════
def test_open_asks_gates_her_origin_only():
    pid = backfill()["id"]
    with dp._tx() as conn:
        assert dp.open_asks(conn, pid, "her") == []                                       # 门控:没请不算
        assert dp.open_asks(conn, pid, "him") == ["invite", "contract", "card", "quote"]  # 不门控
        assert dp.open_asks(conn, pid) == ["invite", "contract", "card", "quote"]          # 默认(旧调用)不门控
    dp.her_request_write(pid, "req-1", now=NOW)
    with dp._tx() as conn:
        assert dp.open_asks(conn, pid, "her") == ["invite", "contract", "card", "quote"]


# ═════ her_request_write 本体 ═════════════════════════════════════════════════════════
def test_request_write_sets_requested_at_on_open_asks_and_logs_event():
    pid = backfill()["id"]
    v = dp.her_request_write(pid, "req-1", now=NOW)
    assert v["write_request"]["pending"] == ["invite", "contract", "card", "quote"]
    assert v["write_request"]["state"] == "queued" and v["write_request"]["requested_at"] == NOW.timestamp()
    rows = raw("SELECT what, requested_at FROM date_asks WHERE plan_id=? ORDER BY what", (pid,))
    assert len(rows) == 4 and all(r[1] == NOW.timestamp() for r in rows)
    assert raw("SELECT text FROM date_events WHERE plan_id=? AND kind='her_request_write'", (pid,)) == \
        [("她请你补写：迟到的请柬、契约书、小卡、那一句话",)]


def test_request_write_requires_client_id():
    pid = backfill()["id"]
    for bad in (None, "", "  ", "x" * 65, 5):
        with pytest.raises(dp.HerEditError) as e:
            dp.her_request_write(pid, bad, now=NOW)
        assert e.value.status == 400 and e.value.field == "client_id"


def test_request_write_rejects_when_nothing_open():
    pid = backfill(invite_text="a", card="b", contract=["c"])["id"]      # 请柬/契约书/小卡都写了
    ok(dp.edit(pid, "set_quote", dict(text="下次还去"), now=NOW))      # 剩 quote,他补上
    with pytest.raises(dp.HerEditError) as e:
        dp.her_request_write(pid, "req-1", now=NOW)
    assert e.value.status == 409 and e.value.code == "nothing_to_write" and "写完" in e.value.text


def test_request_write_rejects_not_visible_plan():
    p = ok(dp.open_plan("Soon", "2026-10-28", "rose", now=NOW))["plan_id"]      # 构思中
    with pytest.raises(dp.HerEditError) as e:
        dp.her_request_write(p, "req-1", now=NOW)
    assert e.value.status == 404


def test_request_write_works_on_his_plan_too_no_origin_restriction():
    """他写的约会(origin!=her)照样能走这个口——只是门控本身对这类约会不生效(行为不变)。"""
    his = his_done_plan()
    assert dp.add_ask(his, "card_after")
    v = dp.her_request_write(his, "req-1", now=NOW)
    assert v["write_request"]["pending"] == ["card_after"]
    assert raw("SELECT requested_at FROM date_asks WHERE plan_id=?", (his,))[0][0] == NOW.timestamp()


def test_request_write_dedupes_same_client_id_replay():
    pid = backfill()["id"]
    v1 = dp.her_request_write(pid, "req-1", now=NOW)
    v2 = dp.her_request_write(pid, "req-1", now=NOW + timedelta(minutes=1))     # 同号重放
    assert v2["write_request"]["requested_at"] == v1["write_request"]["requested_at"]
    assert raw("SELECT COUNT(*) FROM date_events WHERE plan_id=? AND kind='her_request_write'", (pid,)) == [(1,)]


def test_request_write_no_requeue_when_all_sent():
    pid = backfill()["id"]
    dp.her_request_write(pid, "req-1", now=NOW)
    ts = NOW.timestamp()
    with sqlite3.connect(config.db_path()) as c:
        c.execute("UPDATE date_asks SET request_claimed_at=?, request_woke_at=?, request_wake_result='sent'"
                 " WHERE plan_id=?", (ts, ts, pid))
    later = NOW + timedelta(hours=1)
    v = dp.her_request_write(pid, "req-2", now=later)
    assert v["write_request"]["requested_at"] == ts and v["write_request"]["state"] == "sent"
    assert raw("SELECT COUNT(*) FROM date_events WHERE plan_id=? AND kind='her_request_write'", (pid,)) == [(1,)]


def test_request_write_requeues_after_not_sent():
    pid = backfill()["id"]
    dp.her_request_write(pid, "req-1", now=NOW)
    ts = NOW.timestamp()
    with sqlite3.connect(config.db_path()) as c:
        c.execute("UPDATE date_asks SET request_claimed_at=?, request_woke_at=?, request_wake_result='not_sent'"
                 " WHERE plan_id=?", (ts, ts, pid))
    later = NOW + timedelta(hours=1)
    v = dp.her_request_write(pid, "req-2", now=later)
    assert v["write_request"]["requested_at"] == later.timestamp() and v["write_request"]["state"] == "queued"
    rows = raw("SELECT request_claimed_at, request_woke_at, request_wake_result FROM date_asks WHERE plan_id=?",
              (pid,))
    assert all(r == (None, None, None) for r in rows)
    assert raw("SELECT COUNT(*) FROM date_events WHERE plan_id=? AND kind='her_request_write'", (pid,)) == [(2,)]


# ═════ HTTP 路由 ═══════════════════════════════════════════════════════════════════════
def test_request_write_route_contract():
    pid = backfill()["id"]
    c = _client()
    r = c.post(f"/api/dates/{pid}/her/request_write", json={"client_id": "req-1"})
    assert r.status_code == 200 and r.json()["write_request"]["pending"] == ["invite", "contract", "card", "quote"]
    r = c.post(f"/api/dates/{pid}/her/request_write", json={"client_id": "req-1", "foo": 1})
    assert r.status_code == 400 and r.json()["detail"]["field"] == "foo"
    r = c.post(f"/api/dates/{pid}/her/request_write", json={})
    assert r.status_code == 400 and r.json()["detail"]["field"] == "client_id"
    r = c.post(f"/api/dates/{pid}/her/request_write", json="x")
    assert r.status_code == 400


def test_request_write_route_nothing_to_write_409():
    pid = backfill(invite_text="a", card="b", contract=["c"])["id"]
    ok(dp.edit(pid, "set_quote", dict(text="x"), now=NOW))
    r = _client().post(f"/api/dates/{pid}/her/request_write", json={"client_id": "req-1"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "nothing_to_write"


# ═════ 调度(照待办协议,与 date_remind.process_reminders 同协议)══════════════════════════
class Waker:
    def __init__(self, result="sent"):
        self.calls, self.result = [], result

    def __call__(self, body, meta):
        self.calls.append((meta, body))
        return self.result


def run(now, waker, busy=False, quiet=False):
    return date_remind.process_write_requests(wake=waker, busy=lambda: busy, in_quiet=quiet, now=now)


def test_process_write_requests_merges_one_round_and_terminal():
    pid = backfill()["id"]
    dp.her_request_write(pid, "req-1", now=NOW)
    w = Waker()
    r = run(NOW + timedelta(minutes=1), w)
    assert r["woke"] == 1 and len(w.calls) == 1
    meta, body = w.calls[0]
    assert meta["plan_ids"] == [pid] and len(meta["ask_ids"]) == 4
    with dp._tx() as conn:
        p = dp._load(conn, pid)["plan"]
    assert body == dp.request_write_line(p, ["invite", "contract", "card", "quote"])
    assert body.startswith(dp.REQUEST_HEAD + " ")
    assert raw("SELECT request_wake_result FROM date_asks WHERE plan_id=?", (pid,)) == [("sent",)] * 4
    run(NOW + timedelta(minutes=2), w)
    assert len(w.calls) == 1              # 终态不重发


def test_process_write_requests_busy_quiet_defer_then_expire():
    pid = backfill()["id"]
    dp.her_request_write(pid, "req-1", now=NOW)
    w = Waker()
    assert run(NOW + timedelta(minutes=1), w, busy=True)["deferred"] == 4
    assert run(NOW + timedelta(minutes=2), w, quiet=True)["deferred"] == 4
    assert w.calls == []
    later = NOW + timedelta(seconds=dp.WRITE_REQUEST_EXPIRE_S + 60)
    r = run(later, w, quiet=True)
    assert r["expired"] == 4 and r["deferred"] == 0
    assert raw("SELECT request_wake_result FROM date_asks WHERE plan_id=?", (pid,)) == [("expired",)] * 4


def test_process_write_requests_not_sent_releases_for_retry_unknown_terminal():
    pid = backfill()["id"]
    dp.her_request_write(pid, "req-1", now=NOW)
    w = Waker("not_sent")
    assert run(NOW + timedelta(minutes=1), w)["released"] == 4
    w.result = "unknown"
    run(NOW + timedelta(minutes=2), w)
    run(NOW + timedelta(minutes=3), w)
    assert len(w.calls) == 2
    assert raw("SELECT request_wake_result FROM date_asks WHERE plan_id=?", (pid,)) == [("unknown",)] * 4


def test_process_write_requests_abandoned_after_claim_stale():
    pid = backfill()["id"]
    dp.her_request_write(pid, "req-1", now=NOW)
    with sqlite3.connect(config.db_path()) as c:
        c.execute("UPDATE date_asks SET request_claimed_at=? WHERE plan_id=?", (NOW.timestamp(), pid))
    later = NOW + timedelta(seconds=date_remind.CLAIM_STALE_S + 60)
    w = Waker()
    r = run(later, w)
    assert r["abandoned"] == 4 and w.calls == []
    assert raw("SELECT request_wake_result FROM date_asks WHERE plan_id=?", (pid,)) == [("abandoned",)] * 4


def test_process_write_requests_two_plans_one_round():
    """两盒都点了请他补写——合成一次叫醒,每盒一行(定稿那句逐字),不连着叫他两次;两盒都落终态。"""
    pid1 = backfill(cid="c-1")["id"]
    pid2 = backfill(cid="c-2", date="2026-05-04")["id"]
    dp.her_request_write(pid1, "req-1", now=NOW)
    dp.her_request_write(pid2, "req-2", now=NOW)
    w = Waker()
    r = run(NOW + timedelta(minutes=1), w)
    assert r["woke"] == 1 and len(w.calls) == 1
    lines = w.calls[0][1].split("\n")
    assert len(lines) == 2 and all(l.startswith(dp.REQUEST_HEAD + " ") for l in lines)
    assert {l.split("约会 #")[1].split("「")[0].strip() for l in lines} == {str(pid1), str(pid2)}
    with dp._tx() as conn:
        for pid, l in zip(sorted((pid1, pid2)), sorted(lines, key=lambda x: int(x.split("约会 #")[1].split("「")[0]))):
            assert l == dp.request_write_line(dp._load(conn, pid)["plan"], ["invite", "contract", "card", "quote"])
    assert set(raw("SELECT request_wake_result FROM date_asks WHERE plan_id IN (?,?) AND requested_at IS NOT NULL", (pid1, pid2))) == {("sent",)}
    run(NOW + timedelta(minutes=2), w)
    assert len(w.calls) == 1


# ═════ 没有任何一条通 AI 的路:不收「请他补写」(页面也不露)════════════════════════════════
def test_request_write_refused_without_any_ai_channel(monkeypatch):
    pid = backfill()["id"]
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "none")
    with pytest.raises(dp.HerEditError) as e:
        dp.her_request_write(pid, "req-1", now=NOW)
    assert e.value.status == 409 and e.value.code == "no_ai_channel"
    assert raw("SELECT COUNT(*) FROM date_asks WHERE plan_id=? AND requested_at IS NOT NULL", (pid,)) == [(0,)]
    c = _client()
    assert c.get(f"/api/dates/{pid}").json()["write_request"]["available"] is False
    assert c.get("/api/config").json()["write_request_available"] is False
    monkeypatch.delenv("EPHEMERA_AI_CHANNELS")           # 自动判定:三条都没用过/没配 = 不露
    assert c.get("/api/config").json()["write_request_available"] is False
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "http://127.0.0.1:9/hook")     # 配了推 = 露
    assert c.get(f"/api/dates/{pid}").json()["write_request"]["available"] is True


# ── 候选读出后他刚好写完 → 只按真没写的那几样叫醒;全写完 → 不叫醒 ──────────────────
def _done(pid, *whats):
    c = sqlite3.connect(config.db_path())
    try:
        for w in whats:
            c.execute("UPDATE date_asks SET done_at=? WHERE plan_id=? AND what=?", (NOW.timestamp(), pid, w))
        c.commit()
    finally:
        c.close()


def test_claim_rechecks_done_between_read_and_claim():
    pid = backfill()["id"]
    dp.her_request_write(pid, "req-1", now=NOW)
    w = Waker()
    # busy 在「读候选之后、占位之前」被调:借它模拟他在这个空隙里写完了两样
    r = date_remind.process_write_requests(wake=w, busy=lambda: (_done(pid, "invite", "card"), False)[1],
                                           in_quiet=False, now=NOW + timedelta(minutes=1))
    assert r["woke"] == 1
    with dp._tx() as conn:
        p = dp._load(conn, pid)["plan"]
    assert w.calls[0][1] == dp.request_write_line(p, ["contract", "quote"])   # 正文只列真没写的
    assert sorted(x[0] for x in raw("SELECT what FROM date_asks WHERE plan_id=? AND request_wake_result='sent'", (pid,))) \
        == ["contract", "quote"]


def test_claim_skips_when_everything_got_written_in_between():
    pid = backfill()["id"]
    dp.her_request_write(pid, "req-1", now=NOW)
    w = Waker()
    r = date_remind.process_write_requests(
        wake=w, busy=lambda: (_done(pid, "invite", "contract", "card", "quote"), False)[1],
        in_quiet=False, now=NOW + timedelta(minutes=1))
    assert r["woke"] == 0 and w.calls == []
