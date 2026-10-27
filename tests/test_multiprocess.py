"""Real processes on one data directory: a stdio MCP client writes a date while two `ephemera-date serve` processes
run; the envelope reaches the (local, in-test) webhook receiver exactly once, and only one scheduler holds
the lease. tmp data dir; nothing leaves localhost.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _Recv(BaseHTTPRequestHandler):
    got: list = []

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        type(self).got.append((self.headers.get("Idempotency-Key"), json.loads(body)))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


def test_stdio_writer_and_two_servers_deliver_once(tmp_path):
    _Recv.got = []
    recv = ThreadingHTTPServer(("127.0.0.1", 0), _Recv)
    threading.Thread(target=recv.serve_forever, daemon=True).start()
    data = tmp_path / "shared"
    env = {**{k: v for k, v in os.environ.items() if not k.startswith("EPHEMERA_")},
           "EPHEMERA_DATA_DIR": str(data), "EPHEMERA_TZ": "Asia/Shanghai",
           "EPHEMERA_EVENT_WEBHOOK": f"http://127.0.0.1:{recv.server_address[1]}/events",
           "EPHEMERA_SCHEDULER_TICK_S": "0.3"}
    ports = [_free_port(), _free_port()]
    procs = [subprocess.Popen([sys.executable, "-m", "ephemera_date.server", "serve", "--port", str(p)], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for p in ports]
    try:
        for p in ports:
            deadline = time.monotonic() + 20
            while True:
                try:
                    if httpx.get(f"http://127.0.0.1:{p}/api/config", timeout=1).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                assert time.monotonic() < deadline, "serve did not come up"
                time.sleep(0.1)

        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        params = StdioServerParameters(command=sys.executable, args=["-m", "ephemera_date.server", "stdio"], env=env)

        async def write_a_date():
            async with stdio_client(params) as (r, w):
                async with ClientSession(r, w) as s:
                    await s.initialize()
                    out = [await s.call_tool("date_open", {"title_en": "Night", "date": "2099-01-01", "color": "rose"})]
                    out.append(await s.call_tool("date_edit", {
                        "plan": 1, "op": "add_stop", "kind": "train", "time": "19:00", "title": "梧桐站",
                        "address": "青石区1", "clue": "出口右手", "reveal_at": "17:30"}))
                    out.append(await s.call_tool("date_edit", {"plan": 1, "op": "set_prep",
                                                               "items": [{"section": "bring", "text": "伞"}]}))
                    out.append(await s.call_tool("date_send", {"plan": 1}))
                    return out
        results = asyncio.run(asyncio.wait_for(write_a_date(), 60))
        assert all(not r.isError for r in results), [r.content[0].text for r in results]
        deadline = time.monotonic() + 15
        while not _Recv.got and time.monotonic() < deadline:
            time.sleep(0.1)
        time.sleep(1.5)                                                    # both servers had several rounds
        assert [(k, p["kind"]) for k, p in _Recv.got] == [("ephemera-event-1", "envelope")]
        assert "梧桐站" not in json.dumps(_Recv.got, ensure_ascii=False)
        c = sqlite3.connect(str(data / "ephemera.db"))
        try:
            assert c.execute("SELECT push_state FROM date_events").fetchall() == [("sent",)]
            assert c.execute("SELECT COUNT(*) FROM ephemera_meta WHERE key='scheduler_lease'").fetchone()[0] == 1
        finally:
            c.close()
    finally:
        for pr in procs:
            pr.terminate()
        for pr in procs:
            try:
                pr.wait(10)
            except subprocess.TimeoutExpired:
                pr.kill()
        recv.shutdown()
