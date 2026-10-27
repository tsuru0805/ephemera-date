"""The web package served at /app/ by `ephemera-date serve` (webapp.py): redirect, single-page fallback, no way out
of the package directory, MIME types, cache headers, the security headers, 503 without a build, no token for the
static files while /api keeps its token. A fake build in tmp; no network."""
from __future__ import annotations

import pytest
from conftest import AI_TOKEN, HER_TOKEN, H
from starlette.testclient import TestClient

from ephemera_date import config, server, webapp

INDEX = "<!doctype html><title>Ephemera</title><script src=\"/app/_expo/static/js/web/index-abc.js\" defer></script>"


@pytest.fixture()
def dist(tmp_path):
    d = tmp_path / "dist"
    (d / "_expo" / "static" / "js" / "web").mkdir(parents=True)
    (d / "assets" / "fonts").mkdir(parents=True)
    (d / "licenses").mkdir()
    (d / "index.html").write_text(INDEX, encoding="utf-8")
    (d / "_expo" / "x.js").write_text("console.log(1)")
    (d / "_expo" / "static" / "js" / "web" / "index-abc.js").write_text("console.log(2)")
    (d / "canvaskit.wasm").write_bytes(b"\0asm\1\0\0\0")
    (d / "sw.js").write_text("self.addEventListener('push', () => {})")
    (d / "assets" / "fonts" / "Serif.abc123.woff2").write_bytes(b"wOF2")
    (d / "licenses" / "OFL-1.1.txt").write_text("SIL Open Font License")
    (tmp_path / "secret.txt").write_text("outside the package")
    return d


def _client(monkeypatch, web_dir, **env):
    monkeypatch.setenv("EPHEMERA_HER_TOKEN", HER_TOKEN)
    monkeypatch.setenv("EPHEMERA_AI_TOKEN", AI_TOKEN)
    monkeypatch.setenv("EPHEMERA_WEB_DIR", str(web_dir))
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return TestClient(server.build_app(run_scheduler=False), follow_redirects=False)


@pytest.fixture()
def web(monkeypatch, dist):
    with _client(monkeypatch, dist) as c:
        yield c


def test_root_and_bare_base_redirect_to_app(web):
    for path in ("/", "/app"):
        r = web.get(path)
        assert r.status_code == 302 and r.headers["location"] == "/app/", path


def test_index_and_spa_fallback(web):
    r = web.get("/app/")
    assert r.status_code == 200 and r.text == INDEX and r.headers["content-type"].startswith("text/html")
    for page in ("/app/ephemera-day", "/app/ephemera-box?id=3", "/app/some/deep/page", "/app/licenses"):
        r = web.get(page)
        assert r.status_code == 200 and r.text == INDEX, page
        assert r.headers["cache-control"] == "no-cache", page


def test_missing_hashed_build_file_is_404_not_index(web):
    for path in ("/app/_expo/static/js/web/index-old.js", "/app/assets/fonts/Gone.woff2"):
        r = web.get(path)
        assert r.status_code == 404 and "<title>" not in r.text, path


def test_directory_traversal_is_refused(web):
    for path in ("/app/../secret.txt", "/app/%2e%2e/secret.txt", "/app/_expo/..%2f..%2fsecret.txt",
                 "/app/..%5csecret.txt", "/app/%2e%2e%2f%2e%2e%2fpyproject.toml"):
        r = web.get(path)
        assert "outside the package" not in r.text, path
        assert r.status_code == 404, path


def test_raw_dotdot_path_is_404(monkeypatch, dist):
    # TestClient (httpx) collapses "../" before sending; call the handler with the raw path parameter instead
    import asyncio

    from starlette.requests import Request

    async def run(path):
        scope = {"type": "http", "method": "GET", "path": f"/app/{path}", "headers": [], "query_string": b"",
                 "path_params": {"path": path}}
        return await webapp.app_files(Request(scope))

    monkeypatch.setenv("EPHEMERA_WEB_DIR", str(dist))
    for path in ("../secret.txt", "_expo/../../secret.txt", "..\\secret.txt", "a/\x00b"):
        assert asyncio.run(run(path)).status_code == 404, path
    assert asyncio.run(run("_expo/x.js")).status_code == 200


def test_symlink_out_of_the_package_is_404(web, dist):
    (dist / "leak.txt").symlink_to(dist.parent / "secret.txt")
    r = web.get("/app/leak.txt")
    assert r.status_code == 404 and "outside the package" not in r.text


def test_mime_types(web):
    cases = {"/app/canvaskit.wasm": "application/wasm", "/app/assets/fonts/Serif.abc123.woff2": "font/woff2",
             "/app/_expo/x.js": "text/javascript", "/app/sw.js": "text/javascript",
             "/app/licenses/OFL-1.1.txt": "text/plain"}
    for path, mime in cases.items():
        r = web.get(path)
        assert r.status_code == 200, path
        assert r.headers["content-type"].split(";")[0] == mime, (path, r.headers["content-type"])


def test_cache_headers(web):
    year = "public, max-age=31536000, immutable"
    assert web.get("/app/_expo/x.js").headers["cache-control"] == year
    assert web.get("/app/_expo/static/js/web/index-abc.js").headers["cache-control"] == year
    assert web.get("/app/assets/fonts/Serif.abc123.woff2").headers["cache-control"] == year
    for path in ("/app/", "/app/index.html", "/app/sw.js", "/app/canvaskit.wasm", "/app/ephemera-day"):
        assert web.get(path).headers["cache-control"] == "no-cache", path


def test_etag_revalidation_answers_304(web):
    r = web.get("/app/sw.js")
    etag = r.headers["etag"]
    r2 = web.get("/app/sw.js", headers={"If-None-Match": etag})
    assert r2.status_code == 304 and r2.content == b"" and r2.headers["cache-control"] == "no-cache"
    assert "content-security-policy" in r2.headers
    assert web.get("/app/sw.js", headers={"If-None-Match": '"other"'}).status_code == 200


def test_head_has_headers_and_no_body(web):
    r = web.head("/app/canvaskit.wasm")
    assert r.status_code == 200 and r.content == b""
    assert r.headers["content-type"] == "application/wasm" and r.headers["content-length"] == "8"
    r = web.head("/app/ephemera-day")
    assert r.status_code == 200 and r.content == b"" and r.headers["content-type"].startswith("text/html")


CSP_DEFAULT = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
               "img-src 'self' blob: data:; font-src 'self'; connect-src 'self' blob: data:; worker-src 'self'; "
               "object-src 'none'; base-uri 'self'; frame-ancestors 'self'")


def test_security_headers_on_static_responses(web):
    for path in ("/app/", "/app/ephemera-day", "/app/_expo/x.js", "/app/canvaskit.wasm", "/app/_expo/missing.js"):
        r = web.get(path)
        assert r.headers["content-security-policy"] == CSP_DEFAULT, path
        assert r.headers["x-content-type-options"] == "nosniff", path
        assert r.headers["referrer-policy"] == "no-referrer", path


def test_security_headers_only_on_app(web):
    r = web.get("/api/config", headers=H())
    assert r.status_code == 200 and "content-security-policy" not in r.headers
    assert "content-security-policy" not in web.get("/context", headers=H(AI_TOKEN)).headers


def test_embed_origins_and_connect_src(monkeypatch, dist):
    env = {"EPHEMERA_EMBED_ORIGINS": " https://host.example/ ,http://127.0.0.1:8080, *, https://x.example/path",
           "EPHEMERA_WEB_CONNECT_SRC": "https://engine.example:8443, javascript:alert(1)"}
    with _client(monkeypatch, dist, **env) as c:
        csp = c.get("/app/").headers["content-security-policy"]
    assert "frame-ancestors 'self' https://host.example http://127.0.0.1:8080" in csp
    assert csp.endswith("frame-ancestors 'self' https://host.example http://127.0.0.1:8080")
    assert "connect-src 'self' blob: data: https://engine.example:8443;" in csp
    assert "*" not in csp and "x.example" not in csp and "javascript" not in csp


def test_bad_origins_are_named_at_startup(monkeypatch):
    monkeypatch.setenv("EPHEMERA_EMBED_ORIGINS", "https://ok.example, *")
    monkeypatch.setenv("EPHEMERA_WEB_CONNECT_SRC", "engine.example")
    w = [x for x in config.startup_warnings() if "EPHEMERA_EMBED_ORIGINS" in x or "EPHEMERA_WEB_CONNECT_SRC" in x]
    assert len(w) == 2 and "'*'" in w[0] and "'engine.example'" in w[1]
    assert config.embed_origins() == ["https://ok.example"] and config.web_connect_src() == []


def test_no_build_answers_503_with_a_sentence(monkeypatch, tmp_path):
    empty = tmp_path / "nothing-built"
    empty.mkdir()
    with _client(monkeypatch, empty) as c:
        for path in ("/app/", "/app/ephemera-day", "/app/_expo/x.js"):
            r = c.get(path)
            assert r.status_code == 503, path
            assert "bundle_web.py" in r.text and "EPHEMERA_WEB_DIR" in r.text
            assert r.headers["content-type"].startswith("text/plain")
            assert r.headers["content-security-policy"] == CSP_DEFAULT
        assert c.get("/api/config", headers=H()).status_code == 200          # the API does not care


def test_missing_web_dir_also_503(monkeypatch, tmp_path):
    with _client(monkeypatch, tmp_path / "does-not-exist") as c:
        assert c.get("/app/").status_code == 503


def test_default_web_dir_is_inside_the_package(monkeypatch):
    monkeypatch.delenv("EPHEMERA_WEB_DIR", raising=False)
    import ephemera_date
    from pathlib import Path
    assert config.web_dir() == Path(ephemera_date.__file__).parent / "web"


def test_static_needs_no_token_api_still_does(web):
    assert web.get("/app/").status_code == 200                               # no Authorization header
    assert web.get("/app/_expo/x.js").status_code == 200
    assert web.get("/api/config").status_code == 401
    assert web.get("/api/dates").status_code == 401
    assert web.get("/api/config", headers=H("wrong")).status_code == 401
    assert web.get("/api/config", headers=H()).status_code == 200
    assert web.get("/context").status_code == 401
    assert web.post("/mcp", json={}).status_code == 401


def test_api_paths_are_not_swallowed_by_the_fallback(web):
    r = web.get("/api/no-such-thing", headers=H())
    assert r.status_code == 404 and "<title>" not in r.text
    assert "content-security-policy" not in r.headers


# ── codex r1: every file through the boundary check, weak ETags, headers on redirects / 405, case policy ─────────
def test_index_symlink_out_of_the_package_is_404(monkeypatch, dist):
    (dist / "index.html").unlink()
    (dist / "index.html").symlink_to(dist.parent / "secret.txt")
    with _client(monkeypatch, dist) as c:
        for path in ("/app/", "/app/ephemera-day", "/app/index.html"):
            r = c.get(path)
            assert r.status_code == 404 and "outside the package" not in r.text, path
            assert r.headers["content-security-policy"] == CSP_DEFAULT, path


def test_index_symlink_inside_the_package_is_fine(monkeypatch, dist):
    (dist / "real.html").write_text(INDEX, encoding="utf-8")
    (dist / "index.html").unlink()
    (dist / "index.html").symlink_to(dist / "real.html")
    with _client(monkeypatch, dist) as c:
        assert c.get("/app/").text == INDEX and c.get("/app/ephemera-day").text == INDEX


def test_etag_weak_comparison_and_star(web):
    etag = web.get("/app/sw.js").headers["etag"]
    for header in (f"W/{etag}", f'"nope", W/{etag}', "*", f" {etag} "):
        assert web.get("/app/sw.js", headers={"If-None-Match": header}).status_code == 304, header
    assert web.get("/app/sw.js", headers={"If-None-Match": 'W/"nope"'}).status_code == 200
    assert web.get("/app/ephemera-day", headers={"If-None-Match": "*"}).status_code == 304   # the fallback file


def test_redirects_and_405_carry_security_headers(web):
    for path in ("/", "/app"):
        r = web.get(path)
        assert r.status_code == 302 and r.headers["content-security-policy"] == CSP_DEFAULT, path
    for method, path in (("POST", "/app/"), ("PUT", "/app/sw.js"), ("DELETE", "/app/x"), ("POST", "/app"),
                         ("POST", "/"), ("TRACE", "/app/"), ("TRACE", "/")):
        r = web.request(method, path)
        assert r.status_code == 405, (method, path)
        assert r.headers["allow"] == "GET, HEAD"
        assert r.headers["content-security-policy"] == CSP_DEFAULT
        assert r.headers["x-content-type-options"] == "nosniff"


def test_hashed_dirs_match_by_exact_case(web, dist):
    for path in ("/app/ASSETS/missing.js", "/app/Assets/fonts/Serif.abc123.woff2", "/app/_EXPO/x.js"):
        r = web.get(path)
        assert r.status_code == 404 and "<title>" not in r.text, path      # never the app, even on macOS
    assert web.get("/app/assets/missing.js").status_code == 404
    assert web.get("/app/assets/fonts/Serif.abc123.woff2").headers["cache-control"].endswith("immutable")


def test_origins_are_parsed_as_urls(monkeypatch):
    monkeypatch.setenv("EPHEMERA_EMBED_ORIGINS",
                       "HTTPS://Host.Example/, http://[::1]:8443, https://x:99999, https://x:0, https://x:, "
                       "https://u@x, https://x?q, https://-bad.example, ftp://x, https://ok.example:65535")
    assert config.embed_origins() == ["https://host.example", "http://[::1]:8443", "https://ok.example:65535"]
    bad = config._origin_list("EPHEMERA_EMBED_ORIGINS")[1]
    assert bad == ["https://x:99999", "https://x:0", "https://x:", "https://u@x", "https://x?q",
                   "https://-bad.example", "ftp://x"]
    monkeypatch.setenv("EPHEMERA_WEB_CONNECT_SRC", "https://a.example;script-src *, https://b.example\r\nX: y")
    assert config.web_connect_src() == []


def test_startup_note_when_no_pages(monkeypatch, tmp_path, dist):
    monkeypatch.setenv("EPHEMERA_WEB_DIR", str(dist))
    assert webapp.startup_note() is None
    monkeypatch.setenv("EPHEMERA_WEB_DIR", str(tmp_path / "none"))
    assert "no web package" in webapp.startup_note() and "EPHEMERA_BUILD_WITHOUT_WEB" not in webapp.startup_note()
    monkeypatch.setattr(webapp, "build_info", lambda: {"web": False, "reason": "built with EPHEMERA_BUILD_WITHOUT_WEB=1"})
    assert "built with EPHEMERA_BUILD_WITHOUT_WEB=1" in webapp.startup_note()


# ── bundle_web.py and the setup.py build hook (no Node, no npm: those parts are stubbed) ───────────────────────────
import importlib.util  # noqa: E402
from pathlib import Path  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
H32 = "0123456789abcdef0123456789abcdef"


def _load(name, path, monkeypatch=None):
    if monkeypatch is not None:                     # setup.py calls setuptools.setup() when loaded
        import setuptools
        monkeypatch.setattr(setuptools, "setup", lambda **k: None)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def bw():
    return _load("bundle_web_under_test", REPO / "scripts" / "bundle_web.py")


@pytest.fixture()
def export(tmp_path):
    """A fake Expo export with hashed names under _expo/ and assets/."""
    d = tmp_path / "ephemera_date" / "web"
    (d / "_expo" / "static" / "js" / "web").mkdir(parents=True)
    (d / "assets" / "fonts").mkdir(parents=True)
    (d / "index.html").write_text(f'<script src="/app/_expo/static/js/web/index-{H32}.js" defer></script>')
    (d / "_expo" / "static" / "js" / "web" / f"index-{H32}.js").write_text("1")
    (d / "assets" / "fonts" / f"Serif.{H32}.woff2").write_bytes(b"w")
    (d / "assets" / f"close-icon.{H32}@2x.png").write_bytes(b"p")
    (d / "sw.js").write_text("")
    (d / "canvaskit.wasm").write_bytes(b"")
    return d


def test_bundle_check_accepts_a_hashed_export(bw, export):
    bw.check(export)
    assert bw.unhashed(export) == []


def test_bundle_check_refuses_unhashed_names(bw, export):
    (export / "assets" / "fonts" / "Plain.woff2").write_bytes(b"w")
    (export / "_expo" / "chunk.js").write_text("2")
    with pytest.raises(bw.BundleError, match="no content hash") as e:
        bw.check(export)
    assert "_expo/chunk.js" in str(e.value) and "assets/fonts/Plain.woff2" in str(e.value)


def test_bundle_check_refuses_another_base(bw, export):
    (export / "index.html").write_text(f'<script src="/ephemera-date/_expo/static/js/web/index-{H32}.js"></script>')
    with pytest.raises(bw.BundleError, match="not built for /app/"):
        bw.check(export)


def test_bundle_needs_node(bw, monkeypatch):
    monkeypatch.setattr(bw, "node_version", lambda: None)
    with pytest.raises(bw.BundleError, match="Node.js is not installed"):
        bw.node_ok()
    monkeypatch.setattr(bw, "node_version", lambda: (20, 19, 3))
    with pytest.raises(bw.BundleError, match="20.19.3 is too old"):
        bw.node_ok()
    monkeypatch.setattr(bw, "node_version", lambda: (20, 19, 4))
    bw.node_ok()


@pytest.fixture()
def hook(monkeypatch, bw, tmp_path):
    """setup.py loaded with setuptools.setup stubbed, its web folder in tmp and npm never run."""
    st = _load("ephemera_setup_under_test", REPO / "setup.py", monkeypatch)
    monkeypatch.setattr(st, "WEB_PKG", tmp_path / "ephemera_date" / "web")
    monkeypatch.setattr(st, "_bundle_web", lambda: bw)
    monkeypatch.setattr(bw, "_npm", lambda *a, **k: pytest.fail("npm must not run in tests"))
    monkeypatch.delenv("EPHEMERA_BUILD_WITHOUT_WEB", raising=False)
    return st


def test_build_hook_uses_a_checked_web_package(hook, export):
    assert hook.ensure_web() == {"web": True, "files": 6}


def test_build_hook_refuses_an_unusable_web_package(hook, export):
    (export / "assets" / "Plain.png").write_bytes(b"p")
    with pytest.raises(hook.SetupError, match="not usable.*no content hash"):
        hook.ensure_web()


def test_build_hook_without_node_fails_with_the_reason(hook, bw, monkeypatch):
    monkeypatch.setattr(bw, "node_version", lambda: None)
    with pytest.raises(hook.SetupError) as e:
        hook.ensure_web()
    assert "Node.js is not installed" in str(e.value) and "EPHEMERA_BUILD_WITHOUT_WEB=1" in str(e.value)
    monkeypatch.setattr(bw, "node_version", lambda: (18, 20, 0))
    with pytest.raises(hook.SetupError, match="18.20.0 is too old"):
        hook.ensure_web()


def test_build_hook_without_web_only_when_asked(hook, bw, monkeypatch):
    monkeypatch.setattr(bw, "node_version", lambda: None)
    monkeypatch.setenv("EPHEMERA_BUILD_WITHOUT_WEB", "1")
    assert hook.ensure_web() == {"web": False, "reason": "built with EPHEMERA_BUILD_WITHOUT_WEB=1"}
    monkeypatch.setenv("EPHEMERA_BUILD_WITHOUT_WEB", "0")
    with pytest.raises(hook.SetupError):
        hook.ensure_web()


def test_build_hook_without_build_script_fails(hook, monkeypatch):
    monkeypatch.setattr(hook, "_bundle_web", lambda: None)
    with pytest.raises(hook.SetupError, match="no web package .* and no scripts/bundle_web.py"):
        hook.ensure_web()
