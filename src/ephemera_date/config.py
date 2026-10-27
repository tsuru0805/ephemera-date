"""Configuration — environment variables only, read at call time (tests point them at tmp).

Every name lives here; nothing else in the package reads os.environ directly.

    EPHEMERA_DATA_DIR        data directory (database, photos, generated art). Default: the user data dir
                             (macOS ~/Library/Application Support/ephemera, Linux $XDG_DATA_HOME/ephemera
                             or ~/.local/share/ephemera, Windows %APPDATA%/ephemera)
    EPHEMERA_TZ              IANA time zone of the couple (e.g. Asia/Shanghai). Default: $TZ, then the
                             system zone (/etc/localtime), then UTC
    EPHEMERA_TOGETHER_SINCE  optional YYYY-MM-DD: day 1 of "together for N days"; unset = not shown
    EPHEMERA_HIM / EPHEMERA_HER   how every text the engine writes (tool descriptions and receipts, errors,
                                  to-dos, /context, push titles, event cards and memory) refers to the two of
                                  you (default 他 / 她)
    EPHEMERA_HIM_EN / EPHEMERA_HER_EN   the same two names for English lines on the papers ("Dear …,", "FROM : …",
                                  "… WROTE BACK"); the engine only passes them to the page in /api/config
                                  (him_en / her_en). Default Him / Her
    EPHEMERA_HER_TOKEN       bearer token for the page / host app (her side HTTP API)
    EPHEMERA_AI_TOKEN        bearer token for the AI side (MCP over HTTP, GET /context)
    EPHEMERA_EVENT_WEBHOOK   optional URL: user-facing events (envelope, telegram, ...) are POSTed here
    EPHEMERA_AI_WEBHOOK      optional URL: AI to-dos are POSTed here when due (your own relay wakes the AI)
    EPHEMERA_WEBHOOK_SECRET  optional: HMAC-SHA256 signature header for both webhooks
    EPHEMERA_AI_CHANNELS     optional explicit list of configured AI to-do channels: pull,context,webhook / none.
                             Unset = pull and context when EPHEMERA_AI_TOKEN is set (stdio-only setups: set
                             EPHEMERA_AI_CHANNELS=pull), webhook when EPHEMERA_AI_WEBHOOK is a valid http(s) URL
    EPHEMERA_QUIET_HOURS     optional "HH:MM-HH:MM": the AI webhook waits outside this window (pull/context unaffected)
    EPHEMERA_VAPID_PRIVATE_KEY / EPHEMERA_VAPID_PUBLIC_KEY / EPHEMERA_VAPID_SUBJECT
                             optional Web Push (the page opened on its own): VAPID key pair (`ephemera-date vapid-keys`
                             prints one) and a contact (mailto:you@example.com). Unset = no Web Push
    EPHEMERA_SCHEDULER_TICK_S  scheduler round interval in seconds (default 30)
    EPHEMERA_ART_TIMEOUT_S   one generated-art call may take at most this long (default 180)
    EPHEMERA_ALLOWED_ORIGINS optional comma-separated list of page origins (https://app.example.com) allowed to call
                             this server from a browser (CORS). Unset = no CORS headers at all. Never "*"; credentials
                             still travel only in the Authorization header (no cookies)
    EPHEMERA_PLACES_PROVIDER which built-in place service to use: google / amap / osm / none (default osm;
                             none = place search off; see places/config.py for the keys each one needs)
    EPHEMERA_PLACES_ADAPTER  optional "module:attr" adapter replacing the built-in place services; "none" = off
    EPHEMERA_WALK_ADAPTER    optional "module:attr" adapter for walking minutes. Unset = the local road network
                             (ephemera_date.maps.walk_between over the basemaps in EPHEMERA_MAP_DIR); "none" = off
    EPHEMERA_MAP_ADAPTER     optional "module:attr" adapter for the date map. Unset = ephemera_date.maps.build_map
                             over the basemaps in EPHEMERA_MAP_DIR; "none" = off
    EPHEMERA_ART_ADAPTER     optional "module:attr" adapter for per-stop generated art (none built in)
    EPHEMERA_ART_DAILY_MAX   generated-art starts per day (default 10)
                             Old names still read, with a warning at startup: EPHEMERA_PLACE_PROVIDER →
                             EPHEMERA_PLACES_ADAPTER, EPHEMERA_WALK_ROUTER → EPHEMERA_WALK_ADAPTER,
                             EPHEMERA_MAP_RENDERER → EPHEMERA_MAP_ADAPTER, EPHEMERA_ART_GENERATOR → EPHEMERA_ART_ADAPTER
    EPHEMERA_PLACES_STORE_POLICY  how place-service results are kept on a stop: "terms" (default) = only what the service's terms allow long term (Google: place id
                             kept, coordinates cached at most 30 days then looked up again when needed; AMap:
                             coordinates not kept, the stop is not drawn on the map); "user" = coordinates kept
                             like hand-written ones, the operator takes responsibility for the service's terms.
                             Switching back to "terms" takes kept coordinates back (Google: into the 30-day cache;
                             AMap: cleared) at startup and on every scheduler round. "terms" only governs storage:
                             it does not address Google's requirement that Places results shown on a map be shown
                             on a Google map (this map is drawn from OpenStreetMap data)
    EPHEMERA_WEB_DIR         optional directory of a built web package (web/dist) served at /app/. Default: the copy
                             bundled into the package (ephemera_date/web/, put there by scripts/bundle_web.py);
                             no index.html there = /app/ answers 503 with a sentence saying so
    EPHEMERA_EMBED_ORIGINS   optional comma-separated origins allowed to frame /app/ in an <iframe> (CSP
                             frame-ancestors), besides 'self'. Unset = 'self' only. Native web views are not affected
    EPHEMERA_WEB_CONNECT_SRC optional comma-separated engine origins the page served at /app/ may call besides this
                             engine (CSP connect-src), for a page that talks to an engine on another origin
    EPHEMERA_CARDS_DIR       optional lorecards vault: one event card per finished date (memory.py). Unset = no cards
    EPHEMERA_MEMORY_EXPORT_DIR  optional directory: one JSON memory entry per finished date. Unset = no export
"""
from __future__ import annotations

import logging
import os
import re
import sys
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

APP = "ephemera"
log = logging.getLogger("ephemera_date.config")


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


# ── paths ──────────────────────────────────────────────────────────────────────
def _user_data_dir() -> Path:
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / APP
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming") / APP
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / APP


def data_dir() -> Path:
    d = _env("EPHEMERA_DATA_DIR")
    return Path(d).expanduser() if d else _user_data_dir()


def db_path() -> str:
    return str(data_dir() / "ephemera.db")


def cards_dir() -> Path | None:
    d = _env("EPHEMERA_CARDS_DIR")
    return Path(d).expanduser() if d else None


def memory_export_dir() -> Path | None:
    d = _env("EPHEMERA_MEMORY_EXPORT_DIR")
    return Path(d).expanduser() if d else None


def photo_dir() -> Path:
    return data_dir() / "photos"


def art_dir() -> Path:
    return data_dir() / "art"


# ── time ───────────────────────────────────────────────────────────────────────
def _system_zone() -> str | None:
    try:
        target = os.path.realpath("/etc/localtime")
    except OSError:
        return None
    marker = "zoneinfo" + os.sep
    i = target.find(marker)
    return target[i + len(marker):] if i >= 0 else None


def tz_name() -> str:
    for cand in (_env("EPHEMERA_TZ"), _env("TZ").lstrip(":"), _system_zone() or ""):
        if cand:
            try:
                ZoneInfo(cand)
                return cand
            except (ZoneInfoNotFoundError, ValueError):
                continue
    return "UTC"


def tz() -> ZoneInfo:
    return ZoneInfo(tz_name())


def together_since() -> date | None:
    raw = _env("EPHEMERA_TOGETHER_SINCE")
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def together_day(on: date) -> int | None:
    """Day N of being together (start day = day 1). Unset start / before start = None (not shown)."""
    a = together_since()
    if a is None:
        return None
    n = (on - a).days + 1
    return n if n >= 1 else None


# ── names ──────────────────────────────────────────────────────────────────────
def him() -> str:
    return _env("EPHEMERA_HIM", "他")


def her() -> str:
    return _env("EPHEMERA_HER", "她")


def him_en() -> str:
    """The name used in English lines on the papers (the page reads it from /api/config)."""
    return _env("EPHEMERA_HIM_EN") or "Him"


def her_en() -> str:
    return _env("EPHEMERA_HER_EN") or "Her"


_WHO = re.compile("她|(?<!其)他")


def who(text: str) -> str:
    """Engine-written text only (never user or AI content): 她 → her(), 他 → him(); 其他 stays."""
    h, m = her(), him()
    return _WHO.sub(lambda x: h if x.group() == "她" else m, text)


# ── auth / outlets ─────────────────────────────────────────────────────────────
def her_token() -> str:
    return _env("EPHEMERA_HER_TOKEN")


def ai_token() -> str:
    return _env("EPHEMERA_AI_TOKEN")


def event_webhook() -> str:
    return _env("EPHEMERA_EVENT_WEBHOOK")


def ai_webhook() -> str:
    return _env("EPHEMERA_AI_WEBHOOK")


def webhook_secret() -> str:
    return _env("EPHEMERA_WEBHOOK_SECRET")


def ai_channels_override() -> list[str] | None:
    raw = _env("EPHEMERA_AI_CHANNELS")
    if not raw:
        return None
    if raw.lower() == "none":
        return []
    return [x.strip().lower() for x in raw.split(",") if x.strip()]


def quiet_hours() -> tuple[str, str] | None:
    raw = _env("EPHEMERA_QUIET_HOURS")
    if not raw or "-" not in raw:
        return None
    a, _, b = raw.partition("-")
    return a.strip(), b.strip()


# ── optional adapters ──────────────────────────────────────────────────────────
# new name → old name. The old names still work (a warning is logged once per name, and at startup).
LEGACY_ADAPTER_NAMES = {
    "EPHEMERA_PLACES_ADAPTER": "EPHEMERA_PLACE_PROVIDER",
    "EPHEMERA_WALK_ADAPTER": "EPHEMERA_WALK_ROUTER",
    "EPHEMERA_MAP_ADAPTER": "EPHEMERA_MAP_RENDERER",
    "EPHEMERA_ART_ADAPTER": "EPHEMERA_ART_GENERATOR",
}
_warned: set[str] = set()


def _legacy_note(new: str) -> str | None:
    old = LEGACY_ADAPTER_NAMES[new]
    if not _env(old):
        return None
    if _env(new):
        return f"{old} is an old name and is ignored because {new} is also set; remove {old}."
    return f"{old} is an old name; it is still read as {new}, please rename it."


def _adapter_spec(new: str) -> str:
    note = _legacy_note(new)
    if note and note not in _warned:
        _warned.add(note)
        log.warning("[config] %s", note)
    return _env(new) or _env(LEGACY_ADAPTER_NAMES[new])


def art_generator_spec() -> str:
    return _adapter_spec("EPHEMERA_ART_ADAPTER")


def art_daily_max() -> int:
    try:
        return max(0, int(_env("EPHEMERA_ART_DAILY_MAX", "10")))
    except ValueError:
        return 10


def place_provider_spec() -> str:
    return _adapter_spec("EPHEMERA_PLACES_ADAPTER")


def walk_router_spec() -> str:
    return _adapter_spec("EPHEMERA_WALK_ADAPTER")


def map_renderer_spec() -> str:
    return _adapter_spec("EPHEMERA_MAP_ADAPTER")


PLACE_SERVICES = ("google", "amap", "osm", "none")
_PLACE_SERVICE_ALIASES = {"nominatim": "osm", "photon": "osm", "off": "none"}


def places_provider() -> str:
    """EPHEMERA_PLACES_PROVIDER, lower-cased (aliases folded); unset = the built-in default. Not validated here:
    an unknown value is reported by ports (HTTP 503 with a readable text) and by startup_warnings()."""
    from .places.config import DEFAULT_PROVIDER
    v = _env("EPHEMERA_PLACES_PROVIDER", DEFAULT_PROVIDER).lower()
    return _PLACE_SERVICE_ALIASES.get(v, v)


def allowed_origins() -> list[str]:
    """EPHEMERA_ALLOWED_ORIGINS → exact origins (scheme://host[:port], no trailing slash). "*" is never accepted."""
    out = []
    for x in _env("EPHEMERA_ALLOWED_ORIGINS").split(","):
        x = x.strip().rstrip("/")
        if x and x != "*" and x not in out:
            out.append(x)
    return out


def startup_warnings() -> list[str]:
    """Configuration problems worth a log line at startup (the server still starts; each feature reports its own
    error when used)."""
    out = [n for new in LEGACY_ADAPTER_NAMES if (n := _legacy_note(new))]
    prov = places_provider()
    if prov not in PLACE_SERVICES:
        out.append(f"EPHEMERA_PLACES_PROVIDER={_env('EPHEMERA_PLACES_PROVIDER')!r} is not one of "
                   f"{' / '.join(PLACE_SERVICES)}; place search will answer 503 until it is fixed.")
    raw_policy = _env("EPHEMERA_PLACES_STORE_POLICY").lower()
    if raw_policy and raw_policy not in STORE_POLICIES:
        out.append(f"EPHEMERA_PLACES_STORE_POLICY={raw_policy!r} is not one of {' / '.join(STORE_POLICIES)}; "
                   f"using {DEFAULT_STORE_POLICY!r}.")
    if "*" in [x.strip() for x in _env("EPHEMERA_ALLOWED_ORIGINS").split(",")]:
        out.append("EPHEMERA_ALLOWED_ORIGINS: \"*\" is not accepted (list each page origin); it is ignored.")
    for name in ("EPHEMERA_EMBED_ORIGINS", "EPHEMERA_WEB_CONNECT_SRC"):
        bad = _origin_list(name)[1]
        if bad:
            out.append(f"{name}: {', '.join(repr(b) for b in bad)} is not an origin like https://app.example.com; "
                       "ignored.")
    return out


# ── web package (/app/) ─────────────────────────────────────────────────────────
_HOST = re.compile(r"^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$")


def _origin(raw: str) -> str | None:
    """One configured origin → "scheme://host[:port]" (scheme and host lower case), or None when it is not one:
    only http/https, no user, path, query or fragment, a plain host name or address, a port in 1–65535."""
    from urllib.parse import urlsplit
    if any(c.isspace() or c in ";,'\"" for c in raw):
        return None
    try:
        u = urlsplit(raw)
        port = u.port
    except ValueError:                                  # bad port (out of range, not a number) or bad brackets
        return None
    if u.scheme.lower() not in ("http", "https") or u.username is not None or u.password is not None:
        return None
    if u.path not in ("", "/") or u.query or u.fragment or raw.endswith(("?", "#")):
        return None
    host = u.hostname or ""                              # lower case, IPv6 without brackets
    if ":" in host:
        host = f"[{host}]"
    if u.netloc.endswith(":") or not _HOST.match(host) or (port is not None and not 1 <= port <= 65535):
        return None
    return f"{u.scheme.lower()}://{host}" + (f":{port}" if port is not None else "")


def _origin_list(name: str) -> tuple[list[str], list[str]]:
    """Comma-separated origins → (valid, rejected). Only scheme://host[:port] passes; no paths, no "*"."""
    ok: list[str] = []
    bad: list[str] = []
    for x in _env(name).split(","):
        x = x.strip()
        if not x:
            continue
        o = _origin(x)
        if o is None:
            bad.append(x)
        elif o not in ok:
            ok.append(o)
    return ok, bad


def web_dir() -> Path:
    """Where the built web package is: EPHEMERA_WEB_DIR, else the copy bundled into the package."""
    d = _env("EPHEMERA_WEB_DIR")
    return Path(d).expanduser() if d else Path(__file__).parent / "web"


def embed_origins() -> list[str]:
    """Origins allowed to frame /app/ (CSP frame-ancestors) besides 'self', which is always allowed."""
    return _origin_list("EPHEMERA_EMBED_ORIGINS")[0]


def web_connect_src() -> list[str]:
    """Extra origins the page at /app/ may fetch from (CSP connect-src), besides 'self'."""
    return _origin_list("EPHEMERA_WEB_CONNECT_SRC")[0]


STORE_POLICIES = ("terms", "user")
DEFAULT_STORE_POLICY = "terms"


def places_store_policy() -> str:
    v = _env("EPHEMERA_PLACES_STORE_POLICY", DEFAULT_STORE_POLICY).lower()
    return v if v in STORE_POLICIES else DEFAULT_STORE_POLICY


def vapid_private_key() -> str:
    return _env("EPHEMERA_VAPID_PRIVATE_KEY")


def vapid_public_key() -> str:
    return _env("EPHEMERA_VAPID_PUBLIC_KEY")


def vapid_subject() -> str:
    return _env("EPHEMERA_VAPID_SUBJECT")


def _float(name: str, default: float) -> float:
    try:
        return max(0.01, float(_env(name, str(default))))
    except ValueError:
        return default


def scheduler_tick_s() -> float:
    return _float("EPHEMERA_SCHEDULER_TICK_S", 30.0)


def art_timeout_s() -> float:
    return _float("EPHEMERA_ART_TIMEOUT_S", 180.0)


def validate_roles() -> None:
    """The page token must never be able to act as the AI (and the other way round)."""
    if her_token() and her_token() == ai_token():
        raise ValueError("EPHEMERA_HER_TOKEN and EPHEMERA_AI_TOKEN must differ "
                         "(the page must not be able to act as the AI).")
