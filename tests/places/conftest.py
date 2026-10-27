"""地点测试：零真实网络调用。所有 HTTP 走 FakeTransport（录好的响应 / 官方文档格式手写的样例）。"""
from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import pytest

from ephemera_date.places.base import HttpResponse

FIX = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


class FakeTransport:
    """按顺序回放响应；记录每次请求（method, url, params, headers, json_body）。"""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def __call__(self, method, url, *, params=None, headers=None, json_body=None, timeout=None):
        self.calls.append({"method": method, "url": url, "params": dict(params or {}),
                           "headers": dict(headers or {}), "json": json_body})
        r = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(r, Exception):
            raise r
        if callable(r):
            return r()
        return r


def resp(body, status: int = 200) -> HttpResponse:
    if isinstance(body, dict) and "body" in body and "status" in body and "_source" in body:
        status, body = body["status"], body["body"]          # 录制的 Nominatim 样例
    return HttpResponse(status, json.dumps(body, ensure_ascii=False).encode("utf-8"))


@pytest.fixture(autouse=True)
def _no_network(monkeypatch, tmp_path):
    """任何测试里真的去连网 = 失败。数据目录钉到 tmp。"""
    def boom(*a, **k):
        raise AssertionError("测试里不许发真实网络请求")
    monkeypatch.setattr(urllib.request, "urlopen", boom)
    monkeypatch.setenv("EPHEMERA_DATA_DIR", str(tmp_path / "data"))
    for k in ("EPHEMERA_GOOGLE_MAPS_KEY", "EPHEMERA_AMAP_KEY", "EPHEMERA_PLACES_PROVIDER", "EPHEMERA_PLACES_FALLBACK",
              "EPHEMERA_NOMINATIM_URL", "EPHEMERA_OSM_FLAVOR", "EPHEMERA_NOMINATIM_UA", "EPHEMERA_PLACES_CACHE",
              "EPHEMERA_AMAP_CITY", "EPHEMERA_GOOGLE_REGION"):
        monkeypatch.delenv(k, raising=False)
