"""The client address used for rate limiting must come from the trusted proxy header, never from a value the
client can write itself (X-Forwarded-For is appended to by proxies, so its first entry is attacker-controlled)."""

from __future__ import annotations

from typing import Any

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from nazoratly.config import Settings
from nazoratly.middleware import RateLimitMiddleware, client_ip

PEER = "10.0.0.7"
REAL = "203.0.113.9"


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "database_url_app": "postgresql://unused",
        "database_url_auth": "postgresql://unused",
        "jwt_secret": "x" * 40,
        "trust_proxy_headers": True,
        "rate_limit_per_minute": 1000,
        "auth_rate_limit_per_minute": 3,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def limited_app(settings: Settings) -> RateLimitMiddleware:
    async def ok(_: Request) -> PlainTextResponse:
        return PlainTextResponse("ok")

    return RateLimitMiddleware(Starlette(routes=[Route("/v1/auth/login", ok, methods=["POST"])]), settings)


async def statuses(settings: Settings, headers: list[dict[str, str]]) -> list[int]:
    transport = httpx.ASGITransport(app=limited_app(settings), client=(PEER, 5000))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return [(await client.post("/v1/auth/login", headers=h)).status_code for h in headers]


async def test_rotating_forwarded_for_cannot_bypass_the_limit_behind_the_proxy() -> None:
    sent = [{"X-Forwarded-For": f"198.51.100.{i}, {REAL}", "CF-Connecting-IP": REAL} for i in range(6)]
    assert await statuses(make_settings(), sent) == [200, 200, 200, 429, 429, 429]


async def test_forwarded_for_alone_is_ignored_and_the_peer_address_is_limited() -> None:
    sent = [{"X-Forwarded-For": f"198.51.100.{i}"} for i in range(5)]
    assert await statuses(make_settings(), sent) == [200, 200, 200, 429, 429]


async def test_different_real_clients_keep_separate_limits() -> None:
    sent = [{"CF-Connecting-IP": f"203.0.113.{i}"} for i in range(1, 7)]
    assert await statuses(make_settings(), sent) == [200] * 6


def scope(headers: dict[str, str], peer: str | None = PEER) -> dict[str, Any]:
    raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    return {"type": "http", "headers": raw, "client": (peer, 5000) if peer else None}


def test_header_is_used_only_when_proxy_headers_are_trusted() -> None:
    sent = {"CF-Connecting-IP": REAL}
    assert client_ip(scope(sent), make_settings()) == REAL
    assert client_ip(scope(sent), make_settings(trust_proxy_headers=False)) == PEER


def test_header_name_is_configurable_and_case_insensitive() -> None:
    settings = make_settings(client_ip_header="X-Real-IP")
    assert client_ip(scope({"x-real-ip": REAL, "CF-Connecting-IP": "198.51.100.1"}), settings) == REAL


def test_invalid_or_multi_value_header_falls_back_to_the_peer() -> None:
    for bad in ("not-an-ip", "", f"198.51.100.1, {REAL}", "1" * 500):
        assert client_ip(scope({"CF-Connecting-IP": bad}), make_settings()) == PEER


def test_ipv6_and_missing_peer() -> None:
    assert client_ip(scope({"CF-Connecting-IP": "2001:DB8::1"}), make_settings()) == "2001:db8::1"
    assert client_ip(scope({}, peer=None), make_settings()) == "unknown"
