"""AI to-do channel: one table, three ways for the AI to get it.

The AI that writes dates lives in whatever MCP client the user runs; nothing can wake it from outside.
Due reminders and "please write" requests are therefore put into one to-do table (``ai_inbox``) that is
reachable three ways:

1. pull    — every date tool receipt ends with the open to-do count; ``date_inbox`` lists, claims and
             confirms them.
2. context — ``GET /context`` returns the to-dos plus a short date status, for a self-hosted relay to
             append to the system prompt each turn (``?claim=<client>`` also claims what it shows).
3. push    — optional webhook (EPHEMERA_AI_WEBHOOK): each new, unclaimed to-do is POSTed once with an
             ``Idempotency-Key`` header, so the user's own relay can wake the AI.

Showing is not claiming. Any path may *show* an open to-do; *claiming* it (to act on it) is exclusive.
Protocol:
- The claimer is one unique session, never an application name: ``pull:<MCP session id>`` (HTTP: the
  mcp-session-id of that connection; stdio: a random id per process) or ``context:<client id>`` (the relay
  must pass its own unique id). The application's display name is stored only as ``claimed_label``.
- One claimer at a time; a claim runs out after CLAIM_TTL_S and the to-do is claimable again.
- Only the claimer may confirm done (or release). Done = closed for everyone.
- The webhook only *wakes*: pushing never claims, and "being pushed" / "pushed" never blocks a claim. The
  woken receiver must claim successfully before acting, exactly like any other client.

A reminder to-do is a merged round of reminder lines; each line keeps its own validity: an expired line,
or one whose reminder no longer exists (the date was moved / cancelled), drops out of the text, and the
to-do closes when no line is left. A "please write" to-do closes itself when everything asked for is written.

Delivery into the table is idempotent per source key and runs inside the scheduler's own transaction.

The "please write" entry on the page is only offered when at least one path is configured
(``write_request_available``; configuration, not recent activity, decides).
"""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime
from urllib.parse import urlparse

from . import config
from . import plan as dp

log = logging.getLogger("ephemera_date.inbox")

CLAIM_TTL_S = 30 * 60.0
KIND_ZH = {"reminder": "约会提醒", "write_request": "她请你补写", "memory_notice": "约会记忆"}

_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS ai_inbox (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         kind TEXT NOT NULL,
         source_key TEXT NOT NULL UNIQUE,
         plan_ids TEXT NOT NULL DEFAULT '[]',
         ask_ids TEXT NOT NULL DEFAULT '[]',
         parts TEXT NOT NULL DEFAULT '[]',
         text TEXT NOT NULL,
         created_at REAL NOT NULL,
         expire_at REAL,
         shown_at REAL,
         shown_via TEXT,
         claimed_by TEXT,
         claimed_label TEXT,
         claimed_at REAL,
         claim_until REAL,
         done_at REAL,
         done_via TEXT,
         closed_at REAL,
         closed_why TEXT,
         push_state TEXT NOT NULL DEFAULT 'pending',
         push_claimed_at REAL,
         push_at REAL)""",
    "CREATE INDEX IF NOT EXISTS ix_ai_inbox_open ON ai_inbox(done_at, closed_at, created_at)",
    """CREATE TABLE IF NOT EXISTS ephemera_meta (
         key TEXT PRIMARY KEY, value TEXT, updated_at REAL)""",
)


def ensure(conn: sqlite3.Connection, path: str | None = None) -> None:
    """The tables are created with the engine schema (plan.ensure_schema); nothing to do per connection."""


def connect(path: str | None = None) -> sqlite3.Connection:
    return dp._connect(path)


def _now(now: datetime | None) -> datetime:
    return dp._as_tz(now)


# ── meta (activity, scheduler lease) ──────────────────────────────────────────
def meta_get(conn: sqlite3.Connection, key: str) -> tuple[str | None, float | None]:
    r = conn.execute("SELECT value, updated_at FROM ephemera_meta WHERE key=?", (key,)).fetchone()
    return (r[0], r[1]) if r else (None, None)


def meta_set(conn: sqlite3.Connection, key: str, value: str, ts: float) -> None:
    conn.execute("INSERT INTO ephemera_meta (key, value, updated_at) VALUES (?, ?, ?)"
                 " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                 (key, value, ts))


def record_use(channel: str, now: datetime | None = None, *, path: str | None = None) -> None:
    """The AI used a path (an MCP tool call = pull, a /context fetch = context). Information only."""
    ts = _now(now).timestamp()
    conn = connect(path)
    try:
        meta_set(conn, f"channel_seen:{channel}", "1", ts)
    finally:
        conn.close()


def activity(*, path: str | None = None) -> dict:
    """When each path was last used (epoch seconds or None). Shown to the user; never decides anything."""
    conn = connect(path)
    try:
        return {ch: meta_get(conn, f"channel_seen:{ch}")[1] for ch in ("pull", "context")}
    finally:
        conn.close()


def webhook_url_ok(url: str | None = None) -> bool:
    url = config.ai_webhook() if url is None else url
    try:
        u = urlparse(url)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and bool(u.hostname)


def channels() -> list[str]:
    """Configured paths. EPHEMERA_AI_CHANNELS wins (webhook still needs a valid URL); unset = pull and
    context when the AI token is configured, webhook when EPHEMERA_AI_WEBHOOK is a valid URL."""
    forced = config.ai_channels_override()
    hook = ["webhook"] if webhook_url_ok() else []
    if forced is not None:
        return [c for c in ("pull", "context") if c in forced] + (hook if "webhook" in forced else [])
    return (["pull", "context"] if config.ai_token() else []) + hook


def write_request_available() -> bool:
    return bool(channels())


# ── delivery (called by the scheduler through remind.py, inside its transaction) ──
def deliver(kind: str, text: str, source_key: str, *, plan_ids=(), ask_ids=(), parts=None,
            expire_at: float | None = None, now: datetime | None = None, path: str | None = None,
            conn: sqlite3.Connection | None = None) -> int | None:
    """Put one to-do in. Same source_key twice = the existing one, nothing new. Returns its id.
    conn = the caller's open transaction (same commit as the source rows); None = own connection."""
    if kind not in KIND_ZH:
        raise ValueError(kind)
    ts = _now(now).timestamp()
    own = conn is None
    c = connect(path) if own else conn
    try:
        ensure(c, path)
        c.execute("INSERT OR IGNORE INTO ai_inbox (kind, source_key, plan_ids, ask_ids, parts, text, created_at,"
                  " expire_at, push_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  (kind, source_key, json.dumps(sorted(set(plan_ids))), json.dumps(sorted(set(ask_ids))),
                   json.dumps(parts or [], ensure_ascii=False), text, ts, expire_at,
                   "pending" if webhook_url_ok() else "skipped"))
        r = c.execute("SELECT id FROM ai_inbox WHERE source_key=?", (source_key,)).fetchone()
        return r[0] if r else None
    finally:
        if own:
            c.close()


def wake_reminders(body: str, meta: dict) -> str:
    """remind.process_reminders wake callback: the merged round becomes one to-do (same transaction)."""
    deliver("reminder", body, "reminder:" + "|".join(sorted(meta["keys"])), plan_ids=meta.get("plan_ids") or (),
            parts=meta.get("parts"), expire_at=meta.get("expire_at"), now=meta.get("now"), path=meta.get("path"),
            conn=meta.get("conn"))
    return "sent"


def wake_write_requests(body: str, meta: dict) -> str:
    """remind.process_write_requests wake callback (same transaction)."""
    deliver("write_request", body, "write_request:" + ",".join(str(i) for i in sorted(meta["ask_ids"]))
            + f"@{meta.get('round', '')}", plan_ids=meta.get("plan_ids") or (), ask_ids=meta["ask_ids"],
            now=meta.get("now"), path=meta.get("path"), conn=meta.get("conn"))
    return "sent"


# ── settling: what is still open, and what its text is now ──────────────────
def _plan_keys(conn: sqlite3.Connection, plan_id: int, now: datetime, cache: dict) -> set:
    if plan_id not in cache:
        st = dp._load(conn, plan_id)
        cache[plan_id] = {r["key"] for r in dp.reminder_plan(st, now)} if st is not None else set()
    return cache[plan_id]


def _alive_parts(conn, row: dict, now: datetime, cache: dict) -> list[dict]:
    ts = now.timestamp()
    out = []
    for p in json.loads(row.get("parts") or "[]"):
        if p.get("expire_at") is not None and ts >= p["expire_at"]:
            continue
        if p.get("key") not in _plan_keys(conn, p["plan_id"], now, cache):
            continue                                   # moved / cancelled / closed: that line no longer stands
        out.append(p)
    return out


def _settle(conn: sqlite3.Connection, now: datetime) -> list[dict]:
    """Close what no longer needs doing and return the open rows with their current text."""
    ts = now.timestamp()
    cache: dict = {}
    out = []
    for r in conn.execute("SELECT * FROM ai_inbox WHERE done_at IS NULL AND closed_at IS NULL"
                          " ORDER BY created_at, id").fetchall():
        r = dict(r)
        if r["kind"] == "write_request":
            ids = json.loads(r["ask_ids"] or "[]")
            if ids:
                marks = ",".join("?" * len(ids))
                left = conn.execute(f"SELECT COUNT(*) FROM date_asks WHERE id IN ({marks}) AND done_at IS NULL",
                                    ids).fetchone()[0]
                if left == 0:
                    conn.execute("UPDATE ai_inbox SET done_at=?, done_via='written' WHERE id=? AND done_at IS NULL",
                                 (ts, r["id"]))
                    continue
            if r["expire_at"] is not None and ts >= r["expire_at"]:
                conn.execute("UPDATE ai_inbox SET closed_at=?, closed_why='expired' WHERE id=?", (ts, r["id"]))
                continue
            r["current"] = r["text"]
        else:
            parts = json.loads(r["parts"] or "[]")
            if not parts:                              # delivered without parts: whole-item validity
                if r["expire_at"] is not None and ts >= r["expire_at"]:
                    conn.execute("UPDATE ai_inbox SET closed_at=?, closed_why='expired' WHERE id=?", (ts, r["id"]))
                    continue
                r["current"] = r["text"]
            else:
                alive = _alive_parts(conn, r, now, cache)
                if not alive:
                    why = "expired" if all(ts >= p["expire_at"] for p in parts if p.get("expire_at") is not None) \
                        else "void"
                    conn.execute("UPDATE ai_inbox SET closed_at=?, closed_why=? WHERE id=?", (ts, why, r["id"]))
                    continue
                r["current"] = dp.REMIND_HEAD + " " + "\n".join(p["line"] for p in alive)
        out.append(r)
    return out


def _run(path, fn):
    conn = connect(path)
    conn.execute("BEGIN IMMEDIATE")
    try:
        out = fn(conn)
        conn.execute("COMMIT")
        return out
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def _holder(r: dict, ts: float) -> str | None:
    return r["claimed_by"] if r.get("claimed_by") and (r.get("claim_until") or 0) > ts else None


def _blocked_for(r: dict, who: str, ts: float) -> str | None:
    """Who holds it against ``who`` (None = free for who): the display label of the other claimer."""
    h = _holder(r, ts)
    if h is None or h == who:
        return None
    return r.get("claimed_label") or h


def open_items(via: str, now: datetime | None = None, *, path: str | None = None) -> list[dict]:
    """Show the open to-dos (no claiming). Rows carry ``current`` text and ``holder``."""
    now = _now(now)
    ts = now.timestamp()

    def go(conn):
        rows = _settle(conn, now)
        for r in rows:
            if r["shown_at"] is None:
                conn.execute("UPDATE ai_inbox SET shown_at=?, shown_via=? WHERE id=? AND shown_at IS NULL",
                             (ts, via, r["id"]))
            r["holder"] = _holder(r, ts)
        return rows
    return _run(path, go)


def count_open(now: datetime | None = None, *, path: str | None = None) -> int:
    now = _now(now)
    return _run(path, lambda conn: len(_settle(conn, now)))


def _ids(ids) -> list[int]:
    out = []
    for i in ids or []:
        if isinstance(i, bool):
            continue
        if isinstance(i, int):
            out.append(i)
        elif isinstance(i, str) and i.strip().isdigit():
            out.append(int(i.strip()))
    return out


def claim(ids, who: str, now: datetime | None = None, *, path: str | None = None,
          ttl: float = CLAIM_TTL_S, label: str | None = None) -> dict:
    """Claim to-dos for ``who`` (exclusive until the claim runs out). ids=None = every claimable open one.
    → {"claimed": [...], "held": {id: holder}, "closed": [...], "unknown": [...]}"""
    now = _now(now)
    ts = now.timestamp()

    def go(conn):
        rows = {r["id"]: r for r in _settle(conn, now)}
        want = list(rows) if ids is None else _ids(ids)
        out = {"claimed": [], "held": {}, "closed": [], "unknown": []}
        for i in want:
            r = rows.get(i)
            if r is None:
                exists = conn.execute("SELECT 1 FROM ai_inbox WHERE id=?", (i,)).fetchone()
                out["closed" if exists else "unknown"].append(i)
                continue
            h = _blocked_for(r, who, ts)
            if h is not None:
                if ids is not None:
                    out["held"][i] = h
                continue
            cur = conn.execute("UPDATE ai_inbox SET claimed_by=?, claimed_label=?, claimed_at=?, claim_until=?"
                               " WHERE id=? AND done_at IS NULL AND (claimed_by IS NULL OR claimed_by=? OR claim_until<=?)",
                               (who, label or who, ts, ts + ttl, i, who, ts))
            if cur.rowcount != 1:
                continue
            out["claimed"].append(i)
        return out
    return _run(path, go)


def release(ids, who: str, now: datetime | None = None, *, path: str | None = None) -> list[int]:
    def go(conn):
        got = []
        for i in _ids(ids):
            cur = conn.execute("UPDATE ai_inbox SET claimed_by=NULL, claimed_label=NULL, claim_until=NULL WHERE id=? AND claimed_by=?"
                               " AND done_at IS NULL", (i, who))
            if cur.rowcount:
                got.append(i)
        return got
    return _run(path, go)


def mark_done(ids, who: str, now: datetime | None = None, *, path: str | None = None) -> dict:
    """Confirm done: only the current claimer may (claim first). Refused otherwise, saying who holds it.
    → {"done": [...], "already": [...], "held": {id: holder}, "unclaimed": [...], "unknown": [...]}"""
    now = _now(now)
    ts = now.timestamp()

    def go(conn):
        rows = {r["id"]: r for r in _settle(conn, now)}
        out = {"done": [], "already": [], "held": {}, "unclaimed": [], "unknown": []}
        for i in _ids(ids):
            r = rows.get(i)
            if r is None:
                exists = conn.execute("SELECT 1 FROM ai_inbox WHERE id=?", (i,)).fetchone()
                out["already" if exists else "unknown"].append(i)
                continue
            h = _blocked_for(r, who, ts)
            if h is not None:
                out["held"][i] = h
                continue
            if _holder(r, ts) != who:
                out["unclaimed"].append(i)
                continue
            conn.execute("UPDATE ai_inbox SET done_at=?, done_via=? WHERE id=? AND done_at IS NULL", (ts, who, i))
            out["done"].append(i)
        return out
    return _run(path, go)


def _stamp(ts: float) -> str:
    t = datetime.fromtimestamp(ts, config.tz())
    return f"{t.month}/{t.day} {t:%H:%M}"


def render_items(rows: list[dict], who: str | None = None) -> str:
    if not rows:
        return "约会待办：没有。"
    out = [f"约会待办 {len(rows)} 件："]
    for r in rows:
        h = r.get("holder")
        if h is None:
            state = "（可领取）"
        elif h == who:
            state = f"（你领取了，到 {_stamp(r['claim_until'])}）"
        else:
            state = f"（{r.get('claimed_label') or h} 在处理，到 {_stamp(r['claim_until'])}）"
        body = r["current"].replace("\n", "\n    ")
        out.append(f"[待办 {r['id']}] {_stamp(r['created_at'])} · {config.who(KIND_ZH[r['kind']])}{state}\n    {body}")
    out.append("要处理先用 date_inbox 的 op=claim、ids=[编号] 领取；做完用 op=done 确认。")
    return "\n".join(out)


def context_text(now: datetime | None = None, *, claim_for: str | None = None, path: str | None = None) -> str:
    """GET /context: to-dos + date status (the ledger), plain text for a system prompt.
    claim_for = the caller's unique client id: also claim, for "context:<id>", what this text shows as claimable."""
    from . import tools          # tools imports this module
    now = _now(now)
    record_use("context", now, path=path)
    who = f"context:{claim_for}" if claim_for else None
    if who:
        claim(None, who, now, path=path, label=who)
    rows = open_items("context", now, path=path)
    parts = [render_items(rows, who)]
    ledger, _key = tools.ledger_block(now, path=path)
    if ledger:
        parts.append(ledger)
    return "\n\n".join(parts)


# ── push (optional webhook) ───────────────────────────────────────────────────
PUSH_CLAIM_STALE_S = 900.0
PUSH_GIVE_UP_S = 24 * 3600.0


def _in_quiet(now: datetime) -> bool:
    q = config.quiet_hours()
    if not q or not all(dp._hm_ok(x) for x in q):
        return False
    hm = now.strftime("%H:%M")
    a, b = q
    return a <= hm < b if a <= b else (hm >= a or hm < b)


def push_pending(send=None, now: datetime | None = None, *, path: str | None = None, still_owner=None) -> dict:
    """Wake-up only: POST each new, unclaimed to-do once (Idempotency-Key: ephemera-todo-<id>). Never claims.
    send(payload, key) -> sent / not_sent / unknown / failed (outlet.post_json). not_sent (never reached the
    receiver) = retry next round; the other three are final. Quiet hours = wait. still_owner() False = stop."""
    from . import outlet
    now = _now(now)
    ts = now.timestamp()
    out = {"sent": 0, "failed": 0, "unknown": 0, "released": 0, "deferred": 0, "expired": 0, "claimed": 0}
    url = config.ai_webhook()
    ok_url = webhook_url_ok(url)

    def prepare(conn):
        rows = {r["id"]: r for r in _settle(conn, now)}     # finished / expired ones are closed first
        if not ok_url:
            conn.execute("UPDATE ai_inbox SET push_state='skipped' WHERE push_state='pending'")
        out["unknown"] += conn.execute(
            "UPDATE ai_inbox SET push_state='unknown' WHERE push_state='sending' AND push_claimed_at < ?",
            (ts - PUSH_CLAIM_STALE_S,)).rowcount
        out["expired"] += conn.execute(
            "UPDATE ai_inbox SET push_state='expired' WHERE push_state='pending' AND"
            " (done_at IS NOT NULL OR closed_at IS NOT NULL OR created_at < ?)", (ts - PUSH_GIVE_UP_S,)).rowcount
        todo = []
        for r in conn.execute("SELECT id FROM ai_inbox WHERE push_state='pending' ORDER BY created_at, id").fetchall():
            row = rows.get(r[0])
            if row is None:
                continue
            if _holder(row, ts) is not None:              # someone is already on it: no need to wake anyone
                conn.execute("UPDATE ai_inbox SET push_state='claimed' WHERE id=?", (row["id"],))
                out["claimed"] += 1
                continue
            todo.append(row)
        return todo
    rows = _run(path, prepare)
    if not ok_url or not rows:
        return out
    if _in_quiet(now):
        out["deferred"] += len(rows)
        return out
    send = send or (lambda payload, key: outlet.post_json(url, payload, idempotency_key=key))
    conn = connect(path)
    try:
        for r in rows:
            if still_owner is not None and not still_owner():
                break
            # 'sending' only marks the wake-up; it does not claim (claims ignore push_state)
            cur = conn.execute("UPDATE ai_inbox SET push_state='sending', push_claimed_at=? WHERE id=? AND push_state='pending'"
                               " AND done_at IS NULL AND closed_at IS NULL", (ts, r["id"]))
            if cur.rowcount != 1:
                continue
            payload = {"type": "ai_todo", "id": r["id"], "kind": r["kind"], "text": r["current"],
                       "plan_ids": json.loads(r["plan_ids"] or "[]"), "created_at": r["created_at"],
                       "_meta": {"ephemera/secret": True}}
            try:
                state = send(payload, f"ephemera-todo-{r['id']}")
            except Exception as e:  # noqa: BLE001
                log.warning("[inbox] webhook raised, treated as unknown: %r", e)
                state = "unknown"
            if state == "not_sent":
                conn.execute("UPDATE ai_inbox SET push_state='pending', push_claimed_at=NULL WHERE id=? AND push_state='sending'",
                             (r["id"],))
                out["released"] += 1
                continue
            if state not in ("sent", "failed", "unknown"):
                state = "unknown"
            conn.execute("UPDATE ai_inbox SET push_state=?, push_at=? WHERE id=? AND push_state='sending'",
                         (state, ts, r["id"]))
            out[state] += 1
        return out
    finally:
        conn.close()
