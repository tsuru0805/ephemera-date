"""Her side writes: prep checklist ticks / check-in / keepsake-box actions / photos.

Boundaries:
1. Everything she can see or touch comes from plan.her_plan() (= the projection ``project()``); this module
   never SELECTs date_stops/date_legs directly. Draft / missing = 404, same as the read API.
2. Own tables use the date_her_ prefix, keyed by plan_id, no foreign keys into the engine tables.
3. Photo files and her captions are originals: stored under config.photo_dir() (EPHEMERA_DATA_DIR).
4. Check-in does not decide when "the note for this stop" appears (the engine does, by time / early open);
   this module only records that she checked in.

Mark keys — anything outside this whitelist is refused:
  prep:<item key>    prep checklist tick (can be undone). Sent / day-of only; after the date it is read-only
  checkin:<stop_id>  check-in (cannot be undone). Day-of only, once that stop's time has come
  nophoto:<stop_id>  "no photo for this stop". Day-of needs check-in first (same rule as photos); any time after
  sleeve:<stop_id>   opened this stop's sleeve on the keepsake route page   ┐
  lid                broke the seal / lifted the lid                        ├ after the date only
  card_torn          tore open the card envelope (needs a card)             │
  contract_fp        pressed a fingerprint on the contract (needs one)     ┘
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

from . import config
from . import plan as date_plan

log = logging.getLogger("ephemera_date.her")

CAPTION_MAX = 24            # 照片下面那一行小字(原型输入框 maxlength 24)
PHOTO_MAX_BYTES = 20 * 1024 * 1024
PHOTO_PLAN_MAX = 60         # 单盒照片上限(挂站 + 不挂站合计;场合"如60张")
_MAGIC = ((b"\xff\xd8\xff", "jpg", "image/jpeg"), (b"\x89PNG\r\n\x1a\n", "png", "image/png"))
# prep 的条目键由引擎给(p:<类别>:<文字> / t<路段号>),含中文;只拦控制字符与超长
_KEY_RE = re.compile(r"(prep:[^\x00-\x1f]{1,140}|checkin:\d+|nophoto:\d+|sleeve:\d+|lid|card_torn|contract_fp)")   # 一律 fullmatch


class _Already(Exception):
    """写锁里发现同一个 client_id 已经落过(并发重发):原样回执那一张。"""
    def __init__(self, row: dict):
        super().__init__("already")
        self.row = row


class HerError(Exception):
    def __init__(self, status: int, text: str):
        super().__init__(text)
        self.status = status
        self.text = text


# ── 库 ────────────────────────────────────────────────────────────────────────────
_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS date_her_marks (
         plan_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, at REAL NOT NULL,
         PRIMARY KEY (plan_id, key))""",
    # stop_id 可空=这张照片挂在整次约会上,不挂某一站(新库直接这样建)
    """CREATE TABLE IF NOT EXISTS date_her_photos (
         id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, stop_id INTEGER,
         file TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, caption TEXT,
         created_at REAL NOT NULL, deleted_at REAL, client_id TEXT)""",
)
# 老库补列(本模块随刀新建,先留补列口)+ 幂等唯一键:同一次「收好」重发=同一个 client_id,不存两张
_MIGRATE = (
    ("date_her_photos", "client_id", "TEXT"),
)
_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_date_her_photos_plan ON date_her_photos(plan_id, stop_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_date_her_photos_client ON date_her_photos(plan_id, client_id)"
    " WHERE client_id IS NOT NULL",
)
_ready: set[str] = set()


def _relax_photo_stop_not_null(conn: sqlite3.Connection) -> None:
    """老库 date_her_photos.stop_id 是 NOT NULL(建表时定的);放宽成可空,
    让「整次约会不挂站」的照片能落库。SQLite 不支持 ALTER COLUMN,按「建新表→搬数据→改名」重建,
    只在侦测到旧的 NOT NULL 约束时做一次(notnull 标志见 PRAGMA table_info 第 4 列)。
    整段在一个写事务里(SQLite 的 DDL 可回滚):中途断了=原表原样、下次重来;两个进程同时初始化,
    后拿到写锁的那个在事务里再判一次,看到已经可空就不动。"""
    def old_constraint() -> bool:
        cols = {r[1]: r for r in conn.execute("PRAGMA table_info(date_her_photos)")}
        return "stop_id" in cols and cols["stop_id"][3] != 0
    if not old_constraint():
        return                          # 没这张表(下面 _SCHEMA 会建)或已经可空:不用重建
    conn.execute("BEGIN IMMEDIATE")
    try:
        if old_constraint():
            _relax_rebuild(conn)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def _relax_rebuild(conn: sqlite3.Connection) -> None:
    conn.execute("DROP TABLE IF EXISTS date_her_photos__relax")   # 旧表还在=上次没做完的半成品,丢掉重搬
    conn.execute("""CREATE TABLE date_her_photos__relax (
         id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, stop_id INTEGER,
         file TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, caption TEXT,
         created_at REAL NOT NULL, deleted_at REAL, client_id TEXT)""")
    conn.execute("INSERT INTO date_her_photos__relax (id, plan_id, stop_id, file, mime, bytes, caption,"
                 " created_at, deleted_at, client_id)"
                 " SELECT id, plan_id, stop_id, file, mime, bytes, caption, created_at, deleted_at, client_id"
                 " FROM date_her_photos")
    conn.execute("DROP TABLE date_her_photos")
    conn.execute("ALTER TABLE date_her_photos__relax RENAME TO date_her_photos")


def _db_path() -> str:
    return config.db_path()     # 调用时取(测试钉 tmp)


def _connect(path: str | None = None) -> sqlite3.Connection:
    path = path or _db_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    conn = sqlite3.connect(path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    if path not in _ready:
        for sql in _SCHEMA:
            conn.execute(sql)
        for table, col, decl in _MIGRATE:
            if col not in {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        _relax_photo_stop_not_null(conn)    # 老库 stop_id 还是 NOT NULL:重建成可空(在补列之后、建索引之前)
        for sql in _INDEXES:
            conn.execute(sql)
        _ready.add(path)
    return conn


def photo_dir() -> Path:
    """照片落盘目录(调用时读 env;在数据目录下,与库同为运行时数据、不进 git)。"""
    return config.photo_dir()


def _now() -> datetime:
    return datetime.now(config.tz())


# ── 投影(唯一入口)────────────────────────────────────────────────────────────────
def _view(plan_id: int, now: datetime, path: str | None) -> dict:
    v = date_plan.her_plan(plan_id, now=now, path=path)
    if v is None:
        raise HerError(404, "not found")
    return v


def prep_key(item: dict) -> str:
    """准备清单条目的勾选键。引擎给了稳定键就用它;否则按(类别, 文字)取摘要——他改了条目文字,旧勾自然失效。"""
    if item.get("key"):
        return str(item["key"])
    h = hashlib.sha1(f"{item.get('section')}|{item.get('text')}".encode()).hexdigest()[:12]
    return f"{item.get('section')}:{h}"


def _stop(v: dict, stop_id: int) -> dict:
    for s in v["stops"]:
        if s["stop_id"] == stop_id:
            return s
    raise HerError(404, "没有这一站")


def _arrived(s: dict, now: datetime) -> bool:
    at = s.get("arrive_at")
    if isinstance(at, (int, float)):
        return now.timestamp() >= at
    return s.get("place") is not None   # 引擎还没给 arrive_at 时的保守替代:地点已公开才算到了


def _marks(conn: sqlite3.Connection, plan_id: int) -> dict:
    return {r["key"]: {"at": r["at"], "value": json.loads(r["value"]) if r["value"] else None}
            for r in conn.execute("SELECT key, value, at FROM date_her_marks WHERE plan_id=?", (plan_id,))}


def _photos(conn: sqlite3.Connection, plan_id: int, stops: set[int]) -> list[dict]:
    rows = conn.execute("SELECT id, stop_id, caption, created_at FROM date_her_photos"
                        " WHERE plan_id=? AND deleted_at IS NULL ORDER BY created_at, id", (plan_id,))
    # 他删掉的站上的照片不再出现(投影里没有这站了);stop_id=None(不挂站)永远带出
    return [dict(r) for r in rows if r["stop_id"] is None or r["stop_id"] in stops]


def state(plan_id: int, *, now: datetime | None = None, path: str | None = None) -> dict:
    now = now or _now()
    v = _view(plan_id, now, path)
    conn = _connect(path)
    try:
        marks = _marks(conn, plan_id)
        photos = _photos(conn, plan_id, {s["stop_id"] for s in v["stops"]})
    finally:
        conn.close()
    # 引擎改了清单后已不存在的条目,勾不再算数
    live_prep = {f"prep:{prep_key(it)}" for it in v["prep"]}
    marks = {k: m for k, m in marks.items() if not k.startswith("prep:") or k in live_prep}
    # now=服务端时钟(epoch 秒):页面按它判「到点」,不信手机自己的钟(手机钟偏了也不会把还没到的那格亮成 NOW)
    return {"marks": marks, "photos": photos, "now": now.timestamp()}


def _check_mark(v: dict, key: str, now: datetime, checked: bool = False) -> None:
    """checked=这一站已检过票(nophoto 当天要先检票,与照片同规)"""
    ph = v["status"]
    if key.startswith("prep:"):
        if ph not in ("sent", "live"):
            raise HerError(409, "准备清单已经收进纪念盒了")
        if key[5:] not in {prep_key(it) for it in v["prep"]}:
            raise HerError(404, "清单里没有这一条了")
        return
    if key.startswith("checkin:"):
        if ph != "live":
            raise HerError(409, "约会当天才能检票")
        s = _stop(v, int(key.split(":")[1]))
        if not _arrived(s, now):
            raise HerError(409, f"{s.get('time') or '到点'} 才能拆开这一格")
        return
    if key.startswith("nophoto:"):
        if ph not in ("live", "done"):
            raise HerError(409, "当天检过票才能放照片")
        _stop(v, int(key.split(":")[1]))
        if ph == "live" and not checked:
            raise HerError(409, "这一站检过票才能放照片")
        return
    if ph != "done":
        raise HerError(409, "收进纪念盒以后才能打开")
    if key.startswith("sleeve:"):
        _stop(v, int(key.split(":")[1]))
    elif key == "card_torn" and not v.get("card"):
        raise HerError(404, "这一盒没有小卡")
    elif key == "contract_fp" and not v.get("contract"):
        raise HerError(404, "这一盒没有契约书")


def set_mark(plan_id: int, key: str, on: bool = True, *, now: datetime | None = None,
             path: str | None = None) -> dict:
    if not isinstance(key, str) or not _KEY_RE.fullmatch(key):
        raise HerError(400, "bad key")
    now = now or _now()
    v = _view(plan_id, now, path)
    if not on and not key.startswith("prep:"):
        raise HerError(409, "这一步做了就不能撤回")
    conn = _connect(path)
    try:
        checked = False
        if key.startswith("nophoto:"):
            checked = conn.execute("SELECT 1 FROM date_her_marks WHERE plan_id=? AND key=?",
                                   (plan_id, "checkin:" + key.split(":")[1])).fetchone() is not None
        _check_mark(v, key, now, checked)
        if on:
            conn.execute("INSERT OR IGNORE INTO date_her_marks (plan_id, key, value, at) VALUES (?,?,?,?)",
                         (plan_id, key, None, now.timestamp()))
        else:
            conn.execute("DELETE FROM date_her_marks WHERE plan_id=? AND key=?", (plan_id, key))
    finally:
        conn.close()
    return state(plan_id, now=now, path=path)


def _sniff(data: bytes) -> tuple[str, str]:
    for magic, ext, mime in _MAGIC:
        if data.startswith(magic):
            return ext, mime
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in (b"avif", b"avis"):
            return "avif", "image/avif"
        if brand in (b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs", b"mif1", b"msf1"):
            return "heic", "image/heic"
    raise HerError(415, "只收照片(jpg / png / heic / avif)")


def add_photo(plan_id: int, stop_id: int | None, data: bytes, caption: str | None, *,
              client_id: str | None = None, replace: bool = False, replace_id: int | None = None,
              now: datetime | None = None, path: str | None = None) -> dict:
    """client_id=页面每次「收好」生成的一次性编号:超时重发同一张不会存两份(已存过就原样回执)。
    replace=True:同一个「槛位」(某一站,或不挂站的整次约会)原来的照片换成这张(旧的记删除,文件不动);
    「再点进去显示已放的那张、可以换一张」。
    stop_id=None=这张不挂某一站,挂在整次约会上(她可以传"不挂站"的照片,不再限一站一张);
    不挂站的照片不受检票门槛(没有具体的站可检票),仍只认 live/done 阶段。
    那一叠(不挂站)里换一张=replace_id 指名换哪张(一叠有很多张,不能整叠换掉);replace 只管某一站。"""
    now = now or _now()
    if stop_id is None and replace:
        raise HerError(400, "换那一叠里的哪一张要指名(replace_id)")
    if replace_id is not None and stop_id is not None:
        raise HerError(400, "replace_id 只用于那一叠(不挂站)的照片;换某一站的照片用 replace")
    v = _view(plan_id, now, path)
    if v["status"] not in ("live", "done"):
        raise HerError(409, "当天检过票才能放照片")
    if stop_id is not None:
        _stop(v, stop_id)
    if not data:
        raise HerError(400, "没有收到照片")
    if len(data) > PHOTO_MAX_BYTES:
        raise HerError(413, "照片太大了(最多 20MB)")
    ext, mime = _sniff(data)
    cap = (caption or "").strip() or None
    if cap is not None and len(cap) > CAPTION_MAX:
        raise HerError(400, f"小字最多 {CAPTION_MAX} 个字")
    cid = (client_id or "").strip()[:64] or None
    conn = _connect(path)
    try:
        if cid:
            r = conn.execute("SELECT id, stop_id, caption, created_at FROM date_her_photos WHERE plan_id=? AND client_id=?",
                             (plan_id, cid)).fetchone()
            if r:
                return dict(r)
        if stop_id is not None and v["status"] == "live" and not conn.execute(
                "SELECT 1 FROM date_her_marks WHERE plan_id=? AND key=?", (plan_id, f"checkin:{stop_id}")).fetchone():
            raise HerError(409, "这一站检过票才能放照片")
        d = photo_dir() / str(plan_id)
        d.mkdir(parents=True, exist_ok=True)
        name = f"{uuid.uuid4().hex}.{ext}"
        tmp, final = d / (name + ".part"), d / name
        try:
            tmp.write_bytes(data)
            os.replace(tmp, final)       # 写完整再改名,半截文件不会被读到
            # 插入 + 换掉旧的在同一个写事务里(两次「换一张」交错会把两张新照片都删掉)
            conn.execute("BEGIN IMMEDIATE")
            try:
                # 锁外查过一次重发;两次同号请求同时过了那一关,后到的在锁里再认一次,原样回执(否则指名换一张会误报 404)
                if cid:
                    r = conn.execute("SELECT id, stop_id, caption, created_at FROM date_her_photos WHERE plan_id=? AND client_id=?",
                                     (plan_id, cid)).fetchone()
                    if r:
                        raise _Already(dict(r))
                # 上限在写锁里数(锁外数,两张同时传会冲过 60);换一张=先扣掉要换下的那张
                if replace_id is not None:
                    gone = conn.execute("SELECT COUNT(*) FROM date_her_photos WHERE id=? AND plan_id=? AND stop_id IS NULL"
                                        " AND deleted_at IS NULL", (replace_id, plan_id)).fetchone()[0]
                    if not gone:
                        raise HerError(404, "要换的那张照片不在了(可能已经拿掉),刷新一下再换")
                elif replace:
                    gone = conn.execute("SELECT COUNT(*) FROM date_her_photos WHERE plan_id=? AND stop_id=?"
                                        " AND deleted_at IS NULL", (plan_id, stop_id)).fetchone()[0]
                else:
                    gone = 0
                cnt = conn.execute("SELECT COUNT(*) FROM date_her_photos WHERE plan_id=? AND deleted_at IS NULL",
                                   (plan_id,)).fetchone()[0]
                if cnt - gone >= PHOTO_PLAN_MAX:
                    raise HerError(413, f"这一盒最多放 {PHOTO_PLAN_MAX} 张照片")
                cur = conn.execute("INSERT INTO date_her_photos (plan_id, stop_id, file, mime, bytes, caption, created_at,"
                                   " client_id) VALUES (?,?,?,?,?,?,?,?)", (plan_id, stop_id, f"{plan_id}/{name}", mime,
                                                                            len(data), cap, now.timestamp(), cid))
                pid = cur.lastrowid
                if replace_id is not None:   # 那一叠里换指名的那一张(新的排到最后)
                    conn.execute("UPDATE date_her_photos SET deleted_at=? WHERE id=? AND plan_id=?",
                                 (now.timestamp(), replace_id, plan_id))
                elif replace:   # 换一张:这一站其余没删的记删除(投影/事件卡/计数都只认没删的);后来者赢
                    conn.execute("UPDATE date_her_photos SET deleted_at=? WHERE plan_id=? AND stop_id=? AND id<>?"
                                 " AND deleted_at IS NULL", (now.timestamp(), plan_id, stop_id, pid))
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        except _Already as a:
            for f in (tmp, final):      # 这一份是重发:文件不留
                f.unlink(missing_ok=True)
            return a.row
        except BaseException:
            for f in (tmp, final):      # 记录没落成就不留孤儿文件
                f.unlink(missing_ok=True)
            raise
        # 放了照片=这一站不再是「没放」(不挂站的照片没有这个标记)
        if stop_id is not None:
            conn.execute("DELETE FROM date_her_marks WHERE plan_id=? AND key=?", (plan_id, f"nophoto:{stop_id}"))
    finally:
        conn.close()
    return {"id": pid, "stop_id": stop_id, "caption": cap, "created_at": now.timestamp()}


def remove_photo(plan_id: int, photo_id: int, *, now: datetime | None = None, path: str | None = None) -> dict:
    """她从这一盒里拿掉一张照片(记删除,文件不动)。回她的状态(同 GET /her)。"""
    now = now or _now()
    v = _view(plan_id, now, path)
    if v["status"] not in ("live", "done"):
        raise HerError(409, "当天检过票才能动照片")
    conn = _connect(path)
    try:
        cur = conn.execute("UPDATE date_her_photos SET deleted_at=? WHERE id=? AND plan_id=? AND deleted_at IS NULL",
                           (now.timestamp(), photo_id, plan_id))
        if cur.rowcount != 1:
            raise HerError(404, "这张照片不在了(可能已经拿掉),刷新一下")
    finally:
        conn.close()
    return state(plan_id, now=now, path=path)


def set_caption(plan_id: int, photo_id: int, caption: str | None, *,
                now: datetime | None = None, path: str | None = None) -> dict:
    """只改照片底下那行小字(不换照片)。拒绝一律回原因。"""
    now = now or _now()
    v = _view(plan_id, now, path)
    if v["status"] not in ("live", "done"):
        raise HerError(409, "当天检过票才能改照片的小字")
    cap = (caption or "").strip() or None
    if cap is not None and len(cap) > CAPTION_MAX:
        raise HerError(400, f"小字最多 {CAPTION_MAX} 个字")
    conn = _connect(path)
    try:
        # 有效性与改动同一条语句判(查完到改之间被「换一张」删掉=不许假成功)
        cur = conn.execute("UPDATE date_her_photos SET caption=? WHERE id=? AND plan_id=? AND deleted_at IS NULL",
                           (cap, photo_id, plan_id))
        if cur.rowcount != 1:
            raise HerError(404, "这张照片不在了(可能已经换掉),刷新一下再改")
        r = conn.execute("SELECT id, stop_id, created_at FROM date_her_photos WHERE id=?", (photo_id,)).fetchone()
    finally:
        conn.close()
    return {"id": r["id"], "stop_id": r["stop_id"], "caption": cap, "created_at": r["created_at"]}


def photo_file(plan_id: int, photo_id: int, *, now: datetime | None = None,
               path: str | None = None) -> tuple[Path, str]:
    now = now or _now()
    v = _view(plan_id, now, path)
    conn = _connect(path)
    try:
        r = conn.execute("SELECT stop_id, file, mime FROM date_her_photos WHERE id=? AND plan_id=?"
                         " AND deleted_at IS NULL", (photo_id, plan_id)).fetchone()
    finally:
        conn.close()
    if r is None or (r["stop_id"] is not None and r["stop_id"] not in {s["stop_id"] for s in v["stops"]}):
        raise HerError(404, "not found")
    f = (photo_dir() / r["file"]).resolve()
    if not str(f).startswith(str(photo_dir().resolve()) + os.sep) or not f.is_file():
        raise HerError(404, "not found")
    return f, r["mime"]
