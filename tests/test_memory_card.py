"""After-date event cards (lorecards format): generation, kept parts, renames, deletion / archive, races,
failures, the follow-up ask, read-only scanning.

tmp data dir + tmp card vault, fake clock, no network. Dates are built through the engine's public writes.
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

from conftest import TZ
from ephemera_date import config, memory, scheduler
from ephemera_date import her as date_her
from ephemera_date import plan as dp


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


NOW0 = T(10, 20, 10)


@pytest.fixture(autouse=True)
def _vault(tmp_path, monkeypatch):
    monkeypatch.setenv("EPHEMERA_CARDS_DIR", str(tmp_path / "vault"))


def ok(r):
    assert r["ok"], r["errors"]
    return r


def make_done(title="The Evening\nScreening", day="2026-10-28", quote="那天很好"):
    pid = ok(dp.open_plan(title, day, "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="青石区梧桐路3",
                                     clue="改札右手边", reveal_at="17:30", note="我会早到"), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="19:30", stay_until="21:00", title="Le Petit Pot",
                                     address="青石区柳岸1", clue="河边的小门", note="点你想吃的"), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="walk", time="21:30", title="约会", address="柳岸河堤",
                                     clue="沿河"), now=NOW0))
    s1, s2, s3 = [s["id"] for s in dp.snapshot(pid, now=NOW0)["state"]["stops"]]
    ok(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="walk", minutes=6, depart_time="19:20"), now=NOW0))
    ok(dp.edit(pid, "set_leg", dict(to_stop=s3, mode="walk", minutes=8, depart_time="21:15"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "一件薄外套"}]), now=NOW0))
    ok(dp.edit(pid, "set_contract", dict(items=["不许看手机"]), now=NOW0))
    ok(dp.edit(pid, "set_card", dict(text="电影票其实是两张"), now=NOW0))
    ok(dp.send(pid, now=NOW0))
    d = datetime.fromisoformat(day)
    ok(dp.close(pid, quote, now=datetime(d.year, d.month, d.day, 23, 30, tzinfo=TZ)))
    return pid


def run():
    return memory.run_once()["cards"]


def root() -> Path:
    return config.cards_dir() / "events"


def cards() -> list[Path]:
    return sorted(root().glob("*.md")) if root().is_dir() else []


def parse(p: Path):
    fm, body, problem = memory.split_frontmatter(p.read_text("utf-8"))
    assert problem is None
    return fm, memory.split_sections(body, memory.Schema())


def checkup(p: Path) -> list[str]:
    """lorecards `check` rules for one card (the real CLI runs in test_memory_lorecards.py)."""
    fm, body, problem = memory.split_frontmatter(p.read_text("utf-8"))
    out = []
    if problem:
        return [problem]
    kws = memory.parse_str_list(fm.get("keywords"))
    if not kws:
        out.append("no_kw")
    if [k for k in kws if k.casefold() in memory.LORECARDS_GENERIC or len(k) == 1]:
        out.append("generic_kw")
    if str(fm.get("title") or p.stem) != p.stem:
        out.append("title_mismatch")
    if not body.strip():
        out.append("no_body")
    return out


def sql(q, args=()):
    conn = dp._connect()
    try:
        conn.execute(q, args)
    finally:
        conn.close()


def state(pid) -> dict:
    conn = dp._connect()
    try:
        conn.row_factory = sqlite3.Row
        r = conn.execute("SELECT * FROM ephemera_memory_state WHERE plan_id=?", (pid,)).fetchone()
        return dict(r) if r else {}
    finally:
        conn.close()


def add_followup(p: Path, text: str) -> None:
    p.write_text(p.read_text("utf-8").replace("## followup\n", f"## followup\n{text}\n"), "utf-8")


# ── generation ────────────────────────────────────────────────────────────────────
def test_card_written_for_done_plan_only():
    pid = make_done()
    draft = ok(dp.open_plan("Not Yet", "2026-11-20", "sky", now=NOW0))["plan_id"]
    r = run()
    assert r == {pid: "written"} and draft not in r
    [p] = cards()
    assert p.name == "约会·2026-10-28·The Evening Screening.md"
    fm, secs = parse(p)
    assert fm["kind"] == "event" and fm["title"] == p.stem
    assert list(fm)[:3] == ["kind", "title", "keywords"]
    assert secs["when"].startswith("2026-10-28（周三）")
    assert "19:00、19:30–21:00、21:30" in secs["when"]
    assert secs["who"] == "她、他"
    what = secs["what"].splitlines()
    assert what[0] == "- 19:00 · 梧桐站 · 集合"
    assert "  备注：我会早到" in what and "  线索：改札右手边" in what
    assert what[-1] == "那一句话：那天很好"
    assert secs["stance"] == "" and secs["followup"] == ""
    assert checkup(p) == []


def test_keywords_no_generic_words():
    make_done()
    run()
    [p] = cards()
    fm, _ = parse(p)
    assert fm["keywords"] == ["The Evening Screening", "梧桐站", "Le Petit Pot", "10月28日"]
    assert "约会" not in fm["keywords"]                     # a stop called 「约会」 is not a keyword either


def test_unchanged_not_rewritten_and_change_updates():
    pid = make_done()
    assert run() == {pid: "written"}
    p = cards()[0]
    m1 = p.stat().st_mtime_ns
    assert run() == {pid: "same"}
    assert p.stat().st_mtime_ns == m1
    sql("UPDATE date_stops SET note='改过的备注' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert run() == {pid: "updated"}
    assert "  备注：改过的备注" in parse(p)[1]["what"]


def test_her_lines_and_photo_captions_go_to_stance():
    pid = make_done()
    sql("UPDATE date_stops SET her_line='他真的早到了' WHERE plan_id=? AND title='梧桐站'", (pid,))
    conn = dp._connect()
    sid = next(s["id"] for s in dp._load(conn, pid)["stops"] if s["title"] == "Le Petit Pot")
    conn.close()
    conn = date_her._connect()
    try:
        conn.execute("INSERT INTO date_her_photos (plan_id, stop_id, file, mime, bytes, caption, created_at)"
                     " VALUES (?, ?, 'x.jpg', 'image/jpeg', 1, '布丁', 1)", (pid, sid))
    finally:
        conn.close()
    run()
    att = parse(cards()[0])[1]["stance"].splitlines()
    assert att == ["- 19:00 梧桐站：他真的早到了", "- 19:30 Le Petit Pot 照片：布丁"]


# ── follow-up / hand edits / rename ───────────────────────────────────────────────
def test_followup_and_hand_keywords_survive_rewrite():
    pid = make_done()
    run()
    p = cards()[0]
    # the AI wrote a follow-up; the user added a keyword, an alias and turned injection off
    text = p.read_text("utf-8").replace("## followup\n", "## followup\n后来又去了一次那家店。\n")
    text = text.replace("keywords: [", "inject: false\naliases: [河边那晚]\nkeywords: [河边, ")
    p.write_text(text, "utf-8")
    sql("UPDATE date_stops SET title='梧桐駅' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert run() == {pid: "updated"}
    fm, secs = parse(p)
    assert secs["followup"] == "后来又去了一次那家店。"
    assert "梧桐駅" in fm["keywords"] and "梧桐站" not in fm["keywords"]       # generated keyword replaced
    assert "河边" in fm["keywords"]                                          # hand-added one kept
    assert fm["aliases"] == ["河边那晚"] and fm["inject"] is False


def test_rename_moves_card_keeps_followup():
    pid = make_done()
    run()
    old = cards()[0]
    add_followup(old, "他记得。")
    sql("UPDATE date_plans SET title_en='River / Walk' WHERE id=?", (pid,))
    assert run() == {pid: "renamed"}
    [p] = cards()                                           # never two cards
    assert p.name == "约会·2026-10-28·River Walk.md"
    fm, secs = parse(p)
    assert secs["followup"] == "他记得。"
    assert "River Walk" in fm["keywords"] and "The Evening Screening" not in fm["keywords"]


def test_same_day_same_title_two_cards():
    a = make_done(title="Twin")
    b = make_done(title="Twin")
    run()
    names = [p.name for p in cards()]
    assert names == ["约会·2026-10-28·Twin.md", f"约会·2026-10-28·Twin·{b}.md"] and a != b


def test_archived_or_deleted_card_not_resurrected_when_unchanged():
    pid = make_done()
    run()
    cards()[0].unlink()
    assert run() == {pid: "same"}
    assert cards() == []
    sql("UPDATE date_stops SET note='改过' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert run() == {pid: "removed"}          # changed content does not bring a deleted card back either
    assert run() == {pid: "same"}
    assert cards() == []


# ── failures never block ──────────────────────────────────────────────────────────
def test_write_failure_recorded_never_raises_then_retries(tmp_path, monkeypatch):
    pid = make_done()
    blocker = tmp_path / "not_a_dir"
    blocker.write_text("x")
    good = os.environ["EPHEMERA_CARDS_DIR"]
    with monkeypatch.context() as m:
        m.setenv("EPHEMERA_CARDS_DIR", str(blocker))          # the vault cannot be a directory → no card
        r = run()
        assert r[pid].startswith("error:")
        st = state(pid)
        assert st["card_error"] and st["card_hash"] is None
        pid2 = ok(dp.open_plan("Next", "2026-11-30", "sky", now=NOW0))["plan_id"]   # dates still write
        assert pid2
    assert os.environ["EPHEMERA_CARDS_DIR"] == good
    assert run()[pid] == "written"                             # next round retries
    assert state(pid)["card_error"] is None


def test_one_bad_plan_does_not_block_others(monkeypatch):
    a = make_done(title="Alpha")
    b = make_done(title="Beta", day="2026-10-29")
    real = memory.build_fields

    def boom(st, captions=None):
        if st["plan"]["id"] == a:
            raise ValueError("坏数据")
        return real(st, captions)
    with monkeypatch.context() as m:
        m.setattr(memory, "build_fields", boom)
        r = run()
    assert r[a].startswith("error:") and r[b] == "written"


def test_scheduler_job_survives_errors(monkeypatch):
    calls = []

    def bad(**kw):
        calls.append(1)
        raise RuntimeError("x")
    with monkeypatch.context() as m:
        m.setattr(memory, "run_once", bad)
        out = scheduler.tick()
    assert calls == [1] and "error" in out["memory"]
    assert "reminders" in out                                  # the other jobs ran


# ── card_after: ask the AI for the follow-up ──────────────────────────────────────
def asks(pid):
    conn = dp._connect()
    try:
        return [tuple(r) for r in conn.execute("SELECT what, done_at IS NOT NULL FROM date_asks WHERE plan_id=?"
                                                " AND what='card_after'", (pid,))]
    finally:
        conn.close()


def test_card_after_ask_created_once_then_completed():
    pid = make_done()
    run()
    run()
    assert asks(pid) == [("card_after", 0)]                    # first card written → one ask
    add_followup(cards()[0], "写好了。")
    run()
    run()
    assert asks(pid) == [("card_after", 1)]


def test_card_after_ask_through_engine_functions(monkeypatch):
    pid = make_done()
    log = []
    with monkeypatch.context() as m:
        m.setattr(dp, "add_ask", lambda p, w, **k: log.append(("add", p, w)) or True)
        m.setattr(dp, "complete_ask", lambda p, w, **k: log.append(("done", p, w)) or True)
        run()
        run()
        assert log == [("add", pid, "card_after")]
        add_followup(cards()[0], "写好了。")
        run()
        run()
        assert log == [("add", pid, "card_after"), ("done", pid, "card_after")]


def test_followup_written_before_ask_needs_no_ask(monkeypatch):
    pid = make_done()
    memory.queue_followup(pid, "早写了。")                      # queued before the first card
    log = []
    with monkeypatch.context() as m:
        m.setattr(dp, "add_ask", lambda p, w, **k: log.append(("add", p, w)) or True)
        m.setattr(dp, "complete_ask", lambda p, w, **k: log.append(("done", p, w)) or True)
        assert run() == {pid: "written"}
        run()
        assert log == []
    assert parse(cards()[0])[1]["followup"] == "早写了。"


# ── pure functions ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("raw,want", [
    ("The Evening\nScreening", "The Evening Screening"),
    ("a/b\\c", "a b c"),
    ("..hidden..", "hidden"),
    ("\n\t", ""),
])
def test_clean_title(raw, want):
    assert memory.clean_title(raw) == want


def test_card_key_falls_back_to_id_when_title_empty():
    assert memory.card_key({"id": 7, "date": "2026-01-02", "title_en": "\n"}) == "约会·2026-01-02·7"
    assert memory.safe_key(memory.card_key({"id": 7, "date": "2026-01-02", "title_en": "x/../y"}))


# ── unique names; renames take the original card as the source ────────────────────
HAND = "---\nkind: event\ntitle: 手写的\nkeywords: [手写的词]\n---\n## followup\n手写的后续\n"


def test_name_taken_by_hand_card_on_disk():
    root().mkdir(parents=True)
    base = "约会·2026-10-28·The Evening Screening"
    (root() / f"{base}.md").write_text(HAND, "utf-8")
    pid = make_done()
    (root() / f"{base}·{pid}.md").write_text(HAND, "utf-8")          # the ·id name is taken too: go on
    assert run() == {pid: "written"}
    assert (root() / f"{base}.md").read_text("utf-8") == HAND
    assert (root() / f"{base}·{pid}.md").read_text("utf-8") == HAND
    p = root() / f"{base}·{pid}·2.md"
    assert parse(p)[0]["title"] == p.stem
    assert run() == {pid: "same"}                                    # no renaming back and forth


def test_rename_into_occupied_name_keeps_both_and_uses_original_card():
    pid = make_done()
    run()
    orig = cards()[0]
    orig.write_text(orig.read_text("utf-8").replace("## followup\n", "## followup\n原卡的后续\n")
                    .replace("keywords: [", "keywords: [原卡手加, "), "utf-8")
    taken = root() / "约会·2026-10-28·Riverside.md"
    taken.write_text(HAND, "utf-8")                                   # the new name is a hand-written card
    sql("UPDATE date_plans SET title_en='Riverside' WHERE id=?", (pid,))
    assert run() == {pid: "renamed"}
    assert taken.read_text("utf-8") == HAND                           # not one character touched
    assert not orig.exists()
    p = root() / f"约会·2026-10-28·Riverside·{pid}.md"
    fm, secs = parse(p)
    assert secs["followup"] == "原卡的后续" and "原卡手加" in fm["keywords"] and "手写的词" not in fm["keywords"]


def test_rename_into_other_plans_card_name():
    a = make_done(title="Alpha")
    b = make_done(title="Beta")
    run()
    pb = root() / "约会·2026-10-28·Beta.md"
    add_followup(pb, "B 的后续")
    sql("UPDATE date_plans SET title_en='Beta' WHERE id=?", (a,))
    assert run() == {a: "renamed", b: "same"}
    assert parse(pb)[1]["followup"] == "B 的后续"
    assert (root() / f"约会·2026-10-28·Beta·{a}.md").exists()
    assert not (root() / "约会·2026-10-28·Alpha.md").exists()


def test_date_moved_renames_card():
    pid = make_done()
    run()
    add_followup(cards()[0], "改日子之前写的")
    sql("UPDATE date_plans SET date='2026-10-30' WHERE id=?", (pid,))
    assert run() == {pid: "renamed"}
    [p] = cards()
    fm, secs = parse(p)
    assert p.name == "约会·2026-10-30·The Evening Screening.md" and secs["followup"] == "改日子之前写的"
    assert "10月30日" in fm["keywords"] and "10月28日" not in fm["keywords"]


# ── changed / deleted between read and landing → give up this round ───────────────
def _during_render(m, fn):
    real = memory.render

    def wrapped(*a, **k):
        out = real(*a, **k)
        fn()
        return out
    m.setattr(memory, "render", wrapped)


def test_concurrent_edit_between_read_and_replace_is_not_lost(monkeypatch):
    pid = make_done()
    run()
    p = cards()[0]
    sql("UPDATE date_stops SET note='新备注' WHERE plan_id=? AND title='梧桐站'", (pid,))
    with monkeypatch.context() as m:
        _during_render(m, lambda: add_followup(p, "刚存的后续"))
        assert run() == {pid: "raced"}
    assert parse(p)[1]["followup"] == "刚存的后续"                     # not overwritten this round
    assert "新备注" not in parse(p)[1]["what"]
    assert run() == {pid: "updated"}                                  # next round re-reads: both are there
    _, secs = parse(p)
    assert secs["followup"] == "刚存的后续" and "  备注：新备注" in secs["what"]


def test_deleted_between_read_and_replace_not_resurrected(monkeypatch):
    pid = make_done()
    run()
    p = cards()[0]
    sql("UPDATE date_stops SET note='新备注' WHERE plan_id=? AND title='梧桐站'", (pid,))
    with monkeypatch.context() as m:
        _during_render(m, p.unlink)
        assert run() == {pid: "raced"}
    assert cards() == []
    assert run() == {pid: "removed"}
    assert cards() == []


def test_archived_card_not_resurrected():
    pid = make_done()
    run()
    p = cards()[0]
    arch = config.cards_dir() / "_archive" / "event"                  # lorecards archive_card destination
    arch.mkdir(parents=True)
    p.rename(arch / p.name)
    sql("UPDATE date_plans SET title_en='Renamed' WHERE id=?", (pid,))
    assert run() == {pid: "removed"}
    assert cards() == [] and (arch / p.name).exists()


def test_first_write_target_appears_midway_not_overwritten(monkeypatch):
    pid = make_done()
    target = root() / "约会·2026-10-28·The Evening Screening.md"

    def hand_saves():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(HAND, "utf-8")
    with monkeypatch.context() as m:
        _during_render(m, hand_saves)
        assert run() == {pid: "raced"}
    assert target.read_text("utf-8") == HAND
    assert run() == {pid: "written"}                                  # next round steps aside
    assert target.read_text("utf-8") == HAND
    assert (root() / f"约会·2026-10-28·The Evening Screening·{pid}.md").exists()


def test_rename_original_edited_after_new_written_rolls_back(monkeypatch):
    pid = make_done()
    run()
    orig = cards()[0]
    sql("UPDATE date_plans SET title_en='Riverside' WHERE id=?", (pid,))
    real = memory._write_checked

    def wrapped(dst, text, src, still_owner=None):
        v = real(dst, text, src, still_owner)
        add_followup(orig, "改名途中写的")
        return v
    with monkeypatch.context() as m:
        m.setattr(memory, "_write_checked", wrapped)
        assert run() == {pid: "raced"}
    assert cards() == [orig]                                          # new card taken back, original kept
    assert run() == {pid: "renamed"}
    [p] = cards()
    assert p.name == "约会·2026-10-28·Riverside.md" and parse(p)[1]["followup"] == "改名途中写的"


# ── scanning is read only ─────────────────────────────────────────────────────────
def test_scan_is_readonly_no_settle_no_engine_connect(monkeypatch):
    pid = make_done()
    with monkeypatch.context() as m:
        def boom(*a, **k):
            raise AssertionError("the scan must not call this")
        m.setattr(dp, "_settle", boom)
        m.setattr(dp, "_connect", boom)
        m.setattr(dp, "_tx", boom)
        got = []
        m.setattr(dp, "add_ask", lambda p, w, **k: got.append(("add", p, w, "conn" in k)) or True)
        m.setattr(dp, "complete_ask", lambda p, w, **k: got.append(("done", p, w)) or True)
        assert run() == {pid: "written"}
        assert got == [("add", pid, "card_after", True)]              # ask through the scan's own connection
    ro = memory._open_ro(config.db_path())
    try:
        with pytest.raises(sqlite3.OperationalError):
            ro.execute("UPDATE date_plans SET title_en='x'")
    finally:
        ro.close()


def test_no_db_or_no_tables_is_quiet(tmp_path):
    assert memory.run_once(path=str(tmp_path / "missing.db")) == {"cards": {}, "json": {}}
    empty = tmp_path / "empty.db"
    sqlite3.connect(str(empty)).close()
    assert memory.run_once(path=str(empty)) == {"cards": {}, "json": {}}


# ── memory details carried over from the home version ─────────────────────────────
def test_photo_without_stop_and_letters_in_card():
    pid = make_done()
    conn = date_her._connect()
    try:
        conn.execute("INSERT INTO date_her_photos (plan_id, stop_id, file, mime, bytes, caption, created_at)"
                     " VALUES (?, NULL, 'y.jpg', 'image/jpeg', 1, '没有具体哪一站', 2)", (pid,))
    finally:
        conn.close()
    dp.her_set_letter(pid, "卡片测试信", now=T(10, 29))
    ok(dp.edit(pid, "write_reply", dict(text="卡片测试回信"), now=T(10, 29, 1)))
    run()
    _, secs = parse(cards()[0])
    assert "- 照片：没有具体哪一站" in secs["stance"].splitlines()
    assert "- 她的信：卡片测试信" in secs["stance"].splitlines()
    assert secs["what"].splitlines()[-1] == "回信：卡片测试回信"
    assert secs["followup"] == ""                                     # never generated


def test_build_fields_tolerates_missing_letters_key():
    f = memory.build_fields({"plan": {"id": 1, "date": "2026-10-28", "title_en": "X", "title_zh": ""}, "stops": []})
    assert f["stance"] == "" and "followup" not in f


def test_together_day_and_names_follow_config(monkeypatch):
    p = {"id": 2, "date": "2026-04-11", "title_en": "Spring\nDay", "title_zh": "春日"}
    assert "在一起" not in memory.build_fields({"plan": p, "stops": []})["when"]
    monkeypatch.setenv("EPHEMERA_TOGETHER_SINCE", "2026-03-15")
    monkeypatch.setenv("EPHEMERA_HER", "小满")
    monkeypatch.setenv("EPHEMERA_HIM", "阿树")
    f = memory.build_fields({"plan": p, "stops": []})
    assert f["when"] == "2026-04-11（周六） · 在一起的第 28 天 · Spring Day（春日）"
    assert f["who"] == "小满、阿树"
    assert memory.build_keywords({"plan": p, "stops": []}) == ["Spring Day", "春日", "4月11日"]


def test_unknown_headings_head_text_private_section_kept():
    pid = make_done()
    run()
    p = cards()[0]
    fm_text, _, body = p.read_text("utf-8").partition("---\n")[2].partition("---\n")
    p.write_text("---\n" + fm_text + "---\n开头她写的一句\n\n" + body +
                 "\n## 照片墙\n第三张最好看\n\n## correspondence\n私下的笔记\n", "utf-8")
    sql("UPDATE date_stops SET note='再改' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert run() == {pid: "updated"}
    text = p.read_text("utf-8")
    _, secs = parse(p)
    assert secs["_head"] == "开头她写的一句"
    assert "## 照片墙\n第三张最好看" in secs["_extra"]
    assert secs["correspondence"] == "私下的笔记"
    assert "  备注：再改" in secs["what"] and text.count("## what") == 1


def test_bad_frontmatter_card_never_rewritten():
    pid = make_done()
    run()
    p = cards()[0]
    broken = "---\nkeywords: [unclosed\n---\n## followup\n手写\n"
    p.write_text(broken, "utf-8")
    sql("UPDATE date_stops SET note='再改' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert run()[pid].startswith("error:")
    assert p.read_text("utf-8") == broken


def test_vault_kinds_yaml_renames_dir_and_sections():
    v = config.cards_dir()
    v.mkdir(parents=True)
    (v / "kinds.yaml").write_text("dirs: {event: 事件}\nsections: {event: [时间, 涉及谁, 经过, 她的态度, 后续]}\n"
                                  "generic_keywords: [Twin]\n", "utf-8")
    pid = make_done(title="Twin")
    run()
    [p] = sorted((v / "事件").glob("*.md"))
    sch = memory.load_schema(v)
    fm, body, _ = memory.split_frontmatter(p.read_text("utf-8"))
    secs = memory.split_sections(body, sch)
    assert secs["时间"].startswith("2026-10-28") and secs["后续"] == ""
    assert "Twin" not in fm["keywords"]                              # the vault's generic word
    assert memory.written_key(pid) == p.stem


def test_lock_file_at_vault_root_and_lock_timeout(monkeypatch):
    pid = make_done()
    run()
    assert (config.cards_dir() / memory.LOCK_NAME).exists()
    sql("UPDATE date_stops SET note='锁住时改的' WHERE plan_id=? AND title='梧桐站'", (pid,))

    import fcntl
    held = open(config.cards_dir() / memory.LOCK_NAME, "a+")          # another process holding the lock
    fcntl.flock(held.fileno(), fcntl.LOCK_EX)
    try:
        monkeypatch.setattr(memory, "LOCK_TIMEOUT_S", 0.2)
        assert run()[pid].startswith("error:")
        assert "备注：锁住时改的" not in parse(cards()[0])[1]["what"]
    finally:
        fcntl.flock(held.fileno(), fcntl.LOCK_UN)
        held.close()
    assert run() == {pid: "updated"}


def test_lease_lost_writes_nothing():
    pid = make_done()
    out = memory.run_once(still_owner=lambda: False)
    assert out.get("stopped") == "lease lost" and cards() == []
    flips = iter([True, False])                                     # lost right before landing
    assert memory.run_once(still_owner=lambda: next(flips, False))["cards"] == {pid: "stopped"}
    assert cards() == []
    assert run() == {pid: "written"}


def test_stdio_never_runs_the_job():
    """stdio = no scheduler; only scheduler.tick calls memory.run_once."""
    import inspect

    from ephemera_date import server
    assert "memory" not in inspect.getsource(server._run_stdio)
    assert "memory.run_once" in inspect.getsource(scheduler.tick)
    pid = make_done()
    scheduler.tick()
    assert [p.name for p in cards()] == ["约会·2026-10-28·The Evening Screening.md"] and pid


def test_card_root_unset_writes_nothing(monkeypatch):
    make_done()
    monkeypatch.delenv("EPHEMERA_CARDS_DIR")
    assert memory.run_once() == {"cards": {}, "json": {}}


def test_scheduler_run_loop_writes_card_while_owner(tmp_path):
    pid = make_done()

    async def main():
        stop = asyncio.Event()
        task = asyncio.create_task(scheduler.run(stop, tick_s=0.05, heartbeat_s=0.05))
        for _ in range(100):
            await asyncio.sleep(0.05)
            if cards():
                break
        stop.set()
        await task
    asyncio.run(main())
    assert [p.stem for p in cards()] == ["约会·2026-10-28·The Evening Screening"]
    assert json.loads(json.dumps(state(pid)))["card_key"] == cards()[0].stem


# ── follow-up column = recent_section; vaults with 4 / 6 event sections ─────────────
def kinds(text: str) -> memory.Schema:
    v = config.cards_dir()
    v.mkdir(parents=True, exist_ok=True)
    (v / "kinds.yaml").write_text(text, "utf-8")
    return memory.load_schema(v)


def vparse(p: Path, sch: memory.Schema):
    fm, body, problem = memory.split_frontmatter(p.read_text("utf-8"))
    assert problem is None
    return fm, memory.split_sections(body, sch)


def put_section(p: Path, name: str, text: str) -> None:
    """What lorecards write_card(update_recent) does to one section (in place, same file)."""
    p.write_text(p.read_text("utf-8").replace(f"## {name}\n", f"## {name}\n{text}\n", 1), "utf-8")


def test_followup_column_is_recent_section_not_position():
    sch = kinds("sections: {event: [时间, 涉及谁, 经过, 后续, 她的态度]}\nrecent_section: {event: 后续}\n")
    assert sch.followup == "后续"
    assert sch.layout() == {"时间": ["when"], "涉及谁": ["who"], "经过": ["what"], "她的态度": ["stance"]}
    pid = make_done()
    sql("UPDATE date_stops SET her_line='他真的早到了' WHERE plan_id=? AND title='梧桐站'", (pid,))
    run()
    [p] = cards()
    _, secs = vparse(p, sch)
    assert secs["后续"] == "" and secs["她的态度"] == "- 19:00 梧桐站：他真的早到了"
    put_section(p, "后续", "lorecards 写的后续")
    sql("UPDATE date_stops SET note='再改' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert run() == {pid: "updated"}
    _, secs = vparse(p, sch)
    assert secs["后续"] == "lorecards 写的后续" and "  备注：再改" in secs["经过"]
    assert secs["她的态度"] == "- 19:00 梧桐站：他真的早到了"
    assert asks(pid) == [("card_after", 1)]


def test_followup_column_rules_without_recent_section():
    assert memory.Schema(sections=("a", "b", "c", "d", "e"), recent=None).followup == "e"
    assert memory.Schema(sections=("a", "b", "c", "d", "e", "f"), recent="zz").followup == "e"
    s3 = memory.Schema(sections=("a", "b", "c"), recent=None)
    assert s3.followup == "c" and s3.layout() == {"a": ["when"], "b": ["who", "what", "stance"]}
    with pytest.raises(ValueError):
        memory.Schema(sections=("only",)).layout()


def test_four_section_vault_merges_stance_into_what_and_closes_ask():
    sch = kinds("sections: {event: [时间, 涉及谁, 经过, 后续]}\nrecent_section: {event: 后续}\n")
    assert sch.layout() == {"时间": ["when"], "涉及谁": ["who"], "经过": ["what", "stance"]}
    pid = make_done()
    sql("UPDATE date_stops SET her_line='他真的早到了' WHERE plan_id=? AND title='梧桐站'", (pid,))
    run()
    [p] = cards()
    text = p.read_text("utf-8")
    assert [ln for ln in text.splitlines() if ln.startswith("## ")] == ["## 时间", "## 涉及谁", "## 经过", "## 后续"]
    _, secs = vparse(p, sch)
    assert secs["经过"].endswith("那一句话：那天很好\n\n她的态度：\n- 19:00 梧桐站：他真的早到了")
    assert asks(pid) == [("card_after", 0)]
    put_section(p, "后续", "写好了")
    run()
    assert asks(pid) == [("card_after", 1)]
    assert vparse(p, sch)[1]["后续"] == "写好了"


def test_six_section_vault_leaves_extra_section_alone():
    sch = kinds("sections: {event: [时间, 涉及谁, 经过, 她的态度, 后续, 心情]}\nrecent_section: {event: 后续}\n")
    assert sch.followup == "后续" and "心情" not in sch.layout()
    pid = make_done()
    run()
    [p] = cards()
    assert vparse(p, sch)[1]["心情"] == "" and "## 心情" in p.read_text("utf-8")
    put_section(p, "心情", "手写的心情")
    put_section(p, "后续", "写好了")
    sql("UPDATE date_stops SET note='再改' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert run() == {pid: "updated"}
    _, secs = vparse(p, sch)
    assert secs["心情"] == "手写的心情" and secs["后续"] == "写好了" and "  备注：再改" in secs["经过"]
    assert p.read_text("utf-8").count("## ") == 6
    assert asks(pid) == [("card_after", 1)]


def test_layout_change_rewrites_card():
    pid = make_done()
    run()
    kinds("sections: {event: [时间, 涉及谁, 经过, 她的态度, 后续]}\n")
    assert run() == {pid: "updated"}
    assert "## 时间" in cards()[0].read_text("utf-8")


# ── state re-read under the lock (overlapping leases) ─────────────────────────────
def test_overlapping_scheduler_rename_detected_under_lock(monkeypatch):
    import threading
    pid = make_done()
    run()
    add_followup(cards()[0], "原来的后续")
    sql("UPDATE date_plans SET title_en='Riverside' WHERE id=?", (pid,))
    real_lock = memory.cards_lock
    other = {}

    def other_scheduler():                         # a second owner, its whole round in between
        other["out"] = memory.run_once()["cards"]

    calls = {"n": 0}

    def lock(root, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:                          # the first scheduler has read its state, now waits
            t = threading.Thread(target=other_scheduler)
            t.start()
            t.join()
        return real_lock(root, timeout)
    monkeypatch.setattr(memory, "cards_lock", lock)
    assert run() == {pid: "raced"}                  # stale old_key noticed, nothing done on it
    assert other["out"] == {pid: "renamed"}
    [p] = cards()
    assert p.name == "约会·2026-10-28·Riverside.md" and parse(p)[1]["followup"] == "原来的后续"
    monkeypatch.setattr(memory, "cards_lock", real_lock)
    assert run() == {pid: "same"} and state(pid)["card_key"] == p.stem


# ── queued follow-up vs a newer one on the card ───────────────────────────────────
def test_card_followup_edited_after_queue_wins():
    import time as _t
    pid = make_done()
    run()
    p = cards()[0]
    memory.queue_followup(pid, "排队的后续")
    add_followup(p, "卡上后来改的")
    later = _t.time() + 100
    os.utime(p, (later, later))
    assert run() == {pid: "same"}
    assert parse(p)[1]["followup"] == "卡上后来改的" and state(pid)["followup_pending"] is None


def test_queued_followup_newer_than_card_edit_wins():
    import time as _t
    pid = make_done()
    run()
    p = cards()[0]
    add_followup(p, "卡上早先写的")
    earlier = _t.time() - 100
    os.utime(p, (earlier, earlier))
    memory.queue_followup(pid, "排队的后续")
    assert run() == {pid: "updated"}
    assert parse(p)[1]["followup"] == "排队的后续"


def test_queued_followup_wins_over_our_own_later_write():
    """The card's mtime is newer than the queue only because this module wrote it (a round that read its
    state just before the text was queued): the card is untouched since, so the queued text is newer."""
    pid = make_done()
    run()
    memory.queue_followup(pid, "第一段")
    run()
    p = cards()[0]
    memory.queue_followup(pid, "第二段")
    sql("UPDATE ephemera_memory_state SET followup_queued_at=? WHERE plan_id=?", (p.stat().st_mtime - 100, pid))
    assert run() == {pid: "updated"}
    assert parse(p)[1]["followup"] == "第二段"


# ── file permissions ──────────────────────────────────────────────────────────────
@pytest.fixture()
def umask022(monkeypatch):
    monkeypatch.setattr(memory, "_UMASK", 0o022)        # what the process read at start


def test_new_card_and_export_are_0644_rewrite_keeps_mode(tmp_path, monkeypatch, umask022):
    monkeypatch.setenv("EPHEMERA_MEMORY_EXPORT_DIR", str(tmp_path / "export"))
    pid = make_done()
    run()
    p = cards()[0]
    j = tmp_path / "export" / f"date-{pid}.json"
    mode = lambda f: os.stat(f).st_mode & 0o777                  # noqa: E731
    assert mode(p) == 0o644 and mode(j) == 0o644
    os.chmod(p, 0o600)
    os.chmod(j, 0o640)
    sql("UPDATE date_stops SET note='再改' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert memory.run_once() == {"cards": {pid: "updated"}, "json": {pid: "updated"}}
    assert mode(p) == 0o600 and mode(j) == 0o640                # in place: own permissions kept
    sql("UPDATE date_plans SET title_en='Riverside' WHERE id=?", (pid,))
    assert run() == {pid: "renamed"}
    assert mode(cards()[0]) == 0o600                             # renamed card keeps them too


def test_new_file_mode_follows_umask_read_once(monkeypatch):
    old = os.umask(0o077)
    try:
        assert memory._read_umask() == 0o077
    finally:
        os.umask(old)
    monkeypatch.setattr(memory, "_UMASK", 0o077)
    assert memory.new_file_mode() == 0o600


def test_writing_never_touches_the_global_umask(tmp_path, monkeypatch):
    monkeypatch.setenv("EPHEMERA_MEMORY_EXPORT_DIR", str(tmp_path / "export"))
    pid = make_done()

    def no(*a):
        raise AssertionError("os.umask called while writing")
    monkeypatch.setattr(os, "umask", no)
    assert memory.run_once() == {"cards": {pid: "written"}, "json": {pid: "written"}}


# ── unrelated card edits never discard a queued follow-up; a loss is told to the AI ──
def open_todos():
    from ephemera_date import inbox
    return [r for r in inbox.open_items("pull") if r["kind"] == "memory_notice"]


def test_unrelated_card_edit_does_not_discard_queued_followup():
    """Regression: follow-up written, AI queues a new one, then a keyword is added by hand."""
    pid = make_done()
    run()
    p = cards()[0]
    memory.queue_followup(pid, "第一版后续")
    run()
    memory.queue_followup(pid, "AI 新写的第二版后续")
    import time as _t
    _t.sleep(0.05)
    p.write_text(p.read_text("utf-8").replace("keywords: [", "keywords: [手加词, "), "utf-8")
    later = _t.time() + 100
    os.utime(p, (later, later))                          # the card is clearly newer than the queue
    assert run() == {pid: "updated"}
    fm, secs = parse(p)
    assert secs["followup"] == "AI 新写的第二版后续" and "手加词" in fm["keywords"]
    assert open_todos() == []


def test_lost_followup_is_told_to_the_ai():
    import time as _t
    pid = make_done()
    run()
    p = cards()[0]
    memory.queue_followup(pid, "排队的后续")
    add_followup(p, "卡上后来改的")
    later = _t.time() + 100
    os.utime(p, (later, later))
    assert run() == {pid: "same"}
    [todo] = open_todos()
    key = p.stem
    assert todo["current"] == (f"约会 #{pid}「The Evening Screening」：你排队的后续没写进去——事件卡「{key}」的「后续」"
                               f"在你排队之后被改过，卡上的那段留着。你排队的是：「排队的后续」。"
                               f"要改就先用 date_memory 带 plan={pid} 看全文，再用 op=followup 重写。")
    from ephemera_date import inbox
    assert "约会记忆" in inbox.render_items(inbox.open_items("pull"))
    from ephemera_date import tools as dt
    assert dt.inbox_tail(dt._now()).startswith("\n\n（约会待办 1 件")
    run()
    assert len(open_todos()) == 1                       # told once, not every round
