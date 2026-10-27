"""seal.py: which turns a gateway seals (the AI's thinking hidden in her chat view) and what summaries may see.
Pure functions; the integration part checks the engine's real wake-up texts. tmp data dir, no network."""
from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from conftest import TZ
from ephemera_date import inbox, remind, seal
from ephemera_date import plan as dp
from ephemera_date import tools as dt

NOW0 = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"


# ── tool names ──────────────────────────────────────────────────────────────────
def test_every_engine_tool_is_classified():
    """Every tool the engine offers is either sealing or date_memory (the one exception); a new tool must be
    classified here before it ships."""
    assert set(dt.TOOLS) == seal.SEAL_TOOLS | {seal.MEMORY_TOOL}
    assert seal.MEMORY_TOOL not in seal.SEAL_TOOLS


@pytest.mark.parametrize("name", ["date_open", "date_view", "date_route", "date_edit", "date_send", "date_live",
                                  "date_close", "date_inbox"])
def test_date_tools_seal(name):
    assert seal.is_date_tool(name)
    assert seal.is_date_tool(f"mcp__ephemera__{name}")              # client prefixes
    assert seal.is_date_tool(f"ephemera__{name}")


def test_memory_and_other_tools():
    assert not seal.is_date_tool("date_memory")
    assert seal.is_date_tool("date_memory", seal_memory=True)
    assert seal.is_date_tool("mcp__ephemera__date_memory", seal_memory=True)
    for name in ("web_search", "date_opener", "mcp__x__update_date", "", None, 3, "date_edit__x"):
        assert not seal.is_date_tool(name), name


# ── wake-up texts ────────────────────────────────────────────────────────────────
def test_wake_heads():
    assert seal.is_date_wake("[约会提醒] 约会 #3 · 第 2 站 19:30 到 · 15 分钟后。")
    assert seal.is_date_wake("  [约会请写] 她请你补写约会 #3")
    assert not seal.is_date_wake("[约会提醒]没有空格")
    assert not seal.is_date_wake("约会待办 1 件：\n[待办 1] … [约会提醒] …")     # the ledger / to-do list
    assert not seal.is_date_wake("今天好冷")
    assert not seal.is_date_wake(None) and not seal.is_date_wake({"text": "[约会提醒] x"})


# ── should_seal ──────────────────────────────────────────────────────────────────
def test_should_seal_rules():
    assert not seal.should_seal()
    assert not seal.should_seal([], "今天好冷")
    assert seal.should_seal(["web_search", "date_view"], "今天好冷")              # any date tool call
    assert seal.should_seal([{"type": "tool_use", "name": "mcp__ephemera__date_edit", "input": {}}])
    assert seal.should_seal([{"tool": "date_send", "is_error": True}])          # a failed call counts too
    assert seal.should_seal([], "[约会提醒] 约会 #1 明天（10/28 周三）。")         # a reminder wake-up
    assert seal.should_seal(None, "[约会请写] 她请你补写约会 #1")                 # a "please write" wake-up
    assert not seal.should_seal(["date_memory"], "上次那家咖啡叫什么")
    assert seal.should_seal(["date_memory"], "上次那家咖啡叫什么", seal_memory=True)
    assert not seal.should_seal([{"name": None, "tool": None}, {}, "weather"])


# ── redact_for_summary ───────────────────────────────────────────────────────────
def test_redact_for_summary_removes_thinking_only_when_sealed():
    turn = {"sealed": True, "thinking": "先想第 2 站去哪", "thinking_title": "在挑第 2 站",
            "content": [{"type": "thinking", "thinking": "x"}, {"type": "redacted_thinking", "data": "y"},
                        {"type": "text", "text": "好，晚上见。"},
                        {"type": "tool_use", "name": "date_edit", "input": {"op": "add_stop"}}]}
    out = seal.redact_for_summary(turn)
    assert out["thinking"] is None and out["thinking_title"] is None
    assert [b["type"] for b in out["content"]] == ["text", "tool_use"]
    assert turn["thinking"] == "先想第 2 站去哪" and len(turn["content"]) == 4      # input untouched
    plain = {**turn, "sealed": False}
    assert seal.redact_for_summary(plain) == plain and seal.redact_for_summary(plain) is not plain
    assert seal.redact_for_summary({"sealed": True, "content": "text only"}) == {"sealed": True, "content": "text only"}


# ── the engine's real texts ─────────────────────────────────────────────────────
def _sent_plan():
    pid = dp.open_plan("Seal\nTest", DAY, "rose", now=NOW0)["plan_id"]
    assert dp.edit(pid, "add_stop", dict(kind="cafe", time="19:00", title="梧桐站", address="梧桐路3",
                                         clue="改札右手边", reveal_at="17:30"), now=NOW0)["ok"]
    assert dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW0)["ok"]
    assert dp.send(pid, now=NOW0)["ok"]
    return pid


def test_engine_wake_texts_are_recognised_and_the_ledger_is_not(monkeypatch):
    monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "pull,context,webhook")
    monkeypatch.setenv("EPHEMERA_AI_WEBHOOK", "http://127.0.0.1:9/hook")
    _sent_plan()
    assert seal.is_date_wake(remind.compose_body(["约会 #1 明天（10/28 周三）。"]))
    t = datetime(2026, 10, 27, 20, 1, tzinfo=TZ)
    remind.process_reminders(now=t)                                       # the eve reminder is due
    sent = []
    assert inbox.push_pending(lambda payload, key: sent.append(payload) or "sent", t)["sent"] == 1
    assert sent[0]["kind"] == "reminder" and seal.is_date_wake(sent[0]["text"])
    ctx = inbox.context_text(now=t)                                       # the ledger carries the to-do too
    assert "[约会提醒]" in ctx and not seal.is_date_wake(ctx)


def test_engine_write_request_text_is_a_wake():
    p = {"id": 7, "title_en": "Spring", "title_zh": None, "date": "2026-05-03", "origin": "him"}
    assert seal.is_date_wake(dp.request_write_line(p, ["card"]))


def test_tool_results_of_sealing_tools_are_marked_secret():
    """The engine marks every tool result secret (MCP _meta); the seal is about the thinking of the turn."""
    pid = _sent_plan()
    text, _ = asyncio.run(dt.call("date_view", {"plan": pid}))
    meta = dt.result_meta("date_view", {"plan": pid}, text)
    assert meta["ephemera/secret"] is True and meta["ephemera/reveal_after"] is None
