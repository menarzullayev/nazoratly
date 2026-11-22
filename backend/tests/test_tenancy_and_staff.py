from __future__ import annotations

import uuid

import httpx

from tests.conftest import Tenant, make_tenant
from tests.helpers import mk_student, ok


async def _login(client: httpx.AsyncClient, email: str, password: str, org_id: str | None = None) -> Tenant:
    body = {"identifier": email, "password": password}
    if org_id:
        body["org_id"] = org_id
    data = await ok(await client.post("/v1/auth/login", json=body))
    return Tenant(client, data, email, password)


async def _add_staff(owner: Tenant, role: str, password: str = "staff-password-123") -> tuple[dict, str]:
    email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
    data = await ok(
        await owner.post(
            "/v1/staff",
            {"full_name": f"{role} person", "email": email, "role": role, "initial_password": password},
        ),
        201,
    )
    return data, email


async def test_organization_profile(tenant: Tenant) -> None:
    org = await ok(await tenant.get("/v1/organization"))
    assert org["currency"] == "UZS" and org["timezone"] == "Asia/Tashkent"
    upd = await ok(
        await tenant.patch(
            "/v1/organization", {"legal_name": "Test MChJ", "tin": "123456789", "timezone": "Asia/Samarkand"}
        )
    )
    assert upd["legal_name"] == "Test MChJ" and upd["timezone"] == "Asia/Samarkand"
    assert (await tenant.patch("/v1/organization", {"timezone": "Mars/Base"})).status_code == 422
    assert (await tenant.patch("/v1/organization", {"tin": "12"})).status_code == 422


async def test_rls_isolates_centers(tenant: Tenant, tenant_b: Tenant) -> None:
    s = await mk_student(tenant, "Isolated Student")
    assert (await tenant_b.get(f"/v1/students/{s['id']}")).status_code == 404
    assert (await tenant_b.patch(f"/v1/students/{s['id']}", {"notes": "hack"})).status_code == 404
    assert (await tenant_b.get("/v1/students")).json()["items"] == []
    assert (await tenant.get("/v1/students")).json()["items"][0]["full_name"] == "Isolated Student"


async def test_branches_crud(tenant: Tenant) -> None:
    b = await ok(await tenant.post("/v1/branches", {"name": "Main", "address": "Tashkent"}), 201)
    assert (await tenant.post("/v1/branches", {"name": "main"})).status_code == 409  # case-insensitive unique
    upd = await ok(await tenant.patch(f"/v1/branches/{b['id']}", {"address": "Samarkand"}))
    assert upd["address"] == "Samarkand"
    await ok(await tenant.delete(f"/v1/branches/{b['id']}"))
    assert (await tenant.get("/v1/branches")).json()["items"] == []


async def test_staff_roles_and_permissions(client: httpx.AsyncClient, tenant: Tenant) -> None:
    manager, m_email = await _add_staff(tenant, "manager")
    assert manager["status"] == "active"
    mgr = await _login(client, m_email, "staff-password-123")
    # manager: can manage students, cannot touch staff, org or finance-only actions
    await mk_student(mgr, "By Manager")
    assert (
        await mgr.post(
            "/v1/staff",
            {
                "full_name": "x",
                "email": "x@example.com",
                "role": "viewer",
                "initial_password": "long-password-1",
            },
        )
    ).status_code == 403
    assert (await mgr.patch("/v1/organization", {"name": "Hijack"})).status_code == 403
    assert (await mgr.get("/v1/staff")).status_code == 200

    viewer, v_email = await _add_staff(tenant, "viewer")
    vw = await _login(client, v_email, "staff-password-123")
    assert (await vw.get("/v1/students")).status_code == 200
    assert (await vw.post("/v1/students", {"full_name": "No"})).status_code == 403

    teacher, t_email = await _add_staff(tenant, "teacher")
    tc = await _login(client, t_email, "staff-password-123")
    assert (await tc.get("/v1/students")).status_code == 403  # teachers never list all students
    assert (await tc.get("/v1/groups")).status_code == 200


async def test_admin_cannot_grant_owner(client: httpx.AsyncClient, tenant: Tenant) -> None:
    _, a_email = await _add_staff(tenant, "admin")
    admin = await _login(client, a_email, "staff-password-123")
    r = await admin.post(
        "/v1/staff",
        {"full_name": "x", "email": "o@example.com", "role": "owner", "initial_password": "long-password-1"},
    )
    assert r.status_code == 403
    ok_r = await admin.post(
        "/v1/staff",
        {
            "full_name": "y",
            "email": f"{uuid.uuid4().hex}@example.com",
            "role": "manager",
            "initial_password": "long-password-1",
        },
    )
    assert ok_r.status_code == 201


async def test_last_owner_and_self_protection(tenant: Tenant) -> None:
    staff = (await ok(await tenant.get("/v1/staff")))["items"]
    me = next(s for s in staff if s["role"] == "owner")
    assert (
        await tenant.patch(f"/v1/staff/{me['id']}", {"role": "admin"})
    ).status_code == 403  # cannot demote yourself


async def test_suspending_staff_revokes_access_immediately(client: httpx.AsyncClient, tenant: Tenant) -> None:
    mem, email = await _add_staff(tenant, "manager")
    mgr = await _login(client, email, "staff-password-123")
    assert (await mgr.get("/v1/students")).status_code == 200
    await ok(await tenant.patch(f"/v1/staff/{mem['id']}", {"status": "suspended"}))
    assert (await mgr.get("/v1/students")).status_code == 403


async def test_existing_user_gets_invitation_and_must_accept(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    inv = await ok(
        await tenant.post(
            "/v1/staff", {"full_name": "Owner B", "email": tenant_b.email, "role": "accountant"}
        ),
        201,
    )
    assert inv["status"] == "invited"
    # not a member yet: switching into the center is refused
    assert (await tenant_b.post("/v1/auth/switch", {"org_id": tenant.org_id})).status_code == 403
    await ok(await tenant_b.post(f"/v1/me/invitations/{tenant.org_id}/accept"))
    sw = await ok(await tenant_b.post("/v1/auth/switch", {"org_id": tenant.org_id}))
    assert sw["org"]["role"] == "accountant"
    # a second invitation for the same person conflicts
    assert (
        await tenant.post("/v1/staff", {"full_name": "Owner B", "email": tenant_b.email, "role": "viewer"})
    ).status_code == 409
    # the same user now has two centers: login without org_id yields no preselected org
    data = await ok(
        await client.post(
            "/v1/auth/login", json={"identifier": tenant_b.email, "password": tenant_b.password}
        )
    )
    assert data["org"] is None and len(data["organizations"]) == 2


async def test_idempotency_key_replay(tenant: Tenant) -> None:
    key = uuid.uuid4().hex
    body = {"full_name": "Idem Student"}
    r1 = await tenant.post("/v1/students", body, headers={"Idempotency-Key": key})
    r2 = await tenant.post("/v1/students", body, headers={"Idempotency-Key": key})
    assert r1.status_code == 201 and r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"] and r2.headers["idempotent-replayed"] == "true"
    r3 = await tenant.post("/v1/students", {"full_name": "Different"}, headers={"Idempotency-Key": key})
    assert r3.status_code == 422
    total = (await ok(await tenant.get("/v1/students")))["items"]
    assert len([s for s in total if s["full_name"] == "Idem Student"]) == 1
    # failures release the key
    k2 = uuid.uuid4().hex
    assert (
        await tenant.post("/v1/students", {"full_name": ""}, headers={"Idempotency-Key": k2})
    ).status_code == 422
    assert (
        await tenant.post("/v1/students", {"full_name": "After failure"}, headers={"Idempotency-Key": k2})
    ).status_code == 201


async def test_idempotency_is_per_tenant(tenant: Tenant, tenant_b: Tenant) -> None:
    key = uuid.uuid4().hex
    a = await tenant.post("/v1/students", {"full_name": "A"}, headers={"Idempotency-Key": key})
    b = await tenant_b.post("/v1/students", {"full_name": "B"}, headers={"Idempotency-Key": key})
    assert a.status_code == 201 and b.status_code == 201 and a.json()["id"] != b.json()["id"]


async def test_make_tenant_helper_independent(client: httpx.AsyncClient) -> None:
    a, b = await make_tenant(client), await make_tenant(client)
    assert a.org_id != b.org_id
