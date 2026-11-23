"""Demo mode of a center: switch on (sample data, flagged), look, clear, switch off. The database function `demo_clear()`
deletes only flagged rows of the caller's center and refuses when a real row references a demo row."""

from __future__ import annotations

from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends

from nazoratly import demo
from nazoratly.accounting import org_today
from nazoratly.db import execute, fetch_one
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import ApiError, Conflict
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.settings import load_settings
from nazoratly.schemas import Out

router = APIRouter(prefix="/v1", tags=["demo mode"], route_class=IdempotentRoute)


class DemoOut(Out):
    demo_mode: bool
    counts: dict[str, int]


class ClearOut(Out):
    demo_mode: bool
    deleted: dict[str, int]


class DemoReferenced(ApiError):
    status_code, code = 409, "demo_referenced"


async def _clear(db: DB, p: Principal, *, switch_off: bool) -> ClearOut:
    """demo_clear() raises SQLSTATE DM001 with the blocking tables in its detail: the transaction rolls back (nothing is
    deleted, the mode stays) and the caller gets the reason."""
    try:
        async with db.tx(p.session()) as conn:
            cur = await conn.execute("SELECT demo_clear() AS r")
            row = await cur.fetchone()
            deleted = dict((row or {}).get("r") or {})
            if switch_off:
                await execute(
                    conn, "UPDATE org_settings SET demo_mode = false WHERE org_id = %s", (p.org_id,)
                )
            mode = (await load_settings(conn, p.org_id)).demo_mode
    except psycopg.Error as exc:
        if exc.diag.sqlstate == "DM001":
            raise DemoReferenced(
                "Demo data cannot be cleared: real records reference it. Remove or re-link them first.",
                details={"blockers": demo.blockers(exc.diag.message_detail)},
            ) from exc
        raise
    return ClearOut(demo_mode=mode, deleted={k: int(v) for k, v in deleted.items()})


@router.get("/demo", response_model=DemoOut, summary="Is demo mode on, and how many demo rows exist")
async def status(p: Annotated[Principal, Depends(require("org:read"))], db: DB) -> DemoOut:
    async with db.tx(p.session()) as conn:
        cfg = await load_settings(conn, p.org_id)
        return DemoOut(demo_mode=cfg.demo_mode, counts=await demo.counts(conn))


@router.post(
    "/demo/enable",
    response_model=DemoOut,
    status_code=201,
    summary="Switch demo mode on: write the sample data",
)
async def enable(p: Annotated[Principal, Depends(require("org:manage"))], db: DB) -> DemoOut:
    async with db.tx(p.session()) as conn:
        cfg = await load_settings(conn, p.org_id)
        if cfg.demo_mode:
            raise Conflict("Demo mode is already on; switch it off first to start over")
        existing = await fetch_one(conn, "SELECT count(*) AS n FROM students WHERE is_demo")
        assert existing is not None
        if existing["n"]:
            raise Conflict("Demo rows exist from before; clear them first")
        made = await demo.seed(conn, p.org_id, await org_today(conn))
        await execute(conn, "UPDATE org_settings SET demo_mode = true WHERE org_id = %s", (p.org_id,))
    return DemoOut(demo_mode=True, counts=made)


@router.post(
    "/demo/clear",
    response_model=ClearOut,
    summary="Delete the demo rows (only flagged ones); refused with the reason while a real record references one",
)
async def clear(p: Annotated[Principal, Depends(require("org:manage"))], db: DB) -> ClearOut:
    return await _clear(db, p, switch_off=False)


@router.post(
    "/demo/disable",
    response_model=ClearOut,
    summary="Switch demo mode off: clears the demo rows first (the mode stays on when that is refused)",
)
async def disable(p: Annotated[Principal, Depends(require("org:manage"))], db: DB) -> ClearOut:
    return await _clear(db, p, switch_off=True)
