"""· 约会工具字段归属:写错字段名不许静默丢。

他 add_stop 传 place(本意=地点名)→ 引擎只取 title,place 静默丢,回「改好了」却四站地点名全空;
update_stop 只传 place/hint → 「没有要改的字段」却不说该用哪个。修法=工具外壳按 op 登记认的字段,
不认且有值 = 整笔不做 + 回执说清。临时库(conftest)、假时钟、禁网络。
"""
from __future__ import annotations

import asyncio
import re
from datetime import datetime

import httpx
import pytest

from conftest import local_client, local_tools
from ephemera_date import config
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from conftest import TZ

NOW0 = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    assert str(tmp_path) in config.db_path()
    monkeypatch.setattr(dt, "_now", lambda: NOW0)

    dp._connect().close()


T = local_tools()


def call(name, **args):
    out = T[name](args)
    if asyncio.iscoroutine(out):
        out = asyncio.run(out)
    return out


def _plan() -> int:
    text, err = call("date_open", title_en="EMPTY STOMACH\nFULL MOON", date=DAY, color="rose")
    assert not err, text
    return int(re.search(r"约会 #(\d+)", text).group(1))


def _stops(pid):
    return dp.snapshot(pid, now=NOW0)["state"]["stops"]


# ── 他报的两条原样复现 ────────────────────────────────────────────────────────────
def test_add_stop_place_rejected_not_silently_dropped():
    pid = _plan()
    text, err = call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30", place="小巷的粥屋")
    assert err
    assert "不认 place" in text and "place 不是 date_edit 的 add_stop 的字段" in text and "用 title" in text
    assert "add_stop 能写的字段" in text and "title 地点名" in text
    assert _stops(pid) == []                                   # 整笔没生效


def test_update_stop_place_hint_points_to_title_clue():
    pid = _plan()
    assert not call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30")[1]
    sid = _stops(pid)[0]["id"]
    text, err = call("date_edit", plan=pid, op="update_stop", stop_id=sid, place="粥屋", hint="白い湯気")
    assert err
    assert "用 title" in text and "用 clue" in text
    s = _stops(pid)[0]
    assert s["title"] is None and s["clue"] is None


def test_right_names_store_title_address_clue():
    pid = _plan()
    text, err = call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30",
                     title="粥屋", address="南湖区小巷1-1", clue="白い湯気")
    assert not err, text
    sid = _stops(pid)[0]["id"]
    assert not call("date_edit", plan=pid, op="update_stop", stop_id=sid, title="粥屋 本店")[1]
    s = _stops(pid)[0]
    assert (s["title"], s["address"], s["clue"]) == ("粥屋 本店", "南湖区小巷1-1", "白い湯気")


def test_empty_stray_values_pass():
    """schema 是并集,带上空的别家字段不算写错——没有内容,丢了也没丢东西。"""
    pid = _plan()
    text, err = call("date_edit", plan=pid, op="add_stop", kind="cafe", time="15:30", title="粥屋",
                     place="", hint=None, items=[], photo={})
    assert not err, text
    assert _stops(pid)[0]["title"] == "粥屋"


def test_other_tools_and_ops_checked_too():
    pid = _plan()
    text, err = call("date_edit", plan=pid, op="set_basic", title_en="A", quote="x")
    assert err and "set_basic 不认 quote" in text and "date_close" not in text   # 只列本工具的 op
    text, err = call("date_close", plan=pid, quote="q", text="x")
    assert err and "date_close 不认 text" in text
    text, err = call("date_live", plan=pid, op="telegram", telegram="到了吗")
    assert err and "用 text" in text
    text, err = call("date_open", title_en="B", date=DAY, color="rose", stop_id=1)
    assert err and text.startswith("没开成")


def test_bad_op_left_to_engine():
    pid = _plan()
    text, err = call("date_edit", plan=pid, op="rename", place="x")
    assert err and "op 只能是" in text


# ── 登记表与 schema / 引擎不许漂 ─────────────────────────────────────────────────────
def _props():
    return {t["name"]: set(t["input_schema"]["properties"]) for t in dt.tool_schemas()}


def test_registry_covers_every_op():
    assert set(dt._OP_FIELDS[dt.TOOL_EDIT]) == set(dp.EDIT_OPS)
    assert set(dt._OP_FIELDS[dt.TOOL_LIVE]) == set(dp.LIVE_OPS)
    assert set(dt._OP_FIELDS) == set(dt.TOOLS)


def test_registry_matches_schema_both_ways():
    props = _props()
    for tool, table in dt._OP_FIELDS.items():
        owned = set().union(*table.values()) | set(dt._TOOL_COMMON[tool])
        assert owned <= props[tool], (tool, owned - props[tool])            # 登记的都在 schema 里
        assert props[tool] <= owned, (tool, props[tool] - owned)            # schema 里没有无主字段


def test_nested_keys_match_engine():
    assert set(dt._NESTED["steps"]) == set(dp._STEP_KEYS)
    assert set(dt._NESTED["legs"]) == {"to_stop", *dt._LEG_F}


def test_stop_fields_match_engine():
    assert set(dt._STOP_F) == set(dp._STOP_FIELDS)
    for op in ("add_stop", "update_stop"):
        assert set(dp._STOP_FIELDS) <= set(dt._OP_FIELDS[dt.TOOL_EDIT][op])


def test_every_field_has_label():
    for tool, table in dt._OP_FIELDS.items():
        for ks in table.values():
            for k in ks:
                assert dt._zh(tool, k), (tool, k)


# ── 补:嵌套 / 公共键按工具 / 契约书双入口 / 按工具的字段名 ───────────────────────
def _two_stops(pid):
    for t in ("15:30", "16:15"):
        assert not call("date_edit", plan=pid, op="add_stop", kind="cafe", time=t, title="x")[1]
    return [s["id"] for s in _stops(pid)]


def test_legs_nested_stray_rejected():
    pid = _plan()
    a, b = _two_stops(pid)
    text, err = call("date_edit", plan=pid, op="add_stop", kind="walk", time="17:00", title="y",
                     legs=[{"to_stop": b, "mode": "walk", "hint": "路线说明"}])
    assert err and "legs[0].hint" in text and "legs 里每一项能写" in text
    assert len(_stops(pid)) == 2
    text, err = call("date_edit", plan=pid, op="set_leg", to_stop=b, mode="train",
                     steps=[{"line": "山手線", "platform": "3"}])
    assert err and "steps[0].platform" in text
    text, err = call("date_edit", plan=pid, op="move_stop", stop_id=b, to=1,
                     legs=[{"to_stop": a, "mode": "walk", "steps": [{"line": "x", "gate": "东口"}]}])
    assert err and "legs[0].steps[0].gate" in text


def test_prep_items_nested():
    pid = _plan()
    text, err = call("date_edit", plan=pid, op="set_prep", items=[{"section": "bring", "text": "伞", "qty": 1}])
    assert err and "items[0].qty" in text
    assert not call("date_edit", plan=pid, op="set_prep", items=[{"section": "bring", "text": "伞"}])[1]


def test_common_keys_per_tool():
    pid = _plan()
    text, err = call("date_view", plan=pid, next="x")
    assert err and "next" in text
    text, err = call("date_open", title_en="B", date=DAY, color="rose", expect_version=5)
    assert err and "expect_version" in text
    assert not call("date_view", plan=pid)[1]


def test_contract_two_entrances_conflict():
    pid = _plan()
    text, err = call("date_edit", plan=pid, op="set_contract", contract=None, items=["不许看手机"])
    assert err and "只写一个" in text
    assert dp.snapshot(pid, now=NOW0)["state"]["plan"]["contract"] is None
    assert not call("date_edit", plan=pid, op="set_contract", contract=["不许看手机"])[1]
    assert not call("date_edit", plan=pid, op="set_contract", items=["不许看手机"])[1]


def test_labels_per_tool():
    text, err = call("date_route", mode="walk", **{"from": "新宿", "to": "大久保"}, via="x")
    assert err and "to 终点" in text and "挪到第几站" not in text
    pid = _plan()
    text, err = call("date_live", plan=pid, op="telegram", text="到了吗", stop_id=1)
    assert err and "text 电报正文" in text
