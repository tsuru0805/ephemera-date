"""Date engine: data model, phases, reveal rules and the her-side projection, leg timing, edits.

One SQLite database (config.db_path(), WAL). Each write is one BEGIN IMMEDIATE transaction: the whole edit
succeeds or nothing is written. Before and after every edit the reveal records are settled; after a date is
sent, any edit to something she can see writes an automatic telegram in the same transaction.

Single functions own each rule: time conversion (timeline / leg_times / reveal_time), phase, check (what is
missing and what is wrong, same function for "send" and for the progress list), and the her-side projection
``project`` (her read API, the AI's "what she can see", events and the map all go through it).

Read-is-not-read-only: her GET endpoints settle reveals (write date_reveals) and sync sent↔live status.
That is by design ("settle before projecting"), not a bug.

Reminders: reminder_plan computes the full reminder plan from the current date; every write voids
reminders that no longer match (_reminders_hook). Delivery to the AI lives in remind.py / inbox.py.

All clock times are HH:MM in the configured time zone (config.tz()); absolute moments are computed, never stored.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import secrets
import sqlite3
import unicodedata
from collections import Counter
from contextlib import contextmanager
from datetime import date, datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

from typing import Any

from . import config, ports
from . import kinds as date_kinds

log = logging.getLogger("ephemera_date.plan")

HIM = "him"          # origin / added_by / letter author: written by the AI side
HER = "her"          # written by her


def _tz() -> ZoneInfo:
    return config.tz()

# ── 枚举与上限────────────────────────────────────────────
STATUSES = ("draft", "sent", "live", "done", "cancelled")
COLORS = {"blush": "浅粉", "rose": "粉", "cream": "奶白", "sky": "蓝", "berry": "深玫红"}
# 站的种类:唯一一份数据在 date_kinds(19 个大类 + 细类;此前 8 类=)
KINDS = date_kinds.KINDS
MOMENT = date_kinds.MOMENT
LEG_MODES = {"walk": "步行", "train": "电车", "subway": "地铁", "bus": "公交",
             "taxi": "出租车", "other": "其他方式"}
LEG_SOURCES = ("manual", "checked")
PREP_SECTIONS = {"book": "提前准备", "wear": "穿什么", "bring": "带什么", "weather": "天气"}
EVENT_KINDS = ("envelope", "telegram_manual", "telegram_auto", "cancel", "close",
               "her_backfill", "her_edit", "her_wrote", "her_request_write", "late_written")
# late_written=结束后他补写了她在等的那一样(要告诉她:进她的事件列表、推送)
# 她自己的动作(补记/编辑/先写/ 请写按钮):只给他看(约会账、详情),不进她的事件列表、不推送、不算未读
HER_EVENT_KINDS = ("her_backfill", "her_edit", "her_wrote", "her_request_write")
# 她拆开信封(her_open)即算读过的事件:寄出时落的那一条「你收到一封信」(寄出只落这一条;电报、取消、结束不算)
OPENED_BY_ENVELOPE = ("envelope",)
_HER_KINDS_SQL = "(" + ", ".join(f"'{k}'" for k in HER_EVENT_KINDS) + ")"   # 常量拼进 SQL(非外部输入)

MAX_ACTIVE = 3
MAX_STOPS = 6
MAX_TRANSFERS = 4            # 换乘 4 次 = steps 最多 5 步
MAX_SHIFT_MIN = 240
LIMITS = {                    # 字数上限
    "title_en_line": 24, "title_zh": 20, "title": 30, "address": 80, "clue": 40, "note": 120,
    "how_to_get": 80, "summary": 60, "ticket_note": 40, "contract_item": 80,
    "card": 200, "quote": 80, "next": 120, "prep_text": 30, "prep_detail": 40,
    # ↓ 暂定的三个数
    "telegram": 120, "cancel_reason": 200, "prep_items": 30,
    "art_hint": 40,               # 每站现画:画面描述
    "skip_reason": 60,            # 跳过一站的原因
    # (候她过目):迟到的请柬同小卡 200;她每站的一句话同「到站给她的话」120
    "invite": 200, "her_line": 120,
    # (字数上限 2000):她的信 / 他的回信各自上限 2000 字
    "letter": 2000, "reply": 2000,
}
MAX_CONTRACT = 5
MAX_WALK_POINTS = 200

# 事件里给她看的固定文字(定稿)
TXT_ENVELOPE = "你收到一封信"
TXT_CLOSE = "收进纪念盒了"
TXT_DERIVED_HIDDEN = "有一段路要提前准备车票"


class DateError(Exception):
    """写操作被拒:items = [{"code","text"}],整笔回滚。text 不带「没改成：」前缀(渲染时加)。"""

    def __init__(self, items: list[dict]):
        super().__init__("; ".join(i["text"] for i in items))
        self.items = items


def _err(code: str, text: str) -> DateError:
    return DateError([{"code": code, "text": text}])


# ── 表定义(建表与列补齐的唯一来源)────────────────────────────────────────────────
# 每表:列 (name, 建表声明, 补列声明|None)。补列声明=老库缺这列时 ALTER ADD 用的(不能带 PK/UNIQUE,
# NOT NULL 须带默认值);None=主键等建表即有、不可补的列。
_TABLES: dict[str, dict] = {
    "date_plans": {
        "cols": [
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT", None),
            ("paper_no", "TEXT", "TEXT"),
            ("title_en", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            # 中文名。两格都可选、至少一个;主副名唯一函数 display_name
            ("title_zh", "TEXT NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"),
            ("date", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("color", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT 'rose'"),
            ("status", "TEXT NOT NULL DEFAULT 'draft'", "TEXT NOT NULL DEFAULT 'draft'"),
            ("next_note", "TEXT", "TEXT"),
            ("contract_json", "TEXT", "TEXT"),
            ("card_text", "TEXT", "TEXT"),
            ("quote", "TEXT", "TEXT"),
            ("cancel_reason", "TEXT", "TEXT"),
            ("version", "INTEGER NOT NULL DEFAULT 1", "INTEGER NOT NULL DEFAULT 1"),
            ("created_at", "REAL", "REAL"),
            ("updated_at", "REAL", "REAL"),
            ("sent_at", "REAL", "REAL"),
            ("closed_at", "REAL", "REAL"),
            ("cancelled_at", "REAL", "REAL"),
            # 他上次成功写入时她留的话已到第几条(date_notes.id);约会账「你上次动笔之后」按 id 判,
            # 与写事务同锁定序(按时间戳判在并发交错下会把新话当旧话,1021 复现)
            ("notes_upto", "INTEGER", "INTEGER"),
            # 补记过往约会:him=他写的 / her=她补记的。只给引擎与他看,她的读口不出(她要「不加标记」)
            ("origin", "TEXT NOT NULL DEFAULT 'him'", "TEXT NOT NULL DEFAULT 'him'"),
            ("invite_text", "TEXT", "TEXT"),        # 迟到的请柬正文(只用于 origin=her)
            ("written_by_her", "TEXT", "TEXT"),     # 她自己先写了的那几样(JSON:invite/contract/card),他的详情标出处用
            ("her_seen_upto", "INTEGER", "INTEGER"),  # 他 date_view 打开过这次约会时 her_* 事件已到第几条(约会账只提新的)
            ("client_id", "TEXT", "TEXT"),          # 她补记的去重编号(同一次「存好」重发=同一个,不建两盒)
            # 他写约会时自己选藏不藏行程(默认 0=藏,逐站到点揭晓,行为不变)。
            # 寄出之后不许再改(只在 draft/draft_expired 可写,见 _op_set_basic)
            ("open_itinerary", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"),
            # 她在页面按「拆开」的时刻(POST /her/open 记下,只记第一次)。不藏行程从这一刻起才全开
            ("her_opened_at", "REAL", "REAL"),
        ],
        "extra": [],
    },
    "date_stops": {
        "cols": [
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("ord", "INTEGER", "INTEGER"),
            ("kind", "TEXT", "TEXT"),
            ("time", "TEXT", "TEXT"),
            ("stay_until", "TEXT", "TEXT"),
            ("title", "TEXT", "TEXT"),
            ("address", "TEXT", "TEXT"),
            ("lat", "REAL", "REAL"),
            ("lng", "REAL", "REAL"),
            ("reveal_at", "TEXT", "TEXT"),
            ("clue", "TEXT", "TEXT"),
            ("note", "TEXT", "TEXT"),
            ("how_to_get", "TEXT", "TEXT"),
            ("art_hint", "TEXT", "TEXT"),          # 这一站小画的画面描述(他可选写; 每站现画)
            # 一站也可以是一件事、没有固定地点——不填地址坐标、不进地图、不算路段
            ("no_place", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"),
            #  细类:该大类细类表里的一项,或自定义文字(≤12 字、单行,原样存);一件事不分细类
            ("subtype", "TEXT", "TEXT"),
            #  变成「一件事」之前的种类/细类(同一笔写入里按内存新状态记;恢复地点时取回并清空。只管逻辑,不靠事件)
            ("kind_before_moment", "TEXT", "TEXT"),
            ("subtype_before_moment", "TEXT", "TEXT"),
            ("walk_path_json", "TEXT", "TEXT"),
            ("opened_early_at", "REAL", "REAL"),
            # him=他写的 / her=她补的(她补记的约会里的站、她结束后补的站)。她的读口不出
            ("added_by", "TEXT NOT NULL DEFAULT 'him'", "TEXT NOT NULL DEFAULT 'him'"),
            ("her_line", "TEXT", "TEXT"),           # 她给这一站写的一句话(每站一条,可改)
            ("edited_by_her_at", "REAL", "REAL"),   # 她改过这一站的时间/地点(改前改后在 date_events her_edit)
            # 地点从哪家地点服务选来(google/amap/osm;手写=空)+ 该家的地点 ID(条款允许长期存时才有)。
            # 坐标能不能长期存在站上由存储规则定(EPHEMERA_PLACES_STORE_POLICY,见「地点条款存储」)
            ("place_source", "TEXT", "TEXT"),
            ("place_ref", "TEXT", "TEXT"),
            # 寄出后他可以跳过任何一站(date_live skip,原因必写);跳过的站留在记录里,
            # 不参与时间先后、路段起止、提醒,后面的站可以往前挪;unskip 撤回
            ("skipped_at", "REAL", "REAL"),
            ("skip_reason", "TEXT", "TEXT"),
            ("deleted_at", "REAL", "REAL"),
            ("created_at", "REAL", "REAL"),
            ("updated_at", "REAL", "REAL"),
        ],
        # (id, plan_id) 唯一 → 路段可用复合外键保证起止站属于同一约会
        "extra": ["UNIQUE (id, plan_id)"],
    },
    "date_legs": {
        "cols": [
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("from_stop_id", "INTEGER", None),
            ("to_stop_id", "INTEGER NOT NULL", None),
            ("stale", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"),
            ("mode", "TEXT", "TEXT"),
            ("depart_time", "TEXT", "TEXT"),
            ("arrive_time", "TEXT", "TEXT"),
            ("minutes", "INTEGER", "INTEGER"),
            ("summary", "TEXT", "TEXT"),
            ("steps_json", "TEXT", "TEXT"),
            ("fare", "INTEGER", "INTEGER"),
            ("needs_ticket", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"),
            ("ticket_note", "TEXT", "TEXT"),
            ("source", "TEXT NOT NULL DEFAULT 'manual'", "TEXT NOT NULL DEFAULT 'manual'"),
            ("official_url", "TEXT", "TEXT"),
            ("deleted_at", "REAL", "REAL"),
            ("created_at", "REAL", "REAL"),
            ("updated_at", "REAL", "REAL"),
        ],
        "extra": [
            "FOREIGN KEY (from_stop_id, plan_id) REFERENCES date_stops(id, plan_id)",
            "FOREIGN KEY (to_stop_id, plan_id) REFERENCES date_stops(id, plan_id)",
        ],
    },
    "date_prep": {
        "cols": [
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("section", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT 'bring'"),
            ("text", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("detail", "TEXT", "TEXT"),
            ("ord", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "extra": [],
    },
    "date_reveals": {
        "cols": [
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("stop_id", "INTEGER", None),               # 空 = 约会级(field_group=all)
            ("field_group", "TEXT NOT NULL", None),     # place / note / all
            ("revealed_at", "REAL", "REAL"),
        ],
        "extra": [],
    },
    "date_events": {
        "cols": [
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("kind", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT 'telegram_auto'"),
            ("text", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("ref_stop_id", "INTEGER", "INTEGER"),
            ("ref_snapshot", "TEXT", "TEXT"),
            ("push_state", "TEXT NOT NULL DEFAULT 'pending'", "TEXT NOT NULL DEFAULT 'pending'"),
            ("read_at", "REAL", "REAL"),
            ("created_at", "REAL", "REAL"),
            ("detail_json", "TEXT", "TEXT"),        # her_* 事件:改了哪一站哪一项、改前改后
        ],
        "extra": [],
    },
    # 工具写操作的请求编号(request_id 幂等)。与约会改动**同一笔事务**落行,
    # 同号再来=返回「已经做过了」不重做;同号不同参数=拒。只记成功(失败本就没写任何东西,重试无害)
    "date_tool_requests": {
        "cols": [
            ("tool", "TEXT NOT NULL", None),
            ("request_id", "TEXT NOT NULL", None),
            ("args_hash", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("plan_id", "INTEGER", "INTEGER"),
            ("created_at", "REAL", "REAL"),
        ],
        "extra": ["PRIMARY KEY (tool, request_id)"],
    },
    # date_route 查询次数账(只因他调用才发生;kind=walk/transit)
    "date_route_usage": {
        "cols": [
            ("day", "TEXT NOT NULL", None),
            ("kind", "TEXT NOT NULL", None),
            ("count", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "extra": ["PRIMARY KEY (day, kind)"],
    },
    # 到点提醒账(照待办提醒协议:候选=已到点未过期;键含计划时刻与依据;四态+占位)。
    # 不挂外键:删约会后留审计行(作废态),不随约会级联消失。
    "date_reminders": {
        "cols": [
            ("key", "TEXT PRIMARY KEY", None),
            ("plan_id", "INTEGER NOT NULL", "INTEGER NOT NULL DEFAULT 0"),
            ("kind", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT 'stop'"),
            ("stop_id", "INTEGER", "INTEGER"),
            ("basis", "TEXT", "TEXT"),
            ("fire_at", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("expire_at", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("line", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("created_at", "REAL", "REAL"),
            ("wake_claimed_at", "REAL", "REAL"),
            ("woke_at", "REAL", "REAL"),
            # sent / cancelled / unknown / abandoned / expired / void(数据变了作废)
            ("wake_result", "TEXT", "TEXT"),
        ],
        "extra": [],
    },
    # 每站现画:一站一行,sig=种类+地名+画面描述的指纹;sig 变了=重排(旧图作废)
    # status: pending 排队 / running 在画 / done 画好 / failed 画失败(页面用固定画)
    "date_art": {
        "cols": [
            ("stop_id", "INTEGER PRIMARY KEY", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("sig", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("status", "TEXT NOT NULL DEFAULT 'pending'", "TEXT NOT NULL DEFAULT 'pending'"),
            ("requested_at", "REAL", "REAL"),
            ("started_at", "REAL", "REAL"),
            ("finished_at", "REAL", "REAL"),
            ("attempts", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"),
            ("media_id", "TEXT", "TEXT"),
            ("mask_file", "TEXT", "TEXT"),
            ("backend", "TEXT", "TEXT"),
            ("error", "TEXT", "TEXT"),
        ],
        "extra": [],
    },
    # 她请他写的东西(what = invite/contract/card/quote/card_after/reply);他写完即 done_at。约会账「她在等你写」据此列
    # (按钮门控):requested_at = 她按「请写」那一刻;origin=her 的约会只有它不为空才算
    # 「她在等你写」。request_claimed_at / request_woke_at / request_wake_result = 这一轮叫醒的占位/终态,
    # 协议同 date_reminders(claim → woke/result;sent/cancelled/unknown/abandoned/expired/not_sent 释放重试)。
    "date_asks": {
        "cols": [
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("what", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("asked_at", "REAL", "REAL"),
            ("done_at", "REAL", "REAL"),
            ("requested_at", "REAL", "REAL"),
            ("request_claimed_at", "REAL", "REAL"),
            ("request_woke_at", "REAL", "REAL"),
            ("request_wake_result", "TEXT", "TEXT"),
        ],
        "extra": ["UNIQUE (plan_id, what)"],
    },
    # 她按「请写」按钮那次点击的去重(同 client_id 重放 = 原样回,不二次处理;一个约会只留最近一次点击)
    "date_write_requests": {
        "cols": [
            ("plan_id", "INTEGER PRIMARY KEY REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("client_id", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("created_at", "REAL", "REAL"),
        ],
        "extra": [],
    },
    # 一盒一叠照片之外,每盒每人一封信(她的信 + 他的回信)。每人最多一条,可改。
    "date_letters": {
        "cols": [
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("author", "TEXT NOT NULL", None),      # 'her' / 'him'
            ("text", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("created_at", "REAL", "REAL"),
            ("updated_at", "REAL", "REAL"),
        ],
        "extra": ["UNIQUE (plan_id, author)"],
    },
    # 条款只许临时缓存的坐标(谷歌最多 30 天):站上不存,存这里,过期即作废(调度者清掉;需要时重新查)
    "date_place_coords": {
        "cols": [
            ("stop_id", "INTEGER PRIMARY KEY", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("lat", "REAL", "REAL"),
            ("lng", "REAL", "REAL"),
            ("source", "TEXT", "TEXT"),
            ("fetched_at", "REAL", "REAL"),
            ("expires_at", "REAL", "REAL"),
        ],
        "extra": [],
    },
    # 坐标缓存过期后重新查的结果:失败(或回答的不是同一家)按指数退避,期间打开地图不再查
    "date_place_refresh": {
        "cols": [
            ("stop_id", "INTEGER PRIMARY KEY", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("failures", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"),
            ("next_try_at", "REAL", "REAL"),
            ("reason", "TEXT", "TEXT"),
        ],
        "extra": [],
    },
    # 她给构思中的约会留的话(准备中她看得到进度、能留一句话,内容看不到)
    "date_notes": {
        "cols": [
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT", None),
            ("plan_id", "INTEGER NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE", None),
            ("text", "TEXT NOT NULL", "TEXT NOT NULL DEFAULT ''"),
            ("created_at", "REAL", "REAL"),
        ],
        "extra": [],
    },
}

_INDEXES = (
    # 显示顺序在未删站点里唯一(ord 置空 = 删除或改序中间态)
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_date_stops_ord ON date_stops(plan_id, ord)"
    " WHERE deleted_at IS NULL",
    # 每站至多一段未删路段(失效的也算这一段,set_leg 原地重写)
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_date_legs_to ON date_legs(to_stop_id)"
    " WHERE deleted_at IS NULL",
    # 公开记录主键 plan+stop+组;stop 空=约会级,用表达式索引让空值也唯一
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_date_reveals ON date_reveals"
    "(plan_id, IFNULL(stop_id, 0), field_group)",
    "CREATE INDEX IF NOT EXISTS ix_date_events_plan ON date_events(plan_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_date_plans_status ON date_plans(status, date)",
    "CREATE INDEX IF NOT EXISTS ix_date_reminders_open ON date_reminders(plan_id, woke_at)",
    "CREATE INDEX IF NOT EXISTS ix_date_notes_plan ON date_notes(plan_id, created_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_date_plans_client ON date_plans(client_id) WHERE client_id IS NOT NULL",
)


def ensure_schema(conn: sqlite3.Connection) -> None:
    """幂等迁移:建表(IF NOT EXISTS)→ 缺列补齐 → 建索引。重复执行无副作用。"""
    for name, spec in _TABLES.items():
        body = ",\n  ".join([f"{c} {decl}" for c, decl, _ in spec["cols"]] + spec["extra"])
        conn.execute(f"CREATE TABLE IF NOT EXISTS {name} (\n  {body}\n)")
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({name})")}
        for col, _decl, add in spec["cols"]:
            if col not in have and add is not None:
                conn.execute(f"ALTER TABLE {name} ADD COLUMN {col} {add}")
    for sql in _INDEXES:
        conn.execute(sql)
    from . import inbox, outlet, webpush      # side tables of the same database (they import this module)
    for sql in (*inbox._SCHEMA, outlet._DELIVERIES, webpush._SCHEMA):
        conn.execute(sql)


# ── 连接与事务 ────────────────────────────────────────────────────────────────────
_ready: set[str] = set()


def _db_path() -> str:
    return config.db_path()     # 调用时取(测试把 EPHEMERA_DATA_DIR 钉进 tmp)


def _connect(path: str | None = None) -> sqlite3.Connection:
    path = path or _db_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    conn = sqlite3.connect(path, timeout=10, isolation_level=None)  # 手动事务
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    # 删掉的内容(过期的临时坐标等)在库文件里清零,不留在空闲页里
    conn.execute("PRAGMA secure_delete=ON")
    if path not in _ready:
        conn.execute("BEGIN IMMEDIATE")
        try:
            ensure_schema(conn)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            conn.close()
            raise
        _ready.add(path)
    return conn


@contextmanager
def _tx(path: str | None = None):
    """写事务:BEGIN IMMEDIATE(名额判断与写入同锁,两笔并发串行)。异常整笔回滚。"""
    conn = _connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def _now() -> datetime:
    return datetime.now(_tz())


def _as_tz(now: datetime | None) -> datetime:
    if now is None:
        return _now()
    if now.tzinfo is None:
        raise ValueError("now 必须带时区")
    return now.astimezone(_tz())


# ── 时间(唯一权威)─────────────────────────────────────────────────────────────
_HM_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _hm_ok(s) -> bool:
    return isinstance(s, str) and bool(_HM_RE.match(s))


def _mins(hm: str) -> int:
    h, m = hm.split(":")
    return int(h) * 60 + int(m)


def _at(d: date, hm: str) -> datetime:
    h, m = hm.split(":")
    return datetime.combine(d, dtime(int(h), int(m)), _tz())


def _hhmm(dt: datetime) -> str:
    return dt.astimezone(_tz()).strftime("%H:%M")


def _md(d: str | date) -> str:
    d = date.fromisoformat(d) if isinstance(d, str) else d
    return f"{d.month}/{d.day}"


def latest_not_after(anchor: datetime, hm: str) -> datetime:
    """「不晚于 anchor、最近的那个 HH:MM」(reveal_at / 路段 arrive·depart 用)。"""
    cand = _at(anchor.astimezone(_tz()).date(), hm)
    return cand - timedelta(days=1) if cand > anchor else cand


def earliest_not_before(anchor: datetime, hm: str) -> datetime:
    """「不早于 anchor、最近的那个 HH:MM」(stay_until 用)。"""
    cand = _at(anchor.astimezone(_tz()).date(), hm)
    return cand + timedelta(days=1) if cand < anchor else cand


def timeline(st: dict) -> dict:
    """站点绝对时刻:按 ord 依次换算——第 1 站 = date + 时间;之后不早于上一站就同一天,
    早于上一站就过了午夜(加一天)。没写时间的站=None,不参与换算。
    返回 {"abs": {stop_id: dt|None}, "crossings": int, "cross_at": stop_id|None(第二次跨夜的站),
          "span": timedelta|None}"""
    d0 = date.fromisoformat(st["plan"]["date"])
    out: dict = {}
    first_live = next((s.get("time") for s in st["stops"] if s.get("time") and not is_skipped(s)), None)
    day, prev, crossings, second, first, last = d0, None, 0, None, None, None
    for s in st["stops"]:
        t = s.get("time")
        if not t:
            out[s["id"]] = None
            continue
        if is_skipped(s):                     # 跳过的站:锚在约会那天(早于第一个没跳过的站=次日),不随别的站挪动漂移,
            out[s["id"]] = _at(d0 + (timedelta(days=1) if first_live and _mins(t) < _mins(first_live) else timedelta(0)), t)
            continue                          # 也不推进日子、不当后面站的「上一站」
        if prev is not None and _mins(t) < _mins(prev):
            day += timedelta(days=1)
            crossings += 1
            if crossings == 2:
                second = s["id"]
        dt = _at(day, t)
        out[s["id"]] = dt
        prev = t
        first = first or dt
        last = dt
    return {"abs": out, "crossings": crossings, "cross_at": second,
            "span": (last - first) if first else None}


def stay_end(s: dict, abs_: dict) -> datetime | None:
    """该站结束时刻:写了 stay_until = 不早于到达的最近 HH:MM;没写 = 到达时刻。"""
    arr = abs_.get(s["id"])
    if arr is None:
        return None
    return earliest_not_before(arr, s["stay_until"]) if s.get("stay_until") else arr


def leg_times(leg: dict, abs_: dict) -> tuple[datetime | None, datetime | None]:
    """以 to_stop 的绝对到达为锚:arrive = 不晚于锚的最近 HH:MM;
    depart = 不晚于 arrive(无 arrive 则不晚于锚)的最近 HH:MM。"""
    anchor = abs_.get(leg["to_stop_id"])
    if anchor is None:
        return None, None
    arr = latest_not_after(anchor, leg["arrive_time"]) if leg.get("arrive_time") else None
    dep = latest_not_after(arr or anchor, leg["depart_time"]) if leg.get("depart_time") else None
    return dep, arr


def step_times(leg: dict, abs_: dict) -> list[tuple[int, str, datetime]]:
    """换乘明细里的时刻:锚 = 路段到达(没写则到站时刻),各取「不晚于锚的最近 HH:MM」。
    返回 [(第几步, "depart"/"arrive", 绝对时刻)];顺延平移与写回一致性检查用。"""
    _, arr = leg_times(leg, abs_)
    anchor = arr or abs_.get(leg["to_stop_id"])
    if anchor is None:
        return []
    out = []
    for i, stp in enumerate(leg.get("steps") or []):
        for k in ("depart", "arrive"):
            if stp.get(k):
                out.append((i, k, latest_not_after(anchor, stp[k])))
    return out


FIRST_NO_PLACE_TEXT = "第 1 站是你们集合的地方，要有固定地点，不能标 no_place"


def is_no_place(s: dict | None) -> bool:
    """一站是一件事、没有固定地点。"""
    return bool(s and s.get("no_place"))


def is_skipped(s: dict) -> bool:
    """他跳过了这一站(date_live skip)。"""
    return s.get("skipped_at") is not None


def leg_from_id(stops: list[dict], idx: int):
    """通往第 idx(0 起)站的路段该从哪一站出发:往前数第一个有固定地点、没被跳过的站;前面没有 = 第 0 段(她那边)。
    没有固定地点的站、跳过的站都不算路段的起止(不参与路段失效判定)。"""
    for j in range(idx - 1, -1, -1):
        if not is_no_place(stops[j]) and not is_skipped(stops[j]):
            return stops[j]["id"]
    return None


def leg_to(st: dict, stop_id) -> dict | None:
    """通往该站的有效(未失效)路段。没有固定地点的站不算路段→ None。"""
    if is_no_place(next((x for x in st["stops"] if x["id"] == stop_id), None)):
        return None
    for lg in st["legs"]:
        if lg["to_stop_id"] == stop_id and not lg["stale"]:
            return lg
    return None


def reveal_deadline(st: dict, s: dict, abs_: dict) -> datetime | None:
    """「公开要早于出发」的界:路段有出发时刻=出发;否则有 minutes=到达−minutes;否则=到达。
    也是 reveal_at 留空时的默认公开时刻(三档)。"""
    arr = abs_.get(s["id"])
    if arr is None:
        return None
    lg = leg_to(st, s["id"])
    if lg:
        dep, _ = leg_times(lg, abs_)
        if dep is not None:
            return dep
        if lg.get("minutes"):
            return arr - timedelta(minutes=int(lg["minutes"]))
    return arr


def reveal_time(st: dict, s: dict, abs_: dict) -> datetime | None:
    """生效公开时刻(校验、缺项、投影共用):显式 reveal_at = 不晚于到达的最近 HH:MM;留空 = 默认三档。"""
    arr = abs_.get(s["id"])
    if arr is None:
        return None
    if s.get("reveal_at"):
        return latest_not_after(arr, s["reveal_at"])
    return reveal_deadline(st, s, abs_)


# ── 阶段(唯一权威)───────────────────────────────────────────────────────────────
def phase(plan: dict, now: datetime) -> str:
    """draft / draft_expired / sent / live / done / cancelled。
    sent→live 读时计算:约会日 00:00(_tz())起即 live;只有寄出过的才会进 live,draft 永不自动公开。
    live 一直是 live 直到结束;live 把日期改到明天以后=回到 sent(同一公式自然得出)。"""
    s = plan["status"]
    today = _as_tz(now).date()
    d = date.fromisoformat(plan["date"])
    if s == "draft":
        return "draft_expired" if d < today else "draft"
    if s in ("sent", "live"):
        return "live" if today >= d else "sent"
    return s


def _stored_status(plan: dict, now: datetime) -> str:
    ph = phase(plan, now)
    return "draft" if ph == "draft_expired" else ph


# ── 载入 / 写回 ────────────────────────────────────────────────────────────────────
def _load(conn: sqlite3.Connection, plan_id: int) -> dict | None:
    r = conn.execute("SELECT * FROM date_plans WHERE id=?", (plan_id,)).fetchone()
    if r is None:
        return None
    plan = dict(r)
    plan["contract"] = json.loads(plan["contract_json"]) if plan.get("contract_json") else None
    plan["her_wrote"] = set(json.loads(plan["written_by_her"])) if plan.get("written_by_her") else set()
    stops = []
    for row in conn.execute("SELECT * FROM date_stops WHERE plan_id=? AND deleted_at IS NULL"
                            " ORDER BY ord, id", (plan_id,)):
        s = dict(row)
        s["walk_path"] = json.loads(s["walk_path_json"]) if s.get("walk_path_json") else None
        stops.append(s)
    legs = []
    for row in conn.execute("SELECT * FROM date_legs WHERE plan_id=? AND deleted_at IS NULL"
                            " ORDER BY id", (plan_id,)):
        lg = dict(row)
        lg["steps"] = json.loads(lg["steps_json"]) if lg.get("steps_json") else None
        legs.append(lg)
    prep = [dict(row) for row in conn.execute(
        "SELECT * FROM date_prep WHERE plan_id=? ORDER BY ord, id", (plan_id,))]
    reveal_rows = conn.execute(
        "SELECT stop_id, field_group, revealed_at FROM date_reveals WHERE plan_id=?", (plan_id,)).fetchall()
    reveals = {(row["stop_id"], row["field_group"]) for row in reveal_rows}
    # 记录下来的公开时刻(提醒判「某时刻她是否已看到」用;集合 reveals 只回答「现在」)
    reveal_ts = {(row["stop_id"], row["field_group"]): row["revealed_at"] for row in reveal_rows}
    art = {row["stop_id"]: dict(row) for row in conn.execute(
        "SELECT * FROM date_art WHERE plan_id=?", (plan_id,))}
    # 她投影里的 write_request 字段从这里取(project 纯函数,不另开 conn)
    asks = [dict(row) for row in conn.execute(
        "SELECT what, done_at, requested_at, request_woke_at, request_wake_result FROM date_asks"
        " WHERE plan_id=?", (plan_id,))]
    # 她的信 / 他的回信(每人至多一条)
    letters = {row["author"]: {"text": row["text"], "updated_at": row["updated_at"]} for row in conn.execute(
        "SELECT author, text, updated_at FROM date_letters WHERE plan_id=?", (plan_id,))}
    coords = {row["stop_id"]: dict(row) for row in conn.execute(
        "SELECT * FROM date_place_coords WHERE plan_id=?", (plan_id,))}
    return {"plan": plan, "stops": stops, "legs": legs, "prep": prep, "reveals": reveals,
            "reveal_ts": reveal_ts, "art": art, "asks": asks, "letters": letters, "coords": coords}


_PLAN_COLS = ("paper_no", "title_en", "title_zh", "date", "color", "status", "next_note", "contract_json",
              "card_text", "quote", "cancel_reason", "version", "updated_at", "sent_at",
              "closed_at", "cancelled_at", "notes_upto", "invite_text", "written_by_her",
              "open_itinerary")
_STOP_COLS = ("ord", "kind", "time", "stay_until", "title", "address", "lat", "lng", "reveal_at",
              "clue", "note", "how_to_get", "walk_path_json", "opened_early_at", "art_hint",
              "added_by", "her_line", "edited_by_her_at", "no_place", "subtype",
              "kind_before_moment", "subtype_before_moment", "place_source", "place_ref", "skipped_at", "skip_reason")
_LEG_COLS = ("from_stop_id", "to_stop_id", "stale", "mode", "depart_time", "arrive_time",
             "minutes", "summary", "steps_json", "fare", "needs_ticket", "ticket_note",
             "source", "official_url")


def _encode(st: dict) -> None:
    p = st["plan"]
    p["contract_json"] = json.dumps(p["contract"], ensure_ascii=False) if p.get("contract") else None
    p["written_by_her"] = json.dumps(sorted(p["her_wrote"])) if p.get("her_wrote") else None
    for s in st["stops"]:
        s["walk_path_json"] = (json.dumps(s["walk_path"], ensure_ascii=False)
                               if s.get("walk_path") else None)
    for lg in st["legs"]:
        lg["steps_json"] = json.dumps(lg["steps"], ensure_ascii=False) if lg.get("steps") else None


# ── 地点条款存储(EPHEMERA_PLACES_STORE_POLICY;默认 terms)───────────────────────────────────
# terms:按各家条款(places.base.TERMS)只长期存允许的——坐标不许长期存的(谷歌/高德)站上不存坐标;
#        谷歌坐标进 date_place_coords 最多缓存 30 天,过期作废、需要时重新查;高德不缓存,地图上这一站不画。
#        谷歌的地点 ID 可长期存(place_ref),高德什么都不留(标题地址是用户/他自己写进站的字)。
# user: 坐标像手写的一样存在站上(使用者自行承担条款)。手写坐标(没有 place_source)两种规则下都照存。
_NO_CC = object()
COORDS_NOTE = {
    "not_storable": "坐标不可存，未画",
    "expired": "坐标缓存已过期，打开地图时重新查询",
}
UNPLOTTED_TEXT = {
    "not_storable": "坐标不可存，未画",
    "expired": "坐标缓存已过期，重新查询没有成功，未画",
    "lookup_failed": "坐标缓存已过期，重新查询没有成功，未画",
    "other_service": "坐标缓存已过期，现在用的地点服务不是{who}，没法按条款重新查，未画",
    "other_source": "坐标缓存已过期，重新查到的结果不是{who}给的，没有用，未画",
    "no_coords": "这一站没有坐标，未画",
}
PLACE_SOURCE_ZH = {"google": "谷歌", "amap": "高德", "osm": "OpenStreetMap"}
REFRESH_BACKOFF_S = 3600.0          # 重新查失败后第一次等 1 小时,之后每次翻倍
REFRESH_BACKOFF_MAX_S = 86400.0     # 最多等 1 天
_COORDS_DIRTY = "place_coords_dirty"


def _place_terms(src):
    from .places.base import TERMS
    return TERMS.get(src or "")


def place_restricted(src) -> dict | None:
    """这个来源的坐标在当前存储规则下不能长期存在站上 → 该家的条款数据;能存 → None。"""
    t = _place_terms(src)
    if not t or t["long_term_store_ok"] or config.places_store_policy() == "user":
        return None
    return t


def place_store(s: dict, src, ref) -> None:
    """把选中的服务商结果落到内存里的站上(s 已带服务商给的 lat/lng),按存储规则裁剪。"""
    s["place_source"] = src
    t = place_restricted(src)
    if t is None:
        s["place_ref"] = ref
        s["_coords_cache"] = None                  # 坐标就在站上;旧的临时缓存作废
        return
    s["place_ref"] = ref if "provider_id" in t["long_term_fields"] else None
    la, ln = s.get("lat"), s.get("lng")
    s["lat"] = s["lng"] = None
    days = t["coords_cache_max_days"] or 0
    s["_coords_cache"] = (la, ln, src, days) if la is not None and ln is not None and days > 0 else None


def _mark_coords_dirty(conn: sqlite3.Connection, ts: float) -> None:
    """删过临时坐标:下一轮调度把 WAL 截断(旧页面副本里的坐标也不留)。"""
    conn.execute("INSERT INTO ephemera_meta (key, value, updated_at) VALUES (?, '1', ?)"
                 " ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at", (_COORDS_DIRTY, ts))


def _write_coords_cache(conn: sqlite3.Connection, plan_id: int, stop_id: int, cc, ts: float) -> None:
    if cc is None:
        if conn.execute("DELETE FROM date_place_coords WHERE stop_id=?", (stop_id,)).rowcount:
            _mark_coords_dirty(conn, ts)
        conn.execute("DELETE FROM date_place_refresh WHERE stop_id=?", (stop_id,))
        return
    la, ln, src, days = cc
    conn.execute("INSERT INTO date_place_coords (stop_id, plan_id, lat, lng, source, fetched_at, expires_at)"
                 " VALUES (?,?,?,?,?,?,?) ON CONFLICT(stop_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng,"
                 " source=excluded.source, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at",
                 (stop_id, plan_id, la, ln, src, ts, ts + days * 86400))
    conn.execute("DELETE FROM date_place_refresh WHERE stop_id=?", (stop_id,))


def place_coords(st: dict, s: dict, now: datetime) -> tuple:
    """站的坐标(纬度, 经度, 状态)。站上存着的照给;条款不许长期存的:缓存没过期=cached,
    过期/没有=expired(可缓存的来源,需要时重新查),不可缓存=not_storable。其余没坐标=(None, None, None)。"""
    if s.get("lat") is not None or is_no_place(s):
        return s.get("lat"), s.get("lng"), None
    t = _place_terms(s.get("place_source"))
    if not t or t["long_term_store_ok"]:
        return None, None, None
    row = (st.get("coords") or {}).get(s["id"])
    if row and row["expires_at"] is not None and row["expires_at"] > _as_tz(now).timestamp():
        return row["lat"], row["lng"], "cached"
    return None, None, "expired" if (t["coords_cache_max_days"] or 0) > 0 else "not_storable"


def unplotted(view: dict, notes: dict | None = None) -> list[dict]:
    """她的投影里已公开、有固定地点、却没有坐标的站 → 地图上没画的原因(页面逐站说明)。
    notes = {stop_id: 重新查的结果原因}(lookup_failed / other_service / other_source),细化「过期」的说明。"""
    out = []
    for x in (view or {}).get("stops") or []:
        p = x.get("place")
        if not p or x.get("no_place") or p.get("lat") is not None:
            continue
        why = p.get("coords_status") or "no_coords"
        if why == "expired" and (notes or {}).get(x.get("stop_id")):
            why = notes[x["stop_id"]]
        who = PLACE_SOURCE_ZH.get(p.get("place_source") or "", p.get("place_source") or "")
        out.append({"n": x["n"], "stop_id": x.get("stop_id"), "reason": why,
                    "text": (UNPLOTTED_TEXT.get(why) or "").replace("{who}", who) or None})
    return out


def expired_coords(view: dict) -> list[dict]:
    """投影里坐标缓存过期、需要重新查的已公开站。"""
    return [x for x in (view or {}).get("stops") or []
            if x.get("place") and x["place"].get("coords_status") == "expired"]


def cache_place_coords(plan_id: int, stop_id: int, lat: float, lng: float, source: str, *,
                       now: datetime | None = None, path: str | None = None) -> bool:
    """重新查到的坐标写回临时缓存。只认同一家回答的(source 必须等于站的 place_source:别家/兜底回来的坐标
    不能冒充成这家的结果),且只给条款允许缓存的来源;期限照该家条款从现在算。不动约会版本、不落事件。"""
    ts = _as_tz(now).timestamp()
    with _tx(path) as conn:
        r = conn.execute("SELECT place_source, lat, no_place FROM date_stops WHERE id=? AND plan_id=?"
                         " AND deleted_at IS NULL", (stop_id, plan_id)).fetchone()
        if r is None or r["lat"] is not None or r["no_place"] or not source or source != r["place_source"]:
            return False
        t = _place_terms(r["place_source"])
        days = (t or {}).get("coords_cache_max_days") or 0
        if not t or t["long_term_store_ok"] or days <= 0:
            return False
        _write_coords_cache(conn, plan_id, stop_id, (float(lat), float(lng), r["place_source"], days), ts)
        return True


def refresh_state(plan_id: int, *, path: str | None = None) -> dict:
    """{stop_id: {failures, next_try_at, reason}}:重新查坐标的退避记录。"""
    conn = _connect(path)
    try:
        return {r["stop_id"]: dict(r) for r in conn.execute(
            "SELECT stop_id, failures, next_try_at, reason FROM date_place_refresh WHERE plan_id=?", (plan_id,))}
    finally:
        conn.close()


def refresh_failed(plan_id: int, stop_id: int, reason: str, *, now: datetime | None = None,
                   path: str | None = None) -> float:
    """记一次重新查失败(或回答的不是同一家):下次最早什么时候再查(1 小时起,每次翻倍,最多 1 天)。"""
    ts = _as_tz(now).timestamp()
    with _tx(path) as conn:
        r = conn.execute("SELECT failures FROM date_place_refresh WHERE stop_id=?", (stop_id,)).fetchone()
        n = (r["failures"] if r else 0) + 1
        nxt = ts + min(REFRESH_BACKOFF_S * 2 ** (n - 1), REFRESH_BACKOFF_MAX_S)
        conn.execute("INSERT INTO date_place_refresh (stop_id, plan_id, failures, next_try_at, reason)"
                     " VALUES (?,?,?,?,?) ON CONFLICT(stop_id) DO UPDATE SET failures=excluded.failures,"
                     " next_try_at=excluded.next_try_at, reason=excluded.reason", (stop_id, plan_id, n, nxt, reason))
        return nxt


def checkpoint_truncate(path: str | None = None) -> bool:
    """把 WAL 写回库文件并截断(删掉的内容在 WAL 旧页面副本里也不留)。
    返回是否完全成功:读者占着时 busy=1,调用方保留「需要截断」标记,下一轮再来。"""
    conn = _connect(path)
    try:
        row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    finally:
        conn.close()
    return bool(row) and row[0] == 0


def purge_place_coords(*, now: datetime | float | None = None, path: str | None = None) -> int:
    """过期的临时坐标删掉(调度者每轮跑;条款上限一到就不再留着);删过东西就截断 WAL。"""
    ts = now if isinstance(now, (int, float)) else _as_tz(now).timestamp()
    with _tx(path) as conn:
        n = conn.execute("DELETE FROM date_place_coords WHERE expires_at IS NULL OR expires_at <= ?",
                         (ts,)).rowcount
        dirty = conn.execute("SELECT 1 FROM ephemera_meta WHERE key=? AND value='1'", (_COORDS_DIRTY,)).fetchone()
        if n and not dirty:                    # 这轮删过:先记下「需要截断」,截断确认成功后才清
            _mark_coords_dirty(conn, ts)
    if (n or dirty) and checkpoint_truncate(path):
        with _tx(path) as conn:
            conn.execute("DELETE FROM ephemera_meta WHERE key=?", (_COORDS_DIRTY,))
    return n


def enforce_store_policy(*, now: datetime | float | None = None, path: str | None = None) -> dict:
    """存储规则是 terms 时,把之前(user 规则下)站上存着的、条款不许长期存的坐标收回:
    谷歌 = 迁进临时表(从现在起 30 天到期)、站上清掉;高德 = 直接清掉(地图上标未画),地点 ID 也不留;
    这些站「她改了位置」事件里记下的坐标值一并抹掉。user 规则下什么都不做。返回 {moved, cleared}。"""
    out = {"moved": 0, "cleared": 0}
    if config.places_store_policy() != "terms":
        return out
    from .places.base import TERMS
    restricted = [k for k, t in TERMS.items() if not t["long_term_store_ok"]]
    ts = now if isinstance(now, (int, float)) else _as_tz(now).timestamp()
    with _tx(path) as conn:
        rows = conn.execute(
            f"SELECT id, plan_id, lat, lng, place_source, deleted_at, no_place FROM date_stops"
            f" WHERE place_source IN ({','.join('?' * len(restricted))})"
            f" AND (lat IS NOT NULL OR lng IS NOT NULL OR place_ref IS NOT NULL)", restricted).fetchall()
        for r in rows:
            t = TERMS[r["place_source"]]
            days = t["coords_cache_max_days"] or 0
            has = r["lat"] is not None and r["lng"] is not None
            if has and days > 0 and r["deleted_at"] is None and not r["no_place"]:
                _write_coords_cache(conn, r["plan_id"], r["id"], (r["lat"], r["lng"], r["place_source"], days), ts)
                out["moved"] += 1
            elif has:
                out["cleared"] += 1
            keep_ref = "provider_id" in t["long_term_fields"]
            conn.execute("UPDATE date_stops SET lat=NULL, lng=NULL"
                         + ("" if keep_ref else ", place_ref=NULL") + " WHERE id=?", (r["id"],))
            if has or not keep_ref:
                for e in conn.execute("SELECT id, detail_json FROM date_events WHERE plan_id=? AND detail_json IS NOT NULL",
                                      (r["plan_id"],)).fetchall():
                    try:
                        d = json.loads(e["detail_json"])
                    except ValueError:
                        continue
                    if not isinstance(d, dict) or d.get("stop_id") != r["id"]:
                        continue
                    if d.get("field") == "coord":
                        d["before"] = d["after"] = None
                    elif d.get("field") == "place" and not keep_ref:
                        d["before"], d["after"] = [[x[0], None] if isinstance(x, list) and x else x
                                                   for x in (d.get("before"), d.get("after"))]
                    else:
                        continue
                    conn.execute("UPDATE date_events SET detail_json=? WHERE id=?",
                                 (json.dumps(d, ensure_ascii=False), e["id"]))
        if rows:
            _mark_coords_dirty(conn, ts)
    if rows:
        checkpoint_truncate(path)
    return out


def _persist(conn: sqlite3.Connection, old: dict, new: dict, ts: float) -> None:
    """把内存里改好的完整约会写回(同一事务内)。新站的临时负 id 在这里换成真 id。"""
    _encode(new)
    pid = new["plan"]["id"]
    p = new["plan"]
    conn.execute(f"UPDATE date_plans SET {', '.join(c + '=?' for c in _PLAN_COLS)} WHERE id=?",
                 [p.get(c) for c in _PLAN_COLS] + [pid])
    # 站:先把未删站 ord 置空(避开唯一索引的中间冲突),再逐个写最终值
    conn.execute("UPDATE date_stops SET ord=NULL WHERE plan_id=? AND deleted_at IS NULL", (pid,))
    keep = {s["id"] for s in new["stops"]}
    for s in old["stops"]:
        if s["id"] not in keep:
            conn.execute("UPDATE date_stops SET deleted_at=?, updated_at=? WHERE id=?",
                         (ts, ts, s["id"]))
            conn.execute("DELETE FROM date_place_coords WHERE stop_id=?", (s["id"],))
    idmap: dict[int, int] = {}
    caches: list[tuple[dict, object]] = []
    for i, s in enumerate(new["stops"], 1):
        s["ord"] = i
        s["added_by"] = s.get("added_by") or HIM     # 他 add_stop 的新站不带这一键
        s["no_place"] = 1 if s.get("no_place") else 0
        cc = s.pop("_coords_cache", _NO_CC)
        if s["no_place"]:                            # 一件事:没有地点,来源与缓存坐标一起清
            s["place_source"] = s["place_ref"] = None
            cc = None
        caches.append((s, cc))
        if s["id"] < 0:
            cur = conn.execute(
                f"INSERT INTO date_stops (plan_id, {', '.join(_STOP_COLS)}, created_at, updated_at)"
                f" VALUES (?{', ?' * len(_STOP_COLS)}, ?, ?)",
                [pid] + [s.get(c) for c in _STOP_COLS] + [ts, ts])
            idmap[s["id"]] = cur.lastrowid
            s["id"] = cur.lastrowid
        else:
            conn.execute(f"UPDATE date_stops SET {', '.join(c + '=?' for c in _STOP_COLS)},"
                         f" updated_at=? WHERE id=?",
                         [s.get(c) for c in _STOP_COLS] + [ts, s["id"]])
    for s, cc in caches:
        if cc is not _NO_CC:
            _write_coords_cache(conn, new["plan"]["id"], s["id"], cc, ts)
    # 路段:删掉的软删;其余写回(引用的新站临时 id 换真 id)
    keep_l = {lg["id"] for lg in new["legs"] if lg.get("id")}
    for lg in old["legs"]:
        if lg["id"] not in keep_l:
            conn.execute("UPDATE date_legs SET deleted_at=?, updated_at=? WHERE id=?",
                         (ts, ts, lg["id"]))
    for lg in new["legs"]:
        for k in ("from_stop_id", "to_stop_id"):
            if lg.get(k) in idmap:
                lg[k] = idmap[lg[k]]
        if not lg.get("id"):
            cur = conn.execute(
                f"INSERT INTO date_legs (plan_id, {', '.join(_LEG_COLS)}, created_at, updated_at)"
                f" VALUES (?{', ?' * len(_LEG_COLS)}, ?, ?)",
                [pid] + [lg.get(c) for c in _LEG_COLS] + [ts, ts])
            lg["id"] = cur.lastrowid
        else:
            conn.execute(f"UPDATE date_legs SET {', '.join(c + '=?' for c in _LEG_COLS)},"
                         f" updated_at=? WHERE id=?",
                         [lg.get(c) for c in _LEG_COLS] + [ts, lg["id"]])
    # 准备清单:有变化才整表重写
    if _prep_key(old["prep"]) != _prep_key(new["prep"]):
        conn.execute("DELETE FROM date_prep WHERE plan_id=?", (pid,))
        for i, it in enumerate(new["prep"]):
            cur = conn.execute("INSERT INTO date_prep (plan_id, section, text, detail, ord)"
                               " VALUES (?, ?, ?, ?, ?)",
                               (pid, it["section"], it["text"], it.get("detail"), i))
            it["id"] = cur.lastrowid
    # 公开记录:只增不减(公开不可逆)
    for sid, grp in new["reveals"] - old["reveals"]:
        conn.execute("INSERT OR IGNORE INTO date_reveals (plan_id, stop_id, field_group, revealed_at)"
                     " VALUES (?, ?, ?, ?)", (pid, idmap.get(sid, sid), grp, ts))
    new["reveals"] = {(idmap.get(sid, sid), g) for sid, g in new["reveals"]}


def _prep_key(prep: list[dict]) -> list:
    return [(it["section"], it["text"], it.get("detail")) for it in prep]


# ── 公开(唯一投影函数)──────────────────────────────────────────────────────────
def due_reveals(st: dict, now: datetime) -> set:
    """按当前数据此刻应公开、可能还没记录的组。只有 sent/live 会自动到点公开;
    draft 永不公开;cancelled 冻结(取消即不再自动公开);done 另记 all。"""
    ph = phase(st["plan"], now)
    if ph not in ("sent", "live"):
        return set()
    abs_ = timeline(st)["abs"]
    out = set()
    for s in st["stops"]:
        early = s.get("opened_early_at") is not None
        rt = reveal_time(st, s, abs_)
        if early or (rt is not None and now >= rt):
            out.add((s["id"], "place"))
        arr = abs_.get(s["id"])
        # 到站给她的话:到了该站时间,或被提前开且已是当天(矩阵:sent 阶段永不可见)
        if (early and ph == "live") or (arr is not None and now >= arr):
            out.add((s["id"], "note"))
    return out


def _open_all(st: dict) -> bool:
    """不藏行程且她已按「拆开」——全部站对她已公开(不写 date_reveals:提醒的「何时可见」仍按站的原公开时刻算)。"""
    p = st["plan"]
    return bool(p.get("open_itinerary")) and p.get("her_opened_at") is not None and p.get("status") in ("sent", "live", "done")


def shown(st: dict, sid, grp: str) -> bool:
    """这一组她是否已经看到:已记录的公开,或不藏行程且她已拆开。他的改动闸一律按它判
    (拆开后只看 date_reveals 会把她已看到的站当成没公开,放他删站/删路线)。"""
    return (sid, grp) in st["reveals"] or _open_all(st)


def _settle(conn: sqlite3.Connection, st: dict, now: datetime) -> None:
    """结算:把已到点未记录的公开组写进 date_reveals;顺手把 status 同步成 sent/live 实况。
    读口、工具、编辑前、编辑后都调它(结算时机)。"""
    ts = now.timestamp()
    pid = st["plan"]["id"]
    for sid, grp in due_reveals(st, now) - st["reveals"]:
        conn.execute("INSERT OR IGNORE INTO date_reveals (plan_id, stop_id, field_group, revealed_at)"
                     " VALUES (?, ?, ?, ?)", (pid, sid, grp, ts))
        st["reveals"].add((sid, grp))
        st.setdefault("reveal_ts", {})[(sid, grp)] = ts
    want = _stored_status(st["plan"], now)
    if st["plan"]["status"] in ("sent", "live") and want != st["plan"]["status"]:
        conn.execute("UPDATE date_plans SET status=? WHERE id=?", (want, pid))
        st["plan"]["status"] = want


class Visibility:
    """她此刻能看到什么:投影 = 「按当前数据现在应公开」∪「date_reveals 已记录」。
    open_itinerary=1(不藏行程)的约会,从她拆开请柬那一刻起(her_opened_at,页面按「拆开」时
    POST /her/open 记下;寄出但还没拆=照旧逐站到点)全部站的地点/到站的话一起可见,不必等各站各自到点。"""

    def __init__(self, st: dict, now: datetime):
        self.phase = phase(st["plan"], now)
        rec = set(st["reveals"]) | due_reveals(st, now)
        self.all = self.phase == "done"
        self.exists = self.phase in ("sent", "live", "done", "cancelled")
        self.open_itinerary = bool(st["plan"].get("open_itinerary"))
        self.opened = st["plan"].get("her_opened_at") is not None
        # 不藏行程且她已拆开:全部站一起公开
        self.open_all = self.open_itinerary and self.opened and self.exists
        self._rec = rec

    def place(self, stop_id) -> bool:
        return self.all or self.open_all or (stop_id, "place") in self._rec

    def note(self, stop_id) -> bool:
        return self.all or self.open_all or (stop_id, "note") in self._rec

    @property
    def basics(self) -> bool:              # 名字/日期/颜色/编号/准备清单/站数·时间·类型/线索
        return self.exists

    @property
    def sealed(self) -> bool:              # 契约书、小卡(结束后才可见;取消永不)
        return self.all


def leg_phrase(lg: dict | None) -> str:
    """路段的一句话交通方式:「步行约 6 分钟」「坐出租车约 5 分钟」(例句的形)。"""
    if not lg:
        return "（没写）"
    mode = lg.get("mode") or "other"
    zh = LEG_MODES.get(mode, "其他方式")
    head = zh if mode in ("walk", "other") else f"坐{zh}"
    return f"{head}约 {int(lg['minutes'])} 分钟" if lg.get("minutes") else head


def prep_items(st: dict, vis: Visibility | None) -> list[dict]:
    """准备清单 = 他写的条目 + needs_ticket 路段派生的「提前准备」条(只读派生,不另存)。
    vis=None 表示给他看(全量);给她看时目的地未公开只写通用字样。"""
    # key:她打勾按条目记(应落地)。他写的条目 = p:<类>:<文字>((类,文字)本就不许重复;
    # set_prep 整张重插,行 id 不稳,不能用);派生车票条 = t<路段行 id>(路段原地更新 id 不变,揭晓前后同键;
    # 不用 stop_id——目的地没公开时那条特意不说是第几站)。
    items = [{"key": f"p:{it['section']}:{it['text']}", "section": it["section"], "text": it["text"],
              "detail": it.get("detail"), "derived": False} for it in st["prep"]]
    nmap = {s["id"]: i for i, s in enumerate(st["stops"], 1)}
    for s in st["stops"]:
        lg = leg_to(st, s["id"])
        if not lg or not lg.get("needs_ticket"):
            continue
        n = nmap[s["id"]]
        if vis is None or vis.place(s["id"]):
            items.append({"key": f"t{lg.get('id')}", "section": "book", "text": f"去第 {n} 站的车票",
                          "detail": lg.get("ticket_note"), "derived": True, "to_stop": n})
        else:
            items.append({"key": f"t{lg.get('id')}", "section": "book", "text": TXT_DERIVED_HIDDEN,
                          "detail": None, "derived": True})
    return items


def _leg_public_fields(lg: dict) -> dict:
    return {"mode": lg.get("mode"), "depart_time": lg.get("depart_time"),
            "arrive_time": lg.get("arrive_time"), "minutes": lg.get("minutes"),
            "summary": lg.get("summary"), "steps": lg.get("steps"),
            "fare": lg.get("fare"), "needs_ticket": bool(lg.get("needs_ticket")),
            "ticket_note": lg.get("ticket_note"), "official_url": lg.get("official_url")}


def together_day(p: dict) -> int | None:
    """这次约会那天是在一起的第几天(可选配置 EPHEMERA_TOGETHER_SINCE);约会日期坏/早于起点/没设起点 = None。"""
    try:
        return config.together_day(date.fromisoformat(p["date"]))
    except (KeyError, TypeError, ValueError):
        return None


def project(st: dict, now: datetime) -> dict | None:
    """她的视图。构思中/已过期构思中 → None(约会本身不可见)。未公开字段不下发。"""
    now = _as_tz(now)
    vis = Visibility(st, now)
    if not vis.exists:
        return None
    p = st["plan"]
    abs_ = timeline(st)["abs"]
    stops = []
    for n, s in enumerate(st["stops"], 1):
        arr = abs_.get(s["id"])
        # arrive_at =  换算后的绝对到达(epoch 秒;到达时刻本就公开,这里只省掉前端再抄一遍跨午夜规则)
        item = {"n": n, "stop_id": s["id"], "kind": stop_kind(s), "subtype": stop_subtype(s),
                # 固定画轮用:这一站用哪一张(种类本就公开,不泄露地点)
                "art_fixed": fixed_art(stop_kind(s), s["id"]),
                #  功能开关:她能不能改这一站的种类/细类(与她编辑口的权限判断同一个函数;只在已结束时可能为 true)
                "kind_editable": vis.phase == "done" and her_can_edit_kind(s),
                "time": s.get("time"),
                "arrive_at": arr.timestamp() if arr is not None else None,
                "stay_until": s.get("stay_until"), "clue": s.get("clue"),
                "place": None, "note": None, "reveal_at": None,
                # 他跳过了这一站(还在记录里,页面标「跳过了」)与原因
                "skipped": is_skipped(s),
                "skip_reason": s.get("skip_reason") if is_skipped(s) else None,
                # 她给这一站写的一句话(她自己的字;只在结束后能写,所以只会出现在纪念盒里)
                "her_line": s.get("her_line"),
                #  一件事、没有固定地点(功能字段:页面不画地图、不给地址,时间与公开照常)
                "no_place": is_no_place(s)}
        # 还没公开的站:他自己写了公开时间才给她看那个时刻;留空走默认的不给——
        # 默认=路段出发时刻,露出来等于告诉她路上要多久
        if not vis.place(s["id"]) and s.get("reveal_at") and arr is not None:
            item["reveal_at"] = reveal_time(st, s, abs_).timestamp()
        if vis.place(s["id"]):
            lg = leg_to(st, s["id"])
            art = (st.get("art") or {}).get(s["id"])
            la, ln, cst = place_coords(st, s, now)
            item["place"] = {"title": s.get("title"), "address": s.get("address"),
                             # 每站现画:画好且还是这一站现在的样子才给(地点没公开就整个 place 都不给)
                             # art_url=线稿(ink),art_inv_url=反挖(inv);页面按皮肤染色
                             **_art_urls(p["id"], s, art),
                             "lat": la, "lng": ln,
                             # 地点从哪家选来 + 坐标状态(条款不许长期存时:cached / expired / not_storable)
                             "place_source": s.get("place_source"), "place_ref": s.get("place_ref"),
                             "coords_status": cst,
                             "coords_note": COORDS_NOTE.get(cst),
                             "how_to_get": s.get("how_to_get"), "walk_path": s.get("walk_path"),
                             "leg": _leg_public_fields(lg) if lg else None}
        if vis.note(s["id"]):
            item["note"] = s.get("note")
        stops.append(item)
    letters = st.get("letters") or {}
    her_letter, him_reply = letters.get("her"), letters.get("him")
    return {
        "id": p["id"], "paper_no": p.get("paper_no"), "title_en": p["title_en"],
        #  中文名原值(没写=""):永远是英文名下面的小字
        "title_zh": p.get("title_zh") or "",
        # 这次约会是在一起的第几天(config.together_day 同一口径;早于起点/没设起点=None)
        "together_day": together_day(p),
        "date": p["date"], "color": p["color"], "status": vis.phase,
        # 这次是否不藏行程(她的读口不藏字段名=这个值;藏/不藏两种行为一字不改)
        "open_itinerary": vis.open_itinerary,
        # 她按「拆开」被记下的时刻(epoch 秒;没记过=None)。页面本地拆过而这里是 None=补报一次
        "opened_at": p.get("her_opened_at"),
        "stops": stops,
        "prep": prep_items(st, vis),
        "contract": p.get("contract") if vis.sealed else None,
        "card": p.get("card_text") if vis.sealed else None,
        # 迟到的请柬(补记约会才有;与小卡同公开规则:写了才有,结束后可见)
        "invite": p.get("invite_text") if vis.sealed else None,
        "quote": p.get("quote") if vis.sealed else None,
        # 她的信 / 他的回信(同契约书/小卡一样只在结束后可见)
        "letter": ({"text": her_letter["text"], "updated_at": her_letter["updated_at"]}
                   if vis.sealed and her_letter else None),
        "reply": ({"text": him_reply["text"], "updated_at": him_reply["updated_at"]}
                  if vis.sealed and him_reply else None),
        "sent_at": p.get("sent_at"), "closed_at": p.get("closed_at"),
        "cancelled_at": p.get("cancelled_at"),
        # (按钮门控):她按「请写」能请哪些、按过没、那一轮叫醒到哪了
        "write_request": _write_request_view(st.get("asks") or []),
    }


# ── 校验(唯一函数:缺项清单与「写到哪」同出)─────────────────────────────────────
_STOP_REQUIRED = (("kind", "类型"), ("time", "到达时间"), ("title", "地点名"),
                  ("address", "地址"), ("clue", "线索"))


def stop_required(s: dict) -> tuple:
    """这一站寄出时必须写的项:没有固定地点的站不要求地址。"""
    return tuple(x for x in _STOP_REQUIRED if not (x[0] == "address" and is_no_place(s)))


def check(st: dict, now: datetime) -> dict:
    """返回 {"errors": [...], "missing": [...]}。
    errors = 每次写都校验(任何阶段出现即拒写);missing = 寄出时必须(draft 只列为「还缺」,
    sent/live 出现即拒写)。每项 {"code","text","short"};默认值(如留空的 reveal_at)不算缺项。"""
    errors: list[dict] = []
    missing: list[dict] = []
    stops = st["stops"]
    tl = timeline(st)
    abs_ = tl["abs"]
    nmap = {s["id"]: i for i, s in enumerate(stops, 1)}

    def e(code, text):
        errors.append({"code": code, "text": text, "short": text})

    def m(code, short, text):
        missing.append({"code": code, "text": text, "short": short})

    if len(stops) > MAX_STOPS:
        e("too_many_stops", f"最多 {MAX_STOPS} 站，现在是 {len(stops)} 站")
    if stops and all(is_skipped(s) for s in stops):
        e("all_skipped", "每一站都跳过了；至少留一站（不去了用 cancel）")
    if tl["crossings"] > 1:
        e("two_midnights", f"行程最多跨一次午夜，第 {nmap[tl['cross_at']]} 站又过了一次午夜")
    elif tl["span"] is not None and tl["span"] >= timedelta(hours=24):
        e("span_24h", "第 1 站到最后一站要在 24 小时以内")

    for i, s in enumerate(stops):
        n = i + 1
        # 停留到:不早于到达,且早于下一站到达
        if is_skipped(s):                      # 跳过的站不参与先后与公开时间校验
            continue
        end = stay_end(s, abs_)
        j = next((k for k in range(i + 1, len(stops)) if not is_skipped(stops[k])), None)   # 下一个没跳过的站
        if s.get("stay_until") and end is not None and j is not None:
            nxt = abs_.get(stops[j]["id"])
            if nxt is not None and end >= nxt:
                e("stay_overlap", f"第 {n} 站待到 {s['stay_until']}，不早于第 {j + 1} 站到达 "
                                  f"{stops[j]['time']}")
        # 公开要早于出发(显式 reveal_at 才可能违反;已公开过的站豁免)
        placed = shown(st, s["id"], "place")
        if s.get("reveal_at") and not placed and abs_.get(s["id"]) is not None:
            rt = reveal_time(st, s, abs_)
            dl = reveal_deadline(st, s, abs_)
            if rt > dl:
                e("reveal_late", f"第 {n} 站的地点公开时间 {s['reveal_at']} 晚于出发时间 {_hhmm(dl)}")

    for i, s in enumerate(stops):
        if is_no_place(s):
            left = [z for z, on in (("地址", s.get("address")), ("坐标", s.get("lat") is not None or s.get("lng") is not None),
                                     ("散步路线", s.get("walk_path"))) if on]
            if left:
                e("no_place_place", f"第 {i + 1} 站标了没有固定地点（no_place），还留着{'、'.join(left)}："
                                    "先清掉（address 传空、lat/lng 传空、walk_path 传空），或者去掉 no_place")
    smap = {s["id"]: s for s in stops}
    for lg in st["legs"]:
        if lg["to_stop_id"] not in nmap:
            continue
        n = nmap[lg["to_stop_id"]]
        if is_no_place(smap[lg["to_stop_id"]]):
            if not lg["stale"]:
                e("no_place_leg", f"第 {n} 站是一件事、没有固定地点，不算路段；通往它的路段要先用 remove_leg 删掉")
            continue
        if lg["stale"]:
            m("stale_leg", f"第 {n} 站的路段（起点变了，要重写）", f"第 {n} 站的路段起点变了，要重写")
            continue
        steps = lg.get("steps") or []
        if len(steps) > MAX_TRANSFERS + 1:
            e("transfers", f"通往第 {n} 站的路段换乘超过 {MAX_TRANSFERS} 次")
        dep, arr = leg_times(lg, abs_)
        idx = n - 1
        anchor = abs_.get(lg["to_stop_id"])
        pid_ = leg_from_id(stops, idx)                 # 上一个有固定地点的站(一件事的站不算路段起点)
        if pid_ is None and anchor is not None and (dep or arr) is not None \
                and (dep or arr) < anchor - timedelta(hours=24):
            what, own = ("出发", lg["depart_time"]) if dep else ("到达", lg["arrive_time"])
            e("leg0_24h", f"通往第 {n} 站的路段{what}时间 {own} 早于集合前 24 小时")
        if pid_ is not None:
            prev = smap[pid_]
            pn = nmap[pid_]
            pend = stay_end(prev, abs_)
            first_t = dep or arr
            if pend is not None and first_t is not None and first_t < pend:
                what = "出发" if dep else "到达"
                own = lg["depart_time"] if dep else lg["arrive_time"]
                prev_what = f"待到 {prev['stay_until']}" if prev.get("stay_until") \
                    else f"到达 {prev['time']}"
                e("leg_before_prev", f"通往第 {n} 站的路段{what}时间 {own} 早于第 {pn} 站{prev_what}")

    #  兜底:kind=moment ⇒ 没有固定地点、不分细类(写入口各自已拦,这里对改完后的整体再核一遍,绕不过去)
    for i, s in enumerate(stops):
        if s.get("kind") == MOMENT and not is_no_place(s):
            e("moment_place", f"第 {i + 1} 站是一件事（kind=moment），没有固定地点：no_place 不能是 false")
        if s.get("kind") == MOMENT and s.get("subtype"):
            e("moment_subtype", f"第 {i + 1} 站是一件事，不分细类：subtype 要空着")

    # ── 寄出时必须 ──
    if not display_name(st["plan"])[0]:
        m("no_title", "英文名", TXT_NO_TITLE)          # 兜底(英文名写入口已必填)
    if not stops:
        m("no_stops", "站", "还没有站")
    for i, s in enumerate(stops):
        n = i + 1
        for f, label in stop_required(s):
            if s.get(f) in (None, ""):
                m(f"stop_{f}", f"第 {n} 站的{label}", f"第 {n} 站没写{label}")
    if stops:
        s1 = stops[0]
        if is_no_place(s1):                            #  第 1 站是集合的地方(补记的约会不寄出,不走这里)
            m("first_no_place", "第 1 站的固定地点", FIRST_NO_PLACE_TEXT)
        if not s1.get("reveal_at"):
            m("first_reveal", "第 1 站的地点公开时间", "第 1 站没写地点公开时间")
        elif not shown(st, s1["id"], "place") and abs_.get(s1["id"]) is not None:
            if reveal_time(st, s1, abs_) >= abs_[s1["id"]]:
                m("first_reveal_order", "第 1 站的地点公开时间（要早于到达）",
                  f"第 1 站的地点公开时间要早于到达时间 {s1['time']}")
    if not prep_items(st, None):          # 「至少一类」含 needs_ticket 派生的提前准备条
        m("no_prep", "准备清单", "准备清单是空的")
    return {"errors": errors, "missing": missing}


# ── 自动电报(按改动的字段判断,只用可见字段)────────────────────────────────────
def _ref(st: dict, stop_id) -> tuple[int | None, dict | None]:
    for i, s in enumerate(st["stops"], 1):
        if s["id"] == stop_id:
            return s["id"], {"n": i, "title": s.get("title")}
    return None, None


def _line(subject: str, old, new, vb: bool, va: bool, with_value: bool = True) -> str | None:
    """一个字段的电报句:改动前后都不可见 → 不提;两边都可见 → 旧 → 新;只有改后可见 → 写新值;
    只有改前可见 → 只说改了。with_value=False 的长字段(线索/地址/话)永远只说改了。"""
    if not (vb or va):
        return None
    if not with_value:
        return f"{subject}改了"
    if vb and va:
        return f"{subject}改了：{old} → {new}"
    if va:
        return f"{subject}改了：{new}"
    return f"{subject}改了"


def telegram_lines(old: dict, new: dict, now: datetime,
                   moved: set | None = None) -> tuple[list[str], int | None]:
    """寄出后一次编辑的自动电报句子 + 指向的站(取第一处站级改动)。
    moved = 本次被 move_stop 挪动的站(前面加删站导致的编号顺移不算挪)。"""
    moved = moved or set()
    vo, vn = Visibility(old, now), Visibility(new, now)
    lines: list[str] = []
    ref = None
    po, pn = old["plan"], new["plan"]
    if full_name(po) != full_name(pn):
        lines.append(_line("名字", f"「{full_name(po) or '（没写）'}」", f"「{full_name(pn) or '（没写）'}」", True, True))
    if po["date"] != pn["date"]:
        lines.append(f"日期改了：{_md(po['date'])} → {_md(pn['date'])}")
    if po["color"] != pn["color"]:
        lines.append(f"颜色改了：{COLORS[po['color']]} → {COLORS[pn['color']]}")

    on = {s["id"]: i for i, s in enumerate(old["stops"], 1)}
    nn = {s["id"]: i for i, s in enumerate(new["stops"], 1)}
    first_changed_line = None
    if old["stops"] and new["stops"] and old["stops"][0]["id"] != new["stops"][0]["id"]:
        ot, nt = old["stops"][0].get("time"), new["stops"][0].get("time")
        if ot != nt:     # 换了集合站:见面时间变了要单独说
            first_changed_line = f"集合时间改了：{ot or '（没写）'} → {nt or '（没写）'}"
    olds = {s["id"]: s for s in old["stops"]}
    for s in new["stops"]:
        sid, n = s["id"], nn[s["id"]]
        if sid not in olds:
            lines.append(f"加了一站：第 {n} 站 {s.get('time') or ''}".rstrip())
            ref = ref or sid
            continue
        o = olds[sid]
        before = len(lines)
        if sid in moved:
            lines.append(f"第 {on[sid]} 站挪到了第 {n} 站")
        subj = "集合时间" if n == 1 else f"第 {n} 站时间"
        if o.get("time") != s.get("time"):
            lines.append(_line(subj, o.get("time"), s.get("time"), True, True))
        if o.get("stay_until") != s.get("stay_until"):
            lines.append(_line(f"第 {n} 站待到的时间", o.get("stay_until") or "（没写）",
                               s.get("stay_until") or "（没写）", True, True))
        if stop_label(o) != stop_label(s):             #  大类·细类(细类与种类同样对她可见)
            lines.append(_line(f"第 {n} 站类型", stop_label(o) or "（没写）", stop_label(s) or "（没写）", True, True))
        if o.get("clue") != s.get("clue"):
            lines.append(_line(f"第 {n} 站的线索", None, None, True, True, with_value=False))
        pb, pa = vo.place(sid), vn.place(sid)
        if o.get("title") != s.get("title"):
            lines.append(_line(f"第 {n} 站的地点", o.get("title"), s.get("title"), pb, pa))
        if o.get("address") != s.get("address"):
            lines.append(_line(f"第 {n} 站的地址", None, None, pb, pa, with_value=False))
        if (o.get("lat"), o.get("lng")) != (s.get("lat"), s.get("lng")):
            lines.append(_line(f"第 {n} 站的位置", None, None, pb, pa, with_value=False))
        if o.get("how_to_get") != s.get("how_to_get"):
            lines.append(_line(f"第 {n} 站的「怎么去」", None, None, pb, pa, with_value=False))
        if o.get("walk_path") != s.get("walk_path"):
            lines.append(_line(f"第 {n} 站的散步路线", None, None, pb, pa, with_value=False))
        if o.get("note") != s.get("note"):
            lines.append(_line(f"第 {n} 站给你的话", None, None, vo.note(sid), vn.note(sid),
                               with_value=False))
        lo, ln_ = leg_to(old, sid), leg_to(new, sid)
        if _leg_sig(lo) != _leg_sig(ln_):
            if lo is None and ln_ is not None:
                if pa:
                    lines.append(f"怎么去第 {n} 站写好了：{leg_phrase(ln_)}")
            elif ln_ is not None:
                ph_o, ph_n = leg_phrase(lo), leg_phrase(ln_)
                lines.append(_line(f"怎么去第 {n} 站", ph_o, ph_n, pb, pa,
                                   with_value=ph_o != ph_n))
            elif lo is not None and pb:                # 寄出后路段可被撤掉:她看到过的要告诉她
                lines.append(f"怎么去第 {n} 站去掉了")
        if len([x for x in lines[before:] if x]) and ref is None:
            ref = sid
    for o in old["stops"]:
        if o["id"] not in nn:
            lines.append(f"少了一站：原来的第 {on[o['id']]} 站（{o.get('time') or '没写时间'}）")
            ref = ref or o["id"]
    if first_changed_line:
        lines.append(first_changed_line)

    # 准备清单:按「区+文字」比对他写的条目;派生条按她看到的文字比对
    sec = PREP_SECTIONS
    oi, ni = prep_items(old, vo), prep_items(new, vn)
    oc = Counter((i["section"], i["text"]) for i in oi)
    nc = Counter((i["section"], i["text"]) for i in ni)
    for k in nc:
        for _ in range(nc[k] - oc[k]):
            lines.append(f"准备清单更新了：{sec[k[0]]} 加了「{k[1]}」")
    for k in oc:
        for _ in range(oc[k] - nc[k]):
            lines.append(f"准备清单更新了：{sec[k[0]]} 去掉了「{k[1]}」")
    od = {(i["section"], i["text"]): i.get("detail") for i in oi if oc[(i["section"], i["text"])] == 1}
    for i in ni:
        k = (i["section"], i["text"])
        if nc[k] == 1 and k in od and od[k] != i.get("detail"):
            lines.append(f"准备清单更新了：{sec[k[0]]}「{k[1]}」的说明改了")
    return [x for x in lines if x], ref


def _leg_sig(lg: dict | None):
    return None if lg is None else tuple(_leg_public_fields(lg).items()) + (lg.get("from_stop_id"),)


# ── 事件落库─────────────────────────────────────────────────────────────────────
def _add_event(conn: sqlite3.Connection, st: dict, kind: str, text: str, ts: float,
               ref_stop_id=None, old: dict | None = None, detail: dict | None = None) -> int:
    """ref 快照先按改后的站序取;站被这次删掉了就按改前的取(站号=删前的第几站)。
    她自己的动作(HER_EVENT_KINDS)不推送:直接落 skipped,date_push 不会捡。"""
    assert kind in EVENT_KINDS
    sid, snap = _ref(st, ref_stop_id) if ref_stop_id is not None else (None, None)
    if snap is None and ref_stop_id is not None and old is not None:
        sid, snap = _ref(old, ref_stop_id)
    cur = conn.execute(
        "INSERT INTO date_events (plan_id, kind, text, ref_stop_id, ref_snapshot, push_state,"
        " created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (st["plan"]["id"], kind, text, sid,
         json.dumps(snap, ensure_ascii=False) if snap else None,
         "skipped" if kind in HER_EVENT_KINDS else "pending", ts,
         json.dumps(detail, ensure_ascii=False) if detail else None))
    return cur.lastrowid


# ── 到点提醒───────────────────────────────────────────────────────────────
# 提醒不另存「排定表」:任何时刻都能从约会现状算出完整的提醒计划(reminder_plan,纯函数)。
# 待办协议的「改了就作废重排」= 写事务里 _reminders_hook 把不在新计划里的未发行标 void;
# 调度(date_remind.process_reminders)每分钟按现状重算候选,键对不上的永远不会被发。
REMIND_HEAD = "[约会提醒]"
REMIND_LEAD = timedelta(minutes=15)
_WD_ZH = "一二三四五六日"

# (她按「请写」按钮,一次请全部,立刻排一轮叫醒)。正文头与 REMIND_HEAD 并列。
# 没有自然截止时刻(不像提醒绑着约会的时间点),给够跨静音窗(02:00–06:30)+一段忙的裕量再算过期。
REQUEST_HEAD = "[约会请写]"
WRITE_REQUEST_EXPIRE_S = 24 * 3600.0


def _wd_zh(d: date) -> str:
    return "周" + _WD_ZH[d.weekday()]


def _place_visible_at(st: dict, s: dict, abs_: dict, t: datetime) -> bool:
    """该站地点在时刻 t 是否已对她公开:按「何时」判,不按「现在是否已公开」判——
    否则到点公开一结算,出发前 15 分那个过去的时刻也被当成已公开,依据翻成出发、到达提醒凭空消失。
    已记录的公开 ≤ t / 提前开站 ≤ t / 生效公开时刻 ≤ t,任一成立即可见。"""
    ts = t.timestamp()
    rec = (st.get("reveal_ts") or {}).get((s["id"], "place"))
    if rec is not None and rec <= ts:
        return True
    if s.get("opened_early_at") is not None and s["opened_early_at"] <= ts:
        return True
    rt = reveal_time(st, s, abs_)
    return rt is not None and rt <= t


def reminder_plan(st: dict, now: datetime) -> list[dict]:
    """这个约会按现状的完整提醒计划(不论是否到点)。只有 sent/live 有提醒(构思中不提醒)。
    每条 {key, kind, plan_id, stop_id, basis, fire_at, expire_at, line};
    键 = 类型+plan+stop_id+依据+计划时刻,时间或依据一变就是新键。"""
    now = _as_tz(now)
    p = st["plan"]
    ph = phase(p, now)
    if ph not in ("sent", "live"):
        return []
    pid = p["id"]
    d0 = date.fromisoformat(p["date"])
    abs_ = timeline(st)["abs"]
    out: list[dict] = []

    def add(kind, fire, expire, line, stop_id=None, basis=None):
        if fire >= expire:
            return
        out.append({"key": f"{kind}:{pid}:{stop_id or 0}:{basis or '-'}:{fire.isoformat()}",
                    "kind": kind, "plan_id": pid, "stop_id": stop_id, "basis": basis,
                    "fire_at": fire, "expire_at": expire, "line": line})

    timed = [(n, s) for n, s in enumerate(st["stops"], 1)
             if abs_.get(s["id"]) is not None and not is_skipped(s)]          # 跳过的站不提醒
    # 「今天」按第一个没跳过的站(第 1 站被跳过时说的是真正要去的第一站)
    n0, s0 = next(((n, x) for n, x in enumerate(st["stops"], 1) if not is_skipped(x)), (None, None))
    first = abs_.get(s0["id"]) if s0 is not None else None
    # 明天:约会日前一天 20:00,有效到约会日 00:00(过了午夜还说「明天」会错,当天有「今天」那条接上)
    add("eve", _at(d0 - timedelta(days=1), "20:00"), _at(d0, "00:00"),
        f"约会 #{pid} 明天（{_md(d0)} {_wd_zh(d0)}）。")
    # 今天:约会日 09:00(第一站早于 09:15 → 第一站前 15 分),有效到第一站(第一个没跳过的站)
    if first is not None:
        fire = _at(d0, "09:00")
        if first < _at(d0, "09:15"):
            fire = first - REMIND_LEAD
        add("day", fire, first, f"约会 #{pid} 今天，第 {n0} 站 {s0['time']}。")
    # 每站:路段有出发时刻且「出发前 15 分」该站地点已对她公开 → 按出发;否则按到达(防泄露路程长短)
    for n, s in timed:
        arr = abs_[s["id"]]
        lg = leg_to(st, s["id"])
        dep = leg_times(lg, abs_)[0] if lg else None
        if dep is not None and _place_visible_at(st, s, abs_, dep - REMIND_LEAD):
            add("stop", dep - REMIND_LEAD, dep,
                f"约会 #{pid} · 去第 {n} 站 {_hhmm(dep)} 出发 · 15 分钟后。", s["id"], "depart")
        else:
            add("stop", arr - REMIND_LEAD, arr,
                f"约会 #{pid} · 第 {n} 站 {s['time']} 到 · 15 分钟后。", s["id"], "arrival")
    # 还没结束:最后一站所在日期的次日 10:00,有效到当天 23:59;只在 live
    if timed and ph == "live":
        last = abs_[timed[-1][1]["id"]]
        nd = last.date() + timedelta(days=1)
        add("unfinished", _at(nd, "10:00"), _at(nd, "23:59"),
            f"约会 #{pid} 还没结束（最后一站是 {_md(last.date())} {_hhmm(last)}）。")
    return out


def void_stale_reminders(conn: sqlite3.Connection, plan_id: int, keep: set, ts: float) -> int:
    """未发、未占位、且不在现行计划里的提醒行 → void(作废,不再发)。占位中的交给调度收口。"""
    rows = [r[0] for r in conn.execute(
        "SELECT key FROM date_reminders WHERE plan_id=? AND woke_at IS NULL"
        " AND wake_claimed_at IS NULL", (plan_id,))]
    stale = [k for k in rows if k not in keep]
    for k in stale:
        conn.execute("UPDATE date_reminders SET woke_at=?, wake_result='void'"
                     " WHERE key=? AND woke_at IS NULL AND wake_claimed_at IS NULL", (ts, k))
    return len(stale)


def _reminders_hook(conn: sqlite3.Connection, plan_id: int, reason: str, now: datetime) -> None:
    """写事务内(同一笔):按改完后的约会重算提醒计划,把对不上的未发提醒作废。
    删约会/取消/结束 → 计划为空 → 全部未发作废。新计划里的提醒由调度到点再落行(晚寄出也照发)。"""
    st = _load(conn, plan_id)
    keep = {r["key"] for r in reminder_plan(st, now)} if st is not None else set()
    n = void_stale_reminders(conn, plan_id, keep, _as_tz(now).timestamp())
    if n:
        log.info("[date_plan] 约会 #%s %s:作废 %d 条未发提醒", plan_id, reason, n)


# ── 每站小画 ──────────────────────────────────────────────────────────────────────────
# 默认:固定画按站轮换(fixed_art 给名字,页面按名字取自带的图)。可选:配置了生成图接口(ports "art")
# 才排队现画,画好且地点已公开时投影里给 art_url,页面用它替换固定画。不内置任何付费服务。
ART_DEBOUNCE_S = 120          # 排队后 2 分钟没再变才画(他连改几次只画最后一版)

# 每种站的固定画(名字 = 页面素材名;同一站永远是同一张:按站编号取模)
FIXED_ART: dict[str, tuple[str, ...]] = {
    **{k: (k, f"{k}_2", f"{k}_3") for k in ("train", "dinner", "cinema", "walk", "cafe", "viewpoint",
                                             "shopping", "shrine")},
    MOMENT: ("moment_flowers", "moment_cups", "moment_ticket", "moment_ribbon", "moment_star"),
}


def fixed_art(kind: str | None, stop_id: int | None) -> str | None:
    """这一站的固定画名字:有几张备选就按站编号轮换(同一站固定不变);没写种类 = None。"""
    if not kind:
        return None
    names = FIXED_ART.get(kind, (kind,))
    return names[int(stop_id or 0) % len(names)]


def art_enabled() -> bool:
    """配置了生成图接口才现画;没配 = 只用固定画(不排队、他的行程单不提画)。"""
    return ports.configured("art")


def art_daypart(hm: str | None) -> str | None:
    """这一站的时段(写进画面描述,免得画图方一律画成夜景):05:00–16:59 白天 / 17:00–18:59 傍晚 / 其余夜晚;没时间=None。"""
    if not hm or not _hm_ok(hm):
        return None
    m = _mins(hm)
    if 5 * 60 <= m < 17 * 60:
        return "day"
    if 17 * 60 <= m < 19 * 60:
        return "dusk"
    return "night"


def art_sig(s: dict) -> str:
    import hashlib
    # 时段也进指纹:站从白天挪到夜里=画面该换,重画
    raw = "|".join([str(stop_kind(s) or ""), *(str(s.get(k) or "") for k in ("title", "art_hint")),
                    art_daypart(s.get("time")) or ""])     # 细类不进签名
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def art_dir() -> str:
    return str(config.art_dir())


def _art_hook(conn: sqlite3.Connection, plan_id: int, now: datetime, *, her: bool = False) -> None:
    """写事务内排画:寄出后(sent/live)每站一张;构思中只排他写了画面描述的站;种类/地名/画面描述变了=重排、旧图作废。
    站删了=那一行删掉。只排队不出网;画由 art.py 的后台循环做(只在 serve 进程里跑)。
    已结束的约会:他的写入(收尾/补写)不排;her=True(她补记、她结束后改站/补站)按 sent 同规排——
    补记的约会也每站现画,她改了种类/地名按签名重排。没配置生成图接口 = 什么都不做。"""
    if not art_enabled():
        return
    st = _load(conn, plan_id)
    if st is None:
        return
    ph = phase(st["plan"], now)
    if ph == "cancelled" or (ph == "done" and not her):
        return
    if ph == "done":
        ph = "sent"                                # 已结束 + 她的写:每站都排(签名没变的不动)
    ts = now.timestamp()
    have = st.get("art") or {}
    alive = set()
    for s in st["stops"]:
        alive.add(s["id"])
        if not s.get("kind") or not s.get("title"):
            continue
        if not (ph in ("sent", "live") or s.get("art_hint")):
            if s["id"] in have:                    # 构思中把画面描述删了:撤出排队(他行程单不再写「排队重画」)
                conn.execute("DELETE FROM date_art WHERE stop_id=?", (s["id"],))
            continue
        sig = art_sig(s)
        row = have.get(s["id"])
        if row is not None and row["sig"] == sig:
            continue
        conn.execute(
            "INSERT INTO date_art (stop_id, plan_id, sig, status, requested_at, attempts) VALUES (?,?,?,'pending',?,0)"
            " ON CONFLICT(stop_id) DO UPDATE SET sig=excluded.sig, status='pending', requested_at=excluded.requested_at,"
            " attempts=0, started_at=NULL, finished_at=NULL, media_id=NULL, mask_file=NULL, error=NULL",
            (s["id"], plan_id, sig, ts))
    for sid in set(have) - alive:
        conn.execute("DELETE FROM date_art WHERE stop_id=?", (sid,))


def art_line(st: dict, s: dict) -> str | None:
    """他行程单那一站下的一行:这张小画画到哪了。没配置生成图接口 = 不提(她那边一直是固定画)。"""
    row = (st.get("art") or {}).get(s["id"])
    if row is None or not art_enabled():
        return None
    if row["sig"] != art_sig(s):
        return "  画：排队重画（这一站改过）"
    if row["status"] == "done":
        return f"  画：已画好（{config.her()}看到这一站的地点时，固定画会换成它）"
    if row["status"] == "failed":
        return f"  画：没画成（{config.her()}那边用固定画）"
    return "  画：正在画" if row["status"] == "running" else "  画：排队中"


def _art_urls(plan_id: int, s: dict, art: dict | None) -> dict:
    ok = art and art["status"] == "done" and art["sig"] == art_sig(s) and art.get("mask_file")
    base = f"/api/dates/{plan_id}/stops/{s['id']}/art"
    s8 = art["sig"][:8] if ok else ""          # 带版本:重画后页面不吃旧缓存(地点公开后才给,不算泄露)
    return {"art_url": f"{base}?v=ink&s={s8}" if ok else None, "art_inv_url": f"{base}?v=inv&s={s8}" if ok else None}


def her_stop_art(plan_id: int, stop_id: int, *, variant: str = "ink", now: datetime | None = None,
                 path: str | None = None) -> str | None:
    """她取某一站的小画:这一站地点已公开、画好、且还是现在这一站的样子才给文件路径;其余 None(404)。"""
    v = her_plan(plan_id, now=now, path=path)
    if v is None:
        return None
    st_ = next((x for x in v["stops"] if x["stop_id"] == stop_id), None)
    if st_ is None or not st_.get("place") or not st_["place"].get("art_url"):
        return None
    conn = _connect(path)
    try:
        r = conn.execute("SELECT mask_file FROM date_art WHERE stop_id=? AND plan_id=?", (stop_id, plan_id)).fetchone()
    finally:
        conn.close()
    if r is None or not r[0] or variant not in ("ink", "inv"):
        return None
    p = os.path.join(art_dir(), f"{os.path.basename(r[0])}_{variant}.png")
    return p if os.path.isfile(p) else None


# ── 输入清洗 ──────────────────────────────────────────────────────────────────────
def _txt(v, field: str, label: str, limit_key: str | None = None, required=False) -> str | None:
    if v is None or (isinstance(v, str) and v.strip() == ""):
        if required:
            raise _err(f"need_{field}", f"{label}不能空着")
        return None
    if not isinstance(v, str):
        raise _err(f"bad_{field}", f"{label}要是文字")
    v = v.strip()
    lim = LIMITS[limit_key or field]
    if len(v) > lim:
        raise _err(f"long_{field}", f"{label}最多 {lim} 字，现在 {len(v)} 字")
    return v


def _hm_arg(v, field: str, label: str) -> str | None:
    if v is None or v == "":
        return None
    if not _hm_ok(v):
        raise _err(f"bad_{field}", f"{label}要写成 HH:MM（比如 19:05）")
    return v


# 中日文字符(英文名这一格不许出现)按 unicodedata 判(码段表会误伤 〰️〽️、漏掉扩展区汉字):
# 字符名含这些词,或在全角形式区,或在 SIP/TIP 及之后的表意文字扩展区(U+20000–U+3FFFF)=中日文;
# emoji、符号、拉丁扩展(Café)一律放行。
_CJK_NAME_WORDS = ("CJK", "HIRAGANA", "KATAKANA", "HANGUL", "IDEOGRAPHIC", "BOPOMOFO")
_LINE_BREAK_CATS = ("Cc", "Zl", "Zp")


def is_cjk_char(ch: str) -> bool:
    cp = ord(ch)
    # 全角字母/标点 FF00–FF60、全角符号 FFE0–FFE6 算;半角片假名/韩文靠下面的字符名判;
    # 半角箭头等符号 FFE8–FFEE 放行(￩ ￫ 不是中日文)
    if 0x20000 <= cp <= 0x3FFFF or 0xFF00 <= cp <= 0xFF60 or 0xFFE0 <= cp <= 0xFFE6:
        return True
    name = unicodedata.name(ch, "")
    return any(w in name for w in _CJK_NAME_WORDS)


TXT_TITLE_EN_CJK = "英文名这一格只写英文；中文名写在 title_zh"          # 他的工具回执
TXT_TITLE_EN_CJK_HER = "英文名这一格只写英文，中文名写在下面一格"        # 她的补记/PATCH(页面上的说法;code 同为 cjk_title_en)
TXT_NO_TITLE = "英文名不能空着"


def _title_en(v) -> str:
    """英文名(必填; 英文名必须、中文可选)。不许含中日文字符。"""
    if v is None or (isinstance(v, str) and not v.strip()):
        raise _err("need_title_en", TXT_NO_TITLE)
    if not isinstance(v, str):
        raise _err("bad_title_en", "英文名要是文字")
    if any(is_cjk_char(c) for c in v):
        raise _err("cjk_title_en", TXT_TITLE_EN_CJK)
    if any(c != "\n" and unicodedata.category(c) in _LINE_BREAK_CATS for c in v.strip()):
        raise _err("bad_title_en", "英文名最多两行，只用 \\n 分开，不能带别的换行或控制字符")
    lines = [x.strip() for x in v.strip().split("\n")]
    if len(lines) > 2 or any(not x for x in lines):
        raise _err("bad_title_en", "英文名最多两行，用 \\n 分开，每行不能空")
    for x in lines:
        if len(x) > LIMITS["title_en_line"]:
            raise _err("long_title_en", f"英文名每行最多 {LIMITS['title_en_line']} 个字符")
    return "\n".join(lines)


def _title_zh(v) -> str:
    """中文名(可选):空=""。不限字符;一行;最多 LIMITS["title_zh"] 字。"""
    if v is None or (isinstance(v, str) and not v.strip()):
        return ""
    if not isinstance(v, str):
        raise _err("bad_title_zh", "中文名要是文字")
    v = v.strip()
    if len(v.splitlines()) > 1 or any(unicodedata.category(c) in _LINE_BREAK_CATS for c in v):
        raise _err("bad_title_zh", "中文名只写一行")
    if len(v) > LIMITS["title_zh"]:
        raise _err("long_title_zh", f"中文名最多 {LIMITS['title_zh']} 个字，现在 {len(v)} 个字")
    return v


def display_name(plan: dict) -> tuple[str, str]:
    """主副名唯一函数(英文名必须、中文可选、中文永远是小字):main = 英文名(两行合成一行);
    sub = 中文名(有才给,否则空)。不做「只有中文」那条路。"""
    return ((plan.get("title_en") or "").replace("\n", " ").strip(), (plan.get("title_zh") or "").strip())


def full_name(plan: dict) -> str:
    """他那边显示用的全名:两个都有 = 「First Rain（眼镜大作）」;只有一个 = 那一个。"""
    main, sub = display_name(plan)
    return f"{main}（{sub}）" if main and sub else main


def _date_arg(v) -> str:
    if not isinstance(v, str) or not _DATE_RE.match(v):
        raise _err("bad_date", "日期要写成 YYYY-MM-DD")
    try:
        date.fromisoformat(v)
    except ValueError:
        raise _err("bad_date", f"没有 {v} 这一天") from None
    return v


def _color_arg(v) -> str:
    if not isinstance(v, str) or v not in COLORS:
        raise _err("bad_color", "颜色只能是 " + " / ".join(f"{k} {z}" for k, z in COLORS.items()))
    return v


_STOP_FIELDS = ("kind", "time", "stay_until", "title", "address", "lat", "lng", "reveal_at",
                "clue", "note", "how_to_get", "walk_path", "art_hint", "no_place", "subtype")


def _stop_fields(args: dict) -> dict:
    """add_stop/update_stop 的字段清洗。只处理 args 里出现的键;值为 None/空 = 清空。"""
    out: dict = {}
    for k in args:
        if k not in _STOP_FIELDS:
            continue
        v = args[k]
        if k == "kind":
            if v not in (None, "") and v not in KINDS:
                raise _err("bad_kind", "站的类型只能是 " + " / ".join(KINDS))
            out[k] = v or None
        elif k in ("time", "stay_until", "reveal_at"):
            out[k] = _hm_arg(v, k, {"time": "到达时间", "stay_until": "待到的时间",
                                    "reveal_at": "地点公开时间"}[k])
        elif k in ("title", "address", "clue", "note", "how_to_get", "art_hint"):
            out[k] = _txt(v, k, {"title": "地点名", "address": "地址", "clue": "线索",
                                 "note": f"到站给{config.her()}的话", "how_to_get": "怎么去", "art_hint": "画面描述"}[k])
        elif k in ("lat", "lng"):
            if v is None or v == "":
                out[k] = None
            else:
                try:
                    f = float(v)
                except (TypeError, ValueError):
                    raise _err("bad_coord", "坐标要是数字") from None
                lim = 90 if k == "lat" else 180
                if not -lim <= f <= lim:
                    raise _err("bad_coord", f"{'纬度' if k == 'lat' else '经度'}超出范围")
                out[k] = f
        elif k == "walk_path":
            out[k] = _walk_path(v)
        elif k == "no_place":
            if v not in (None, True, False, 0, 1) or isinstance(v, float):
                raise _err("bad_no_place", "no_place 要写 true 或 false")
            out[k] = 1 if v else 0
        elif k == "subtype":
            out[k] = subtype_arg(v)
    return out


def subtype_arg(v) -> str | None:
    """细类:空 = 不写;否则单行、≤12 字,原样存(细类表里的或自定义的都行)。"""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    if not isinstance(v, str):
        raise _err("bad_subtype", "subtype 要是文字")
    v = v.strip()
    if len(v.splitlines()) > 1 or any(unicodedata.category(c) in ("Cc", "Zl", "Zp") for c in v):
        raise _err("bad_subtype", "细类只写一行")
    if len(v) > date_kinds.SUBTYPE_MAX:
        raise _err("long_subtype", f"细类最多 {date_kinds.SUBTYPE_MAX} 个字，现在 {len(v)} 个字")
    return v


def her_can_edit_kind(s: dict) -> bool:
    """她能不能改这一站的种类/细类:她补的站可以,他写的站不行(她的编辑口与投影 kind_editable 共用)。"""
    return s.get("added_by") == "her"


def stop_kind(s: dict) -> str | None:
    """显示用的大类:没有固定地点的站一律当「一件事」(旧数据 no_place=1 但种类不是 moment 也这样读,不改库)。"""
    return MOMENT if is_no_place(s) else s.get("kind")


def stop_subtype(s: dict) -> str | None:
    return None if stop_kind(s) == MOMENT else (s.get("subtype") or None)


def stop_label(s: dict) -> str:
    """「大类·细类」(没有细类只写大类;dinner 按这一站的 time 显示「午餐/晚餐」,见 date_kinds.label)。"""
    return date_kinds.label(stop_kind(s), stop_subtype(s), s.get("time"))


def _remember_before_moment(s: dict, before: dict) -> None:
    """这一站变成一件事:记下当时(内存里改动前)的种类与细类,恢复地点时用。"""
    s["kind_before_moment"] = before.get("kind") if before.get("kind") != MOMENT else None
    s["subtype_before_moment"] = before.get("subtype") or None


def _forget_before_moment(s: dict) -> None:
    s["kind_before_moment"] = None
    s["subtype_before_moment"] = None


def _bind_moment(before: dict | None, s: dict, f: dict, n: int) -> None:
    """kind=moment ⇔ no_place=1(他写的站)。before = 改前的站(新站 None);f = 这一笔给的字段。"""
    kind_given, np_given = "kind" in f, "no_place" in f
    was_kind = (before or {}).get("kind")
    if s.get("kind") == MOMENT:
        if np_given and not f["no_place"]:
            raise _err("moment_place", f"第 {n} 站是一件事（kind=moment），没有固定地点，no_place 不能写 false")
        s["no_place"] = 1
    elif np_given and f["no_place"]:
        if kind_given and f["kind"]:
            raise _err("moment_kind", f"第 {n} 站设了 no_place 就是一件事（kind=moment）；要写别的种类就别设 no_place")
        s["kind"] = MOMENT
    if s.get("kind") == MOMENT and before is not None and was_kind != MOMENT:
        _remember_before_moment(s, before)             # 变成一件事:记下改动前的种类/细类(内存新状态)
    elif s.get("kind") != MOMENT and before is not None and is_no_place(before) and (kind_given or np_given):
        s["no_place"] = 0                              # 从一件事改成有固定地点的种类:要补地点
        if not s.get("address") and s.get("lat") is None:
            raise _err("moment_needs_place", f"第 {n} 站从「一件事」改成有固定地点的种类，要同时补地点（address 或 lat+lng）")
    if s.get("kind") == MOMENT and s.get("subtype"):
        raise _err("moment_subtype", f"第 {n} 站是一件事，不分细类：subtype 要空着")
    if s.get("kind") != MOMENT and was_kind == MOMENT:
        _forget_before_moment(s)                       # 离开一件事:记着的原种类作废


def _walk_path(v):
    if v in (None, "", []):
        return None
    if not isinstance(v, list) or len(v) > MAX_WALK_POINTS:
        raise _err("bad_walk_path", f"散步路线要是坐标点列表，最多 {MAX_WALK_POINTS} 个点")
    pts = []
    for p in v:
        if not (isinstance(p, (list, tuple)) and len(p) == 2):
            raise _err("bad_walk_path", "散步路线的每个点要写成 [纬度, 经度]")
        try:
            la, ln = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            raise _err("bad_walk_path", "散步路线的坐标要是数字") from None
        if not (-90 <= la <= 90 and -180 <= ln <= 180):
            raise _err("bad_walk_path", "散步路线有坐标超出范围")
        pts.append([la, ln])
    return pts


_LEG_FIELDS = ("mode", "depart_time", "arrive_time", "minutes", "summary", "steps", "fare",
               "needs_ticket", "ticket_note", "source", "official_url")


def _leg_fields(args: dict) -> dict:
    out: dict = {}
    mode = args.get("mode")
    if mode not in LEG_MODES:
        raise _err("bad_mode", "路段的交通方式只能是 " + " / ".join(LEG_MODES))
    out["mode"] = mode
    out["depart_time"] = _hm_arg(args.get("depart_time"), "depart_time", "出发时间")
    out["arrive_time"] = _hm_arg(args.get("arrive_time"), "arrive_time", "到达时间")
    mins = args.get("minutes")
    if mins in (None, ""):
        out["minutes"] = None
    else:
        if isinstance(mins, bool) or not isinstance(mins, int) or not 1 <= mins <= 1440:
            raise _err("bad_minutes", "路段大约多久要写成 1 到 1440 之间的整数分钟")
        out["minutes"] = mins
    out["summary"] = _txt(args.get("summary"), "summary", "路段一句话")
    out["steps"] = _steps(args.get("steps"))
    fare = args.get("fare")
    if fare in (None, ""):
        out["fare"] = None
    else:
        if isinstance(fare, bool) or not isinstance(fare, int) or fare < 0:
            raise _err("bad_fare", "车费要写成不小于 0 的整数")
        out["fare"] = fare
    out["needs_ticket"] = 1 if args.get("needs_ticket") else 0
    out["ticket_note"] = _txt(args.get("ticket_note"), "ticket_note", "车票备注")
    src = args.get("source") or "manual"
    if src not in LEG_SOURCES:
        raise _err("bad_source", "source 只能是 manual / checked")
    out["source"] = src
    url = args.get("official_url")
    if url in (None, ""):
        out["official_url"] = None
    else:
        if not isinstance(url, str) or not url.startswith("https://") or len(url) > 1000:
            raise _err("bad_url", "官方路线页链接要是 https:// 开头的网址")
        out["official_url"] = url
    return out


_STEP_KEYS = ("line", "direction", "board", "alight", "stops", "depart", "arrive")


def _steps(v):
    if v in (None, "", []):
        return None
    if not isinstance(v, list):
        raise _err("bad_steps", "换乘明细要是列表")
    if len(v) > MAX_TRANSFERS + 1:
        raise _err("transfers", f"换乘最多 {MAX_TRANSFERS} 次（明细最多 {MAX_TRANSFERS + 1} 步）")
    out = []
    for st_ in v:
        if not isinstance(st_, dict):
            raise _err("bad_steps", "换乘明细每一步要是对象")
        step = {}
        for k in _STEP_KEYS:
            x = st_.get(k)
            if x in (None, ""):
                continue
            if k in ("depart", "arrive"):
                step[k] = _hm_arg(x, f"step_{k}", "换乘的时刻")
            elif k == "stops":
                if isinstance(x, bool) or not isinstance(x, int) or x < 0:
                    raise _err("bad_steps", "坐几站要写成整数")
                step[k] = x
            else:
                if not isinstance(x, str) or len(x) > 40:
                    raise _err("bad_steps", "换乘明细里的线名、方向、站名每项最多 40 字")
                step[k] = x.strip()
        out.append(step)
    return out


def _stop_n(st: dict, stop_id) -> int:
    if isinstance(stop_id, bool) or not isinstance(stop_id, int):
        raise _err("bad_stop", "站要用 stop 编号（整数，详情里每站标着 [stop N]）")
    for i, s in enumerate(st["stops"], 1):
        if s["id"] == stop_id:
            return i
    raise _err("no_stop", f"这个约会里没有 stop {stop_id}")


def _int_arg(v, code: str, text: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise _err(code, text)
    return v


# ── 名额 ─────────────────────────────────────────────────────────────────────────
def _active_count(conn: sqlite3.Connection, today: date, exclude: int | None) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM date_plans WHERE id<>? AND"
        " (status IN ('sent','live') OR (status='draft' AND date>=?))",
        (exclude or 0, today.isoformat())).fetchone()[0]


def _quota_check(conn, today, exclude=None):
    if _active_count(conn, today, exclude) >= MAX_ACTIVE:
        raise _err("quota", f"同时进行中的约会最多 {MAX_ACTIVE} 个，已经满了")


def _paper_no(conn: sqlite3.Connection, plan: dict) -> str:
    """纸面编号 MMDD;同一年同一 MMDD 已有的,第二个起加 -2、-3……(寄出后不变)。"""
    d = date.fromisoformat(plan["date"])
    base = f"{d.month:02d}{d.day:02d}"
    taken = {r[0] for r in conn.execute(
        "SELECT paper_no FROM date_plans WHERE id<>? AND substr(date,1,4)=? AND"
        " (paper_no=? OR paper_no LIKE ?)", (plan["id"], f"{d.year:04d}", base, base + "-%"))}
    if base not in taken:
        return base
    k = 2
    while f"{base}-{k}" in taken:
        k += 1
    return f"{base}-{k}"


# ── 写入:公共骨架 ───────────────────────────────────────────────────────────────────
def _fail(e: DateError, plan_id=None) -> dict:
    return {"ok": False, "plan_id": plan_id, "errors": e.items}


def _ok(st: dict, events: list[int], **extra) -> dict:
    return {"ok": True, "plan_id": st["plan"]["id"], "version": st["plan"]["version"],
            "errors": [], "events": events, **extra}


_PHASE_ZH = {"draft": "构思中", "draft_expired": "构思中（日期已过）", "sent": "已寄出",
             "live": "当天", "done": "已结束", "cancelled": "已取消"}


LATE_HINT = ("结束后只能补写还没写的：迟到的请柬（set_invite，只有她补记的约会有）、契约书（set_contract）、"
             "小卡（set_card）、那一句话（set_quote）、某站你给她的话（update_stop 只写 note）")


def _guard_terminal(pid: int, ph: str) -> None:
    if ph == "done":
        raise _err("phase", f"约会 #{pid} 已经结束了。{config.who(LATE_HINT)}")
    if ph == "cancelled":
        raise _err("phase", f"约会 #{pid} 已经取消了，不能再改")


# ── 请求编号(request_id 幂等;在写事务里查/记,与改动同成同败)──
Req = tuple  # (tool, request_id, args_hash)


def _req_seen(conn: sqlite3.Connection, req: Req | None) -> dict | None:
    """同一个请求编号已经成功做过 → 返回「已做过」结果;同号不同参数 → DateError;没见过 → None。"""
    if not req:
        return None
    tool, rid, ah = req
    r = conn.execute("SELECT args_hash, plan_id FROM date_tool_requests"
                     " WHERE tool=? AND request_id=?", (tool, rid)).fetchone()
    if r is None:
        return None
    if r["args_hash"] != ah:
        raise _err("request_mismatch", f"request_id {rid} 已经用在另一次不同的操作上了，换一个编号")
    return {"ok": True, "plan_id": r["plan_id"], "version": None, "errors": [], "events": [],
            "duplicate": True}


def _req_record(conn: sqlite3.Connection, req: Req | None, plan_id, ts: float) -> None:
    if req:
        tool, rid, ah = req
        conn.execute("INSERT INTO date_tool_requests (tool, request_id, args_hash, plan_id,"
                      " created_at) VALUES (?, ?, ?, ?, ?)", (tool, rid, ah, plan_id, ts))


def _run(plan_id: int, now: datetime | None, path: str | None,
         expect_version, next_note, mutate, req: Req | None = None) -> dict:
    """写操作骨架:加锁 → 载入 → 编辑前结算 → 版本校验 → mutate(old,new,ph,ctx) → 校验改完后的
    完整约会 → 写回 → 编辑后结算 → 事件 → 提醒挂点。任何一步 DateError = 整笔回滚。"""
    try:
        now = _as_tz(now)
        if next_note is not None:
            next_note = _txt(next_note, "next", "下一步留言") if next_note != "" else ""
        with _tx(path) as conn:
            seen = _req_seen(conn, req)
            if seen is not None:
                return seen
            st = _load(conn, plan_id) if isinstance(plan_id, int) and not isinstance(plan_id, bool) else None
            if st is None:
                raise _err("no_plan", f"没有约会 #{plan_id}")
            _settle(conn, st, now)                     # ① 编辑前按旧值结算(到点没人读也收不回)
            ph = phase(st["plan"], now)
            if expect_version is not None and expect_version != st["plan"]["version"]:
                raise _err("version", f"约会 #{plan_id} 已经被改过了（现在是 v{st['plan']['version']}，"
                                      f"你拿的是 v{expect_version}），先看最新的再改")
            old = copy.deepcopy(st)
            new = copy.deepcopy(st)
            ctx: dict = {"events": [], "auto_telegram": ph in ("sent", "live"),
                         "remind": None, "deleted": False}
            mutate(conn, old, new, ph, now, ctx)
            ts = now.timestamp()
            if ctx["deleted"]:
                _reminders_hook(conn, plan_id, "delete_plan", now)
                _req_record(conn, req, plan_id, ts)
                return {"ok": True, "plan_id": plan_id, "version": None, "errors": [],
                        "events": [], "deleted": True}
            _guard_first_no_place(old, new, ph)        #  兜底(结构改动在 _guard_structure 里已先拦)
            # ② 校验改完后的完整约会
            res = check(new, now)
            if ph == "done":
                # 已结束后的补写:寄出用的缺项、路段/公开类校验不适用(补记的约会本来就没有线索、公开时间);
                # 只看时间轴本身理不理得通
                bad = [b for b in res["errors"] if b["code"] in _DONE_ERRORS]
            else:
                bad = list(res["errors"])
                if phase(new["plan"], now) in ("sent", "live", "done") or ctx.get("sending"):
                    #  first_no_place 只当寄出前提:寄出后改前就已经是 no_place 首站的旧数据不拦这一笔
                    # (否则连 set_card、当天 close 都做不了);新造成的已由 _guard_first_no_place 拦下
                    legacy = (not ctx.get("sending") and old["stops"] and new["stops"]
                              and old["stops"][0]["id"] == new["stops"][0]["id"] and is_no_place(old["stops"][0]))
                    # 寄出后撤掉路段可能连带撤掉唯一的车票准备条——准备清单空了不拦(寄出时已过闸)
                    bad += [m for m in res["missing"] if not (legacy and m["code"] == "first_no_place")
                            and not (m["code"] == "no_prep" and not ctx.get("sending"))]
            if bad:
                raise DateError([{"code": b["code"], "text": b["text"]} for b in bad])
            new["plan"]["version"] = old["plan"]["version"] + 1
            new["plan"]["updated_at"] = ts
            new["plan"]["notes_upto"] = conn.execute(
                "SELECT MAX(id) FROM date_notes WHERE plan_id=?", (plan_id,)).fetchone()[0]
            if next_note is not None:
                new["plan"]["next_note"] = next_note or None
            new["plan"]["status"] = _stored_status(new["plan"], now)
            _persist(conn, old, new, ts)
            _settle(conn, new, now)                    # ③ 写后按新值结算
            ev_ids = []
            if ctx["auto_telegram"]:
                lines, ref = telegram_lines(old, new, now, ctx.get("moved"))
                if lines:
                    ev_ids.append(_add_event(conn, new, "telegram_auto", "；".join(lines), ts, ref, old))
            for kind, text, ref in ctx["events"]:
                ev_ids.append(_add_event(conn, new, kind, text, ts, ref))
            if ctx.get("late"):                        # 他补写了她在等的那一样
                complete_ask(plan_id, ctx["late"], conn=conn, now=now)
                # 他写好了要告诉她(电报列表 + 推送,同他别的动作)
                ev_ids.append(_add_event(conn, new, "late_written", f"{config.him()}写好了{_LATE_ZH[ctx['late']]}", ts, None))
            _reminders_hook(conn, plan_id, ctx["remind"] or "edit", now)   # 每笔写都重核(改 reveal_at 等也会影响依据)
            _art_hook(conn, plan_id, now)              # 每站现画:该排的排上、改过的重排
            _req_record(conn, req, plan_id, ts)
            extra = {k: ctx[k] for k in ("late",) if k in ctx}
            return _ok(new, ev_ids, **extra)
    except DateError as e:
        return _fail(e, plan_id)


# ── 写入:开约会 ────────────────────────────────────────────────────────────────────
def _open_itinerary_arg(v) -> int:
    if v not in (None, True, False, 0, 1) or isinstance(v, float):
        raise _err("bad_open_itinerary", "open_itinerary 要写 true 或 false")
    return 1 if v else 0


def open_plan(title_en, date_, color, next_note=None, *, title_zh=None, open_itinerary=None,
              now: datetime | None = None, path: str | None = None, req: Req | None = None) -> dict:
    """date_open:开一个构思中的约会。名额 < 3、日期 ≥ 今天;名额检查与插入同一把写锁。
    英文名必填、中文名可选。open_itinerary(默认 false=藏):寄出后她拆开请柬即可看到
    全部站;寄出后不能再改(可在这里带,也可以寄出前用 set_basic 改)。"""
    try:
        now = _as_tz(now)
        t = _title_en(title_en)
        tz = _title_zh(title_zh)
        d = _date_arg(date_)
        c = _color_arg(color)
        nn = _txt(next_note, "next", "下一步留言")
        oi = _open_itinerary_arg(open_itinerary)
        if date.fromisoformat(d) < now.date():
            raise _err("past_date", "日期不能早于今天")
        ts = now.timestamp()
        with _tx(path) as conn:
            seen = _req_seen(conn, req)
            if seen is not None:
                return seen
            _quota_check(conn, now.date())
            cur = conn.execute(
                "INSERT INTO date_plans (title_en, title_zh, date, color, status, next_note, version,"
                " created_at, updated_at, open_itinerary) VALUES (?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?)",
                (t, tz, d, c, nn, ts, ts, oi))
            _req_record(conn, req, cur.lastrowid, ts)
            return {"ok": True, "plan_id": cur.lastrowid, "version": 1, "errors": [], "events": []}
    except DateError as e:
        return _fail(e)


# ── 写入:date_edit 十二种 op ───────────────────────────────────────────────────────
EDIT_OPS = ("set_basic", "add_stop", "update_stop", "remove_stop", "move_stop", "set_leg",
            "remove_leg", "set_prep", "set_contract", "set_card", "cancel", "delete_plan",
            "set_invite", "set_quote", "write_reply")

_tmp_ids = iter(range(-1, -10_000_000, -1))


def _restale(st: dict) -> list[dict]:
    """相邻关系变了的路段标失效(起点不再是「上一站」;第 0 段=终点不再是第 1 站)。
    失效是粘性的:只有 set_leg(或结构改动附带的 legs)重写才恢复。返回本次新失效的路段。"""
    stops = st["stops"]
    # 起点 = 上一个有固定地点的站(没有固定地点的站加进来/挪走,不让前后路段失效)
    prev = {s["id"]: leg_from_id(stops, i) for i, s in enumerate(stops) if not is_no_place(s) and not is_skipped(s)}
    newly = []
    for lg in st["legs"]:
        if lg["to_stop_id"] in prev and not lg["stale"] and lg["from_stop_id"] != prev[lg["to_stop_id"]]:
            lg["stale"] = 1
            newly.append(lg)
    return newly


def _drop_stale(st: dict) -> list[dict]:
    """撤掉失效路段(起点已不是「上一站」)与通往跳过站的路段;返回撤掉的。"""
    skipped = {s["id"] for s in st["stops"] if is_skipped(s)}
    gone = [lg for lg in st["legs"] if lg["stale"] or lg["to_stop_id"] in skipped]
    st["legs"] = [lg for lg in st["legs"] if lg not in gone]
    return gone


def _guard_first_no_place(old: dict, new: dict, ph: str) -> None:
    """他写的约会第 1 站是集合的地方,不能是 no_place(已结束的约会不寄出、不受限)。
    只拦「这一笔让第 1 站变成了 no_place」:库里已有的旧数据不挡别的修改,缺项清单照样点名。"""
    if ph != "done" and new["stops"] and is_no_place(new["stops"][0]) and not (
            old["stops"] and old["stops"][0]["id"] == new["stops"][0]["id"] and is_no_place(old["stops"][0])):
        raise _err("first_no_place", FIRST_NO_PLACE_TEXT)


def _guard_structure(old: dict, new: dict, ph: str, action: str) -> None:
    """寄出后的结构性改动(加站/删站/移站)共同闸,在 legs 一起重写之后调用:
    - 换第 1 站(集合站):旧第 1 站她还没看到才可以换;她已看到的站不能换成第 1 站。
    - 路段断了(起点不再是上一站):寄出后系统直接撤掉断的那段(原规则=要他同一笔重写)。
    action 只用于回执文字(「删除第 2 站」)。"""
    _guard_first_no_place(old, new, ph)
    _restale(new)
    if ph not in ("sent", "live"):
        return
    onum = {s["id"]: i for i, s in enumerate(old["stops"], 1)}
    if old["stops"] and new["stops"] and old["stops"][0]["id"] != new["stops"][0]["id"]:
        if shown(old, old["stops"][0]["id"], "place"):
            raise _err("first_stop", f"{config.her()}已经看到第 1 站（集合站）了，不能再换集合站。要改它的内容用 update_stop")
        nf = new["stops"][0]["id"]
        if shown(old, nf, "place"):
            raise _err("public_first", f"{config.her()}已经看到第 {onum[nf]} 站了，不能把它换成第 1 站")
    # 寄出后删站/挪站让路段断了=系统直接撤掉断的那段(他想要可以再 set_leg 写),不再拦他
    # (原来:已公开的路段失效=public_leg、留下失效路段=stale_leg,要他在同一笔里重写)
    _drop_stale(new)


def _apply_leg(new: dict, sid, args: dict) -> None:
    """写一段路段(set_leg 与结构改动里的 legs 共用):起点恒为此刻站序里的上一站,写完即不失效。"""
    n = _stop_n(new, sid)
    if is_no_place(new["stops"][n - 1]):
        raise _err("no_place_leg", f"第 {n} 站是一件事、没有固定地点，不算路段，不用写怎么去第 {n} 站")
    f = _leg_fields(args)
    prev = leg_from_id(new["stops"], n - 1)
    cur = next((lg for lg in new["legs"] if lg["to_stop_id"] == sid), None)
    if cur is None:
        cur = {"id": None, "to_stop_id": sid}
        new["legs"].append(cur)
    cur.update(f)
    cur["from_stop_id"] = prev
    cur["stale"] = 0


def _apply_relinks(new: dict, args: dict) -> None:
    """加站/删站/移站同一笔里附带的 legs:按改完后的站序重写受影响的路段(解已公开路线死锁)。"""
    legs = args.get("legs")
    if legs in (None, []):
        return
    if not isinstance(legs, list) or len(legs) > MAX_STOPS:
        raise _err("bad_legs", "legs 要是列表：这次一起重写的路段，每段写 to_stop 和 set_leg 一样的字段")
    seen = set()
    for item in legs:
        if not isinstance(item, dict):
            raise _err("bad_legs", "legs 里每段要是对象")
        sid = item.get("to_stop")
        _stop_n(new, sid)                      # 先验类型与存在(列表/对象当 id 时给规范回执)
        if sid in seen:
            raise _err("bad_legs", f"legs 里 stop {sid} 写了两次")
        seen.add(sid)
        _apply_leg(new, sid, item)


def _op_set_basic(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        p = new["plan"]
        touched = False
        if "title_en" in args:
            p["title_en"] = _title_en(args["title_en"])
            touched = True
        if "title_zh" in args:
            p["title_zh"] = _title_zh(args["title_zh"])
            touched = True
        if "color" in args:
            p["color"] = _color_arg(args["color"])
            touched = True
        if "open_itinerary" in args:
            # 寄出之后不许再改藏不藏(只在构思中可改)
            if ph not in ("draft", "draft_expired"):
                raise _err("sent_locked", "寄出后不能再改是否藏行程")
            p["open_itinerary"] = _open_itinerary_arg(args["open_itinerary"])
            touched = True
        if "date" in args:
            d = _date_arg(args["date"])
            nd, today = date.fromisoformat(d), now.date()
            if ph == "live":
                if nd <= today:
                    raise _err("live_date", "当天改日期只能改到明天或更晚")
            elif ph == "sent" and nd < today:
                raise _err("past_date", "日期不能早于今天")
            # draft 随便改;从不占名额(已过期)变成占名额(今天以后)才过名额检查
            if ph == "draft_expired" and nd >= today:
                _quota_check(conn, today, exclude=p["id"])
            if d != p["date"]:
                p["date"] = d
                ctx["remind"] = "date"
            touched = True
        if not touched:
            raise _err("nothing", "set_basic 没有要改的：title_en / title_zh / date / color 至少给一个")
    return mutate


def _op_add_stop(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        f = _stop_fields(args)
        pos = args.get("position")
        n = len(new["stops"])
        if n >= MAX_STOPS:
            raise _err("too_many_stops", f"最多 {MAX_STOPS} 站，已经满了")
        if pos is None:
            pos = n + 1
        pos = _int_arg(pos, "bad_position", "position 要写整数（第几站）")
        if not 1 <= pos <= n + 1:
            raise _err("bad_position", f"position 只能是 1 到 {n + 1}")
        s = {k: None for k in _STOP_FIELDS}
        s.update(f)
        s.update({"id": next(_tmp_ids), "opened_early_at": None})
        _bind_moment(None, s, f, pos)                  #  一件事 ⇔ 没有固定地点
        new["stops"].insert(pos - 1, s)
        _apply_relinks(new, args)
        _guard_structure(old, new, ph, f"在第 {pos} 站的位置加站")
        ctx["remind"] = "add_stop"
    return mutate


def _op_update_stop(args):
    def mutate(conn, old, new, ph, now, ctx):
        if ph == "done":
            return _late_stop_note(new, args, ctx)
        _guard_terminal(old["plan"]["id"], ph)
        sid = args.get("stop_id")
        _stop_n(new, sid)
        f = _stop_fields(args)
        if not f:
            raise _err("nothing", "update_stop 没有要改的字段")
        s = next(x for x in new["stops"] if x["id"] == sid)
        was = is_no_place(s)
        before = dict(s)
        s.update(f)
        if "lat" in f or "lng" in f:                   # 他手写的坐标:不再算地点服务的结果
            s["place_source"] = s["place_ref"] = None
            s["_coords_cache"] = None
        _bind_moment(before, s, f, _stop_n(new, sid))   #  一件事 ⇔ 没有固定地点
        if (s.get("lat") is None) != (s.get("lng") is None):
            raise _err("bad_coord", "坐标要纬度经度一起写")
        if is_no_place(s) != was:                      #  有没有固定地点变了:路段起止跟着变
            n = _stop_n(new, sid)
            if is_no_place(s):
                lg = next((x for x in new["legs"] if x["to_stop_id"] == sid and not x["stale"]), None)
                if lg is not None and ph in ("sent", "live"):     # 寄出后系统直接撤掉这段,不拦
                    new["legs"] = [x for x in new["legs"] if x is not lg]
                elif lg is not None:
                    raise _err("no_place_leg", f"第 {n} 站还有通往它的路段：先用 remove_leg 删掉，再设 no_place")
            _guard_structure(old, new, ph, f"把第 {n} 站改成{'没有' if is_no_place(s) else '有'}固定地点")
            ctx["remind"] = "update_stop"
        if {"time", "stay_until", "reveal_at"} & set(f):
            ctx["remind"] = "update_stop"
    return mutate


def _op_remove_stop(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        sid = args.get("stop_id")
        n = _stop_n(new, sid)
        if ph in ("sent", "live") and shown(old, sid, "place"):
            raise _err("public_stop", f"{config.her()}已经看到第 {n} 站了，不能删除。要改它用 update_stop，"
                                      f"系统会发电报告诉{config.her()}")
        new["stops"] = [s for s in new["stops"] if s["id"] != sid]
        new["legs"] = [lg for lg in new["legs"] if lg["to_stop_id"] != sid]   # 通往它的路段随站删
        _apply_relinks(new, args)
        _guard_structure(old, new, ph, f"删除第 {n} 站")
        ctx["remind"] = "remove_stop"
    return mutate


def _op_move_stop(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        sid = args.get("stop_id")
        n = _stop_n(new, sid)
        to = _int_arg(args.get("to"), "bad_position", "to 要写整数（挪到第几站）")
        if not 1 <= to <= len(new["stops"]):
            raise _err("bad_position", f"to 只能是 1 到 {len(new['stops'])}")
        if to == n:
            raise _err("nothing", f"第 {n} 站本来就在这个位置")
        s = new["stops"].pop(n - 1)
        new["stops"].insert(to - 1, s)
        ctx["moved"] = {sid}
        _apply_relinks(new, args)
        _guard_structure(old, new, ph, f"移动第 {n} 站")
        ctx["remind"] = "move_stop"
    return mutate


def _op_set_leg(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        _apply_leg(new, args.get("to_stop"), args)
        ctx["remind"] = "set_leg"
    return mutate


def _op_remove_leg(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        sid = args.get("to_stop")
        n = _stop_n(new, sid)
        cur = next((lg for lg in new["legs"] if lg["to_stop_id"] == sid), None)
        if cur is None:
            raise _err("no_leg", f"通往第 {n} 站还没有路段")
        new["legs"] = [lg for lg in new["legs"] if lg is not cur]
        ctx["remind"] = "remove_leg"
    return mutate


def _op_set_prep(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        items = args.get("items")
        if not isinstance(items, list):
            raise _err("bad_prep", "items 要是列表（整张准备清单，按顺序）")
        if len(items) > LIMITS["prep_items"]:
            raise _err("bad_prep", f"准备清单最多 {LIMITS['prep_items']} 条")
        out, seen = [], set()
        for it in items:
            if not isinstance(it, dict) or it.get("section") not in PREP_SECTIONS:
                raise _err("bad_prep", "每条要写 section（" + " / ".join(PREP_SECTIONS) + "）和 text")
            t = _txt(it.get("text"), "prep_text", "准备清单的条目", required=True)
            key = (it["section"], t)
            if key in seen:
                raise _err("bad_prep", f"准备清单里「{t}」重复了")
            seen.add(key)
            out.append({"section": it["section"], "text": t,
                        "detail": _txt(it.get("detail"), "prep_detail", "条目说明")})
        new["prep"] = out
    return mutate


def _op_set_contract(args):
    def mutate(conn, old, new, ph, now, ctx):
        if ph == "done":
            _late_free(new["plan"], "contract")
            items = args.get("items")
            if not isinstance(items, list) or not items or len(items) > MAX_CONTRACT:
                raise _err("bad_contract", f"契约书要写 1 到 {MAX_CONTRACT} 条")
            new["plan"]["contract"] = [_txt(x, "contract_item", "契约书条款", required=True) for x in items]
            ctx["late"] = "contract"
            return
        _guard_terminal(old["plan"]["id"], ph)
        items = args.get("items")
        if items in (None, []):
            new["plan"]["contract"] = None
            return
        if not isinstance(items, list) or len(items) > MAX_CONTRACT:
            raise _err("bad_contract", f"契约书最多 {MAX_CONTRACT} 条")
        new["plan"]["contract"] = [_txt(x, "contract_item", "契约书条款", required=True)
                                   for x in items]
    return mutate


def _op_set_card(args):
    def mutate(conn, old, new, ph, now, ctx):
        if ph == "done":
            _late_free(new["plan"], "card")
            new["plan"]["card_text"] = _txt(args.get("text"), "card", "小卡", required=True)
            ctx["late"] = "card"
            return
        _guard_terminal(old["plan"]["id"], ph)
        new["plan"]["card_text"] = _txt(args.get("text"), "card", "小卡")
    return mutate


# ── 结束后他补写他那一份(只补还没写的;她的字、她补的站的时间地点不碰)──────────────────
_LATE_ZH = {"invite": "迟到的请柬", "contract": "契约书", "card": "小卡", "quote": "那一句话", "reply": "回信"}
_DONE_ERRORS = ("too_many_stops", "two_midnights", "span_24h", "no_place_place", "moment_place", "moment_subtype")
# 她那边整体兜底被拒时 detail.field 指向哪一项
_ERR_FIELD = {"moment_place": "no_place", "moment_subtype": "subtype", "no_place_place": "address"}


def _late_value(p: dict, what: str):
    return {"invite": p.get("invite_text"), "contract": p.get("contract"),
            "card": p.get("card_text"), "quote": p.get("quote")}[what]


def _late_free(p: dict, what: str) -> None:
    """结束后只补空的:已经写了(不管谁写的)= 拒,说清是谁写的。"""
    if _late_value(p, what):
        who = config.her() if what in (p.get("her_wrote") or set()) else "你"
        raise _err("late_written", f"{_LATE_ZH[what]}{who}已经写了，结束后不能再改")


def _late_stop_note(new: dict, args: dict, ctx: dict) -> None:
    sid = args.get("stop_id")
    n = _stop_n(new, sid)
    f = _stop_fields(args)
    other = [k for k in f if k != "note"]
    if other or not f:
        raise _err("late_stop", f"约会已经结束了，update_stop 只能写 note（第 {n} 站你给{config.her()}的话）；"
                                f"时间、地点、类型和{config.her()}写的字都不能改了")
    s = next(x for x in new["stops"] if x["id"] == sid)
    if s.get("note"):
        raise _err("late_written", f"第 {n} 站你给{config.her()}的话已经写了，结束后不能再改")
    if not f["note"]:
        raise _err("need_note", "note 不能空着")
    s["note"] = f["note"]


def _op_set_invite(args):
    def mutate(conn, old, new, ph, now, ctx):
        p = new["plan"]
        if p.get("origin") != "her":
            raise _err("not_backfill", f"迟到的请柬只有{config.her()}补记的约会才有；你写的约会，请柬由日期、站和准备清单拼成，不用另写")
        if ph != "done":
            raise _err("phase", f"约会 #{p['id']} 还没收进纪念盒")
        _late_free(p, "invite")
        p["invite_text"] = _txt(args.get("text"), "invite", "迟到的请柬", required=True)
        ctx["late"] = "invite"
    return mutate


def _op_set_quote(args):
    def mutate(conn, old, new, ph, now, ctx):
        if ph != "done":
            raise _err("phase", "那一句话在结束时用 date_close 写；set_quote 只用来补写已经结束、还没有那一句话的约会")
        _late_free(new["plan"], "quote")
        new["plan"]["quote"] = _txt(args.get("text"), "quote", "那一句话", required=True)
        ctx["late"] = "quote"
    return mutate


def _op_write_reply(args):
    """回她的信(只认 done、她要先有信);与其它「结束后补写」不同,他的回信他能一直改——
    只有第一次写完才算「补上了她在等的那一样」(触发 late_written 电报+推送),之后改动静默生效。
    直接操作 date_letters(与 _persist 的 plan/stops 走的是两套机制)。"""
    def mutate(conn, old, new, ph, now, ctx):
        pid = old["plan"]["id"]
        if ph != "done":
            raise _err("phase", f"约会 #{pid} 还没收进纪念盒")
        her = conn.execute("SELECT 1 FROM date_letters WHERE plan_id=? AND author='her'", (pid,)).fetchone()
        if her is None:
            raise _err("no_letter", f"{config.her()}还没写信，不用回信")
        text = _txt(args.get("text"), "reply", "回信", required=True)
        ts = now.timestamp()
        prev = conn.execute("SELECT 1 FROM date_letters WHERE plan_id=? AND author='him'", (pid,)).fetchone()
        conn.execute(
            "INSERT INTO date_letters (plan_id, author, text, created_at, updated_at) VALUES (?, 'him', ?, ?, ?)"
            " ON CONFLICT(plan_id, author) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at",
            (pid, text, ts, ts))
        if prev is None:
            ctx["late"] = "reply"
    return mutate


def _op_cancel(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        if ph not in ("sent", "live"):
            raise _err("phase", "还没寄出的约会不用取消，要删除用 delete_plan")
        reason = _txt(args.get("reason"), "cancel_reason", "取消的原因", required=True)
        p = new["plan"]
        p["status"] = "cancelled"
        p["cancelled_at"] = now.timestamp()
        p["cancel_reason"] = reason
        ctx["auto_telegram"] = False
        ctx["events"].append(("cancel", f"约会取消了。{config.him()}写：{reason}", None))
        ctx["remind"] = "cancel"
    return mutate


def _op_delete_plan(args):
    def mutate(conn, old, new, ph, now, ctx):
        if ph not in ("draft", "draft_expired"):
            raise _err("phase", "寄出后不能删除，要取消用 cancel")
        conn.execute("DELETE FROM date_plans WHERE id=?", (old["plan"]["id"],))
        ctx["deleted"] = True
    return mutate


_EDIT_MUTATORS = {"set_basic": _op_set_basic, "add_stop": _op_add_stop,
                  "update_stop": _op_update_stop, "remove_stop": _op_remove_stop,
                  "move_stop": _op_move_stop, "set_leg": _op_set_leg,
                  "remove_leg": _op_remove_leg, "set_prep": _op_set_prep,
                  "set_contract": _op_set_contract, "set_card": _op_set_card,
                  "cancel": _op_cancel, "delete_plan": _op_delete_plan,
                  "set_invite": _op_set_invite, "set_quote": _op_set_quote,
                  "write_reply": _op_write_reply}


def edit(plan_id: int, op: str, args: dict | None = None, *, next_note=None,
         expect_version: int | None = None, now: datetime | None = None,
         path: str | None = None, req: Req | None = None) -> dict:
    """date_edit。寄出后每次编辑都对改完后的完整约会跑全量校验;改了她能看到的字段同事务发自动电报。"""
    if op not in _EDIT_MUTATORS:
        return _fail(_err("bad_op", "op 只能是 " + " / ".join(EDIT_OPS)), plan_id)
    return _run(plan_id, now, path, expect_version, next_note,
                _EDIT_MUTATORS[op](args or {}), req)


# ── 写入:寄出 / 当天 / 结束 ─────────────────────────────────────────────────────────
def send(plan_id: int, *, next_note=None, expect_version: int | None = None,
         now: datetime | None = None, path: str | None = None, req: Req | None = None) -> dict:
    """date_send:全量校验通过才寄;生成信封事件;排定提醒(挂点)。寄出时已过公开时刻的站=寄出即公开。"""
    def mutate(conn, old, new, ph, now_, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        if ph == "draft_expired":
            raise _err("past_date", "日期已经过了，先用 set_basic 改日期")
        if ph in ("sent", "live"):
            raise _err("phase", f"约会 #{old['plan']['id']} 已经寄出了")
        res = check(new, now_)
        if res["errors"] or res["missing"]:
            raise DateError([{"code": "send_" + b["code"], "text": b["text"]}
                             for b in res["errors"] + res["missing"]])
        p = new["plan"]
        p["status"] = "sent"
        p["sent_at"] = now_.timestamp()
        p["paper_no"] = _paper_no(conn, p)
        ctx["sending"] = True
        ctx["auto_telegram"] = False
        ctx["events"].append(("envelope", TXT_ENVELOPE, None))
        ctx["remind"] = "send"
    return _run(plan_id, now, path, expect_version, next_note, mutate, req)


LIVE_OPS = ("open_stop", "telegram", "shift", "skip", "unskip")


def live(plan_id: int, op: str, args: dict | None = None, *, next_note=None,
         expect_version: int | None = None, now: datetime | None = None,
         path: str | None = None, req: Req | None = None) -> dict:
    """date_live:open_stop 提前公开某站;telegram 手写电报;shift 从某站起整体顺延/提前;
    skip / unskip 跳过某站(原因必写)/ 撤回跳过。"""
    args = args or {}
    if op == "open_stop":
        mut = _live_open_stop(args)
    elif op == "telegram":
        mut = _live_telegram(args)
    elif op == "shift":
        mut = _live_shift(args)
    elif op in ("skip", "unskip"):
        mut = _live_skip(args, op == "skip")
    else:
        return _fail(_err("bad_op", "op 只能是 " + " / ".join(LIVE_OPS)), plan_id)
    return _run(plan_id, now, path, expect_version, next_note, mut, req)


def _live_open_stop(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        if ph not in ("sent", "live"):
            raise _err("phase", "还没寄出，不能提前公开")
        sid = args.get("stop_id")
        n = _stop_n(new, sid)
        s = next(x for x in new["stops"] if x["id"] == sid)
        if s.get("opened_early_at") is not None or (shown(old, sid, "place") and shown(old, sid, "note")):
            raise _err("already_open", f"第 {n} 站已经公开了")
        s["opened_early_at"] = now.timestamp()
        ctx["auto_telegram"] = False
        ctx["remind"] = "open_stop"
    return mutate


def _live_skip(args, on: bool):
    """跳过某一站(她看到过的也行,原因必写)/ 撤回跳过。跳过的站留在记录里,不参与先后与路段,后面的站可以往前挪。
    通往它的路段、以它为起点的路段一并撤掉(想要再 set_leg 写)。自动发电报告诉她。"""
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        if ph not in ("sent", "live"):
            raise _err("phase", "寄出以后、约会当天才能跳过一站（还没寄出直接 remove_stop）")
        sid = args.get("stop_id")
        n = _stop_n(new, sid)
        s = next(x for x in new["stops"] if x["id"] == sid)
        if on and is_skipped(s):
            raise _err("already_skipped", f"第 {n} 站已经跳过了")
        if not on and not is_skipped(s):
            raise _err("not_skipped", f"第 {n} 站没有跳过")
        if on and all(is_skipped(x) or x["id"] == sid for x in new["stops"]):
            raise _err("skip_all", "不能把每一站都跳过；不去了用 cancel")
        reason = _txt(args.get("reason"), "skip_reason", "跳过的原因", required=True) if on else None
        s["skipped_at"] = now.timestamp() if on else None
        s["skip_reason"] = reason
        _restale(new)
        _drop_stale(new)
        side, _ref = telegram_lines(old, new, now)   # 连带撤掉的路段/车票准备条一起说(跳过的这一站自己的不重复说)
        side = [x for x in side if f"第 {n} 站" not in x]
        ctx["auto_telegram"] = False
        ctx["events"].append(("telegram_auto", "；".join([f"第 {n} 站跳过了：{reason}" if on else f"第 {n} 站不跳过了",
                                                         *side]), sid))
        ctx["remind"] = "edit"
    return mutate


def _live_telegram(args):
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        if ph not in ("sent", "live"):
            raise _err("phase", "还没寄出，电报发不出去")
        text = _txt(args.get("text"), "telegram", "电报", required=True)
        ctx["auto_telegram"] = False
        ctx["events"].append(("telegram_manual", text, None))
    return mutate


def _live_shift(args):
    """当天顺延算法:受影响时刻换绝对 → 加减 → 写回 HH:MM → 重新换算必须逐个相等,否则拒。"""
    def mutate(conn, old, new, ph, now, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        if ph != "live":
            raise _err("phase", "整体顺延只能在约会当天用")
        sid = args.get("from_stop")
        n = _stop_n(new, sid)
        if is_skipped(next(x for x in new["stops"] if x["id"] == sid)):
            raise _err("skipped", f"第 {n} 站跳过了，从它后面那一站开始挪")
        mins = _int_arg(args.get("minutes"), "bad_minutes", "minutes 要写整数（正=推后，负=提前）")
        if mins == 0 or abs(mins) > MAX_SHIFT_MIN:
            raise _err("bad_minutes", f"一次最多挪 {MAX_SHIFT_MIN} 分钟，也不能是 0")
        delta = timedelta(minutes=mins)
        abs_ = timeline(old)["abs"]
        stops = new["stops"]
        affected = [x for x in stops[n - 1:] if not is_skipped(x)]   # 跳过的站不跟着挪
        if any(abs_.get(s["id"]) is None for s in affected):
            raise _err("no_time", "受影响的站有没写时间的，先补上")
        targets: list[tuple[str, object, datetime]] = []
        for s in affected:
            targets.append(("time", s, abs_[s["id"]] + delta))
            if s.get("stay_until"):
                targets.append(("stay", s, stay_end(s, abs_) + delta))
            lg = leg_to(new, s["id"])
            if lg:
                dep, arr = leg_times(lg, abs_)
                if dep is not None:
                    targets.append(("dep", lg, dep + delta))
                if arr is not None:
                    targets.append(("arr", lg, arr + delta))
                for i, k, dt in step_times(lg, abs_):
                    targets.append(("step", (lg, i, k), dt + delta))
            if s.get("reveal_at") and not shown(old, s["id"], "place"):
                targets.append(("reveal", s, reveal_time(old, s, abs_) + delta))
        today0 = datetime.combine(now.date(), dtime(0, 0), _tz())
        if n == 1:
            nf = abs_[stops[0]["id"]] + delta
            if nf.date() != abs_[stops[0]["id"]].date() or nf < today0:
                raise _err("shift_first", "第 1 站会被挪到别的日子，这种情况请用 set_basic 改日期")
        elif any(not is_skipped(x) for x in stops[:n - 1]):
            prev = next(x for x in reversed(stops[:n - 1]) if not is_skipped(x))   # 上一个没跳过的站
            pend = stay_end(prev, abs_)
            if pend is not None and abs_[sid] + delta < pend:
                raise _err("shift_order", f"提前以后第 {n} 站会早于第 {_stop_n(new, prev['id'])} 站的"
                                          f"{'停留结束' if prev.get('stay_until') else '到达'}")
        for kind, obj, dt in targets:
            if kind == "step":
                lg, i, k = obj
                lg["steps"][i][k] = _hhmm(dt)
                continue
            key = {"time": "time", "stay": "stay_until", "dep": "depart_time",
                   "arr": "arrive_time", "reveal": "reveal_at"}[kind]
            obj[key] = _hhmm(dt)
        # 写回后重新换算,必须逐个等于平移后的绝对时刻
        nabs = timeline(new)["abs"]
        for kind, obj, dt in targets:
            if kind == "time":
                got = nabs.get(obj["id"])
            elif kind == "stay":
                got = stay_end(obj, nabs)
            elif kind in ("dep", "arr"):
                got = leg_times(obj, nabs)[0 if kind == "dep" else 1]
            elif kind == "step":
                lg, i, k = obj
                got = next((d for j, kk, d in step_times(lg, nabs) if j == i and kk == k), None)
            else:
                got = reveal_time(new, obj, nabs)
            if got != dt:
                raise _err("shift_mismatch", "挪完以后有时间会被算到别的日子，没法这样挪，"
                                             "请一站站用 update_stop 改")
        word = "顺延" if mins > 0 else "提前"
        ctx["auto_telegram"] = False
        ctx["events"].append(("telegram_auto", f"后面的行程{word} {abs(mins)} 分钟（第 {n} 站起）", sid))
        ctx["remind"] = "shift"
    return mutate


def close(plan_id: int, quote, *, next_note=None, expect_version: int | None = None,
          now: datetime | None = None, path: str | None = None, req: Req | None = None) -> dict:
    """date_close:只有当天(live)能结束;必填那一句话;全部公开;收进纪念盒。"""
    def mutate(conn, old, new, ph, now_, ctx):
        _guard_terminal(old["plan"]["id"], ph)
        if ph != "live":
            raise _err("phase", "还没寄出，不能结束" if ph in ("draft", "draft_expired")
                       else "还没到约会当天，不能结束")
        q = _txt(quote, "quote", "那一句话", required=True)
        p = new["plan"]
        p["status"] = "done"
        p["quote"] = q
        p["closed_at"] = now_.timestamp()
        new["reveals"].add((None, "all"))
        ctx["auto_telegram"] = False
        ctx["events"].append(("close", TXT_CLOSE, None))
        ctx["remind"] = "close"
    return _run(plan_id, now, path, expect_version, next_note, mutate, req)


# ── 读(他这侧, 工具渲染用;会结算)────────────────────────────────────────────────
def snapshot(plan_id: int, *, now: datetime | None = None,
             path: str | None = None) -> dict | None:
    """他读的完整状态:阶段、绝对时刻、校验(写到哪/还缺)、她此刻的投影、电报。不存在/非本人 → None。"""
    now = _as_tz(now)
    with _tx(path) as conn:
        st = _load(conn, plan_id) if isinstance(plan_id, int) and not isinstance(plan_id, bool) else None
        if st is None:
            return None
        _settle(conn, st, now)
        events = [dict(r) for r in conn.execute(
            "SELECT * FROM date_events WHERE plan_id=? ORDER BY created_at, id", (plan_id,))]
        notes = _notes(conn, plan_id)
        asks = open_asks(conn, plan_id, st["plan"].get("origin"))
        photos = _photo_counts(conn, plan_id)
    return {"state": st, "phase": phase(st["plan"], now), "timeline": timeline(st),
            "check": check(st, now), "her_view": project(st, now), "events": events, "notes": notes,
            "asks": asks, "photos": photos, "letters": st.get("letters") or {}}


def _photo_counts(conn: sqlite3.Connection, plan_id: int) -> dict:
    """她放的照片数(按站;表归 date_her,还没建就是没有)。他的详情里提一句,内容他看不到这里。"""
    try:
        return {r[0]: r[1] for r in conn.execute(
            "SELECT stop_id, COUNT(*) FROM date_her_photos WHERE plan_id=? AND deleted_at IS NULL GROUP BY stop_id",
            (plan_id,))}
    except sqlite3.OperationalError as e:
        if "no such table" in str(e):              # 她还没放过任何照片(date_her 还没建表)= 没有;别的错往上抛
            return {}
        raise


def list_plans(*, now: datetime | None = None, path: str | None = None) -> list[dict]:
    """进行中的约会(构思中含过期构思、已寄出、当天),按日期排。"""
    now = _as_tz(now)
    with _tx(path) as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM date_plans WHERE status IN ('draft','sent','live')"
            " ORDER BY date, id")]
        out = []
        for pid in ids:
            st = _load(conn, pid)
            _settle(conn, st, now)
            out.append({"state": st, "phase": phase(st["plan"], now), "check": check(st, now),
                        "notes": _notes(conn, pid)})
    return out


# ── 准备中──────────────────────────────────────────────────────────────
# 构思中的约会她能看到「准备到哪了」:日期、几站、各部分写没写、还缺几样(只给类别和数目)、他上次动笔的时间;
# 看不到名字、颜色和任何内容。
# progress() 是白名单从零拼的,不经 project(),新增字段只能显式加在这里。
NOTE_MAX = 100          # 一句话
NOTES_PER_PLAN = 30
_PROGRESS_WHAT = {      # check() 缺项 code → 她看到的类别(具体是哪一站不给)
    "no_stops": "stops", "stop_kind": "stop_kind", "stop_time": "stop_time", "stop_title": "stop_title",
    "stop_address": "stop_address", "stop_clue": "stop_clue",
    "first_reveal": "first_reveal", "first_reveal_order": "first_reveal", "stale_leg": "legs",
    "no_prep": "prep",
}


def _notes(conn: sqlite3.Connection, plan_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT id, text, created_at FROM date_notes WHERE plan_id=? ORDER BY created_at, id", (plan_id,))]


def progress(st: dict, now: datetime) -> dict:
    """构思中的约会给她的准备进度(纯函数,白名单)。"""
    chk = check(st, now)
    p, stops = st["plan"], st["stops"]
    stop_ids = {s["id"] for s in stops}
    holes = sum(1 for s in stops if any(s.get(f) in (None, "") for f, _ in stop_required(s)))
    counts: dict[str, int] = {}
    for m in chk["missing"]:
        k = _PROGRESS_WHAT.get(m["code"], "other")
        counts[k] = counts.get(k, 0) + 1
    art = st.get("art") or {}
    drawn = sum(1 for s in stops if (a := art.get(s["id"])) and a["status"] == "done" and a["sig"] == art_sig(s))
    return {
        "id": p["id"], "date": p["date"],
        "last_edited_at": p.get("updated_at") or p.get("created_at"),
        "stops": {"count": len(stops), "complete": len(stops) - holes},
        "legs": sum(1 for lg in st["legs"] if not lg["stale"] and lg["to_stop_id"] in stop_ids),
        "prep": len({it["section"] for it in prep_items(st, None)}),
        "contract": bool(p.get("contract")), "card": bool(p.get("card_text")),
        "art": {"drawn": drawn, "planned": sum(1 for s in stops if s.get("art_hint"))},
        "missing": [{"what": k, "count": c} for k, c in counts.items()],
        "conflicts": len(chk["errors"]),
        "ready": not chk["missing"] and not chk["errors"],
    }


def her_preparing(*, now: datetime | None = None, path: str | None = None) -> list[dict]:
    """她看到的「准备中」:构思中且没过日子的约会。每份 = progress + 她自己留过的话。"""
    now = _as_tz(now)
    with _tx(path) as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM date_plans WHERE status='draft' ORDER BY date, id")]
        out = []
        for pid in ids:
            st = _load(conn, pid)
            if phase(st["plan"], now) != "draft":
                continue
            out.append({**progress(st, now), "notes": _notes(conn, pid)})
    return out


class NoteError(Exception):
    def __init__(self, status: int, text: str):
        super().__init__(text)
        self.status, self.text = status, text


def her_leave_note(plan_id: int, text, *, now: datetime | None = None, path: str | None = None) -> dict:
    """她给准备中的约会留一句话。只在构思中(没过日子);不动约会本身(版本、他上次动笔的时间都不变)。
    时刻在拿到写锁之后取(等锁跨了午夜就按写入时的日子判过期)。"""
    t = text.strip() if isinstance(text, str) else ""
    if not t:
        raise NoteError(400, "empty")
    if len(t) > NOTE_MAX or any(ord(c) < 32 and c not in "\n" for c in t):
        raise NoteError(400, "too_long" if len(t) > NOTE_MAX else "bad_char")
    with _tx(path) as conn:
        now = _as_tz(now)
        st = _load(conn, plan_id) if isinstance(plan_id, int) else None
        if st is None or phase(st["plan"], now) != "draft":
            raise NoteError(404, "not found")
        n = conn.execute("SELECT COUNT(*) FROM date_notes WHERE plan_id=?", (plan_id,)).fetchone()[0]
        if n >= NOTES_PER_PLAN:
            raise NoteError(409, "full")
        conn.execute("INSERT INTO date_notes (plan_id, text, created_at) VALUES (?,?,?)",
                     (plan_id, t, now.timestamp()))
        return {**progress(st, now), "notes": _notes(conn, plan_id)}


# ── 她的读口───────────────────────────────────────────────────────────────────
def her_plans(*, now: datetime | None = None, path: str | None = None) -> list[dict]:
    """书架+信封:已寄出/当天/已结束(取消的不上书架,只在事件列表)。每份已投影。"""
    now = _as_tz(now)
    with _tx(path) as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM date_plans WHERE status IN ('sent','live','done')"
            " ORDER BY date, id")]
        out = []
        for pid in ids:
            st = _load(conn, pid)
            _settle(conn, st, now)
            view = project(st, now)
            if view is None:
                continue
            view["unread"] = conn.execute(
                "SELECT COUNT(*) FROM date_events WHERE plan_id=? AND read_at IS NULL"
                f" AND kind NOT IN {_HER_KINDS_SQL}", (pid,)).fetchone()[0]
            out.append(view)
    return out


def her_plan(plan_id: int, *, now: datetime | None = None, path: str | None = None) -> dict | None:
    """单个约会(投影后)。构思中/不存在 → None(对她来说一样不存在)。取消的仍可按 id 取冻结投影。"""
    now = _as_tz(now)
    with _tx(path) as conn:
        st = _load(conn, plan_id) if isinstance(plan_id, int) and not isinstance(plan_id, bool) else None
        if st is None:
            return None
        _settle(conn, st, now)
        return project(st, now)


def _event_view(ev: dict, st: dict, vis: Visibility) -> dict:
    ref = None
    if ev.get("ref_stop_id") is not None:
        snap = json.loads(ev["ref_snapshot"]) if ev.get("ref_snapshot") else {}
        ref = {"n": snap.get("n")}
        # 站名:该站地点「现在」对她已公开才给(揭晓后旧电报也补上站名)
        alive = any(s["id"] == ev["ref_stop_id"] for s in st["stops"])
        if alive and vis.place(ev["ref_stop_id"]) or (ev["ref_stop_id"], "place") in st["reveals"]:
            ref["title"] = snap.get("title")
    return {"id": ev["id"], "plan_id": ev["plan_id"], "kind": ev["kind"], "text": ev["text"],
            "ref_stop": ref, "read_at": ev.get("read_at"), "created_at": ev["created_at"]}


def her_events(plan_id: int | None = None, *, now: datetime | None = None,
               path: str | None = None) -> list[dict]:
    """事件列表(含取消电报),按时间。构思中的约会没有事件、也不出现。"""
    now = _as_tz(now)
    with _tx(path) as conn:
        q = ("SELECT id FROM date_plans WHERE status<>'draft'"
             + (" AND id=?" if plan_id is not None else "") + " ORDER BY id")
        pids = [r[0] for r in conn.execute(q, ((plan_id,) if plan_id is not None else ()))]
        out = []
        for pid in pids:
            st = _load(conn, pid)
            _settle(conn, st, now)
            vis = Visibility(st, now)
            for r in conn.execute("SELECT * FROM date_events WHERE plan_id=?"
                                  f" AND kind NOT IN {_HER_KINDS_SQL} ORDER BY created_at, id", (pid,)):
                out.append(_event_view(dict(r), st, vis))
    out.sort(key=lambda e: (e["created_at"], e["id"]))
    return out


def her_mark_read(ids: list[int], *, now: datetime | None = None, path: str | None = None) -> int:
    """她打开页面看到即写 read_at(只写还没读的;构思中约会的事件不存在)。返回本次标记条数。"""
    now = _as_tz(now)
    ids = [i for i in ids if isinstance(i, int) and not isinstance(i, bool)]
    if not ids:
        return 0
    with _tx(path) as conn:
        cur = conn.execute(
            f"UPDATE date_events SET read_at=? WHERE read_at IS NULL AND id IN"
            f" ({','.join('?' * len(ids))}) AND plan_id IN"
            f" (SELECT id FROM date_plans WHERE status<>'draft') AND kind NOT IN {_HER_KINDS_SQL}",
            [now.timestamp()] + ids)
        return cur.rowcount


# ── 补记过往约会 + 结束后她能加东西 + 她请他写────────────
# 她的三个写口:补记(backfill)/ 结束后编辑(her_edit)/ 她先写三样之一(her_write)。都只认 页面token(register)。
# 她自己的动作落 date_events her_*(只给他看:约会账与详情;不进她的事件列表、不推送)。
# 拒绝一律带原因(哪一项、为什么),不许静默。她的读口(project)白名单里不出 origin / added_by / edited_by_her_at。
ASK_KINDS = ("invite", "contract", "card", "quote", "card_after", "reply")
ASK_ZH = {"invite": "迟到的请柬", "contract": "契约书", "card": "小卡", "quote": "那一句话",
          "card_after": "事件卡的「后续」段", "reply": "回信"}
HER_WRITE_KINDS = ("invite", "contract", "card")
HER_EDIT_MAX_OPS = 20


class HerEditError(Exception):
    """她的写口被拒:status=HTTP 码;detail 给 页面显示(哪一项、为什么)。"""

    def __init__(self, status: int, code: str, text: str, *, op: int | None = None, field: str | None = None):
        super().__init__(text)
        self.status, self.code, self.text, self.op, self.field = status, code, text, op, field

    @property
    def detail(self) -> dict:
        d = {"code": self.code, "text": self.text}
        if self.op is not None:
            d["op_index"] = self.op
        if self.field is not None:
            d["field"] = self.field
        return d


def _ask_conn(path, conn):
    return (conn, False) if conn is not None else (_connect(path), True)


def add_ask(plan_id: int, what: str, *, path: str | None = None, conn: sqlite3.Connection | None = None,
            now: datetime | None = None) -> bool:
    """建一条「她在等他写」(幂等:已有——不论写没写完——都不动,写完的不会被重新打开)。返回是否新建。
    conn=调用方事务里的连接(同成同败);不给就自己开一条(自动提交)。"""
    if what not in ASK_KINDS:
        raise ValueError(f"what 只能是 {' / '.join(ASK_KINDS)}")
    c, own = _ask_conn(path, conn)
    try:
        cur = c.execute("INSERT OR IGNORE INTO date_asks (plan_id, what, asked_at) VALUES (?, ?, ?)",
                        (plan_id, what, _as_tz(now).timestamp()))
        return cur.rowcount == 1
    finally:
        if own:
            c.close()


def complete_ask(plan_id: int, what: str, *, path: str | None = None, conn: sqlite3.Connection | None = None,
                 now: datetime | None = None) -> bool:
    """他(或她先)写完了那一样 → done_at。幂等:没有这条或已完成=不动。返回是否本次完成。"""
    if what not in ASK_KINDS:
        raise ValueError(f"what 只能是 {' / '.join(ASK_KINDS)}")
    c, own = _ask_conn(path, conn)
    try:
        cur = c.execute("UPDATE date_asks SET done_at=? WHERE plan_id=? AND what=? AND done_at IS NULL",
                        (_as_tz(now).timestamp(), plan_id, what))
        return cur.rowcount == 1
    finally:
        if own:
            c.close()


def open_asks(conn: sqlite3.Connection, plan_id: int, origin: str | None = None) -> list[str]:
    """她在等他写的清单(未完成的 ask)。(按钮门控):origin='her' 的约会只算
    requested_at 不为空的那些(她没按「请写」之前不算「她在等你写」);origin 不是 her(他自己写的
    约会)不受门控,行为不变——传 None(旧调用的默认值)也不门控。"""
    rows = conn.execute("SELECT what, requested_at FROM date_asks WHERE plan_id=? AND done_at IS NULL",
                        (plan_id,)).fetchall()
    gated = origin == "her"
    have = {w for w, requested_at in rows if not gated or requested_at is not None}
    return [w for w in ASK_KINDS if w in have]


def _write_request_view(asks: list[dict]) -> dict:
    """她投影里的 write_request 字段:pending=还没写的清单(ASK_KINDS 顺序);
    requested_at=这一批里最晚一次「请写」的时刻,没请过任何一个=None;
    state: none=没有在请的(或没什么要请的)/queued=已请、叫醒还没排上或排上了还没落终态/
    sent=已请的全部叫醒成功/failed=落了终态但不是 sent(她可以再按一次,之前没叫通的会重新排)。"""
    open_ = {a["what"]: a for a in asks if a.get("done_at") is None}
    pending = [w for w in ASK_KINDS if w in open_]
    requested = [open_[w] for w in pending if open_[w].get("requested_at") is not None]
    if not requested:
        return {"pending": pending, "requested_at": None, "state": "none"}
    requested_at = max(a["requested_at"] for a in requested)
    if any(a.get("request_woke_at") is None for a in requested):
        state = "queued"
    elif all(a.get("request_wake_result") == "sent" for a in requested):
        state = "sent"
    else:
        state = "failed"
    return {"pending": pending, "requested_at": requested_at, "state": state}


def request_write_line(p: dict, whats: list[str]) -> str:
    """她按「请写」那一轮给他的那句话(一字不改)。她补记的约会带「，她补记的」,
    他自己写的约会不带。"""
    her_note = f"，{config.her()}补记的" if p.get("origin") == "her" else ""
    items = "、".join(ASK_ZH[w] for w in whats)
    return (f"{REQUEST_HEAD} {config.her()}请你补写约会 #{p['id']}「{full_name(p)}」（{p['date']}{her_note}）"
            f"里还没写的：{items}。用 date_view 打开这次约会看{config.her()}写的内容。")


def _he(status, code, text, op=None, field=None):
    return HerEditError(status, code, text, op=op, field=field)


def _from_date_error(e: DateError, op=None, field=None) -> HerEditError:
    it = e.items[0]
    text = TXT_TITLE_EN_CJK_HER if it["code"] == "cjk_title_en" else it["text"]   # 给她的文案不带字段名
    return HerEditError(400, it["code"], text, op=op, field=field)


def _her_txt(v, field, label, limit_key, required=False, op=None):
    try:
        return _txt(v, field, label, limit_key, required=required)
    except DateError as e:
        raise _from_date_error(e, op, field) from None


def _her_hm(v, field, label, op=None):
    try:
        return _hm_arg(v, field, label)
    except DateError as e:
        raise _from_date_error(e, op, field) from None


def _her_coord(v, field, op=None):
    if v is None or v == "":
        return None
    lim, label = (90, "纬度") if field == "lat" else (180, "经度")
    if isinstance(v, bool):
        raise _he(400, "bad_coord", f"{label}要是数字", op, field)
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise _he(400, "bad_coord", f"{label}要是数字", op, field) from None
    if not -lim <= f <= lim:
        raise _he(400, "bad_coord", f"{label}超出范围", op, field)
    return f


def _her_bool(v, field, op=None) -> int:
    if v is None:
        return 0
    if not isinstance(v, bool):
        raise _he(400, "bad_bool", f"{field} 要写 true 或 false", op, field)
    return 1 if v else 0


def _her_subtype(v, op=None):
    try:
        return subtype_arg(v)
    except DateError as e:
        raise _from_date_error(e, op, "subtype") from None


def _her_bind_new(s: dict, op, where: str) -> None:
    """她新写的站(补记/补一站):kind=moment ⇔ no_place=1;一件事不分细类。"""
    if s["kind"] == MOMENT:
        s["no_place"] = 1
    elif s["no_place"]:
        s["kind"] = MOMENT        # 她选了「一件事」(页面只传 no_place):种类即一件事,投影里 kind=moment
    if s["kind"] == MOMENT and s.get("subtype"):
        raise _he(400, "moment_subtype", f"{where}「一件事」不分细类，subtype 要空着", op, "subtype")


def _her_kind(v, op=None):
    if not isinstance(v, str) or v not in KINDS:
        raise _he(400, "bad_kind", "站的种类只能是 " + " / ".join(KINDS), op, "kind")
    return v


PLACE_REF_MAX = 200


def _her_place_src(x: dict, lat, lng, op=None, where: str = "") -> tuple:
    """她从地点搜索结果里选的地点:(来源, 地点 ID);都没传 = (None, None)。选了结果要连坐标一起传。"""
    src, ref = x.get("place_source"), x.get("place_ref")
    if src in (None, ""):
        if ref not in (None, ""):
            raise _he(400, "bad_place_source", f"{where}place_ref 要和 place_source 一起传", op, "place_source")
        return None, None
    from .places.base import TERMS
    if not isinstance(src, str) or src not in TERMS:
        raise _he(400, "bad_place_source", f"{where}place_source 只能是 " + " / ".join(TERMS), op, "place_source")
    if ref not in (None, "") and (not isinstance(ref, str) or len(ref) > PLACE_REF_MAX):
        raise _he(400, "bad_place_ref", f"{where}place_ref 要是 {PLACE_REF_MAX} 字以内的文字", op, "place_ref")
    if lat is None or lng is None:
        raise _he(400, "place_needs_coord", f"{where}选了地点搜索的结果要连坐标一起传（lat+lng）", op, "lat")
    return src, (ref or None)


def _gives_place(c) -> bool:
    """her_edit 的一条改动是不是给了地点(地址 / 坐标 / 地点搜索结果)。"""
    if c[0] == "place":
        return bool(c[2] and c[2][0])
    return c[0] in ("address", "coord") and c[2] not in (None, "", [None, None])


# 他写的字段(她的编辑口一律拒,回原因)
_HIS_FIELDS = {
    "clue": "线索", "note": "他给你的话", "card": "小卡", "card_text": "小卡", "contract": "契约书",
    "invite": "请柬", "invite_text": "请柬", "quote": "那一句话", "how_to_get": "怎么去",
    "reveal_at": "地点公开时间", "stay_until": "待到的时间", "art_hint": "画面描述", "walk_path": "散步路线",
    "leg": "路线", "legs": "路线",
}
_PLAN_FIELDS = {"title_en": "名字", "title_zh": "中文名", "date": "日期", "color": "颜色"}
# place_source / place_ref:她从地点搜索结果里选的地点 = 搜索候选的 source / provider_id 原样传回(要连 lat/lng);
# 坐标怎么存按存储规则(place_store)。手写的地点不传这两项。
_BACKFILL_STOP_KEYS = ("kind", "time", "title", "address", "lat", "lng", "her_line", "no_place", "subtype",
                       "place_source", "place_ref")
_BACKFILL_KEYS = ("client_id", "date", "title_en", "title_zh", "color", "stops", "invite_text", "contract", "card")
_EDIT_OPS_FIELDS = {
    "set_line": ("stop_id", "her_line"),
    "update_stop": ("stop_id", "time", "title", "address", "lat", "lng", "kind", "no_place", "subtype",
                    "place_source", "place_ref"),
    "add_stop": ("position", "kind", "time", "title", "address", "lat", "lng", "her_line", "no_place", "subtype",
                 "place_source", "place_ref"),
    "remove_stop": ("stop_id",),
    "set_plan": ("title_en", "title_zh", "date", "color"),      # 只限补记的约会(origin=her)
}


def _reject_field(k: str, origin: str, op=None, where: str = "") -> HerEditError:
    if k in _HIS_FIELDS:
        return _he(403, "his_field", f"{where}{config.who(_HIS_FIELDS[k])}（{k}）是{config.him()}写的，原样留着，不能改", op, k)
    if k in _PLAN_FIELDS:
        if origin == "her":
            return _he(400, "plan_field", f"{_PLAN_FIELDS[k]}（{k}）要用 set_plan 改", op, k)
        return _he(403, "his_field", f"{_PLAN_FIELDS[k]}（{k}）是{config.him()}写的，原样留着，不能改", op, k)
    return _he(400, "unknown_field", f"{where}不认识 {k} 这一项", op, k)


def _contract_in(v, op=None):
    if not isinstance(v, list) or not v or len(v) > MAX_CONTRACT:
        raise _he(400, "bad_contract", f"契约书要写 1 到 {MAX_CONTRACT} 条", op, "contract")
    return [_her_txt(x, "contract", "契约书条款", "contract_item", required=True, op=op) for x in v]


def _visible_done(conn, plan_id, now) -> dict:
    """她能动的约会:存在、对她可见(构思中=不存在,同读口 404);取消的不在书架。"""
    st = _load(conn, plan_id) if isinstance(plan_id, int) and not isinstance(plan_id, bool) else None
    if st is None or project(st, now) is None:
        raise _he(404, "not_found", "not found")
    _settle(conn, st, now)
    ph = phase(st["plan"], now)
    if ph != "done":
        raise _he(409, "phase", f"收进纪念盒以后才能改（这次约会现在是{_PHASE_ZH.get(ph, ph)}）")
    return st


def her_backfill(body: dict, *, now: datetime | None = None, path: str | None = None) -> dict:
    """补记一次以前和他的约会:同一笔写完——约会(done、origin=her、全部公开)、站(added_by=her)、
    她没写的 invite/contract/card/quote 各建一条 date_ask、her_backfill 事件、每站排现画。返回她的投影(无标记)。
    client_id 相同 = 同一次「存好」的重发,原样回那一盒,不建第二盒。"""
    if not isinstance(body, dict):
        raise _he(400, "bad_body", "要传一个对象")
    for k in body:
        if k not in _BACKFILL_KEYS:                 # 出现即拒(含空值):不许有被静默忽略的字段
            raise _reject_field(k, "her")
    now = _as_tz(now)
    cid = body.get("client_id")
    if not isinstance(cid, str) or not cid.strip() or len(cid) > 64:
        # 必填:没有它,超时重发就会建出第二盒
        raise _he(400, "bad_client_id", "client_id 必填：每次「存好」生成一个 64 字以内的编号，重发用同一个",
                  field="client_id")
    fld = "date"
    try:
        d = _date_arg(body.get("date"))
        fld = "title_en"
        title = _title_en(body.get("title_en"))
        fld = "title_zh"
        title_zh = _title_zh(body.get("title_zh"))
        fld = "color"
        color = _color_arg(body.get("color"))
    except DateError as e:
        raise _from_date_error(e, field=fld) from None
    if date.fromisoformat(d) >= now.date():
        raise _he(400, "not_past", f"补记的约会日期要早于今天（今天是 {_md(now.date())}）", field="date")
    stops_in = body.get("stops")
    if not isinstance(stops_in, list) or not stops_in:
        raise _he(400, "no_stops", "至少写一站", field="stops")
    if len(stops_in) > MAX_STOPS:
        raise _he(400, "too_many_stops", f"最多 {MAX_STOPS} 站，现在是 {len(stops_in)} 站", field="stops")
    stops = []
    for i, x in enumerate(stops_in, 1):
        where = f"第 {i} 站的"
        if not isinstance(x, dict):
            raise _he(400, "bad_stop", f"第 {i} 站要是对象", field="stops")
        for k in x:
            if k not in _BACKFILL_STOP_KEYS:
                raise _reject_field(k, "her", where=where)
        s = {"kind": _her_kind(x.get("kind")),
             "time": _her_hm(x.get("time"), "time", f"{where}时间"),
             "title": _her_txt(x.get("title"), "title", f"{where}地名", "title", required=True),
             "address": _her_txt(x.get("address"), "address", f"{where}地址", "address"),
             "lat": _her_coord(x.get("lat"), "lat"), "lng": _her_coord(x.get("lng"), "lng"),
             "her_line": _her_txt(x.get("her_line"), "her_line", f"{where}那一句话", "her_line"),
             "no_place": _her_bool(x.get("no_place"), "no_place"),
             "subtype": _her_subtype(x.get("subtype"))}
        if (s["lat"] is None) != (s["lng"] is None):
            raise _he(400, "bad_coord", f"{where}坐标要纬度经度一起写", field="lat")
        _her_bind_new(s, None, where)
        src, ref = _her_place_src(x, s["lat"], s["lng"], where=where)
        if src and s["no_place"]:
            raise _he(400, "no_place_place", f"{where}「一件事」没有固定地点，不用再传地点", field="place_source")
        s["place_source"] = s["place_ref"] = None
        if src:
            place_store(s, src, ref)
        stops.append(s)
    wrote = {}
    if body.get("invite_text") not in (None, ""):
        wrote["invite"] = _her_txt(body["invite_text"], "invite_text", "迟到的请柬", "invite")
    if body.get("contract") not in (None, [], ""):
        wrote["contract"] = _contract_in(body["contract"])
    if body.get("card") not in (None, ""):
        wrote["card"] = _her_txt(body["card"], "card", "小卡", "card")
    ts = now.timestamp()
    with _tx(path) as conn:
        r = conn.execute("SELECT id FROM date_plans WHERE client_id=?", (cid,)).fetchone()
        if r is not None:
            st = _load(conn, r[0])
            return {**project(st, now), "duplicate": True}
        cur = conn.execute(
            "INSERT INTO date_plans (title_en, title_zh, date, color, status, origin, version, created_at,"
            " updated_at, closed_at, invite_text, contract_json, card_text, written_by_her, client_id)"
            " VALUES (?, ?, ?, ?, 'done', 'her', 1, ?, ?, ?, ?, ?, ?, ?, ?)",
            (title, title_zh, d, color, ts, ts, ts, wrote.get("invite"),
             json.dumps(wrote["contract"], ensure_ascii=False) if "contract" in wrote else None,
             wrote.get("card"), json.dumps(sorted(wrote)) if wrote else None, cid))
        pid = cur.lastrowid
        conn.execute("UPDATE date_plans SET paper_no=? WHERE id=?", (_paper_no(conn, {"id": pid, "date": d}), pid))
        for i, s in enumerate(stops, 1):
            cur = conn.execute(
                "INSERT INTO date_stops (plan_id, ord, kind, time, title, address, lat, lng, her_line,"
                " no_place, subtype, place_source, place_ref, added_by, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'her',?,?)",
                (pid, i, s["kind"], s["time"], s["title"], s["address"], s["lat"], s["lng"],
                 s["her_line"], s["no_place"], s["subtype"], s["place_source"], s["place_ref"], ts, ts))
            if s.get("_coords_cache"):
                _write_coords_cache(conn, pid, cur.lastrowid, s["_coords_cache"], ts)
        conn.execute("INSERT INTO date_reveals (plan_id, stop_id, field_group, revealed_at) VALUES (?, NULL, 'all', ?)",
                     (pid, ts))
        st = _load(conn, pid)
        bad = [b for b in check(st, now)["errors"] if b["code"] in _DONE_ERRORS]
        if bad:
            raise _he(400, bad[0]["code"], bad[0]["text"], field=_ERR_FIELD.get(bad[0]["code"], "stops"))
        for w in ("invite", "contract", "card", "quote"):
            if w not in wrote:
                add_ask(pid, w, conn=conn, now=now)
        _add_event(conn, st, "her_backfill", f"{config.her()}补记了这次约会（{len(stops)} 站）", ts,
                   detail={"stops": len(stops), "wrote": sorted(wrote)})
        _art_hook(conn, pid, now, her=True)
        st = _load(conn, pid)
        return project(st, now)


def _stop_by_id(st: dict, sid, op) -> tuple[int, dict]:
    if isinstance(sid, bool) or not isinstance(sid, int):
        raise _he(400, "bad_stop", "stop_id 要写整数", op, "stop_id")
    for i, s in enumerate(st["stops"], 1):
        if s["id"] == sid:
            return i, s
    raise _he(404, "no_stop", f"没有这一站（stop {sid}）", op, "stop_id")


def _q(v) -> str:
    return f"「{v}」" if v not in (None, "") else "（没写）"


def her_edit(plan_id: int, ops, *, expect_version: int | None = None, now: datetime | None = None,
             path: str | None = None) -> dict:
    """结束后她的编辑(她选 B):给某站写/改/删她的一句话;改任何一站的时间、地名、地址、坐标
    (她补的站还能改种类);补一站;删她自己补的站。他写的字(线索/他的话/小卡/契约书/请柬/那一句话/名字……)一律拒。
    一次可带多项,整笔原子:任一项被拒=整笔不生效,回执说清第几项、哪一项、为什么。每项改动落一条 her_edit 事件(带改前改后)。"""
    if not isinstance(ops, list) or not ops:
        raise _he(400, "bad_ops", "ops 要是非空列表")
    if len(ops) > HER_EDIT_MAX_OPS:
        raise _he(400, "bad_ops", f"一次最多 {HER_EDIT_MAX_OPS} 项")
    with _tx(path) as conn:
        now = _as_tz(now)
        st = _visible_done(conn, plan_id, now)
        origin = st["plan"].get("origin") or HIM
        if expect_version is not None and expect_version != st["plan"]["version"]:
            raise _he(409, "version", "这次约会刚被改过，刷新看最新的再改")
        old, new = copy.deepcopy(st), copy.deepcopy(st)
        ts = now.timestamp()
        evs: list[tuple[str, dict, dict]] = []        # (文字, 站对象(新站落库后才有真 id), detail)
        for i, o in enumerate(ops):
            if not isinstance(o, dict):
                raise _he(400, "bad_op", "每一项要是对象", i)
            name = o.get("op")
            if not isinstance(name, str) or name not in _EDIT_OPS_FIELDS:
                raise _he(400, "bad_op", "op 只能是 " + " / ".join(_EDIT_OPS_FIELDS), i, "op")
            if name == "set_plan" and origin != "her":
                raise _he(403, "his_field", f"名字、日期、颜色是{config.him()}写的，原样留着，不能改", i, "op")
            for k in o:                                # 出现即拒(含空值):受保护字段不许被静默忽略
                if k != "op" and k not in _EDIT_OPS_FIELDS[name]:
                    raise _reject_field(k, origin, i)
            if name == "set_plan":                    # 补记的约会整盒是她写的:名字/日期/颜色可改
                p = new["plan"]
                if not any(k in o for k in _PLAN_FIELDS):
                    raise _he(400, "nothing", f"第 {i + 1} 项没有要改的（title_en / title_zh / date / color）", i)
                try:
                    if "title_en" in o or "title_zh" in o:
                        before_full = full_name(p)
                        before = {"title_en": p["title_en"], "title_zh": p.get("title_zh") or ""}
                        fld = "title_en"
                        en = _title_en(o["title_en"]) if "title_en" in o else p["title_en"]
                        fld = "title_zh"
                        zh = _title_zh(o["title_zh"]) if "title_zh" in o else (p.get("title_zh") or "")
                        if (en, zh) != (before["title_en"], before["title_zh"]):
                            p["title_en"], p["title_zh"] = en, zh
                            if en == before["title_en"]:      # 只动了中文名(title_zh "" = 删掉中文名,改后写「无」)
                                bz, az = before["title_zh"], zh
                                txt = f"{config.her()}把中文名从{f'「{bz}」' if bz else '无'}改成{f'「{az}」' if az else '无'}"
                            else:
                                txt = f"{config.her()}把名字从「{before_full}」改成「{full_name(p)}」"
                            evs.append((txt, None,
                                        {"op": "set_plan", "field": "title", "before": before,
                                         "after": {"title_en": en, "title_zh": zh}}))
                    if "date" in o:
                        fld = "date"
                        val = _date_arg(o["date"])
                        if date.fromisoformat(val) >= now.date():
                            raise _he(400, "not_past", f"补记的约会日期要早于今天（今天是 {_md(now.date())}）", i, "date")
                        if val != p["date"]:
                            evs.append((f"{config.her()}把日期从 {_md(p['date'])} 改成 {_md(val)}", None,
                                        {"op": "set_plan", "field": "date", "before": p["date"], "after": val}))
                            p["date"] = val
                            p["paper_no"] = _paper_no(conn, p)     # 纸面编号跟着日期(她的盒子,没寄出过)
                    if "color" in o:
                        fld = "color"
                        val = _color_arg(o["color"])
                        if val != p["color"]:
                            evs.append((f"{config.her()}把颜色从 {COLORS[p['color']]} 改成 {COLORS[val]}", None,
                                        {"op": "set_plan", "field": "color", "before": p["color"], "after": val}))
                            p["color"] = val
                except DateError as e:
                    raise _from_date_error(e, i, fld) from None
            elif name == "set_line":
                n, s = _stop_by_id(new, o.get("stop_id"), i)
                line = _her_txt(o.get("her_line"), "her_line", "那一句话", "her_line", op=i)
                before = s.get("her_line")
                if line == before:
                    continue
                s["her_line"] = line
                txt = (f"{config.her()}给第 {n} 站加了一句话" if not before else
                       f"{config.her()}删了第 {n} 站{config.her()}写的那句话" if not line else f"{config.her()}改了第 {n} 站{config.her()}写的那句话")
                evs.append((txt, s, {"op": "set_line", "n": n, "field": "her_line", "before": before, "after": line}))
            elif name == "update_stop":
                n, s = _stop_by_id(new, o.get("stop_id"), i)
                ch: list[tuple[str, object, object]] = []
                mine = her_can_edit_kind(s)
                new_kind = None
                for fld_ in ("kind", "subtype"):
                    if fld_ in o and not mine:
                        raise _he(403, "his_field", f"第 {n} 站的{'种类' if fld_ == 'kind' else '细类'}是{config.him()}定的，"
                                  "不能改（时间、地名、地址、位置可以改）", i, fld_)
                if "kind" in o:
                    new_kind = _her_kind(o["kind"], i)
                    ch.append(("kind", s.get("kind"), new_kind))
                if "subtype" in o:
                    ch.append(("subtype", s.get("subtype"), _her_subtype(o["subtype"], i)))
                if "time" in o:
                    ch.append(("time", s.get("time"), _her_hm(o["time"], "time", "时间", i)))
                if "title" in o:
                    ch.append(("title", s.get("title"), _her_txt(o["title"], "title", "地名", "title", True, i)))
                if "address" in o:
                    ch.append(("address", s.get("address"), _her_txt(o["address"], "address", "地址", "address", op=i)))
                if "lat" in o or "lng" in o:
                    la = _her_coord(o.get("lat"), "lat", i) if "lat" in o else s.get("lat")
                    ln = _her_coord(o.get("lng"), "lng", i) if "lng" in o else s.get("lng")
                    if (la is None) != (ln is None):
                        raise _he(400, "bad_coord", "坐标要纬度经度一起写", i, "lat")
                    # 坐标从地点搜索结果来(带 place_source)=按存储规则裁剪;没带=她手写的,照存
                    src, ref = _her_place_src(o, la, ln, i)
                    tmp = {"lat": la, "lng": ln, "place_source": None, "place_ref": None, "_coords_cache": None}
                    if src:
                        place_store(tmp, src, ref)
                    ch.append(("coord", [s.get("lat"), s.get("lng")], [tmp["lat"], tmp["lng"]]))
                    ch.append(("place", [s.get("place_source"), s.get("place_ref")],
                               [tmp["place_source"], tmp["place_ref"]]))
                    s["_coords_cache"] = tmp["_coords_cache"]
                elif "place_source" in o or "place_ref" in o:
                    _her_place_src(o, None, None, i)        # 没带坐标:报「要连坐标一起传」或来源不对
                #  一件事、没有固定地点(页面只传 no_place):选「一件事」=原来的地址坐标自动清掉(各落一条改前改后);
                # 再选一个有地址/坐标的地点=自动回到有固定地点;同一项里「一件事」和地址/坐标一起传=拒
                was_np = is_no_place(s)
                #  一件事 ⇔ 没有固定地点:她把自己补的站种类选成 moment = 选了「一件事」;从一件事改成别的种类要同时选地点
                if new_kind == MOMENT and s.get("kind") != MOMENT:
                    _remember_before_moment(s, s)      # 内存里这一刻的种类/细类(同一笔前面的 op 已经改到 s 上)
                if new_kind is not None and new_kind != MOMENT and s.get("kind") == MOMENT:
                    _forget_before_moment(s)           # 显式选了别的种类离开一件事
                if new_kind == MOMENT:
                    if "no_place" in o and not o["no_place"]:
                        raise _he(400, "moment_place", "「一件事」没有固定地点，no_place 不能是 false", i, "no_place")
                    o = {**o, "no_place": True}
                elif new_kind is not None and was_np:
                    if o.get("no_place"):
                        raise _he(400, "moment_kind", "选了「一件事」种类就要是 moment", i, "kind")
                    if not any(_gives_place(c) for c in ch):
                        raise _he(400, "moment_needs_place", f"第 {n} 站从「一件事」改成别的种类，要同时选一个地点"
                                  "（address 或 lat+lng）", i, "kind")
                elif new_kind is None and was_np and s.get("kind") == MOMENT and not o.get("no_place") \
                        and any(_gives_place(c) for c in ch):
                    #  往返:她把站设成「一件事」后只传地址/坐标恢复地点 → 回到变成一件事之前记下的种类与细类
                    # (kind_before_moment / subtype_before_moment);记录是空的 → 400 说清,不猜默认种类
                    prev_kind, prev_sub = s.get("kind_before_moment"), s.get("subtype_before_moment")
                    if prev_kind not in KINDS or prev_kind == MOMENT:
                        raise _he(400, "moment_kind", f"第 {n} 站要恢复地点请同时选种类（kind）", i, "kind")
                    new_kind = prev_kind
                    ch.append(("kind", MOMENT, prev_kind))
                    if prev_sub and "subtype" not in o:
                        ch.append(("subtype", s.get("subtype"), prev_sub))
                    _forget_before_moment(s)
                if "no_place" in o:
                    np_ = bool(_her_bool(o["no_place"], "no_place", i))
                    if np_ and mine and new_kind is None and s.get("kind") != MOMENT:
                        _remember_before_moment(s, s)
                        ch.append(("kind", s.get("kind"), MOMENT))   # 她自己补的站:选「一件事」= 种类也是一件事
                        new_kind = MOMENT
                    if np_ and (s.get("subtype") or any(c[0] == "subtype" and c[2] for c in ch)):
                        if any(c[0] == "subtype" and c[2] for c in ch):
                            raise _he(400, "moment_subtype", "「一件事」不分细类，subtype 要空着", i, "subtype")
                        if mine:
                            ch.append(("subtype", s.get("subtype"), None))   # 选一件事:原来的细类一起清掉(落事件)
                    both = [k for k in ("address", "lat", "lng", "place_source", "place_ref") if k in o]
                    if np_ and both:
                        raise _he(400, "no_place_place", "选了「一件事、没有固定地点」就不用再传地址和坐标，原来的会自动清掉",
                                  i, both[0])
                    if np_:
                        if s.get("address"):
                            ch.append(("address", s.get("address"), None))
                        if s.get("walk_path"):
                            ch.append(("walk_path", "有散步路线", "无"))
                        if s.get("lat") is not None or s.get("lng") is not None:
                            ch.append(("coord", [s.get("lat"), s.get("lng")], [None, None]))
                        if s.get("place_source") or s.get("place_ref"):
                            ch.append(("place", [s.get("place_source"), s.get("place_ref")], [None, None]))
                    ch.append(("no_place", was_np, np_))
                elif was_np and any(_gives_place(c) for c in ch):
                    ch.append(("no_place", True, False))
                if not ch:
                    raise _he(400, "nothing", f"第 {i + 1} 项没有要改的（time / title / address / lat+lng / no_place / kind / subtype）", i)
                touched = False
                moved = any(c[0] in ("coord", "address", "no_place") and c[1] != c[2] for c in ch)
                for f, a, b in ch:
                    if a == b:
                        continue
                    touched = True
                    if f == "place":                   # 来源/地点 ID:位置的一部分,别的位置改动已落事件就不另落
                        s["place_source"], s["place_ref"] = b
                        if moved:
                            continue
                        txt = f"{config.her()}改了第 {n} 站的位置"
                    elif f == "coord":
                        s["lat"], s["lng"] = b
                        txt = f"{config.her()}改了第 {n} 站的位置"
                    elif f == "walk_path":
                        s["walk_path"] = None
                        txt = f"{config.her()}清掉了第 {n} 站的散步路线"
                    elif f == "no_place":
                        s["no_place"] = 1 if b else 0
                        txt = f"{config.her()}把第 {n} 站改成了一件事、没有固定地点" if b else f"{config.her()}给第 {n} 站改回了固定地点"
                    else:
                        s[f] = b
                        txt = {"kind": f"{config.her()}把第 {n} 站种类从 {KINDS.get(a, '（没写）')} 改成 {KINDS.get(b)}",
                               "subtype": (f"{config.her()}把第 {n} 站细类从{_q(a)}改成{_q(b)}" if a and b else
                                           f"{config.her()}给第 {n} 站写了细类{_q(b)}" if b else f"{config.her()}删了第 {n} 站的细类"),
                               "time": f"{config.her()}把第 {n} 站时间从 {a or '（没写）'} 改成 {b or '（没写）'}",
                               "title": f"{config.her()}把第 {n} 站地名从{_q(a)}改成{_q(b)}",
                               "address": (f"{config.her()}把第 {n} 站地址从{_q(a)}改成{_q(b)}" if a and b else
                                           f"{config.her()}给第 {n} 站补了地址{_q(b)}" if b else f"{config.her()}删了第 {n} 站的地址")}[f]
                    evs.append((txt, s, {"op": "update_stop", "n": n, "field": f, "before": a, "after": b}))
                if touched:
                    s["edited_by_her_at"] = ts
            elif name == "add_stop":
                if len(new["stops"]) >= MAX_STOPS:
                    raise _he(409, "too_many_stops", f"最多 {MAX_STOPS} 站，已经满了", i)
                pos = o.get("position")
                cnt = len(new["stops"])
                if pos in (None, ""):
                    pos = cnt + 1
                if isinstance(pos, bool) or not isinstance(pos, int) or not 1 <= pos <= cnt + 1:
                    raise _he(400, "bad_position", f"position 只能是 1 到 {cnt + 1}", i, "position")
                s = {k: None for k in _STOP_FIELDS}
                s.update({"id": next(_tmp_ids), "opened_early_at": None, "added_by": "her",
                          "kind": _her_kind(o.get("kind"), i),
                          "time": _her_hm(o.get("time"), "time", "时间", i),
                          "title": _her_txt(o.get("title"), "title", "地名", "title", True, i),
                          "address": _her_txt(o.get("address"), "address", "地址", "address", op=i),
                          "lat": _her_coord(o.get("lat"), "lat", i), "lng": _her_coord(o.get("lng"), "lng", i),
                          "her_line": _her_txt(o.get("her_line"), "her_line", "那一句话", "her_line", op=i),
                          "edited_by_her_at": None, "no_place": _her_bool(o.get("no_place"), "no_place", i),
                          "subtype": _her_subtype(o.get("subtype"), i)})
                if (s["lat"] is None) != (s["lng"] is None):
                    raise _he(400, "bad_coord", "坐标要纬度经度一起写", i, "lat")
                _her_bind_new(s, i, "")
                src, ref = _her_place_src(o, s["lat"], s["lng"], i)
                if src and s["no_place"]:
                    raise _he(400, "no_place_place", "「一件事」没有固定地点，不用再传地点", i, "place_source")
                if src:
                    place_store(s, src, ref)
                new["stops"].insert(pos - 1, s)
                evs.append((f"{config.her()}补了一站：第 {pos} 站{_q(s['title'])}" + (f" {s['time']}" if s["time"] else ""), s,
                            {"op": "add_stop", "n": pos, "title": s["title"], "time": s["time"], "kind": s["kind"]}))
            else:   # remove_stop
                n, s = _stop_by_id(new, o.get("stop_id"), i)
                if s.get("added_by") != "her":
                    raise _he(403, "his_stop", f"第 {n} 站是{config.him()}写的，不能删（时间、地名、地址、位置可以改）", i, "stop_id")
                new["stops"] = [x for x in new["stops"] if x is not s]
                evs.append((f"{config.her()}删了{config.her()}补的第 {n} 站{_q(s.get('title'))}", None,
                            {"op": "remove_stop", "n": n, "stop_id": s["id"], "title": s.get("title"),
                             "time": s.get("time")}))
        if not evs:
            return project(st, now)                   # 全部和原来一样:不动版本、不落事件
        bad = [b for b in check(new, now)["errors"] if b["code"] in _DONE_ERRORS]
        if bad:
            raise _he(400, bad[0]["code"], bad[0]["text"], field=_ERR_FIELD.get(bad[0]["code"]))
        new["plan"]["version"] = old["plan"]["version"] + 1
        _persist(conn, old, new, ts)
        for txt, s, det in evs:
            sid = s["id"] if s is not None else det.get("stop_id")
            _add_event(conn, new, "her_edit", txt, ts, None, detail={**det, "stop_id": sid})
        _art_hook(conn, plan_id, now, her=True)       # 种类/地名改了按签名重排;补的站排上;删的站撤掉
        return project(_load(conn, plan_id), now)


_UNSET = object()      # her_write:区分「没传」和「显式传了 null」(放错位置的字段只要出现就拒)


def her_write(plan_id: int, what, text=_UNSET, items=_UNSET, *, now: datetime | None = None,
              path: str | None = None) -> dict:
    """她先写三样里他还没写的一样(她选 C:默认请他写,她也可以先写)。请柬只有补记的约会有。
    他已经写了 = 409「他已经写了」;她自己写过的可以改。写了即完成对应的 ask、落 her_wrote 事件。"""
    if what not in HER_WRITE_KINDS:
        raise _he(400, "bad_what", "what 只能是 invite / contract / card", field="what")
    if what == "contract" and text is not _UNSET:   # 写错位置的字段出现即拒(含 null),不许被静默丢
        raise _he(400, "bad_field", "契约书写在 items（每条一行），不用 text", field="text")
    if what != "contract" and items is not _UNSET:
        raise _he(400, "bad_field", f"{ASK_ZH[what]}写在 text，不用 items", field="items")
    text = None if text is _UNSET else text
    items = None if items is _UNSET else items
    with _tx(path) as conn:
        now = _as_tz(now)
        st = _visible_done(conn, plan_id, now)
        p = st["plan"]
        if what == "invite" and p.get("origin") != "her":
            raise _he(409, "not_backfill", f"这次约会是{config.him()}写的，请柬已经有了，不用另写", field="what")
        cur = _late_value(p, what)
        mine = what in p["her_wrote"]
        if cur and not mine:
            raise _he(409, "he_wrote", f"{config.him()}已经写了", field=what)
        if what == "contract":
            val = _contract_in(items)
            col, dbv = "contract_json", json.dumps(val, ensure_ascii=False)
        else:
            lk = "invite" if what == "invite" else "card"
            val = _her_txt(text, what, ASK_ZH[what], lk, required=True)
            col, dbv = ("invite_text" if what == "invite" else "card_text"), val
        if cur == val:
            return project(st, now)
        ts = now.timestamp()
        hw = sorted(p["her_wrote"] | {what})
        conn.execute(f"UPDATE date_plans SET {col}=?, written_by_her=?, version=version+1 WHERE id=?",
                     (dbv, json.dumps(hw), plan_id))
        complete_ask(plan_id, what, conn=conn, now=now)
        _add_event(conn, st, "her_wrote", f"{config.her()}{config.who('改了她自己写的') if cur else '自己写了'}{ASK_ZH[what]}", ts,
                   detail={"what": what})
        return project(_load(conn, plan_id), now)


def her_open(plan_id: int, *, now: datetime | None = None, path: str | None = None) -> dict | None:
    """她在页面按「拆开」。只记第一次的时刻(重复调用=原样返回,幂等);
    只认已寄出/当天/已结束;构思中/不存在/取消 → None(读口回 404,和不存在一样)。不动版本、不落事件。
    拆开=读过信:同一事务里把这次约会的信封事件(OPENED_BY_ENVELOPE)标为已读(只写还没读的,重复拆开不改时刻);
    电报等其他事件不动。read_at 只管她的未读,AI 待办(/context)与事件 webhook / 推送不看它。"""
    with _tx(path) as conn:
        now = _as_tz(now)
        st = _load(conn, plan_id) if isinstance(plan_id, int) and not isinstance(plan_id, bool) else None
        if st is None:
            return None
        _settle(conn, st, now)
        if phase(st["plan"], now) not in ("sent", "live", "done"):
            return None
        if st["plan"].get("her_opened_at") is None:
            conn.execute("UPDATE date_plans SET her_opened_at=? WHERE id=? AND her_opened_at IS NULL",
                         (now.timestamp(), plan_id))
            st = _load(conn, plan_id)
        kinds = ",".join("?" * len(OPENED_BY_ENVELOPE))
        cur = conn.execute(f"UPDATE date_events SET read_at=? WHERE plan_id=? AND read_at IS NULL AND kind IN ({kinds})",
                           (now.timestamp(), plan_id, *OPENED_BY_ENVELOPE))
        if cur.rowcount:
            st = _load(conn, plan_id)
        return project(st, now)


def her_set_letter(plan_id: int, text, *, now: datetime | None = None, path: str | None = None) -> dict:
    """她写/改/删这次约会的信。只认 status=done;空串=删掉她的信——若「回信」
    ask 还没完成就一并撤(他已经写好的回信不受影响,原样留着);第一次写信建 reply ask
    (与其它 ask 同受「请写」按钮门控:origin=her 的约会要她按「请他补寄」才进「他在等你写」清单)。"""
    with _tx(path) as conn:
        now = _as_tz(now)
        st = _visible_done(conn, plan_id, now)
        if text is None:
            text = ""
        if not isinstance(text, str):
            raise _he(400, "bad_text", "text 要是文字", field="text")
        t = text.strip()
        if len(t) > LIMITS["letter"]:
            raise _he(400, "long_letter", f"信最多 {LIMITS['letter']} 个字，现在 {len(t)} 个字", field="text")
        ts = now.timestamp()
        cur = conn.execute("SELECT text FROM date_letters WHERE plan_id=? AND author='her'",
                           (plan_id,)).fetchone()
        if not t:
            if cur is None:
                return project(st, now)             # 本来就没有信,删=无操作
            conn.execute("DELETE FROM date_letters WHERE plan_id=? AND author='her'", (plan_id,))
            conn.execute("DELETE FROM date_asks WHERE plan_id=? AND what='reply' AND done_at IS NULL",
                        (plan_id,))
            _add_event(conn, st, "her_wrote", f"{config.her()}删了{config.her()}写的信", ts, detail={"what": "letter", "action": "delete"})
            return project(_load(conn, plan_id), now)
        if cur is not None and cur["text"] == t:
            return project(st, now)                 # 没变:不动版本、不落事件
        is_new = cur is None
        conn.execute(
            "INSERT INTO date_letters (plan_id, author, text, created_at, updated_at) VALUES (?, 'her', ?, ?, ?)"
            " ON CONFLICT(plan_id, author) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at",
            (plan_id, t, ts, ts))
        if is_new:
            add_ask(plan_id, "reply", conn=conn, now=now)
        _add_event(conn, st, "her_wrote", f"{config.her()}写了信" if is_new else f"{config.her()}改了{config.her()}写的信", ts,
                   detail={"what": "letter", "action": "create" if is_new else "update"})
        return project(_load(conn, plan_id), now)


def her_request_write(plan_id: int, client_id, *, now: datetime | None = None, path: str | None = None) -> dict:
    """她按「请他补写」(没按之前不提醒他;按一次 = 这一盒还没写的全部一起请,
    并立刻排一轮叫醒)。client_id 防连点重发:同号重放 = 原样回当前投影,不二次处理。
    只认 status=done 的约会;没有未写的 ask → 409「他都写完了」。
    之前请过、那一轮叫醒已经 sent 的不重请;落了终态但不是 sent(not_sent/expired/abandoned/
    cancelled/unknown——没确定送到)的允许重新排队。"""
    if not isinstance(client_id, str) or not client_id.strip() or len(client_id) > 64:
        raise _he(400, "bad_client_id", "client_id 必填：每次按「请写」生成一个 64 字以内的编号，重发用同一个",
                  field="client_id")
    from . import inbox                             # 这里才用:inbox 依赖本模块
    with _tx(path) as conn:
        now = _as_tz(now)
        st = _visible_done(conn, plan_id, now)        # 先判约会可见、再认重放,最后才看通道
        ts = now.timestamp()
        prev = conn.execute("SELECT client_id FROM date_write_requests WHERE plan_id=?", (plan_id,)).fetchone()
        if prev is not None and prev[0] == client_id:
            return project(st, now)
        if not inbox.write_request_available():
            # 三条路(拉/注入/推)一条都没配好:没人会处理,不收(页面本来就不露这个按钮)
            raise _he(409, "no_ai_channel", f"还没有接好通知{config.him()}的路，请{config.him()}补写的请求没人收得到")
        rows = conn.execute(
            "SELECT what, requested_at, request_woke_at, request_wake_result FROM date_asks"
            " WHERE plan_id=? AND done_at IS NULL", (plan_id,)).fetchall()
        if not rows:
            raise _he(409, "nothing_to_write", f"{config.him()}都写完了")
        touch = sorted((r[0] for r in rows if r[1] is None or (r[2] is not None and r[3] != "sent")),
                      key=ASK_KINDS.index)
        if touch:
            conn.executemany(
                "UPDATE date_asks SET requested_at=?, request_claimed_at=NULL, request_woke_at=NULL,"
                " request_wake_result=NULL WHERE plan_id=? AND what=?",
                [(ts, plan_id, w) for w in touch])
            _add_event(conn, st, "her_request_write", f"{config.her()}请你补写：{'、'.join(ASK_ZH[w] for w in touch)}", ts,
                       detail={"whats": touch})
        conn.execute(
            "INSERT INTO date_write_requests (plan_id, client_id, created_at) VALUES (?, ?, ?)"
            " ON CONFLICT(plan_id) DO UPDATE SET client_id=excluded.client_id, created_at=excluded.created_at",
            (plan_id, client_id, ts))
        return project(_load(conn, plan_id), now)


# ── 他那一侧:书架 / 她的新动作 / 她在等你写(约会账与工具共用)──────────────────────────────
def her_events_for_him(conn: sqlite3.Connection, plan_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        f"SELECT id, kind, text, created_at, detail_json FROM date_events WHERE plan_id=? AND kind IN {_HER_KINDS_SQL}"
        " ORDER BY id", (plan_id,))]


def mark_her_seen(plan_id: int, upto: int | None, *, path: str | None = None) -> None:
    """他 date_view 打开过这次约会:她的动作看到第几条(约会账只提之后的)。只往前走。"""
    if not upto:
        return
    conn = _connect(path)
    try:
        conn.execute("UPDATE date_plans SET her_seen_upto=? WHERE id=? AND IFNULL(her_seen_upto, 0) < ?",
                     (upto, plan_id, upto))
    finally:
        conn.close()


def shelf_digest(*, now: datetime | None = None, path: str | None = None) -> dict:
    """他读的书架摘要:shelf=已结束的约会(新→旧);news=[(plan, 她上次被他看过之后的动作)];asks=[(plan, 还没写的)]。"""
    now = _as_tz(now)
    conn = _connect(path)
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, title_en, title_zh, date, origin, her_seen_upto FROM date_plans WHERE status='done'"
            " ORDER BY date DESC, id DESC")]
        news, asks = [], []
        for p in sorted(rows, key=lambda x: (x["date"], x["id"])):
            evs = [e for e in her_events_for_him(conn, p["id"]) if e["id"] > (p.get("her_seen_upto") or 0)]
            if evs:
                news.append((p, evs))
            a = open_asks(conn, p["id"], p.get("origin"))
            if a:
                asks.append((p, a))
    finally:
        conn.close()
    return {"shelf": rows, "news": news, "asks": asks}
