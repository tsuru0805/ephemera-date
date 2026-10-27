"""地点查询的本地缓存（SQLite）。

只给 OSM（Nominatim / Photon）用：Nominatim 政策要求客户端缓存同一查询、不重复发。
谷歌与高德的通用条款不允许缓存/存储结果内容，适配层不缓存它们。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path


class QueryCache:
    def __init__(self, path: str | Path, ttl_s: float = 30 * 86400):
        self.path = Path(path)
        self.ttl_s = float(ttl_s)
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.execute("CREATE TABLE IF NOT EXISTS place_cache (k TEXT PRIMARY KEY, v TEXT NOT NULL,"
                      " at REAL NOT NULL)")

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.execute("PRAGMA journal_mode=WAL")
        return c

    @staticmethod
    def key(*parts) -> str:
        return json.dumps(parts, ensure_ascii=False, separators=(",", ":"))

    def get(self, k: str):
        with self._lock:
            c = self._conn()
            try:
                row = c.execute("SELECT v, at FROM place_cache WHERE k=?", (k,)).fetchone()
            finally:
                c.close()
        if not row or time.time() - row[1] > self.ttl_s:
            return None
        return json.loads(row[0])

    def put(self, k: str, v) -> None:
        with self._lock:
            c = self._conn()
            try:
                with c:
                    c.execute("INSERT OR REPLACE INTO place_cache (k, v, at) VALUES (?,?,?)",
                              (k, json.dumps(v, ensure_ascii=False), time.time()))
            finally:
                c.close()
