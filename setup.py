"""Build hooks: a wheel or an sdist always carries the web package (the pages served at /app/), unless asked not to.

Everything else about the package is in pyproject.toml; this file only adds two command hooks.

- build_py (wheels, `pip install .`, `pip install git+…`) and sdist: when src/ephemera_date/web/ has no index.html,
  build the pages with scripts/bundle_web.py (needs Node.js 20.19.4 or newer). No Node, or the build fails → the
  package build fails with the reason. A web package already in place is checked (built for /app, hashed names) and
  used as is.
- EPHEMERA_BUILD_WITHOUT_WEB=1: a package without the pages is allowed. The wheel then says so in
  ephemera_date/_build.json ({"web": false, ...}), and `ephemera-date serve` says so in its startup log.
- Editable installs (`pip install -e .`) never build the pages: the source tree is used as is
  (run scripts/bundle_web.py, or set EPHEMERA_WEB_DIR, to get pages there).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py
from setuptools.command.sdist import sdist

try:
    from setuptools.errors import SetupError
except ImportError:                                     # pragma: no cover — older setuptools
    from distutils.errors import DistutilsSetupError as SetupError  # type: ignore[no-redef]

HERE = Path(__file__).resolve().parent
WEB_PKG = HERE / "src" / "ephemera_date" / "web"
WITHOUT_WEB_VAR = "EPHEMERA_BUILD_WITHOUT_WEB"
HOW_TO_SKIP = (f"To build a package without the pages (engine only: /app/ will answer 503), set {WITHOUT_WEB_VAR}=1. "
               "The Docker image always includes them.")


def _without_web() -> bool:
    return os.environ.get(WITHOUT_WEB_VAR, "").strip().lower() in ("1", "true", "yes")


def _bundle_web():
    """scripts/bundle_web.py as a module (standard library only), or None when it is not in this source tree."""
    path = HERE / "scripts" / "bundle_web.py"
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location("_ephemera_bundle_web", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)                        # type: ignore[union-attr]
    return mod


def ensure_web() -> dict:
    """Make sure the package's web folder holds a checked build. → the build info written into the wheel."""
    bw = _bundle_web()
    if (WEB_PKG / "index.html").is_file():
        if bw is not None:
            try:
                bw.check(WEB_PKG)
            except bw.BundleError as e:
                raise SetupError(f"the web package in {WEB_PKG} is not usable: {e} "
                                 "Rebuild it with `python scripts/bundle_web.py`.") from None
        return {"web": True, "files": sum(1 for p in WEB_PKG.rglob("*") if p.is_file())}
    if _without_web():
        print(f"warning: {WITHOUT_WEB_VAR}=1: building the package WITHOUT the pages (/app/ will answer 503)")
        return {"web": False, "reason": f"built with {WITHOUT_WEB_VAR}=1"}
    if bw is None:
        raise SetupError("this source tree has no web package (src/ephemera_date/web/) and no scripts/bundle_web.py "
                         "to build one. " + HOW_TO_SKIP)
    try:
        n = bw.bundle()
    except bw.BundleError as e:
        raise SetupError(f"the pages could not be built: {e} " + HOW_TO_SKIP) from None
    return {"web": True, "files": n}


class BuildPyWithWeb(build_py):
    def run(self):
        info = None
        if not getattr(self, "editable_mode", False):
            info = ensure_web()
            self.__dict__.pop("data_files", None)       # the web files may be new: list package data again
        super().run()
        if info is not None:
            out = Path(self.build_lib) / "ephemera_date" / "_build.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(info) + "\n", encoding="utf-8")


class SDistWithWeb(sdist):
    def run(self):
        ensure_web()                                    # the built pages go into the sdist as package data
        super().run()


setup(cmdclass={"build_py": BuildPyWithWeb, "sdist": SDistWithWeb})
