"""The AI's date tools (MCP): date_open / date_view / date_route / date_edit / date_send / date_live /
date_close, plus date_inbox (the AI to-do list) and date_memory (finished dates; event card follow-up, memory.py).

All rules live in the engine (plan.py); this module only maps arguments → engine and engine results → the
text the AI reads (itinerary / list / why it failed), request_id idempotency, and date_route.

- Success receipt = one result line + this date's itinerary; failure = 「没改成：…」/「没寄出：还缺 N 项——…」
  + the current itinerary. **If the write committed but rendering failed, it is still reported as success**
  (with a note) — never is_error, or the AI would do it again.
- request_id: checked and recorded by the engine inside the same write transaction; same id again = "already
  done" + latest detail, same id with different arguments = refused.
- Every receipt ends with the open AI to-do count (inbox.py: the "pull" path).
- date_route only looks things up (walking minutes through the walk port — by default the local road network —
  and the places port for names);
  it never writes a date.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import date as _date, datetime

from . import config, inbox, memory, ports, scheduler
from . import plan as dp

log = logging.getLogger("ephemera_date.tools")

TOOL_OPEN = "date_open"
TOOL_VIEW = "date_view"
TOOL_ROUTE = "date_route"
TOOL_EDIT = "date_edit"
TOOL_SEND = "date_send"
TOOL_LIVE = "date_live"
TOOL_CLOSE = "date_close"
TOOL_INBOX = "date_inbox"
TOOL_MEMORY = "date_memory"
TOOLS = (TOOL_OPEN, TOOL_VIEW, TOOL_ROUTE, TOOL_EDIT, TOOL_SEND, TOOL_LIVE, TOOL_CLOSE, TOOL_INBOX, TOOL_MEMORY)

# ── 工具说明 ────────────────────────────────────────────────────────────────────────
# 原句保留;只把称呼换成占位 {her} / {him}(EPHEMERA_HER / EPHEMERA_HIM,默认「她」「他」),时区换成 {tz}。
# 句子是逐字定过的:改字前先找作者过目。
DESC = {
    TOOL_OPEN: "开一个新的约会计划，状态是「构思中」。构思中{her}能看到有一场约会在准备、哪天、准备到哪了（几站、各部分写没写、"
               "还缺几样、你上次动笔的时间），看不到名字、颜色和任何内容；{her}可以给你留一句话。需要：title_en（英文名，两行用 \\n 分开）、"
               "date（YYYY-MM-DD，{tz} 时间）、color（blush 浅粉 / rose 粉 / cream 奶白 / sky 蓝 / berry 深玫红）。"
               "同时进行中的约会最多 3 个。返回约会编号和详情。"
               "约会可以再起一个中文名 title_zh（可选），在{her}那边显示成英文名下面的小字；英文名必写。"
               "可选 open_itinerary（默认 false）：true=不藏行程，寄出后{her}拆开请柬就能看到全部站的地点、时间、"
               "线索、怎么去。寄出后不能再改。",
    TOOL_VIEW: "不带 plan：列出所有进行中的约会，每个一行。带 plan：这个约会的完整详情，包括每一站、每段路、"
               "准备清单、契约书和小卡、电报、{her}现在能看到什么、还缺什么、你上次留的下一步。"
               "不带 plan 时也列书架（已结束的约会）；已结束的约会也能打开，每段标着是你写的、{her}补记的还是{her}后来加的。",
    TOOL_ROUTE: "查路，不写进约会。mode=walk：查两地之间步行大约几分钟、多远。"
                "电车的线路、换乘、时间按你知道的写。确认后用 date_edit 的 set_leg 写进去。",
    TOOL_EDIT: "写或改一个约会，op 选一种：set_basic 改名字、日期、颜色、是否不藏行程（open_itinerary，只能在寄出前改）；"
               "add_stop / update_stop / remove_stop / move_stop 管站；"
               "set_leg / remove_leg 管路段（通往某一站怎么走）；set_prep 准备清单；set_contract 契约书；set_card 限定小卡；"
               "cancel 取消已寄出的约会，必须写原因，会作为电报发给{her}；delete_plan 删除还在构思中的约会。"
               "站 = 你们会停下来、在那里待一段时间的地方，集合点也算一站。路段 = 两站之间怎么移动，"
               "中途换乘的车站写在路段里，不算一站。可以附 next，给下次的自己留一句下一步。"
               "寄出后改了{her}能看到的内容，系统会自动发电报告诉{her}。一次操作失败就整笔不生效，回执会写清原因。"
               "{art}"
               "已结束的约会只补写没写的：set_invite 迟到的请柬（限{her}补记的）、set_contract、set_card、"
               "set_quote 那一句话（写 text）、update_stop 只写 note。"
               "write_reply 回信{her}写的信（只能在约会结束后、{her}已经写了信才能用，text=回信正文；写好的回信{him}能一直改）。"
               "迟到的请柬：这次约会已经发生过，是{her}后来补记的；请柬写成寄往那一天的、迟到的邀请。"
               "一站也可以是一件事、没有固定地点（no_place）：比如一起买一束花。这种站不填地址和坐标，不进地图、不算路段，时间照写，到点照样公开给{her}。"
               "kind 是大类（19 种，见枚举）；subtype 是细类（可选，可以用该大类的细类之一，也可以自己写，12 字以内）；kind=moment 表示一件事，没有固定地点，不写 subtype。"
               "dinner=吃饭，{her}那边按这一站的 time 显示「午餐」（16:30 前）或「晚餐」（16:30 起）。",
    TOOL_SEND: "寄出邀请。寄出前会检查必填项，缺什么会列出来，不会寄。寄出后{her}收到信封，能看到名字、日期、准备清单，"
               "以及到了公开时间的内容。",
    TOOL_LIVE: "约会当天用。op=open_stop：提前公开某一站；op=telegram：给{her}发一封电报，{her}马上能看到；"
               "op=shift：从某一站起，后面的时间整体推后或提前 N 分钟，会自动发电报告诉{her}。"
               "op=skip：跳过某一站（{her}看到过的也行），reason 写原因（必写），那一站留在记录里标「跳过了」，"
               "后面的站可以往前挪；op=unskip 撤回。",
    TOOL_CLOSE: "结束约会，写下那一句话（quote）。结束后全部内容对{her}公开，这个约会收进纪念盒。",
    # 新增(开源版):AI 待办通道的「拉」
    TOOL_INBOX: "约会待办：到点的约会提醒、{her}请你补写的东西。op=list（默认）列出还没做完的待办，只看不领；"
                "op=claim 带 ids 领取（认的是这一次连接；领取后 30 分钟内别的连接领不走，过时自动放回）；"
                "op=done 带 ids 确认做完（要先领取）；op=release 带 ids 放回。client 可选，只用来显示你是谁。"
                "每个约会工具的回执末尾都写着现在有几件待办。",
    # 新增(开源版):查过往约会 + 事件卡「后续」(memory.py)
    TOOL_MEMORY: "查已经结束的约会（进行中和构思中的不在这里，用 date_view）。op=find（默认）：按 name（约会名）、"
                 "place（站名或地址）、from / to（日期 YYYY-MM-DD，含当天）查，可以组合；不带条件从最近的列起；"
                 "带 plan 只看这一次的全文。{followup}",
}
# 只在配置了生成图接口时才说(没配时这句话不成立:{her}那边一直是固定画)
ART_SENTENCE = "站可以写 art_hint（画面描述，40 字以内），{her}那边这一站的小画会照着现画；构思中只画写了它的站，寄出后每站都画。"


# 只在配置了事件卡目录(EPHEMERA_CARDS_DIR)时才说
FOLLOWUP_SENTENCE = ("op=followup 带 plan 和 text：写这次约会事件卡的「后续」段（约会之后发生的、和它有关的事，"
                     f"{memory.FOLLOWUP_MAX} 字以内），整段替换。")


def desc(name: str) -> str:
    text = DESC[name].replace("{art}", ART_SENTENCE if dp.art_enabled() else "")
    text = text.replace("{followup}", FOLLOWUP_SENTENCE if config.cards_dir() is not None else "")
    return (text.replace("{her}", config.her()).replace("{him}", config.him())
            .replace("{tz}", config.tz_name()))


# ── schema(字段语义只写边界;站/路段一律用详情里标的 [stop N] 稳定编号)──────────────────
# 取值有限的字段(op、颜色、路段方式与来源、准备清单的分区)一律写 enum,取值直接来自引擎的常量;
# set_prep 的 items 写成对象 schema。其余嵌套结构只写一行字段提示,不展开成子 schema。
_S, _I, _B = {"type": "string"}, {"type": "integer"}, {"type": "boolean"}
_COMMON_W = {"next": _S, "expect_version": _I, "request_id": _S}
_LEG_F = {
    "mode": {"type": "string", "enum": list(dp.LEG_MODES)},
    "depart_time": _S, "arrive_time": _S, "minutes": _I, "summary": _S,
    "steps": {"type": "array", "description": "[{line,direction,board,alight,stops,depart,arrive}]"},
    "fare": _I, "needs_ticket": _B, "ticket_note": _S,
    "source": {"type": "string", "enum": list(dp.LEG_SOURCES)}, "official_url": _S,
}
def _d(desc: str) -> dict:
    return {"type": "string", "description": desc}


# schema 是各 op 字段的并集;站的 title/address/clue 各写一句归属,其余靠写错时的回执教。
# 各 op 真正认哪些字段=下方 _OP_FIELDS。
_STOP_F = {
    "kind": {"type": "string", "enum": list(dp.KINDS)}, "subtype": _S, "time": _S, "stay_until": _S,
    "title": _d("站的地点名"), "address": _d("站的地址"),
    "lat": {"type": "number"}, "lng": {"type": "number"}, "reveal_at": _S, "clue": _d("站的线索"),
    "note": _S, "how_to_get": _S, "art_hint": _S, "no_place": _B,
    "walk_path": {"type": "array", "description": "[[lat,lng]]"},
}


def _obj(props: dict, required: list[str] | None = None) -> dict:
    o = {"type": "object", "properties": props}
    if required:
        o["required"] = required
    return o


def tool_schemas() -> list[dict]:
    def t(name, schema):
        return {"name": name, "description": desc(name), "input_schema": schema}
    return [
        t(TOOL_OPEN, _obj({"title_en": _S, "title_zh": _S, "date": _S,
                           "color": {"type": "string", "enum": list(dp.COLORS)},
                           "open_itinerary": _B,
                           "next": _S, "request_id": _S}, ["title_en", "date", "color"])),
        t(TOOL_VIEW, _obj({"plan": _I})),
        t(TOOL_ROUTE, _obj({"mode": {"type": "string", "enum": ["walk"]}, "from": _S, "to": _S},
                           ["mode", "from", "to"])),
        t(TOOL_EDIT, _obj({
            "plan": _I, "op": {"type": "string", "enum": list(dp.EDIT_OPS)},
            "title_en": _S, "title_zh": _S, "date": _S, "color": {"type": "string", "enum": list(dp.COLORS)},
            "open_itinerary": _B,
            "stop_id": _I, "position": _I, "to": _I, **_STOP_F,
            "to_stop": _I, **_LEG_F,
            "legs": {"type": "array", "description": "加站/删站/移站时一起重写的路段：每段=to_stop+跟 set_leg 一样的字段",
                     "items": {"type": "object"}},
            "items": {"type": "array", "description": "[{section:book/wear/bring/weather,text,detail}]",
                      # set_prep 用对象；set_contract 旧写法用 items 传字符串（正式字段是 contract），两种都收
                      "items": {"anyOf": [_obj({"section": {"type": "string", "enum": list(dp.PREP_SECTIONS)},
                                                "text": _S, "detail": _S}, ["section", "text"]), _S]}},
            "contract": {"type": "array", "items": _S}, "text": _S, "reason": _S, **_COMMON_W,
        }, ["plan", "op"])),
        t(TOOL_SEND, _obj({"plan": _I, **_COMMON_W}, ["plan"])),
        t(TOOL_LIVE, _obj({"plan": _I, "op": {"type": "string", "enum": list(dp.LIVE_OPS)},
                           "stop_id": _I, "text": _S, "from_stop": _I, "minutes": _I, "reason": _S,
                           **_COMMON_W},
                          ["plan", "op"])),
        t(TOOL_CLOSE, _obj({"plan": _I, "quote": _S, **_COMMON_W}, ["plan", "quote"])),
        t(TOOL_INBOX, _obj({"op": {"type": "string", "enum": ["list", "claim", "done", "release"]},
                            "ids": {"type": "array", "items": _I}, "client": _S})),
        t(TOOL_MEMORY, _obj({"op": {"type": "string", "enum": ["find", "followup"]}, "plan": _I,
                             "name": _S, "place": _S, "from": _S, "to": _S, "text": _S})),
    ]


# ── 字段归属(add_stop 传 place 曾被静默丢掉)──────────────────────────────────────────
# schema 是并集,引擎各 op 只取自己认的键、其余静默忽略 → 写错字段名=回「改好了」却什么都没存。
# 这里登记每个工具/op 真正认的字段(含 legs/steps/items 嵌套);传了不认的字段且有值 = 整笔不做,
# 回执说清该用哪个。值为空(None / "" / [] / {})的不认字段放过:没有内容,丢了也没丢东西。
_W = ("next", "expect_version", "request_id")
_TOOL_COMMON: dict[str, tuple[str, ...]] = {
    TOOL_OPEN: ("next", "request_id"), TOOL_VIEW: ("plan",), TOOL_ROUTE: (),
    TOOL_EDIT: ("plan", "op", *_W), TOOL_SEND: ("plan", *_W), TOOL_LIVE: ("plan", "op", *_W),
    TOOL_CLOSE: ("plan", *_W), TOOL_INBOX: ("op",), TOOL_MEMORY: ("op", "plan"),
}
_OP_FIELDS: dict[str, dict[str | None, tuple[str, ...]]] = {
    TOOL_OPEN: {None: ("title_en", "title_zh", "date", "color", "open_itinerary")},
    TOOL_VIEW: {None: ()},
    TOOL_ROUTE: {None: ("mode", "from", "to")},
    TOOL_EDIT: {
        "set_basic": ("title_en", "title_zh", "date", "color", "open_itinerary"),
        "add_stop": (*_STOP_F, "position", "legs"),
        "update_stop": ("stop_id", *_STOP_F),
        "remove_stop": ("stop_id", "legs"),
        "move_stop": ("stop_id", "to", "legs"),
        "set_leg": ("to_stop", *_LEG_F),
        "remove_leg": ("to_stop",),
        "set_prep": ("items",),
        "set_contract": ("contract", "items"),
        "set_card": ("text",),
        "cancel": ("reason",),
        "delete_plan": (),
        "set_invite": ("text",),                   # 已结束约会补写
        "set_quote": ("text",),
        "write_reply": ("text",),                  # 回她的信
    },
    TOOL_SEND: {None: ()},
    TOOL_LIVE: {"open_stop": ("stop_id",), "telegram": ("text",), "shift": ("from_stop", "minutes"),
                "skip": ("stop_id", "reason"), "unskip": ("stop_id",)},
    TOOL_CLOSE: {None: ("quote",)},
    TOOL_INBOX: {None: ("ids", "client")},
    TOOL_MEMORY: {"find": ("name", "place", "from", "to"), "followup": ("text",)},
}
# 嵌套对象里认的键:字段名 → 每一项(对象)的键。items 只在 set_prep 是对象(set_contract 的 items 是字符串)。
_NESTED: dict[str, tuple[str, ...]] = {
    "legs": ("to_stop", *_LEG_F), "steps": dp._STEP_KEYS,
}
_PREP_ITEM = ("section", "text", "detail")
# 最可能的本意(op 或嵌套名 → 写错的键 → 该用的键);没登记的错键只说它归哪个 op
_STOP_MEANT = {"place": "title", "name": "title", "hint": "clue", "location": "address"}
_MEANT = {
    "add_stop": _STOP_MEANT, "update_stop": _STOP_MEANT,
    "set_leg": {"stop_id": "to_stop"}, "remove_leg": {"stop_id": "to_stop"}, "legs": {"stop_id": "to_stop"},
    "remove_stop": {"to_stop": "stop_id"}, "move_stop": {"to_stop": "stop_id", "position": "to"},
    "set_card": {"card": "text", "card_text": "text"}, "telegram": {"telegram": "text"},
    "set_invite": {"invite": "text", "invite_text": "text"}, "set_quote": {"quote": "text"},
    "set_contract": {"clauses": "contract"},
}
_FIELD_ZH = {
    "title_en": "英文名", "title_zh": "中文名", "date": "日期", "color": "颜色", "open_itinerary": "是否不藏行程",
    "kind": "类型", "time": "到达时间",
    "stay_until": "待到的时间", "title": "地点名", "address": "地址", "lat": "纬度", "lng": "经度",
    "no_place": "没有固定地点", "subtype": "细类",
    "reveal_at": "地点公开时间", "clue": "线索", "note": "到站给她的话", "how_to_get": "怎么去",
    "art_hint": "画面描述", "walk_path": "散步路线", "stop_id": "哪一站", "position": "插在第几站",
    "to": "挪到第几站", "legs": "一起重写的路段", "to_stop": "通往哪一站", "mode": "交通方式",
    "depart_time": "出发时间", "arrive_time": "到达时间", "minutes": "大约几分钟", "summary": "路段一句话",
    "steps": "换乘明细", "fare": "车费", "needs_ticket": "要不要买票", "ticket_note": "车票备注",
    "source": "来源", "official_url": "官方路线页", "items": "条目", "contract": "契约书条款",
    "text": "小卡正文", "reason": "原因",
    "from_stop": "从哪一站起", "quote": "那一句话", "ids": "待办编号", "client": "显示用的名字",
}
_FIELD_ZH_BY_TOOL = {
    TOOL_ROUTE: {"mode": "walk", "from": "起点", "to": "终点"},
    TOOL_LIVE: {"text": "电报正文", "minutes": "推后（正）或提前（负）几分钟", "reason": "跳过的原因"},
    TOOL_EDIT: {},
    TOOL_MEMORY: {"name": "约会名", "place": "站名或地址", "from": "从哪天", "to": "到哪天", "text": "后续正文"},
}


_FIELD_ZH_BY_OP = {"set_invite": {"text": "迟到的请柬正文"}, "set_quote": {"text": "那一句话"},
                    "write_reply": {"text": "回信正文"}}


def _zh(tool: str, k: str, op: str | None = None) -> str:
    return config.who(_FIELD_ZH_BY_OP.get(op or "", {}).get(k) or _FIELD_ZH_BY_TOOL.get(tool, {}).get(k)
                      or _FIELD_ZH.get(k, ""))


def _empty(v) -> bool:
    return v is None or v == "" or v == [] or v == {}


def _nested_stray(name: str, val, allowed: tuple[str, ...], path: str) -> list[tuple[str, str, str]]:
    """嵌套对象/对象列表里不认的键 → [(显示路径, 键, 嵌套名)]。形状不对(不是对象)交给引擎报。"""
    out: list[tuple[str, str, str]] = []
    rows = [(path, val)] if isinstance(val, dict) else (
        [(f"{path}[{i}]", x) for i, x in enumerate(val)] if isinstance(val, list) else [])
    for p, row in rows:
        if not isinstance(row, dict):
            continue
        for k, v in row.items():
            if k not in allowed:
                if not _empty(v):
                    out.append((f"{p}.{k}", k, name))
            elif k in _NESTED and k != name:
                out += _nested_stray(k, v, _NESTED[k], f"{p}.{k}")
    return out


def _stray_fields(tool: str, args: dict) -> str | None:
    """不认的字段 → 失败回执文字;都认识 = None。op 本身写错交给引擎报(它会列可选 op)。"""
    table = _OP_FIELDS.get(tool)
    if table is None:
        return None
    op = args.get("op") if None not in table else None
    if op not in table:
        return None
    who = f"{tool} 的 {op}" if op else tool
    lead = {TOOL_OPEN: "没开成", TOOL_VIEW: "没看成", TOOL_ROUTE: "没查成", TOOL_SEND: "没寄出",
            TOOL_MEMORY: "没写成" if op == "followup" else "没查成"}.get(tool, "没改成")
    if op == "set_contract" and "contract" in args and not _empty(args.get("items")) \
            and args.get("contract") != args.get("items"):
        return (f"{lead}：set_contract 的 contract 和 items 写了不一样的内容，只写一个（契约书用 contract）。"
                "这一笔没有生效。")
    own = table[op]
    known = set(own) | set(_TOOL_COMMON[tool])
    stray: list[tuple[str, str, str]] = [(k, k, op or tool) for k in args if k not in known and not _empty(args[k])]
    for k in own:                                  # 嵌套里的键也要认(legs 里写错一样会被静默丢)
        if k in args:
            if k in _NESTED:
                stray += _nested_stray(k, args[k], _NESTED[k], k)
            elif k == "items" and op == "set_prep":
                stray += _nested_stray(k, args[k], _PREP_ITEM, k)
    if not stray:
        return None
    parts, nested_can = [], {}
    for path, k, grp in stray:
        if path == k:
            owners = [o for o, ks in table.items() if o and k in ks]
            line = f"{k} 是 {' / '.join(owners)} 用的" if owners else f"{k} 不是 {who} 的字段"
        else:
            line = f"{path} 不是 {grp} 里的字段"
            allowed = _PREP_ITEM if grp == "items" else _NESTED[grp]
            nested_can[grp] = "、".join(allowed)
        meant = _MEANT.get(grp, {}).get(k)
        if meant:
            line += f"；你要写{_zh(tool, meant, op) or meant}，用 {meant}"
        parts.append(line)
    can = "、".join(f"{k} {_zh(tool, k, op)}".strip() for k in own) or "除下面这几个以外没有别的"
    common = _TOOL_COMMON[tool]
    tail = f"\n{who} 能写的字段：{can}" + (f"；另外都可以带：{'、'.join(common)}" if common else "") + "。"
    for grp, ks in nested_can.items():
        tail += f"\n{grp} 里每一项能写：{ks}。"
    return (f"{lead}：{who} 不认 " + "、".join(p for p, _, _ in stray) + "。" + "。".join(parts) + "。"
            + tail + "\n这一笔没有生效，改好字段名再做一次。")


# ── 渲染(行程单 /  列表摘要)──────────────────────────────────────────────
_WD = "一二三四五六日"
_PHASE_ZH = {"draft": "构思中", "draft_expired": "构思中（日期已过，没寄出）", "sent": "已寄出",
             "live": "当天", "done": "已结束", "cancelled": "已取消"}
_MON_DAY = lambda iso: f"{int(iso[5:7])}/{int(iso[8:10])}"  # noqa: E731


def _wd(iso: str) -> str:
    return "周" + _WD[_date.fromisoformat(iso).weekday()]


def _name(p: dict) -> str:
    """他读的约会名(主副名唯一函数 dp.full_name):两个都有 =「First Rain（眼镜大作）」。"""
    return dp.full_name(p)


def _hm(dt) -> str:
    return dp._hhmm(dt) if dt is not None else "（没写）"


def _dots(bits: list[str]) -> str:
    """「 · 」连接;前一项以全角括号收尾时不留前导空格(「集合（train）· 梧桐站」「（已经订好了）· 有一段」)。"""
    out = ""
    for b in bits:
        if out:
            out += ("· " if out.endswith("）") else " · ")
        out += b
    return out


def _leg_desc(lg: dict) -> str:
    bits = [dp.leg_phrase(lg)]
    if lg.get("summary"):
        bits.append(lg["summary"])
    for stp in lg.get("steps") or []:
        seg = " ".join(x for x in (stp.get("line"), f"往{stp['direction']}" if stp.get("direction") else "") if x)
        if stp.get("board") or stp.get("alight"):
            seg += f" {stp.get('board', '?')}→{stp.get('alight', '?')}"
        if stp.get("stops") is not None:
            seg += f" {stp['stops']} 站"
        if seg.strip():
            bits.append(seg.strip())
    if lg.get("fare_yen") is not None:
        bits.append(f"¥{lg['fare_yen']}")
    if lg.get("depart_time"):
        bits.append(f"{lg['depart_time']} 出发")
    if lg.get("arrive_time"):
        bits.append(f"{lg['arrive_time']} 到")
    if lg.get("needs_ticket"):
        bits.append("要提前买票" + (f"：{lg['ticket_note']}" if lg.get("ticket_note") else ""))
    return _dots(bits)


def _seen(vis, flag: bool, later: str) -> str:
    """她能不能看到的括注:能看到=「她已能看到」;否则给出什么时候能看到。"""
    return f"（{config.her()}已能看到）" if (vis is not None and flag) else f"（{later}）"


_PLACE_SOURCE_ZH = {"google": "谷歌", "amap": "高德", "osm": "OpenStreetMap"}


def _coords_line(st: dict, s: dict, now: datetime) -> str | None:
    """地点来自条款不许长期存坐标的服务时,详情里说明坐标的处境(高德:不存不画;谷歌:缓存过期)。"""
    if dp.is_no_place(s):
        return None
    _, _, status = dp.place_coords(st, s, now)
    who = _PLACE_SOURCE_ZH.get(s.get("place_source") or "", s.get("place_source") or "")
    if status == "not_storable":
        return f"  坐标：坐标不可存，未画（地点来自{who}，按它的条款不存坐标，{config.her()}的地图上不画这一站）"
    if status == "expired":
        return f"  坐标：坐标缓存已过期（地点来自{who}，按它的条款最多临时缓存），{config.her()}打开地图时重新查询"
    return None


def render_detail(snap: dict, now: datetime) -> str:
    st, ph, chk = snap["state"], snap["phase"], snap["check"]
    p, abs_ = st["plan"], snap["timeline"]["abs"]
    vis = dp.Visibility(st, now) if ph not in ("draft", "draft_expired") else None
    head = [f"约会 #{p['id']} 「{_name(p)}」", f"{_MON_DAY(p['date'])} {_wd(p['date'])}", _PHASE_ZH[ph]]
    if (_td := dp.together_day(p)) is not None:          # 在一起的第几天
        head.insert(2, f"在一起的第 {_td} 天")
    done = ph == "done"
    her_origin = p.get("origin") == "her"
    if her_origin:
        head.append(f"{config.her()}补记的约会")
    if p.get("open_itinerary"):      # 详情写明这一次是否不藏行程
        head.append(f"不藏行程（{config.her()}拆开请柬即可看到全部站）")
    if p.get("her_opened_at") is not None and vis is not None:   # 只写已记下的事实;没记=不提
        head.append(f"{config.her()} {_stamp(p['her_opened_at'])} 拆开了请柬")
    her_evs = [_ev_detail(e) for e in snap["events"] if e["kind"] in dp.HER_EVENT_KINDS]
    added_later = {d.get("stop_id") for e, d in her_evs if d.get("op") == "add_stop"}
    line_later = {d.get("stop_id") for e, d in her_evs if d.get("op") == "set_line"}
    photos = snap.get("photos") or {}
    if p.get("paper_no"):
        head.append(f"纸面编号 No.{p['paper_no']}")
    head += [f"颜色：{dp.COLORS[p['color']]}", f"v{p['version']}"]
    out = [" · ".join(head), ""]
    stops = st["stops"]
    if not stops:
        out.append("（还没有站）")
    for n, s in enumerate(stops, 1):
        sid = s["id"]
        lg = next((x for x in st["legs"] if x["to_stop_id"] == sid), None)
        place_seen = vis is not None and vis.place(sid)
        if lg is not None:
            first_leg = dp.leg_from_id(stops, n - 1) is None     #  前面全是没有固定地点的站=第 0 段
            ind = "" if n == 1 else "  "
            lead = f"↓ {config.her()}怎么来" if first_leg else f"↓ 怎么去第 {n} 站"
            if lg["stale"]:
                out.append(f"{ind}{lead}：第 {n} 站的路段起点变了，要重写")
            else:
                when = f"第 1 站地点公开时{config.her()}能看到" if n == 1 else f"第 {n} 站地点公开后{config.her()}能看到"
                out.append(f"{ind}{lead}：{_leg_desc(lg)}{_seen(vis, place_seen, when)}")
                if lg.get("official_url"):
                    out.append(f"{ind}  官方路线页：已附（{config.her()}点开看）")
        t = s.get("time") or "（没写时间）"
        stay = f"，待到 {s['stay_until']}" if s.get("stay_until") else ""
        kind = f"{dp.stop_label(s)}（{dp.stop_kind(s)}）" if dp.stop_kind(s) else "（没写类型）"   #  大类·细类
        src = ""
        if done:                                       # 出处:你写的 / 她补记的 / 她后来加的
            src = ("（你写的）" if s.get("added_by", dp.HIM) != dp.HER else
                   f"（{config.her()}补记的）" if her_origin and sid not in added_later else f"（{config.her()}后来加的）")
        out.append(f"第 {n} 站 [stop {sid}] {t} 到{stay} · " + _dots([kind, s.get('title') or '（没写地点名）']) + src
                   + (f" · 跳过了：{s.get('skip_reason') or ''}" if dp.is_skipped(s) else ""))
        cline = _coords_line(st, s, now)
        if done:
            out.append(NO_PLACE_LINE if dp.is_no_place(s) else f"  地址：{s.get('address') or '（没写）'}")
            if cline:
                out.append(cline)
            art_ln = dp.art_line(st, s)
            if art_ln:
                out.append(art_ln)
            if s.get("clue"):
                out.append(f"  线索：{s['clue']}")
            out.append(f"  你给{config.her()}的话：{s['note']}" if s.get("note") else f"  你给{config.her()}的话：没写")
            if s.get("her_line"):
                when = f"{config.her()}后来写的" if (sid in line_later or not her_origin or sid in added_later) else f"{config.her()}补记时写的"
                out.append(f"  {config.her()}写的一句话：「{s['her_line']}」（{when}）")
            if photos.get(sid):
                out.append(f"  {config.her()}放了 {photos[sid]} 张照片")
            chg = [f"{_stamp(e['created_at'])} {_EDIT_ZH[d['field']]} {_val(d['field'], d.get('before'), s.get('time'))} → "
                   f"{_val(d['field'], d.get('after'), s.get('time'))}"
                   for e, d in her_evs if d.get("op") == "update_stop" and d.get("stop_id") == sid
                   and d.get("field") in _EDIT_ZH]
            if chg:                                    # 改前改后(取 detail_json),坐标也列出数值
                out.append(f"  {config.her()}改过：" + "；".join(chg))
            continue
        rt = dp.reveal_time(st, s, abs_)
        # 第 1 站没有默认:没有前一段路可推,默认=到达时刻,而寄出要求第 1 站公开早于到达 → 必须写(check 的 first_reveal)
        rv = (s.get("reveal_at") or "") if s.get("reveal_at") else (
            f"{_hm(rt)}（没写，按默认）" if rt and n > 1 else "（没写）")
        later = "到点公开" if vis is not None else "寄出后到点公开"
        if s.get("reveal_at"):
            later += f"；这个时间{config.her()}看得到"            # 他写的公开时间对她可见
        if dp.is_no_place(s):                          #  一件事:地址那一行换成固定一句,公开时间另起一行
            out.append(NO_PLACE_LINE)
            out.append(f"  公开：{rv}{_seen(vis, place_seen, later)}")
        else:
            out.append(f"  地址：{s.get('address') or '（没写）'} · 地点公开：{rv}{_seen(vis, place_seen, later)}")
            if cline:
                out.append(cline)
        art_ln = dp.art_line(st, s)                    #  每站现画:这张画到哪了
        if art_ln:
            out.append(art_ln)
        if s.get("clue"):
            out.append(f"  线索：{s['clue']}{config.who('（她随时能点开）' if vis is not None else '（寄出后她能点开）')}")
        if s.get("note"):
            out.append(f"  到站给{config.her()}的话：{s['note']}{_seen(vis, vis is not None and vis.note(sid), config.who('到站后她能看到'))}")
        if n > 1 and not dp.is_no_place(s) and not s.get("reveal_at") and (lg is None or (not lg.get("depart_time") and not lg.get("minutes"))):
            out.append(f"  提示：通往这站的路段没写出发时刻，地点要到到站时才公开，{config.her()}出门前看不到")
    if done and photos.get(None):     # 不挂站的照片(挂在整次约会上)
        out.append(f"{config.her()}放了 {photos[None]} 张照片（不挂站，整次约会）")
    # 准备清单(他看全量,含派生的车票条)
    prep = dp.prep_items(st, None)
    if prep:
        out.append(f"准备清单{config.who('（她已能看到）' if vis is not None else '（寄出后她能看到）')}：")
        by: dict[str, list[str]] = {}
        for it in prep:
            by.setdefault(it["section"], []).append(it["text"] + (f"（{it['detail']}）" if it.get("detail") else ""))
        if "book" in by:
            out.append(f"  {dp.PREP_SECTIONS['book']}：" + _dots(by["book"]))
        rest = [f"{dp.PREP_SECTIONS[k]}：" + _dots(by[k]) for k in ("wear", "bring", "weather") if k in by]
        if rest:
            out.append("  " + "　".join(rest))
    elif not (done and her_origin):                # 补记的约会没有准备清单这一页,不提
        out.append("准备清单：还没写")
    if done:
        out += _late_lines(p, snap.get("asks") or [], snap.get("letters"))
    else:
        if p.get("contract"):
            out.append(f"契约书（结束后{config.her()}才能看到）：" + " ".join(f"{i}. {c}" for i, c in enumerate(p["contract"], 1)))
        else:
            out.append("契约书：没写")
        out.append(f"小卡（结束后{config.her()}才能看到）：{p['card_text']}" if p.get("card_text") else "小卡：没写")
    evs = [e for e in snap["events"] if e["kind"] not in ("envelope", *dp.HER_EVENT_KINDS)]
    if evs:
        unread = sum(1 for e in evs if e.get("read_at") is None)
        rd = f"{config.her()}已读" if unread == 0 else f"{unread} 封{config.her()}还没读"
        shown = " · ".join(f"{_MON_DAY(datetime.fromtimestamp(e['created_at'], config.tz()).date().isoformat())} "
                           + (f"「{e['text']}」" if e["kind"] == "telegram_manual" else e["text"]) for e in evs)
        out.append(f"电报（{len(evs)} 封，{rd}）：{shown}")
    else:
        out.append("电报：还没有")
    if snap.get("notes"):                          # 准备中她能留一句话
        out.append(f"{config.her()}留的话：" + " · ".join(f"{_stamp(n['created_at'])}「{n['text']}」" for n in snap["notes"]))
    if her_evs:                                    # 她补记/后来加的,按时间
        out.append(f"{config.her()}补记 / 加的：" + " · ".join(f"{_stamp(e['created_at'])} {e['text']}" for e, _ in her_evs))
    out.append("")
    out.append(f"{config.her()}现在能看到：{_she_sees(snap, vis)}")
    if done:
        asks = [_ask_label(a, p["id"]) for a in snap.get("asks") or []]
        out.append(f"{config.her()}在等你写：{'、'.join(asks) if asks else '无'}")
    else:
        miss = [m["short"] for m in chk["missing"]] + [e["short"] for e in chk["errors"]]
        out.append(f"还缺：{'、'.join(miss) if miss else '无'}")
    out.append(f"下一步（你上次留的）：{p.get('next_note') or '（没留）'}")
    return "\n".join(out)


_EDIT_ZH = {"time": "时间", "title": "地名", "address": "地址", "coord": "位置", "kind": "种类",
            "no_place": "没有固定地点", "walk_path": "散步路线", "subtype": "细类"}
NO_PLACE_LINE = "  一件事 · 没有固定地点"         #  不加修饰


def _val(field: str, v, time: str | None = None) -> str:
    if field == "coord":
        return f"{v[0]:.5f},{v[1]:.5f}" if isinstance(v, list) and len(v) == 2 and None not in v else "（没写）"
    if field == "no_place":
        return "是" if v else "否"
    if field == "kind":
        # dinner 按这一站现在的 time 显示「午餐/晚餐」(见 date_kinds.label)
        return dp.date_kinds.label(v, None, time) if v else "（没写）"
    return f"「{v}」" if field in ("title", "address") and v else (v or "（没写）")


def _ev_detail(e: dict) -> tuple[dict, dict]:
    try:
        d = json.loads(e.get("detail_json") or "{}")
    except ValueError:
        d = {}
    return e, d if isinstance(d, dict) else {}


# 记忆输出模块可以登记「后续」那一项更具体的说法(哪张卡、怎么写):hook(plan_id) -> str | None
ASK_LABEL_HOOKS: dict[str, object] = {memory.ASK_WHAT: memory.ask_label}


def _ask_label(what: str, plan_id: int) -> str:
    """她在等你写的一样。"""
    hook = ASK_LABEL_HOOKS.get(what)
    if hook is not None:
        try:
            got = hook(plan_id)
            if got:
                return got
        except Exception as e:  # noqa: BLE001 — 说法取不到就用通用的,不挡回执
            log.warning("[tools] ask label hook failed: %r", e)
    return dp.ASK_ZH[what]


def _late_lines(p: dict, asks: list[str], letters: dict | None = None) -> list[str]:
    """已结束约会的四样:谁写的、她是不是在等你写。
    letters 非空时追加她的信全文 + 回信(只在她写了信才出,没写信=没有回信这件事)。"""
    hw = p.get("her_wrote") or set()

    def who(w):
        return f"（{config.her()}写的）" if w in hw else "（你写的）"

    def empty(w):
        return f"还没写（{config.her()}在等你写）" if w in asks else "没写"

    out = []
    if p.get("origin") == "her":
        out.append(f"迟到的请柬：{p['invite_text']}{who('invite')}" if p.get("invite_text")
                   else f"迟到的请柬：{empty('invite')}")
    out.append("契约书：" + " ".join(f"{i}. {c}" for i, c in enumerate(p["contract"], 1)) + who("contract")
               if p.get("contract") else f"契约书：{empty('contract')}")
    out.append(f"小卡：{p['card_text']}{who('card')}" if p.get("card_text") else f"小卡：{empty('card')}")
    out.append(f"那一句话：{p['quote']}（你写的）" if p.get("quote") else f"那一句话：{empty('quote')}")
    her_letter = (letters or {}).get("her")
    if her_letter:
        out.append(f"{config.her()}的信：{her_letter['text']}")
        him_reply = (letters or {}).get("him")
        out.append(f"回信：{him_reply['text']}（你写的）" if him_reply else f"回信：{empty('reply')}")
    return out


def _stamp(ts: float) -> str:
    t = datetime.fromtimestamp(ts, config.tz())
    return f"{t.month}/{t.day} {t:%H:%M}"


def _she_sees(snap: dict, vis) -> str:
    if vis is None:
        return "准备进度（日期、几站、各部分写没写、还缺几样、你上次动笔的时间），名字、颜色和内容看不到"
    st = snap["state"]
    if vis.all:
        return "全部"
    if vis.open_all:                        # 不藏行程且她已拆开,就是全部(不等逐站到点)
        return "全部（不藏行程）"
    bits = ["名字、日期、准备清单"]
    nums = [n for n, s in enumerate(st["stops"], 1) if vis.place(s["id"])]
    if 1 in nums:
        bits.append("第 1 站地点与怎么来")       #  定稿:第 1 站前面那段是「她怎么来」
    rest = [str(n) for n in nums if n != 1]
    if rest:
        bits.append(f"第 {'、'.join(rest)} 站地点与怎么去")
    notes = [str(n) for n, s in enumerate(st["stops"], 1) if vis.note(s["id"])]
    if notes:
        bits.append(f"第 {'、'.join(notes)} 站给{config.her()}的话")
    if any(s.get("clue") for s in st["stops"]):
        bits.append("全部线索")
    return "、".join(bits)


def render_line(item: dict) -> str:
    p = item["state"]["plan"]
    miss = [m["short"] for m in item["check"]["missing"]]
    return f"#{p['id']} {_name(p)} · {_MON_DAY(p['date'])} · {_PHASE_ZH[item['phase']]} · 还缺：{'、'.join(miss) if miss else '无'}"


def render_list(now: datetime) -> str:
    items = dp.list_plans(now=now)
    out = [render_line(i) for i in items] if items else ["现在没有进行中的约会。"]
    shelf = dp.shelf_digest(now=now)["shelf"]
    if shelf:                                      # 书架:已结束的约会(新→旧),用 plan 编号打开
        out.append(f"书架（已结束 {len(shelf)} 次）：")
        out += [f"#{p['id']} {_name(p)} · {_MON_DAY(p['date'])}" + (f"（{config.her()}补记的）" if p.get("origin") == "her" else "")
                for p in shelf]
    return "\n".join(out)



# ── 约会账(/ )────────────────────────────────────────────────────────
LEDGER_HEADER = "# 约会账 ·"   # cc_loop 判「本轮已带」用;表头权威一处
_LEDGER_STAMP_RE = re.compile(r"生成于 \d{1,2}/\d{1,2} \d{2}:\d{2}；")
_STOP_MISS = ("stop_", "no_stops", "first_reveal")


def _wrote(item: dict) -> str:
    """「写到」一行(例句的形):N 站(站上不缺=「齐」);有才写路段/准备清单;
    契约书·小卡:寄出后总写(写没写都是事实),构思中只在写了时提。"""
    st, ph, chk = item["state"], item["phase"], item["check"]
    p = st["plan"]
    stops = st["stops"]
    bits = []
    stop_ok = stops and not any(m["code"].startswith(_STOP_MISS) for m in chk["missing"])
    bits.append(f"{len(stops)} 站" + ("齐" if stop_ok else ""))
    if p.get("open_itinerary"):          # 约会账也写明是否不藏行程
        bits.append("不藏行程")
    legs = [lg for lg in st["legs"] if not lg["stale"]]
    if legs:
        bits.append(f"路段 {len(legs)} 段")
    secs = {it["section"] for it in dp.prep_items(st, None)}
    if secs:
        bits.append(f"准备清单 {len(secs)} 类")
    sent = ph in ("sent", "live")
    if sent or p.get("contract"):
        bits.append("契约书已写" if p.get("contract") else "契约书没写")
    if sent or p.get("card_text"):
        bits.append("小卡已写" if p.get("card_text") else "小卡没写")
    miss = [m["short"] for m in chk["missing"]] + [e["short"] for e in chk["errors"]]
    bits.append(f"还缺：{'、'.join(miss) if miss else '无'}")
    return "；".join(bits)


LEDGER_NEWS_MAX = 12          # 「她补记 / 加的」最多列几行(多了说还有几条,打开约会能看全)


def ledger_block(now: datetime | None = None, *, path: str | None = None) -> tuple[str, str]:
    """→ (约会账正文, 去重键)。进行中/过期构思的约会、她补记或加的、她在等你写——三样都没有 → ("", "")。
    书架那一行单独不出账(不能因为书架上有约会就多出被盖思考的轮),只附在有账时的末尾。
    去重键 = 去掉「生成于 MM/DD HH:MM；」后的正文(生成时刻每次都变,不能进键)
    + 「她补记 / 加的」那段涉及事件的最大 id(同一句话连改两次正文一样,不带 id 第二次会被当成没变吞掉)。"""
    now = dp._as_tz(now)
    items = dp.list_plans(now=now, path=path)
    dig = dp.shelf_digest(now=now, path=path)
    if not items and not dig["news"] and not dig["asks"]:
        return "", ""
    active = [i for i in items if i["phase"] != "draft_expired"]
    expired = [i for i in items if i["phase"] == "draft_expired"]
    out = [f"{LEDGER_HEADER} 约会（生成于 {now.month}/{now.day} {now:%H:%M}；进行中 {len(active)} 个）"]
    if active or expired:
        # 约会账不带进行中约会的名字与内容(带了它的轮不再盖思考,内容要靠工具看,调工具那轮才盖)
        # 例外:「她留的话」是她自己写给他的,照常列出
        out.append("（进行中的约会这里只写进度，不写约会名和你写的内容；要看用 date_view 打开）")
    for i in active:
        p = i["state"]["plan"]
        ph = i["phase"]
        status = _PHASE_ZH[ph]
        if ph == "sent":
            days = (_date.fromisoformat(p["date"]) - now.date()).days
            status += f"（还有 {days} 天）"
        out.append(f"· 约会 #{p['id']} {_MON_DAY(p['date'])} {_wd(p['date'])} · {status}")
        out.append(f"  写到：{_wrote(i)}")
        fresh = [n for n in i.get("notes") or [] if n["id"] > (p.get("notes_upto") or 0)]
        if fresh:                                  # 只列他上次动笔之后的;全部在详情里
            out.append(f"  {config.her()}留的话（你上次动笔之后）：" + " · ".join(f"「{n['text']}」" for n in fresh[-3:]))
        out.append("  下一步：" + ("你上次留了一句（date_view 里看）" if p.get("next_note") else "没留"))
    for i in expired:
        p = i["state"]["plan"]
        out.append(f"· 约会 #{p['id']} {_MON_DAY(p['date'])} · {_PHASE_ZH['draft_expired']}")
    out += _ledger_shelf_lines(dig)
    text = "\n".join(out)
    key = _LEDGER_STAMP_RE.sub("", text, count=1)
    news_ids = [e["id"] for _, evs in dig["news"] for e in evs]
    if news_ids:
        key += f"\n[her_events≤{max(news_ids)}]"
    return text, key


def _ledger_shelf_lines(dig: dict) -> list[str]:
    """约会账后三段(没有内容就整段不出):她补记 / 加的(他上次 date_view 打开那次约会之后)、她在等你写、书架。"""
    out: list[str] = []
    news = [(p, e) for p, evs in dig["news"] for e in evs]
    if news:
        out.append(f"{config.her()}补记 / 加的（你上次看之后）：")
        for p, e in news[:LEDGER_NEWS_MAX]:
            out.append(f"· {_MON_DAY(p['date'])} 「{_name(p)}」 {e['text']}")
        if len(news) > LEDGER_NEWS_MAX:
            out.append(f"· 还有 {len(news) - LEDGER_NEWS_MAX} 条，date_view 打开那次约会能看全")
    if dig["asks"]:
        out.append(f"{config.her()}在等你写：")
        for p, ws in dig["asks"]:
            out.append(f"· {_MON_DAY(p['date'])} 「{_name(p)}」：" + "、".join(_ask_label(w, p["id"]) for w in ws))
    shelf = dig["shelf"]
    if shelf:
        recent = "、".join(f"「{_name(p)}」{_MON_DAY(p['date'])}" for p in shelf[:3])
        out.append(f"书架：{len(shelf)} 次（最近：{recent}）")
    return out


# ── 执行体 ────────────────────────────────────────────────────────────────────────
def _now() -> datetime:
    return dp._now()


def _req(tool: str, args: dict) -> dp.Req | None:
    rid = args.get("request_id")
    if rid in (None, ""):
        return None
    body = {k: v for k, v in args.items() if k != "request_id"}
    ah = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()
    return (tool, str(rid)[:80], ah)


def _detail_or_note(plan_id, now: datetime) -> str:
    """写已提交后取详情;取不出来照样算成功(不许回 is_error 让他重做)。"""
    try:
        snap = dp.snapshot(plan_id, now=now)
        if snap is None:
            return render_list(now)
        return render_detail(snap, now)
    except Exception as e:  # noqa: BLE001
        log.warning("[tools] 写成功后取详情失败: %r", e)
        return "（详情暂时读不出来，用 date_view 再看一眼）"


def _fail_text(res: dict, lead: str = "没改成") -> str:
    errs = [{**e, "text": e["text"].rstrip("。")} for e in res["errors"]]   # 句末统一由这里加,防「。。」
    codes = [e["code"] for e in errs]
    if lead == "没寄出" and all(c.startswith("send_") for c in codes):
        missing_codes = {"send_" + c for c in ("no_stops", "first_reveal", "first_reveal_order", "no_prep",
                                                "stale_leg", "first_no_place")} | {c for c in codes if c.startswith("send_stop_")}
        if all(c in missing_codes for c in codes):
            return f"没寄出：还缺 {len(errs)} 项——" + "；".join(e["text"] for e in errs) + "。"
    return f"{lead}：" + "；".join(e["text"] for e in errs) + "。"


def _with_plan(res: dict, plan_id, now: datetime, ok_line: str, lead: str = "没改成") -> tuple[str, bool]:
    if res.get("duplicate"):
        return ("这个请求已经做过了，下面是现在的样子。\n\n" + _detail_or_note(res.get("plan_id"), now), False)
    if res["ok"]:
        if res.get("events"):
            scheduler.kick()                   # 有新信封/电报 → 调度者立刻派发一次(跨线程安全;没有调度者=它下一轮补上)
        return ok_line + "\n\n" + _detail_or_note(plan_id, now), False
    if any(e["code"] == "no_plan" for e in res["errors"]):
        return f"没有约会 #{plan_id}。\n\n{render_list(now)}", True
    txt = _fail_text(res, lead)
    try:
        snap = dp.snapshot(plan_id, now=now)
        if snap is not None:
            txt += "\n\n" + render_detail(snap, now)
    except Exception:  # noqa: BLE001
        pass
    return txt, True


def _event_note(res: dict, plan_id, now: datetime) -> str:
    """这一笔自动发出的电报(给他一句知情)。"""
    if not res.get("events"):
        return ""
    try:
        snap = dp.snapshot(plan_id, now=now)
        ids = set(res["events"])
        texts = [e["text"] for e in (snap or {}).get("events", []) if e["id"] in ids and e["kind"] == "telegram_auto"]
        return (f"已自动给{config.her()}发了电报：" + "；".join(f"「{t}」" for t in texts)) if texts else ""
    except Exception:  # noqa: BLE001
        return ""


class _BadArg(Exception):
    pass


def _int(v, field: str = "plan"):
    """整数参数:int 原样;纯数字字符串转 int;空=None;其余明确报错(不许静默忽略,expect_version 失效=版本保护失效)。"""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        raise _BadArg(f"{field} 要写整数")
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.strip().lstrip("-").isdigit():
        return int(v.strip())
    raise _BadArg(f"{field} 要写整数")


def _exec_open(args: dict, now: datetime):
    res = dp.open_plan(args.get("title_en"), args.get("date"), args.get("color"),
                       args.get("next"), title_zh=args.get("title_zh"), open_itinerary=args.get("open_itinerary"),
                       now=now, req=_req(TOOL_OPEN, args))
    if res.get("duplicate"):
        return "这个请求已经做过了，下面是现在的样子。\n\n" + _detail_or_note(res["plan_id"], now), False
    if not res["ok"]:
        return _fail_text(res, "没开成"), True
    return f"开好了：约会 #{res['plan_id']}。\n\n" + _detail_or_note(res["plan_id"], now), False


def _exec_view(args: dict, now: datetime):
    plan = args.get("plan")
    if plan in (None, ""):
        return render_list(now), False
    try:
        pid = _int(plan)
    except _BadArg:
        pid = None
    snap = dp.snapshot(pid, now=now) if pid is not None else None
    if snap is None:
        return f"没有约会 #{plan}。\n\n{render_list(now)}", True
    text = render_detail(snap, now)
    seen = [e["id"] for e in snap["events"] if e["kind"] in dp.HER_EVENT_KINDS]
    if seen:                                       # 他打开看过了:约会账不再提这些
        try:
            dp.mark_her_seen(pid, max(seen))
        except Exception as e:  # noqa: BLE001 — 记已读失败只会让约会账多提一次,不挡查看
            log.warning("[tools] 记她的动作已读失败: %r", e)
    return text, False


def _exec_edit(args: dict, now: datetime):
    pid, op = _int(args.get("plan")), args.get("op")
    if pid is None:
        return "没改成：plan 要写约会编号（整数）。\n\n" + render_list(now), True
    eargs = {k: v for k, v in args.items() if k not in ("plan", "op", "next", "expect_version", "request_id")}
    if op == "set_contract":
        eargs = {"items": args.get("contract", args.get("items"))}
    res = dp.edit(pid, op, eargs, next_note=args.get("next"),
                  expect_version=_int(args.get("expect_version"), "expect_version"), now=now, req=_req(TOOL_EDIT, args))
    if op == "delete_plan" and res["ok"] and not res.get("duplicate"):
        return f"删掉了约会 #{pid}。\n\n{render_list(now)}", False
    note = _event_note(res, pid, now) if res["ok"] else ""
    if res["ok"] and res.get("late"):              # 结束后补写了她在等的那一样
        return _with_plan(res, pid, now, f"写好了：{dp.ASK_ZH[res['late']]}，{config.her()}在纪念盒里能看到了。")
    if res["ok"] and op == "update_stop" and _phase_of(pid, now) == "done":
        return _with_plan(res, pid, now, f"写好了，{config.her()}在纪念盒里能看到这一站你给{config.her()}的话了。")
    return _with_plan(res, pid, now, "改好了。" + (f"\n{note}" if note else ""))


def _phase_of(pid: int, now: datetime) -> str | None:
    try:
        snap = dp.snapshot(pid, now=now)
        return snap["phase"] if snap else None
    except Exception:  # noqa: BLE001
        return None


def _exec_send(args: dict, now: datetime):
    pid = _int(args.get("plan"))
    if pid is None:
        return "没寄出：plan 要写约会编号（整数）。\n\n" + render_list(now), True
    res = dp.send(pid, next_note=args.get("next"), expect_version=_int(args.get("expect_version"), "expect_version"),
                  now=now, req=_req(TOOL_SEND, args))
    return _with_plan(res, pid, now, f"寄出了，{config.her()}收到了信封。", lead="没寄出")


def _exec_live(args: dict, now: datetime):
    pid, op = _int(args.get("plan")), args.get("op")
    if pid is None:
        return "没改成：plan 要写约会编号（整数）。\n\n" + render_list(now), True
    largs = {k: args[k] for k in ("stop_id", "text", "from_stop", "minutes", "reason") if k in args}
    res = dp.live(pid, op, largs, next_note=args.get("next"),
                  expect_version=_int(args.get("expect_version"), "expect_version"), now=now, req=_req(TOOL_LIVE, args))
    ok_line = {"open_stop": "提前公开了。", "telegram": "电报发出去了。",
               "shift": f"挪好了，已自动给{config.her()}发了电报。",
               "skip": f"跳过了，已自动给{config.her()}发了电报。",
               "unskip": f"撤回了跳过，已自动给{config.her()}发了电报。"}.get(op, "好了。")
    return _with_plan(res, pid, now, ok_line)


def _exec_close(args: dict, now: datetime):
    pid = _int(args.get("plan"))
    if pid is None:
        return "没改成：plan 要写约会编号（整数）。\n\n" + render_list(now), True
    res = dp.close(pid, args.get("quote"), next_note=args.get("next"),
                   expect_version=_int(args.get("expect_version"), "expect_version"), now=now, req=_req(TOOL_CLOSE, args))
    return _with_plan(res, pid, now, "结束了，收进纪念盒。")


# 没有传会话身份时(stdio、本进程直接调用)用的进程级随机身份:同一进程=同一个领取者
PROCESS_SESSION = "local-" + __import__("uuid").uuid4().hex


def _who(session: str | None) -> str:
    """领取者 = 这一次连接本身(MCP 会话 id / 进程随机 id),不是应用名。"""
    return "pull:" + (session or PROCESS_SESSION)


def _label(args: dict, label: str | None, who: str) -> str:
    name = args.get("client") if isinstance(args.get("client"), str) and args.get("client").strip() else label
    return str(name).strip()[:60] if name else who


def _exec_inbox(args: dict, now: datetime, session: str | None = None, label: str | None = None):
    op = args.get("op") or "list"
    who = _who(session)
    label = _label(args, label, who)
    if op == "list":
        return inbox.render_items(inbox.open_items("pull", now), who), False
    if op not in ("claim", "done", "release"):
        return "没成：date_inbox 的 op 只能是 list、claim、done 或 release。", True
    ids = args.get("ids")
    if not isinstance(ids, list) or not ids:
        return "没成：ids 要写待办编号列表（比如 [3]）。", True
    bits, err = [], False
    if op == "claim":
        r = inbox.claim(ids, who, now, label=label)
        if r["claimed"]:
            bits.append("领取了：" + "、".join(f"待办 {i}" for i in r["claimed"]))
        if r["held"]:
            bits.append("别人在处理，领不走：" + "、".join(f"待办 {i}（{h}）" for i, h in r["held"].items()))
        if r["closed"]:
            bits.append("已经做完或过期了：" + "、".join(f"待办 {i}" for i in r["closed"]))
        err = not r["claimed"]
    elif op == "done":
        r = inbox.mark_done(ids, who, now)
        if r["done"]:
            bits.append("确认做完：" + "、".join(f"待办 {i}" for i in r["done"]))
        if r["already"]:
            bits.append("之前就做完或过期了：" + "、".join(f"待办 {i}" for i in r["already"]))
        if r["held"]:
            bits.append("别人在处理，没确认：" + "、".join(f"待办 {i}（{h}）" for i, h in r["held"].items()))
        if r["unclaimed"]:
            bits.append("还没领取，先用 op=claim 领取：" + "、".join(f"待办 {i}" for i in r["unclaimed"]))
        err = not r["done"] and not r["already"]
    else:
        got = inbox.release(ids, who, now)
        bits.append(("放回了：" + "、".join(f"待办 {i}" for i in got)) if got else "没有你领取着的这几件")
        err = not got
        r = {"unknown": []}
    if r.get("unknown"):
        bits.append("没有这几件：" + "、".join(str(i) for i in r["unknown"]))
    return "；".join(bits) + "。\n\n" + inbox.render_items(inbox.open_items("pull", now), who), err


def _exec_memory(args: dict, now: datetime):
    op = args.get("op") or "find"
    lead = "没写成" if op == "followup" else "没查成"
    try:
        pid = _int(args.get("plan"))
    except _BadArg as e:
        return f"{lead}：{e}。", True
    try:
        if op == "find":
            return memory.find(plan=pid, name=args.get("name"), place=args.get("place"),
                               d_from=args.get("from"), d_to=args.get("to")), False
        if op == "followup":
            if pid is None:
                return "没写成：plan 要写约会编号（整数）。", True
            text = memory.queue_followup(pid, args.get("text"), now=now)
            scheduler.kick()                       # 有调度者=马上写卡;没有=它下一轮写
            return text, False
    except memory.ToolError as e:
        return f"{lead}：{e}。", True
    return "没成：date_memory 的 op 只能是 find 或 followup。", True


def _memory_reveal(pids: list[int]) -> float | None:
    """date_memory 的结果只含已结束的约会:全部已结束=最晚的结束时刻;有一个不是(或读不出)=None(继续藏)。"""
    if not pids:
        return None
    conn = dp._connect()
    try:
        rows = {r["id"]: r for r in conn.execute(
            f"SELECT id, status, closed_at, updated_at FROM date_plans WHERE id IN ({','.join('?' * len(pids))})",
            pids)}
    finally:
        conn.close()
    if any(rows.get(p) is None or rows[p]["status"] != "done" for p in pids):
        return None
    return max((rows[p]["closed_at"] or rows[p]["updated_at"] or 0) for p in pids) or None


# ── 保密标记(给自建网关遮蔽用)────────────────────────────────────────────────────────
_PLAN_RE = re.compile(r"约会 #(\d+)")


def result_meta(name: str, args, text: str, now: datetime | None = None) -> dict:
    """Machine-readable secrecy marker for every tool result (MCP result _meta):
    ephemera/secret = true (the result may hold what she must not see yet);
    ephemera/reveal_after = epoch seconds from which all of it is public to her (the date was closed),
    or null = not known yet, keep it hidden; ephemera/plan_ids = the date(s) it is about."""
    a = args if isinstance(args, dict) else {}
    pid = None
    try:
        pid = _int(a.get("plan"))
    except _BadArg:
        pid = None
    if pid is None and name == TOOL_OPEN:
        m = _PLAN_RE.search(text or "")
        pid = int(m.group(1)) if m else None
    if name == TOOL_MEMORY:
        pids = [pid] if pid is not None else sorted({int(x) for x in _PLAN_RE.findall(text or "")})
        reveal = None
        try:
            reveal = _memory_reveal(pids)
        except Exception as e:  # noqa: BLE001 — a marker that cannot be computed stays "keep hidden"
            log.warning("[tools] result_meta: %r", e)
        return {"ephemera/secret": True, "ephemera/reveal_after": reveal, "ephemera/plan_ids": pids}
    reveal = None
    if pid is not None and name != TOOL_INBOX:
        try:
            snap = dp.snapshot(pid, now=now or _now())
            if snap is not None and snap["phase"] == "done":
                p = snap["state"]["plan"]
                reveal = p.get("closed_at") or p.get("updated_at")
        except Exception as e:  # noqa: BLE001 — a marker that cannot be computed stays "keep hidden"
            log.warning("[tools] result_meta: %r", e)
    return {"ephemera/secret": True, "ephemera/reveal_after": reveal,
            "ephemera/plan_ids": [pid] if pid is not None else []}


# ── date_route 查路(只查,不写约会)────────────────────────────────────────────────────
_LATLNG = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def _usage(kind: str, now: datetime) -> None:
    try:
        conn = dp._connect()
        try:
            conn.execute("INSERT INTO date_route_usage (day, kind, count) VALUES (?, ?, 1)"
                         " ON CONFLICT(day, kind) DO UPDATE SET count=count+1", (now.date().isoformat(), kind))
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001 — 记账失败不挡查询
        log.warning("[tools] route 记账失败: %r", e)


class _RouteErr(Exception):
    pass


async def _point(s: str) -> tuple[float, float]:
    m = _LATLNG.match(s or "")
    if m:
        return float(m.group(1)), float(m.group(2))
    places = await ports.aget("places")
    if places is None:
        raise _RouteErr("步行时间查不了：地点服务没有配置，from / to 写「纬度,经度」")
    try:
        got = await ports.acall(places.geocode, s)
    except (ports.PlaceError, ports.PortUnavailable) as e:
        raise _RouteErr(f"步行时间查不了：{e.text}") from None
    if not got:
        raise _RouteErr(f"找不到「{s}」这个地方")
    p = got[0]
    return float(p.lat), float(p.lng)


def _walk_failed(frm: str, to: str, text: str | None) -> str:
    text = (text or "步行路线服务没有给出时间").rstrip("。")
    # 「这段…」类原因接在起止后面读;其余(还没建底图等)单独一句
    return f"步行时间查不了：{frm} 到 {to} {text}。" if text.startswith("这段") else f"步行时间查不了，{text}。"


async def _route_walk(frm: str, to: str, now: datetime):
    try:
        router = await ports.aget("walk")
    except ports.PortUnavailable as e:
        return f"步行时间查不了：{e.text.rstrip('。')}。", True
    if router is None:
        return "步行时间查不了：步行路线服务没有配置。", True
    _usage("walk", now)
    try:
        o = await _point(frm)
        d = await _point(to)
        res = await ports.acall(router.walk, o, d)
    except _RouteErr as e:
        return str(e) + "。", True
    except ports.NoRoadData as e:
        return _walk_failed(frm, to, e.text), True
    except (ports.PlaceError, ports.PortUnavailable) as e:
        return f"步行时间查不了：{e.text.rstrip('。')}。", True
    except Exception as e:  # noqa: BLE001
        log.warning("[tools] walk 调用失败: %r", e)
        return "步行时间查不了：步行路线服务出错了。", True
    if getattr(res, "minutes", None) is None:          # 原因原样带回,不退直线冒充
        return _walk_failed(frm, to, getattr(res, "reason_text", None)), True
    mins = max(1, int(res.minutes))
    dist_m = getattr(res, "meters", None)
    dist = ""
    if dist_m is not None:
        dist_m = float(dist_m)
        dist = "，" + (f"{int(round(dist_m / 10.0) * 10)} 米" if dist_m < 1000 else f"{dist_m / 1000:.1f} 公里")
    unv = getattr(res, "unverified_connector_m", None)
    note = f"（有一段 {int(unv)} 米没有核实能走）" if unv else ""
    ferry = getattr(res, "ferry", None) or ()
    if ferry:
        note += (f"（含轮渡 {len(ferry)} 段，坐船加等船约 {sum(int(x['minutes']) for x in ferry)} 分钟，"
                 f"已算进总时间；船期按你知道的核对）")
    return (f"步行：{frm} → {to} 大约 {mins} 分钟{dist}{note}。"
            f"确认后用 date_edit 的 set_leg 写进去（核对过可以写 source=checked）。"), False


async def _exec_route(args: dict, now: datetime):
    mode, frm, to = args.get("mode"), str(args.get("from") or "").strip(), str(args.get("to") or "").strip()
    if not frm or not to:
        return "查不了：from 和 to 都要写（地名或「纬度,经度」）。", True
    if mode == "walk":
        return await _route_walk(frm, to, now)
    return "查不了：mode 只能是 walk。", True


# ── 挂载面 ─────────────────────────────────────────────────────────────────────────
_SYNC = {TOOL_OPEN: _exec_open, TOOL_VIEW: _exec_view, TOOL_EDIT: _exec_edit, TOOL_SEND: _exec_send,
         TOOL_LIVE: _exec_live, TOOL_CLOSE: _exec_close, TOOL_MEMORY: _exec_memory}


def inbox_tail(now: datetime) -> str:
    """每个工具回执末尾的待办数(AI 待办通道的「拉」)。"""
    try:
        n = inbox.count_open(now)
    except Exception as e:  # noqa: BLE001 — 数不出来不挡回执
        log.warning("[tools] 待办计数失败: %r", e)
        return ""
    return f"\n\n（约会待办 {n} 件" + ("，用 date_inbox 查看）" if n else "）")


def _record_pull(now: datetime) -> None:
    try:
        inbox.record_use("pull", now)
    except Exception as e:  # noqa: BLE001
        log.warning("[tools] 记录工具调用失败: %r", e)


def call_sync(name: str, args, session: str | None = None, label: str | None = None) -> tuple[str, bool]:
    """同步工具(除 date_route 外全部)。→ (回执文字, is_error)。"""
    a = args if isinstance(args, dict) else {}
    if name == TOOL_MEMORY and not a.get("op"):
        a = {**a, "op": "find"}                    # op 默认 find(字段归属照 find 查)
    now = _now()
    _record_pull(now)
    stray = _stray_fields(name, a)                 # 写错字段名不许静默丢:整笔不做,回执说清
    if stray:
        return stray + inbox_tail(now), True
    try:
        text, err = _exec_inbox(a, now, session, label) if name == TOOL_INBOX else _SYNC[name](a, now)
    except _BadArg as e:
        text, err = f"没改成：{e}。", True
    except Exception as e:  # noqa: BLE001 — 回执说清,不冒成静默失败
        log.warning("[tools] %s 执行失败: %r", name, e, exc_info=True)
        text, err = (f"没成：{name} 执行出错（{type(e).__name__}），约会库暂时不可用。"
                     "先用 date_view 看一眼现状再决定要不要重做。", True)
    if name == TOOL_INBOX:
        return text, err
    return text + inbox_tail(now), err


async def call(name: str, args, session: str | None = None, label: str | None = None) -> tuple[str, bool]:
    """MCP 入口:同步工具放线程里跑(库锁等待不堵事件循环),date_route 直接 await。"""
    import asyncio
    if name not in TOOLS:
        return f"没有 {name} 这个工具。", True
    if name == TOOL_ROUTE:
        a = args if isinstance(args, dict) else {}
        now = _now()
        await asyncio.to_thread(_record_pull, now)
        stray = _stray_fields(name, a)
        if stray:
            text, err = stray, True
        else:
            text, err = await _exec_route(a, now)
        return text + await asyncio.to_thread(inbox_tail, now), err
    return await asyncio.to_thread(call_sync, name, args, session, label)
