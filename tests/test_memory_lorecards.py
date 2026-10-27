"""Integration: the event card is read by a real lorecards install (its CLI and its own writer).

lorecards is not a dependency of this package. Point LORECARDS_BIN at its CLI (default: `lorecards` on PATH);
its Python is taken from the same directory. Without it these tests are skipped, unless
EPHEMERA_REQUIRE_LORECARDS=1 (then they fail). Example:

    python3 -m venv /tmp/lorecards-venv && /tmp/lorecards-venv/bin/pip install lorecards-mcp
    LORECARDS_BIN=/tmp/lorecards-venv/bin/lorecards python -m pytest tests/test_memory_lorecards.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from ephemera_date import config, memory
from test_memory_card import make_done, parse, sql

BIN = os.environ.get("LORECARDS_BIN") or shutil.which("lorecards")
HAVE = bool(BIN) and Path(BIN).exists()
REQUIRED = os.environ.get("EPHEMERA_REQUIRE_LORECARDS") == "1"     # CI: missing lorecards = failure, not a skip
pytestmark = pytest.mark.skipif(not HAVE and not REQUIRED, reason="lorecards CLI not installed")


def test_lorecards_installed_when_required():
    assert HAVE, f"EPHEMERA_REQUIRE_LORECARDS=1 but no lorecards CLI (LORECARDS_BIN={BIN!r})"


@pytest.fixture(autouse=True)
def _vault(tmp_path, monkeypatch):
    monkeypatch.setenv("EPHEMERA_CARDS_DIR", str(tmp_path / "vault"))


def lc(*args) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith("EPHEMERA_")}
    return subprocess.run([BIN, "--vault", str(config.cards_dir()), *args], capture_output=True, text=True,
                          env=env, timeout=60)


def lpy(code: str) -> subprocess.CompletedProcess:
    py = Path(BIN).parent / "python"
    return subprocess.run([str(py), "-c", code], capture_output=True, text=True, timeout=60)


def test_lorecards_reads_the_card_and_keywords_fire():
    pid = make_done()
    memory.run_once()
    key = memory.written_key(pid)
    r = lc("check")
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.strip().endswith("all cards look fine.")
    r = lc("list", "--json")
    rows = json.loads(r.stdout)
    assert [(x["key"], x["kind"]) for x in rows] == [(key, "event")]
    assert rows[0]["keywords"] == ["The Evening Screening", "梧桐站", "Le Petit Pot", "10月28日"]
    for sentence in ("还记得梧桐站那天吗", "10月28日那次", "the evening screening was nice"):
        r = lc("try", sentence, "--json")
        hits = json.loads(r.stdout)["hits"]
        assert [h["key"] for h in hits] == [key], (sentence, r.stdout)
        assert "那一句话：那天很好" in hits[0]["body"]
    assert json.loads(lc("try", "今天天气不错", "--json").stdout)["hits"] == []


def test_lorecards_followup_writer_and_archive_coexist():
    pid = make_done()
    memory.run_once()
    key = memory.written_key(pid)
    vault = str(config.cards_dir())
    r = lpy("from lorecards import engine; print(engine.write_card(%r, kind='event', key=%r, "
            "fields={'followup': '他后来又提起这一天'}, mode='update_recent'))" % (vault, key))
    assert r.returncode == 0, r.stderr
    sql("UPDATE date_stops SET note='lorecards 写过之后改的' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert memory.run_once()["cards"] == {pid: "updated"}
    [p] = sorted((config.cards_dir() / "events").glob("*.md"))
    _, secs = parse(p)
    assert secs["followup"] == "他后来又提起这一天" and "lorecards 写过之后改的" in secs["what"]
    assert lc("check").returncode == 0
    r = lpy("from lorecards import engine; print(engine.archive_card(%r, 'event', %r))" % (vault, key))
    assert r.returncode == 0, r.stderr
    sql("UPDATE date_stops SET note='归档之后又改' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert memory.run_once()["cards"] == {pid: "removed"}
    assert list((config.cards_dir() / "events").glob("*.md")) == []
    assert json.loads(lc("list", "--json").stdout) == []


def test_lorecards_recent_section_vault_followup_survives_rewrite():
    """kinds.yaml puts the follow-up 4th and names it with recent_section: lorecards' update_recent writes
    there, and our rewrite keeps it (the column is chosen by recent_section, not by position)."""
    v = config.cards_dir()
    v.mkdir(parents=True)
    (v / "kinds.yaml").write_text("sections: {event: [时间, 涉及谁, 经过, 后续, 她的态度]}\n"
                                  "recent_section: {event: 后续}\n", "utf-8")
    pid = make_done()
    sql("UPDATE date_stops SET her_line='他真的早到了' WHERE plan_id=? AND title='梧桐站'", (pid,))
    memory.run_once()
    key = memory.written_key(pid)
    r = lpy("from lorecards import engine; print(engine.write_card(%r, kind='event', key=%r, "
            "fields={'后续': 'lorecards 写的后续'}, mode='update_recent'))" % (str(v), key))
    assert r.returncode == 0, r.stderr
    sql("UPDATE date_stops SET note='之后又改' WHERE plan_id=? AND title='梧桐站'", (pid,))
    assert memory.run_once()["cards"] == {pid: "updated"}
    r = lpy("import json; from lorecards import engine; d = engine.card_detail(%r, 'event', %r); "
            "print(json.dumps(d['fields'], ensure_ascii=False))" % (str(v), key))
    fields = json.loads(r.stdout)
    assert fields["后续"] == "lorecards 写的后续"
    assert fields["她的态度"] == "- 19:00 梧桐站：他真的早到了" and "之后又改" in fields["经过"]
    assert lc("check").returncode == 0
