"""Database access: two connection pools (app / auth identity) and request-scoped transactions.

Every business transaction starts by setting the session contract of db/migrations (`app.org_id`, `app.user_id`,
`app.request_id`, ...) with transaction-local scope, so it is safe behind a transaction-mode pooler and the
database's row-level security decides what is visible.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from nazoratly.config import Settings
from nazoratly.errors import NotFound

Conn = AsyncConnection[DictRow]

# Tables a public id may be resolved on (identifier whitelist: never interpolate user input).
_RESOLVABLE = {
    "students": True,
    "guardians": True,
    "teachers": True,
    "study_groups": True,
    "courses": True,
    "rooms": False,
    "branches": True,
    "enrollments": False,
    "leads": True,
    "lead_sources": False,
    "absence_entitlements": False,
    "lesson_packages": False,
    "waitlist_entries": False,
    "schedule_notices": False,
    "lessons": False,
    "charges": False,
    "documents": False,
    "payments": False,
    "expenses": False,
    "accounts": False,
    "journal_entries": False,
    "cash_accounts": False,
    "bank_statements": False,
    "statement_lines": False,
    "suppliers": False,
    "supplier_bills": False,
    "bill_payments": False,
    "teacher_payrolls": False,
    "payroll_items": False,
    "agent_clients": False,
    "agent_drafts": False,
    "outbox_messages": False,
    "memberships": False,
    "data_consents": False,
}  # value: has deleted_at (soft delete)


@dataclass(frozen=True)
class Session:
    """Who the transaction acts for (what gets written to the app.* settings)."""

    user_id: int | None
    org_id: int | None
    request_id: str | None = None
    actor_type: str = "user"
    agent_client_id: int | None = None


def _conninfo_kwargs(settings: Settings) -> dict[str, Any]:
    return {
        "row_factory": dict_row,
        "options": f"-c statement_timeout={settings.db_statement_timeout_ms} "
        "-c idle_in_transaction_session_timeout=30000 -c timezone=UTC",
        "application_name": settings.service_name,
    }


class Database:
    def __init__(self, settings: Settings) -> None:
        kw = _conninfo_kwargs(settings)
        self.app_pool: AsyncConnectionPool[Conn] = AsyncConnectionPool(
            settings.database_url_app.get_secret_value(),
            min_size=settings.db_pool_min,
            max_size=settings.db_pool_max,
            kwargs=kw,
            open=False,
            name="app",
            connection_class=AsyncConnection[DictRow],
        )
        self.auth_pool: AsyncConnectionPool[Conn] = AsyncConnectionPool(
            settings.database_url_auth.get_secret_value(),
            min_size=1,
            max_size=max(2, settings.db_pool_max // 2),
            kwargs=kw,
            open=False,
            name="auth",
            connection_class=AsyncConnection[DictRow],
        )

    async def open(self) -> None:
        await self.app_pool.open(wait=True, timeout=15)
        await self.auth_pool.open(wait=True, timeout=15)

    async def close(self) -> None:
        await self.app_pool.close()
        await self.auth_pool.close()

    async def ping(self) -> bool:
        try:
            async with self.app_pool.connection(timeout=3) as conn:
                await conn.execute("SELECT 1")
            return True
        except Exception:
            return False

    @asynccontextmanager
    async def tx(self, s: Session) -> AsyncIterator[Conn]:
        """Tenant transaction as nazoratly_app. Commits on success, rolls back on any exception."""
        async with self.app_pool.connection() as conn:
            await _apply_session(conn, s)
            yield conn

    @asynccontextmanager
    async def auth_tx(self, s: Session | None = None) -> AsyncIterator[Conn]:
        """Transaction as nazoratly_auth (login, registration, refresh tokens)."""
        async with self.auth_pool.connection() as conn:
            await _apply_session(conn, s or Session(user_id=None, org_id=None))
            yield conn


async def _apply_session(conn: Conn, s: Session) -> None:
    await conn.execute(
        "SELECT set_config('app.org_id', %s, true), set_config('app.user_id', %s, true),"
        " set_config('app.request_id', %s, true), set_config('app.actor_type', %s, true),"
        " set_config('app.agent_client_id', %s, true)",
        (
            str(s.org_id) if s.org_id is not None else "",
            str(s.user_id) if s.user_id is not None else "",
            s.request_id or "",
            s.actor_type,
            str(s.agent_client_id) if s.agent_client_id is not None else "",
        ),
    )


async def fetch_all(conn: Conn, sql: str, params: Any = None) -> list[dict[str, Any]]:
    cur = await conn.execute(sql, params)
    return list(await cur.fetchall())


async def fetch_one(conn: Conn, sql: str, params: Any = None) -> dict[str, Any] | None:
    cur = await conn.execute(sql, params)
    return await cur.fetchone()


async def execute(conn: Conn, sql: str, params: Any = None) -> int:
    cur = await conn.execute(sql, params)
    return cur.rowcount


async def resolve(conn: Conn, table: str, public_id: Any, *, what: str | None = None) -> int:
    """public UUID -> internal id inside the current tenant (RLS applies); NotFound when absent/soft-deleted."""
    if table not in _RESOLVABLE:
        raise ValueError(f"table {table!r} is not resolvable")
    live = " AND deleted_at IS NULL" if _RESOLVABLE[table] else ""
    row = await fetch_one(conn, f"SELECT id FROM {table} WHERE public_id = %s{live}", (public_id,))
    if row is None:
        raise NotFound(f"{what or table.rstrip('s')} not found")
    return int(row["id"])


async def resolve_opt(conn: Conn, table: str, public_id: Any, *, what: str | None = None) -> int | None:
    return None if public_id is None else await resolve(conn, table, public_id, what=what)


_IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")


async def patch_row(conn: Conn, table: str, row_id: int, changes: dict[str, Any]) -> None:
    """UPDATE the given columns of one row. Table/column names come from code (pydantic fields), never from clients;
    the identifier check is a second line of defence."""
    if not changes:
        return
    if not _IDENT.match(table) or not all(_IDENT.match(k) for k in changes):
        raise ValueError("invalid identifier")
    sets = ", ".join(f"{k} = %({k})s" for k in changes)
    await conn.execute(f"UPDATE {table} SET {sets} WHERE id = %(_id)s", {**changes, "_id": row_id})
