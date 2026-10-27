"""Self-test of the no-network guard in conftest: outside lookups, connects (connect / connect_ex /
create_connection) and datagrams fail the test; proxies are cleared; this machine stays reachable."""
from __future__ import annotations

import os
import socket

import pytest

from conftest import PROXY_VARS, clear_proxies

OUTSIDE = "192.0.2.1"            # TEST-NET-1 (RFC 5737): never routed; refused before any packet anyway


def test_outside_lookup_and_connects_are_refused():
    with pytest.raises(AssertionError, match="不许连外网"):
        socket.getaddrinfo("example.com", 443)
    with pytest.raises(AssertionError, match="不许连外网"):
        socket.create_connection((OUTSIDE, 80), timeout=0.1)
    for how in ("connect", "connect_ex"):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(AssertionError, match="不许连外网"):
                getattr(s, how)((OUTSIDE, 80))
        finally:
            s.close()
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        with pytest.raises(AssertionError, match="不许连外网"):
            u.sendto(b"x", (OUTSIDE, 53))
        with pytest.raises(AssertionError, match="不许连外网"):
            u.sendto(b"x", 0, (OUTSIDE, 53))
    finally:
        u.close()


def test_this_machine_is_still_reachable():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    try:
        c = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        assert c.connect_ex(srv.getsockname()) == 0
        c.close()
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        u.sendto(b"x", ("127.0.0.1", srv.getsockname()[1]))
        u.close()
    finally:
        srv.close()


def test_proxies_are_cleared(monkeypatch):
    assert not any(os.environ.get(k) for k in PROXY_VARS)            # the autouse fixture already ran
    for k in PROXY_VARS:
        monkeypatch.setenv(k, "http://proxy.invalid:8080")
    clear_proxies(monkeypatch)
    assert not any(k in os.environ for k in PROXY_VARS)


def test_system_proxy_settings_are_ignored():
    """macOS/Windows 上 urllib 会读系统代理;测试里必须返回空,免得经本机代理真实出网。"""
    import urllib.request
    assert urllib.request.getproxies() == {}
