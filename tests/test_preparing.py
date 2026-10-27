"""· 准备中:构思中的约会她看得到进度、能留一句话,内容看不到。

临时库(conftest)、假时钟、禁网络。重点=不漏:进度里不许出现名字/颜色/站的任何文字。
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime

import httpx
import pytest

from conftest import local_client, local_tools
from ephemera_date import config
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from conftest import TZ

NOW0 = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)
DAY = "2026-10-26"
SECRETS = ("EMPTY STOMACH", "粥屋", "南湖区小巷", "白い湯気", "到站给她的话", "湯気の立つ白い粥",
           "鳥居の下", "rose", "不许看手机", "小卡正文")


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    assert str(tmp_path) in config.db_path()
    clock = {"now": NOW0}
    monkeypatch.setattr(dt, "_now", lambda: clock["now"])

    dp._connect().close()
    yield clock


T = local_tools()


def call(name, **args):
    out = T[name](args)
    if asyncio.iscoroutine(out):
        out = asyncio.run(out)
    text, err = out
    assert not err, text
    return text


def _open() -> int:
    text = call("date_open", title_en="EMPTY STOMACH\nFULL MOON", date=DAY, color="rose")
    return int(re.search(r"约会 #(\d+)", text).group(1))


def _stops(pid):
    return [s["id"] for s in dp.snapshot(pid, now=NOW0)["state"]["stops"]]


def _full(pid):
    """写满到能寄出(含契约书、小卡、画面描述)。"""
    call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30", title="粥屋", address="南湖区小巷1-1",
         clue="白い湯気", note="到站给她的话", reveal_at="12:00", art_hint="湯気の立つ白い粥", lat=35.7, lng=139.7)
    call("date_edit", plan=pid, op="add_stop", kind="walk", time="16:15", title="鳥居の下", address="南湖区2-2",
         clue="赤い")
    call("date_edit", plan=pid, op="set_prep", items=[{"section": "bring", "text": "伞"}])
    call("date_edit", plan=pid, op="set_contract", contract=["不许看手机"])
    call("date_edit", plan=pid, op="set_card", text="小卡正文")


def _prep_one(now=NOW0):
    got = dp.her_preparing(now=now)
    assert len(got) == 1
    return got[0]


# ── 不漏 ────────────────────────────────────────────────────────────────────────────
def test_progress_is_whitelist_and_leaks_nothing():
    pid = _open()
    _full(pid)
    v = _prep_one()
    assert set(v) == {"id", "date", "last_edited_at", "stops", "legs", "prep", "contract", "card", "art",
                      "missing", "conflicts", "ready", "notes"}
    blob = json.dumps(v, ensure_ascii=False)
    for s in SECRETS:
        assert s not in blob, s
    assert v["date"] == DAY and v["stops"] == {"count": 2, "complete": 2}
    assert v["contract"] is True and v["card"] is True and v["prep"] == 1
    assert v["art"] == {"drawn": 0, "planned": 1}
    assert v["ready"] is True and v["missing"] == [] and v["conflicts"] == 0


def test_missing_only_categories_and_counts():
    pid = _open()
    call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30")
    call("date_edit", plan=pid, op="add_stop", kind="walk", time="16:15", title="粥屋")
    v = _prep_one()
    got = {m["what"]: m["count"] for m in v["missing"]}
    assert got["stop_title"] == 1 and got["stop_address"] == 2 and got["stop_clue"] == 2
    assert got["first_reveal"] == 1 and got["prep"] == 1
    assert v["stops"] == {"count": 2, "complete": 0} and v["ready"] is False
    assert "粥屋" not in json.dumps(v, ensure_ascii=False)


def test_empty_draft_and_only_drafts_listed(_env):
    pid = _open()
    v = _prep_one()
    assert v["stops"]["count"] == 0 and {"what": "stops", "count": 1} in v["missing"]
    _full(pid)
    call("date_send", plan=pid)
    assert dp.her_preparing(now=NOW0) == []                  # 寄出后=信封,不再是准备中
    pid2 = _open()
    assert [p["id"] for p in dp.her_preparing(now=NOW0)] == [pid2]
    assert dp.her_preparing(now=datetime(2026, 10, 27, 9, 0, tzinfo=TZ)) == []   # 过了日子没寄出=不列


# ── 留一句话 ────────────────────────────────────────────────────────────────────────
def test_note_does_not_touch_plan_or_last_edited():
    pid = _open()
    before = dp.snapshot(pid, now=NOW0)["state"]["plan"]
    later = datetime(2026, 10, 21, 12, 0, tzinfo=TZ)
    v = dp.her_leave_note(pid, "  要记得订位哦  ", now=later)
    after = dp.snapshot(pid, now=later)["state"]["plan"]
    assert (after["version"], after["updated_at"]) == (before["version"], before["updated_at"])
    assert v["last_edited_at"] == before["updated_at"]
    assert [n["text"] for n in v["notes"]] == ["要记得订位哦"]


@pytest.mark.parametrize("text,status", [("", 400), ("   ", 400), ("字" * 101, 400), ("a\x07b", 400), (None, 400)])
def test_note_validation(text, status):
    pid = _open()
    with pytest.raises(dp.NoteError) as e:
        dp.her_leave_note(pid, text, now=NOW0)
    assert e.value.status == status


def test_note_only_on_preparing_plans():
    with pytest.raises(dp.NoteError) as e:
        dp.her_leave_note(999, "x", now=NOW0)
    assert e.value.status == 404
    pid = _open()
    with pytest.raises(dp.NoteError) as e:                   # 过了日子
        dp.her_leave_note(pid, "x", now=datetime(2026, 10, 27, 9, 0, tzinfo=TZ))
    assert e.value.status == 404
    _full(pid)
    call("date_send", plan=pid)
    with pytest.raises(dp.NoteError) as e:                   # 寄出后
        dp.her_leave_note(pid, "x", now=NOW0)
    assert e.value.status == 404


def test_note_cap():
    pid = _open()
    for i in range(dp.NOTES_PER_PLAN):
        dp.her_leave_note(pid, f"第{i}句", now=NOW0)
    with pytest.raises(dp.NoteError) as e:
        dp.her_leave_note(pid, "再一句", now=NOW0)
    assert e.value.status == 409


def test_delete_plan_drops_notes():
    pid = _open()
    dp.her_leave_note(pid, "x", now=NOW0)
    call("date_edit", plan=pid, op="delete_plan")
    conn = dp._connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM date_notes").fetchone()[0] == 0
    finally:
        conn.close()


# ── 他那边 ──────────────────────────────────────────────────────────────────────────
def test_he_sees_notes_in_detail_and_fresh_ones_in_ledger(_env):
    pid = _open()
    t1 = datetime(2026, 10, 21, 9, 30, tzinfo=TZ)
    dp.her_leave_note(pid, "要记得订位哦", now=t1)
    _env["now"] = datetime(2026, 10, 21, 10, 0, tzinfo=TZ)
    detail = call("date_view", plan=pid)
    assert "她留的话：10/21 09:30「要记得订位哦」" in detail
    assert "她现在能看到：准备进度" in detail and "内容看不到" in detail
    led, _ = dt.ledger_block(now=_env["now"])
    assert "她留的话（你上次动笔之后）：「要记得订位哦」" in led
    call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30")    # 他动笔了
    led2, _ = dt.ledger_block(now=_env["now"])
    assert "她留的话" not in led2
    assert "要记得订位哦" in call("date_view", plan=pid)                       # 详情里一直在


def test_open_description_tells_him():
    d = next(t for t in dt.tool_schemas() if t["name"] == "date_open")["description"]
    assert "她能看到有一场约会在准备" in d and "她可以给你留一句话" in d and "她看不到。" not in d


# ── 她的两个口 ──────────────────────────────────────────────────────────────────────
def _client():
    return local_client()


def test_routes(monkeypatch):
    monkeypatch.setattr(dp, "_now", lambda: NOW0)
    pid = _open()
    c = _client()
    r = c.get("/api/dates/preparing")
    assert r.status_code == 200 and [p["id"] for p in r.json()["plans"]] == [pid]
    r = c.post(f"/api/dates/{pid}/note", json={"text": "要记得订位哦"})
    assert r.status_code == 200 and r.json()["notes"][0]["text"] == "要记得订位哦"
    assert c.post(f"/api/dates/{pid}/note", json={"text": ""}).status_code == 400
    assert c.post("/api/dates/999/note", json={"text": "x"}).status_code == 404
    assert c.get(f"/api/dates/{pid}").status_code == 404                  # 单个约会读口仍不给构思中


# ── 补:并发定序 / 午夜 / 取末三条 / 坐标 ─────────────────────────────
def test_fresh_is_ordered_by_write_not_clock(_env):
    """留言时刻早于他那笔写入、但写入顺序在后(等锁交错)→ 仍算「你上次动笔之后」。"""
    pid = _open()
    _env["now"] = datetime(2026, 10, 21, 10, 0, tzinfo=TZ)
    call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30")       # 他 10:00 写
    dp.her_leave_note(pid, "晚到的话", now=datetime(2026, 10, 21, 9, 59, tzinfo=TZ))   # 时刻更早,写入在后
    led, _ = dt.ledger_block(now=_env["now"])
    assert "「晚到的话」" in led
    call("date_edit", plan=pid, op="update_stop", stop_id=_stops(pid)[0], title="x")
    assert "她留的话" not in dt.ledger_block(now=_env["now"])[0]


def test_ledger_keeps_last_three(_env):
    pid = _open()
    for i in range(5):
        dp.her_leave_note(pid, f"第{i}句", now=NOW0)
    led, _ = dt.ledger_block(now=NOW0)
    assert "「第2句」 · 「第3句」 · 「第4句」" in led and "第1句" not in led


def test_note_expiry_judged_after_lock(monkeypatch):
    pid = _open()
    monkeypatch.setattr(dp, "_now", lambda: datetime(2026, 10, 27, 0, 0, 1, tzinfo=TZ))
    with pytest.raises(dp.NoteError) as e:
        dp.her_leave_note(pid, "x")                           # now=None:拿锁后取时刻
    assert e.value.status == 404


def _strip(v):
    return {k: v[k] for k in v if k not in ("last_edited_at", "notes")}


def test_progress_has_no_coords():
    pid = _open()
    call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30", title="粥屋", lat=35.7123, lng=139.7456)
    blob = json.dumps(_prep_one(), ensure_ascii=False)
    assert "35.71" not in blob and "139.74" not in blob


def test_note_cap_under_concurrency():
    import threading
    pid = _open()
    for i in range(dp.NOTES_PER_PLAN - 1):
        dp.her_leave_note(pid, f"{i}", now=NOW0)
    res = []

    def go():
        try:
            dp.her_leave_note(pid, "抢", now=NOW0)
            res.append("ok")
        except dp.NoteError as e:
            res.append(e.status)
    ts = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(res, key=str) == [409, "ok"]


def test_note_expiry_real_lock_wait(monkeypatch):
    """真的等锁——锁被别人占着时跨了午夜,放锁后按写入时刻判过期。"""
    import threading
    import time
    pid = _open()
    clock = {"now": datetime(2026, 10, 26, 23, 59, 59, tzinfo=TZ)}
    monkeypatch.setattr(dp, "_now", lambda: clock["now"])
    holder = dp._connect()
    holder.execute("BEGIN IMMEDIATE")
    out = {}

    def go():
        try:
            dp.her_leave_note(pid, "x")
            out["r"] = "ok"
        except dp.NoteError as e:
            out["r"] = e.status
    t = threading.Thread(target=go)
    t.start()
    time.sleep(0.3)                                  # 留言在等锁(请求时还是 10/26)
    clock["now"] = datetime(2026, 10, 27, 0, 0, 1, tzinfo=TZ)
    holder.execute("COMMIT")
    holder.close()
    t.join(10)
    assert out["r"] == 404
