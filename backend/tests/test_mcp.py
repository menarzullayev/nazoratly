from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
import psycopg

from nazoratly.mcp_server import AgentSettings, create_app
from tests.conftest import Tenant
from tests.helpers import ok
from tests.test_agents import _consented_pair

HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


@asynccontextmanager
async def mcp_ctx(pg_server: dict[str, Any], **kw: Any) -> AsyncIterator[httpx.AsyncClient]:
    # entered and exited inside the test's own task (anyio task groups cannot cross pytest fixture tasks)
    app = create_app(
        AgentSettings(database_url_agent=pg_server["agent"], **({"mcp_calls_per_minute": 1000} | kw))
    )  # type: ignore[arg-type]
    inner = app.inner  # type: ignore[attr-defined]
    async with inner.router.lifespan_context(inner):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://mcp") as c:
            yield c


async def rpc(
    c: httpx.AsyncClient, token: str | None, method: str, params: dict[str, Any] | None = None
) -> httpx.Response:
    headers = dict(HEADERS)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return await c.post(
        "/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    )


async def tool(c: httpx.AsyncClient, token: str, name: str, **args: Any) -> dict[str, Any]:
    r = await rpc(c, token, "tools/call", {"name": name, "arguments": args})
    assert r.status_code == 200, r.text
    return r.json()["result"]  # type: ignore[no-any-return]


def content(result: dict[str, Any]) -> Any:
    if "structuredContent" in result and result["structuredContent"] is not None:
        sc = result["structuredContent"]
        return sc.get("result", sc)
    return json.loads(result["content"][0]["text"])


async def _agent(t: Tenant, scopes: list[str]) -> str:
    created = await ok(await t.post("/v1/agents", {"name": "mcp", "scopes": scopes}), 201)
    return str(created["token"])


async def test_unauthenticated_and_listing(pg_server: dict[str, Any], tenant: Tenant) -> None:
    async with mcp_ctx(pg_server) as mcp_client:
        assert (await rpc(mcp_client, None, "tools/list")).status_code == 401
        assert (await rpc(mcp_client, "nzt_not_a_real_token", "tools/list")).status_code == 401
        token = await _agent(tenant, ["read"])
        r = await rpc(mcp_client, token, "tools/list")
        names = {t["name"] for t in r.json()["result"]["tools"]}
        assert names == {
            "list_debtors",
            "attendance_summary",
            "revenue_report",
            "list_reminder_targets",
            "draft_reminder",
        }
        assert (await mcp_client.get("/health")).status_code == 200


async def test_read_tools_see_only_consented_data_of_own_center(
    pg_server: dict[str, Any], tenant: Tenant, tenant_b: Tenant
) -> None:
    async with mcp_ctx(pg_server) as mcp_client:
        from tests.helpers import enroll, mk_group, mk_student

        await _consented_pair(tenant_b)
        grp = await mk_group(tenant, monthly_fee="100000")
        consenting, silent = await mk_student(tenant, "Consenting"), await mk_student(tenant, "Silent")
        for s in (consenting, silent):
            await enroll(tenant, grp["id"], s["id"], "2025-01-01")
        from tests.helpers import consent

        await consent(tenant, consenting["id"], "ai_assistant_processing")
        await ok(await tenant.post("/v1/charges/generate", {"month": "2025-06-01", "due_day": 5}))
        token = await _agent(tenant, ["read"])
        debtors = content(await tool(mcp_client, token, "list_debtors"))
        assert [d["full_name"] for d in debtors] == [
            "Consenting"
        ]  # the student without AI consent is invisible
        assert debtors[0]["outstanding_total"] == "100000.00"
        assert "phone" not in debtors[0]
        rev = content(
            await tool(
                mcp_client,
                token,
                "revenue_report",
                date_from="2025-01-01",
                date_to="2025-12-31",
                group_by="month",
            )
        )
        assert rev == [] or isinstance(rev, list)
        bad = await tool(
            mcp_client, token, "attendance_summary", date_from="2025-06-30", date_to="2025-06-01"
        )
        assert bad["isError"] is True


async def test_draft_flow_scope_and_human_approval(
    pg_server: dict[str, Any], tenant: Tenant, super_dsn: str
) -> None:
    async with mcp_ctx(pg_server) as mcp_client:
        s, g = await _consented_pair(tenant)
        read_only = await _agent(tenant, ["read"])
        full = await _agent(tenant, ["read", "draft"])
        targets = content(await tool(mcp_client, full, "list_reminder_targets"))
        assert len(targets) == 1 and "phone" not in targets[0]
        sid, gid = targets[0]["student_id"], targets[0]["guardian_id"]

        denied = await tool(
            mcp_client,
            read_only,
            "draft_reminder",
            student_id=sid,
            guardian_id=gid,
            body="Salom",
            summary="debt reminder",
        )
        assert denied["isError"] is True and "scope" in denied["content"][0]["text"]
        wrong = await tool(
            mcp_client,
            full,
            "draft_reminder",
            student_id=sid,
            guardian_id=gid + 12345,
            body="Salom",
            summary="debt reminder",
        )
        assert wrong["isError"] is True

        made = content(
            await tool(
                mcp_client,
                full,
                "draft_reminder",
                student_id=sid,
                guardian_id=gid,
                body="Hurmatli ota-ona...",
                summary="Overdue tuition reminder",
            )
        )
        assert made["status"] == "pending"
        drafts = (await ok(await tenant.get("/v1/agent-drafts")))["items"]
        assert len(drafts) == 1 and drafts[0]["id"] == made["draft_id"] and drafts[0]["status"] == "pending"
        assert (await ok(await tenant.get("/v1/outbox")))[
            "items"
        ] == []  # nothing is sent without human approval
        await ok(await tenant.post(f"/v1/agent-drafts/{made['draft_id']}/approve", {"channel": "sms"}))
        assert len((await ok(await tenant.get("/v1/outbox", params={"status": "queued"})))["items"]) == 1
        _ = (s, g)

        # every call, including the refused ones, is in the append-only log with the right outcome
        agents = await ok(await tenant.get("/v1/agents"))
        ro = next(a for a in agents if a["scopes"] == ["read"])
        calls = (await ok(await tenant.get(f"/v1/agents/{ro['id']}/calls")))["items"]
        assert [(c["tool_name"], c["outcome"]) for c in calls] == [("draft_reminder", "denied")]
        fl = next(a for a in agents if a["scopes"] == ["read", "draft"] and a["id"] != ro["id"])
        outcomes = sorted(
            (c["tool_name"], c["outcome"])
            for c in (await ok(await tenant.get(f"/v1/agents/{fl['id']}/calls")))["items"]
        )
        assert (
            ("draft_reminder", "ok") in outcomes
            and ("draft_reminder", "denied") in outcomes
            and ("list_reminder_targets", "ok") in outcomes
        )
        with psycopg.connect(super_dsn) as c:
            row = c.execute(
                "SELECT actor_type, agent_client_id IS NOT NULL FROM audit_log WHERE entity_type = 'agent_drafts' AND action = 'insert' ORDER BY id DESC LIMIT 1"
            ).fetchone()
        assert row == ("agent", True)


async def test_revoked_token_stops_working_and_rate_limit(pg_server: dict[str, Any], tenant: Tenant) -> None:
    async with mcp_ctx(pg_server) as mcp_client:
        created = await ok(await tenant.post("/v1/agents", {"name": "temp", "scopes": ["read"]}), 201)
        token = created["token"]
        assert (await rpc(mcp_client, token, "tools/list")).status_code == 200
        await ok(await tenant.post(f"/v1/agents/{created['id']}/revoke"))
        assert (await rpc(mcp_client, token, "tools/list")).status_code == 401

    tok2 = await _agent(tenant, ["read"])
    async with mcp_ctx(pg_server, mcp_calls_per_minute=2) as c:
        results = [(await tool(c, tok2, "list_debtors"))["isError"] for _ in range(3)]
    assert results == [False, False, True]
