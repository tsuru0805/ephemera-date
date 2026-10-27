"""限速：同一端点（主机）全应用共用一个闸——跨线程、跨进程都成立。

Nominatim 使用政策（https://operations.osmfoundation.org/policies/nominatim/）：
- 绝对上限每秒 1 次（整个应用合计，不是每个用户、也不是每个进程）；
- 批量查询只能单线程、单台机器，不做分布式；
- 运行超过一天或定期跑的脚本，每分钟最多 4 次（BULK_INTERVAL_S = 15s）。

实现：数据目录下每个主机一个锁文件（<数据目录>/ratelimit/<主机>.lock），内容是共享时间戳
{"last": 上次请求结束时刻, "last_bulk": 上次批量请求结束时刻}（墙钟秒，跨进程可比）。
拿到文件排他锁（POSIX flock / Windows msvcrt.locking）的调用者等到间隔够了才发，发完写回时间戳再放锁——
所以同一时刻全机最多一个请求在途，多个进程（serve、stdio MCP、CLI 脚本）自然排队。
同进程内另加一把线程锁（少开文件；文件锁本身按打开的文件描述符计，线程各自打开也互斥）。

批量请求：既要离上次任何请求 ≥ interval_s，也要离上次批量请求 ≥ bulk_interval_s；交互请求只看前者。
单台机器：锁文件在本机数据目录里，不提供任何跨机器协调（政策本来就不许分布式）。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

INTERACTIVE_INTERVAL_S = 1.0
BULK_INTERVAL_S = 15.0

if os.name == "nt":                      # pragma: no cover - 本机只测 POSIX
    import msvcrt

    def _lock(f):
        f.seek(0)
        while True:
            try:
                msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError:
                time.sleep(0.05)

    def _unlock(f):
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
else:
    import fcntl

    def _lock(f):
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)

    def _unlock(f):
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


class FileLimiter:
    def __init__(self, directory: str | Path, *, interval_s: float = INTERACTIVE_INTERVAL_S,
                 bulk_interval_s: float = BULK_INTERVAL_S, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep):
        self.dir = Path(directory)
        self.interval_s, self.bulk_interval_s = float(interval_s), float(bulk_interval_s)
        self._clock, self._sleep = clock, sleep
        self._tlocks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        self.sent = 0                     # 本实例放行的请求数（测试/统计用）

    def path_for(self, url: str) -> Path:
        host = urlsplit(url).netloc or url
        return self.dir / (re.sub(r"[^A-Za-z0-9._-]", "_", host) + ".lock")

    def _tlock(self, key: str) -> threading.Lock:
        with self._guard:
            return self._tlocks.setdefault(key, threading.Lock())

    @contextmanager
    def slot(self, url: str, bulk: bool = False):
        """拿到发请求的资格（排队 + 等间隔），with 块里发请求；退出时记下结束时刻。
        with 块里也可以不发（例如拿到锁后复查缓存命中），这时不更新时间戳。"""
        path = self.path_for(url)
        self.dir.mkdir(parents=True, exist_ok=True)
        with self._tlock(str(path)):
            with open(path, "a+", encoding="utf-8") as f:
                _lock(f)
                try:
                    f.seek(0)
                    try:
                        st = json.loads(f.read() or "{}")
                    except ValueError:
                        st = {}
                    ticket = _Ticket(self, st, bulk)
                    try:
                        yield ticket
                    finally:
                        if ticket.used:          # 请求发出去了（不论成败）才记时间戳
                            end = self._clock()
                            st["last"] = end
                            if bulk:
                                st["last_bulk"] = end
                            f.seek(0)
                            f.truncate()
                            f.write(json.dumps(st))
                            f.flush()
                            os.fsync(f.fileno())
                            self.sent += 1
                finally:
                    _unlock(f)


class _Ticket:
    """slot() 里拿到的排队资格。wait() = 等到间隔够了（发请求前调用）。"""

    def __init__(self, lim: FileLimiter, st: dict, bulk: bool):
        self.lim, self.st, self.bulk, self.used = lim, st, bulk, False

    def wait(self) -> float:
        due = float(self.st.get("last", 0)) + self.lim.interval_s
        if self.bulk:
            due = max(due, float(self.st.get("last_bulk", 0)) + self.lim.bulk_interval_s)
        wait = due - self.lim._clock()
        if wait > 0:
            self.lim._sleep(wait)
        self.used = True
        return max(wait, 0.0)


_defaults: dict[str, FileLimiter] = {}
_dlock = threading.Lock()


def default_limiter(data_dir: str | Path | None = None) -> FileLimiter:
    """数据目录下的共享限速器（同一数据目录 = 同一个闸，跨进程）。"""
    if data_dir is None:
        from .config import default_data_dir
        data_dir = default_data_dir()
    d = str(Path(data_dir) / "ratelimit")
    with _dlock:
        if d not in _defaults:
            _defaults[d] = FileLimiter(d)
        return _defaults[d]
