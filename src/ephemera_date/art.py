"""Optional per-stop generated art (the default is the fixed art rotation, plan.fixed_art).

Only active when an ArtGenerator adapter is configured (EPHEMERA_ART_GENERATOR, see ports.py); nothing paid
is built in. The generator gets a short English subject (kind scene + place name + the AI's art_hint +
time of day) and returns two transparent single-colour PNG masks (line art "ink", inverted "inv") that the
page tints by theme. She only receives them once the stop's place is revealed (plan.project art_url).

- Queue: plan._art_hook (inside each write transaction; queue only, no network).
- Draw: run_once, called by the scheduler (serve process only): a job waits ART_DEBOUNCE_S after its last
  change, at most EPHEMERA_ART_DAILY_MAX starts per day (retries count), two attempts, then failed (the page
  keeps the fixed art).
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime

from . import config, ports
from . import plan as dp

log = logging.getLogger("ephemera_date.art")

RUNNING_STALE_S = 900.0
MAX_ATTEMPTS = 2

# kind → the scene in the picture (English, for the generator). Only "what to draw"; style is the generator's.
SCENE = {"train": "a train station entrance", "dinner": "a small restaurant", "cinema": "a cinema entrance",
         "walk": "a quiet street for a walk", "cafe": "a small cafe", "viewpoint": "an observation deck view",
         "shopping": "a little shop front", "shrine": "a small shrine gate",
         "sweets": "a little pastry shop", "bar": "a quiet bar counter",
         "live": "a small live stage", "museum": "a quiet museum gallery",
         "aquarium": "an aquarium tunnel with fish", "amusement": "a ferris wheel at an amusement park",
         "play": "a retro game arcade", "park": "a park path with trees",
         "onsen": "a hot spring bath with steam", "stay": "a quiet room by the window",
         "moment": "a small thing we did that day"}
SUBJECT_TEMPLATE = "{scene}: {place}. {hint}"
DAYPART = {"day": "daytime, clear sky.", "dusk": "at dusk.", "night": "at night."}


def build_subject(kind: str, place: str, hint: str | None, time_hm: str | None = None) -> str:
    h = (hint.strip().rstrip("。.") + ".") if hint else ""
    out = SUBJECT_TEMPLATE.format(scene=SCENE.get(kind, "a place"), place=place, hint=h).strip()
    part = dp.art_daypart(time_hm)
    return f"{out} {DAYPART[part]}" if part else out


def _void_dead(conn, now: datetime) -> None:
    """Queued rows that will never be drawn (date over / cancelled / expired draft) → failed.
    Rows queued at or after a date was closed (her backfill / her edits) are kept."""
    for (sid, pid, req) in conn.execute(
            "SELECT stop_id, plan_id, requested_at FROM date_art WHERE status='pending'").fetchall():
        st = dp._load(conn, pid)
        ph = dp.phase(st["plan"], now) if st is not None else None
        if ph == "done" and req is not None and req >= (st["plan"].get("closed_at") or float("inf")):
            continue
        if st is None or ph in ("done", "cancelled", "draft_expired"):
            conn.execute("UPDATE date_art SET status='failed', error='约会已结束或取消' WHERE stop_id=? AND status='pending'",
                         (sid,))


def _claim(now: datetime, path: str | None) -> dict | None:
    ts = now.timestamp()
    with dp._tx(path) as conn:
        conn.execute("UPDATE date_art SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END"
                     " WHERE status='running' AND started_at < ?", (MAX_ATTEMPTS, ts - RUNNING_STALE_S))
        _void_dead(conn, now)
        day = now.date().isoformat()
        r = conn.execute("SELECT count FROM date_route_usage WHERE day=? AND kind='art'", (day,)).fetchone()
        if (r[0] if r else 0) >= config.art_daily_max():
            return None
        for row in conn.execute("SELECT * FROM date_art WHERE status='pending' AND requested_at <= ?"
                                " ORDER BY requested_at", (ts - dp.ART_DEBOUNCE_S,)).fetchall():
            row = dict(row)
            st = dp._load(conn, row["plan_id"])
            s = next((x for x in (st or {}).get("stops", []) if x["id"] == row["stop_id"]), None)
            if s is None or dp.art_sig(s) != row["sig"]:
                continue
            cur = conn.execute("UPDATE date_art SET status='running', started_at=?, attempts=attempts+1"
                               " WHERE stop_id=? AND sig=? AND status='pending'", (ts, row["stop_id"], row["sig"]))
            if cur.rowcount == 1:
                conn.execute("INSERT INTO date_route_usage (day, kind, count) VALUES (?, 'art', 1)"
                             " ON CONFLICT(day, kind) DO UPDATE SET count=count+1", (day,))
                return {**row, "kind": dp.stop_kind(s), "title": s["title"], "art_hint": s.get("art_hint"),
                        "time": s.get("time"), "attempts": row["attempts"] + 1}
    return None


def _sweep_files(path: str | None) -> None:
    """Files that no longer belong to any row (stop deleted / redrawn) are removed."""
    d = dp.art_dir()
    if not os.path.isdir(d):
        return
    conn = dp._connect(path)
    try:
        keep = {f"{sid}_{sig}" for sid, sig in conn.execute("SELECT stop_id, sig FROM date_art")}
    finally:
        conn.close()
    for f in os.listdir(d):
        if "_".join(f.split("_")[:2]) not in keep:
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass


def _lease_is(conn, owner: str | None, lease_s: float) -> bool:
    """Inside the caller's write transaction: is the scheduler lease still ``owner``'s and current?
    owner None = not run by a scheduler (direct call): nothing to check."""
    if owner is None:
        return True
    from . import scheduler
    r = conn.execute("SELECT value, updated_at FROM ephemera_meta WHERE key=?", (scheduler.LEASE_KEY,)).fetchone()
    return (r is not None and str(r[0]).split("@", 1)[0] == owner and r[1] is not None
            and time.time() - r[1] <= lease_s)


def _remove(*files: str) -> None:
    for f in files:
        try:
            os.remove(f)
        except OSError:
            pass


def _commit_drawing(sid: int, sig: str, ink: bytes, inv: bytes, path: str | None, owner: str | None,
                    lease_s: float, backend: str) -> str:
    """Files + state in one step, guarded by the lease: write both images as temp files, then in ONE
    BEGIN IMMEDIATE transaction check the lease is still ``owner``'s (acquire_lease needs the same write lock,
    so nobody can take it between the check and the commit) → rename to the real names, mark done, COMMIT;
    otherwise delete the temp files, ROLLBACK, "lease_lost". Returns done / superseded / lease_lost."""
    base = os.path.join(dp.art_dir(), f"{sid}_{sig}")
    tmp = {v: f"{base}_{v}.png.{os.getpid()}.tmp" for v in ("ink", "inv")}
    for v, data in (("ink", ink), ("inv", inv)):
        with open(tmp[v], "wb") as f:
            f.write(data)
    conn = dp._connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            if not _lease_is(conn, owner, lease_s):
                conn.execute("ROLLBACK")
                _remove(*tmp.values())
                return "lease_lost"
            mine = conn.execute("SELECT 1 FROM date_art WHERE stop_id=? AND sig=? AND status='running'",
                                (sid, sig)).fetchone() is not None
            if not mine:
                conn.execute("ROLLBACK")
                _remove(*tmp.values())
                return "superseded"
            for v in ("ink", "inv"):
                os.replace(tmp[v], f"{base}_{v}.png")
            conn.execute("UPDATE date_art SET status='done', finished_at=?, mask_file=?, backend=?, error=NULL"
                         " WHERE stop_id=? AND sig=? AND status='running'", (time.time(), f"{sid}_{sig}", backend, sid, sig))
            conn.execute("COMMIT")
            return "done"
        except BaseException:
            conn.execute("ROLLBACK")
            _remove(*tmp.values(), f"{base}_ink.png", f"{base}_inv.png")
            raise
    finally:
        conn.close()


def _commit_failure(sid: int, sig: str, path: str | None, owner: str | None, lease_s: float, **cols) -> bool:
    """Record a failed attempt — only while still the lease owner (same transaction as the check)."""
    sets = ", ".join(f"{k}=?" for k in cols)
    with dp._tx(path) as conn:
        if not _lease_is(conn, owner, lease_s):
            return False
        conn.execute(f"UPDATE date_art SET {sets} WHERE stop_id=? AND sig=? AND status='running'",
                     (*cols.values(), sid, sig))
        return True


async def run_once(now: datetime | None = None, *, path: str | None = None, generator=None,
                   still_owner=None, owner: str | None = None, lease_s: float | None = None) -> dict | None:
    """Draw one queued stop (nothing to draw / not configured / daily cap → None).
    owner = the scheduler's lease owner id: the result is committed only if that lease is still current
    (checked inside the commit transaction, see _commit_drawing); otherwise it is discarded and the next owner
    redraws. still_owner() is only an early exit before the commit."""
    import asyncio
    from . import scheduler
    lease_s = scheduler.LEASE_S if lease_s is None else lease_s
    gen = generator or ports.get("art")
    if gen is None:
        return None
    now = dp._as_tz(now)
    await asyncio.to_thread(_sweep_files, path)
    job = await asyncio.to_thread(_claim, now, path)
    if job is None:
        return None
    sid, sig = job["stop_id"], job["sig"]
    os.makedirs(dp.art_dir(), exist_ok=True)
    try:
        try:
            ink, inv = await asyncio.wait_for(gen.generate({
                "stop_id": sid, "kind": job["kind"], "title": job["title"], "art_hint": job.get("art_hint"),
                "time": job.get("time"),
                "subject": build_subject(job["kind"], job["title"], job.get("art_hint"), job.get("time"))}),
                timeout=config.art_timeout_s())
        except asyncio.TimeoutError:
            raise TimeoutError(f"generator took longer than {config.art_timeout_s():g}s") from None
        if not (isinstance(ink, bytes) and isinstance(inv, bytes) and ink and inv):
            raise ValueError("generator returned no image")
        if still_owner is not None and not still_owner():
            return {"stop_id": sid, "status": "lease_lost"}   # stale 'running' row is reclaimed by the next owner
        status = await asyncio.to_thread(_commit_drawing, sid, sig, ink, inv, path, owner, lease_s,
                                         type(gen).__name__)
        return {"stop_id": sid, "status": status}
    except Exception as e:  # noqa: BLE001 — a failed drawing never affects the date
        status = "failed" if job["attempts"] >= MAX_ATTEMPTS else "pending"
        log.warning("[art] stop %s not drawn (%s, attempt %d): %r", sid, status, job["attempts"], e)
        if not await asyncio.to_thread(_commit_failure, sid, sig, path, owner, lease_s, status=status,
                                       finished_at=time.time(), backend=type(gen).__name__, error=str(e)[:200]):
            return {"stop_id": sid, "status": "lease_lost"}
        return {"stop_id": sid, "status": status, "error": str(e)}
