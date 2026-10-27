"""The web package (the pages) served by `ephemera-date serve` under /app/.

- ``GET /`` and ``GET /app`` → 302 ``/app/``.
- ``GET|HEAD /app/{path}``: a file of the built package is served as is; any other path is a page of the app and gets
  index.html (single-page fallback). Missing files under ``_expo/`` and ``assets/`` (the hashed build output) answer
  404 instead, so a stale page never caches HTML as a script for a year; the two directory names match by exact
  case, and another case (``ASSETS/…``) is 404 too (neither a build file nor a page, on any file system).
- Every file sent, index.html included, must have its real path (symlinks followed) inside the package directory;
  ``..``, a backslash or a symlink pointing outside answers 404.
- ``If-None-Match`` uses weak comparison (``W/`` ignored, ``*`` matches) → 304.
- Other methods → 405 with ``Allow: GET, HEAD``.
- No token: the pages are public files; every request they make to /api still needs the her token.
- No built package (no index.html in config.web_dir()) → 503 with one sentence saying how to build it.
- Only these responses (files, fallback, redirects, 304, 404, 405, 503) carry the Content-Security-Policy,
  X-Content-Type-Options and Referrer-Policy headers.
"""
from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Route

from . import config

BASE = "/app"

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
    ".otf": "font/otf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}
IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"
HASHED_DIRS = ("_expo", "assets")          # file names carry a content hash: cache for a year
NO_CACHE_FILES = ("index.html", "sw.js", "canvaskit.wasm")

NOT_BUILT_TEXT = ("这台引擎上没有装网页包。从仓库安装时装好 Node.js 20.19.4 或更新、不设 EPHEMERA_BUILD_WITHOUT_WEB，"
                  "再装一次就会自动构建页面（源码目录里也可以运行 python scripts/bundle_web.py）；"
                  "或者把 EPHEMERA_WEB_DIR 设成已经构建好的 web/dist 目录。/api、/context、/mcp 不受影响。\n")


def build_info() -> dict:
    """What the package build recorded (setup.py writes ephemera_date/_build.json into wheels): {"web": bool, ...};
    {} for a source checkout or an editable install."""
    import json
    try:
        return json.loads((Path(__file__).parent / "_build.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def startup_note() -> str | None:
    """A line for the startup log when /app/ has nothing to serve (None when the pages are there)."""
    root = config.web_dir()
    if (root / "index.html").is_file():
        return None
    why = (" (this package was built with EPHEMERA_BUILD_WITHOUT_WEB=1)" if build_info().get("web") is False else "")
    return (f"no web package at {root}{why}: /app/ answers 503. Build one with scripts/bundle_web.py, "
            "or point EPHEMERA_WEB_DIR at a built web/dist.")


def csp() -> str:
    """The Content-Security-Policy of every /app/ response (read at call time: tests change the env)."""
    connect = " ".join(["'self'", "blob:", "data:", *config.web_connect_src()])
    ancestors = " ".join(["'self'", *config.embed_origins()])
    return ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' blob: data:; font-src 'self'; "
            f"connect-src {connect}; worker-src 'self'; object-src 'none'; base-uri 'self'; "
            f"frame-ancestors {ancestors}")


def security_headers() -> dict[str, str]:
    return {"Content-Security-Policy": csp(), "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"}


def _mime(path: Path) -> str:
    ext = path.suffix.lower()
    return MIME.get(ext) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _cache_control(rel: tuple[str, ...]) -> str:
    if rel and rel[0] in HASHED_DIRS and rel[-1] not in NO_CACHE_FILES:
        return IMMUTABLE
    return NO_CACHE


def _safe_parts(raw: str) -> tuple[str, ...] | None:
    """The path below /app/ as parts, or None when it tries to leave the directory or is not a plain path."""
    if "\\" in raw or "\x00" in raw:
        return None
    parts = tuple(p for p in raw.split("/") if p not in ("", "."))
    if any(p == ".." for p in parts):
        return None
    return parts


def _inside(root: Path, target: Path) -> bool:
    """The real path of target (symlinks followed) is inside the real path of root."""
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


def _etag_matches(header: str, etag: str) -> bool:
    """If-None-Match, weak comparison (RFC 9110 13.1.2): W/ prefixes are ignored; "*" matches any current file."""
    strip = lambda t: t[2:] if t[:2] in ("W/", "w/") else t      # noqa: E731
    tags = [t.strip() for t in header.split(",") if t.strip()]
    return "*" in tags or strip(etag) in {strip(t) for t in tags}


def _not_found() -> Response:
    return PlainTextResponse("not found", status_code=404, headers=security_headers())


def _file(request: Request, root: Path, path: Path, rel: tuple[str, ...]) -> Response:
    """Every file goes out through here: inside the package directory (real path) or 404."""
    if not _inside(root, path) or not path.is_file():
        return _not_found()
    st = os.stat(path)
    headers = {**security_headers(), "Cache-Control": _cache_control(rel)}
    resp = FileResponse(path, media_type=_mime(path), headers=headers, stat_result=st)
    etag = resp.headers.get("etag")
    if etag and _etag_matches(request.headers.get("if-none-match", ""), etag):
        return Response(status_code=304, headers={**headers, "ETag": etag})
    return resp


def _method_not_allowed() -> Response:
    return PlainTextResponse("method not allowed", status_code=405,
                             headers={**security_headers(), "Allow": "GET, HEAD"})


async def app_files(request: Request) -> Response:
    if request.method not in ("GET", "HEAD"):
        return _method_not_allowed()
    root = config.web_dir()
    index = root / "index.html"
    if not index.is_file():
        return PlainTextResponse(NOT_BUILT_TEXT, status_code=503,
                                 headers={**security_headers(), "Cache-Control": NO_CACHE})
    parts = _safe_parts(request.path_params.get("path", ""))
    if parts is None:
        return _not_found()
    if not parts:
        return _file(request, root, index, ("index.html",))
    if parts[0] not in HASHED_DIRS and parts[0].lower() in HASHED_DIRS:
        # _expo / assets match by exact case only: ASSETS/x.js is neither a build file nor a page of the app
        return _not_found()
    target = root.joinpath(*parts)
    if not _inside(root, target):
        return _not_found()
    if target.is_file():
        return _file(request, root, target, parts)
    if parts[0] in HASHED_DIRS:
        return _not_found()
    return _file(request, root, index, ("index.html",))     # a page of the app: the app decides what to show


async def to_app(request: Request) -> Response:
    if request.method not in ("GET", "HEAD"):
        return _method_not_allowed()
    return RedirectResponse(BASE + "/", status_code=302, headers=security_headers())


def routes() -> list[Route]:
    """Mounted after /api, /context and /mcp. Every method reaches the handlers, so a 405 carries the security
    headers too."""
    return [
        Route("/", to_app, methods=ALL_METHODS),
        Route(BASE, to_app, methods=ALL_METHODS),
        Route(BASE + "/{path:path}", app_files, methods=ALL_METHODS),
    ]


ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]
