"""After-date memory: a lorecards event card and a structured JSON entry for every finished date,
plus the AI's look-back tool (``date_memory``: find past dates, write a card's follow-up).

Outputs (each one is off unless its directory is configured):

- ``EPHEMERA_CARDS_DIR``: a lorecards vault. One card per finished date in its event directory
  (``events/`` unless the vault's ``kinds.yaml`` renames it), YAML frontmatter + ``## section`` body, section
  names from the vault's schema (default ``when / who / what / stance / followup``; the follow-up is the
  vault's ``recent_section.event``, see ``Schema``). The file is plain Markdown: lorecards is not needed to
  read it. New cards and exports get the usual 0666 & ~umask permissions; a rewrite keeps the file's own.
- ``EPHEMERA_MEMORY_EXPORT_DIR``: ``date-<id>.json`` per finished date (schema: ``EXPORT_SCHEMA`` below),
  rewritten in place with a higher ``version`` whenever its content changes; removed when the date is deleted.

Card rules:
- Keywords: the date's names, every stop name (2+ characters), and 「M月D日」. Generic words (「约会」,
  lorecards' generic list, the vault's ``generic_keywords``) never become keywords.
- The follow-up section is written by the AI (``date_memory op=followup``, or any lorecards writer); a
  rewrite keeps whatever the file has there. A queued follow-up and an edit on the card: the newer wins. Keywords added by hand, aliases and every other frontmatter key,
  headings outside the schema and text before the first heading are kept.
- Card name = 「约会·<date>·<full name>」. A file already on disk that is not this date's card (hand-written,
  another date's) is never taken over: the name becomes 「…·<id>」, then 「…·<id>·n」. Renaming the date or
  moving its day renames the card (the old file is the source of what is kept, then removed): never two cards.
- A card this module wrote that is gone (deleted, or archived into lorecards' ``_archive/``) is not brought
  back.
- Concurrency: read the card (recording mtime_ns + size + inode) → render → re-check that version right
  before landing → atomic landing (``os.replace`` in place; ``os.link`` for a new name, which cannot
  overwrite anything). Changed or gone in between = this round gives up and re-reads next round. The whole
  sequence holds a cross-process lock file at the vault root (``LOCK_NAME``): lorecards itself has no card
  write lock (its writers check mtime instead), and its mtime check sees our replaced file as changed.
- First time a card is written → ``plan.add_ask(id, 'card_after')`` (the AI's ledger asks for the follow-up);
  once the follow-up is non-empty → ``plan.complete_ask``.

Scheduling: ``run_once`` is one job of the single scheduler (``ephemera-date serve``), run only while holding the
lease, and checked again right before every landing; ``ephemera-date stdio`` never writes cards or exports
(``date_memory op=followup`` from any process only queues the text in the database for the scheduler).
Date data is loaded through a read-only connection (no engine migration, no settling); the module's own
state table is the only thing it writes, apart from the two ask calls.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import sqlite3
import stat
import tempfile
import threading
import time
from datetime import date, datetime
from pathlib import Path

import yaml

from . import config
from . import plan as dp

try:                                    # POSIX; elsewhere the lock degrades to in-process only
    import fcntl
except ImportError:                     # pragma: no cover
    fcntl = None

log = logging.getLogger("ephemera_date.memory")

PREFIX = "约会"
ASK_WHAT = "card_after"
TITLE_MAX = 60
FOLLOWUP_MAX = 600                      # = lorecards RECENT_MAX_CHARS
LOCK_NAME = ".ephemera-cards.lock"
LOCK_TIMEOUT_S = 10.0
EXPORT_SCHEMA = "ephemera.date-memory/1"
FIND_MAX = 20                           # date_memory find: summary lines at most
FULL_MAX = 3                            # ... of which this many come with the full text
NOTICE_TTL_S = 7 * 24 * 3600.0          # "your queued follow-up was not written" stays in the to-dos this long

# lorecards schema, event kind (lorecards/schema.py); a vault's kinds.yaml may rename them
EVENT_DIR = "events"
EVENT_SECTIONS = ("when", "who", "what", "stance", "followup")
PRIVATE_SECTIONS = ("correspondence",)
LORECARDS_GENERIC = frozenset({
    "i", "you", "he", "she", "it", "we", "they", "the", "a", "an", "and", "or",
    "ok", "okay", "yes", "no", "hi", "hey", "thanks", "please", "this", "that",
})
NO_KEYWORDS = frozenset({"约会", "约会日"})
_WD = "一二三四五六日"
_BAD_CHARS_RE = re.compile(r"[\x00-\x1f\x7f/\\]+")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")
_SPACE_RE = re.compile(r"\s+")
_SECTION_RE = re.compile(r"^## (.+?)\s*$", re.M)
_SPLIT_RE = re.compile(r"[,，、]")

_STATE_SQL = """CREATE TABLE IF NOT EXISTS ephemera_memory_state (
    plan_id INTEGER PRIMARY KEY,
    card_dir TEXT, card_key TEXT, card_hash TEXT, gen_keywords TEXT, card_written_at REAL,
    card_error TEXT, card_error_at REAL, asked_at REAL, after_done_at REAL, card_ver TEXT, followup_hash TEXT,
    followup_pending TEXT, followup_queued_at REAL,
    json_file TEXT, json_hash TEXT, json_version INTEGER NOT NULL DEFAULT 0, json_written_at REAL,
    json_error TEXT, json_error_at REAL)"""
_CARD_COLS = ("card_dir", "card_key", "card_hash", "gen_keywords", "card_written_at", "card_error",
              "card_error_at", "asked_at", "after_done_at", "card_ver", "followup_hash")
# what another scheduler (overlapping lease) changes when it writes this date's card
_OWN_COLS = ("card_dir", "card_key", "card_hash", "card_written_at", "card_ver")
_STATE_ADD = (("card_ver", "TEXT"), ("followup_hash", "TEXT"))


# ── lorecards schema (event kind only) ────────────────────────────────────────────
GEN_FIELDS = ("when", "who", "what", "stance")     # what we generate, in lorecards' default order
FIELD_ZH = {"when": "时间", "who": "涉及谁", "what": "经过", "stance": "{her}的态度"}


class Schema:
    """Directory + section names of the event kind for one vault (lorecards ``load_schema``, event part).

    Which heading holds what:
    - follow-up = ``recent_section.event`` when it is one of the event sections (lorecards ``recent_for``,
      the section its ``write_card(mode="update_recent")`` writes); otherwise the 5th section; with fewer
      than five sections and no usable recent section, the last one.
    - the other sections, in their order, take when / who / what / stance by position. More than four:
      the extra ones are never written (kept as they are on the card). Fewer than four: the fields that do
      not fit are appended, each under a 「名称：」 line, to the section that takes "what" (or the last one).
    """

    def __init__(self, event_dir: str = EVENT_DIR, sections: tuple[str, ...] = EVENT_SECTIONS,
                 private: tuple[str, ...] = PRIVATE_SECTIONS, generic: frozenset = LORECARDS_GENERIC,
                 recent: str | None = "followup"):
        self.event_dir, self.sections, self.private, self.generic = event_dir, tuple(sections), private, generic
        self.recent = recent

    @property
    def names(self) -> list[str]:
        return list(self.sections) + [n for n in self.private if n not in self.sections]

    @property
    def followup(self) -> str:
        if self.recent in self.sections:
            return self.recent
        return self.sections[4] if len(self.sections) >= 5 else self.sections[-1]

    def layout(self) -> dict[str, list[str]]:
        """heading → the generated fields written there (first one plain, the rest under a 「名称：」 line)."""
        rest = [n for n in self.sections if n != self.followup]
        if not rest:
            raise ValueError("卡库的 event 只有一栏，放不下约会的内容")
        out: dict[str, list[str]] = {}
        what_col = rest[min(GEN_FIELDS.index("what"), len(rest) - 1)]
        for i, f in enumerate(GEN_FIELDS):
            out.setdefault(rest[i] if i < len(rest) else what_col, []).append(f)
        return out

    def signature(self) -> list:
        return [self.event_dir, list(self.sections), self.followup]


def load_schema(root: Path) -> Schema:
    """Read ``<vault>/kinds.yaml`` like lorecards does; anything unusable falls back to the defaults."""
    p = root / "kinds.yaml"
    if not p.is_file():
        return Schema()
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except (OSError, UnicodeDecodeError, yaml.YAMLError):
        return Schema()
    if not isinstance(raw, dict):
        return Schema()
    d = EVENT_DIR
    dirs = raw.get("dirs")
    if isinstance(dirs, dict) and isinstance(dirs.get("event"), str):
        d = safe_key(dirs["event"]) or EVENT_DIR
    secs = EVENT_SECTIONS
    sections = raw.get("sections")
    if isinstance(sections, dict) and isinstance(sections.get("event"), list):
        got = tuple(dict.fromkeys(str(n).strip() for n in sections["event"] if str(n).strip()))
        if got:                                     # lorecards keeps the defaults for an empty list
            secs = got
    recent = "followup"
    rs = raw.get("recent_section")
    if isinstance(rs, dict) and "event" in rs:      # lorecards: `str(name).strip() or None`, null = None
        recent = (str(rs["event"]).strip() or None) if rs["event"] is not None else None
    private = PRIVATE_SECTIONS
    if isinstance(raw.get("private_sections"), list):
        private = tuple(str(n).strip() for n in raw["private_sections"] if str(n).strip())
    generic = LORECARDS_GENERIC
    if isinstance(raw.get("generic_keywords"), list):
        generic = frozenset(generic | {str(w).strip().casefold() for w in raw["generic_keywords"] if str(w).strip()})
    return Schema(d, secs, private, generic, recent)


def safe_key(key: str) -> str | None:
    """lorecards ``safe_key``: a card key is one file name, no path parts, no leading dot, no control chars."""
    k = (key or "").strip()
    if k.endswith(".md"):
        k = k[:-3].strip()
    if (not k or k in (".", "..") or ".." in k or "/" in k or "\\" in k
            or k.startswith(".") or _CTRL_RE.search(k)):
        return None
    return k


def parse_str_list(raw) -> list[str]:
    """lorecards ``parse_str_list``: keywords/aliases as a list, or one string split on , ， 、"""
    if isinstance(raw, str):
        raw = _SPLIT_RE.split(raw.strip().strip("[]"))
    elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for k in raw:
        if not isinstance(k, (str, int, float)):
            continue
        s = str(k).strip().strip("\"'").strip()
        if s and s not in out:
            out.append(s)
    return out


def split_frontmatter(text: str) -> tuple[dict | None, str, str | None]:
    """→ (frontmatter, body, problem); problem None / "no_fm" / "bad_fm" (lorecards semantics)."""
    if not text.startswith("---"):
        return {}, text, "no_fm"
    parts = text.split("---", 2)
    if len(parts) != 3:
        return {}, text, "no_fm"
    try:
        loaded = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        return None, parts[2], "bad_fm"
    if not isinstance(loaded, dict):
        return None, parts[2], "bad_fm"
    return loaded, parts[2], None


def split_sections(body: str, schema: Schema) -> dict[str, str]:
    """``## heading`` → {heading: text}; unknown or repeated headings verbatim in ``_extra``; text before the
    first heading in ``_head`` (lorecards ``split_sections``)."""
    names = schema.names
    out: dict[str, str] = {n: "" for n in names}
    matches = list(_SECTION_RE.finditer(body))
    out["_head"] = (body[: matches[0].start()] if matches else body).strip()
    extra: list[str] = []
    for i, m in enumerate(matches):
        name = m.group(1).strip()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        content = body[m.end():end].strip()
        if name in out and name not in ("_head", "_extra") and not out[name]:
            out[name] = content
        else:
            extra.append(f"## {name}\n{content}".rstrip())
    out["_extra"] = "\n\n".join(extra)
    return out


def render_body(secs: dict[str, str], schema: Schema) -> str:
    parts: list[str] = []
    if (secs.get("_head") or "").strip():
        parts.append(secs["_head"].strip())
    for n in schema.names:
        text = (secs.get(n) or "").strip()
        if not text and n not in schema.sections:
            continue                        # an empty private heading is not stamped onto the card
        parts.append(f"## {n}\n{text}".rstrip())
    if (secs.get("_extra") or "").strip():
        parts.append(secs["_extra"].strip())
    return "\n\n".join(parts).strip() + "\n"


def followup_of(text: str | None, schema: Schema) -> str:
    if not text:
        return ""
    fm, body, problem = split_frontmatter(text)
    return (split_sections(text if problem == "no_fm" else body, schema).get(schema.followup) or "").strip()


# ── card content (pure) ───────────────────────────────────────────────────────────
def clean_title(title: str | None) -> str:
    """A date name → one line usable as a file name / keyword."""
    t = _SPACE_RE.sub(" ", _BAD_CHARS_RE.sub(" ", title or "")).strip()
    t = t.replace("..", ".").strip(". ").strip()
    return t[:TITLE_MAX].strip()


def card_key(plan: dict) -> str:
    t = clean_title(dp.full_name(plan))
    return f"{PREFIX}·{plan['date']}·{t}" if t else f"{PREFIX}·{plan['date']}·{plan['id']}"


def _md_zh(d: str) -> str:
    x = date.fromisoformat(d)
    return f"{x.month}月{x.day}日"


def _span(s: dict) -> str:
    t = s.get("time") or "?"
    return f"{t}–{s['stay_until']}" if s.get("stay_until") else t


def _one_line(v) -> str:
    return _SPACE_RE.sub(" ", str(v or "")).strip()


def photo_captions(conn: sqlite3.Connection, plan_id: int) -> dict[int | None, list[str]]:
    """Her photo captions by stop (None = not tied to a stop). No photo table yet = none."""
    try:
        rows = conn.execute("SELECT stop_id, caption FROM date_her_photos WHERE plan_id=? AND deleted_at IS NULL"
                            " AND caption IS NOT NULL AND caption != '' ORDER BY created_at, id",
                            (plan_id,)).fetchall()
    except sqlite3.OperationalError as e:
        if "no such table" in str(e):
            return {}
        raise
    out: dict[int | None, list[str]] = {}
    for r in rows:
        out.setdefault(r[0], []).append(r[1].strip())
    return out


def build_fields(st: dict, captions: dict | None = None) -> dict[str, str]:
    """A finished date → the card's sections by field (no follow-up: that one is written by the AI)."""
    p = st["plan"]
    captions = captions or {}
    her, him = config.her(), config.him()
    d = date.fromisoformat(p["date"])
    stops = st["stops"]
    when = [f"{d.isoformat()}（周{_WD[d.weekday()]}）"]
    if (td := dp.together_day(p)) is not None:
        when[0] += f" · 在一起的第 {td} 天"
    if dp.display_name(p)[1]:
        when[0] += f" · {clean_title(dp.full_name(p))}"
    if stops:
        when.append("各站时刻：" + "、".join(_span(s) for s in stops))
    what: list[str] = []
    for s in stops:
        line = " · ".join(x for x in (s.get("time") or "", _one_line(s.get("title")), dp.stop_label(s)) if x)
        what.append(f"- {line}" + (f"（跳过了：{_one_line(s.get('skip_reason'))}）" if dp.is_skipped(s) else ""))   # 当天跳过的站与原因
        if (s.get("clue") or "").strip():
            what.append(f"  线索：{_one_line(s['clue'])}")
        if (s.get("note") or "").strip():
            what.append(f"  备注：{_one_line(s['note'])}")
    if (p.get("quote") or "").strip():
        what.append(f"那一句话：{_one_line(p['quote'])}")
    letters = st.get("letters") or {}
    reply = (letters.get("him") or {}).get("text")
    if (reply or "").strip():
        what.append(f"回信：{_one_line(reply)}")
    stance: list[str] = []
    for s in stops:
        where = " ".join(x for x in (s.get("time") or "", _one_line(s.get("title"))) if x)
        if (s.get("her_line") or "").strip():
            stance.append(f"- {where}：{_one_line(s['her_line'])}")
        for c in captions.get(s["id"], []):
            stance.append(f"- {where} 照片：{_one_line(c)}")
    for c in captions.get(None, []):
        stance.append(f"- 照片：{_one_line(c)}")
    letter = (letters.get("her") or {}).get("text")
    if (letter or "").strip():
        stance.append(f"- {her}的信：{_one_line(letter)}")
    return {"when": "\n".join(when), "who": f"{her}、{him}", "what": "\n".join(what), "stance": "\n".join(stance)}


def build_keywords(st: dict, schema: Schema | None = None) -> list[str]:
    generic = (schema or Schema()).generic
    p = st["plan"]
    out: list[str] = []

    def add(k: str) -> None:
        k = _one_line(k)
        if len(k) >= 2 and k not in NO_KEYWORDS and k.casefold() not in generic and k not in out:
            out.append(k)
    add(clean_title((p.get("title_en") or "").replace("\n", " ")))
    add(clean_title(p.get("title_zh") or ""))
    for s in st["stops"]:
        add(s.get("title") or "")
    add(_md_zh(p["date"]))
    return out


def content_hash(key: str, fields: dict, keywords: list[str], layout: list | None = None) -> str:
    blob = json.dumps({"key": key, "fields": fields, "keywords": keywords, **({"layout": layout} if layout else {})},
                      ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class BadCard(Exception):
    """The card on disk has frontmatter that does not parse: never rewritten (lorecards refuses too)."""


def render(key: str, fields: dict, gen_keywords: list[str], *, old_text: str | None,
           old_gen_keywords: list[str], schema: Schema | None = None, followup: str | None = None) -> str:
    """The whole card file. With an old file: its follow-up (unless ``followup`` replaces it), unknown
    headings, leading text, hand-added keywords and every other frontmatter key are kept."""
    schema = schema or Schema()
    fm: dict = {}
    body = ""
    if old_text is not None:
        got, body, problem = split_frontmatter(old_text)
        if problem == "bad_fm":
            raise BadCard("卡的 frontmatter 读不出来，不改写（修好后下一轮会再写）")
        fm = got or {}
        if problem == "no_fm":
            body = old_text
    old = split_sections(body, schema) if old_text is not None else {}
    hand = [k for k in parse_str_list(fm.get("keywords")) if k not in old_gen_keywords]
    keywords = list(gen_keywords) + [k for k in hand if k not in gen_keywords]
    secs = {n: old.get(n, "") for n in schema.names}
    her = config.her()
    for col, fs in schema.layout().items():
        parts = [(fields.get(fs[0]) or "").strip()]
        for f in fs[1:]:                            # did not fit in a section of its own
            if (fields.get(f) or "").strip():
                parts.append(FIELD_ZH[f].replace("{her}", her) + "：\n" + fields[f].strip())
        secs[col] = "\n\n".join(x for x in parts if x)
    fu = schema.followup
    secs[fu] = followup if followup is not None else old.get(fu, "")
    secs["_head"], secs["_extra"] = old.get("_head", ""), old.get("_extra", "")
    head = {"kind": "event", "title": key, "keywords": keywords}
    for k, v in fm.items():
        if k not in head:
            head[k] = v
    y = yaml.safe_dump(head, allow_unicode=True, sort_keys=False, default_flow_style=None, width=1000)
    return f"---\n{y}---\n{render_body(secs, schema)}"


def after_hint(key: str, plan_id: int) -> str:
    """The AI's ledger line for the follow-up ask: which card, and how to write it."""
    return (f"事件卡「{key}」的「后续」段（用 date_memory 写：op=followup，plan={plan_id}，text=后续内容；"
            f"整段替换，不另开新卡）")


# ── state ─────────────────────────────────────────────────────────────────────────
def _open_ro(db: str) -> sqlite3.Connection:
    """Date tables, read only (uri mode=ro): no engine migration, no write transaction."""
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _open_state(db: str) -> sqlite3.Connection:
    """Write connection for this module's own state table (and the two ask calls)."""
    conn = sqlite3.connect(db, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute(_STATE_SQL)
    have = {r[1] for r in conn.execute("PRAGMA table_info(ephemera_memory_state)")}
    for col, decl in _STATE_ADD:
        if col not in have:
            conn.execute(f"ALTER TABLE ephemera_memory_state ADD COLUMN {col} {decl}")
    return conn


def _state(conn: sqlite3.Connection, plan_id: int) -> dict:
    r = conn.execute("SELECT * FROM ephemera_memory_state WHERE plan_id=?", (plan_id,)).fetchone()
    return dict(r) if r else {}


def _save(conn: sqlite3.Connection, plan_id: int, **cols) -> None:
    conn.execute("INSERT OR IGNORE INTO ephemera_memory_state (plan_id) VALUES (?)", (plan_id,))
    if cols:
        sets = ", ".join(f"{k}=?" for k in cols)
        conn.execute(f"UPDATE ephemera_memory_state SET {sets} WHERE plan_id=?", (*cols.values(), plan_id))


def _state_ro(plan_id: int, path: str | None = None) -> dict:
    db = path or dp._db_path()
    if not os.path.exists(db):
        return {}
    try:
        conn = _open_ro(db)
    except sqlite3.Error:
        return {}
    try:
        return _state(conn, plan_id)
    except sqlite3.Error:
        return {}
    finally:
        conn.close()


def written_key(plan_id: int, *, path: str | None = None) -> str | None:
    """What this date's card is called now (file name without .md); never written = None. Read only."""
    st = _state_ro(plan_id, path)
    root = config.cards_dir()
    if not st.get("card_key") or root is None or st.get("card_dir") != str(root):
        return None
    return st["card_key"]


def ask_label(plan_id: int) -> str | None:
    """tools.ASK_LABEL_HOOKS['card_after']."""
    key = written_key(plan_id)
    return after_hint(key, plan_id) if key else None


# ── landing ───────────────────────────────────────────────────────────────────────
class LockTimeout(Exception):
    pass


_thread_lock = threading.Lock()


@contextlib.contextmanager
def cards_lock(root: Path, timeout: float | None = None):
    """Exclusive lock over the card vault, across threads and processes (``<vault>/LOCK_NAME``)."""
    timeout = LOCK_TIMEOUT_S if timeout is None else timeout
    deadline = time.monotonic() + timeout
    if not _thread_lock.acquire(timeout=timeout):
        raise LockTimeout(f"事件卡写锁 {timeout:g} 秒内没拿到")
    fh = None
    try:
        if fcntl is not None:
            fh = open(root / LOCK_NAME, "a+")
            while True:
                try:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise LockTimeout(f"事件卡写锁 {timeout:g} 秒内没拿到") from None
                    time.sleep(0.05)
        yield
    finally:
        if fh is not None:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            finally:
                fh.close()
        _thread_lock.release()


def _read_umask() -> int:
    """The process umask: /proc where it exists (no change at all), else one swap at import time."""
    try:
        with open("/proc/self/status", encoding="ascii") as f:
            for line in f:
                if line.startswith("Umask:"):
                    return int(line.split()[1], 8)
    except (OSError, ValueError):
        pass
    m = os.umask(0o022)
    os.umask(m)
    return m


# read once when the process loads this module; writing a file never touches the global umask
_UMASK = _read_umask()


def new_file_mode() -> int:
    """A new card / export: the usual 0666 & ~umask (0644 under umask 022), not mkstemp's 0600."""
    return 0o666 & ~_UMASK


def _mode_of(p: Path) -> int | None:
    try:
        return stat.S_IMODE(p.stat().st_mode)
    except FileNotFoundError:
        return None


class _Src:
    """A card as read: text + version (mtime_ns, size, inode) taken *before* reading, so a write landing
    between the two can only make the version look older (= the pre-landing check gives up: safe side)."""

    def __init__(self, path: Path, text: str, ver: tuple[int, int, int]):
        self.path, self.text, self.ver = path, text, ver


def _ver(p: Path) -> tuple[int, int, int] | None:
    try:
        st = p.stat()
    except FileNotFoundError:
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


def _read(p: Path) -> _Src | None:
    v = _ver(p)
    if v is None:
        return None
    try:
        return _Src(p, p.read_text("utf-8"), v)
    except FileNotFoundError:
        return None


class _Raced(Exception):
    """Changed / gone / taken between reading and landing: give up this round, re-read next round."""


class _LeaseLost(Exception):
    pass


def _write_checked(dst: Path, text: str, src: _Src | None, still_owner=None) -> tuple[int, int, int]:
    """Atomic landing with a version re-check (caller holds ``cards_lock``). Returns the new file's version.
    - in place (src is dst): temp file → re-check dst → os.replace.
    - new name (first write / rename): os.link(temp, dst) — fails atomically when dst exists, so nobody's
      card is ever overwritten; src (the old card when renaming) is re-checked before landing too.
    What remains: a writer without the lock (a hand edit, lorecards' own writers) landing in the
    microseconds between the re-check and os.replace; a file system has no compare-and-swap."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".ephemera-", suffix=".tmp", dir=str(dst.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        # rewriting (in place or under a new name) keeps the card's own permissions; a new card gets the usual ones
        mode = _mode_of(src.path) if src is not None else new_file_mode()
        if mode is None:
            raise _Raced(f"{src.path.name} 在读之后不见了")
        os.chmod(tmp, mode)
        if still_owner is not None and not still_owner():
            raise _LeaseLost()
        if src is not None and _ver(src.path) != src.ver:
            raise _Raced(f"{src.path.name} 在读之后变了")
        if src is not None and src.path == dst:
            os.replace(tmp, dst)
        else:
            try:
                os.link(tmp, dst)
            except FileExistsError:
                raise _Raced(f"{dst.name} 被别的卡占了") from None
        v = _ver(dst)
        if v is None:
            raise _Raced(f"{dst.name} 刚写下就不见了")
        return v
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _inside(root: Path, p: Path) -> bool:
    try:
        return p.resolve().is_relative_to(root.resolve())
    except OSError:
        return False


def _owner_of(sconn: sqlite3.Connection, key: str) -> int | None:
    r = sconn.execute("SELECT plan_id FROM ephemera_memory_state WHERE card_key=?", (key,)).fetchone()
    return r[0] if r else None


def _pick_key(sconn: sqlite3.Connection, edir: Path, plan_id: int, base: str, prev_key: str | None) -> str:
    """A truly unique card name: not registered to another date, and either not on disk or this date's own
    card. The previous name is kept while it is still valid (no flip-flopping)."""
    def ok(k: str) -> bool:
        owner = _owner_of(sconn, k)
        if owner is not None and owner != plan_id:
            return False
        if (edir / f"{k}.md").exists() or (edir / f"{k}.md").is_symlink():
            return owner == plan_id and k == prev_key
        return True
    tail = f"{base}·{plan_id}"
    if prev_key and (prev_key == base or prev_key == tail or prev_key.startswith(tail + "·")) and ok(prev_key):
        return prev_key
    for k in [base, tail] + [f"{tail}·{i}" for i in range(2, 1000)]:
        if safe_key(k) == k and ok(k):
            return k
    raise RuntimeError("找不到可用的卡名")


def _clear_pending(sconn: sqlite3.Connection, plan_id: int, applied: str | None) -> None:
    """Drop the queued follow-up only if it is still the one just applied (a newer one waits for next round)."""
    if applied is not None:
        sconn.execute("UPDATE ephemera_memory_state SET followup_pending=NULL WHERE plan_id=? AND followup_pending=?",
                      (plan_id, applied))


def _text_hash(t: str) -> str:
    return hashlib.sha256((t or "").strip().encode("utf-8")).hexdigest()


def _pending_wins(src: _Src, st: dict, schema: Schema, pending: str) -> bool:
    """A queued follow-up vs the one on the card: the newer one wins.
    - card follow-up empty, or the same text → queued.
    - card follow-up is still the text this module last wrote there (``followup_hash``) → nobody touched the
      follow-up (other edits to the card, a hand-added keyword say, do not count) → queued.
    - only when the follow-up section itself changed: compare times. It has no time of its own, so the card
      file's mtime stands in for it (approximation: the last edit of the card, whatever it touched)."""
    on_card = followup_of(src.text, schema)
    if not on_card or on_card == pending.strip():
        return True
    if st.get("followup_hash") is not None and st["followup_hash"] == _text_hash(on_card):
        return True
    return src.ver[0] / 1e9 <= float(st.get("followup_queued_at") or 0)


def lost_followup_line(plan: dict, key: str, pending: str) -> str:
    """The AI's to-do when its queued follow-up lost to a newer one on the card (never dropped silently)."""
    return (f"约会 #{plan['id']}「{dp.full_name(plan)}」：你排队的后续没写进去——事件卡「{key}」的「后续」"
            f"在你排队之后被改过，卡上的那段留着。你排队的是：「{pending.strip()}」。"
            f"要改就先用 date_memory 带 plan={plan['id']} 看全文，再用 op=followup 重写。")


def _card_one(ro, sconn, plan_id: int, root: Path, schema: Schema, now_ts: float, still_owner=None) -> str:
    st = dp._load(ro, plan_id)                  # read only; never _settle (it writes)
    if st is None:
        return "gone"
    prev = _state(sconn, plan_id)
    if prev.get("card_dir") not in (None, str(root)):  # the vault moved: this date has no card there yet
        _save(sconn, plan_id, **{c: None for c in _CARD_COLS})
        prev = _state(sconn, plan_id)
    edir = root / schema.event_dir
    old_key = prev.get("card_key")
    key = _pick_key(sconn, edir, plan_id, card_key(st["plan"]), old_key)
    fields = build_fields(st, photo_captions(ro, plan_id))
    kws = build_keywords(st, schema)
    h = content_hash(key, fields, kws, schema.signature())
    dst = edir / f"{key}.md"
    pending = prev.get("followup_pending")
    result = "same"
    if h != prev.get("card_hash") or pending is not None:
        old = edir / f"{old_key}.md" if old_key else None
        if not _inside(root, dst) or (old is not None and not _inside(root, old)):
            raise RuntimeError("卡的路径落在卡目录之外（软链）")
        old_gen = json.loads(prev["gen_keywords"]) if prev.get("gen_keywords") else []
        gen = json.dumps(kws, ensure_ascii=False)
        wrote = False
        with cards_lock(root):
            # under the lock, re-read our state: with an overlapping lease another scheduler may have written
            # (or renamed) this card since `prev` was read; everything above was decided on stale state
            if any(_state(sconn, plan_id).get(c) != prev.get(c) for c in _OWN_COLS):
                log.info("[memory] date %s: card written by another scheduler meanwhile; next round", plan_id)
                return "raced"
            src = _read(old) if old is not None else None
            if src is None and prev.get("card_written_at"):
                # written before and gone now = deleted or archived: never brought back
                _save(sconn, plan_id, card_dir=str(root), card_hash=h, gen_keywords=gen,
                      card_error=None, card_error_at=None)
                _clear_pending(sconn, plan_id, pending)
                return "removed"
            use = pending
            if pending is not None and src is not None and not _pending_wins(src, prev, schema, pending):
                log.info("[memory] date %s: the card's follow-up is newer than the queued one; AI told", plan_id)
                from . import inbox                       # inbox imports plan; imported here, not at load
                inbox.deliver("memory_notice", lost_followup_line(st["plan"], key, pending),
                              f"memory_notice:{plan_id}:{prev.get('followup_queued_at')}", plan_ids=[plan_id],
                              expire_at=now_ts + NOTICE_TTL_S, now=datetime.fromtimestamp(now_ts, config.tz()),
                              conn=sconn)
                use = None
            if use is None and h == prev.get("card_hash"):
                _clear_pending(sconn, plan_id, pending)    # nothing else to write
            else:
                text = render(key, fields, kws, old_text=src.text if src else None, old_gen_keywords=old_gen,
                              schema=schema, followup=use)
                try:
                    new_ver = _write_checked(dst, text, src, still_owner)
                    if src is not None and src.path != dst:     # rename: new card landed, old one goes
                        if _ver(src.path) != src.ver:
                            if _ver(dst) == new_ver:
                                dst.unlink()               # old card just changed: take back ours, redo next round
                                raise _Raced(f"{src.path.name} 在改名途中变了")
                            msg = (f"改名途中原卡「{src.path.name}」与新卡「{dst.name}」都被改过，两张都留着，请手动合并")
                            log.warning("[memory] date %s: %s", plan_id, msg)
                            _save(sconn, plan_id, card_dir=str(root), card_key=key, card_hash=h, gen_keywords=gen,
                                  card_written_at=now_ts, card_ver=json.dumps(list(new_ver)),
                                  followup_hash=_text_hash(followup_of(text, schema)),
                                  card_error=msg, card_error_at=now_ts)
                            return "conflict"
                        src.path.unlink()
                except _Raced as e:
                    log.info("[memory] date %s: card left for next round: %s", plan_id, e)
                    return "raced"
                except _LeaseLost:
                    return "stopped"
                _save(sconn, plan_id, card_dir=str(root), card_key=key, card_hash=h, gen_keywords=gen,
                      card_written_at=now_ts, card_ver=json.dumps(list(new_ver)),
                      followup_hash=_text_hash(followup_of(text, schema)), card_error=None, card_error_at=None)
                _clear_pending(sconn, plan_id, pending)
                wrote = True
        if wrote:
            result = "renamed" if (old_key and old_key != key) else ("updated" if prev.get("card_written_at") else "written")
        prev = _state(sconn, plan_id)
    # follow-up: written → close the ask; not written and never asked → ask the AI for it
    if prev.get("after_done_at"):
        return result
    cur = _read(dst)
    if cur is not None and followup_of(cur.text, schema):
        if prev.get("asked_at"):
            dp.complete_ask(plan_id, ASK_WHAT, conn=sconn)
        _save(sconn, plan_id, after_done_at=now_ts)
    elif not prev.get("asked_at") and cur is not None:
        dp.add_ask(plan_id, ASK_WHAT, conn=sconn)
        _save(sconn, plan_id, asked_at=now_ts)
    return result


# ── structured export ─────────────────────────────────────────────────────────────
def _iso(ts) -> str | None:
    return datetime.fromtimestamp(ts, config.tz()).isoformat(timespec="seconds") if ts else None


def build_entry(st: dict, captions: dict | None = None) -> dict:
    """A finished date → the JSON memory entry, without ``version`` / ``exported_at`` (see EXPORT_SCHEMA)."""
    p = st["plan"]
    captions = captions or {}
    main, sub = dp.display_name(p)
    letters = st.get("letters") or {}
    stops, photos = [], []
    for n, s in enumerate(st["stops"], 1):
        stops.append({"n": n, "time": s.get("time"), "stay_until": s.get("stay_until"),
                      "title": s.get("title"), "address": s.get("address"),
                      "kind": dp.stop_kind(s), "label": dp.stop_label(s), "no_place": dp.is_no_place(s),
                      "clue": s.get("clue"), "note": s.get("note"), "her_line": s.get("her_line"),
                      "skipped": dp.is_skipped(s), "skip_reason": s.get("skip_reason") if dp.is_skipped(s) else None})
        photos += [{"stop_n": n, "caption": c} for c in captions.get(s["id"], [])]
    photos += [{"stop_n": None, "caption": c} for c in captions.get(None, [])]
    return {
        "id": p["id"], "paper_no": p.get("paper_no"),
        "name": dp.full_name(p), "title_en": main, "title_zh": sub or None,
        "date": p["date"], "together_day": dp.together_day(p),
        "names": {"her": config.her(), "him": config.him()},
        "stops": stops,
        "letters": {"her": (letters.get("her") or {}).get("text"), "him": (letters.get("him") or {}).get("text")},
        "photos": photos,
        "quote": p.get("quote"), "card": p.get("card_text"), "contract": p.get("contract"),
        "invite": p.get("invite_text"),
        "closed_at": _iso(p.get("closed_at")),
        "plan_version": p.get("version"),
    }


def _json_one(ro, sconn, plan_id: int, root: Path, now_ts: float, still_owner=None) -> str:
    st = dp._load(ro, plan_id)
    if st is None:
        return "gone"
    prev = _state(sconn, plan_id)
    entry = build_entry(st, photo_captions(ro, plan_id))
    h = hashlib.sha256(json.dumps(entry, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    dst = root / f"date-{plan_id}.json"
    if h == prev.get("json_hash") and prev.get("json_file") == str(dst):
        return "same"
    version = int(prev.get("json_version") or 0) + 1
    doc = {"schema": EXPORT_SCHEMA, "version": version, "exported_at": _iso(now_ts), **entry}
    root.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".ephemera-", suffix=".tmp", dir=str(root))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
            f.write("\n")
        mode = _mode_of(dst)                     # rewrite keeps the file's permissions; new = the usual ones
        os.chmod(tmp, new_file_mode() if mode is None else mode)
        if still_owner is not None and not still_owner():
            return "stopped"
        os.replace(tmp, dst)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    _save(sconn, plan_id, json_file=str(dst), json_hash=h, json_version=version, json_written_at=now_ts,
          json_error=None, json_error_at=None)
    return "updated" if prev.get("json_file") else "written"


def _prune_json(ro, sconn, still_owner=None) -> dict:
    """Exports whose date no longer exists → file removed (only files this module wrote)."""
    out = {}
    rows = sconn.execute("SELECT plan_id, json_file FROM ephemera_memory_state WHERE json_file IS NOT NULL").fetchall()
    for pid, f in rows:
        if ro.execute("SELECT 1 FROM date_plans WHERE id=?", (pid,)).fetchone() is not None:
            continue
        if still_owner is not None and not still_owner():
            break
        try:
            os.unlink(f)
        except FileNotFoundError:
            pass
        _save(sconn, pid, json_file=None, json_hash=None, json_written_at=None)
        out[pid] = "deleted"
    return out


# ── the scheduler job ─────────────────────────────────────────────────────────────
def run_once(*, now: datetime | None = None, path: str | None = None, still_owner=None) -> dict:
    """One round → {"cards": {plan_id: result}, "json": {plan_id: result}}. Results: written / updated /
    renamed / same / removed / raced / conflict / stopped / deleted / error:…  One date failing never stops
    the others and never raises; it is retried next round."""
    cards_root, export_root = config.cards_dir(), config.memory_export_dir()
    out: dict = {"cards": {}, "json": {}}
    if cards_root is None and export_root is None:
        return out
    now_ts = dp._as_tz(now).timestamp()
    db = path or dp._db_path()
    if not os.path.exists(db):
        return out
    ro = _open_ro(db)
    try:
        try:
            ids = [r[0] for r in ro.execute("SELECT id FROM date_plans WHERE status='done' ORDER BY id")]
        except sqlite3.OperationalError as e:
            if "no such table" in str(e):
                return out
            raise
        sconn = _open_state(db)
        try:
            schema = None
            if cards_root is not None and ids:
                try:
                    cards_root.mkdir(parents=True, exist_ok=True)
                    schema = load_schema(cards_root)
                except OSError as e:
                    log.warning("[memory] card directory unusable, no cards this round: %r", e)
                    for pid in ids:
                        out["cards"][pid] = f"error:{e}"
                        _save(sconn, pid, card_error=str(e)[:300], card_error_at=now_ts)
            for pid in ids:
                if still_owner is not None and not still_owner():
                    out["stopped"] = "lease lost"
                    return out
                if schema is not None:
                    try:
                        out["cards"][pid] = _card_one(ro, sconn, pid, cards_root, schema, now_ts, still_owner)
                    except Exception as e:  # noqa: BLE001 — retried next round
                        log.warning("[memory] date %s: card not written (next round retries): %r", pid, e)
                        _save(sconn, pid, card_error=str(e)[:300], card_error_at=now_ts)
                        out["cards"][pid] = f"error:{e}"
                if export_root is not None:
                    try:
                        out["json"][pid] = _json_one(ro, sconn, pid, export_root, now_ts, still_owner)
                    except Exception as e:  # noqa: BLE001
                        log.warning("[memory] date %s: export not written (next round retries): %r", pid, e)
                        _save(sconn, pid, json_error=str(e)[:300], json_error_at=now_ts)
                        out["json"][pid] = f"error:{e}"
            if export_root is not None:
                out["json"].update(_prune_json(ro, sconn, still_owner))
        finally:
            sconn.close()
    finally:
        ro.close()
    return out


# ── date_memory (the AI's tool) ───────────────────────────────────────────────────
class ToolError(Exception):
    pass


def _done_plans(ro) -> list[dict]:
    try:
        return [dict(r) for r in ro.execute(
            "SELECT id FROM date_plans WHERE status='done' ORDER BY date DESC, id DESC")]
    except sqlite3.OperationalError as e:
        if "no such table" in str(e):
            return []
        raise


def _date_arg(v, field: str) -> str | None:
    if v in (None, ""):
        return None
    s = str(v).strip()
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        raise ToolError(f"{field} 要写日期 YYYY-MM-DD") from None


def _matches(st: dict, name: str | None, place: str | None, d_from: str | None, d_to: str | None) -> bool:
    p = st["plan"]
    if d_from and p["date"] < d_from:
        return False
    if d_to and p["date"] > d_to:
        return False
    if name:
        hay = " ".join((dp.full_name(p), p.get("title_en") or "", p.get("title_zh") or "")).casefold()
        if name.casefold() not in hay:
            return False
    if place:
        q = place.casefold()
        if not any(q in (s.get("title") or "").casefold() or q in (s.get("address") or "").casefold()
                   for s in st["stops"]):
            return False
    return True


def _summary(st: dict) -> str:
    p = st["plan"]
    d = date.fromisoformat(p["date"])
    bits = [f"约会 #{p['id']}「{dp.full_name(p)}」", f"{d.month}/{d.day} 周{_WD[d.weekday()]}"]
    if (td := dp.together_day(p)) is not None:
        bits.append(f"在一起的第 {td} 天")
    names = [_one_line(s.get("title")) for s in st["stops"] if (s.get("title") or "").strip()]
    bits.append(f"{len(st['stops'])} 站" + (f"：{'、'.join(names)}" if names else ""))
    return " · ".join(bits)


def _full(ro, st: dict, path: str | None = None) -> str:
    """The readable full text: the same sections as the card, plus its follow-up when there is one."""
    pid = st["plan"]["id"]
    f = build_fields(st, photo_captions(ro, pid))
    out = [f"—— {_summary(st)} ——", f"时间：{f['when']}", f"涉及谁：{f['who']}"]
    if f["what"]:
        out.append("经过：\n" + f["what"])
    if f["stance"]:
        out.append(f"{config.her()}写的：\n" + f["stance"])
    fu = _followup_now(pid, path)
    if fu:
        out.append("后续：\n" + fu)
    return "\n".join(out)


def _followup_now(plan_id: int, path: str | None = None) -> str:
    """The card's follow-up as it is on disk (or the one queued for it). No card = ""."""
    st = _state_ro(plan_id, path)
    if st.get("followup_pending"):
        return st["followup_pending"].strip()
    key, root = written_key(plan_id, path=path), config.cards_dir()
    if not key or root is None:
        return ""
    schema = load_schema(root)
    cur = _read(root / schema.event_dir / f"{key}.md")
    return followup_of(cur.text, schema) if cur else ""


def find(*, plan=None, name=None, place=None, d_from=None, d_to=None, path: str | None = None) -> str:
    """date_memory op=find. Finished dates only; anything else is never returned."""
    name = _one_line(name) or None
    place = _one_line(place) or None
    d_from, d_to = _date_arg(d_from, "from"), _date_arg(d_to, "to")
    db = path or dp._db_path()
    if not os.path.exists(db):
        return "还没有已结束的约会。"
    ro = _open_ro(db)
    try:
        if plan is not None:
            st = dp._load(ro, plan)
            if st is None or st["plan"]["status"] != "done":
                raise ToolError(f"没有已结束的约会 #{plan}")
            return _full(ro, st, path)
        hits = []
        for row in _done_plans(ro):
            st = dp._load(ro, row["id"])
            if st is not None and _matches(st, name, place, d_from, d_to):
                hits.append(st)
        if not hits:
            return "没有找到符合条件的已结束约会。" if (name or place or d_from or d_to) else "还没有已结束的约会。"
        shown = hits[:FIND_MAX]
        head = f"找到 {len(hits)} 次已结束的约会" + (f"（只列最近 {FIND_MAX} 次，缩小条件再查）" if len(hits) > FIND_MAX else "") + "："
        out = [head] + [_summary(st) for st in shown]
        out += [""] + ["\n\n".join(_full(ro, st, path) for st in shown[:FULL_MAX])]
        if len(shown) > FULL_MAX:
            out.append("\n其余的用 plan=编号 看全文。")
        return "\n".join(out)
    finally:
        ro.close()


def queue_followup(plan_id: int, text, *, now: datetime | None = None, path: str | None = None) -> str:
    """date_memory op=followup: queue the follow-up for this date's card (written by the scheduler)."""
    root = config.cards_dir()
    if root is None:
        raise ToolError("没有配置事件卡目录（EPHEMERA_CARDS_DIR），后续写不了")
    t = str(text or "").strip()
    if not t:
        raise ToolError("text 要写后续的内容")
    if len(t) > FOLLOWUP_MAX:
        raise ToolError(f"后续最多 {FOLLOWUP_MAX} 字，现在 {len(t)} 字")
    db = path or dp._db_path()
    if not os.path.exists(db):
        raise ToolError(f"没有已结束的约会 #{plan_id}")
    ro = _open_ro(db)
    try:
        st = dp._load(ro, plan_id)
    finally:
        ro.close()
    if st is None or st["plan"]["status"] != "done":
        raise ToolError(f"没有已结束的约会 #{plan_id}")
    sconn = _open_state(db)
    try:
        prev = _state(sconn, plan_id)
        key = prev.get("card_key") if prev.get("card_dir") == str(root) else None
        if key and prev.get("card_written_at"):
            if _ver(root / load_schema(root).event_dir / f"{key}.md") is None:
                raise ToolError(f"事件卡「{key}」已经被删掉或归档了，不再写")
        _save(sconn, plan_id, followup_pending=t, followup_queued_at=dp._as_tz(now).timestamp())
    finally:
        sconn.close()
    if key:
        return f"收到了，下一轮写进事件卡「{key}」的「后续」段（写卡由 ephemera-date serve 负责）。"
    return "收到了，这次约会的事件卡写出来时会带上这段后续（写卡由 ephemera-date serve 负责）。"
