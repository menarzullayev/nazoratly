"""Per-center settings (trial limits for now)."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import Field, StringConstraints

from nazoratly.db import Conn, execute, fetch_all, fetch_one
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import Forbidden, Unprocessable
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
    reminder_cooldown_days: int = Field(
        description="no second debt reminder draft for a student within these days"
    )
    reminder_min_overdue: int = Field(
        description="no debt reminder draft below this overdue amount, whole so'm"
    )
    reminder_template: str | None = Field(
        description="own text of the debt reminder ({guardian} {student} {amount} {days} {center}); null = standard"
    )
    installment_remind_days: int = Field(
        description="draft a reminder this many days before an installment is due (0 = off)"
    )


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
    reminder_cooldown_days: Annotated[int, Field(ge=0, le=365)] | None = None
    reminder_min_overdue: Annotated[int, Field(ge=0, le=1_000_000_000)] | None = None
    reminder_template: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = (
        Field(default=None, description="empty string = back to the standard text")
    )
    installment_remind_days: Annotated[int, Field(ge=0, le=30)] | None = None


_FIELDS = (
    "trial_free_lessons",
    "trial_free_days",
    "excused_mode",
    "makeup_expiry_days",
    "makeup_lapses",
    "package_expiry_days",
    "package_low_lessons",
    "lead_reminder_days",
    "family_discount_2nd_percent",
    "family_discount_3rd_percent",
    "requisites",
)  # the settings a branch may override (the rest is center-wide)
_ORG_ONLY = (
    "demo_mode, ai_enabled, ai_sees_names, ai_daily_limit, reminder_cooldown_days, reminder_min_overdue, "
    "reminder_template, installment_remind_days"
)
_CENTER_ONLY_PATCH = ("reminder_", "installment_remind_days")  # no branch override, as in the Sheets edition
_EFFECTIVE = ", ".join(f"COALESCE(bs.{f}, os.{f}) AS {f}" for f in _FIELDS if f != "requisites")
# requisites may be cleared in a branch ('' = print nothing), so a NULL there means "inherit", an empty string "none"
_EFFECTIVE += ", COALESCE(bs.requisites, os.requisites) AS requisites"


async def load_settings(conn: Conn, org_id: int, branch_id: int | None = None) -> SettingsOut:
    """The center's settings as they apply to a branch: the branch's own values over the center's. Without `branch_id`
    the branch the session works in (X-Branch / the staff member's branch) is used; none = the center's values."""
    if branch_id is None:
        row = await fetch_one(conn, "SELECT app_branch_id() AS b")
        assert row is not None
        branch_id = None if row["b"] is None else int(row["b"])
    return await load_settings_at(conn, org_id, branch_id)


async def load_settings_by_branch(conn: Conn, org_id: int) -> dict[int | None, SettingsOut]:
    """Effective settings of every visible branch (key = branch id) plus the center's own under key None: for work that
    spans branches (monthly charges, reminder lists), where each row must follow ITS branch's rules."""
    out: dict[int | None, SettingsOut] = {None: await load_settings_at(conn, org_id, None)}
    rows = await fetch_all(conn, "SELECT id FROM branches WHERE deleted_at IS NULL")
    for r in rows:
        out[int(r["id"])] = await load_settings_at(conn, org_id, int(r["id"]))
    return out


async def load_settings_at(conn: Conn, org_id: int, branch_id: int | None) -> SettingsOut:
    """Like load_settings, but `None` means the center's own values even inside a narrowed session."""
    await execute(
        conn, "INSERT INTO org_settings (org_id) VALUES (%s) ON CONFLICT (org_id) DO NOTHING", (org_id,)
    )
    row = await fetch_one(
        conn,
        f"SELECT {_EFFECTIVE}, os.{_ORG_ONLY.replace(', ', ', os.')} FROM org_settings os "
        "LEFT JOIN branch_settings bs ON bs.org_id = os.org_id AND bs.branch_id = %s WHERE os.org_id = %s",
        (branch_id, org_id),
    )
    assert row is not None
    return SettingsOut.model_validate(row)


@router.get("/settings", response_model=SettingsOut, summary="Center settings (trial limits)")
async def get_settings(p: Annotated[Principal, Depends(require("org:read"))], db: DB) -> SettingsOut:
    async with db.tx(p.session()) as conn:
        return await load_settings(conn, p.org_id)


@router.patch(
    "/settings",
    response_model=SettingsOut,
    summary="Change settings (a staff member working in a branch changes that branch's own values)",
)
async def patch_settings(
    body: SettingsPatch, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> SettingsOut:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if any(k.startswith("ai_") for k in changes) and not p.can("org:manage"):
        raise Forbidden("only the owner can change the AI switches")
    async with db.tx(p.session()) as conn:
        await load_settings_at(conn, p.org_id, None)  # creates the center row on first use
        if p.scope_branch_id is None:
            for (
                column,
                value,
            ) in changes.items():  # column names come from the model above, never from the client
                stored = None if column in ("requisites", "reminder_template") and value == "" else value
                await execute(
                    conn, f"UPDATE org_settings SET {column} = %s WHERE org_id = %s", (stored, p.org_id)
                )
        else:
            if any(k.startswith("ai_") for k in changes):
                raise Unprocessable("The AI switches are center-wide: change them without choosing a branch")
            if any(k.startswith(_CENTER_ONLY_PATCH) for k in changes):
                raise Unprocessable(
                    "The reminder settings are center-wide: change them without choosing a branch"
                )
            await set_branch_overrides(conn, p.org_id, p.scope_branch_id, changes)
        return await load_settings(conn, p.org_id)


async def set_branch_overrides(conn: Conn, org_id: int, branch_id: int, changes: dict[str, Any]) -> None:
    """Writes the given overrides of one branch; a value of None clears the override (the branch inherits again)."""
    await execute(
        conn,
        "INSERT INTO branch_settings (org_id, branch_id) VALUES (%s, %s) ON CONFLICT (branch_id) DO NOTHING",
        (org_id, branch_id),
    )
    for column, value in changes.items():
        if column not in _FIELDS:
            raise Unprocessable(f"{column} is a center-wide setting")
        await execute(
            conn, f"UPDATE branch_settings SET {column} = %s WHERE branch_id = %s", (value, branch_id)
        )
