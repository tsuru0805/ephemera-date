"""Hiding the AI's thinking in the turns where it writes a date: a reference for self-hosted gateways.

The engine cannot reach anyone's chat view, so this is what a gateway (your own relay between the AI and her chat
page) calls; pure functions, no I/O. docs/SECRECY.md describes how to wire it.

A turn is sealed when
  1. the AI called any date tool in it (including a call that failed; the whole turn is sealed, also the thinking
     before the call), or
  2. the turn was started by a date wake-up: a reminder or a "please write" request from the engine (the text the
     AI receives begins with plan.REMIND_HEAD or plan.REQUEST_HEAD followed by a space).
Carrying the date ledger (the GET /context text) in the system prompt does NOT seal a turn: the ledger never holds
the name or the content of a date in progress.

Sealing is a mask in the view, not encryption: it is stored with the message (a replay or a reopened app shows it
sealed too); a sealed turn's thinking is left out of summaries, its thinking title is shown only once unsealed;
she can unseal a turn after confirming.

Which tools count (SEAL_TOOLS): every tool that reads or writes a date that may still be partly hidden from her:
  date_open, date_view, date_edit, date_send, date_live, date_close — they write or show stops, places, clues,
      legs and texts she has not seen yet;
  date_route — walking time between two places, used while choosing the stops (the places themselves are the
      secret);
  date_inbox — its list shows the to-do lines of dates in progress (stop numbers and times of reminders, the name
      and day of a date she asked him to write for), and the turn that handles a to-do is a turn about that date.
Not counted: date_memory — it only finds dates that are over (closed), and closing a date reveals all of it to her
(the tool result's ephemera/reveal_after is set), so it brings out nothing she cannot already see. A gateway that
prefers to seal it too passes seal_memory=True.
"""
from __future__ import annotations

import copy
from collections.abc import Iterable
from typing import Any

from .plan import REMIND_HEAD, REQUEST_HEAD

SEAL_TOOLS = frozenset({"date_open", "date_view", "date_route", "date_edit", "date_send", "date_live",
                        "date_close", "date_inbox"})
MEMORY_TOOL = "date_memory"
WAKE_HEADS = (REMIND_HEAD, REQUEST_HEAD)
THINKING_BLOCK_TYPES = frozenset({"thinking", "redacted_thinking"})


def bare_tool_name(name: Any) -> str:
    """The tool's own name without a client prefix: MCP clients often name a tool "<prefix>__<tool>"
    (for example mcp__ephemera__date_edit); the part after the last "__" is the engine's name."""
    if not isinstance(name, str) or not name:
        return ""
    return name.rsplit("__", 1)[-1]


def is_date_tool(name: Any, *, seal_memory: bool = False) -> bool:
    """Is this a date tool whose call seals the turn (see the module text for which ones and why)."""
    bare = bare_tool_name(name)
    return bare in SEAL_TOOLS or (seal_memory and bare == MEMORY_TOOL)


def is_date_wake(text: Any) -> bool:
    """Was the turn started by a date wake-up: a reminder or a "please write" request?
    The engine's wake-up texts (the text of an AI to-do, the "text" of an AI webhook payload) begin with
    "[约会提醒] " or "[约会请写] ". Leading whitespace is ignored; the head must be followed by a space."""
    if not isinstance(text, str):
        return False
    t = text.lstrip()
    return any(t.startswith(h + " ") for h in WAKE_HEADS)


def _call_name(call: Any) -> Any:
    """A tool call as a name, or a dict with "name" (Anthropic tool_use, MCP) or "tool"."""
    if isinstance(call, dict):
        return call.get("name") if call.get("name") is not None else call.get("tool")
    return call


def should_seal(tool_calls: Iterable[Any] | None = None, wake_text: Any = None, *,
                seal_memory: bool = False) -> bool:
    """Seal this turn? tool_calls = every tool call of the turn so far (names or dicts with "name" / "tool";
    failed calls included); wake_text = the text that started the turn (the user-side message), or None."""
    if is_date_wake(wake_text):
        return True
    return any(is_date_tool(_call_name(c), seal_memory=seal_memory) for c in (tool_calls or ()))


def redact_for_summary(turn: dict) -> dict:
    """A copy of a stored turn as summaries and title generators may see it: when turn["sealed"] is true, the
    thinking is gone (the "thinking" field and thinking blocks in "content") and so is "thinking_title".
    Text blocks and tool calls stay as they are (their own masking, if any, is the gateway's tool-result policy).
    An unsealed turn is returned as a plain copy. The input is never changed."""
    out = copy.deepcopy(turn)
    if not turn.get("sealed"):
        return out
    if "thinking" in out:
        out["thinking"] = None
    if "thinking_title" in out:
        out["thinking_title"] = None
    content = out.get("content")
    if isinstance(content, list):
        out["content"] = [b for b in content
                          if not (isinstance(b, dict) and b.get("type") in THINKING_BLOCK_TYPES)]
    return out
