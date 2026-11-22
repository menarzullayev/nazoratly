"""MCP server for the clients' AI agents (Model B). Separate service: python -m nazoratly.mcp_server.

Security model (enforced by the database, see db/migrations 0004/0005/0007):
- connects as role nazoratly_agent: no access to raw tables, only agent_v_* views (consented students only),
  INSERT of drafts and tool-call log rows;
- every request carries a bearer token (nzt_...) that is checked through agent_authenticate();
- tiers: 'read' tools need scope read, 'draft' tools need scope draft; nothing here executes, pays or deletes;
  a human approves drafts in the API (/v1/agent-drafts);
- every call (ok / denied / error) is written to agent_tool_calls.
"""

from __future__ import annotations

import json
import time
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime
from typing import Annotated, Any, Literal

import structlog
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from nazoratly.security import sha256

log = structlog.get_logger("mcp")
Limit = Annotated[int, Field(ge=1, le=200, description="max rows")]
Conn = AsyncConnection[DictRow]


class AgentSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NAZORATLY_", env_file=".env", extra="ignore")

    database_url_agent: SecretStr
    mcp_host: str = "0.0.0.0"  # noqa: S104 - container service; expose through a TLS proxy
    mcp_port: int = 8001
    mcp_allowed_hosts: list[str] = Field(
        default_factory=list, description="Host headers accepted (DNS-rebinding guard)"
    )
    mcp_calls_per_minute: int = Field(default=60, ge=1)
    db_statement_timeout_ms: int = Field(default=10_000, ge=100)


@dataclass(frozen=True)
class AgentIdentity:
    client_id: int
    org_id: int
    user_id: int
    scopes: frozenset[str]


class ToolDenied(Exception):
    """Raised for caller errors that must be logged as 'denied' (missing scope, rate limit, invalid target)."""


class AgentBackend:
    def __init__(self, settings: AgentSettings) -> None:
        self.settings = settings
        self.pool: AsyncConnectionPool[Conn] = AsyncConnectionPool(
            settings.database_url_agent.get_secret_value(),
            min_size=1,
            max_size=10,
            open=False,
            name="agent",
            connection_class=AsyncConnection[DictRow],
            kwargs={
                "row_factory": dict_row,
                "options": f"-c statement_timeout={settings.db_statement_timeout_ms} -c idle_in_transaction_session_timeout=15000",
                "application_name": "nazoratly-mcp",
            },
        )
        self._hits: dict[int, deque[float]] = {}

    async def open(self) -> None:
        await self.pool.open(wait=True, timeout=15)

    async def close(self) -> None:
        await self.pool.close()

    async def authenticate(self, token: str) -> AgentIdentity | None:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT client_id, org_id, user_id, scopes FROM agent_authenticate(%s)", (sha256(token),)
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return AgentIdentity(row["client_id"], row["org_id"], row["user_id"], frozenset(row["scopes"]))

    def _rate_ok(self, client_id: int) -> bool:
        now = time.monotonic()
        q = self._hits.setdefault(client_id, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.settings.mcp_calls_per_minute:
            return False
        q.append(now)
        return True

    async def _session(self, conn: Conn, who: AgentIdentity, request_id: str) -> None:
        await conn.execute(
            "SELECT set_config('app.org_id', %s, true), set_config('app.agent_client_id', %s, true),"
            " set_config('app.actor_type', 'agent', true), set_config('app.request_id', %s, true)",
            (str(who.org_id), str(who.client_id), request_id),
        )

    async def _log(
        self,
        who: AgentIdentity,
        tool: str,
        tier: str,
        args: dict[str, Any],
        outcome: str,
        rows: int | None,
        error: str | None,
        rid: str,
    ) -> None:
        async with self.pool.connection() as conn:
            await self._session(conn, who, rid)
            await conn.execute(
                "INSERT INTO agent_tool_calls (org_id, agent_client_id, tool_name, tier, args, outcome, rows_returned, error, request_id) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    who.org_id,
                    who.client_id,
                    tool,
                    tier,
                    Jsonb(_loggable(args)),
                    outcome,
                    rows,
                    (error or "")[:500] or None,
                    rid,
                ),
            )

    async def call[T](
        self,
        who: AgentIdentity,
        request_id: str,
        tool: str,
        tier: Literal["read", "draft"],
        args: dict[str, Any],
        fn: Callable[[Conn], Awaitable[T]],
    ) -> T:
        """Run one tool: scope check, rate limit, transaction as the agent, then the audit-log row."""
        try:
            if tier not in who.scopes:
                raise ToolDenied(f"this agent token has no '{tier}' scope")
            if not self._rate_ok(who.client_id):
                raise ToolDenied("rate limit exceeded; retry in a minute")
            async with self.pool.connection() as conn:
                await self._session(conn, who, request_id)
                result = await fn(conn)
                rows = len(result) if isinstance(result, list) else 1
                await conn.execute(
                    "INSERT INTO agent_tool_calls (org_id, agent_client_id, tool_name, tier, args, outcome, rows_returned, request_id) "
                    "VALUES (%s, %s, %s, %s, %s, 'ok', %s, %s)",
                    (who.org_id, who.client_id, tool, tier, Jsonb(_loggable(args)), rows, request_id),
                )
            return result
        except ToolDenied as exc:
            await self._log(who, tool, tier, args, "denied", None, str(exc), request_id)
            raise
        except Exception as exc:
            log.error("tool_failed", tool=tool, error=repr(exc))
            await self._log(who, tool, tier, args, "error", None, type(exc).__name__, request_id)
            raise


def _loggable(args: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in args.items():
        if isinstance(v, str) and len(v) > 200:
            out[k] = v[:200] + "..."
        elif isinstance(v, date):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


def _plain(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """JSON-safe rows: Decimal -> string (money stays exact), date -> ISO."""

    def default(o: Any) -> str:
        return o.isoformat() if isinstance(o, date | datetime) else str(o)  # Decimal, UUID -> exact string

    return json.loads(json.dumps(rows, default=default))  # type: ignore[no-any-return]


class TokenAuthMiddleware:
    """Authenticates the bearer token for every HTTP request and hands the identity to the tools via the ASGI scope."""

    def __init__(self, app: ASGIApp, backend: AgentBackend) -> None:
        self.app = app
        self.inner = app  # the Starlette MCP app (tests enter its lifespan)
        self.backend = backend

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope.get("path") == "/health":
            await JSONResponse({"status": "ok"})(scope, receive, send)
            return
        auth = dict(scope["headers"]).get(b"authorization", b"").decode("latin-1")
        who = (
            await self.backend.authenticate(auth[7:].strip()) if auth.lower().startswith("bearer ") else None
        )
        if who is None:
            await JSONResponse(
                {"error": "invalid, expired or revoked agent token"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )(scope, receive, send)
            return
        scope["nazoratly_agent"] = who
        await self.app(scope, receive, send)


def build_server(backend: AgentBackend) -> FastMCP:
    s = backend.settings
    hosts = s.mcp_allowed_hosts
    mcp = FastMCP(
        "nazoratly",
        instructions=(
            "Read-only analytics and reminder drafting for an education center. You can read debtors, attendance and revenue "
            "(only students whose guardians consented to AI processing) and propose reminder drafts. Drafts are NOT sent: "
            "a human must approve each one. You cannot pay, delete or modify anything."
        ),
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=bool(hosts), allowed_hosts=hosts, allowed_origins=[]
        ),
    )

    def identity(ctx: Context[Any, Any, Any]) -> tuple[AgentIdentity, str]:
        req = ctx.request_context.request
        who = req.scope.get("nazoratly_agent") if req is not None else None
        if not isinstance(who, AgentIdentity):
            raise ToolDenied("unauthenticated")
        return who, str(
            getattr(req, "headers", {}).get("x-request-id", "")
        ) or f"mcp-{int(time.time() * 1000)}"

    @mcp.tool(
        description="Students with overdue tuition (only those with AI-processing consent), largest debt first."
    )
    async def list_debtors(
        ctx: Context[Any, Any, Any],
        min_days_overdue: Annotated[int, Field(ge=0, le=3650)] = 1,
        limit: Limit = 50,
    ) -> list[dict[str, Any]]:
        who, rid = identity(ctx)

        async def run(c: Conn) -> list[dict[str, Any]]:
            cur = await c.execute(
                "SELECT student_id, full_name, count(*) AS open_charges, sum(outstanding) AS outstanding_total, max(days_overdue) AS max_days_overdue "
                "FROM agent_v_debtors WHERE days_overdue >= %s GROUP BY student_id, full_name ORDER BY outstanding_total DESC, student_id LIMIT %s",
                (min_days_overdue, limit),
            )
            return _plain(list(await cur.fetchall()))

        return await backend.call(
            who, rid, "list_debtors", "read", {"min_days_overdue": min_days_overdue, "limit": limit}, run
        )

    @mcp.tool(
        description="Attendance counts per student for a date range (students with AI-processing consent only)."
    )
    async def attendance_summary(
        ctx: Context[Any, Any, Any],
        date_from: date,
        date_to: date,
        min_absences: Annotated[int, Field(ge=0, le=1000)] = 0,
        limit: Limit = 50,
    ) -> list[dict[str, Any]]:
        who, rid = identity(ctx)
        if date_to < date_from or (date_to - date_from).days > 366:
            raise ToolDenied("date range must be 0-366 days")

        async def run(c: Conn) -> list[dict[str, Any]]:
            cur = await c.execute(
                "SELECT student_id, full_name, count(*) FILTER (WHERE status = 'present') AS present, count(*) FILTER (WHERE status = 'late') AS late,"
                " count(*) FILTER (WHERE status = 'absent') AS absent, count(*) FILTER (WHERE status = 'excused') AS excused "
                "FROM agent_v_attendance WHERE lesson_date BETWEEN %s AND %s GROUP BY student_id, full_name "
                "HAVING count(*) FILTER (WHERE status = 'absent') >= %s ORDER BY absent DESC, student_id LIMIT %s",
                (date_from, date_to, min_absences, limit),
            )
            return _plain(list(await cur.fetchall()))

        args = {"date_from": date_from, "date_to": date_to, "min_absences": min_absences, "limit": limit}
        return await backend.call(who, rid, "attendance_summary", "read", args, run)

    @mcp.tool(description="Revenue (money received) per day or month. Aggregates only; no personal data.")
    async def revenue_report(
        ctx: Context[Any, Any, Any], date_from: date, date_to: date, group_by: Literal["day", "month"] = "day"
    ) -> list[dict[str, Any]]:
        who, rid = identity(ctx)
        if date_to < date_from or (date_to - date_from).days > 1830:
            raise ToolDenied("date range must be 0-1830 days")
        trunc = "month" if group_by == "month" else "day"

        async def run(c: Conn) -> list[dict[str, Any]]:
            cur = await c.execute(
                f"SELECT date_trunc('{trunc}', day)::date AS period, method, sum(payments_count)::int AS payments_count, sum(total) AS total "
                "FROM agent_v_revenue_daily WHERE day BETWEEN %s AND %s GROUP BY 1, 2 ORDER BY 1, 2",
                (date_from, date_to),
            )
            return _plain(list(await cur.fetchall()))

        return await backend.call(
            who,
            rid,
            "revenue_report",
            "read",
            {"date_from": date_from, "date_to": date_to, "group_by": group_by},
            run,
        )

    @mcp.tool(
        description="Guardians who may receive a reminder (linked, reminders on, notifications + AI consent). No phone numbers."
    )
    async def list_reminder_targets(
        ctx: Context[Any, Any, Any], student_id: int | None = None, limit: Limit = 50
    ) -> list[dict[str, Any]]:
        who, rid = identity(ctx)

        async def run(c: Conn) -> list[dict[str, Any]]:
            cur = await c.execute(
                "SELECT student_id, student_name, guardian_id, guardian_name, relation, is_primary FROM agent_v_reminder_targets "
                "WHERE (%s::bigint IS NULL OR student_id = %s) ORDER BY student_name, is_primary DESC, guardian_id LIMIT %s",
                (student_id, student_id, limit),
            )
            return _plain(list(await cur.fetchall()))

        return await backend.call(
            who, rid, "list_reminder_targets", "read", {"student_id": student_id, "limit": limit}, run
        )

    @mcp.tool(
        description="Propose a reminder message to a guardian. Creates a DRAFT only; a human must approve it before anything is sent."
    )
    async def draft_reminder(
        ctx: Context[Any, Any, Any],
        student_id: int,
        guardian_id: int,
        body: Annotated[
            str, Field(min_length=1, max_length=1000, description="message text for the guardian")
        ],
        summary: Annotated[
            str,
            Field(
                min_length=3, max_length=300, description="one line telling the human what this draft is for"
            ),
        ],
    ) -> dict[str, Any]:
        who, rid = identity(ctx)

        async def run(c: Conn) -> dict[str, Any]:
            cur = await c.execute(
                "SELECT 1 AS ok FROM agent_v_reminder_targets WHERE student_id = %s AND guardian_id = %s",
                (student_id, guardian_id),
            )
            if await cur.fetchone() is None:
                raise ToolDenied(
                    "not a valid reminder target (not linked, reminders off, or consent missing)"
                )
            cur = await c.execute(
                "INSERT INTO agent_drafts (org_id, agent_client_id, kind, student_id, guardian_id, body, summary) "
                "VALUES (%s, %s, 'reminder_message', %s, %s, %s, %s) RETURNING public_id, expires_at",
                (who.org_id, who.client_id, student_id, guardian_id, body, summary),
            )
            row = await cur.fetchone()
            assert row is not None
            return _plain(
                [
                    {
                        "draft_id": row["public_id"],
                        "status": "pending",
                        "expires_at": row["expires_at"],
                        "note": "A human must approve this draft in the nazoratly app; nothing has been sent.",
                    }
                ]
            )[0]

        args = {"student_id": student_id, "guardian_id": guardian_id, "body": body, "summary": summary}
        return await backend.call(who, rid, "draft_reminder", "draft", args, run)

    return mcp


def create_app(settings: AgentSettings | None = None) -> TokenAuthMiddleware:
    settings = settings or AgentSettings()
    backend = AgentBackend(settings)
    server = build_server(backend)
    inner = server.streamable_http_app()
    original_lifespan = inner.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app: Any) -> Any:
        await backend.open()
        try:
            async with original_lifespan(app):
                yield
        finally:
            await backend.close()

    inner.router.lifespan_context = lifespan
    return TokenAuthMiddleware(inner, backend)


def main() -> None:
    import uvicorn

    settings = AgentSettings()
    uvicorn.run(create_app(settings), host=settings.mcp_host, port=settings.mcp_port, access_log=False)


if __name__ == "__main__":
    main()
