"""Run Ephemera: one command, two modes.

    ephemera serve     # HTTP: her side API (/api/*), AI to-dos (/context), MCP (/mcp), the pages (/app/)
                       # + the single scheduler
    ephemera stdio     # MCP over stdio for a local MCP client; reads/writes the database only, no scheduler

Configuration is environment variables only (see config.py).
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import sys

from mcp import types
from mcp.server.lowlevel import Server

from . import config, http, scheduler, tools, webapp

log = logging.getLogger("ephemera_date.server")

INSTRUCTIONS = ("Ephemera：一次约会做成一套会一点点拆开、最后能收藏的纸品。你用 date_* 工具写约会：date_open 开一个，"
                "date_edit 写站和路段，date_send 寄出，当天用 date_live，结束用 date_close。"
                "到点提醒和补写请求在 date_inbox 里。已结束的约会用 date_memory 查。")


def build_mcp() -> Server:
    srv: Server = Server("ephemera-date", instructions=INSTRUCTIONS)

    @srv.list_tools()
    async def _list_tools() -> list[types.Tool]:
        return [types.Tool(name=t["name"], description=t["description"], inputSchema=t["input_schema"])
                for t in tools.tool_schemas()]

    @srv.call_tool(validate_input=False)          # the engine validates and explains in Chinese
    async def _call_tool(name: str, arguments: dict | None):
        label = session = None
        try:
            ctx = srv.request_context
            params = ctx.session.client_params
            label = params.clientInfo.name if params and params.clientInfo else None   # display only
            req = getattr(ctx, "request", None)
            session = req.headers.get("mcp-session-id") if req is not None else None   # HTTP: one id per session
        except (LookupError, AttributeError):
            pass
        args = arguments or {}
        # stdio / no session header: tools falls back to a random id per process (one process = one claimer)
        text, is_error = await tools.call(name, args, session=session, label=label)
        # secrecy marker for self-hosted relays that mask date content in her chat view (see tools.result_meta)
        meta = await asyncio.to_thread(tools.result_meta, name, args, text)
        return types.CallToolResult(content=[types.TextContent(type="text", text=text)], isError=is_error,
                                    _meta=meta)

    return srv


CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
CORS_HEADERS = ["Authorization", "Content-Type"]


def build_app(*, run_scheduler: bool = True):
    """The serve app: her API + /context + /mcp + the web package at /app/, with the scheduler in its lifespan.
    Refuses (ValueError) a role configuration where the page token could act as the AI.

    CORS only when EPHEMERA_ALLOWED_ORIGINS lists origins: Access-Control-Allow-Origin echoes a listed origin
    (never "*"), preflight allows the Authorization and Content-Type headers, no credentials mode (the token
    travels in the Authorization header, there are no cookies)."""
    config.validate_roles()
    http.install_log_redaction()
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from mcp.server.transport_security import TransportSecuritySettings
    from starlette.applications import Starlette
    from starlette.middleware import Middleware
    from starlette.middleware.cors import CORSMiddleware
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    manager = StreamableHTTPSessionManager(
        # stateful: every connection gets its own mcp-session-id, which is also its to-do claimer identity
        app=build_mcp(), stateless=False, json_response=True,
        # behind a tunnel the Host header is the tunnel's; the bearer token is the guard (http.authorized)
        security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False))

    class MCPApp:                                  # a class instance = Starlette mounts it as a raw ASGI app
        async def __call__(self, scope, receive, send):
            from starlette.requests import Request
            if not http.authorized(Request(scope), "ai"):
                await JSONResponse({"detail": "missing or wrong token"}, status_code=401)(scope, receive, send)
                return
            await manager.handle_request(scope, receive, send)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        stop = asyncio.Event()
        task = asyncio.create_task(scheduler.run(stop)) if run_scheduler else None
        async with manager.run():
            try:
                yield
            finally:
                stop.set()
                if task is not None:
                    await task

    origins = config.allowed_origins()
    middleware = [Middleware(CORSMiddleware, allow_origins=origins, allow_methods=CORS_METHODS,
                             allow_headers=CORS_HEADERS, allow_credentials=False, max_age=600)] if origins else []
    # the web package (/app/, no token) comes last: /api, /context and /mcp always win
    return Starlette(routes=[*http.routes(), Route("/mcp", MCPApp(), methods=["GET", "POST", "DELETE"]),
                             *webapp.routes()],
                     middleware=middleware, lifespan=lifespan)


def _enforce_store_policy() -> None:
    """Startup: coordinates kept under EPHEMERA_PLACES_STORE_POLICY=user are taken back once it is "terms"."""
    from . import plan as dp
    try:
        r = dp.enforce_store_policy()
        if r["moved"] or r["cleared"]:
            log.info("[server] store policy terms: %s coordinates moved to the 30-day cache, %s cleared",
                     r["moved"], r["cleared"])
    except Exception as e:  # noqa: BLE001 — the scheduler retries every round
        log.warning("[server] store policy check failed: %r", e)


def _run_stdio() -> None:
    from mcp.server.stdio import stdio_server

    async def main() -> None:
        srv = build_mcp()
        async with stdio_server() as (read, write):
            await srv.run(read, write, srv.create_initialization_options())

    asyncio.run(main())


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="ephemera-date")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("stdio", help="MCP over stdio (no scheduler: reminders are delivered by `ephemera-date serve`)")
    sub.add_parser("vapid-keys", help="print a fresh Web Push (VAPID) key pair as env lines")
    sp = sub.add_parser("serve", help="HTTP: /api (her side), /context and /mcp (AI side), the pages at /app/, "
                                           "plus the scheduler")
    sp.add_argument("--host", default="127.0.0.1")
    sp.add_argument("--port", type=int, default=8791)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s",
                        stream=sys.stderr)
    for w in config.startup_warnings():
        log.warning("[server] %s", w)
    if args.cmd == "serve" and (note := webapp.startup_note()):
        log.warning("[server] %s", note)
    config.data_dir().mkdir(parents=True, exist_ok=True)
    if args.cmd in ("stdio", "serve"):
        _enforce_store_policy()
    if args.cmd == "vapid-keys":
        from . import webpush
        for k, v in webpush.generate_keys().items():
            print(f"{k}={v}")
        return
    if args.cmd == "stdio":
        _run_stdio()
        return
    if args.host not in ("127.0.0.1", "localhost", "::1") and not (config.her_token() and config.ai_token()):
        sys.exit("Refusing to listen on a non-loopback address without EPHEMERA_HER_TOKEN and EPHEMERA_AI_TOKEN.")
    try:
        app = build_app()
    except ValueError as e:
        sys.exit(str(e))
    import uvicorn
    # uvicorn configures its loggers when the Config is built; the key= mask goes on after that
    server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=args.port, access_log=False))
    http.install_log_redaction()
    server.run()


if __name__ == "__main__":
    main()
