"""Multi-branch service helpers: the branch a piece of work belongs to, narrowing a transaction to one branch, and the
branch lookups the routers share. The rules themselves are in rules/branches.py (shared with the Sheets edition); the
separation of data is the database's job (branch_scope policies), so most endpoints need nothing from here."""

from __future__ import annotations

import uuid
from typing import Any

from nazoratly.db import Conn, fetch_all, fetch_one
from nazoratly.deps import Principal
from nazoratly.errors import Forbidden, NotFound, Unprocessable
from nazoratly.rules.branches import cash_close_branch


async def set_scope(conn: Conn, branch_id: int | None) -> None:
    """Narrow (or widen: None) the branch scope of the current transaction. Row-level security reads it live."""
    await conn.execute(
        "SELECT set_config('app.branch_id', %s, true)", (str(branch_id) if branch_id is not None else "",)
    )


async def active_branch_ids(conn: Conn) -> list[int]:
    rows = await fetch_all(
        conn, "SELECT id FROM branches WHERE status = 'active' AND deleted_at IS NULL ORDER BY id"
    )
    return [int(r["id"]) for r in rows]


async def branch_by_public(conn: Conn, public_id: uuid.UUID) -> dict[str, Any]:
    row = await fetch_one(
        conn,
        "SELECT id, public_id, name, status, is_default FROM branches WHERE public_id = %s AND deleted_at IS NULL",
        (public_id,),
    )
    if row is None:
        raise NotFound("branch not found")
    return row


async def default_branch(conn: Conn, org_id: int) -> int:
    row = await fetch_one(conn, "SELECT default_branch_id(%s) AS id", (org_id,))
    assert row is not None and row["id"] is not None
    return int(row["id"])


async def branch_for_cash(conn: Conn, p: Principal, requested: uuid.UUID | None) -> int:
    """The branch a cash close / cash preview belongs to, and narrows the transaction to it, so the book balance and
    the shift numbers are that branch's own. Restricted staff: their branch. Center-wide staff: the branch they name, or
    the only active branch; with several active branches they must choose."""
    requested_id: int | None = None
    if requested is not None:
        row = await fetch_one(
            conn, "SELECT id FROM branches WHERE public_id = %s AND deleted_at IS NULL", (requested,)
        )
        if row is None:
            if p.scope_branch_id is not None:
                raise Forbidden("This branch is not available to your account")
            raise NotFound("branch not found")
        requested_id = int(row["id"])
    decided = cash_close_branch(
        scope=p.scope_branch_id, requested=requested_id, active=await active_branch_ids(conn)
    )
    error = decided["error"]
    if error == "forbidden_branch":
        raise Forbidden("This branch is not available to your account")
    if error == "unknown_branch":
        raise Unprocessable("The branch is closed or unknown")
    if error == "branch_required":
        raise Unprocessable(
            "This center has several branches: choose the branch of the cash desk (branch_id or the X-Branch header)",
            details={"errors": ["branch_required"]},
        )
    branch = int(decided["branch"])
    await set_scope(conn, branch)
    return branch


_MARKED = {"students", "enrollments", "lessons", "study_groups", "leads", "payments", "teachers"}


async def branch_of(conn: Conn, table: str, row_id: int) -> int | None:
    """The branch mark of one row (whitelisted tables)."""
    if table not in _MARKED:
        raise ValueError(f"{table!r} is not a branch-marked lookup table")
    row = await fetch_one(conn, f"SELECT branch_id FROM {table} WHERE id = %s", (row_id,))
    return None if row is None else int(row["branch_id"])
