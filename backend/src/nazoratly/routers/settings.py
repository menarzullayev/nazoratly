"""Per-center settings (trial limits for now)."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import Field, StringConstraints

from nazoratly.db import Conn, execute, fetch_one
from nazoratly.deps import DB, Principal, require
from nazoratly.idempotency import IdempotentRoute
from nazoratly.schemas import Model, Out

router = APIRouter(prefix="/v1", tags=["settings"], route_class=IdempotentRoute)


class SettingsOut(Out):
    trial_free_lessons: int
    trial_free_days: int
    excused_mode: Literal["makeup", "credit", "none"]
    makeup_expiry_days: int
    makeup_lapses: bool
    requisites: str | None = Field(
        description="the center's own requisites, printed on receipts and invoices"
    )


class SettingsPatch(Model):
    trial_free_lessons: Annotated[int, Field(ge=0, le=100)] | None = None
    trial_free_days: Annotated[int, Field(ge=0, le=365)] | None = None
    excused_mode: Literal["makeup", "credit", "none"] | None = None
    makeup_expiry_days: Annotated[int, Field(ge=0, le=365)] | None = None
    makeup_lapses: bool | None = None
    requisites: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = Field(
        default=None, description="empty string clears it"
    )


async def load_settings(conn: Conn, org_id: int) -> SettingsOut:
    """The center's settings; the row is created with the defaults on first use."""
    await execute(
        conn, "INSERT INTO org_settings (org_id) VALUES (%s) ON CONFLICT (org_id) DO NOTHING", (org_id,)
    )
    row = await fetch_one(
        conn,
        "SELECT trial_free_lessons, trial_free_days, excused_mode, makeup_expiry_days, makeup_lapses, requisites FROM org_settings WHERE org_id = %s",
        (org_id,),
    )
    assert row is not None
    return SettingsOut.model_validate(row)


@router.get("/settings", response_model=SettingsOut, summary="Center settings (trial limits)")
async def get_settings(p: Annotated[Principal, Depends(require("org:read"))], db: DB) -> SettingsOut:
    async with db.tx(p.session()) as conn:
        return await load_settings(conn, p.org_id)


@router.patch("/settings", response_model=SettingsOut)
async def patch_settings(
    body: SettingsPatch, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> SettingsOut:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    async with db.tx(p.session()) as conn:
        await load_settings(conn, p.org_id)
        for column, value in changes.items():  # column names come from the model above, never from the client
            stored = None if column == "requisites" and value == "" else value
            await execute(
                conn, f"UPDATE org_settings SET {column} = %s WHERE org_id = %s", (stored, p.org_id)
            )
        return await load_settings(conn, p.org_id)
