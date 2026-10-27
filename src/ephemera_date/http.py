"""HTTP API: her side (the page / a host app) and the AI side's GET /context.

Two roles, two bearer tokens (config.her_token / config.ai_token):
- her: /api/*  — the page reads only the projection (plan.project), never raw rows.
- ai:  /context and /mcp (mounted in server.py).
A token never works for the other role. Her token only travels in the Authorization header. The AI token
also works as ``?key=<AI token>`` on /mcp and /context* (for MCP clients such as claude.ai connectors that cannot
set a request header); the header is preferred because a URL can end up in proxy logs and browser history,
and log lines have ``key=`` masked (see install_log_redaction).
A role without a configured token is reachable only as localhost (a tunnel / forwarded port / DNS-rebinding
host name is refused).

Errors are JSON {"detail": ...}: a string, or {code, text[, op_index, field]} for her writes. A draft date
and a date that does not exist answer the same 404.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import re

from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from . import config, inbox, ports, tools, webpush
from . import her as date_her
from . import kinds
from . import plan as dp

log = logging.getLogger("ephemera_date.http")
LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}


class HTTPError(Exception):
    def __init__(self, status: int, detail):
        super().__init__(str(detail))
        self.status, self.detail = status, detail


def _host_is_loopback(request: Request) -> bool:
    host = (request.headers.get("host") or "").lower()
    if host.startswith("["):
        host = host.split("]")[0] + "]"
    else:
        host = host.rsplit(":", 1)[0]
    client = request.client.host if request.client else ""
    return host in LOOPBACK and (client in LOOPBACK or client in ("testclient", ""))


def _matches(given: str, token: str) -> bool:
    return bool(given) and hmac.compare_digest(given.encode(), token.encode())


def authorized(request: Request, role: str) -> bool:
    """Bearer header for both roles; the AI role also accepts ?key= (MCP clients that cannot set a header)."""
    token = config.her_token() if role == "her" else config.ai_token()
    if not token:
        return _host_is_loopback(request)
    h = request.headers.get("authorization", "")
    if _matches(h[7:].strip() if h.lower().startswith("bearer ") else "", token):
        return True
    return role == "ai" and _matches((request.query_params.get("key") or "").strip(), token)


# ── log redaction: ?key= never reaches a log line in clear ───────────────────────
_KEY_IN_URL = re.compile(r"(?i)([?&]key=)[^&\s\"'#]*")


def redact(text: str) -> str:
    """Mask the value of every key= query parameter in a URL or log line."""
    return _KEY_IN_URL.sub(r"\1***", text) if "key=" in text.lower() else text


class RedactKeyFilter(logging.Filter):
    """Masks key= in a record's message and arguments (also uvicorn's access log, whose formatter reads the
    argument tuple positionally, so the tuple keeps its shape)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact(a) if isinstance(a, str) else a for a in record.args)
        elif isinstance(record.args, dict):
            record.args = {k: redact(v) if isinstance(v, str) else v for k, v in record.args.items()}
        return True


_REDACT_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn")


def install_log_redaction() -> None:
    """Attach RedactKeyFilter to uvicorn's loggers and to every handler of the root and uvicorn loggers.
    Idempotent; call it after logging is configured (server.main does, and build_app does for other runners)."""
    targets: list = [logging.getLogger(n) for n in _REDACT_LOGGERS]
    for lg in [logging.getLogger(), *targets]:
        targets.extend(lg.handlers)
    for t in targets:
        if not any(isinstance(f, RedactKeyFilter) for f in t.filters):
            t.addFilter(RedactKeyFilter())


def _json(data, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status)


def _err(status: int, detail) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status)


def endpoint(role: str = "her"):
    """Wrap a handler: auth, HTTPError / her-side errors → JSON, sync work in a thread."""
    def deco(fn):
        async def run(request: Request):
            if not authorized(request, role):
                return _err(401, "missing or wrong token")
            try:
                out = await fn(request)
            except HTTPError as e:
                return _err(e.status, e.detail)
            except dp.HerEditError as e:
                return _err(e.status, e.detail)
            except date_her.HerError as e:
                return _err(e.status, e.text)
            except dp.NoteError as e:
                return _err(e.status, e.text)
            except ports.PortUnavailable as e:
                return _err(e.status, {"code": e.code, "text": e.text})
            except ports.PlaceError as e:
                return _err(e.status, {"code": e.code, "text": e.text})
            except webpush.SubscribeError as e:
                return _err(e.status, {"code": e.code, "text": e.text})
            return out if isinstance(out, Response) else _json(out)
        return run
    return deco


async def _body(request: Request):
    try:
        return await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        raise HTTPError(400, {"code": "bad_body", "text": "要传 JSON"}) from None


def _pid(request: Request, key: str = "plan_id") -> int:
    return int(request.path_params[key])


def _sync(fn, *a, **kw):
    return asyncio.to_thread(fn, *a, **kw)


def _decorate(view):
    """Her views get write_request.available: the "please write" button only shows when a path reaches the AI."""
    if isinstance(view, dict) and isinstance(view.get("write_request"), dict):
        view["write_request"]["available"] = inbox.write_request_available()
    return view


def _decorate_all(views):
    avail = inbox.write_request_available()
    for v in views:
        if isinstance(v.get("write_request"), dict):
            v["write_request"]["available"] = avail
    return views


# ── strict bodies (unknown fields / wrong types → 400 naming the field) ──────────
def _strict(body, fields: dict[str, tuple], required: tuple = ()) -> dict:
    if not isinstance(body, dict):
        raise dp.HerEditError(400, "bad_field", "要传一个对象")
    for k in body:
        if k not in fields:
            raise dp.HerEditError(400, "bad_field", f"不认识 {k} 这一项", field=k)
    for k in required:
        if k not in body:
            raise dp.HerEditError(400, "bad_field", f"{k} 必填", field=k)
    for k, v in body.items():
        types_ = fields[k]
        ok = (v is None and type(None) in types_) or any(
            isinstance(v, t) and not (t is int and isinstance(v, bool)) for t in types_ if t is not type(None))
        if k == "items" and isinstance(v, list):
            ok = all(isinstance(x, str) for x in v)
        if not ok:
            raise dp.HerEditError(400, "bad_field", f"{k} 的类型不对", field=k)
    return body


# ── her: dates ──────────────────────────────────────────────────────────────────
PLACE_SOURCE_ZH = {"google": "谷歌", "amap": "高德", "osm": "OpenStreetMap"}


def _place_service() -> dict:
    """页面据此决定边输边搜还是点「搜索」才查,并显示署名。地点服务关着/读不出能力 = available false。"""
    off = {"available": False, "provider": None, "fallback": None, "supports_autocomplete": False,
           "attribution": None, "store_policy": config.places_store_policy()}
    try:
        prov = ports.get("places")
    except Exception as e:  # noqa: BLE001 — a broken override must not take /api/config down
        return {**off, "error": str(e)}
    if prov is None:
        return off
    try:
        cap = prov.capabilities()
    except Exception:  # noqa: BLE001 — an adapter without capabilities(): be conservative
        cap = None
    fb = getattr(getattr(prov, "fallback", None), "name", None)
    return {"available": True, "provider": getattr(prov, "name", None), "fallback": fb,
            "supports_autocomplete": bool(cap and cap.supports_autocomplete),
            "attribution": cap.attribution if cap else None, "store_policy": config.places_store_policy()}


def _map_status() -> dict:
    try:
        r = ports.get("map")
    except Exception as e:  # noqa: BLE001
        return {"available": False, "ready": False, "reason": "error", "text": str(e)}
    if r is None:
        return {"available": False, "ready": False, "reason": "not_configured", "text": "地图没有配置"}
    st = r.status() if hasattr(r, "status") else {"ready": True, "reason": None, "text": None}
    return {"available": True, **st}


@endpoint()
async def api_config(request):
    return {"title": "Ephemera", "tz": config.tz_name(), "her": config.her(), "him": config.him(),
            "her_en": config.her_en(), "him_en": config.him_en(),
            "together_since": (d.isoformat() if (d := config.together_since()) else None),
            "write_request_available": inbox.write_request_available(),
            "ai_channels": inbox.channels(), "ai_activity": await _sync(inbox.activity),
            "web_push": webpush.enabled(), "vapid_public_key": config.vapid_public_key() or None,
            "places": ports.configured("places"), "map": ports.configured("map"), "art": dp.art_enabled(),
            "place_service": await _sync(_place_service), "map_status": await _sync(_map_status)}


@endpoint()
async def dates_list(request):
    return {"plans": _decorate_all(await _sync(dp.her_plans))}


@endpoint()
async def dates_preparing(request):
    return {"plans": await _sync(dp.her_preparing)}


@endpoint()
async def dates_note(request):
    body = await _body(request)
    if not isinstance(body, dict) or not isinstance(body.get("text"), str):
        raise HTTPError(400, "text 必填")
    return await _sync(dp.her_leave_note, _pid(request), body["text"])


@endpoint()
async def dates_backfill(request):
    return _decorate(await _sync(dp.her_backfill, await _body(request)))


@endpoint()
async def dates_her_edit(request):
    body = await _body(request)
    if not isinstance(body, dict):
        raise HTTPError(400, {"code": "bad_body", "text": "要传一个对象：{ops:[...]}"})
    ev = body.get("expect_version")
    if ev is not None and (isinstance(ev, bool) or not isinstance(ev, int)):
        raise HTTPError(400, {"code": "bad_version", "text": "expect_version 要是整数", "field": "expect_version"})
    extra = [k for k in body if k not in ("ops", "expect_version")]
    if extra:
        raise HTTPError(400, {"code": "unknown_field", "text": f"不认识 {extra[0]} 这一项", "field": extra[0]})
    return _decorate(await _sync(dp.her_edit, _pid(request), body.get("ops"), expect_version=ev))


@endpoint()
async def dates_her_write(request):
    b = _strict(await _body(request), {"what": (str,), "text": (str, type(None)), "items": (list, type(None))},
                required=("what",))
    given = {k: b[k] for k in ("text", "items") if k in b}       # explicit null counts as given
    return _decorate(await _sync(dp.her_write, _pid(request), b["what"], **given))


@endpoint()
async def dates_her_open(request):
    v = await _sync(dp.her_open, _pid(request))
    if v is None:
        raise HTTPError(404, "not found")
    return _decorate(v)


@endpoint()
async def dates_her_letter(request):
    b = _strict(await _body(request), {"text": (str,)})
    return _decorate(await _sync(dp.her_set_letter, _pid(request), b.get("text", "")))


@endpoint()
async def dates_her_request_write(request):
    body = await _body(request)
    if not isinstance(body, dict):
        raise HTTPError(400, {"code": "bad_body", "text": "要传一个对象：{client_id}"})
    extra = [k for k in body if k != "client_id"]
    if extra:
        raise HTTPError(400, {"code": "unknown_field", "text": f"不认识 {extra[0]} 这一项", "field": extra[0]})
    return _decorate(await _sync(dp.her_request_write, _pid(request), body.get("client_id")))


@endpoint()
async def dates_kinds(request):
    return kinds.kinds_payload()


@endpoint()
async def dates_place_search(request):
    q = (request.query_params.get("q") or "").strip()
    if not q:
        raise HTTPError(400, {"code": "empty", "text": "要输入地名再搜"})
    provider = await ports.aget("places")
    if provider is None:
        raise ports.PortUnavailable("地点搜索现在用不了：地点服务没有配置。可以先手写地址", 503, "not_configured")
    res = await ports.acall(provider.search, q)
    src = getattr(res, "source", None) or getattr(provider, "name", None)
    fb = getattr(res, "fallback_from", None)
    notice = None
    if fb:       # 兜底:逐次可见,不悄悄换成别家的结果;没配钥匙和服务故障分开说
        who = PLACE_SOURCE_ZH.get(fb, fb)
        notice = (f"没配{who}钥匙，这次是用 OpenStreetMap 搜的" if getattr(res, "fallback_code", None) == "not_configured"
                  else f"{who}现在用不了，这次是用 OpenStreetMap 搜的，结果可能少一些")
    return {"items": [_place_item(p) for p in res], "source": src, "fallback_from": fb,
            "fallback_code": getattr(res, "fallback_code", None), "notice": notice}


def _place_item(p) -> dict:
    """搜索候选给页面:选中后把 source / provider_id 原样作为 place_source / place_ref 传回写口。"""
    if isinstance(p, dict):
        return p
    return {"title": p.title, "address": p.address, "lat": p.lat, "lng": p.lng, "kind": p.kind,
            "subtype": p.subtype, "source": p.source, "provider_id": p.provider_id, "region": p.region,
            "fallback_from": p.fallback_from,
            # 存储规则下坐标能不能长期存(false=站上不存坐标,见 /api/config place_service.store_policy)
            "coords_storable": dp.place_restricted(p.source) is None}


@endpoint()
async def dates_events(request):
    raw = request.query_params.get("plan")
    plan = None
    if raw not in (None, ""):
        try:
            plan = int(raw)
        except ValueError:
            raise HTTPError(400, "plan 要是整数") from None
    return {"events": await _sync(dp.her_events, plan)}


@endpoint()
async def dates_events_read(request):
    body = await _body(request)
    ids = body.get("ids") if isinstance(body, dict) else None
    if not isinstance(ids, list):
        raise HTTPError(400, "ids 要是列表")
    return {"marked": await _sync(dp.her_mark_read, ids)}


@endpoint()
async def dates_stop_art(request):
    v = request.query_params.get("v") or "ink"
    p = await _sync(dp.her_stop_art, _pid(request), int(request.path_params["stop_id"]), variant=v)
    if p is None:
        raise HTTPError(404, "not found")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


@endpoint()
async def dates_one(request):
    v = await _sync(dp.her_plan, _pid(request))
    if v is None:
        raise HTTPError(404, "not found")
    return _decorate(v)


# ── her: her side (marks, photos, map) ───────────────────────────────────────────
@endpoint()
async def her_state(request):
    return await _sync(date_her.state, _pid(request))


@endpoint()
async def her_mark(request):
    body = await _body(request)
    if not isinstance(body, dict) or not isinstance(body.get("key"), str):
        raise HTTPError(400, "key 必填")
    on = body.get("on", True)
    if not isinstance(on, bool):
        raise HTTPError(400, "on 要写 true 或 false")
    return await _sync(date_her.set_mark, _pid(request), body["key"], on)


def _form_int(v, name: str):
    if v in (None, ""):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        raise HTTPError(400, f"{name} 要是整数") from None


@endpoint()
async def her_photo(request):
    form = await request.form(max_files=1, max_fields=10)
    try:
        f = form.get("file")
        if f is None or not hasattr(f, "read"):
            raise HTTPError(400, "file 必填")
        data = await f.read(date_her.PHOTO_MAX_BYTES + 1)
        stop_id = _form_int(form.get("stop_id"), "stop_id")
        replace_id = _form_int(form.get("replace_id"), "replace_id")
        replace = str(form.get("replace") or "").strip().lower() in ("1", "true")
        return await _sync(date_her.add_photo, _pid(request), stop_id, data, str(form.get("caption") or ""),
                           client_id=str(form.get("client_id") or "") or None, replace=replace, replace_id=replace_id)
    finally:
        await form.close()


@endpoint()
async def her_photo_one(request):
    pid, photo = _pid(request), int(request.path_params["photo_id"])
    if request.method == "DELETE":
        return await _sync(date_her.remove_photo, pid, photo)
    if request.method == "PATCH":
        b = _strict(await _body(request), {"caption": (str,)})
        return await _sync(date_her.set_caption, pid, photo, b.get("caption", ""))
    f, mime = await _sync(date_her.photo_file, pid, photo)
    return FileResponse(f, media_type=mime, headers={"Cache-Control": "private, max-age=86400"})


async def _refresh_coords(pid: int, view: dict) -> dict:
    """坐标缓存过期的已公开站:重新取一次写回缓存(条款允许的期限内)。→ {stop_id: 没取成的原因}。

    只认同一家的回答:有地点 ID 且地点服务就是那一家 → 按 ID 取(谷歌 details);没有 ID → 按标题地址查。
    现在用的地点服务不是那一家 = 不查(other_service);查回来的是别家/兜底的结果 = 不用(other_source);
    查不到/出错 = lookup_failed。后两种按指数退避,退避期间打开地图不再查。"""
    todo = dp.expired_coords(view)
    if not todo:
        return {}
    try:
        prov = await ports.aget("places")
    except ports.PortUnavailable as e:       # 地点服务配置有误:当作没有地点服务,这几站照「没画」说明
        log.warning("[http] 地点服务用不了,不重新查坐标: %s", e.text)
        prov = None
    state = await _sync(dp.refresh_state, pid)
    now = dp._now().timestamp()
    notes: dict = {}
    for x in todo:
        sid, p = x["stop_id"], x["place"]
        src = p.get("place_source")
        if prov is None or getattr(prov, "name", None) != src:
            notes[sid] = "other_service"
            continue
        st = state.get(sid)
        if st and st["next_try_at"] and st["next_try_at"] > now:
            notes[sid] = st["reason"] or "lookup_failed"
            continue
        ref, q = p.get("place_ref"), p.get("address") or p.get("title")
        try:
            if ref and hasattr(prov, "details"):
                got = await ports.acall(prov.details, ref)
            elif q:
                got = await ports.acall(prov.geocode, q)
            else:
                got = None
        except Exception as e:  # noqa: BLE001 — 重新查失败:这一站照「没画」说明,不挡整张图
            log.warning("[http] 重新查坐标失败 stop %s: %r", sid, e)
            got = None
        hit = got[0] if got else None
        if hit is not None and (getattr(got, "fallback_from", None) or getattr(got, "source", None) != src
                                or hit.source != src):
            notes[sid] = "other_source"
        elif hit is None or not await _sync(dp.cache_place_coords, pid, sid, hit.lat, hit.lng, hit.source):
            notes[sid] = "lookup_failed"
        else:
            continue
        await _sync(dp.refresh_failed, pid, sid, notes[sid])
    return notes


@endpoint()
async def her_map(request):
    from . import maps
    renderer = await ports.aget("map")
    if renderer is None:
        raise ports.PortUnavailable("地图没有配置", 503, "not_configured")
    pid = _pid(request)
    v = await _sync(dp.her_plan, pid)
    if v is None:
        raise HTTPError(404, "not found")
    expired = len(dp.expired_coords(v))
    notes = await _refresh_coords(pid, v)
    if len(notes) < expired:                       # 有站重新取到了坐标
        v = await _sync(dp.her_plan, pid)
    try:
        out = await ports.acall(renderer.build_map, v)
    except maps.MapUnavailable as e:
        raise ports.PortUnavailable(e.text, 503, e.code) from None
    if isinstance(out, dict):
        out = {**out, "unplotted": dp.unplotted(v, notes)}
    return out


# ── her: Web Push subscriptions ──────────────────────────────────────────────────
@endpoint()
async def push_subscribe(request):
    return await _sync(webpush.subscribe, await _body(request))


@endpoint()
async def push_unsubscribe(request):
    body = await _body(request)
    return await _sync(webpush.unsubscribe, body.get("endpoint") if isinstance(body, dict) else None)


# ── ai: /context (+ claim / done / release for relays that do not speak MCP) ──────
SECRET_HEADERS = {"X-Ephemera-Secret": "true", "X-Ephemera-Reveal-After": "none"}


def _client_name(raw) -> str | None:
    return str(raw).strip()[:60] if isinstance(raw, str) and raw.strip() else None


CLIENT_REQUIRED = {"code": "client_required",
                   "text": "领取要带你自己的唯一 client id（每个客户端一个，不要用应用名）"}


@endpoint("ai")
async def context(request):
    raw_claim = request.query_params.get("claim")
    claim_for = _client_name(raw_claim)
    if raw_claim is not None and claim_for is None:
        raise HTTPError(400, CLIENT_REQUIRED)
    text = await _sync(inbox.context_text, claim_for=claim_for)
    meta = {"ephemera/secret": True, "ephemera/reveal_after": None}
    if request.query_params.get("format") == "json":
        return JSONResponse({"text": text, "_meta": meta}, headers=SECRET_HEADERS)
    return PlainTextResponse(text, headers=SECRET_HEADERS)


async def _ai_ids(request):
    body = await _body(request)
    if not isinstance(body, dict) or not isinstance(body.get("ids"), list) or not body["ids"]:
        raise HTTPError(400, {"code": "bad_ids", "text": "ids 要写待办编号列表"})
    client = _client_name(body.get("client"))
    if client is None:
        raise HTTPError(400, CLIENT_REQUIRED)
    return body["ids"], "context:" + client


@endpoint("ai")
async def context_claim(request):
    ids, who = await _ai_ids(request)
    return {**await _sync(inbox.claim, ids, who), "_meta": {"ephemera/secret": True}}


@endpoint("ai")
async def context_done(request):
    ids, who = await _ai_ids(request)
    return {**await _sync(inbox.mark_done, ids, who), "_meta": {"ephemera/secret": True}}


@endpoint("ai")
async def context_release(request):
    ids, who = await _ai_ids(request)
    return {"released": await _sync(inbox.release, ids, who)}


def routes() -> list[Route]:
    P = "/api/dates/{plan_id:int}"
    return [
        Route("/api/config", api_config),
        Route("/api/dates", dates_list),
        Route("/api/dates/preparing", dates_preparing),
        Route("/api/dates/backfill", dates_backfill, methods=["POST"]),
        Route("/api/dates/kinds", dates_kinds),
        Route("/api/dates/place_search", dates_place_search),
        Route("/api/dates/events", dates_events),
        Route("/api/dates/events/read", dates_events_read, methods=["POST"]),
        Route(P, dates_one),
        Route(P + "/note", dates_note, methods=["POST"]),
        Route(P + "/her", her_state, methods=["GET"]),
        Route(P + "/her", dates_her_edit, methods=["PATCH"]),
        Route(P + "/her/write", dates_her_write, methods=["PUT"]),
        Route(P + "/her/open", dates_her_open, methods=["POST"]),
        Route(P + "/her/letter", dates_her_letter, methods=["PUT"]),
        Route(P + "/her/request_write", dates_her_request_write, methods=["POST"]),
        Route(P + "/her/mark", her_mark, methods=["POST"]),
        Route(P + "/her/photo", her_photo, methods=["POST"]),
        Route(P + "/her/photo/{photo_id:int}", her_photo_one, methods=["GET", "PATCH", "DELETE"]),
        Route(P + "/stops/{stop_id:int}/art", dates_stop_art),
        Route(P + "/map", her_map),
        Route("/api/push/subscribe", push_subscribe, methods=["POST"]),
        Route("/api/push/unsubscribe", push_unsubscribe, methods=["POST"]),
        Route("/context", context),
        Route("/context/claim", context_claim, methods=["POST"]),
        Route("/context/done", context_done, methods=["POST"]),
        Route("/context/release", context_release, methods=["POST"]),
    ]
