"""date_memory: find finished dates (never anything in progress), write a card's follow-up, secrecy marker,
the follow-up ask label in the AI's ledger.

tmp data dir + tmp card vault, fake clock, no network.
"""
from __future__ import annotations

import asyncio

import pytest

from conftest import local_tools
from ephemera_date import config, memory
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from test_memory_card import NOW0, T, cards, make_done, ok, parse


@pytest.fixture()
def vault(tmp_path, monkeypatch):
    monkeypatch.setenv("EPHEMERA_CARDS_DIR", str(tmp_path / "vault"))


def mem(**args):
    return local_tools()["date_memory"](args)


def three():
    a = make_done(title="Alpha", day="2026-10-28")
    b = make_done(title="Beta", day="2026-11-03")
    live = ok(dp.open_plan("Gamma", "2026-11-10", "sky", now=NOW0))["plan_id"]       # in preparation
    ok(dp.edit(live, "add_stop", dict(kind="cafe", time="15:00", title="梧桐站", address="青石区梧桐路3",
                                      clue="秘密"), now=NOW0))
    return a, b, live


def test_find_returns_only_finished_dates():
    a, b, live = three()
    text, err = mem()
    assert not err
    assert f"约会 #{a}「Alpha」" in text and f"约会 #{b}「Beta」" in text
    assert f"#{live}" not in text and "Gamma" not in text and "秘密" not in text
    assert text.index(f"#{b}") < text.index(f"#{a}")                       # newest first
    text, err = mem(place="梧桐")                                           # the draft has this place too
    assert not err and "Gamma" not in text and f"#{a}" in text
    text, err = mem(plan=live)
    assert err and text.startswith(f"没查成：没有已结束的约会 #{live}") and "Gamma" not in text


def test_find_by_name_place_and_date_range():
    a, b, _ = three()
    text, _ = mem(name="alp")
    assert f"#{a}" in text and f"#{b}" not in text
    text, _ = mem(place="柳岸1")                                            # an address
    assert f"#{a}" in text and f"#{b}" in text
    text, _ = mem(**{"from": "2026-11-01", "to": "2026-11-30"})
    assert f"#{b}" in text and f"#{a}" not in text
    text, _ = mem(**{"from": "2026-10-28", "to": "2026-10-28"})              # inclusive
    assert f"#{a}" in text and f"#{b}" not in text
    text, err = mem(name="nothing")
    assert not err and text == "没有找到符合条件的已结束约会。"
    text, err = mem(**{"from": "10/28"})
    assert err and text == "没查成：from 要写日期 YYYY-MM-DD。"


def test_find_full_text_and_summary():
    pid = make_done()
    text, _ = mem(plan=pid)
    assert text.splitlines()[0] == f"—— 约会 #{pid}「The Evening Screening」 · 10/28 周三 · 3 站：梧桐站、Le Petit Pot、约会 ——"
    assert "经过：\n- 19:00 · 梧桐站 · 集合" in text and "那一句话：那天很好" in text
    assert "后续" not in text                                              # no card, no follow-up


def test_find_caps_full_text(monkeypatch):
    ids = [make_done(title=f"D{i}", day=f"2026-10-{20 + i}") for i in range(5)]
    text, _ = mem()
    assert text.startswith("找到 5 次已结束的约会：")
    assert text.count("—— 约会 #") == memory.FULL_MAX and "其余的用 plan=编号 看全文。" in text
    monkeypatch.setattr(memory, "FIND_MAX", 2)
    text, _ = mem()
    assert "（只列最近 2 次，缩小条件再查）" in text and f"#{ids[0]}" not in text


def test_find_with_no_database_or_no_dates():
    text, err = mem()
    assert not err and text == "还没有已结束的约会。"


def test_find_meta_marks_returned_dates_and_reveal(vault):
    a, b, live = three()
    text, _ = mem()
    meta = dt.result_meta("date_memory", {"op": "find"}, text)
    assert meta["ephemera/secret"] is True and meta["ephemera/plan_ids"] == sorted([a, b])
    closed = [dp.snapshot(x)["state"]["plan"]["closed_at"] for x in (a, b)]
    assert meta["ephemera/reveal_after"] == max(closed)
    m2 = dt.result_meta("date_memory", {"plan": live}, f"没查成：没有已结束的约会 #{live}。")
    assert m2["ephemera/reveal_after"] is None and m2["ephemera/plan_ids"] == [live]


def test_followup_queued_then_written_by_scheduler_and_ask_closed(vault):
    pid = make_done()
    memory.run_once()
    key = cards()[0].stem
    ledger = dt.ledger_block(now=T(10, 29))[0]
    assert f"事件卡「{key}」的「后续」段（用 date_memory 写：op=followup，plan={pid}" in ledger
    text, err = mem(op="followup", plan=pid, text="后来又去了一次。")
    assert not err and text == f"收到了，下一轮写进事件卡「{key}」的「后续」段（写卡由 ephemera-date serve 负责）。"
    assert parse(cards()[0])[1]["followup"] == ""                          # the tool itself never writes the card
    assert memory.run_once()["cards"] == {pid: "updated"}
    assert parse(cards()[0])[1]["followup"] == "后来又去了一次。"
    conn = dp._connect()
    try:
        done = conn.execute("SELECT done_at FROM date_asks WHERE plan_id=? AND what='card_after'", (pid,)).fetchone()[0]
    finally:
        conn.close()
    assert done is not None
    text, _ = mem(plan=pid)
    assert text.endswith("后续：\n后来又去了一次。")
    mem(op="followup", plan=pid, text="整段换掉。")                          # replaces, never appends
    memory.run_once()
    assert parse(cards()[0])[1]["followup"] == "整段换掉。"
    assert memory.run_once()["cards"] == {pid: "same"}


def test_followup_refusals(vault, monkeypatch):
    pid = make_done()
    live = ok(dp.open_plan("Later", "2026-12-01", "sky", now=NOW0))["plan_id"]
    assert mem(op="followup", plan=live, text="x") == (f"没写成：没有已结束的约会 #{live}。", True)
    assert mem(op="followup", plan=pid, text="  ") == ("没写成：text 要写后续的内容。", True)
    assert mem(op="followup", plan=pid, text="长" * 601)[0] == "没写成：后续最多 600 字，现在 601 字。"
    assert mem(op="followup", text="x") == ("没写成：plan 要写约会编号（整数）。", True)
    memory.run_once()
    cards()[0].unlink()
    key = memory.written_key(pid)
    assert mem(op="followup", plan=pid, text="x") == (f"没写成：事件卡「{key}」已经被删掉或归档了，不再写。", True)
    monkeypatch.delenv("EPHEMERA_CARDS_DIR")
    assert mem(op="followup", plan=pid, text="x") == (
        "没写成：没有配置事件卡目录（EPHEMERA_CARDS_DIR），后续写不了。", True)


def test_followup_before_card_exists_goes_into_first_card(vault):
    pid = make_done()
    text, err = mem(op="followup", plan=pid, text="先写好的后续")
    assert not err and text == "收到了，这次约会的事件卡写出来时会带上这段后续（写卡由 ephemera-date serve 负责）。"
    memory.run_once()
    assert parse(cards()[0])[1]["followup"] == "先写好的后续"


def test_stray_fields_and_bad_op():
    text, err = mem(op="find", text="x")
    assert err and text.startswith("没查成：date_memory 的 find 不认 text。text 是 followup 用的")
    text, err = mem(place="x", quote="y")
    assert err and "不认 quote" in text
    assert mem(op="nope") == ("没成：date_memory 的 op 只能是 find 或 followup。", True)


def test_description_mentions_followup_only_with_cards_dir(monkeypatch, tmp_path):
    assert "op=followup" not in dt.desc("date_memory")
    monkeypatch.setenv("EPHEMERA_CARDS_DIR", str(tmp_path / "v"))
    assert dt.desc("date_memory").endswith(dt.FOLLOWUP_SENTENCE)
    names = [t["name"] for t in dt.tool_schemas()]
    assert "date_memory" in names


def test_mcp_lists_and_calls_date_memory():
    from ephemera_date import server
    from mcp import types
    srv = server.build_mcp()
    make_done()

    async def main():
        tools = await srv.request_handlers[types.ListToolsRequest](types.ListToolsRequest(method="tools/list"))
        names = [t.name for t in tools.root.tools]
        res = await srv.request_handlers[types.CallToolRequest](types.CallToolRequest(
            method="tools/call", params=types.CallToolRequestParams(name="date_memory", arguments={})))
        return names, res.root
    names, res = asyncio.run(main())
    assert "date_memory" in names
    assert "找到 1 次已结束的约会" in res.content[0].text and res.meta["ephemera/secret"] is True
