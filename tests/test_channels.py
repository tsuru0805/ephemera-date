"""AI to-do channel (pull / context / push), the single scheduler, auth, Web Push, secrecy markers, MCP over HTTP.

tmp data dir, fake clock, fake webhook / Web Push senders; no network.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import time
from datetime import datetime, timedelta

import pytest

from conftest import AI_TOKEN, HER_TOKEN, H, TZ, local_tools
from ephemera_date import config, inbox, outlet, scheduler, webpush
from ephemera_date import plan as dp
from ephemera_date import remind
from ephemera_date import tools as dt

NOW0 = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


def ok(r):
    assert r["ok"], r["errors"]
    return r


def raw(sql, args=()):
    c = sqlite3.connect(config.db_path())
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def make_plan(now=NOW0, day=DAY, first="19:00", reveal="17:30"):
    pid = ok(dp.open_plan("Night", day, "rose", now=now))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time=first, title="梧桐站", address="a", clue="c",
                                     reveal_at=reveal), now=now))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=now))
    ok(dp.send(pid, now=now))
    return pid


def backfill(cid="c-1"):
    return dp.her_backfill({"client_id": cid, "date": "2026-05-03", "title_en": "Spring", "color": "sky",
                            "stops": [{"kind": "cafe", "time": "12:00", "title": "古城"}]}, now=NOW0)["id"]


@pytest.fixture()
def app_client(monkeypatch):
    from starlette.testclient import TestClient

    from ephemera_date import server
    monkeypatch.setenv("EPHEMERA_HER_TOKEN", HER_TOKEN)
    monkeypatch.setenv("EPHEMERA_AI_TOKEN", AI_TOKEN)
    with TestClient(server.build_app(run_scheduler=False)) as c:
        yield c


# ══ A1 展示 ≠ 领取;领取排他、带领取者、超时放回 ═══════════════════════════════════════
def test_showing_is_not_claiming_and_claims_are_exclusive(monkeypatch):
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "http://127.0.0.1:9/hook")
    make_plan()
    t = T(10, 27, 20, 1)
    remind.process_reminders(now=t)
    remind.process_reminders(now=t + timedelta(minutes=1))              # 再跑一轮:不新派
    assert raw("SELECT COUNT(*) FROM ai_inbox") == [(1,)]
    assert [r["holder"] for r in inbox.open_items("pull", t)] == [None]  # 看 ≠ 领
    assert "（可领取）" in inbox.context_text(t)
    assert inbox.claim([1], "pull:desk", t)["claimed"] == [1]
    assert inbox.claim([1], "pull:phone", t)["held"] == {1: "pull:desk"}
    assert inbox.claim([1], "context:relay", t)["held"] == {1: "pull:desk"}
    assert "（pull:desk 在处理，到 10/27 20:31）" in inbox.context_text(t, claim_for="relay")
    assert inbox.mark_done([1], "pull:phone", t)["held"] == {1: "pull:desk"}
    sent = []
    r = inbox.push_pending(lambda p, k: sent.append(p) or "sent", t)     # 已被别路领取:不推
    assert sent == [] and r["claimed"] == 1
    later = t + timedelta(seconds=inbox.CLAIM_TTL_S + 1)                 # 领取超时:自动回到可领
    assert inbox.claim([1], "pull:phone", later)["claimed"] == [1]
    assert inbox.mark_done([1], "pull:desk", later)["held"] == {1: "pull:phone"}
    assert inbox.mark_done([1], "pull:phone", later)["done"] == [1]
    assert inbox.count_open(later) == 0


def test_context_claim_and_relay_endpoints(app_client):
    make_plan()
    scheduler.tick(now=T(10, 27, 20, 1))
    r = app_client.get("/context", params={"claim": "relay"}, headers=H(AI_TOKEN))
    assert r.status_code == 200 and "（你领取了" in r.text
    assert raw("SELECT claimed_by FROM ai_inbox") == [("context:relay",)]
    r = app_client.post("/context/done", json={"ids": [1], "client": "other"}, headers=H(AI_TOKEN))
    assert r.json()["held"] == {"1": "context:relay"}
    r = app_client.post("/context/done", json={"ids": [1], "client": "relay"}, headers=H(AI_TOKEN))
    assert r.json()["done"] == [1] and r.json()["_meta"]["ephemera/secret"] is True
    assert app_client.post("/context/done", json={"ids": [1]}, headers=H(HER_TOKEN)).status_code == 401


def test_context_claims_need_a_unique_client_id(app_client):
    make_plan()
    scheduler.tick(now=T(10, 27, 20, 1))
    r = app_client.get("/context", params={"claim": " "}, headers=H(AI_TOKEN))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "client_required"
    for path in ("/context/claim", "/context/done", "/context/release"):
        r = app_client.post(path, json={"ids": [1]}, headers=H(AI_TOKEN))
        assert r.status_code == 400 and r.json()["detail"]["code"] == "client_required"
    assert raw("SELECT claimed_by FROM ai_inbox") == [(None,)]
    assert app_client.get("/context", headers=H(AI_TOKEN)).status_code == 200    # 只看不领:不用 id


def test_webhook_only_wakes_and_claims_stay_exclusive_during_send(monkeypatch):
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "http://127.0.0.1:9/hook")
    make_plan()
    t = T(10, 27, 20, 1)
    remind.process_reminders(now=t)
    seen = {}

    def send(payload, key):
        seen["key"] = key
        seen["state_during"] = raw("SELECT push_state FROM ai_inbox")[0][0]
        seen["a"] = inbox.claim([1], "pull:a", t)                         # 推送进行中:照常能领
        seen["b"] = inbox.claim([1], "pull:b", t)                         # 但同一时刻只有一个领取者
        return "sent"
    assert inbox.push_pending(send, t)["sent"] == 1
    assert seen["key"] == "ephemera-todo-1" and seen["state_during"] == "sending"
    assert seen["a"]["claimed"] == [1] and seen["b"]["held"] == {1: "pull:a"}
    assert raw("SELECT claimed_by, push_state FROM ai_inbox") == [("pull:a", "sent")]   # 推送不改领取者
    assert inbox.claim([1], "pull:woken", t)["held"] == {1: "pull:a"}     # 被叫醒的一方也得领到才算
    assert inbox.mark_done([1], "pull:woken", t)["held"] == {1: "pull:a"}
    inbox.release([1], "pull:a", t)
    assert inbox.claim([1], "pull:woken", t)["claimed"] == [1]


def test_pushed_todo_is_claimable_and_not_held_by_the_webhook(monkeypatch):
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "http://127.0.0.1:9/hook")
    make_plan()
    t = T(10, 27, 20, 1)
    remind.process_reminders(now=t)
    assert inbox.push_pending(lambda p, k: "sent", t)["sent"] == 1
    assert raw("SELECT claimed_by FROM ai_inbox") == [(None,)]
    assert inbox.claim([1], "pull:x", t)["claimed"] == [1]
    assert inbox.claim([1], "pull:y", t)["held"] == {1: "pull:x"}


# ══ A2 占位与写入待办同一事务 ════════════════════════════════════════════════════════
def test_inbox_write_lock_failure_is_retried_not_lost(monkeypatch):
    make_plan()
    t = T(10, 27, 20, 1)
    real = inbox.deliver
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return real(*a, **k)
    monkeypatch.setattr(inbox, "deliver", flaky)
    r = remind.process_reminders(now=t)
    assert r["errors"] == 1 and r["woke"] == 0
    assert raw("SELECT wake_claimed_at, woke_at FROM date_reminders") == [(None, None)]   # 整笔回滚:没占位
    assert raw("SELECT COUNT(*) FROM ai_inbox") == [(0,)]
    assert remind.process_reminders(now=t + timedelta(minutes=1))["woke"] == 1
    assert raw("SELECT COUNT(*) FROM ai_inbox") == [(1,)]
    assert raw("SELECT wake_result FROM date_reminders") == [("sent",)]


def test_crash_after_claim_rolls_back_and_redelivers():
    make_plan()
    t = T(10, 27, 20, 1)

    class Crash(BaseException):
        pass

    def boom(body, meta):
        inbox.wake_reminders(body, meta)          # 待办已写进同一事务……
        raise Crash()                              # ……然后进程没了
    with pytest.raises(Crash):
        remind.process_reminders(wake=boom, now=t)
    assert raw("SELECT wake_claimed_at, woke_at FROM date_reminders") == [(None, None)]
    assert raw("SELECT COUNT(*) FROM ai_inbox") == [(0,)]                  # 一起回滚,没有半截
    assert remind.process_reminders(now=t + timedelta(minutes=1))["woke"] == 1
    assert raw("SELECT COUNT(*) FROM ai_inbox") == [(1,)]


def test_write_request_crash_after_claim_rolls_back(monkeypatch):
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "pull")
    pid = backfill()
    dp.her_request_write(pid, "req-1", now=NOW0)

    class Crash(BaseException):
        pass

    def boom(body, meta):
        raise Crash()
    with pytest.raises(Crash):
        remind.process_write_requests(wake=boom, now=NOW0 + timedelta(minutes=1))
    assert set(raw("SELECT request_claimed_at, request_woke_at FROM date_asks WHERE requested_at IS NOT NULL")) \
        == {(None, None)}
    assert remind.process_write_requests(now=NOW0 + timedelta(minutes=2))["woke"] == 1
    assert raw("SELECT kind FROM ai_inbox") == [("write_request",)]


# ══ A3 推之前先结算:写完的不推 ═══════════════════════════════════════════════════════
def test_push_skips_requests_already_written(monkeypatch):
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "webhook")
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "http://127.0.0.1:9/hook")
    pid = backfill()
    dp.her_request_write(pid, "req-1", now=NOW0)
    remind.process_write_requests(now=NOW0 + timedelta(minutes=1))     # 只入箱,不推
    assert raw("SELECT kind, push_state FROM ai_inbox") == [("write_request", "pending")]
    for op, args in (("set_invite", {"text": "迟到的请柬"}), ("set_contract", {"items": ["一"]}),
                     ("set_card", {"text": "小卡"}), ("set_quote", {"text": "那一句"})):
        ok(dp.edit(pid, op, args, now=NOW0 + timedelta(minutes=2)))
    sent = []
    r = inbox.push_pending(lambda p, k: sent.append(p) or "sent", NOW0 + timedelta(minutes=3))
    assert sent == [] and r["expired"] == 1
    assert raw("SELECT done_via, push_state FROM ai_inbox") == [("written", "expired")]


# ══ A4 合并批次逐条过期;改期/取消按来源作废 ═════════════════════════════════════════════
def test_merged_round_expires_line_by_line_0010_meeting():
    pid = make_plan(day="2026-10-25", first="00:10", reveal="23:00")
    t = T(10, 24, 23, 56)                                                # 「明天」与「今天」「第 1 站」同轮合并
    remind.process_reminders(now=t)
    rows = inbox.open_items("pull", t)
    assert len(rows) == 1 and f"约会 #{pid} 明天（10/25 周日）。" in rows[0]["current"]
    n_lines = rows[0]["current"].count("\n") + 1
    later = T(10, 25, 0, 1)
    rows = inbox.open_items("pull", later)
    assert len(rows) == 1 and "明天" not in rows[0]["current"]          # 过了午夜:「明天」那一行剔除
    assert rows[0]["current"].count("\n") + 1 == n_lines - 1
    assert f"约会 #{pid} 今天，第 1 站 00:10。" in rows[0]["current"]
    assert "明天" not in inbox.context_text(later)
    assert inbox.count_open(T(10, 25, 0, 11)) == 0                       # 每一行都过期:整件关闭
    assert raw("SELECT closed_why FROM ai_inbox") == [("expired",)]


def test_moved_or_cancelled_date_voids_inbox_lines():
    p1 = make_plan()
    p2 = make_plan()
    t = T(10, 27, 20, 1)
    remind.process_reminders(now=t)
    assert inbox.open_items("pull", t)[0]["current"].count("明天") == 2
    ok(dp.edit(p1, "set_basic", {"date": "2026-10-30"}, now=t))           # 改期:p1 的「明天」不再成立
    cur = inbox.open_items("pull", t)[0]["current"]
    assert f"约会 #{p1}" not in cur and f"约会 #{p2} 明天" in cur
    ok(dp.edit(p2, "cancel", {"reason": "下雨"}, now=t))
    assert inbox.count_open(t) == 0 and raw("SELECT closed_why FROM ai_inbox") == [("void",)]


# ══ A5 502/504=不确定;幂等键 ════════════════════════════════════════════════════════
def test_post_json_states_and_idempotency_header():
    import httpx
    seen = {}

    def client(handler):
        return httpx.Client(transport=httpx.MockTransport(handler))

    def capture(r):
        seen.update(r.headers)
        return httpx.Response(204)
    assert outlet.post_json("http://x/h", {"a": 1}, client=client(capture), idempotency_key="ephemera-event-7") == "sent"
    assert seen["idempotency-key"] == "ephemera-event-7"
    for status, want in ((503, "not_sent"), (429, "not_sent"), (502, "unknown"), (504, "unknown"),
                         (500, "unknown"), (404, "failed")):
        assert outlet.post_json("http://x/h", {}, client=client(lambda r, s=status: httpx.Response(s))) == want, status

    def refuse(r):
        raise httpx.ConnectError("refused", request=r)

    def slow(r):
        raise httpx.ReadTimeout("slow", request=r)
    assert outlet.post_json("http://x/h", {}, client=client(refuse)) == "not_sent"
    assert outlet.post_json("http://x/h", {}, client=client(slow)) == "unknown"


def test_event_webhook_carries_idempotency_key(monkeypatch):
    monkeypatch.setenv("EPHEMERA_EVENT_WEBHOOK", "http://127.0.0.1:9/events")
    got = []
    monkeypatch.setattr(outlet, "post_json",
                        lambda url, payload, idempotency_key=None: got.append(idempotency_key) or "sent")
    pid = make_plan()
    outlet.sweep(now=NOW0)
    eid = raw("SELECT id FROM date_events WHERE plan_id=?", (pid,))[0][0]
    assert got == [f"ephemera-event-{eid}"]


def test_webhook_signature(monkeypatch):
    import hashlib
    import hmac

    import httpx
    monkeypatch.setenv("EPHEMERA_WEBHOOK_SECRET", "s3cret")
    got = {}

    def h(r):
        got["sig"], got["body"] = r.headers["x-ephemera-signature"], r.content
        return httpx.Response(200)
    outlet.post_json("http://x/h", {"k": "v"}, client=httpx.Client(transport=httpx.MockTransport(h)))
    assert got["sig"] == "sha256=" + hmac.new(b"s3cret", got["body"], hashlib.sha256).hexdigest()


def test_ai_webhook_four_states_and_quiet_hours(monkeypatch):
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "http://127.0.0.1:9/hook")
    monkeypatch.setenv("EPHEMERA_QUIET_HOURS", "20:00-20:30")
    make_plan()
    remind.process_reminders(now=T(10, 27, 20, 1))
    calls = []

    def send(state):
        return lambda p, k: calls.append(p) or state
    assert inbox.push_pending(send("sent"), T(10, 27, 20, 2))["deferred"] == 1 and calls == []
    assert inbox.push_pending(send("not_sent"), T(10, 27, 20, 31))["released"] == 1        # 没送到:重试
    assert inbox.push_pending(send("unknown"), T(10, 27, 20, 32))["unknown"] == 1          # 说不清:终态
    assert inbox.push_pending(send("sent"), T(10, 27, 20, 33))["sent"] == 0
    assert len(calls) == 2 and calls[-1]["_meta"] == {"ephemera/secret": True}
    assert inbox.count_open(T(10, 27, 20, 34)) == 1                       # 推不确定:拉/注入照样看得到


# ══ A6 可用性看配置,不看最近活动;先可见与重放,后通道 ══════════════════════════════════════
def test_channels_come_from_configuration(monkeypatch):
    assert inbox.channels() == [] and not inbox.write_request_available()
    inbox.record_use("context", NOW0)
    assert inbox.channels() == []                                        # 用过一次 ≠ 配好了
    assert inbox.activity()["context"] == NOW0.timestamp()               # 只作信息
    monkeypatch.setenv("EPHEMERA_AI_TOKEN", "t")
    assert inbox.channels() == ["pull", "context"]
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "not a url")
    assert inbox.channels() == ["pull", "context"]                       # webhook 要有效 URL 才算
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "https://relay.example/hook")
    assert inbox.channels() == ["pull", "context", "webhook"]
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "webhook")
    assert inbox.channels() == ["webhook"]
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "")
    assert inbox.channels() == [] and not inbox.write_request_available()
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "none")
    assert inbox.channels() == []


def test_request_write_checks_visibility_and_replay_before_channels(monkeypatch):
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "pull")
    pid = backfill()
    v1 = dp.her_request_write(pid, "req-1", now=NOW0)
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "none")
    v2 = dp.her_request_write(pid, "req-1", now=NOW0 + timedelta(minutes=1))      # 重放已成功的:原样回
    assert v2["write_request"]["requested_at"] == v1["write_request"]["requested_at"]
    with pytest.raises(dp.HerEditError) as e:
        dp.her_request_write(pid, "req-2", now=NOW0)
    assert e.value.code == "no_ai_channel"
    draft = ok(dp.open_plan("Soon", DAY, "rose", now=NOW0))["plan_id"]
    with pytest.raises(dp.HerEditError) as e:
        dp.her_request_write(draft, "req-3", now=NOW0)
    assert e.value.status == 404                                         # 不可见的约会:先 404,不露通道状态


# ══ B 单一调度者:独立续租、失租即停、外部调用超时 ═════════════════════════════════════════
def test_lease_single_owner_until_expiry():
    assert scheduler.acquire_lease("a", 1000.0)
    assert not scheduler.acquire_lease("b", 1010.0)
    assert scheduler.acquire_lease("a", 1060.0)
    assert not scheduler.acquire_lease("b", 1100.0)
    assert scheduler.acquire_lease("b", 1060.0 + scheduler.LEASE_S + 1)
    scheduler.release_lease("b")
    assert scheduler.acquire_lease("c", 1060.0 + scheduler.LEASE_S + 2)


def test_lost_lease_stops_dispatch_mid_round():
    pid = make_plan()
    for i in range(3):
        ok(dp.live(pid, "telegram", {"text": f"{i}"}, now=NOW0))
    sent, owner = [], {"ok": True}

    def send(payload):
        sent.append(payload)
        owner["ok"] = False                                              # 发第一条时租约被别人接走
        return "sent"
    outlet.sweep(send, now=NOW0, still_owner=lambda: owner["ok"])
    assert len(sent) == 1
    assert [r[0] for r in raw("SELECT push_state FROM date_events ORDER BY id")] == ["sent", "pending", "pending", "pending"]


def test_lease_lost_between_targets_stops_the_rest(monkeypatch):
    _vapid(monkeypatch)
    monkeypatch.setenv("EPHEMERA_EVENT_WEBHOOK", "http://127.0.0.1:9/events")
    webpush.subscribe(SUB)
    owner = {"ok": True}
    hooks, pushes = [], []

    def hook(url, payload, idempotency_key=None):
        hooks.append(1)
        owner["ok"] = False                                              # 第一个目标送完,租约没了
        return "sent"
    monkeypatch.setattr(outlet, "post_json", hook)
    monkeypatch.setattr(webpush, "_webpush", lambda sub, data, key: pushes.append(1))
    make_plan()
    outlet.sweep(now=NOW0, still_owner=lambda: owner["ok"])
    assert (len(hooks), len(pushes)) == (1, 0)                           # 第二个目标不再发
    assert raw("SELECT push_state FROM date_events") == [("pending",)]
    assert raw("SELECT target FROM date_event_deliveries") == [("webhook",)]
    owner["ok"] = True                                                   # 下一任主人只补没送的那个
    outlet.sweep(now=NOW0, still_owner=lambda: owner["ok"])
    assert (len(hooks), len(pushes)) == (1, 1) and raw("SELECT push_state FROM date_events") == [("sent",)]


def test_lease_lost_while_drawing_discards_the_result(monkeypatch):
    import os

    from ephemera_date import art, ports
    owner = {"ok": True}

    class Gen:
        async def generate(self, job):
            owner["ok"] = False                                          # 画的时候失租
            return b"ink", b"inv"
    ports.install("art", Gen())
    make_plan()
    r = asyncio.run(art.run_once(NOW0 + timedelta(minutes=5), still_owner=lambda: owner["ok"]))
    assert r["status"] == "lease_lost"
    assert raw("SELECT status, mask_file FROM date_art") == [("running", None)]    # 不写状态,下一任收回重画
    assert not os.path.isdir(dp.art_dir()) or not [f for f in os.listdir(dp.art_dir()) if f.endswith(".png")]


def _hold_lease(owner):
    assert scheduler.acquire_lease(owner)


def _steal_lease():
    c = sqlite3.connect(config.db_path())
    c.execute("UPDATE ephemera_meta SET value=?, updated_at=? WHERE key=?",
              (f"other@{time.time()}", time.time(), scheduler.LEASE_KEY))
    c.commit()
    c.close()


def test_lease_taken_after_drawing_before_commit_leaves_nothing(monkeypatch):
    import os

    from ephemera_date import art, ports

    class Gen:
        async def generate(self, job):
            _steal_lease()                                               # 画完、提交前:别的 owner 接走租约
            return b"ink", b"inv"
    ports.install("art", Gen())
    make_plan()
    _hold_lease("me")
    r = asyncio.run(art.run_once(NOW0 + timedelta(minutes=5), owner="me", still_owner=lambda: True))
    assert r["status"] == "lease_lost"                                   # 内存里还以为是主人,提交事务里查出不是
    assert raw("SELECT status, mask_file FROM date_art") == [("running", None)]
    files = os.listdir(dp.art_dir()) if os.path.isdir(dp.art_dir()) else []
    assert [f for f in files if f.endswith(".png") or ".tmp" in f] == []


def test_drawing_commit_normal_path_with_current_lease():
    import os

    from ephemera_date import art, ports

    class Gen:
        async def generate(self, job):
            return b"ink", b"inv"
    ports.install("art", Gen())
    make_plan()
    _hold_lease("me")
    r = asyncio.run(art.run_once(NOW0 + timedelta(minutes=5), owner="me", still_owner=lambda: True))
    assert r["status"] == "done"
    (sid, mask), = raw("SELECT stop_id, mask_file FROM date_art WHERE status='done'")
    assert sorted(f for f in os.listdir(dp.art_dir())) == [f"{mask}_ink.png", f"{mask}_inv.png"]


def test_failed_drawing_not_recorded_after_lease_lost():
    from ephemera_date import art, ports

    class Gen:
        async def generate(self, job):
            _steal_lease()
            raise RuntimeError("画坏了")
    ports.install("art", Gen())
    make_plan()
    _hold_lease("me")
    r = asyncio.run(art.run_once(NOW0 + timedelta(minutes=5), owner="me"))
    assert r["status"] == "lease_lost" and raw("SELECT status, error FROM date_art") == [("running", None)]


def _run_loop(**kw):
    holder = {}

    def go():
        async def main():
            holder["stop"], holder["loop"] = asyncio.Event(), asyncio.get_running_loop()
            await scheduler.run(holder["stop"], **kw)
        asyncio.run(main())
    th = threading.Thread(target=go, daemon=True)
    th.start()
    deadline = time.monotonic() + 3
    while "loop" not in holder and time.monotonic() < deadline:
        time.sleep(0.01)

    def stop():
        holder["loop"].call_soon_threadsafe(holder["stop"].set)
        th.join(5)
        assert not th.is_alive()
    return stop


def _wait(cond, secs=5.0):
    deadline = time.monotonic() + secs
    while not cond() and time.monotonic() < deadline:
        time.sleep(0.02)
    return cond()


def test_heartbeat_renews_during_a_long_round_and_takeover_stops_it(monkeypatch):
    rounds, seen_owner = [], []

    def long_tick(now=None, path=None, still_owner=None):
        rounds.append(time.monotonic())
        for _ in range(80):                                              # 一轮比租期还长(按测试缩小的租期)
            seen_owner.append(still_owner())
            time.sleep(0.02)
    monkeypatch.setattr(scheduler, "tick", long_tick)
    stop = _run_loop(tick_s=30, heartbeat_s=0.1, lease_s=0.5)
    assert _wait(lambda: len(seen_owner) > 40)
    assert all(seen_owner[:40])                                          # 心跳独立续租:长任务中仍是主人
    c = sqlite3.connect(config.db_path())                                # 另一个进程接走租约
    c.execute("UPDATE ephemera_meta SET value=?, updated_at=? WHERE key=?",
              (f"other@{time.time() + 100}", time.time() + 100, scheduler.LEASE_KEY))
    c.commit()
    c.close()
    assert _wait(lambda: seen_owner and seen_owner[-1] is False)          # 失租:轮内立刻看到
    time.sleep(0.3)
    n = len(rounds)
    scheduler.kick()
    time.sleep(0.5)
    assert len(rounds) == n                                              # 不是主人就不再开新一轮
    stop()


def test_hung_generator_does_not_hold_up_rounds(monkeypatch):
    from ephemera_date import art as art_mod
    from ephemera_date import ports

    class Hang:
        async def generate(self, job):
            await asyncio.sleep(3600)
    ports.install("art", Hang())
    monkeypatch.setenv("EPHEMERA_ART_TIMEOUT_S", "30")
    make_plan()
    rounds = []
    monkeypatch.setattr(scheduler, "tick", lambda now=None, path=None, still_owner=None: rounds.append(1))
    started = threading.Event()
    real = art_mod.run_once

    async def spy(*a, **k):
        started.set()
        return await real(*a, now=NOW0 + timedelta(minutes=5), **k)
    monkeypatch.setattr(art_mod, "run_once", spy)
    stop = _run_loop(tick_s=30, heartbeat_s=0.1)
    assert _wait(started.is_set)
    n = len(rounds)
    for _ in range(3):
        scheduler.kick()
        time.sleep(0.15)
    assert len(rounds) >= n + 3                                          # 画卡住,提醒照样一轮轮跑
    stop()


def test_losing_the_lease_cancels_a_drawing_in_flight(monkeypatch):
    from ephemera_date import art as art_mod
    from ephemera_date import ports
    ports.install("art", object())                                       # art_enabled() True
    started, cancelled = threading.Event(), threading.Event()

    async def hang(*a, **k):
        started.set()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise
    monkeypatch.setattr(art_mod, "run_once", hang)
    monkeypatch.setattr(scheduler, "tick", lambda now=None, path=None, still_owner=None: None)
    stop = _run_loop(tick_s=30, heartbeat_s=0.1, lease_s=0.5)
    assert _wait(started.is_set)
    c = sqlite3.connect(config.db_path())
    c.execute("UPDATE ephemera_meta SET value=?, updated_at=? WHERE key=?",
              (f"other@{time.time() + 100}", time.time() + 100, scheduler.LEASE_KEY))
    c.commit()
    c.close()
    assert _wait(cancelled.is_set)                                       # 心跳发现失租:正在画的那张取消
    stop()


def test_generator_timeout_counts_as_failure(monkeypatch):
    from ephemera_date import art, ports

    class Hang:
        async def generate(self, job):
            await asyncio.sleep(3600)
    ports.install("art", Hang())
    monkeypatch.setenv("EPHEMERA_ART_TIMEOUT_S", "0.1")
    make_plan()
    r = asyncio.run(art.run_once(NOW0 + timedelta(minutes=5)))
    assert r["status"] == "pending" and "longer than" in r["error"]


def test_two_concurrent_ticks_deliver_once():
    make_plan()
    t = T(10, 27, 20, 1)
    bar = threading.Barrier(2)

    def go():
        bar.wait()
        scheduler.tick(now=t)
    th = [threading.Thread(target=go) for _ in range(2)]
    [x.start() for x in th]
    [x.join() for x in th]
    assert raw("SELECT COUNT(*) FROM ai_inbox") == [(1,)]
    assert raw("SELECT COUNT(*) FROM date_reminders WHERE wake_result='sent'") == [(1,)]


def test_restart_recovers_undelivered_events(monkeypatch):
    monkeypatch.setenv("EPHEMERA_EVENT_WEBHOOK", "http://127.0.0.1:9/events")
    sent = []
    monkeypatch.setattr(outlet, "post_json",
                        lambda url, payload, idempotency_key=None: sent.append(payload) or "sent")
    pid = make_plan()
    ok(dp.live(pid, "telegram", {"text": "x"}, now=NOW0))
    assert raw("SELECT push_state FROM date_events ORDER BY id") == [("pending",), ("pending",)]
    scheduler.tick(now=NOW0 + timedelta(hours=3))
    assert [p["kind"] for p in sent] == ["envelope", "telegram_manual"]


def test_kick_from_worker_thread_without_event_loop_triggers_a_tick(monkeypatch):
    ticks = []
    monkeypatch.setattr(scheduler, "tick",
                        lambda now=None, path=None, still_owner=None: ticks.append(time.monotonic()))
    stop = _run_loop(tick_s=30, heartbeat_s=0.1)
    assert _wait(lambda: len(ticks) >= 1)
    n = len(ticks)
    worker = threading.Thread(target=scheduler.kick)                      # 普通线程,没有事件循环
    worker.start()
    worker.join()
    assert _wait(lambda: len(ticks) > n, 3)                               # 没等 30 秒
    stop()
    assert scheduler._loop is None
    assert raw("SELECT COUNT(*) FROM ephemera_meta WHERE key=?", (scheduler.LEASE_KEY,)) == [(0,)]


def test_tool_calls_never_start_a_scheduler():
    scheduler.kick()
    local_tools()["date_open"]({"title_en": "A", "date": DAY, "color": "rose"})
    assert scheduler._loop is None
    assert raw("SELECT COUNT(*) FROM ephemera_meta WHERE key=?", (scheduler.LEASE_KEY,)) == [(0,)]
    assert raw("SELECT COUNT(*) FROM date_reminders") == [(0,)]


# ══ D 网页推送 ═══════════════════════════════════════════════════════════════════════
SUB = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "BPkey", "auth": "authkey"}}


def _vapid(monkeypatch):
    for k, v in webpush.generate_keys().items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("EPHEMERA_VAPID_SUBJECT", "mailto:test@example.com")


def test_push_subscribe_needs_config_and_valid_subscription(api, monkeypatch):
    r = api.post("/api/push/subscribe", json=SUB, headers=H())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "not_configured"
    _vapid(monkeypatch)
    assert api.get("/api/config", headers=H()).json()["vapid_public_key"] == config.vapid_public_key()
    for bad, code in (({**SUB, "endpoint": "http://push.example/x"}, "bad_endpoint"),
                      ({"endpoint": SUB["endpoint"], "keys": {}}, "bad_keys"), ("x", "bad_body")):
        r = api.post("/api/push/subscribe", json=bad, headers=H())
        assert r.status_code == 400 and r.json()["detail"]["code"] == code
    assert api.post("/api/push/subscribe", json=SUB, headers=H(AI_TOKEN)).status_code == 401
    assert api.post("/api/push/subscribe", json=SUB, headers=H()).json() == {"subscribed": True}
    assert api.post("/api/push/subscribe", json=SUB, headers=H()).json() == {"subscribed": True}   # 同一设备重订=更新
    assert len(webpush.subscriptions()) == 1
    assert api.post("/api/push/unsubscribe", json={"endpoint": SUB["endpoint"]}, headers=H()).json() == {"removed": 1}


def test_events_go_to_webhook_and_web_push_with_fixed_text_only(monkeypatch):
    _vapid(monkeypatch)
    monkeypatch.setenv("EPHEMERA_EVENT_WEBHOOK", "http://127.0.0.1:9/events")
    webpush.subscribe(SUB)
    webpush.subscribe({**SUB, "endpoint": "https://push.example/gone"})
    hooks, pushes = [], []
    monkeypatch.setattr(outlet, "post_json",
                        lambda url, payload, idempotency_key=None: hooks.append(payload) or "sent")

    def fake_webpush(sub, data, key):
        from pywebpush import WebPushException
        pushes.append((sub["endpoint"], json.loads(data), key))
        if sub["endpoint"].endswith("gone"):
            resp = type("R", (), {"status_code": 410, "text": "", "headers": {}})()
            raise WebPushException("gone", response=resp)
    monkeypatch.setattr(webpush, "_webpush", fake_webpush)
    pid = make_plan()
    ok(dp.live(pid, "telegram", {"text": "我在梧桐站等你"}, now=NOW0))
    outlet.sweep(now=NOW0)
    assert [h["kind"] for h in hooks] == ["envelope", "telegram_manual"]
    good = [p for p in pushes if p[0].endswith("abc")]
    assert [(p[1]["title"], p[1]["body"], p[1]["navigate"]) for p in good] == [
        ("你收到一封信", "Ephemera", {"page": "seal", "planId": pid}),
        ("有一封新电报", "Ephemera", {"page": "telegrams", "planId": None})]
    assert set(good[0][1]) == {"title", "body", "navigate", "event_id"} and good[0][2].startswith("ephemera-event-")
    for _ep, data, _k in pushes:
        for secret in ("Night", "梧桐", "我在", "10/28"):
            assert secret not in json.dumps(data, ensure_ascii=False)
    assert [s["endpoint"] for s in webpush.subscriptions()] == [SUB["endpoint"]]   # 推送服务说没了:删订阅
    assert raw("SELECT push_state FROM date_events ORDER BY id") == [("sent",), ("sent",)]
    outlet.sweep(now=NOW0)
    assert len(hooks) == 2 and len([p for p in pushes if p[0].endswith("abc")]) == 2   # 每个目标只送一次


def test_one_target_down_retries_only_that_target(monkeypatch):
    _vapid(monkeypatch)
    monkeypatch.setenv("EPHEMERA_EVENT_WEBHOOK", "http://127.0.0.1:9/events")
    webpush.subscribe(SUB)
    hooks, pushes = [], []
    state = {"hook": "not_sent"}
    monkeypatch.setattr(outlet, "post_json",
                        lambda url, payload, idempotency_key=None: hooks.append(1) or state["hook"])
    monkeypatch.setattr(webpush, "_webpush", lambda sub, data, key: pushes.append(1))
    make_plan()
    outlet.sweep(now=NOW0)
    assert (len(hooks), len(pushes)) == (1, 1) and raw("SELECT push_state FROM date_events") == [("pending",)]
    state["hook"] = "sent"
    outlet.sweep(now=NOW0)
    assert (len(hooks), len(pushes)) == (2, 1) and raw("SELECT push_state FROM date_events") == [("sent",)]


# ══ C/E 鉴权 + 保密标记 + MCP over HTTP ═════════════════════════════════════════════════
def test_build_app_refuses_shared_token(monkeypatch):
    from ephemera_date import server
    monkeypatch.setenv("EPHEMERA_HER_TOKEN", "same")
    monkeypatch.setenv("EPHEMERA_AI_TOKEN", "same")
    with pytest.raises(ValueError):
        server.build_app(run_scheduler=False)


def test_context_needs_ai_token_and_carries_secret_marker(app_client):
    assert app_client.get("/context").status_code == 401
    assert app_client.get("/context", headers=H(HER_TOKEN)).status_code == 401
    r = app_client.get("/context", headers=H(AI_TOKEN))
    assert r.status_code == 200 and r.text == "约会待办：没有。"
    assert r.headers["x-ephemera-secret"] == "true" and r.headers["x-ephemera-reveal-after"] == "none"
    j = app_client.get("/context", params={"format": "json"}, headers=H(AI_TOKEN)).json()
    assert j == {"text": "约会待办：没有。", "_meta": {"ephemera/secret": True, "ephemera/reveal_after": None}}
    assert inbox.activity()["context"] is not None


def test_her_api_refuses_ai_token(app_client):
    assert app_client.get("/api/dates", headers=H(AI_TOKEN)).status_code == 401
    assert app_client.get("/api/dates", headers=H(HER_TOKEN)).status_code == 200


def _rpc(c, method, params=None, tok=AI_TOKEN, rid=1, session=None):
    h = {**H(tok), "Accept": "application/json, text/event-stream", "Content-Type": "application/json",
         "MCP-Protocol-Version": "2025-06-18"}
    if session:
        h["mcp-session-id"] = session
    return c.post("/mcp", headers=h,
                  content=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}))


def _session(c, name="t"):
    r = _rpc(c, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": name, "version": "0"}})
    assert r.status_code == 200, r.text
    sid = r.headers["mcp-session-id"]
    c.post("/mcp", headers={**H(AI_TOKEN), "Accept": "application/json, text/event-stream",
                            "Content-Type": "application/json", "mcp-session-id": sid,
                            "MCP-Protocol-Version": "2025-06-18"},
           content=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}))
    return sid


def test_mcp_over_http_lists_calls_and_marks_results_secret(app_client):
    assert _rpc(app_client, "tools/list", tok=HER_TOKEN).status_code == 401
    sid = _session(app_client)
    names = [t["name"] for t in _rpc(app_client, "tools/list", rid=2, session=sid).json()["result"]["tools"]]
    assert names == list(dt.TOOLS)
    res = _rpc(app_client, "tools/call", {"name": "date_open",
                                          "arguments": {"title_en": "A", "date": "2099-01-01", "color": "rose"}},
               rid=3, session=sid).json()["result"]
    assert res["isError"] is False and res["content"][0]["text"].startswith("开好了：约会 #1。")
    assert res["_meta"] == {"ephemera/secret": True, "ephemera/reveal_after": None, "ephemera/plan_ids": [1]}
    res = _rpc(app_client, "tools/call", {"name": "date_send", "arguments": {"plan": 1}}, rid=4,
               session=sid).json()["result"]
    assert res["isError"] is True and res["_meta"]["ephemera/secret"] is True


def test_two_mcp_sessions_with_the_same_app_name_cannot_both_claim(app_client):
    make_plan()
    remind.process_reminders(now=T(10, 27, 20, 1))
    s1, s2 = _session(app_client, "same-app"), _session(app_client, "same-app")
    assert s1 != s2

    def claim(sid):
        return _rpc(app_client, "tools/call", {"name": "date_inbox", "arguments": {"op": "claim", "ids": [1]}},
                    rid=9, session=sid).json()["result"]
    a, b = claim(s1), claim(s2)
    assert a["isError"] is False and a["content"][0]["text"].startswith("领取了：待办 1")
    assert b["isError"] is True and b["content"][0]["text"].startswith("别人在处理，领不走：待办 1（same-app）")
    assert raw("SELECT claimed_by FROM ai_inbox") == [(f"pull:{s1}",)]


def test_result_meta_reveal_after_once_the_date_is_closed():
    pid = make_plan()
    assert dt.result_meta("date_view", {"plan": pid}, "", now=NOW0)["ephemera/reveal_after"] is None
    ok(dp.close(pid, "好", now=T(10, 28, 23)))
    m = dt.result_meta("date_view", {"plan": pid}, "", now=T(10, 28, 23, 5))
    assert m["ephemera/reveal_after"] == T(10, 28, 23).timestamp() and m["ephemera/plan_ids"] == [pid]
    assert dt.result_meta("date_view", {}, "", now=NOW0) == {"ephemera/secret": True, "ephemera/reveal_after": None,
                                                              "ephemera/plan_ids": []}


def test_no_token_means_localhost_only():
    from starlette.testclient import TestClient

    from ephemera_date import server
    with TestClient(server.build_app(run_scheduler=False)) as c:
        assert c.get("/api/dates").status_code == 401
        assert c.get("/context").status_code == 401
    with TestClient(server.build_app(run_scheduler=False), base_url="http://localhost:8791") as c:
        assert c.get("/api/dates").status_code == 200
        assert c.get("/context").status_code == 200


def test_serve_refuses_public_bind_without_tokens(monkeypatch):
    from ephemera_date import server
    with pytest.raises(SystemExit):
        server.main(["serve", "--host", "0.0.0.0"])
    monkeypatch.setenv("EPHEMERA_HER_TOKEN", "same")
    monkeypatch.setenv("EPHEMERA_AI_TOKEN", "same")
    with pytest.raises(SystemExit):
        server.main(["serve"])
