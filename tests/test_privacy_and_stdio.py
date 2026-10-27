"""Confidentiality at the HTTP edge (errors are identical for draft vs missing) + the stdio MCP server.

tmp data dir; the stdio test runs the real `python -m ephemera_date.server stdio` in a subprocess.
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime

from conftest import H, TZ
from ephemera_date import plan as dp

NOW0 = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)


def _draft():
    pid = dp.open_plan("Secret Name", "2026-10-28", "rose", now=NOW0)["plan_id"]
    dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="青石区1", clue="c",
                                  reveal_at="17:30", note="秘密的话"), now=NOW0)
    return pid


def test_draft_and_missing_dates_answer_identically_everywhere(api):
    pid = _draft()
    sid = dp.snapshot(pid, now=NOW0)["state"]["stops"][0]["id"]
    api.clock["now"] = NOW0
    reqs = [("get", "/api/dates/{p}"), ("get", "/api/dates/{p}/her"), ("get", "/api/dates/{p}/map"),
            ("post", "/api/dates/{p}/her/open"), ("get", "/api/dates/{p}/stops/{s}/art"),
            ("get", "/api/dates/{p}/her/photo/1")]
    from ephemera_date import ports

    class Map:
        def build_map(self, v):
            return {}
    ports.install("map", Map())
    for m, path in reqs:
        a = getattr(api, m)(path.format(p=pid, s=sid), headers=H())
        b = getattr(api, m)(path.format(p=9999, s=sid), headers=H())
        assert a.status_code == b.status_code == 404, path
        assert a.json() == b.json(), path
        for secret in ("Secret", "梧桐站", "青石区", "秘密"):
            assert secret not in a.text
    assert api.get("/api/dates/events", headers=H()).json() == {"events": []}       # 构思中的约会没有事件
    prep = api.get("/api/dates/preparing", headers=H()).json()["plans"]
    assert len(prep) == 1 and "Secret" not in str(prep) and "梧桐站" not in str(prep)


def test_stdio_server_lists_and_calls_tools(tmp_path):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    env = {**os.environ, "EPHEMERA_DATA_DIR": str(tmp_path / "stdio-data"), "EPHEMERA_TZ": "Asia/Shanghai"}
    params = StdioServerParameters(command=sys.executable, args=["-m", "ephemera_date.server", "stdio"], env=env)

    async def main():
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                tools = [t.name for t in (await s.list_tools()).tools]
                res = await s.call_tool("date_open", {"title_en": "A", "date": "2099-01-01", "color": "rose"})
                return tools, res
    tools, res = asyncio.run(asyncio.wait_for(main(), 60))
    assert "date_inbox" in tools and "date_open" in tools
    assert not res.isError and res.content[0].text.startswith("开好了：约会 #1。")
    import sqlite3
    c = sqlite3.connect(str(tmp_path / "stdio-data" / "ephemera.db"))
    try:
        assert c.execute("SELECT COUNT(*) FROM date_plans").fetchone()[0] == 1
        # stdio 只读写库,不当调度者:没有租约
        assert c.execute("SELECT COUNT(*) FROM ephemera_meta WHERE key='scheduler_lease'").fetchone()[0] == 0
    finally:
        c.close()
