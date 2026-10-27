"""(随后改拍):约会名分英文名、中文名两格。英文名必须;中文名可选,永远是英文名下面的小字。

验收:display_name 两种情况(只英文 / 两个都有)与「只有中文」被拒;title_en 含中日文被拒且原因清楚;
补记/寄出/改名不能让英文名为空;投影带 title_zh;推送与电报按规则显示名字;事件卡关键词含中文名、改名后后续段不丢。
全部临时库 + 临时 vault(conftest 钉 tmp)、假时钟、禁网络。
"""
from __future__ import annotations

import asyncio
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

from conftest import local_client, local_tools
from ephemera_date import config
from ephemera_date import outlet
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from conftest import TZ

NOW = datetime(2026, 10, 23, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"
CJK_TXT = "英文名这一格只写英文；中文名写在 title_zh"            # 他的工具回执
CJK_HER = "英文名这一格只写英文，中文名写在下面一格"              # 她的补记/PATCH
SENTENCE = "约会可以再起一个中文名 title_zh（可选），在她那边显示成英文名下面的小字；英文名必写。"


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    assert str(tmp_path) in config.db_path()
    monkeypatch.setattr(dt, "_now", lambda: NOW)
    monkeypatch.setattr(dp, "_now", lambda: NOW)

    dp._connect().close()
    yield


TOOLS = local_tools()


def call(name, **args):
    out = TOOLS[name](args)
    if asyncio.iscoroutine(out):
        out = asyncio.run(out)
    return out


def ok(r):
    assert r["ok"], r["errors"]
    return r


def fail(r, code):
    assert not r["ok"], r
    assert code in [e["code"] for e in r["errors"]], r["errors"]
    return r


def ready_plan(title_en="First\nRain", title_zh=None, send=False):
    pid = ok(dp.open_plan(title_en, DAY, "rose", title_zh=title_zh, now=NOW))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="a", clue="c",
                                        reveal_at="17:30"), now=NOW))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "伞"}]), now=NOW))
    if send:
        ok(dp.send(pid, now=NOW))
    return pid


# ── 主副名唯一函数 ────────────────────────────────────────────────────────────────────────
def test_display_name_rules():
    assert dp.display_name({"title_en": "First\nRain", "title_zh": ""}) == ("First Rain", "")
    assert dp.display_name({"title_en": "First Rain", "title_zh": "眼镜大作"}) == ("First Rain", "眼镜大作")
    assert dp.full_name({"title_en": "First Rain", "title_zh": "眼镜大作"}) == "First Rain（眼镜大作）"
    assert dp.full_name({"title_en": "First Rain", "title_zh": None}) == "First Rain"
    # 中文永远是副名:没有英文名时不会被当成主名
    assert dp.display_name({"title_en": "", "title_zh": "眼镜大作"})[0] == ""
    assert dp.full_name({"title_en": "", "title_zh": "眼镜大作"}) == ""


def test_only_chinese_is_rejected_everywhere():
    fail(dp.open_plan("", DAY, "rose", title_zh="眼镜大作", now=NOW), "need_title_en")
    fail(dp.open_plan(None, DAY, "rose", title_zh="眼镜大作", now=NOW), "need_title_en")
    pid = ready_plan(title_zh="眼镜大作")
    fail(dp.edit(pid, "set_basic", {"title_en": ""}, now=NOW), "need_title_en")
    t, err = call("date_open", title_zh="眼镜大作", date=DAY, color="rose")
    assert err and "英文名不能空着" in t
    with pytest.raises(dp.HerEditError) as e:
        dp.her_backfill({"client_id": "z-1", "date": "2026-05-03", "title_zh": "眼镜大作", "color": "sky",
                         "stops": [{"kind": "cafe", "title": "喫茶"}]}, now=NOW)
    assert e.value.status == 400 and e.value.field == "title_en" and "英文名" in e.value.text
    v = dp.her_backfill({"client_id": "z-2", "date": "2026-05-03", "title_en": "Spring", "color": "sky",
                         "stops": [{"kind": "cafe", "title": "喫茶"}]}, now=NOW)
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(v["id"], [{"op": "set_plan", "title_en": "", "title_zh": "春"}], now=NOW)
    assert e.value.field == "title_en"


def test_legacy_empty_title_en_cannot_be_sent():
    pid = ready_plan()
    c = sqlite3.connect(config.db_path())
    c.execute("UPDATE date_plans SET title_en='' WHERE id=?", (pid,))
    c.commit()
    c.close()
    assert any(m["code"] == "no_title" for m in dp.snapshot(pid, now=NOW)["check"]["missing"])
    fail(dp.send(pid, now=NOW), "send_no_title")


@pytest.mark.parametrize("bad", ["First 雨", "はじめて", "First、Rain", "ＦＩＲＳＴ"])
def test_title_en_with_cjk_rejected_with_reason(bad):
    r = fail(dp.open_plan(bad, DAY, "rose", now=NOW), "cjk_title_en")
    assert r["errors"][0]["text"] == CJK_TXT
    pid = ready_plan()
    fail(dp.edit(pid, "set_basic", {"title_en": bad}, now=NOW), "cjk_title_en")
    with pytest.raises(dp.HerEditError) as e:
        dp.her_backfill({"client_id": "c-" + bad, "date": "2026-05-03", "title_en": bad, "color": "sky",
                         "stops": [{"kind": "cafe", "title": "喫茶"}]}, now=NOW)
    assert e.value.field == "title_en" and e.value.text == CJK_HER and e.value.code == "cjk_title_en"
    v = dp.her_backfill({"client_id": "ok-" + bad, "date": "2026-05-03", "title_en": "Ok", "color": "sky",
                         "stops": [{"kind": "cafe", "title": "喫茶"}]}, now=NOW)
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(v["id"], [{"op": "set_plan", "title_en": bad}], now=NOW)
    assert e.value.field == "title_en" and e.value.text == CJK_HER and e.value.code == "cjk_title_en"


def test_title_zh_limits():
    fail(dp.open_plan("Rain", DAY, "rose", title_zh="字" * 21, now=NOW), "long_title_zh")
    fail(dp.open_plan("Rain", DAY, "rose", title_zh="眼镜\n大作", now=NOW), "bad_title_zh")
    ok(dp.open_plan("Rain", DAY, "rose", title_zh="字" * 20, now=NOW))


# ── 她的读口 / 推送 / 电报 ───────────────────────────────────────────────────────────────
def test_projection_carries_title_zh_raw():
    a = ready_plan(title_zh="眼镜大作", send=True)
    b = ready_plan(title_en="Night Walk", send=True)
    views = {v["id"]: v for v in dp.her_plans(now=NOW)}
    assert (views[a]["title_en"], views[a]["title_zh"]) == ("First\nRain", "眼镜大作")
    assert (views[b]["title_en"], views[b]["title_zh"]) == ("Night Walk", "")


def test_push_and_telegram_use_full_name():
    pid = ready_plan(send=True)
    plan = {"title_en": "First\nRain", "title_zh": "眼镜大作", "date": DAY}
    assert outlet.push_text("telegram_auto", plan) == ("有一封新电报", "「First Rain（眼镜大作）」")
    assert outlet.push_text("close", {**plan, "title_zh": ""})[1] == "「First Rain」"
    r = ok(dp.edit(pid, "set_basic", {"title_zh": "眼镜大作"}, now=NOW))
    texts = [e["text"] for e in dp.her_events(pid, now=NOW) if e["id"] in r["events"]]
    assert texts == ["名字改了：「First Rain」 → 「First Rain（眼镜大作）」"]
    sent = []
    outlet.sweep(lambda payload: sent.append(payload) or "sent")          # 推送扫描真读库里的名字(带中文名)
    assert [(x["title"], x["body"]) for x in sent if x["event_id"] == r["events"][0]] == [("有一封新电报", "「First Rain（眼镜大作）」")]


def test_his_views_use_full_name():
    pid = ready_plan(title_zh="眼镜大作")
    t, err = call("date_view", plan=pid)
    assert not err and t.splitlines()[0].startswith(f"约会 #{pid} 「First Rain（眼镜大作）」")
    t, err = call("date_view")
    assert f"#{pid} First Rain（眼镜大作） · 10/28" in t
    t, err = call("date_open", title_en="Moon", title_zh="月亮", date=DAY, color="sky")
    assert not err and "「Moon（月亮）」" in t
    v = dp.her_backfill({"client_id": "s-1", "date": "2026-05-03", "title_en": "Spring", "title_zh": "春天",
                         "color": "sky", "stops": [{"kind": "cafe", "title": "喫茶"}]}, now=NOW)
    led, _ = dt.ledger_block(NOW)
    assert "· 5/3 「Spring（春天）」 她补记了这次约会（1 站）" in led and "书架：1 次（最近：「Spring（春天）」5/3）" in led
    dp.her_edit(v["id"], [{"op": "set_plan", "title_zh": "春雨"}], now=NOW)
    assert "她把中文名从「春天」改成「春雨」" in dt.ledger_block(NOW)[0]


def test_tool_schema_and_sentence():
    o = next(x for x in dt.tool_schemas() if x["name"] == "date_open")
    assert SENTENCE in o["description"] and "title_zh" in o["input_schema"]["properties"]
    assert o["input_schema"]["required"] == ["title_en", "date", "color"]
    e = next(x for x in dt.tool_schemas() if x["name"] == "date_edit")
    assert "title_zh" in e["input_schema"]["properties"]
    pid = ready_plan()
    t, err = call("date_edit", plan=pid, op="set_basic", title_zh="眼镜大作")
    assert not err and "First Rain（眼镜大作）" in t


@pytest.mark.parametrize("good", ["First 〰️", "First 〽️", "Café", "Rain's Day", "Rain 🌧️", "Naïve Señor"])
def test_title_en_allows_symbols_emoji_and_latin_extended(good):
    ok(dp.open_plan(good, DAY, "rose", now=NOW))


@pytest.mark.parametrize("bad", ["Rain 𠮷", "Rain 𠀀", "Rain 한글", "Rain ㄅ", "Rain　Day"])
def test_title_en_rejects_extension_and_other_cjk(bad):
    assert fail(dp.open_plan(bad, DAY, "rose", now=NOW), "cjk_title_en")["errors"][0]["text"] == CJK_TXT


@pytest.mark.parametrize("sep", ["\u0085", " ", " ", "\r", "\x0b"])
def test_line_breaks_other_than_newline_rejected(sep):
    fail(dp.open_plan("Rain", DAY, "rose", title_zh=f"眼镜{sep}大作", now=NOW), "bad_title_zh")
    fail(dp.open_plan(f"First{sep}Rain", DAY, "rose", now=NOW), "bad_title_en")
    ok(dp.open_plan("First\nRain", DAY, "rose", now=NOW))          # 英文名两行只认 \n


def test_real_old_table_without_title_zh_migrates(tmp_path):
    db = str(tmp_path / "old.db")
    cols = [c for c in dp._TABLES["date_plans"]["cols"] if c[0] != "title_zh"]
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE date_plans (" + ", ".join(f"{n} {d}" for n, d, _ in cols) + ")")
    c.execute("INSERT INTO date_plans (title_en, date, color) VALUES ('Old', '2026-01-01', 'rose')")
    c.commit()
    c.close()
    conn = dp._connect(db)
    try:
        assert [tuple(r) for r in conn.execute("SELECT title_en, title_zh FROM date_plans")] == [("Old", "")]
        dp.ensure_schema(conn)
    finally:
        conn.close()


def test_ledger_does_not_leak_active_plan_names():
    ready_plan(title_en="Secret Night", title_zh="秘密之夜")
    led, _ = dt.ledger_block(NOW)
    assert led and "秘密之夜" not in led and "Secret Night" not in led


def test_her_set_plan_empty_title_zh_removes_it():
    v = dp.her_backfill({"client_id": "rm-1", "date": "2026-05-03", "title_en": "Spring", "title_zh": "春天",
                         "color": "sky", "stops": [{"kind": "cafe", "title": "喫茶"}]}, now=NOW)
    v = dp.her_edit(v["id"], [{"op": "set_plan", "title_zh": "  "}], now=NOW)
    assert v["title_zh"] == "" and v["title_en"] == "Spring"
    c = sqlite3.connect(config.db_path())
    try:
        rows = c.execute("SELECT text, detail_json FROM date_events WHERE plan_id=? AND kind='her_edit'",
                         (v["id"],)).fetchall()
    finally:
        c.close()
    assert rows[0][0] == "她把中文名从「春天」改成无"
    import json as _j
    assert _j.loads(rows[0][1])["after"] == {"title_en": "Spring", "title_zh": ""}
    v = dp.her_edit(v["id"], [{"op": "set_plan", "title_zh": "春雨"}], now=NOW)
    assert v["title_zh"] == "春雨"
    t, _ = call("date_view", plan=v["id"])
    assert "她把中文名从无改成「春雨」" in t



def test_halfwidth_symbols_allowed_but_halfwidth_kana_rejected():
    """半角箭头 ￩ ￫ 是符号,放行;半角片假名 ｱ、全角字母 Ａ、全角符号 ￥ 仍算中日文。"""
    assert not dp.is_cjk_char("\uffe9") and not dp.is_cjk_char("\uffeb")
    assert dp.is_cjk_char("\uff71") and dp.is_cjk_char("\uff21") and dp.is_cjk_char("\uffe5")


