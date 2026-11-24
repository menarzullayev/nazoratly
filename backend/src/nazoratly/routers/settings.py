"""Per-center settings (trial limits for now)."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import Field, StringConstraints

from nazoratly.db import Conn, execute, fetch_one
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import Forbidden
from nazoratly.idempotency import IdempotentRoute
from nazoratly.schemas import Dec2, Model, Out

router = APIRouter(prefix="/v1", tags=["settings"], route_class=IdempotentRoute)


class SettingsOut(Out):
    trial_free_lessons: int
    trial_free_days: int
    excused_mode: Literal["makeup", "credit", "none"]
    makeup_expiry_days: int
    makeup_lapses: bool
    package_expiry_days: int
    package_low_lessons: int
    lead_reminder_days: int = Field(
        description="quiet days after which an open lead shows in the internal reminder list"
    )
    family_discount_2nd_percent: Dec2 = Field(
        description="percent off for the second child of a family (0 = off)"
    )
    family_discount_3rd_percent: Dec2 = Field(
        description="percent off for the third and later children of a family (0 = off)"
    )
    demo_mode: bool = Field(description="the center is in demo mode (switched through /v1/demo)")
    requisites: str | None = Field(
        description="the center's own requisites, printed on receipts and invoices"
    )
    ai_enabled: bool = Field(description="AI-written reports are allowed (off = rule-based reports only)")
    ai_sees_names: bool = Field(
        description="the AI may receive real student names (default off: pseudonyms only, names restored locally)"
    )
    ai_daily_limit: int = Field(description="AI-written reports per day; the rest are rule-based")


class SettingsPatch(Model):
    trial_free_lessons: Annotated[int, Field(ge=0, le=100)] | None = None
    trial_free_days: Annotated[int, Field(ge=0, le=365)] | None = None
    excused_mode: Literal["makeup", "credit", "none"] | None = None
    makeup_expiry_days: Annotated[int, Field(ge=0, le=365)] | None = None
    makeup_lapses: bool | None = None
    package_expiry_days: Annotated[int, Field(ge=1, le=730)] | None = None
    package_low_lessons: Annotated[int, Field(ge=0, le=50)] | None = None
    lead_reminder_days: Annotated[int, Field(ge=1, le=60)] | None = None
    family_discount_2nd_percent: (
        Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)] | None
    ) = None
    family_discount_3rd_percent: (
        Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)] | None
    ) = None
    requisites: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = Field(
        default=None, description="empty string clears it"
    )
    ai_enabled: bool | None = None  # AI switches need org:manage (the owner)
    ai_sees_names: bool | None = None
    ai_daily_limit: Annotated[int, Field(ge=0, le=200)] | None = None


async def load_settings(conn: Conn, org_id: int) -> SettingsOut:
    """The center's settings; the row is created with the defaults on first use."""
    await execute(
        conn, "INSERT INTO org_settings (org_id) VALUES (%s) ON CONFLICT (org_id) DO NOTHING", (org_id,)
    )
    row = await fetch_one(
        conn,
        "SELECT trial_free_lessons, trial_free_days, excused_mode, makeup_expiry_days, makeup_lapses, package_expiry_days, package_low_lessons, lead_reminder_days, family_discount_2nd_percent, family_discount_3rd_percent, demo_mode, requisites, ai_enabled, ai_sees_names, ai_daily_limit FROM org_settings WHERE org_id = %s",
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
    if any(k.startswith("ai_") for k in changes) and not p.can("org:manage"):
        raise Forbidden("only the owner can change the AI switches")
    async with db.tx(p.session()) as conn:
        await load_settings(conn, p.org_id)
        for column, value in changes.items():  # column names come from the model above, never from the client
            stored = None if column == "requisites" and value == "" else value
            await execute(
                conn, f"UPDATE org_settings SET {column} = %s WHERE org_id = %s", (stored, p.org_id)
            )
        return await load_settings(conn, p.org_id)
