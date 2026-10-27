"""The single scheduler: reminders, "please write" requests, event and to-do webhooks, generated art,
after-date memory (event cards + JSON export, memory.py), dropping place coordinates whose terms-limited
cache period ran out (plan.purge_place_coords), and taking back coordinates kept under the "user" store
policy once it is switched to "terms" (plan.enforce_store_policy).

Runs only inside ``ephemera-date serve``. ``ephemera-date stdio`` never starts it (it only reads and writes the
database), so a laptop MCP client and a server can share one data directory without double delivery.

- One owner at a time: a lease row in the database (``ephemera_meta``), renewed by its own heartbeat
  (independent of how long a round takes). A second serve process on the same data directory waits until
  the first stops renewing it; a process that fails to renew stops dispatching at once (every job checks
  ``still_owner`` between deliveries).
- Outside calls have timeouts (webhooks, Web Push, the art generator); generated art runs as its own task,
  so a hung generator never holds up reminders.
- Every job claims its rows atomically before delivering (see remind.py / inbox.py / outlet.py), so even an
  overlapping lease could not deliver twice.
- After a restart everything not yet delivered is still in the database and goes out on the next tick.
- ``kick()`` asks for an immediate tick (a tool just wrote an envelope / telegram). It is thread-safe and
  needs no event loop in the calling thread: tool calls run in worker threads.
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import threading
import time
import uuid

from . import inbox, memory, outlet, remind
from . import plan as dp

log = logging.getLogger("ephemera_date.scheduler")

LEASE_S = 90.0
HEARTBEAT_S = 20.0
LEASE_KEY = "scheduler_lease"

_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_wake: asyncio.Event | None = None


def owner_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


def acquire_lease(owner: str, now: float | None = None, *, path: str | None = None, ttl: float = LEASE_S) -> bool:
    """Take or renew the lease. True = this process may run the jobs now."""
    now = time.time() if now is None else now
    conn = inbox.connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            val, at = inbox.meta_get(conn, LEASE_KEY)
            mine = val is not None and val.split("@", 1)[0] == owner
            free = val is None or at is None or (now - at) > ttl
            if mine or free:
                inbox.meta_set(conn, LEASE_KEY, f"{owner}@{now}", now)
                conn.execute("COMMIT")
                return True
            conn.execute("COMMIT")
            return False
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def release_lease(owner: str, *, path: str | None = None) -> None:
    conn = inbox.connect(path)
    try:
        conn.execute("DELETE FROM ephemera_meta WHERE key=? AND value LIKE ?", (LEASE_KEY, owner + "@%"))
    finally:
        conn.close()


def tick(now=None, *, path: str | None = None, still_owner=None) -> dict:
    """One round of every job (synchronous; the loop runs it in a worker thread).
    still_owner() False = stop at the next delivery boundary (the lease was lost)."""
    out = {}
    for name, fn in (("reminders", lambda: remind.process_reminders(now=now, path=path)),
                     ("write_requests", lambda: remind.process_write_requests(now=now, path=path)),
                     ("events", lambda: outlet.sweep(now=now, path=path, still_owner=still_owner)),
                     ("ai_webhook", lambda: inbox.push_pending(now=now, path=path, still_owner=still_owner)),
                     ("memory", lambda: memory.run_once(now=now, path=path, still_owner=still_owner)),
                     ("place_policy", lambda: dp.enforce_store_policy(now=now, path=path)),
                     ("place_coords", lambda: dp.purge_place_coords(now=now, path=path))):
        if still_owner is not None and not still_owner():
            out["stopped"] = "lease lost"
            break
        try:
            out[name] = fn()
        except Exception as e:  # noqa: BLE001 — one job failing must not stop the others
            log.warning("[scheduler] %s failed: %r", name, e)
            out[name] = {"error": repr(e)}
    return out


def kick() -> None:
    """Run the next tick now (no-op when this process has no scheduler; the owner's tick picks it up)."""
    with _lock:
        loop, ev = _loop, _wake
    if loop is None or ev is None:
        return
    try:
        loop.call_soon_threadsafe(ev.set)
    except RuntimeError:            # loop already closed
        pass


async def run(stop: asyncio.Event | None = None, *, path: str | None = None, tick_s: float | None = None,
              heartbeat_s: float = HEARTBEAT_S, lease_s: float = LEASE_S) -> None:
    """The serve loop. Returns when ``stop`` is set."""
    global _loop, _wake
    from . import art
    from . import config
    owner = owner_id()
    tick_s = config.scheduler_tick_s() if tick_s is None else tick_s
    with _lock:
        _loop, _wake = asyncio.get_running_loop(), asyncio.Event()
    stop = stop or asyncio.Event()
    owned = threading.Event()                      # set while our lease is current
    tasks: dict = {"art": None}

    async def heartbeat():
        while not stop.is_set():
            try:
                ok = await asyncio.to_thread(acquire_lease, owner, path=path, ttl=lease_s)
            except Exception as e:  # noqa: BLE001 — cannot renew = not the owner any more
                log.warning("[scheduler] lease renew failed: %r", e)
                ok = False
            if ok:
                if not owned.is_set():
                    owned.set()
                    _wake.set()                    # just became owner: run a round now
            elif owned.is_set():
                owned.clear()
                log.warning("[scheduler] lease lost: stop dispatching")
                if tasks["art"] is not None and not tasks["art"].done():
                    tasks["art"].cancel()              # a drawing in flight is abandoned too
            try:
                await asyncio.wait_for(stop.wait(), timeout=heartbeat_s)
            except asyncio.TimeoutError:
                pass

    hb = asyncio.create_task(heartbeat())
    try:
        while not stop.is_set():
            _wake.clear()                       # before the tick: a kick during the tick runs another one
            if owned.is_set():
                try:
                    await asyncio.to_thread(tick, path=path, still_owner=owned.is_set)
                except Exception as e:  # noqa: BLE001
                    log.warning("[scheduler] tick failed: %r", e)
                if dp.art_enabled() and (tasks["art"] is None or tasks["art"].done()) and owned.is_set():
                    tasks["art"] = asyncio.create_task(_art_once(art, path, owned.is_set, owner, lease_s))
            waiter = asyncio.ensure_future(_wake.wait())
            stopper = asyncio.ensure_future(stop.wait())
            try:
                await asyncio.wait({waiter, stopper}, timeout=tick_s, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for t in (waiter, stopper):
                    t.cancel()
    finally:
        stop.set()
        hb.cancel()
        for t in (hb, tasks["art"]):
            if t is not None:
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        with _lock:
            _loop, _wake = None, None
        try:
            await asyncio.to_thread(release_lease, owner, path=path)
        except Exception:  # noqa: BLE001
            pass


async def _art_once(art, path, still_owner, owner, lease_s) -> None:
    try:
        await art.run_once(path=path, still_owner=still_owner, owner=owner, lease_s=lease_s)
    except Exception as e:  # noqa: BLE001
        log.warning("[scheduler] art failed: %r", e)
