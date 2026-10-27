"""Web Push for the page opened on its own (no host app to show notifications).

The page subscribes through the her-side API (``POST /api/push/subscribe`` with a PushSubscription); the
event outlet then sends each user-facing event to every subscription. The payload carries only a fixed
title, the word "Ephemera" and where to open (``navigate``) — never a date's name, places or any text —
because it passes through the browser vendor's push service.

Needs EPHEMERA_VAPID_PRIVATE_KEY / EPHEMERA_VAPID_PUBLIC_KEY / EPHEMERA_VAPID_SUBJECT (``ephemera-date vapid-keys``
prints a fresh pair). Unset = Web Push off; subscribing is refused with a reason.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from urllib.parse import urlparse

from . import config
from . import plan as dp

log = logging.getLogger("ephemera_date.webpush")

TIMEOUT_S = 10.0
TTL_S = 24 * 3600
MAX_SUBSCRIPTIONS = 20

_SCHEMA = """CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL,
    auth TEXT NOT NULL, created_at REAL NOT NULL, last_ok_at REAL)"""


class SubscribeError(Exception):
    def __init__(self, status: int, code: str, text: str):
        super().__init__(text)
        self.status, self.code, self.text = status, code, text


def enabled() -> bool:
    return bool(config.vapid_private_key() and config.vapid_public_key() and config.vapid_subject())


def _conn(path: str | None = None) -> sqlite3.Connection:
    c = dp._connect(path)
    c.execute(_SCHEMA)
    return c


def _check(sub) -> tuple[str, str, str]:
    if not isinstance(sub, dict):
        raise SubscribeError(400, "bad_body", "要传浏览器给的订阅对象：{endpoint, keys:{p256dh, auth}}")
    ep, keys = sub.get("endpoint"), sub.get("keys")
    u = urlparse(ep) if isinstance(ep, str) else None
    if not ep or len(ep) > 1000 or u is None or u.scheme != "https" or not u.hostname:
        raise SubscribeError(400, "bad_endpoint", "endpoint 要是 https:// 开头的推送地址")
    if not isinstance(keys, dict) or not all(isinstance(keys.get(k), str) and 0 < len(keys[k]) <= 200
                                             for k in ("p256dh", "auth")):
        raise SubscribeError(400, "bad_keys", "keys 里要有 p256dh 和 auth")
    return ep, keys["p256dh"], keys["auth"]


def subscribe(sub, *, path: str | None = None) -> dict:
    if not enabled():
        raise SubscribeError(503, "not_configured", "网页推送没有配置")
    ep, p256dh, auth = _check(sub)
    c = _conn(path)
    try:
        n = c.execute("SELECT COUNT(*) FROM push_subscriptions WHERE endpoint<>?", (ep,)).fetchone()[0]
        if n >= MAX_SUBSCRIPTIONS:
            raise SubscribeError(409, "full", f"最多 {MAX_SUBSCRIPTIONS} 个设备")
        c.execute("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?)"
                  " ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth",
                  (ep, p256dh, auth, time.time()))
    finally:
        c.close()
    return {"subscribed": True}


def unsubscribe(endpoint, *, path: str | None = None) -> dict:
    c = _conn(path)
    try:
        n = c.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,)).rowcount if isinstance(endpoint, str) else 0
    finally:
        c.close()
    return {"removed": n}


def subscriptions(*, path: str | None = None) -> list[dict]:
    c = _conn(path)
    try:
        return [dict(r) for r in c.execute("SELECT * FROM push_subscriptions ORDER BY id")]
    finally:
        c.close()


def _drop(sub_id: int, path: str | None) -> None:
    c = _conn(path)
    try:
        c.execute("DELETE FROM push_subscriptions WHERE id=?", (sub_id,))
    finally:
        c.close()


def _mark_ok(sub_id: int, path: str | None) -> None:
    c = _conn(path)
    try:
        c.execute("UPDATE push_subscriptions SET last_ok_at=? WHERE id=?", (time.time(), sub_id))
    finally:
        c.close()


def _vapid():
    from py_vapid import Vapid02
    key = config.vapid_private_key()
    return Vapid02.from_pem(key.encode()) if "BEGIN" in key else Vapid02.from_string(private_key=key)


def _webpush(sub: dict, data: str, key: str):
    from pywebpush import webpush        # imported lazily: only needed when Web Push is configured
    return webpush({"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                   data=data, vapid_private_key=_vapid(),
                   vapid_claims={"sub": config.vapid_subject()}, timeout=TIMEOUT_S, ttl=TTL_S,
                   headers={"Topic": key[-32:]})


def send(sub: dict, payload: dict, key: str, *, path: str | None = None) -> str:
    """One push → sent / not_sent / unknown / failed. A subscription the push service says is gone is removed."""
    import requests
    from pywebpush import WebPushException
    try:
        _webpush(sub, json.dumps(payload, ensure_ascii=False), key)
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        if status in (404, 410):
            _drop(sub["id"], path)
            return "failed"
        if status in (429, 503):
            return "not_sent"
        if status is not None and status >= 500:
            return "unknown"
        return "failed"
    except (requests.ConnectionError, requests.exceptions.ConnectTimeout):
        return "not_sent"
    except requests.RequestException as e:
        log.warning("[webpush] error after sending: %r", e)
        return "unknown"
    _mark_ok(sub["id"], path)
    return "sent"


def generate_keys() -> dict:
    """A fresh VAPID key pair as env values (private = base64url DER, public = base64url for applicationServerKey)."""
    import base64

    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid02
    v = Vapid02()
    v.generate_keys()
    der = v.private_key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
                                      serialization.NoEncryption())
    raw = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    return {"EPHEMERA_VAPID_PRIVATE_KEY": b64(der),
            "EPHEMERA_VAPID_PUBLIC_KEY": b64(raw)}
