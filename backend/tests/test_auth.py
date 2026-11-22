from __future__ import annotations

import uuid

import httpx
import psycopg

from tests.conftest import Tenant, make_tenant

pytestmark = []


async def test_health_and_ready(client: httpx.AsyncClient) -> None:
    r = await client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    r = await client.get("/ready")
    assert r.status_code == 200 and r.json()["status"] == "ready"
    assert r.headers["x-request-id"]
    assert r.headers["x-content-type-options"] == "nosniff"


async def test_register_login_me(client: httpx.AsyncClient, tenant: Tenant) -> None:
    r = await client.get("/v1/me", headers=tenant.h)
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == tenant.email and body["org"]["role"] == "owner"
    r = await client.post(
        "/v1/auth/login", json={"identifier": tenant.email.upper(), "password": tenant.password}
    )
    assert r.status_code == 200
    assert r.json()["org"]["id"] == tenant.org_id


async def test_register_duplicate_and_weak_password(client: httpx.AsyncClient, tenant: Tenant) -> None:
    payload = {
        "full_name": "X",
        "center_name": "Y",
        "email": tenant.email,
        "password": "another-long-password",
    }
    assert (await client.post("/v1/auth/register", json=payload)).status_code == 409
    payload["email"] = f"{uuid.uuid4().hex}@example.com"
    payload["password"] = "short"
    r = await client.post("/v1/auth/register", json=payload)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    r = await client.post(
        "/v1/auth/register", json={"full_name": "X", "center_name": "Y", "password": "long-enough-pass"}
    )
    assert r.status_code == 422  # neither email nor phone


async def test_wrong_password_is_generic_and_locks_out(client: httpx.AsyncClient) -> None:
    t = await make_tenant(client, "lock")
    for _ in range(5):
        r = await client.post("/v1/auth/login", json={"identifier": t.email, "password": "wrong-password-x"})
        assert r.status_code == 401
        assert r.json()["error"]["message"] == "Invalid credentials"
    r = await client.post("/v1/auth/login", json={"identifier": t.email, "password": t.password})
    assert r.status_code == 429  # locked even with the correct password
    unknown = await client.post(
        "/v1/auth/login", json={"identifier": "nobody@example.com", "password": "whatever-123"}
    )
    assert unknown.status_code == 401 and unknown.json()["error"]["message"] == "Invalid credentials"


async def test_unauthenticated_and_bad_tokens(client: httpx.AsyncClient) -> None:
    assert (await client.get("/v1/me")).status_code == 401
    assert (await client.get("/v1/me", headers={"Authorization": "Bearer not.a.jwt"})).status_code == 401
    assert (await client.get("/v1/students")).status_code == 401


async def test_refresh_rotation_and_reuse_detection(client: httpx.AsyncClient) -> None:
    t = await make_tenant(client, "rot")
    r1 = await client.post("/v1/auth/refresh", json={"refresh_token": t.refresh})
    assert r1.status_code == 200
    new_refresh = r1.json()["refresh_token"]
    assert new_refresh != t.refresh
    # old token presented again -> whole family revoked, including the new token
    assert (await client.post("/v1/auth/refresh", json={"refresh_token": t.refresh})).status_code == 401
    assert (await client.post("/v1/auth/refresh", json={"refresh_token": new_refresh})).status_code == 401


async def test_logout_revokes_session(client: httpx.AsyncClient) -> None:
    t = await make_tenant(client, "out")
    assert (await client.post("/v1/auth/logout", json={"refresh_token": t.refresh})).status_code == 200
    assert (await client.post("/v1/auth/refresh", json={"refresh_token": t.refresh})).status_code == 401


async def test_change_password_signs_out_everywhere(client: httpx.AsyncClient) -> None:
    t = await make_tenant(client, "pw")
    r = await t.post(
        "/v1/auth/password", {"current_password": "bad-current-pass", "new_password": "brand-new-password"}
    )
    assert r.status_code == 401
    r = await t.post(
        "/v1/auth/password", {"current_password": t.password, "new_password": "brand-new-password"}
    )
    assert r.status_code == 200
    assert (await client.post("/v1/auth/refresh", json={"refresh_token": t.refresh})).status_code == 401
    assert (
        await client.post("/v1/auth/login", json={"identifier": t.email, "password": "brand-new-password"})
    ).status_code == 200


async def test_switch_requires_membership(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    r = await tenant.post("/v1/auth/switch", {"org_id": tenant_b.org_id})
    assert r.status_code == 403
    r = await tenant.post("/v1/auth/switch", {"org_id": tenant.org_id})
    assert r.status_code == 200


async def test_disabled_user_loses_access_immediately(client: httpx.AsyncClient, super_dsn: str) -> None:
    t = await make_tenant(client, "dis")
    assert (await t.get("/v1/me")).status_code == 200
    with psycopg.connect(super_dsn, autocommit=True) as c:
        c.execute("UPDATE users SET status = 'disabled' WHERE email = %s", (t.email,))
    assert (await t.get("/v1/me")).status_code == 401
    r = await client.post("/v1/auth/login", json={"identifier": t.email, "password": t.password})
    assert r.status_code == 401


async def test_body_limit_and_request_id(client: httpx.AsyncClient) -> None:
    big = "x" * 1_100_000
    r = await client.post("/v1/auth/login", content=big, headers={"content-type": "application/json"})
    assert r.status_code == 413
    r = await client.get("/health", headers={"X-Request-ID": "my-request-id-123"})
    assert r.headers["x-request-id"] == "my-request-id-123"
