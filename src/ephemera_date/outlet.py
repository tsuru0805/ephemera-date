"""Event outlet: user-facing date events (envelope / telegram / cancel / close / late written) → the
user's webhook and/or Web Push subscriptions.

Events are written with push_state='pending' inside the edit's own transaction (plan._add_event). The
scheduler (serve process only) sweeps them: each row is claimed pending → sending one at a time and sent to
every target (the webhook EPHEMERA_EVENT_WEBHOOK; each Web Push subscription, see webpush.py). Each
(event, target) pair is delivered at most once (date_event_deliveries); a failed or uncertain delivery is
not retried (she still sees the event in the page's event list); "never reached it" (connection refused,
429 / 503) is retried next round. A row left in 'sending' by a crash is marked unknown, never resent. Rows
that were never reached stay pending and go out after a restart. Every request carries an
``Idempotency-Key: ephemera-event-<id>`` header so a receiver can drop duplicates.

Webhook payload: fixed, spoiler-free texts (name and date) and where the page should open — never places,
clues or any body text. Web Push payload (through the browser vendor's service): fixed title, "Ephemera"
and where to open — not even the name.

No target configured = events are marked skipped (the page's event list is unaffected).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging

import httpx

from . import config
from . import plan as dp

log = logging.getLogger("ephemera_date.outlet")

SENDING_STALE_S = 600.0
TIMEOUT_S = 10.0


def push_text(kind: str, plan: dict) -> tuple[str, str] | None:
    """(title, body), fixed texts. Unknown kind → None (not pushed)."""
    name = f"「{dp.full_name(plan)}」"
    if kind == "envelope":
        return dp.TXT_ENVELOPE, f"Ephemera · {dp._md(plan['date'])}"
    if kind in ("telegram_manual", "telegram_auto"):
        return "有一封新电报", name
    if kind == "cancel":
        return "约会取消了", f"{name} · 有一封电报"
    if kind == "close":
        return dp.TXT_CLOSE, name
    if kind == "late_written":                 # the AI wrote, after the date, the piece she was waiting for
        return plan.get("text") or f"{config.him()}写好了", name
    return None


_PAGES = {"envelope": "seal", "telegram_manual": "telegrams", "telegram_auto": "telegrams",
          "cancel": "telegrams", "close": "box", "late_written": "box"}


def page_of(kind: str, plan_id: int) -> dict | None:
    """Where tapping the notification should land (embed protocol navigate{page, planId})."""
    page = _PAGES.get(kind)
    if page is None:
        return None
    return {"page": page, "planId": plan_id if page in ("seal", "box") else None}


def _sign(body: bytes) -> dict:
    secret = config.webhook_secret()
    if not secret:
        return {}
    return {"X-Ephemera-Signature": "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()}


def post_json(url: str, payload: dict, *, client: httpx.Client | None = None,
              idempotency_key: str | None = None) -> str:
    """POST → sent (2xx) / not_sent (never reached the receiver: connection refused, 429, 503) /
    unknown (it may have been handled: timeout after sending, 502, 504, other 5xx) / failed (4xx)."""
    body = json.dumps(payload, ensure_ascii=False).encode()
    headers = {"Content-Type": "application/json", **_sign(body)}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    own = client is None
    c = client or httpx.Client(timeout=TIMEOUT_S)
    try:
        r = c.post(url, content=body, headers=headers)
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return "not_sent"
    except httpx.HTTPError as e:
        log.warning("[outlet] webhook error after sending: %r", e)
        return "unknown"
    finally:
        if own:
            c.close()
    if 200 <= r.status_code < 300:
        return "sent"
    if r.status_code in (429, 503):
        return "not_sent"
    if r.status_code >= 500:
        return "unknown"
    return "failed"


_DELIVERIES = """CREATE TABLE IF NOT EXISTS date_event_deliveries (
    event_id INTEGER NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, at REAL NOT NULL,
    PRIMARY KEY (event_id, target))"""


def _targets(send, path) -> list[tuple[str, object]]:
    """[(target name, fn(payload, key) -> state)]."""
    from . import webpush
    if send is not None:
        return [("custom", lambda payload, key: send(payload))]
    out = []
    url = config.event_webhook()
    if url:
        out.append(("webhook", lambda payload, key: post_json(url, payload, idempotency_key=key)))
    if webpush.enabled():
        for sub in webpush.subscriptions(path=path):
            out.append((f"webpush:{sub['id']}",
                        lambda payload, key, sub=sub: webpush.send(sub, web_payload(payload), key, path=path)))
    return out


def _pending(conn) -> list[int]:
    return [r[0] for r in conn.execute(
        "SELECT id FROM date_events WHERE push_state='pending' ORDER BY created_at, id")]


def web_payload(payload: dict) -> dict:
    """What goes through the browser vendor's push service: fixed title, the app name, where to open."""
    title = {"late_written": f"{config.him()}写好了"}.get(payload["kind"], payload["title"])
    return {"title": title, "body": "Ephemera", "navigate": payload["navigate"], "event_id": payload["event_id"]}


def sweep(send=None, now=None, *, path: str | None = None, still_owner=None) -> dict:
    """Push every pending event once per target. send(payload) -> state replaces all targets (tests).
    still_owner() False = stop now (the scheduler lost its lease)."""
    out = {"sent": 0, "failed": 0, "skipped": 0, "unknown": 0, "released": 0}
    ts = dp._as_tz(now).timestamp()
    conn = dp._connect(path)
    try:
        conn.execute(_DELIVERIES)
        targets = _targets(send, path)
        if not targets:
            out["skipped"] = conn.execute("UPDATE date_events SET push_state='skipped' WHERE push_state='pending'").rowcount
            return out
        out["unknown"] += conn.execute(
            "UPDATE date_events SET push_state='unknown' WHERE push_state='sending' AND created_at < ?",
            (ts - SENDING_STALE_S,)).rowcount
        for ev_id in _pending(conn):
            if still_owner is not None and not still_owner():
                break
            cur = conn.execute("UPDATE date_events SET push_state='sending' WHERE id=? AND push_state='pending'", (ev_id,))
            if cur.rowcount != 1:
                continue
            r = conn.execute("SELECT e.id, e.kind, e.plan_id, e.text, p.title_en, p.title_zh, p.date FROM date_events e"
                             " JOIN date_plans p ON p.id = e.plan_id WHERE e.id=?", (ev_id,)).fetchone()
            r = dict(r) if r else None
            txt = push_text(r["kind"], r) if r else None
            if txt is None:
                conn.execute("UPDATE date_events SET push_state='skipped' WHERE id=?", (ev_id,))
                out["skipped"] += 1
                continue
            payload = {"type": "event", "kind": r["kind"], "title": txt[0], "body": txt[1],
                       "plan_id": r["plan_id"], "event_id": r["id"], "navigate": page_of(r["kind"], r["plan_id"])}
            done = {t: st for t, st in conn.execute(
                "SELECT target, state FROM date_event_deliveries WHERE event_id=?", (ev_id,))}
            states, retry, lost = [], False, False
            for name, fn in targets:
                if still_owner is not None and not still_owner():
                    lost = True                         # lease lost between targets: stop right here
                    break
                if name in done:
                    states.append(done[name])
                    continue
                try:
                    state = fn(payload, f"ephemera-event-{ev_id}")
                except Exception as e:  # noqa: BLE001
                    log.warning("[outlet] push raised, not retried: %r", e)
                    state = "unknown"
                if state == "not_sent":
                    retry = True
                    continue
                if state not in ("sent", "failed", "unknown"):
                    state = "unknown"
                conn.execute("INSERT OR IGNORE INTO date_event_deliveries (event_id, target, state, at) VALUES (?,?,?,?)",
                             (ev_id, name, state, ts))
                states.append(state)
            if lost:
                # the rest of this event's targets belong to the next owner (delivered ones are recorded)
                conn.execute("UPDATE date_events SET push_state='pending' WHERE id=? AND push_state='sending'", (ev_id,))
                break
            if retry:
                conn.execute("UPDATE date_events SET push_state='pending' WHERE id=? AND push_state='sending'", (ev_id,))
                out["released"] += 1
                if send is not None or len(targets) == 1:
                    break                              # the only endpoint is down: stop this round, keep order
                continue
            final = "sent" if states and all(x == "sent" for x in states) else \
                ("unknown" if "unknown" in states else ("failed" if states else "skipped"))
            if "sent" in states and final != "sent":
                final = "sent"                          # reached her somewhere; per-target detail is in deliveries
            conn.execute("UPDATE date_events SET push_state=? WHERE id=? AND push_state='sending'", (final, ev_id))
            out[final] += 1
    finally:
        conn.close()
    if any(out.values()):
        log.info("[outlet] %s", out)
    return out
