"""ASGI middleware: request id + access log, security headers, body-size limit, in-process rate limiting."""

from __future__ import annotations

import re
import time
import uuid
from collections import deque
from collections.abc import MutableMapping
from typing import Any

import structlog
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from nazoratly.config import Settings
from nazoratly.errors import body as error_body

log = structlog.get_logger("access")
_RID_OK = re.compile(r"^[A-Za-z0-9._-]{8,64}$")

SECURITY_HEADERS = {
    b"x-content-type-options": b"nosniff",
    b"x-frame-options": b"DENY",
    b"referrer-policy": b"no-referrer",
    b"cache-control": b"no-store",
    b"content-security-policy": b"default-src 'none'; frame-ancestors 'none'",
}


def client_ip(scope: Scope, trust_proxy: bool) -> str:
    headers = dict(scope.get("headers", []))
    if trust_proxy and b"x-forwarded-for" in headers:
        return str(headers[b"x-forwarded-for"].decode("latin-1").split(",")[0].strip())
    client = scope.get("client")
    return str(client[0]) if client else "unknown"


class RequestContextMiddleware:
    """Assigns a request id, binds it to the log context, logs one access line, adds security headers."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        raw = dict(scope["headers"]).get(b"x-request-id", b"").decode("latin-1")
        rid = raw if _RID_OK.match(raw) else uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = rid
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=rid)
        started = time.perf_counter()
        status = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers: list[tuple[bytes, bytes]] = list(message.get("headers", []))
                present = {k.lower() for k, _ in headers}
                headers.append((b"x-request-id", rid.encode()))
                headers.extend((k, v) for k, v in SECURITY_HEADERS.items() if k not in present)
                if self.settings.env == "prod":
                    headers.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:  # last resort: handlers normally translate errors
            log.error("unhandled_exception", error=repr(exc), exc_info=exc)
            response = JSONResponse(
                error_body("internal_error", "Internal server error", rid), status_code=500
            )
            await response(scope, receive, send_wrapper)
        finally:
            path = scope.get("path", "")
            if path not in ("/health", "/ready"):
                log.info(
                    "request",
                    method=scope.get("method"),
                    path=path,
                    status=status,
                    duration_ms=round((time.perf_counter() - started) * 1000, 1),
                )


class BodyLimitMiddleware:
    """Rejects bodies above the limit with 413, including chunked uploads without Content-Length."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = dict(scope["headers"]).get(b"content-length")
        rid = scope.get("state", {}).get("request_id")
        too_big = JSONResponse(
            error_body("payload_too_large", "Request body is too large", rid), status_code=413
        )
        if declared is not None and declared.isdigit() and int(declared) > self.max_bytes:
            await too_big(scope, receive, send)
            return
        seen = 0
        exceeded = False

        async def limited_receive() -> Message:
            nonlocal seen, exceeded
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    exceeded = True
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        started = False

        async def guarded_send(message: Message) -> None:
            nonlocal started
            started = started or message["type"] == "http.response.start"
            await send(message)

        await self.app(scope, limited_receive, guarded_send)
        if exceeded and not started:
            await too_big(scope, receive, send)


class _Window:
    __slots__ = ("hits",)

    def __init__(self) -> None:
        self.hits: deque[float] = deque()


class RateLimiter:
    """Sliding-window limiter per key. Process-local: with several API instances each enforces its own window
    (the login lockout in the database is the cross-instance control for credential guessing)."""

    def __init__(self) -> None:
        self._windows: MutableMapping[str, _Window] = {}
        self._last_sweep = time.monotonic()

    def hit(self, key: str, limit: int, window_s: float = 60.0) -> tuple[bool, int]:
        now = time.monotonic()
        if now - self._last_sweep > 60:
            self._sweep(now, window_s)
        w = self._windows.setdefault(key, _Window())
        while w.hits and now - w.hits[0] > window_s:
            w.hits.popleft()
        if len(w.hits) >= limit:
            retry = int(window_s - (now - w.hits[0])) + 1
            return False, retry
        w.hits.append(now)
        return True, 0

    def _sweep(self, now: float, window_s: float) -> None:
        self._last_sweep = now
        for k in [k for k, w in self._windows.items() if not w.hits or now - w.hits[-1] > window_s]:
            del self._windows[k]


class RateLimitMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings
        self.limiter = RateLimiter()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path") in ("/health", "/ready"):
            await self.app(scope, receive, send)
            return
        ip = client_ip(scope, self.settings.trust_proxy_headers)
        checks: list[tuple[str, int]] = [(f"all:{ip}", self.settings.rate_limit_per_minute)]
        if str(scope.get("path", "")).startswith("/v1/auth/"):
            checks.append((f"auth:{ip}", self.settings.auth_rate_limit_per_minute))
        for key, limit in checks:
            ok, retry = self.limiter.hit(key, limit)
            if not ok:
                rid = scope.get("state", {}).get("request_id")
                resp = JSONResponse(
                    error_body("rate_limited", "Too many requests", rid),
                    status_code=429,
                    headers={"Retry-After": str(retry)},
                )
                await resp(scope, receive, send)
                return
        await self.app(scope, receive, send)


def request_ip(request: Request, settings: Settings) -> str:
    return client_ip(request.scope, settings.trust_proxy_headers)


__all__ = [
    "BodyLimitMiddleware",
    "RateLimitMiddleware",
    "RateLimiter",
    "RequestContextMiddleware",
    "request_ip",
]
_unused: Any = None
