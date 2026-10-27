"""How the engine refers to the two of you (EPHEMERA_HER / EPHEMERA_HIM): every text the engine writes uses them.

Default (unset) = the original sentences, word for word. Set = only the two names change, the rest of each
sentence stays as it was. Text written by the AI or by her is never touched. tmp data dir, no network.
"""
from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from conftest import TZ
from ephemera_date import config, inbox, outlet
from ephemera_date import plan as dp
from ephemera_date import tools as dt

NOW = datetime(2026, 10, 20, 10, 0, tzinfo=TZ)
DAY = "2026-10-28"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setattr(dt, "_now", lambda: NOW)
    dp._connect().close()


def _custom(monkeypatch):
    monkeypatch.setenv("EPHEMERA_HER", "你")
    monkeypatch.setenv("EPHEMERA_HIM", "Ta")


def _call(name, **args):
    text, err = asyncio.run(dt.call(name, args))
    assert not err, text
    return text


def _sent_plan(note="到了先喝一杯"):
    pid = int(_call("date_open", title_en="Night", date=DAY, color="rose").split("#", 1)[1].split("。", 1)[0])
    _call("date_edit", plan=pid, op="add_stop", kind="cafe", time="19:00", title="咖啡馆", address="某路 1 号",
          clue="门口有棵树", note=note, reveal_at="17:30")
    _call("date_edit", plan=pid, op="set_prep", items=[{"section": "bring", "text": "伞"}])
    return pid, _call("date_send", plan=pid)


def _backfill():
    body = {"date": "2026-05-03", "title_en": "Spring", "color": "sky", "client_id": "c-1",
            "stops": [{"kind": "cafe", "time": "12:00", "title": "古城", "lat": 35.70, "lng": 139.70}]}
    return dp.her_backfill(body, now=NOW)


def _his_field_refusal(v):
    with pytest.raises(dp.HerEditError) as e:
        dp.her_edit(v["id"], [{"op": "update_stop", "stop_id": dp.snapshot(v["id"], now=NOW)["state"]["stops"][0]["id"], "clue": "x"}], now=NOW)
    return e.value.text


def test_who_only_swaps_the_two_names(monkeypatch):
    assert config.who("她请你补写，他写好了，其他方式") == "她请你补写，他写好了，其他方式"
    _custom(monkeypatch)
    assert config.who("她请你补写，他写好了，其他方式") == "你请你补写，Ta写好了，其他方式"
    assert config.her() == "你" and config.him() == "Ta"


def test_default_texts_are_the_original_sentences():
    pid, sent = _sent_plan()
    assert sent.startswith("寄出了，她收到了信封。")
    view = _call("date_view", plan=pid)
    assert "  到站给她的话：到了先喝一杯（到站后她能看到）" in view
    assert "  线索：门口有棵树（她随时能点开）" in view
    assert "准备清单（她已能看到）：" in view
    assert "她现在能看到：" in view
    assert outlet.web_payload({"kind": "late_written", "title": "x", "navigate": {}, "event_id": 1})["title"] == "他写好了"
    assert outlet.push_text("late_written", {"name": "N", "title_en": "N", "date": DAY})[0] == "他写好了"
    v = _backfill()
    bid = v["id"]
    assert _his_field_refusal(v).endswith("线索（clue）是他写的，原样留着，不能改")
    line = dp.request_write_line({"id": bid, "origin": "her", "date": "2026-05-03", "title_en": "Spring"}, ["card"])
    assert "她请你补写约会 #" in line and "，她补记的）" in line and line.endswith("用 date_view 打开这次约会看她写的内容。")
    rows = [{"id": 1, "kind": "write_request", "holder": None, "created_at": NOW.timestamp(), "current": "x"}]
    assert "· 她请你补写（可领取）" in inbox.render_items(rows)


def test_custom_names_replace_only_the_names(monkeypatch):
    _custom(monkeypatch)
    pid, sent = _sent_plan(note="他说她会喜欢")          # the AI's own words: never rewritten
    assert sent.startswith("寄出了，你收到了信封。")
    view = _call("date_view", plan=pid)
    assert "  到站给你的话：他说她会喜欢（到站后你能看到）" in view
    assert "  线索：门口有棵树（你随时能点开）" in view
    assert "准备清单（你已能看到）：" in view
    assert "你现在能看到：" in view and "她现在能看到" not in view
    assert outlet.web_payload({"kind": "late_written", "title": "x", "navigate": {}, "event_id": 1})["title"] == "Ta写好了"
    assert outlet.push_text("late_written", {"name": "N", "title_en": "N", "date": DAY})[0] == "Ta写好了"
    v = _backfill()
    bid = v["id"]
    assert _his_field_refusal(v).endswith("线索（clue）是Ta写的，原样留着，不能改")
    line = dp.request_write_line({"id": bid, "origin": "her", "date": "2026-05-03", "title_en": "Spring"}, ["card"])
    assert "你请你补写约会 #" in line and "，你补记的）" in line and line.endswith("用 date_view 打开这次约会看你写的内容。")
    rows = [{"id": 1, "kind": "write_request", "holder": None, "created_at": NOW.timestamp(), "current": "x"}]
    assert "· 你请你补写（可领取）" in inbox.render_items(rows)
    with pytest.raises(dp.HerEditError) as e:
        monkeypatch.setenv("EPHEMERA_AI_CHANNELS", "none")
        dp.her_request_write(bid, "req-1", now=NOW)
    assert e.value.text == "还没有接好通知Ta的路，请Ta补写的请求没人收得到"


def test_custom_names_reach_errors_and_field_labels(monkeypatch):
    _custom(monkeypatch)
    assert dt._zh("date_edit", "note") == "到站给你的话"
    with pytest.raises(dp.DateError) as e:
        dp._guard_terminal(1, "done")
    assert "只有你补记的约会有" in str(e.value.items[0]["text"]) and "某站你给你的话" in e.value.items[0]["text"]


# ── English names (EPHEMERA_HER_EN / EPHEMERA_HIM_EN): only handed to the page, next to the Chinese ones ──────────
def test_english_names_default_her_him_in_api_config(api):
    from conftest import H
    cfg = api.get("/api/config", headers=H()).json()
    assert (cfg["her"], cfg["him"], cfg["her_en"], cfg["him_en"]) == ("她", "他", "Her", "Him")


def test_english_names_are_configured_apart_from_the_chinese_ones(api, monkeypatch):
    from conftest import H
    monkeypatch.setenv("EPHEMERA_HER", "你")
    monkeypatch.setenv("EPHEMERA_HER_EN", " Mia ")
    monkeypatch.setenv("EPHEMERA_HIM_EN", "Leo")
    cfg = api.get("/api/config", headers=H()).json()
    assert (cfg["her"], cfg["him"], cfg["her_en"], cfg["him_en"]) == ("你", "他", "Mia", "Leo")
    monkeypatch.setenv("EPHEMERA_HIM_EN", "   ")                    # blank = default
    assert api.get("/api/config", headers=H()).json()["him_en"] == "Him"


def test_english_names_do_not_change_engine_written_chinese(monkeypatch):
    monkeypatch.setenv("EPHEMERA_HER_EN", "Mia")
    monkeypatch.setenv("EPHEMERA_HIM_EN", "Leo")
    assert config.who("她补记的，他来回信") == "她补记的，他来回信"
