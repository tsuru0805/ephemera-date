"""Open itinerary (不藏行程) + photos not tied to a stop + her letter and his reply.

tmp data dir, fake clock (explicit now), no network; dates are built through the engine's public writes.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime

import pytest

from conftest import local_client, local_tools
from ephemera_date import config
from ephemera_date import her as date_her
from ephemera_date import plan as dp
from ephemera_date import tools as dt
from conftest import TZ

JPG = b"\xff\xd8\xff\xe0" + b"0" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def T(m, d, h=12, mi=0):
    return datetime(2026, m, d, h, mi, tzinfo=TZ)


NOW0 = T(10, 20, 10)


def ok(r):
    assert r["ok"], r["errors"]
    return r


def _her_client():
    return local_client()


def make_plan(open_itinerary=None, send=True):
    """两站:集合 19:00(17:30 公开)→ 晚餐 19:30(步行,19:20 出发,20:10 才有默认公开——没写 reveal_at)。"""
    kw = {} if open_itinerary is None else {"open_itinerary": open_itinerary}
    pid = ok(dp.open_plan("The Evening\nScreening", "2026-10-28", "rose", now=NOW0, **kw))["plan_id"]
    ok(dp.edit(pid, "add_stop", dict(kind="train", time="19:00", title="梧桐站", address="青石区梧桐路3",
                                        clue="改札右手边", reveal_at="17:30", note="我会早到",
                                        lat=35.6440, lng=139.6988), now=NOW0))
    ok(dp.edit(pid, "add_stop", dict(kind="dinner", time="19:30", title="Le Petit Pot", address="青石区柳岸1",
                                        clue="河边的小门", note="点你想吃的", lat=35.6425, lng=139.7003), now=NOW0))
    st = dp.snapshot(pid, now=NOW0)["state"]["stops"]
    s1, s2 = [s["id"] for s in st]
    ok(dp.edit(pid, "set_leg", dict(to_stop=s2, mode="walk", minutes=6, depart_time="19:20"), now=NOW0))
    ok(dp.edit(pid, "set_prep", dict(items=[{"section": "bring", "text": "一件薄外套"}]), now=NOW0))
    if send:
        ok(dp.send(pid, now=NOW0))
    return pid, (s1, s2)


def close(pid, now=None):
    ok(dp.close(pid, "那天很好", now=now or T(10, 28, 23, 30)))


# ══════════════  不藏行程 ══════════════════════════════════════════════════════
def test_open_itinerary_default_false_hidden_behaviour_unchanged():
    """默认(不传/false)=藏:行为与改动前一字不改——寄出即发,第 2 站地点此刻不可见。"""
    pid, (s1, s2) = make_plan()
    v = dp.her_plan(pid, now=NOW0)
    assert v["open_itinerary"] is False
    s2v = next(x for x in v["stops"] if x["stop_id"] == s2)
    assert s2v["place"] is None                       # 没到公开时刻,藏着


def test_open_itinerary_sent_but_not_opened_still_hidden():
    """true=不藏,但她还没按「拆开」:和藏的约会一样逐站到点,第 2 站地点此刻不可见(她要的是拆开后才看到)。"""
    pid, (s1, s2) = make_plan(open_itinerary=True)
    v = dp.her_plan(pid, now=NOW0)
    assert v["open_itinerary"] is True and v["opened_at"] is None
    s2v = next(x for x in v["stops"] if x["stop_id"] == s2)
    assert s2v["place"] is None and s2v["note"] is None


def test_open_itinerary_true_reveals_all_stops_once_opened():
    """true=不藏:她按「拆开」(her_open)那一刻起,全部站地点/到站的话/线索/怎么去一起可见,不必等各站各自到点。"""
    pid, (s1, s2) = make_plan(open_itinerary=True)
    v = dp.her_open(pid, now=NOW0)
    assert v["open_itinerary"] is True and v["opened_at"] == NOW0.timestamp()
    for sid in (s1, s2):
        sv = next(x for x in v["stops"] if x["stop_id"] == sid)
        assert sv["place"] is not None, f"stop {sid} 没有一起公开"
        assert sv["note"] and sv["clue"]
    s2v = next(x for x in v["stops"] if x["stop_id"] == s2)
    assert s2v["place"]["leg"] is not None             # 怎么去也一起给
    assert dp.her_plan(pid, now=NOW0)["stops"][1]["place"] is not None   # 之后的读口照样全开


def test_her_open_records_first_time_only_and_hidden_plan_unchanged():
    """只记第一次;藏行程的约会记了拆开也照旧逐站到点(藏/不藏两种行为不混)。"""
    pid, (s1, s2) = make_plan()
    dp.her_open(pid, now=NOW0)
    v = dp.her_open(pid, now=T(10, 21))
    assert v["opened_at"] == NOW0.timestamp()
    assert next(x for x in v["stops"] if x["stop_id"] == s2)["place"] is None


def test_her_open_draft_or_missing_is_none():
    pid, _ = make_plan(open_itinerary=True, send=False)
    assert dp.her_open(pid, now=NOW0) is None
    assert dp.her_open(999999, now=NOW0) is None
    c = _her_client()
    assert c.post(f"/api/dates/{pid}/her/open").status_code == 404


def test_her_open_http_route_and_his_detail():
    """HTTP 口回投影;他的详情写「她 … 拆开了请柬」,没拆=不提。"""
    pid, _ = make_plan(open_itinerary=True)
    assert "拆开了请柬" not in dt.render_detail(dp.snapshot(pid, now=NOW0), NOW0)
    resp = _her_client().post(f"/api/dates/{pid}/her/open")
    assert resp.status_code == 200 and resp.json()["opened_at"] is not None
    assert "拆开了请柬" in dt.render_detail(dp.snapshot(pid, now=NOW0), NOW0)


def test_opened_open_itinerary_stops_count_as_seen_for_his_edits():
    """她拆开不藏行程后,还没到原公开时刻的站也算她看到了:他不能删这一站。
    寄出后删路段不再因「她看到过」被拒;要跳过她看到过的站用 date_live skip(test_flex.py)。"""
    pid, (s1, s2) = make_plan(open_itinerary=True)
    pid2, (t1, t2) = make_plan(open_itinerary=True)
    dp.her_open(pid, now=NOW0)
    r = dp.edit(pid, "remove_stop", dict(stop_id=s2), now=NOW0)
    assert not r["ok"] and r["errors"][0]["code"] == "public_stop"
    ok(dp.edit(pid, "remove_leg", dict(to_stop=s2), now=NOW0))
    ok(dp.edit(pid2, "remove_leg", dict(to_stop=t2), now=NOW0))


def test_open_does_not_write_reveals():
    """拆开不写 date_reveals:提醒判「某时刻她是否已看到」仍按站的原公开时刻。"""
    pid, (s1, s2) = make_plan(open_itinerary=True)
    dp.her_open(pid, now=NOW0)
    conn = sqlite3.connect(config.db_path())
    try:
        n = conn.execute("SELECT COUNT(*) FROM date_reveals WHERE plan_id=?", (pid,)).fetchone()[0]
    finally:
        conn.close()
    assert n == 0


def test_open_itinerary_cannot_change_after_sent():
    """寄出之后不许再改藏不藏,拒绝带原因。"""
    pid, _ = make_plan(open_itinerary=False)
    r = dp.edit(pid, "set_basic", dict(open_itinerary=True), now=NOW0)
    assert not r["ok"]
    assert r["errors"][0]["code"] == "sent_locked"
    assert dp.her_plan(pid, now=NOW0)["open_itinerary"] is False


def test_open_itinerary_changeable_before_sent():
    """寄出前可以改(date_open 没传 / 之后 set_basic 改)。"""
    pid = ok(dp.open_plan("Trip", "2026-10-28", "rose", now=NOW0))["plan_id"]
    ok(dp.edit(pid, "set_basic", dict(open_itinerary=True), now=NOW0))
    conn = sqlite3.connect(config.db_path())
    try:
        row = conn.execute("SELECT open_itinerary FROM date_plans WHERE id=?", (pid,)).fetchone()
    finally:
        conn.close()
    assert row[0] == 1


def test_open_itinerary_bad_value_rejected():
    pid = ok(dp.open_plan("Trip2", "2026-10-29", "rose", now=NOW0))["plan_id"]
    r = dp.edit(pid, "set_basic", dict(open_itinerary="yes"), now=NOW0)
    assert not r["ok"] and r["errors"][0]["code"] == "bad_open_itinerary"


def test_open_itinerary_her_write_access_unchanged_even_when_open():
    """不藏不放开她的写口:寄出到结束之间她仍然只能看。"""
    pid, (s1, s2) = make_plan(open_itinerary=True)
    with pytest.raises(dp.HerEditError):
        dp.her_edit(pid, [{"op": "set_line", "stop_id": s1, "her_line": "真好"}], now=NOW0)


def test_open_itinerary_in_detail_and_ledger():
    """他的详情/约会账各写一句是否不藏。"""
    pid, _ = make_plan(open_itinerary=True)
    snap = dp.snapshot(pid, now=NOW0)
    assert "不藏行程" in dt.render_detail(snap, NOW0)
    text, _ = dt.ledger_block(NOW0)
    assert "不藏行程" in text


def test_open_itinerary_done_phase_still_all_regardless():
    """结束后(done)本就全公开,不因 open_itinerary 改变既有的"全部已公开"结果。"""
    pid, _ = make_plan(open_itinerary=False)
    close(pid)
    v = dp.her_plan(pid, now=T(10, 29))
    assert all(s["place"] is not None for s in v["stops"])


# ══════════════  一叠照片(不限一站一张)══════════════════════════════════════════
def test_photo_without_stop_id_allowed_live_and_counted():
    pid, (s1, s2) = make_plan()
    # live 当天才能放;不挂站的照片不需要先检票(没有具体站可检)
    r = date_her.add_photo(pid, None, JPG, "没有具体哪一站", now=T(10, 28, 19))
    assert r["stop_id"] is None
    st = date_her.state(pid, now=T(10, 28, 19))
    assert any(p["stop_id"] is None and p["caption"] == "没有具体哪一站" for p in st["photos"])


def test_photo_without_stop_rejected_before_live():
    pid, (s1, s2) = make_plan()
    with pytest.raises(date_her.HerError):
        date_her.add_photo(pid, None, JPG, None, now=NOW0)      # 还是 sent 阶段


def test_photo_plan_level_replace_swaps_only_the_named_photo():
    """那一叠里换一张=指名(replace_id)换那一张;同叠其余照片、挂站的照片都不动。不指名的 replace 被拒。"""
    pid, (s1, s2) = make_plan()
    a = date_her.add_photo(pid, None, JPG, "a", client_id="c-1", now=T(10, 28, 19))
    a2 = date_her.add_photo(pid, None, JPG, "a2", client_id="c-1b", now=T(10, 28, 19))
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19, 1))
    b = date_her.add_photo(pid, s1, JPG, "挂站的", client_id="c-2", now=T(10, 28, 19, 1))
    with pytest.raises(date_her.HerError) as ei:
        date_her.add_photo(pid, None, PNG, "b", client_id="c-x", replace=True, now=T(10, 28, 19, 2))
    assert ei.value.status == 400
    new = date_her.add_photo(pid, None, PNG, "b", client_id="c-3", replace_id=a["id"], now=T(10, 28, 19, 2))
    ids = {p["id"] for p in date_her.state(pid, now=T(10, 28, 19, 3))["photos"]}
    assert a["id"] not in ids and {a2["id"], b["id"], new["id"]} <= ids
    with pytest.raises(date_her.HerError) as ei:             # 已经换掉的那张不能再换
        date_her.add_photo(pid, None, PNG, None, client_id="c-4", replace_id=a["id"], now=T(10, 28, 19, 4))
    assert ei.value.status == 404


def test_photo_replace_retry_same_client_id_after_lockless_check_returns_original(monkeypatch):
    """同号重发都过了锁外那一关(模拟交错):后到的在写锁里认出已落过,原样回执,不报 404、不多一张。"""
    pid, _ = make_plan()
    a = date_her.add_photo(pid, None, JPG, "a", client_id="c-1", now=T(10, 28, 19))
    first = date_her.add_photo(pid, None, PNG, "b", client_id="c-swap", replace_id=a["id"], now=T(10, 28, 19, 1))
    real = date_her._connect

    class Blind:   # 锁外那次查重看不到(=两个请求同时过了那一关)
        def __init__(self, c):
            self.c, self.n = c, 0
        def execute(self, sql, *args):
            if "client_id=?" in sql and sql.lstrip().startswith("SELECT") and self.n == 0:
                self.n += 1
                return self.c.execute("SELECT 1 WHERE 0")
            return self.c.execute(sql, *args)
        def close(self):
            self.c.close()
    monkeypatch.setattr(date_her, "_connect", lambda path=None: Blind(real(path)))
    again = date_her.add_photo(pid, None, PNG, "b", client_id="c-swap", replace_id=a["id"], now=T(10, 28, 19, 2))
    monkeypatch.setattr(date_her, "_connect", real)
    assert again["id"] == first["id"]
    assert len(date_her.state(pid, now=T(10, 28, 19, 3))["photos"]) == 1


def test_photo_remove_one_from_stack():
    pid, _ = make_plan()
    a = date_her.add_photo(pid, None, JPG, "a", client_id="c-1", now=T(10, 28, 19))
    b = date_her.add_photo(pid, None, JPG, "b", client_id="c-2", now=T(10, 28, 19))
    st = date_her.remove_photo(pid, a["id"], now=T(10, 28, 19, 1))
    assert [p["id"] for p in st["photos"]] == [b["id"]]
    with pytest.raises(date_her.HerError) as ei:
        date_her.remove_photo(pid, a["id"], now=T(10, 28, 19, 2))
    assert ei.value.status == 404
    c = _her_client()
    assert c.delete(f"/api/dates/{pid}/her/photo/{b['id']}").status_code in (200, 409)   # 真时钟下阶段可能不对,只验口在


def test_photo_plan_box_cap_enforced():
    pid, (s1, s2) = make_plan()
    for i in range(date_her.PHOTO_PLAN_MAX):
        date_her.add_photo(pid, None, JPG, None, client_id=f"c-{i}", now=T(10, 28, 19))
    with pytest.raises(date_her.HerError) as ei:
        date_her.add_photo(pid, None, JPG, None, client_id="c-over", now=T(10, 28, 19))
    assert "最多放" in ei.value.text
    # 满了也能换一张(换下的先扣掉,总数不变)
    first = date_her.state(pid, now=T(10, 28, 19))["photos"][0]
    r = date_her.add_photo(pid, None, PNG, None, client_id="c-swap", replace_id=first["id"], now=T(10, 28, 19, 1))
    assert len(date_her.state(pid, now=T(10, 28, 19, 2))["photos"]) == date_her.PHOTO_PLAN_MAX and r["id"]


def _old_photo_db(db):
    conn = sqlite3.connect(db)
    try:
        conn.execute("""CREATE TABLE date_her_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, stop_id INTEGER NOT NULL,
            file TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, caption TEXT,
            created_at REAL NOT NULL, deleted_at REAL)""")
        conn.execute("INSERT INTO date_her_photos (plan_id, stop_id, file, mime, bytes, created_at)"
                     " VALUES (1, 42, '1/old.jpg', 'image/jpeg', 10, 0)")
        conn.commit()
    finally:
        conn.close()


def test_photo_migration_interrupted_rolls_back_and_retries(tmp_path, monkeypatch):
    """重建中途出错=整段回滚,原表与数据原样;下次再连接重新迁移成功。"""
    db = str(tmp_path / "old_her2.db")
    _old_photo_db(db)
    real = date_her._relax_rebuild

    def boom(conn):
        conn.execute("DROP TABLE IF EXISTS date_her_photos__relax")
        conn.execute("CREATE TABLE date_her_photos__relax (id INTEGER)")
        conn.execute("DROP TABLE date_her_photos")
        raise RuntimeError("断电")
    monkeypatch.setattr(date_her, "_relax_rebuild", boom)
    with pytest.raises(RuntimeError):
        date_her._connect(db)
    conn = sqlite3.connect(db)
    try:
        assert conn.execute("SELECT stop_id FROM date_her_photos").fetchall() == [(42,)]
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='date_her_photos__relax'").fetchone()
    finally:
        conn.close()
    monkeypatch.setattr(date_her, "_relax_rebuild", real)
    conn = date_her._connect(db)
    try:
        cols = {r[1]: r for r in conn.execute("PRAGMA table_info(date_her_photos)")}
        assert cols["stop_id"][3] == 0
        assert [tuple(r) for r in conn.execute("SELECT stop_id, file FROM date_her_photos")] == [(42, "1/old.jpg")]
        idx = {r[1] for r in conn.execute("PRAGMA index_list(date_her_photos)")}
        assert {"ix_date_her_photos_plan", "ux_date_her_photos_client"} <= idx
    finally:
        conn.close()


def test_photo_migration_second_initializer_is_noop(tmp_path):
    """两个进程先后初始化同一个旧库:后来的在写锁里再判一次,看到已可空就不动(数据不重复不丢)。"""
    db = str(tmp_path / "old_her3.db")
    _old_photo_db(db)
    date_her._connect(db).close()
    date_her._ready.discard(db)
    conn = date_her._connect(db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM date_her_photos").fetchone()[0] == 1
    finally:
        conn.close()


def test_photo_old_db_migrates_not_null_stop_id_to_nullable(tmp_path):
    """迁移对旧库安全:老库 date_her_photos.stop_id 是 NOT NULL,照样能升级并插入 NULL 行。"""
    db = str(tmp_path / "old_her.db")
    conn = sqlite3.connect(db)
    try:
        conn.execute("""CREATE TABLE date_her_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, stop_id INTEGER NOT NULL,
            file TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, caption TEXT,
            created_at REAL NOT NULL, deleted_at REAL)""")
        conn.execute("INSERT INTO date_her_photos (plan_id, stop_id, file, mime, bytes, created_at)"
                     " VALUES (1, 42, '1/old.jpg', 'image/jpeg', 10, 0)")
        conn.commit()
    finally:
        conn.close()
    conn = date_her._connect(db)
    try:
        cols = {r[1]: r for r in conn.execute("PRAGMA table_info(date_her_photos)")}
        assert cols["stop_id"][3] == 0                 # 已经可空
        assert cols["client_id"][1] == "client_id"      # 老的补列机制仍然跑过
        row = conn.execute("SELECT plan_id, stop_id, file FROM date_her_photos WHERE plan_id=1").fetchone()
        assert tuple(row) == (1, 42, "1/old.jpg")        # 旧数据完整保留
        conn.execute("INSERT INTO date_her_photos (plan_id, stop_id, file, mime, bytes, created_at)"
                     " VALUES (1, NULL, '1/new.jpg', 'image/jpeg', 20, 1)")   # 新语义:NULL 可插入
        conn.commit()
    finally:
        conn.close()


def test_photo_projection_counts_and_captions_separate_bucket():
    pid, (s1, s2) = make_plan()
    date_her.set_mark(pid, f"checkin:{s1}", True, now=T(10, 28, 19))
    date_her.add_photo(pid, s1, JPG, "挂站", now=T(10, 28, 19))
    date_her.add_photo(pid, None, JPG, "不挂站", now=T(10, 28, 19, 1))
    close(pid, now=T(10, 28, 23))
    snap = dp.snapshot(pid, now=T(10, 29))
    photos = snap["photos"]
    assert photos.get(s1) == 1
    assert photos.get(None) == 1
    detail = dt.render_detail(snap, T(10, 29))
    assert "不挂站" in detail


def test_photo_get_without_stop_id_servable():
    pid, (s1, s2) = make_plan()
    r = date_her.add_photo(pid, None, JPG, None, now=T(10, 28, 19))
    f, mime = date_her.photo_file(pid, r["id"], now=T(10, 28, 19))
    assert f.is_file() and mime == "image/jpeg"


def test_photo_http_route_stop_id_optional():
    pid, (s1, s2) = make_plan()
    c = _her_client()
    resp = c.post(f"/api/dates/{pid}/her/photo",
                  data={"caption": "http 不挂站"},
                  files={"file": ("x.jpg", JPG, "image/jpeg")})
    # 阶段还是 sent(NOW0),本该 409;只验证 stop_id 真的是可选的(不是 422 缺字段)
    assert resp.status_code == 409, resp.text


# ══════════════  她的信 + 他的回信 ═══════════════════════════════════════════════
def test_letter_write_requires_done():
    pid, _ = make_plan()
    with pytest.raises(dp.HerEditError) as ei:
        dp.her_set_letter(pid, "想你", now=NOW0)
    assert ei.value.status == 409


def test_letter_write_creates_reply_ask_and_projects():
    pid, _ = make_plan()
    close(pid)
    v = dp.her_set_letter(pid, "今天真好,想把这天留住。", now=T(10, 29))
    assert v["letter"]["text"] == "今天真好,想把这天留住。"
    assert v["reply"] is None
    conn = sqlite3.connect(config.db_path())
    try:
        row = conn.execute("SELECT done_at FROM date_asks WHERE plan_id=? AND what='reply'", (pid,)).fetchone()
    finally:
        conn.close()
    assert row is not None and row[0] is None


def test_letter_too_long_rejected():
    pid, _ = make_plan()
    close(pid)
    with pytest.raises(dp.HerEditError) as ei:
        dp.her_set_letter(pid, "x" * 2001, now=T(10, 29))
    assert ei.value.code == "long_letter"


def test_letter_empty_deletes_and_retracts_open_ask():
    pid, _ = make_plan()
    close(pid)
    dp.her_set_letter(pid, "写了", now=T(10, 29))
    v = dp.her_set_letter(pid, "", now=T(10, 29, 1))
    assert v["letter"] is None
    conn = sqlite3.connect(config.db_path())
    try:
        row = conn.execute("SELECT 1 FROM date_asks WHERE plan_id=? AND what='reply'", (pid,)).fetchone()
    finally:
        conn.close()
    assert row is None                              # 未完成的 ask 被撤掉了


def test_letter_delete_after_reply_keeps_his_reply():
    pid, _ = make_plan()
    close(pid)
    dp.her_set_letter(pid, "写了", now=T(10, 29))
    ok(dp.edit(pid, "write_reply", dict(text="我也想你"), now=T(10, 29, 5)))
    v = dp.her_set_letter(pid, "", now=T(10, 29, 10))
    assert v["letter"] is None
    assert v["reply"]["text"] == "我也想你"          # 他已经写好的回信不受她删信影响


def test_reply_requires_her_letter_first():
    pid, _ = make_plan()
    close(pid)
    r = dp.edit(pid, "write_reply", dict(text="回信"), now=T(10, 29))
    assert not r["ok"] and r["errors"][0]["code"] == "no_letter"


def test_reply_requires_done_phase():
    pid, _ = make_plan()
    r = dp.edit(pid, "write_reply", dict(text="太早了"), now=NOW0)
    assert not r["ok"] and r["errors"][0]["code"] == "phase"


def test_reply_completes_ask_and_he_can_edit_it_again():
    pid, _ = make_plan()
    close(pid)
    dp.her_set_letter(pid, "信", now=T(10, 29))
    r1 = ok(dp.edit(pid, "write_reply", dict(text="第一版回信"), now=T(10, 29, 1)))
    assert r1.get("late") == "reply"
    conn = sqlite3.connect(config.db_path())
    try:
        row = conn.execute("SELECT done_at FROM date_asks WHERE plan_id=? AND what='reply'", (pid,)).fetchone()
    finally:
        conn.close()
    assert row[0] is not None
    r2 = ok(dp.edit(pid, "write_reply", dict(text="改过的回信"), now=T(10, 29, 2)))
    assert "late" not in r2 or r2.get("late") is None    # 他能一直改:第二次不是"补上了"事件
    v = dp.her_plan(pid, now=T(10, 29, 3))
    assert v["reply"]["text"] == "改过的回信"


def test_reply_too_long_rejected():
    pid, _ = make_plan()
    close(pid)
    dp.her_set_letter(pid, "信", now=T(10, 29))
    r = dp.edit(pid, "write_reply", dict(text="x" * 2001), now=T(10, 29, 1))
    assert not r["ok"] and r["errors"][0]["code"] == "long_reply"


def test_letter_and_reply_in_his_detail_full_text():
    pid, _ = make_plan()
    close(pid)
    dp.her_set_letter(pid, "亲爱的", now=T(10, 29))
    ok(dp.edit(pid, "write_reply", dict(text="亲爱的回信"), now=T(10, 29, 1)))
    snap = dp.snapshot(pid, now=T(10, 29, 2))
    detail = dt.render_detail(snap, T(10, 29, 2))
    assert "亲爱的" in detail
    assert "亲爱的回信" in detail


def test_letter_http_route_extra_field_forbidden():
    pid, _ = make_plan()
    close(pid)
    c = _her_client()
    resp = c.put(f"/api/dates/{pid}/her/letter", json={"text": "信", "extra": 1})
    assert resp.status_code == 400


def test_letter_http_route_roundtrip():
    pid, _ = make_plan()
    close(pid)
    c = _her_client()
    resp = c.put(f"/api/dates/{pid}/her/letter", json={"text": "http 写的信"})
    assert resp.status_code == 200
    assert resp.json()["letter"]["text"] == "http 写的信"




# ══════════════  拆信即已读 ═════════════════════════════════════════════════════
def _evs(pid, now=NOW0):
    return {e["id"]: e for e in dp.her_events(pid, now=now)}


def _push_states(pid):
    with sqlite3.connect(config.db_path()) as c:
        return dict(c.execute("SELECT id, push_state FROM date_events WHERE plan_id=? ORDER BY id", (pid,)))


def test_her_open_marks_the_envelope_read():
    """拆信前信封事件未读,拆信后已读(read_at=拆的时刻);列表里的未读数随之归零。"""
    pid, _ = make_plan()
    env = [e for e in dp.her_events(pid, now=NOW0) if e["kind"] == "envelope"]
    assert len(env) == 1 and env[0]["read_at"] is None
    assert next(p for p in dp.her_plans(now=NOW0) if p["id"] == pid)["unread"] == 1
    dp.her_open(pid, now=T(10, 20, 11))
    env = [e for e in dp.her_events(pid, now=NOW0) if e["kind"] == "envelope"]
    assert env[0]["read_at"] == T(10, 20, 11).timestamp()
    assert next(p for p in dp.her_plans(now=NOW0) if p["id"] == pid)["unread"] == 0


def test_her_open_again_keeps_the_first_read_time():
    pid, _ = make_plan()
    dp.her_open(pid, now=T(10, 20, 11))
    dp.her_open(pid, now=T(10, 21, 9))
    env = [e for e in dp.her_events(pid, now=NOW0) if e["kind"] == "envelope"]
    assert env[0]["read_at"] == T(10, 20, 11).timestamp()


def test_her_open_marks_only_this_dates_envelope_not_telegrams():
    pid, _ = make_plan()
    other, _ = make_plan()
    ok(dp.live(pid, "telegram", {"text": "我在梧桐站等你"}, now=NOW0))
    before_push = _push_states(pid)
    dp.her_open(pid, now=T(10, 20, 11))
    kinds = {e["kind"]: e["read_at"] for e in dp.her_events(pid, now=NOW0)}
    assert kinds["envelope"] is not None
    assert kinds["telegram_manual"] is None                                        # 电报不算拆信读过
    assert [e["read_at"] for e in dp.her_events(other, now=NOW0)] == [None]         # 别的约会不动
    assert _push_states(pid) == before_push                                         # 推送 / webhook 状态不动


def test_her_open_does_not_touch_ai_context():
    from ephemera_date import inbox
    pid, _ = make_plan()
    before = inbox.context_text()
    dp.her_open(pid, now=T(10, 20, 11))
    assert inbox.context_text() == before


def test_her_open_http_marks_envelope_read():
    pid, _ = make_plan()
    c = _her_client()
    assert c.post(f"/api/dates/{pid}/her/open").status_code == 200
    evs = c.get(f"/api/dates/events?plan={pid}").json()["events"]
    assert [e["read_at"] is not None for e in evs if e["kind"] == "envelope"] == [True]
