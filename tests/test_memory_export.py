"""Structured memory export (one JSON entry per finished date): schema, versioned rewrite, deletion.

tmp data dir + tmp export dir, fake clock, no network.
"""
from __future__ import annotations

import json
from datetime import datetime

import pytest

from conftest import TZ
from ephemera_date import config, memory
from ephemera_date import her as date_her
from ephemera_date import plan as dp
from test_memory_card import T, make_done, ok, sql


@pytest.fixture(autouse=True)
def _export(tmp_path, monkeypatch):
    monkeypatch.setenv("EPHEMERA_MEMORY_EXPORT_DIR", str(tmp_path / "export"))


def run():
    return memory.run_once()["json"]


def doc(pid):
    return json.loads((config.memory_export_dir() / f"date-{pid}.json").read_text("utf-8"))


def test_export_only_finished_dates_with_full_schema(monkeypatch):
    monkeypatch.setenv("EPHEMERA_TOGETHER_SINCE", "2026-10-01")
    pid = make_done()
    draft = ok(dp.open_plan("Not Yet", "2026-11-20", "sky", now=T(10, 20)))["plan_id"]
    sql("UPDATE date_stops SET her_line='他真的早到了' WHERE plan_id=? AND title='梧桐站'", (pid,))
    conn = date_her._connect()
    try:
        sid = conn.execute("SELECT id FROM date_stops WHERE plan_id=? AND title='Le Petit Pot'", (pid,)).fetchone()[0]
        conn.execute("INSERT INTO date_her_photos (plan_id, stop_id, file, mime, bytes, caption, created_at)"
                     " VALUES (?, ?, 'x.jpg', 'image/jpeg', 1, '布丁', 1)", (pid, sid))
        conn.execute("INSERT INTO date_her_photos (plan_id, stop_id, file, mime, bytes, caption, created_at)"
                     " VALUES (?, NULL, 'y.jpg', 'image/jpeg', 1, '一整叠', 2)", (pid,))
    finally:
        conn.close()
    dp.her_set_letter(pid, "她的信", now=T(10, 29))
    ok(dp.edit(pid, "write_reply", dict(text="他的回信"), now=T(10, 29, 1)))
    assert run() == {pid: "written"} and draft not in run()
    d = doc(pid)
    assert d["schema"] == memory.EXPORT_SCHEMA and d["version"] == 1
    assert d["id"] == pid and d["name"] == "The Evening Screening" and d["title_zh"] is None
    assert d["date"] == "2026-10-28" and d["together_day"] == 28
    assert d["names"] == {"her": "她", "him": "他"}
    assert [(s["n"], s["time"], s["title"], s["address"], s["label"]) for s in d["stops"]] == [
        (1, "19:00", "梧桐站", "青石区梧桐路3", "集合"),
        (2, "19:30", "Le Petit Pot", "青石区柳岸1", "晚餐"),
        (3, "21:30", "约会", "柳岸河堤", "散步")]
    assert d["stops"][0]["her_line"] == "他真的早到了" and d["stops"][1]["stay_until"] == "21:00"
    assert d["letters"] == {"her": "她的信", "him": "他的回信"}
    assert d["photos"] == [{"stop_n": 2, "caption": "布丁"}, {"stop_n": None, "caption": "一整叠"}]
    assert d["quote"] == "那天很好" and d["card"] == "电影票其实是两张" and d["contract"] == ["不许看手机"]
    assert d["closed_at"] == datetime(2026, 10, 28, 23, 30, tzinfo=TZ).isoformat()
    assert isinstance(d["plan_version"], int) and d["exported_at"]


def test_unchanged_not_rewritten_change_bumps_version_same_file():
    pid = make_done()
    run()
    f = config.memory_export_dir() / f"date-{pid}.json"
    m1 = f.stat().st_mtime_ns
    assert run() == {pid: "same"} and f.stat().st_mtime_ns == m1
    sql("UPDATE date_plans SET title_en='Renamed' WHERE id=?", (pid,))
    assert run() == {pid: "updated"}
    d = doc(pid)
    assert d["version"] == 2 and d["name"] == "Renamed"
    assert sorted(p.name for p in config.memory_export_dir().iterdir()) == [f"date-{pid}.json"]   # no temp left


def test_deleted_date_removes_its_json():
    a = make_done(title="Alpha")
    b = make_done(title="Beta")
    run()
    sql("DELETE FROM date_plans WHERE id=?", (a,))
    assert run() == {b: "same", a: "deleted"}
    assert not (config.memory_export_dir() / f"date-{a}.json").exists()
    assert (config.memory_export_dir() / f"date-{b}.json").exists()
    assert run() == {b: "same"}


def test_hand_deleted_export_not_recreated_until_content_changes():
    pid = make_done()
    run()
    f = config.memory_export_dir() / f"date-{pid}.json"
    f.unlink()                                          # a consumer took it
    assert run() == {pid: "same"} and not f.exists()
    sql("UPDATE date_stops SET note='改过' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert run() == {pid: "updated"} and doc(pid)["version"] == 2


def test_export_unset_writes_nothing(monkeypatch):
    make_done()
    monkeypatch.delenv("EPHEMERA_MEMORY_EXPORT_DIR")
    assert memory.run_once() == {"cards": {}, "json": {}}


def test_export_lease_lost_writes_nothing():
    pid = make_done()
    flips = iter([True, False])
    assert memory.run_once(still_owner=lambda: next(flips, False))["json"] == {pid: "stopped"}
    assert not (config.memory_export_dir() / f"date-{pid}.json").exists()
    assert run() == {pid: "written"} and doc(pid)["version"] == 1


def test_cards_and_export_independent(tmp_path, monkeypatch):
    """Both on: one round writes both; a broken card vault does not stop the export."""
    blocker = tmp_path / "file"
    blocker.write_text("x")
    monkeypatch.setenv("EPHEMERA_CARDS_DIR", str(blocker))
    pid = make_done()
    out = memory.run_once()
    assert out["cards"][pid].startswith("error:") and out["json"] == {pid: "written"}
