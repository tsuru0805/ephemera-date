"""Configuration errors answer readably (never 500), the AI-side ?key= token, log masking, and CORS."""
from __future__ import annotations

import asyncio
import logging

import pytest
from conftest import AI_TOKEN, HER_TOKEN, H
from starlette.testclient import TestClient

from ephemera_date import config, http, server
from ephemera_date import tools as dt


@pytest.fixture()
def app_client(monkeypatch):
    monkeypatch.setenv("EPHEMERA_HER_TOKEN", HER_TOKEN)
    monkeypatch.setenv("EPHEMERA_AI_TOKEN", AI_TOKEN)
    with TestClient(server.build_app(run_scheduler=False)) as c:
        yield c


@pytest.fixture()
def fresh_warnings(monkeypatch):
    monkeypatch.setattr(config, "_warned", set())


@pytest.fixture()
def clean_log_filters():
    """install_log_redaction() touches global loggers: take its filters off again after the test."""
    yield
    loggers = [logging.getLogger(), *(logging.getLogger(n) for n in http._REDACT_LOGGERS)]
    for t in [*loggers, *(h for lg in loggers for h in lg.handlers)]:
        for f in [f for f in t.filters if isinstance(f, http.RedactKeyFilter)]:
            t.removeFilter(f)


MCP_INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "test", "version": "0"}}}
MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


# ══ AI-side URL key ═════════════════════════════════════════════════════════════
def test_ai_side_accepts_key_in_url(app_client):
    assert app_client.get("/context", params={"key": AI_TOKEN}).status_code == 200
    assert app_client.get("/context", params={"key": "wrong"}).status_code == 401
    r = app_client.post("/context/release", params={"key": AI_TOKEN}, json={"ids": [1], "client": "relay"})
    assert r.status_code == 200
    r = app_client.post("/mcp", params={"key": AI_TOKEN}, json=MCP_INIT, headers=MCP_HEADERS)
    assert r.status_code == 200 and r.json()["result"]["serverInfo"]["name"] == "ephemera-date"
    assert app_client.post("/mcp", json=MCP_INIT, headers=MCP_HEADERS).status_code == 401
    assert app_client.post("/mcp", params={"key": HER_TOKEN}, json=MCP_INIT, headers=MCP_HEADERS).status_code == 401


def test_header_or_key_either_one_is_enough_on_the_ai_side(app_client):
    assert app_client.get("/context", headers=H(AI_TOKEN)).status_code == 200
    # a wrong header does not hide a right key, and a right header does not need a key
    assert app_client.get("/context", params={"key": AI_TOKEN}, headers=H("nope")).status_code == 200


def test_her_side_refuses_key_in_url(app_client):
    assert app_client.get("/api/dates", params={"key": HER_TOKEN}).status_code == 401
    assert app_client.get("/api/dates", params={"key": AI_TOKEN}).status_code == 401
    assert app_client.get("/api/dates", headers=H(HER_TOKEN)).status_code == 200
    assert app_client.get("/context", params={"key": HER_TOKEN}).status_code == 401      # her token ≠ AI


def test_redact_masks_every_key_parameter():
    assert http.redact("/mcp?key=s3cret") == "/mcp?key=***"
    assert http.redact("GET /context?format=json&key=s3cret&claim=x") == "GET /context?format=json&key=***&claim=x"
    assert http.redact("/mcp?KEY=s3cret#frag") == "/mcp?KEY=***#frag"
    assert http.redact("/api/dates?monkey=1") == "/api/dates?monkey=1"          # only the key parameter
    assert http.redact("no url here") == "no url here"


def test_uvicorn_access_log_masks_the_key(clean_log_filters):
    from uvicorn.logging import AccessFormatter
    lines: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record):
            lines.append(self.format(record))

    h = Collect()
    h.setFormatter(AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False))
    lg = logging.getLogger("uvicorn.access")
    old_level, old_prop = lg.level, lg.propagate
    lg.addHandler(h)
    lg.setLevel(logging.INFO)
    lg.propagate = False
    try:
        http.install_log_redaction()
        http.install_log_redaction()                                          # idempotent
        # the exact call uvicorn's h11/httptools protocols make for an access line
        lg.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "POST", "/mcp?key=s3cret&x=1", "1.1", 200)
    finally:
        lg.removeHandler(h)
        lg.setLevel(old_level)
        lg.propagate = old_prop
    assert lines == ['127.0.0.1:5000 - "POST /mcp?key=***&x=1 HTTP/1.1" 200 OK']
    assert sum(isinstance(f, http.RedactKeyFilter) for f in lg.filters) == 1


def test_package_log_lines_are_masked_too(caplog, clean_log_filters):
    caplog.set_level(logging.INFO)
    http.install_log_redaction()
    logging.getLogger("ephemera_date.http").warning("request to %s failed", "https://x.example/mcp?key=s3cret")
    assert "s3cret" not in caplog.text and "key=***" in caplog.text


# ══ place service choice and adapter overrides ══════════════════════════════════
def test_places_provider_none_turns_search_off_with_503(app_client, monkeypatch):
    monkeypatch.setenv("EPHEMERA_PLACES_PROVIDER", "none")
    r = app_client.get("/api/dates/place_search", params={"q": "咖啡"}, headers=H())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "not_configured"
    assert "可以先手写地址" in r.json()["detail"]["text"]
    cfg = app_client.get("/api/config", headers=H()).json()
    assert cfg["places"] is False and cfg["place_service"]["available"] is False


def test_unknown_places_provider_is_a_readable_503(app_client, monkeypatch):
    monkeypatch.setenv("EPHEMERA_PLACES_PROVIDER", "bing")
    r = app_client.get("/api/dates/place_search", params={"q": "咖啡"}, headers=H())
    assert r.status_code == 503
    d = r.json()["detail"]
    assert d["code"] == "bad_config" and "EPHEMERA_PLACES_PROVIDER" in d["text"] and "'bing'" in d["text"]
    cfg = app_client.get("/api/config", headers=H())
    assert cfg.status_code == 200 and cfg.json()["place_service"]["available"] is False
    assert "EPHEMERA_PLACES_PROVIDER" in cfg.json()["place_service"]["error"]


@pytest.mark.parametrize("spec,needle", [
    ("no_such_module_xyz:thing", "导入不了模块 no_such_module_xyz"),
    ("json:no_such_attr", "模块 json 里没有 no_such_attr"),
    ("json:loads", "创建适配器时出错"),                       # a "factory" that raises when called
    ("google", "选内置地点服务用 EPHEMERA_PLACES_PROVIDER"),   # the two names mixed up
    ("not-a-spec", "module:attr"),
    ("os:path", "这不是地点服务适配器，缺少方法 search、geocode"),   # importable, but not an adapter
    ("os:sep", "这不是地点服务适配器"),
])
def test_bad_places_adapter_is_a_readable_503(app_client, monkeypatch, spec, needle):
    monkeypatch.setenv("EPHEMERA_PLACES_ADAPTER", spec)
    r = app_client.get("/api/dates/place_search", params={"q": "咖啡"}, headers=H())
    assert r.status_code == 503, r.text
    d = r.json()["detail"]
    assert d["code"] == "bad_config" and "EPHEMERA_PLACES_ADAPTER" in d["text"] and needle in d["text"]
    assert app_client.get("/api/config", headers=H()).status_code == 200


def test_bad_map_adapter_is_a_readable_503(app_client, monkeypatch):
    monkeypatch.setenv("EPHEMERA_MAP_ADAPTER", "no_such_module_xyz:thing")
    r = app_client.get("/api/dates/1/map", headers=H())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "bad_config"
    st = app_client.get("/api/config", headers=H()).json()["map_status"]
    assert st["available"] is False and "EPHEMERA_MAP_ADAPTER" in st["text"]


def test_bad_walk_adapter_is_a_readable_tool_receipt(monkeypatch):
    monkeypatch.setenv("EPHEMERA_WALK_ADAPTER", "no_such_module_xyz:thing")
    text, err = asyncio.run(dt.call("date_route", {"mode": "walk", "from": "31.23,121.47", "to": "31.24,121.48"}))
    assert err is True and text.startswith("步行时间查不了：EPHEMERA_WALK_ADAPTER=")


def test_old_adapter_names_still_work_and_warn(app_client, monkeypatch, caplog, fresh_warnings):
    caplog.set_level(logging.WARNING, logger="ephemera_date.config")
    monkeypatch.setenv("EPHEMERA_PLACE_PROVIDER", "none")
    r = app_client.get("/api/dates/place_search", params={"q": "咖啡"}, headers=H())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "not_configured"
    assert "EPHEMERA_PLACE_PROVIDER is an old name; it is still read as EPHEMERA_PLACES_ADAPTER" in caplog.text
    n = caplog.text.count("EPHEMERA_PLACE_PROVIDER is an old name")
    app_client.get("/api/dates/place_search", params={"q": "咖啡"}, headers=H())
    assert caplog.text.count("EPHEMERA_PLACE_PROVIDER is an old name") == n         # once, not per request
    assert any("EPHEMERA_PLACE_PROVIDER" in w for w in config.startup_warnings())


@pytest.mark.parametrize("old,new,getter", [
    ("EPHEMERA_PLACE_PROVIDER", "EPHEMERA_PLACES_ADAPTER", config.place_provider_spec),
    ("EPHEMERA_WALK_ROUTER", "EPHEMERA_WALK_ADAPTER", config.walk_router_spec),
    ("EPHEMERA_MAP_RENDERER", "EPHEMERA_MAP_ADAPTER", config.map_renderer_spec),
    ("EPHEMERA_ART_GENERATOR", "EPHEMERA_ART_ADAPTER", config.art_generator_spec),
])
def test_old_name_maps_and_new_name_wins(monkeypatch, fresh_warnings, old, new, getter):
    monkeypatch.setenv(old, "a.b:old")
    assert getter() == "a.b:old"
    monkeypatch.setenv(new, "a.b:new")
    assert getter() == "a.b:new"
    assert f"{old} is an old name and is ignored because {new} is also set; remove {old}." in config.startup_warnings()


def test_startup_logs_configuration_warnings(monkeypatch, caplog, capsys):
    monkeypatch.setenv("EPHEMERA_MAP_RENDERER", "none")
    monkeypatch.setenv("EPHEMERA_PLACES_PROVIDER", "bing")
    monkeypatch.setenv("EPHEMERA_PLACES_STORE_POLICY", "keep")
    monkeypatch.setenv("EPHEMERA_ALLOWED_ORIGINS", "*")
    caplog.set_level(logging.WARNING, logger="ephemera_date.server")
    server.main(["vapid-keys"])
    assert "EPHEMERA_VAPID_PRIVATE_KEY=" in capsys.readouterr().out
    for needle in ("EPHEMERA_MAP_RENDERER is an old name", "EPHEMERA_PLACES_PROVIDER='bing' is not one of",
                   "EPHEMERA_PLACES_STORE_POLICY='keep' is not one of", 'EPHEMERA_ALLOWED_ORIGINS: "*" is not accepted'):
        assert needle in caplog.text


# ══ CORS ════════════════════════════════════════════════════════════════════════
PAGE = "https://app.example.com"


def test_no_allowed_origins_means_no_cors_headers(app_client):
    r = app_client.get("/api/config", headers={**H(), "Origin": PAGE})
    assert r.status_code == 200 and "access-control-allow-origin" not in r.headers
    r = app_client.options("/api/dates", headers={"Origin": PAGE, "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers


def _cors_client(monkeypatch, origins: str):
    monkeypatch.setenv("EPHEMERA_HER_TOKEN", HER_TOKEN)
    monkeypatch.setenv("EPHEMERA_AI_TOKEN", AI_TOKEN)
    monkeypatch.setenv("EPHEMERA_ALLOWED_ORIGINS", origins)
    return TestClient(server.build_app(run_scheduler=False))


def test_listed_origin_is_echoed_never_star(monkeypatch):
    with _cors_client(monkeypatch, f" {PAGE}/ , https://other.example:8443") as c:
        r = c.get("/api/config", headers={**H(), "Origin": PAGE})
        assert r.status_code == 200 and r.headers["access-control-allow-origin"] == PAGE
        assert "origin" in r.headers.get("vary", "").lower()
        assert "access-control-allow-credentials" not in r.headers
        r = c.get("/api/config", headers={**H(), "Origin": "https://other.example:8443"})
        assert r.headers["access-control-allow-origin"] == "https://other.example:8443"
        r = c.get("/api/config", headers={**H(), "Origin": "https://evil.example"})
        assert r.status_code == 200 and "access-control-allow-origin" not in r.headers
        assert c.get("/api/config", headers={"Origin": PAGE}).status_code == 401    # CORS is not auth


def test_preflight_allows_authorization_and_content_type(monkeypatch):
    with _cors_client(monkeypatch, PAGE) as c:
        r = c.options("/api/dates/1/her", headers={"Origin": PAGE, "Access-Control-Request-Method": "PATCH",
                                                   "Access-Control-Request-Headers": "authorization, content-type"})
        assert r.status_code == 200 and r.headers["access-control-allow-origin"] == PAGE
        allowed = r.headers["access-control-allow-headers"].lower()
        assert "authorization" in allowed and "content-type" in allowed
        assert "PATCH" in r.headers["access-control-allow-methods"]
        assert "access-control-allow-credentials" not in r.headers
        r = c.options("/api/dates", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
        assert r.status_code == 400 and "access-control-allow-origin" not in r.headers
        r = c.options("/api/dates", headers={"Origin": PAGE, "Access-Control-Request-Method": "GET",
                                             "Access-Control-Request-Headers": "x-custom"})
        assert r.status_code == 400                                              # other headers are not allowed


def test_star_is_ignored(monkeypatch):
    assert config.allowed_origins() == []
    with _cors_client(monkeypatch, "*") as c:
        r = c.get("/api/config", headers={**H(), "Origin": PAGE})
        assert "access-control-allow-origin" not in r.headers
    monkeypatch.setenv("EPHEMERA_ALLOWED_ORIGINS", f"*,{PAGE}")
    assert config.allowed_origins() == [PAGE]


@pytest.mark.parametrize("env,kind", [("EPHEMERA_WALK_ADAPTER", "步行路线服务"), ("EPHEMERA_MAP_ADAPTER", "地图")])
def test_importable_non_adapter_is_bad_config_not_500(app_client, monkeypatch, env, kind):
    monkeypatch.setenv(env, "os:path")
    if env == "EPHEMERA_MAP_ADAPTER":
        r = app_client.get("/api/dates/1/map", headers=H())
        assert r.status_code == 503 and r.json()["detail"]["code"] == "bad_config"
        assert f"这不是{kind}适配器" in r.json()["detail"]["text"]
    else:
        text, err = asyncio.run(dt.call("date_route", {"mode": "walk", "from": "31.23,121.47", "to": "31.24,121.48"}))
        assert err is True and f"这不是{kind}适配器" in text
