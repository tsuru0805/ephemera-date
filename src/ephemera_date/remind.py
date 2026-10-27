"""Reminder and "please write" scheduling: due items go into the AI to-do table (inbox.py).

- Plan: plan.reminder_plan (pure, computed from the date as it is now); every write voids reminders that no
  longer match (plan._reminders_hook).
- Scheduling: only the serve process runs this (scheduler.py, every minute). Candidates = reminders in the
  current plan that are due and not expired; dedupe key = kind+plan+stop_id+basis+planned time (primary key
  of date_reminders, INSERT OR IGNORE); everything due at once is merged into one round; each row is claimed
  atomically before delivery. Four outcomes of a delivery: sent / cancelled / unknown are final;
  not_sent releases the claim for a retry next minute. A claim left unresolved for 15 minutes = abandoned;
  due but never delivered before its validity ends = expired; no longer in the current plan = void.
- in_quiet = wait (the caller decides; the scheduler passes False because the to-do table is always readable).
- Text = the fixed lines built in plan.py, first line headed "[约会提醒]" / "[约会请写]"; only facts she can
  see at that moment.
"""
from __future__ import annotations

import logging
from datetime import datetime

from . import plan as dp

log = logging.getLogger("ephemera_date.remind")

CLAIM_STALE_S = 900.0

WAKE_SENT = "sent"
WAKE_CANCELLED = "cancelled"
WAKE_NOT_SENT = "not_sent"
WAKE_UNKNOWN = "unknown"
_WAKE_TERMINAL = (WAKE_SENT, WAKE_CANCELLED, WAKE_UNKNOWN)


def compose_body(lines: list[str]) -> str:
    return dp.REMIND_HEAD + " " + "\n".join(lines)


def _iso(dt: datetime) -> str:
    return dt.astimezone(dp._tz()).isoformat()


def _busy(busy) -> bool:
    if busy is None:
        return False
    try:
        return bool(busy())
    except Exception as e:  # noqa: BLE001
        log.warning("[remind] busy() raised, deferring: %r", e)
        return True


def process_reminders(*, wake=None, busy=None, in_quiet: bool = False, now: datetime | None = None,
                      path: str | None = None) -> dict:
    """一次调度。wake(body, meta)->WAKE_*(默认 = 放进 AI 待办表);busy()->bool(可选:嵌入方说 AI 正忙=顺延);
    in_quiet=顺延。meta = {keys, plan_ids, expire_at, now, path}。"""
    if wake is None:
        from . import inbox
        wake = inbox.wake_reminders
    out = {"logged": 0, "woke": 0, "deferred": 0, "expired": 0, "abandoned": 0,
           "void": 0, "released": 0, "errors": 0}
    now = dp._as_tz(now)
    ts = now.timestamp()
    conn = dp._connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            # ① 收口:过期没叫成 = expired;占位后一直没落终态又已过期 = abandoned
            cur = conn.execute(
                "UPDATE date_reminders SET woke_at=?, wake_result='expired'"
                " WHERE woke_at IS NULL AND wake_claimed_at IS NULL AND expire_at <= ?",
                (ts, _iso(now)))
            out["expired"] += cur.rowcount
            cur = conn.execute(
                "UPDATE date_reminders SET woke_at=?, wake_result='abandoned'"
                " WHERE woke_at IS NULL AND wake_claimed_at IS NOT NULL AND wake_claimed_at < ?",
                (ts, ts - CLAIM_STALE_S))
            out["abandoned"] += cur.rowcount
            # ② 按现状重算:进行中(sent/live)的约会 → 现行计划;对不上的未发行作废
            ids = [r[0] for r in conn.execute(
                "SELECT id FROM date_plans WHERE status IN ('sent','live')"
                " ORDER BY date, id")]
            cands: list[dict] = []
            for pid in ids:
                st = dp._load(conn, pid)
                plan = dp.reminder_plan(st, now)
                out["void"] += dp.void_stale_reminders(conn, pid, {r["key"] for r in plan}, ts)
                cands += [r for r in plan if r["fire_at"] <= now < r["expire_at"]]
            # 不再进行中的约会(取消/结束/删)剩下的未发行:全部作废
            q = "SELECT DISTINCT plan_id FROM date_reminders WHERE woke_at IS NULL AND wake_claimed_at IS NULL"
            for (pid,) in conn.execute(q).fetchall():
                if pid not in ids:
                    out["void"] += dp.void_stale_reminders(conn, pid, set(), ts)
            for c in cands:
                # 键又回到现行计划(如顺延 +X 再 −X):之前被作废的那行复活重排;其余已落行不动
                cur = conn.execute(
                    "INSERT INTO date_reminders (key, plan_id, kind, stop_id, basis,"
                    " fire_at, expire_at, line, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(key) DO UPDATE SET woke_at=NULL, wake_result=NULL,"
                    " wake_claimed_at=NULL, expire_at=excluded.expire_at, line=excluded.line"
                    " WHERE date_reminders.wake_result='void'",
                    (c["key"], c["plan_id"], c["kind"], c["stop_id"], c["basis"],
                     _iso(c["fire_at"]), _iso(c["expire_at"]), c["line"], ts))
                out["logged"] += cur.rowcount
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        if not cands:
            return out
        keys = [c["key"] for c in cands]
        rows = {r["key"]: dict(r) for r in conn.execute(
            f"SELECT * FROM date_reminders WHERE key IN ({','.join('?' * len(keys))})", keys)}
        pending = [c for c in cands
                   if rows.get(c["key"]) and rows[c["key"]]["woke_at"] is None
                   and rows[c["key"]]["wake_claimed_at"] is None]
        if not pending:
            return out
        if _busy(busy) or in_quiet:
            out["deferred"] += len(pending)
            return out
        # ③④ 占位 + 送达 + 落终态在同一个写事务里(默认送达 = 写进待办表,用的就是这条连接):
        # 中途出错或进程没了 = 整笔回滚,这几条仍是没占位的,下一分钟重来(不会落 abandoned/unknown 漏派)
        claim_ts = ts
        conn.execute("BEGIN IMMEDIATE")
        try:
            claimed = []
            for c in pending:
                cur = conn.execute(
                    "UPDATE date_reminders SET wake_claimed_at=?"
                    " WHERE key=? AND wake_claimed_at IS NULL AND woke_at IS NULL", (claim_ts, c["key"]))
                if cur.rowcount == 1:
                    claimed.append(c)
            if not claimed:
                conn.execute("COMMIT")
                return out
            claimed.sort(key=lambda c: (c["plan_id"], c["fire_at"], c["key"]))
            body = compose_body([c["line"] for c in claimed])
            meta = {"keys": [c["key"] for c in claimed], "plan_ids": sorted({c["plan_id"] for c in claimed}),
                    "parts": [{"key": c["key"], "plan_id": c["plan_id"], "line": c["line"],
                               "expire_at": c["expire_at"].timestamp()} for c in claimed],
                    "expire_at": max(c["expire_at"] for c in claimed).timestamp(), "now": now, "path": path,
                    "conn": conn}
            result = wake(body, meta)
            ks = [c["key"] for c in claimed]
            marks = ",".join("?" * len(ks))
            if result == WAKE_NOT_SENT:
                conn.execute(f"UPDATE date_reminders SET wake_claimed_at=NULL WHERE key IN ({marks})"
                             " AND wake_claimed_at=? AND woke_at IS NULL", (*ks, claim_ts))
                out["released"] += len(ks)
                log.warning("[remind] 提醒明确没送出去,释放占位,下一分钟重试")
            else:
                if result not in _WAKE_TERMINAL:
                    log.error("[remind] 送达返回了不认识的结果 %r,按说不清落终态", result)
                    result = WAKE_UNKNOWN
                conn.execute(f"UPDATE date_reminders SET woke_at=?, wake_result=? WHERE key IN ({marks})"
                             " AND woke_at IS NULL", (ts, result, *ks))
                out["woke"] += 1
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return out
    except Exception as e:  # noqa: BLE001
        out["errors"] += 1
        log.error("[remind] 调度异常(本分钟跳过): %r", e)
        return out
    finally:
        conn.close()


# ──  她按「请写」按钮的送达──────────────────────────────────────────────
# 候选 = date_asks 里 requested_at 已设、未完成(done_at NULL)、未占位未落终态的行;同一约会的多条
# 合成一轮(一次 wake 调用)。占位/四态/静音窗协议与 process_reminders 一致;expire 用 WRITE_REQUEST_EXPIRE_S
# (没有像提醒那样天然绑定的截止时刻,给够跨静音窗+一段忙的裕量)。
def process_write_requests(*, wake=None, busy=None, in_quiet: bool = False, now: datetime | None = None,
                           path: str | None = None) -> dict:
    """一次调度。wake(body, meta)->WAKE_*(默认 = 放进 AI 待办表);busy()->bool(可选,同上);in_quiet=顺延。
    同一分钟里排着的几盒合成一轮。meta = {ask_ids, plan_ids, round, now, path}。"""
    if wake is None:
        from . import inbox
        wake = inbox.wake_write_requests
    out = {"woke": 0, "deferred": 0, "expired": 0, "abandoned": 0, "released": 0, "errors": 0}
    now = dp._as_tz(now)
    ts = now.timestamp()
    conn = dp._connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            cur = conn.execute(
                "UPDATE date_asks SET request_woke_at=?, request_wake_result='expired'"
                " WHERE done_at IS NULL AND requested_at IS NOT NULL"
                " AND request_woke_at IS NULL AND request_claimed_at IS NULL"
                " AND ? - requested_at > ?", (ts, ts, dp.WRITE_REQUEST_EXPIRE_S))
            out["expired"] += cur.rowcount
            cur = conn.execute(
                "UPDATE date_asks SET request_woke_at=?, request_wake_result='abandoned'"
                " WHERE done_at IS NULL AND request_woke_at IS NULL AND request_claimed_at IS NOT NULL"
                " AND request_claimed_at < ?", (ts, ts - CLAIM_STALE_S))
            out["abandoned"] += cur.rowcount
            rows = [dict(r) for r in conn.execute(
                "SELECT a.id AS ask_id, a.plan_id, a.what, p.id AS p_id, p.title_en, p.title_zh, p.date,"
                " p.origin FROM date_asks a JOIN date_plans p ON p.id = a.plan_id"
                " WHERE a.done_at IS NULL AND a.requested_at IS NOT NULL"
                " AND a.request_woke_at IS NULL AND a.request_claimed_at IS NULL"
                " ORDER BY a.plan_id, a.what")]
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        if not rows:
            return out
        if _busy(busy) or in_quiet:
            out["deferred"] += len(rows)
            return out
        claim_ts = ts
        by_plan: dict[int, list] = {}
        for r in rows:
            by_plan.setdefault(r["plan_id"], []).append(r)
        # 整批占位 + 送达 + 落终态同一个写事务(占位与「还没写」复核也在里面);出错=整笔回滚,下一分钟重来
        conn.execute("BEGIN IMMEDIATE")
        try:
            groups = []
            for plan_id, items in by_plan.items():
                cand = [r["ask_id"] for r in items]
                cm = ",".join("?" * len(cand))
                conn.execute(f"UPDATE date_asks SET request_claimed_at=? WHERE id IN ({cm})"
                             " AND done_at IS NULL AND request_claimed_at IS NULL AND request_woke_at IS NULL",
                             (claim_ts, *cand))
                got = [dict(r) for r in conn.execute(
                    f"SELECT id, what FROM date_asks WHERE id IN ({cm}) AND request_claimed_at=?"
                    " AND done_at IS NULL AND request_woke_at IS NULL", (*cand, claim_ts))]
                if not got:
                    continue
                p = {"id": items[0]["p_id"], "title_en": items[0]["title_en"], "title_zh": items[0]["title_zh"],
                     "date": items[0]["date"], "origin": items[0]["origin"]}
                groups.append((p, got))
            if not groups:
                conn.execute("COMMIT")
                return out
            ids = [r["id"] for _, got in groups for r in got]
            marks = ",".join("?" * len(ids))
            body = "\n".join(dp.request_write_line(p, sorted((r["what"] for r in got), key=dp.ASK_KINDS.index))
                             for p, got in groups)
            meta = {"ask_ids": ids, "plan_ids": sorted(p["id"] for p, _ in groups), "round": claim_ts,
                    "now": now, "path": path, "conn": conn}
            result = wake(body, meta)
            if result == WAKE_NOT_SENT:
                conn.execute(f"UPDATE date_asks SET request_claimed_at=NULL WHERE id IN ({marks})"
                             " AND request_claimed_at=? AND request_woke_at IS NULL", (*ids, claim_ts))
                out["released"] += len(ids)
                log.warning("[remind] 请写明确没送出去,释放占位,下一分钟重试")
            else:
                if result not in _WAKE_TERMINAL:
                    log.error("[remind] 请写送达返回了不认识的结果 %r,按说不清落终态", result)
                    result = WAKE_UNKNOWN
                conn.execute(f"UPDATE date_asks SET request_woke_at=?, request_wake_result=? WHERE id IN ({marks})"
                             " AND request_woke_at IS NULL", (ts, result, *ids))
                out["woke"] += 1
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return out
    except Exception as e:  # noqa: BLE001
        out["errors"] += 1
        log.error("[remind] 请写调度异常(本分钟跳过): %r", e)
        return out
    finally:
        conn.close()
