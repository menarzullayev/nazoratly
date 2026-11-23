"""Security regression tests: authentication, tenant isolation, injection, abuse limits (real DB, real app)."""

from __future__ import annotations

import base64
import json
import time
import uuid
from typing import Any

import httpx
import jwt
import pytest

from nazoratly.config import Settings
from nazoratly.main import create_app
from tests.conftest import Tenant, make_tenant
from tests.helpers import mk_student

SECRET = "test-secret-test-secret-test-secret-0123"
PROTECTED = [
    ("GET", "/v1/me"),
    ("GET", "/v1/students"),
    ("POST", "/v1/students"),
    ("GET", "/v1/guardians"),
    ("GET", "/v1/courses"),
    ("GET", "/v1/groups"),
    ("GET", "/v1/teachers"),
    ("GET", "/v1/outbox"),
    ("GET", "/v1/audit"),
    ("GET", "/v1/agents"),
    ("GET", "/v1/agent-drafts"),
]


def _b64(d: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


async def test_every_protected_route_rejects_anonymous(client: httpx.AsyncClient) -> None:
    for method, path in PROTECTED:
        r = await client.request(method, path, json={} if method == "POST" else None)
        assert r.status_code == 401, f"{method} {path} -> {r.status_code}"
        assert r.json()["error"]["code"]


async def test_every_v1_get_route_requires_auth_unless_public(client: httpx.AsyncClient) -> None:
    spec = (await client.get("/openapi.json")).json()
    public = ("/v1/auth/", "/v1/pay/", "/hooks/")
    for path, ops in spec["paths"].items():
        if "get" not in ops or "{" in path or path.startswith(public) or not path.startswith("/v1/"):
            continue
        r = await client.get(path)
        assert r.status_code in (401, 403), f"GET {path} -> {r.status_code}"


@pytest.mark.parametrize(
    "token",
    [
        "",
        "garbage",
        "a.b.c",
        jwt.encode(
            {"sub": str(uuid.uuid4()), "exp": int(time.time()) + 600},
            "wrong-secret-wrong-secret-wrong-secret",
            algorithm="HS256",
        ),
        jwt.encode({"sub": str(uuid.uuid4()), "exp": int(time.time()) - 60}, SECRET, algorithm="HS256"),
        jwt.encode({"sub": str(uuid.uuid4())}, SECRET, algorithm="HS256"),
    ],
)
async def test_forged_or_expired_tokens_rejected(client: httpx.AsyncClient, token: str) -> None:
    r = await client.get("/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


async def test_alg_none_token_rejected(client: httpx.AsyncClient, tenant: Tenant) -> None:
    claims = jwt.decode(tenant.access, options={"verify_signature": False})
    forged = f"{_b64({'alg': 'none', 'typ': 'JWT'})}.{_b64(claims)}."
    r = await client.get("/v1/me", headers={"Authorization": f"Bearer {forged}"})
    assert r.status_code == 401


async def test_tampered_payload_rejected(client: httpx.AsyncClient, tenant: Tenant) -> None:
    head, _payload, sig = tenant.access.split(".")
    claims = jwt.decode(tenant.access, options={"verify_signature": False})
    claims["org"] = str(uuid.uuid4())
    r = await client.get("/v1/me", headers={"Authorization": f"Bearer {head}.{_b64(claims)}.{sig}"})
    assert r.status_code == 401


async def test_cross_tenant_access_is_404(tenant: Tenant, tenant_b: Tenant) -> None:
    s = await mk_student(tenant, "Secret Student")
    sid = s["id"]
    assert (await tenant_b.get(f"/v1/students/{sid}")).status_code == 404
    assert (await tenant_b.patch(f"/v1/students/{sid}", {"full_name": "Hacked"})).status_code == 404
    assert (await tenant_b.delete(f"/v1/students/{sid}")).status_code == 404
    names = [x["full_name"] for x in (await tenant_b.get("/v1/students")).json()["items"]]
    assert "Secret Student" not in names
    still = await tenant.get(f"/v1/students/{sid}")
    assert still.status_code == 200 and still.json()["full_name"] == "Secret Student"


SQLI = [
    "' OR '1'='1",
    "'; DROP TABLE students; --",
    '" OR 1=1 --',
    "%' UNION SELECT NULL--",
    "1; SELECT pg_sleep(5)",
]


@pytest.mark.parametrize("payload", SQLI)
async def test_sql_injection_in_search_and_path(tenant: Tenant, payload: str) -> None:
    await mk_student(tenant, "Normal Student")
    t0 = time.monotonic()
    r = await tenant.get("/v1/students", params={"q": payload})
    assert time.monotonic() - t0 < 3  # pg_sleep must not execute
    assert r.status_code in (200, 422), r.text
    if r.status_code == 200:
        assert r.json()["items"] == []
    r = await tenant.get(f"/v1/students/{payload}")
    assert r.status_code in (404, 422)
    assert (await tenant.get("/v1/students")).status_code == 200  # table still there


async def test_sql_injection_in_login_identifier(client: httpx.AsyncClient) -> None:
    r = await client.post(
        "/v1/auth/login", json={"identifier": "' OR 1=1 --", "password": "whatever-password"}
    )
    assert r.status_code in (401, 422)


async def test_xss_payload_is_stored_inert_and_served_as_json(tenant: Tenant) -> None:
    payload = "<script>alert(1)</script>"
    s = await mk_student(tenant, payload)
    r = await tenant.get(f"/v1/students/{s['id']}")
    assert r.headers["content-type"].startswith("application/json")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'none'" in r.headers["content-security-policy"]
    assert r.json()["full_name"] == payload


@pytest.mark.parametrize(
    "body",
    [
        b"{not json",
        b'{"full_name": null}',
        b'{"full_name": ["a"]}',
        b'{"full_name": "' + b"A" * 100_000 + b'"}',
        b'{"full_name": "ok", "birth_date": "9999-99-99"}',
        b"\xff\xfe\x00",
    ],
)
async def test_malformed_input_never_500(tenant: Tenant, body: bytes) -> None:
    r = await tenant.client.post(
        "/v1/students", content=body, headers={**tenant.h, "Content-Type": "application/json"}
    )
    assert r.status_code in (400, 413, 422), r.status_code


async def test_oversized_body_rejected(tenant: Tenant) -> None:
    big = b'{"full_name": "' + b"x" * (3 * 1024 * 1024) + b'"}'
    r = await tenant.client.post(
        "/v1/students", content=big, headers={**tenant.h, "Content-Type": "application/json"}
    )
    assert r.status_code == 413


async def test_no_secrets_in_responses(tenant: Tenant) -> None:
    for path in ("/v1/me", "/v1/org"):
        text = (await tenant.get(path)).text.lower()
        for needle in ("password_hash", "argon2", "secret_ciphertext", "jwt_secret"):
            assert needle not in text, (path, needle)


async def test_security_headers_on_every_response(client: httpx.AsyncClient) -> None:
    for path in ("/health", "/v1/me", "/does-not-exist"):
        r = await client.get(path)
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["x-frame-options"] == "DENY"
        assert r.headers["referrer-policy"] == "no-referrer"
        assert r.headers["x-request-id"]


async def test_error_bodies_do_not_leak_internals(tenant: Tenant) -> None:
    r = await tenant.get("/v1/students/not-a-uuid")
    low = r.text.lower()
    for needle in ("traceback", "psycopg", "select ", "postgres", 'file "'):
        assert needle not in low


async def test_refresh_token_reuse_is_rejected(client: httpx.AsyncClient) -> None:
    t = await make_tenant(client, "rot")
    r1 = await client.post("/v1/auth/refresh", json={"refresh_token": t.refresh})
    assert r1.status_code == 200
    r2 = await client.post("/v1/auth/refresh", json={"refresh_token": t.refresh})
    assert r2.status_code == 401
    r3 = await client.post("/v1/auth/refresh", json={"refresh_token": r1.json()["refresh_token"]})
    assert r3.status_code == 401  # reuse detection revokes the whole chain


async def test_login_lockout_after_repeated_failures(client: httpx.AsyncClient) -> None:
    t = await make_tenant(client, "lock")
    codes = []
    for _ in range(8):
        r = await client.post(
            "/v1/auth/login", json={"identifier": t.email, "password": "wrong-password-123"}
        )
        codes.append(r.status_code)
    assert codes[0] == 401
    assert any(c in (423, 429) for c in codes[5:]), codes
    r = await client.post("/v1/auth/login", json={"identifier": t.email, "password": t.password})
    assert r.status_code in (423, 429)


async def test_login_does_not_reveal_whether_account_exists(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    a = await client.post(
        "/v1/auth/login", json={"identifier": tenant.email, "password": "wrong-password-123"}
    )
    b = await client.post(
        "/v1/auth/login",
        json={"identifier": f"nobody-{uuid.uuid4().hex}@example.com", "password": "wrong-password-123"},
    )
    assert a.status_code == b.status_code == 401
    assert a.json()["error"]["code"] == b.json()["error"]["code"]
    assert a.json()["error"]["message"] == b.json()["error"]["message"]


async def test_rate_limit_returns_429_with_retry_after(settings: Settings) -> None:
    limited = settings.model_copy(update={"rate_limit_per_minute": 20, "auth_rate_limit_per_minute": 5})
    app = create_app(limited)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            codes = [(await c.get("/v1/me")).status_code for _ in range(30)]
            assert codes.count(429) >= 8, codes
            r = await c.get("/v1/me")
            assert r.status_code == 429 and "retry-after" in {k.lower() for k in r.headers}
            fresh = [
                (
                    await c.post(
                        "/v1/auth/login", json={"identifier": "x@example.com", "password": "pw-pw-pw-pw-pw"}
                    )
                ).status_code
                for _ in range(10)
            ]
            assert 429 in fresh


async def test_fake_agent_token_rejected_on_staff_api(client: httpx.AsyncClient) -> None:
    r = await client.get("/v1/me", headers={"Authorization": "Bearer nzag_" + "A" * 40})
    assert r.status_code == 401
