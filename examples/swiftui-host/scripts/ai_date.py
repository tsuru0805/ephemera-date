#!/usr/bin/env python3
"""The AI side for trying the host: writes, sends and closes a date through the engine's MCP tools over HTTP.

Standard library only. Talks Streamable HTTP MCP (JSON-RPC) to <base>/mcp with the AI token.

    python3 ai_date.py write   # a date for today: 4 stops (one is a "moment", no fixed place), prep list,
                               # contract, card; stop times a little in the past so every stop can be checked in now
    python3 ai_date.py close   # close the date written last (it goes to the box)
    python3 ai_date.py clear   # close or delete every date still going (the engine keeps at most 3)
    python3 ai_date.py view    # date_view

Env: EPHEMERA_MCP (default http://127.0.0.1:18870/mcp), EPHEMERA_AI_TOKEN (default ai-host-token),
     EPHEMERA_TZ (default: the system zone; must match the engine's).
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

MCP = os.environ.get("EPHEMERA_MCP", "http://127.0.0.1:18870/mcp")
TOKEN = os.environ.get("EPHEMERA_AI_TOKEN", "ai-host-token")
STATE = Path(os.environ.get("EPHEMERA_HOST_STATE", "/tmp/ephemera-host-last-plan"))


class Mcp:
    def __init__(self, url: str, token: str):
        self.url, self.token, self.sid, self.n = url, token, None, 0

    def _rpc(self, method: str, params: dict | None = None, notify: bool = False):
        body: dict = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self.n += 1
            body["id"] = self.n
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "Authorization": f"Bearer {self.token}"}
        if self.sid:
            headers["mcp-session-id"] = self.sid
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as r:
            self.sid = r.headers.get("mcp-session-id") or self.sid
            text = r.read().decode()
        if notify:
            return None
        line = next((x for x in text.splitlines() if x.startswith("data:")), None)
        msg = json.loads(line[5:] if line else text)
        if "error" in msg:
            raise RuntimeError(f"{method}: {msg['error']}")
        return msg["result"]

    def init(self):
        self._rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                 "clientInfo": {"name": "swiftui-host-example", "version": "0"}})
        self._rpc("notifications/initialized", {}, notify=True)
        return self

    def call(self, name: str, args: dict) -> str:
        res = self._rpc("tools/call", {"name": name, "arguments": args})
        text = "\n".join(c.get("text", "") for c in res.get("content", []))
        if res.get("isError"):
            raise RuntimeError(f"{name}: {text}")
        return text


def wall(minutes: int) -> datetime:
    tz = os.environ.get("EPHEMERA_TZ")
    now = datetime.now(ZoneInfo(tz)) if tz else datetime.now().astimezone()
    return now + timedelta(minutes=minutes)


def write(m: Mcp) -> int:
    today = wall(0).strftime("%Y-%m-%d")
    opened = m.call("date_open", {"title_en": "A Quiet\nRiver Walk", "title_zh": "沿河慢慢走", "date": today, "color": "sky"})
    plan = int(re.search(r"#(\d+)", opened).group(1))
    stops = [
        dict(kind="train", t=-50, title="东门车站", address="滨河路 1 号", clue="有钟的那个出口", lat=31.2304, lng=121.4737),
        dict(kind="cafe", t=-40, title="转角咖啡", address="滨河路 18 号", clue="门口有一棵银杏", lat=31.2312, lng=121.4751),
        dict(kind="moment", t=-25, title="一起买一束花", clue="你挑颜色，我付钱"),
        dict(kind="walk", t=-10, title="沿河步道", address="河堤", clue="把今天走完", lat=31.2338, lng=121.4781),
    ]
    for k, s in enumerate(stops):
        t = s.pop("t")
        args = {"plan": plan, "op": "add_stop", "time": wall(t).strftime("%H:%M"), **s}
        if k == 0:
            args["reveal_at"] = wall(t - 5).strftime("%H:%M")
        print(m.call("date_edit", args).splitlines()[0])
    m.call("date_edit", {"plan": plan, "op": "set_prep", "items": [
        {"section": "wear", "text": "一双走得久的鞋"}, {"section": "bring", "text": "一件薄外套"}]})
    m.call("date_edit", {"plan": plan, "op": "set_contract", "items": ["今天不看工作消息", "散步走到河的尽头"]})
    m.call("date_edit", {"plan": plan, "op": "set_card", "text": "谢谢你陪我走完这一天。"})
    sent = m.call("date_send", {"plan": plan})
    print(sent.splitlines()[0])
    STATE.write_text(str(plan))
    return plan


def close(m: Mcp, plan: int | None = None) -> None:
    plan = plan or int(STATE.read_text())
    print(m.call("date_close", {"plan": plan, "quote": "Good company, a good day"}).splitlines()[0])


def clear(m: Mcp) -> None:
    for line in m.call("date_view", {}).splitlines():
        hit = re.match(r"^#(\d+)", line)
        if not hit:
            continue
        pid = int(hit.group(1))
        if "· 构思中" in line:
            m.call("date_edit", {"plan": pid, "op": "delete_plan"})
        elif re.search(r"· (当天|已寄出)", line):
            close(m, pid)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "write"
    m = Mcp(MCP, TOKEN).init()
    if cmd == "write":
        print("plan", write(m))
    elif cmd == "close":
        close(m)
    elif cmd == "clear":
        clear(m)
    elif cmd == "view":
        print(m.call("date_view", {}))
    else:
        sys.exit(__doc__)
