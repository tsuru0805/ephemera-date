#!/usr/bin/env python3
"""Build the web package and put it inside the Python package, so `ephemera-date serve` serves it at /app/.

    python scripts/bundle_web.py                 # npm ci (when web/node_modules is missing) + npm run build + copy
    python scripts/bundle_web.py --no-build      # only copy an existing web/dist
    python scripts/bundle_web.py --from DIR      # copy a dist built elsewhere

What it does:
  1. checks Node.js (20.19.4 or newer, the floor of react-native 0.81 / metro in web/package-lock.json);
  2. `npm ci` in web/ when web/node_modules is missing, then `npm run build` with EPHEMERA_WEB_BASE=/app
     (the engine serves the pages at /app/; another base path is only for hosting the export somewhere else);
  3. checks the export: index.html loads its scripts from /app/, and every file under _expo/ and assets/ carries a
     content hash in its name (the engine caches those for a year);
  4. replaces src/ephemera_date/web/ with a copy of web/dist (that folder is not in git).

Building a wheel or an sdist (pip install ., python -m build) runs the same steps on its own when the package has no
web package yet (setup.py); see the README for the three ways to install. Instead of bundling,
EPHEMERA_WEB_DIR=<path to a dist> points a running engine at any build.

Standard library only: setup.py imports this file inside the isolated build environment.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
PACKAGE = ROOT / "src" / "ephemera_date"
DEST = PACKAGE / "web"
NODE_MIN = (20, 19, 4)
BASE = "/app"
HASHED_DIRS = ("_expo", "assets")
# name.<32 hex>.ext, name-<32 hex>.ext, name.<32 hex>@2x.ext (Expo's export names)
_HASHED_NAME = re.compile(r"[.-][0-9a-f]{32}(@\d+(\.\d+)?x)?\.[A-Za-z0-9]+$")


class BundleError(Exception):
    """A readable reason the web package could not be built or bundled."""


def node_version() -> tuple[int, int, int] | None:
    node = shutil.which("node")
    if not node:
        return None
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, check=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"v(\d+)\.(\d+)\.(\d+)", out.strip())
    return tuple(int(x) for x in m.groups()) if m else None      # type: ignore[return-value]


def node_ok() -> None:
    v = node_version()
    if v is None:
        raise BundleError("Node.js is not installed (need 20.19.4 or newer to build the pages): https://nodejs.org/")
    if v < NODE_MIN:
        raise BundleError(f"Node.js {'.'.join(map(str, v))} is too old: the pages need 20.19.4 or newer.")


def _npm(*args: str, env: dict | None = None) -> None:
    npm = shutil.which("npm")
    if not npm:
        raise BundleError("npm is not installed (it comes with Node.js).")
    print("+ npm", " ".join(args), flush=True)
    try:
        subprocess.run([npm, *args], cwd=WEB, env=env, check=True)
    except subprocess.CalledProcessError as e:
        raise BundleError(f"`npm {' '.join(args)}` in web/ failed (exit {e.returncode}); see the output above.") from None


def build() -> Path:
    if not (WEB / "package.json").is_file():
        raise BundleError(f"no web package sources at {WEB} (web/package.json is missing).")
    node_ok()
    if not (WEB / "node_modules").is_dir():
        _npm("ci")
    env = {**os.environ, "EPHEMERA_WEB_BASE": BASE}
    if os.environ.get("EPHEMERA_WEB_BASE", BASE).rstrip("/") != BASE:
        print(f"note: EPHEMERA_WEB_BASE={os.environ['EPHEMERA_WEB_BASE']!r} ignored; the engine serves /app/")
    _npm("run", "build", env=env)
    return WEB / "dist"


def unhashed(dist: Path) -> list[str]:
    """Files under _expo/ and assets/ whose names carry no content hash (relative paths)."""
    out = []
    for d in HASHED_DIRS:
        for p in sorted((dist / d).rglob("*")) if (dist / d).is_dir() else []:
            if p.is_file() and not _HASHED_NAME.search(p.name):
                out.append(p.relative_to(dist).as_posix())
    return out


def check(dist: Path) -> None:
    index = dist / "index.html"
    if not index.is_file():
        raise BundleError(f"{index} does not exist: nothing to bundle.")
    html = index.read_text(encoding="utf-8", errors="replace")
    if f'src="{BASE}/_expo/' not in html:
        raise BundleError(f"{index} was not built for {BASE}/ (its scripts do not load from {BASE}/_expo/); "
                          "build it again without EPHEMERA_WEB_BASE.")
    if not (dist / "_expo").is_dir():
        raise BundleError(f"{dist} has no _expo/ directory: not an Expo web export.")
    bad = unhashed(dist)
    if bad:
        raise BundleError("these files would be cached for a year but carry no content hash in their names: "
                          + ", ".join(bad[:10]) + (f" (and {len(bad) - 10} more)" if len(bad) > 10 else ""))


def copy(dist: Path, dest: Path = DEST) -> int:
    if dest.exists():
        if dest.resolve().name != "web" or dest.resolve().parent.name != "ephemera_date":
            raise BundleError(f"refusing to replace {dest}: not the package's web folder")
        shutil.rmtree(dest)
    shutil.copytree(dist, dest)
    files = [p for p in dest.rglob("*") if p.is_file()]
    size = sum(p.stat().st_size for p in files)
    print(f"bundled {len(files)} files ({size / 1e6:.1f} MB) into {dest}")
    return len(files)


def bundle(src: Path | None = None, *, no_build: bool = False) -> int:
    """Build (unless told not to), check and copy. → number of files bundled. Raises BundleError."""
    dist = src.expanduser().resolve() if src else (WEB / "dist" if no_build else build())
    check(dist)
    return copy(dist)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--no-build", action="store_true", help="copy the existing web/dist without building")
    ap.add_argument("--from", dest="src", type=Path, help="copy this dist directory instead of web/dist")
    a = ap.parse_args(argv)
    try:
        bundle(a.src, no_build=a.no_build)
    except BundleError as e:
        sys.exit(f"bundle_web: {e}")


if __name__ == "__main__":
    main()
