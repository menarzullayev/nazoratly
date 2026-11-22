from __future__ import annotations

import hashlib
import uuid
from typing import Any

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row

from tests.conftest import Tenant
from tests.helpers import consent, mk_guardian, mk_student, ok
from tests.test_tenancy_and_staff import _add_staff, _login


def _agent_conn(pg_server: dict[str, Any]) -> psycopg.Connection[dict[str, Any]]:
    return psycopg.connect(pg_server["agent"], row_factory=dict_row, autocommit=False)  # type: ignore[return-value]


def _as_agent(conn: psycopg.Connection[dict[str, Any]], org_id: int, client_id: int) -> None:
    conn.execute(
        "SELECT set_config('app.org_id', %s, true), set_config('app.agent_client_id', %s, true), set_config('app.actor_type', 'agent', true)",
        (str(org_id), str(client_id)),
    )


async def _consented_pair(t: Tenant) -> tuple[dict, dict]:
    s, g = await mk_student(t, "Reminder Student"), await mk_guardian(t, "Reminder Parent")
    await ok(
        await t.post(
            f"/v1/students/{s['id']}/guardians",
            {"guardian_id": g["id"], "relation": "mother", "is_primary": True},
        ),
        201,
    )
    await consent(t, s["id"], "notifications", g["id"])
    await consent(t, s["id"], "ai_assistant_processing", g["id"])
    return s, g


def _auth(pg_server: dict[str, Any], token: str) -> dict[str, Any] | None:
    with _agent_conn(pg_server) as c:
        return c.execute(
            "SELECT * FROM agent_authenticate(%s)", (hashlib.sha256(token.encode()).digest(),)
        ).fetchone()


def _propose(
    pg_server: dict[str, Any],
    who: dict[str, Any],
    student_public: str,
    guardian_public: str,
    body: str = "Hurmatli ota-ona, to'lov muddati o'tdi.",
) -> None:
    with _agent_conn(pg_server) as c:
        _as_agent(c, who["org_id"], who["client_id"])
        row = c.execute("SELECT student_id, guardian_id FROM agent_v_reminder_targets LIMIT 1").fetchone()
        assert row is not None
        c.execute(
            "INSERT INTO agent_drafts (org_id, agent_client_id, kind, student_id, guardian_id, body, summary) "
            "VALUES (%s, %s, 'reminder_message', %s, %s, %s, 'Remind about overdue tuition')",
            (who["org_id"], who["client_id"], row["student_id"], row["guardian_id"], body),
        )
        c.commit()


async def test_agent_lifecycle_and_draft_approval(tenant: Tenant, pg_server: dict[str, Any]) -> None:
    s, g = await _consented_pair(tenant)
    created = await ok(
        await tenant.post("/v1/agents", {"name": "My assistant", "scopes": ["read", "draft"]}), 201
    )
    token = created["token"]
    assert token.startswith("nzt_") and created["scopes"] == ["read", "draft"]
    listed = await ok(await tenant.get("/v1/agents"))
    assert "token" not in listed[0] and listed[0]["id"] == created["id"]

    who = _auth(pg_server, token)
    assert who is not None and who["scopes"] == ["read", "draft"]
    assert _auth(pg_server, "nzt_wrong") is None

    # the agent sees only consented data through views and cannot touch raw tables
    with _agent_conn(pg_server) as c:
        _as_agent(c, who["org_id"], who["client_id"])
        assert c.execute("SELECT count(*) AS n FROM agent_v_reminder_targets").fetchone()["n"] == 1  # type: ignore[index]
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT * FROM students")
    with _agent_conn(pg_server) as c:
        _as_agent(c, who["org_id"], who["client_id"])
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("UPDATE agent_drafts SET status = 'approved'")

    _propose(pg_server, who, s["id"], g["id"])
    drafts = (await ok(await tenant.get("/v1/agent-drafts")))["items"]
    assert len(drafts) == 1 and drafts[0]["status"] == "pending" and drafts[0]["agent_name"] == "My assistant"
    assert drafts[0]["student_id"] == s["id"] and drafts[0]["guardian_id"] == g["id"]

    approved = await ok(await tenant.post(f"/v1/agent-drafts/{drafts[0]['id']}/approve", {"channel": "sms"}))
    assert approved["status"] == "approved"
    queue = (await ok(await tenant.get("/v1/outbox", params={"status": "queued"})))["items"]
    assert len(queue) == 1 and queue[0]["draft_id"] == drafts[0]["id"] and queue[0]["channel"] == "sms"
    assert (await tenant.post(f"/v1/agent-drafts/{drafts[0]['id']}/approve", {})).status_code == 409
    assert (await tenant.post(f"/v1/agent-drafts/{drafts[0]['id']}/reject")).status_code == 409

    # tool-call log is append-only and visible to the human side
    with _agent_conn(pg_server) as c:
        _as_agent(c, who["org_id"], who["client_id"])
        c.execute(
            "INSERT INTO agent_tool_calls (org_id, agent_client_id, tool_name, tier, args, outcome, rows_returned) "
            "VALUES (%s, %s, 'list_debtors', 'read', '{}', 'ok', 3)",
            (who["org_id"], who["client_id"]),
        )
        c.commit()
    calls = (await ok(await tenant.get(f"/v1/agents/{created['id']}/calls")))["items"]
    assert [x["tool_name"] for x in calls] == ["list_debtors"]

    # audit shows that the DRAFT was created by an agent and the decision by a human
    trail = (await ok(await tenant.get("/v1/audit", params={"entity_type": "agent_drafts"})))["items"]
    actors = [(a["action"], a["actor_type"]) for a in trail]
    assert ("insert", "agent") in actors and ("update", "user") in actors
    assert all("org_id" not in (a["after"] or {}) for a in trail)

    # revoke: token stops working at once
    rev = await ok(await tenant.post(f"/v1/agents/{created['id']}/revoke"))
    assert rev["status"] == "revoked"
    assert _auth(pg_server, token) is None
    assert (await tenant.post(f"/v1/agents/{created['id']}/revoke")).status_code == 409


async def test_reject_expire_and_consent_withdrawn(
    tenant: Tenant, pg_server: dict[str, Any], super_dsn: str
) -> None:
    s, g = await _consented_pair(tenant)
    created = await ok(await tenant.post("/v1/agents", {"name": "A", "scopes": ["read", "draft"]}), 201)
    who = _auth(pg_server, created["token"])
    assert who is not None
    for _ in range(3):
        _propose(pg_server, who, s["id"], g["id"])
    d1, d2, d3 = [d["id"] for d in (await ok(await tenant.get("/v1/agent-drafts")))["items"]]

    rej = await ok(await tenant.post(f"/v1/agent-drafts/{d1}/reject"))
    assert rej["status"] == "rejected"
    assert (await tenant.post(f"/v1/agent-drafts/{d1}/approve", {})).status_code == 409

    with psycopg.connect(super_dsn, autocommit=True) as c:  # age one draft past its 48 h expiry
        c.execute(
            "UPDATE agent_drafts SET expires_at = now() - interval '1 minute' WHERE public_id = %s", (d2,)
        )
    assert (await tenant.post(f"/v1/agent-drafts/{d2}/approve", {})).status_code == 409
    expired = (await ok(await tenant.get("/v1/agent-drafts", params={"status": "expired"})))["items"]
    assert [d["id"] for d in expired] == [d2]

    # the guardian withdraws the notifications consent -> approval is refused and the draft stays pending
    notif = next(
        c
        for c in (await ok(await tenant.get(f"/v1/students/{s['id']}/consents")))
        if c["purpose"] == "notifications"
    )
    await ok(await tenant.post(f"/v1/consents/{notif['id']}/revoke"))
    assert (await tenant.post(f"/v1/agent-drafts/{d3}/approve", {"channel": "sms"})).status_code == 422
    still = (await ok(await tenant.get("/v1/agent-drafts")))["items"]
    assert [d["id"] for d in still] == [d3] and still[0]["status"] == "pending"
    assert (await ok(await tenant.get("/v1/outbox")))["items"] == []
    # and the agent no longer sees that guardian as a reminder target
    with _agent_conn(pg_server) as c:
        _as_agent(c, who["org_id"], who["client_id"])
        assert c.execute("SELECT count(*) AS n FROM agent_v_reminder_targets").fetchone()["n"] == 0  # type: ignore[index]


async def test_agent_cannot_cross_tenants_or_forge(
    tenant: Tenant, tenant_b: Tenant, pg_server: dict[str, Any]
) -> None:
    s, g = await _consented_pair(tenant)
    await _consented_pair(tenant_b)
    created = await ok(await tenant.post("/v1/agents", {"name": "A", "scopes": ["read"]}), 201)
    who = _auth(pg_server, created["token"])
    assert who is not None
    with _agent_conn(pg_server) as c:
        _as_agent(c, who["org_id"], who["client_id"])
        names = [
            r["student_name"]
            for r in c.execute("SELECT student_name FROM agent_v_reminder_targets").fetchall()
        ]
        assert names == ["Reminder Student"]  # only its own center even though both centers have one
    with _agent_conn(pg_server) as c:
        _as_agent(c, who["org_id"], who["client_id"])
        with pytest.raises(psycopg.errors.InsufficientPrivilege):  # forged agent_client_id / other org rows
            c.execute(
                "INSERT INTO agent_tool_calls (org_id, agent_client_id, tool_name, tier, outcome) VALUES (%s, %s, 'x', 'read', 'ok')",
                (who["org_id"] + 999, who["client_id"] + 999),
            )
    _ = (s, g)


async def test_agent_management_rbac_and_validation(client: httpx.AsyncClient, tenant: Tenant) -> None:
    _, m_email = await _add_staff(tenant, "manager")
    mgr = await _login(client, m_email, "staff-password-123")
    assert (await mgr.get("/v1/agents")).status_code == 403
    assert (await mgr.post("/v1/agents", {"name": "x"})).status_code == 403
    assert (await mgr.get("/v1/audit")).status_code == 403
    assert (await mgr.get("/v1/agent-drafts")).status_code == 403
    assert (await tenant.post("/v1/agents", {"name": "x", "scopes": ["admin"]})).status_code == 422
    assert (await tenant.post("/v1/agents", {"name": "x", "scopes": []})).status_code == 422
    forever = await ok(
        await tenant.post("/v1/agents", {"name": "forever", "scopes": ["read"], "expires_in_days": None}), 201
    )
    assert forever["expires_at"] is None


async def test_outbox_needs_consent_and_is_idempotent(tenant: Tenant) -> None:
    s, g = await mk_student(tenant), await mk_guardian(tenant)
    await ok(
        await tenant.post(
            f"/v1/students/{s['id']}/guardians", {"guardian_id": g["id"], "relation": "father"}
        ),
        201,
    )
    msg = {
        "student_id": s["id"],
        "guardian_id": g["id"],
        "channel": "sms",
        "body": "Salom",
        "client_ref": "ref-12345678",
    }
    assert (await tenant.post("/v1/outbox", msg)).status_code == 422  # no notifications consent
    await consent(tenant, s["id"], "notifications", g["id"])
    queued = await ok(await tenant.post("/v1/outbox", msg), 201)
    assert (await tenant.post("/v1/outbox", msg)).status_code == 409  # same client_ref never queues twice
    cancelled = await ok(await tenant.post(f"/v1/outbox/{queued['id']}/cancel"))
    assert cancelled["status"] == "cancelled"
    assert (await tenant.post(f"/v1/outbox/{queued['id']}/cancel")).status_code == 409


async def test_audit_filters(tenant: Tenant) -> None:
    s = await mk_student(tenant, "Audited")
    await ok(await tenant.patch(f"/v1/students/{s['id']}", {"notes": "changed"}))
    rows = (
        await ok(await tenant.get("/v1/audit", params={"entity_type": "students", "entity_id": s["id"]}))
    )["items"]
    assert [r["action"] for r in rows] == ["update", "insert"] and rows[0]["after"]["notes"] == "changed"
    assert rows[0]["before"]["notes"] is None and rows[0]["entity_id"] == s["id"]
    assert (await tenant.get("/v1/audit", params={"entity_type": "nonsense"})).status_code == 404
    assert (await tenant.get("/v1/audit", params={"entity_id": s["id"]})).status_code == 404
    _ = uuid
