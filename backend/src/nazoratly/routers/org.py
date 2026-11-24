"""Center profile, branches and staff (memberships)."""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from psycopg.errors import UniqueViolation
from pydantic import EmailStr, Field, StringConstraints, field_validator, model_validator

from nazoratly.db import execute, fetch_all, fetch_one, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Forbidden, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.schemas import Message, Model, Name, Out, Page, Phone, make_page
from nazoratly.security import hash_password

router = APIRouter(prefix="/v1", tags=["organization"], route_class=IdempotentRoute)

Role = Literal["owner", "admin", "manager", "accountant", "teacher", "viewer"]
_PRIVILEGED_ROLES = {"owner", "admin"}


# ---- organization --------------------------------------------------------------------------------------------
class OrganizationOut(Out):
    id: uuid.UUID
    name: str
    legal_name: str | None
    tin: str | None
    timezone: str
    currency: str
    status: str


class OrganizationPatch(Model):
    name: Name | None = None
    legal_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] | None = None
    tin: Annotated[str, StringConstraints(pattern=r"^([0-9]{9}|[0-9]{14})$")] | None = None
    timezone: str | None = None

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        if v is not None:
            try:
                ZoneInfo(v)
            except (ZoneInfoNotFoundError, ValueError) as e:
                raise ValueError("unknown IANA time zone") from e
        return v


_ORG_COLS = "public_id AS id, name, legal_name, tin, timezone, currency, status"


@router.get("/organization", response_model=OrganizationOut)
async def get_organization(p: Annotated[Principal, Depends(require("org:read"))], db: DB) -> OrganizationOut:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(conn, f"SELECT {_ORG_COLS} FROM organizations WHERE id = %s", (p.org_id,))
    if row is None:
        raise NotFound("Center not found")
    return OrganizationOut.model_validate(row)


@router.patch("/organization", response_model=OrganizationOut)
async def patch_organization(
    body: OrganizationPatch, p: Annotated[Principal, Depends(require("org:manage"))], db: DB
) -> OrganizationOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        if changes:
            sets = ", ".join(f"{k} = %({k})s" for k in changes)
            await execute(
                conn, f"UPDATE organizations SET {sets} WHERE id = %(_id)s", {**changes, "_id": p.org_id}
            )
        row = await fetch_one(conn, f"SELECT {_ORG_COLS} FROM organizations WHERE id = %s", (p.org_id,))
    assert row is not None
    return OrganizationOut.model_validate(row)


# ---- branches ------------------------------------------------------------------------------------------------
class BranchIn(Model):
    name: Name
    address: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None


class BranchPatch(Model):
    name: Name | None = None
    address: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None
    status: Literal["active", "closed"] | None = None


class BranchOut(Out):
    id: uuid.UUID
    name: str
    address: str | None
    status: str
    is_default: bool = Field(
        description="the center's default branch: where rows land when no branch is chosen"
    )


_BRANCH = "public_id AS id, name, address, status, is_default"


@router.get("/branches", response_model=Page[BranchOut])
async def list_branches(
    p: Annotated[Principal, Depends(require("org:read"))], db: DB, pg: Paging
) -> Page[BranchOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"SELECT {_BRANCH} FROM branches WHERE deleted_at IS NULL ORDER BY lower(name), id LIMIT %s OFFSET %s",
            (pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, BranchOut)


@router.post("/branches", response_model=BranchOut, status_code=201)
async def create_branch(
    body: BranchIn, p: Annotated[Principal, Depends(require("branches:manage"))], db: DB
) -> BranchOut:
    async with db.tx(p.session(unscoped=True)) as conn:  # center-wide staff only
        row = await fetch_one(
            conn,
            f"INSERT INTO branches (org_id, name, address) VALUES (%s, %s, %s) RETURNING {_BRANCH}",
            (p.org_id, body.name, body.address),
        )
    assert row is not None
    return BranchOut.model_validate(row)


@router.get("/branches/{branch_id}", response_model=BranchOut)
async def get_branch(
    branch_id: uuid.UUID, p: Annotated[Principal, Depends(require("org:read"))], db: DB
) -> BranchOut:
    async with db.tx(p.session()) as conn:
        bid = await resolve(conn, "branches", branch_id, what="branch")
        row = await fetch_one(conn, f"SELECT {_BRANCH} FROM branches WHERE id = %s", (bid,))
    assert row is not None
    return BranchOut.model_validate(row)


@router.patch("/branches/{branch_id}", response_model=BranchOut)
async def patch_branch(
    branch_id: uuid.UUID,
    body: BranchPatch,
    p: Annotated[Principal, Depends(require("branches:manage"))],
    db: DB,
) -> BranchOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session(unscoped=True)) as conn:
        bid = await resolve(conn, "branches", branch_id, what="branch")
        if changes.get("status") == "closed":
            cur = await fetch_one(conn, "SELECT is_default FROM branches WHERE id = %s", (bid,))
            if cur is not None and cur["is_default"]:
                raise Conflict("The default branch cannot be closed: make another branch the default first")
        if changes:
            sets = ", ".join(f"{k} = %({k})s" for k in changes)
            await execute(conn, f"UPDATE branches SET {sets} WHERE id = %(_id)s", {**changes, "_id": bid})
        row = await fetch_one(conn, f"SELECT {_BRANCH} FROM branches WHERE id = %s", (bid,))
    assert row is not None
    return BranchOut.model_validate(row)


@router.delete("/branches/{branch_id}", response_model=Message, summary="Soft-delete a branch")
async def delete_branch(
    branch_id: uuid.UUID, p: Annotated[Principal, Depends(require("branches:manage"))], db: DB
) -> Message:
    async with db.tx(p.session(unscoped=True)) as conn:
        bid = await resolve(conn, "branches", branch_id, what="branch")
        in_use = await fetch_one(
            conn,
            "SELECT (SELECT count(*) FROM study_groups WHERE branch_id = %(b)s AND deleted_at IS NULL) AS groups,"
            " (SELECT count(*) FROM rooms WHERE branch_id = %(b)s) AS rooms,"
            " (SELECT count(*) FROM students WHERE branch_id = %(b)s AND deleted_at IS NULL) AS students,"
            " (SELECT count(*) FROM memberships WHERE branch_id = %(b)s) AS staff,"
            " (SELECT is_default FROM branches WHERE id = %(b)s) AS is_default",
            {"b": bid},
        )
        assert in_use is not None
        if in_use["is_default"]:
            raise Conflict("The default branch cannot be deleted: make another branch the default first")
        if in_use["groups"] or in_use["rooms"] or in_use["students"] or in_use["staff"]:
            raise Conflict("Branch still has groups, rooms, students or staff", details=dict(in_use))
        await execute(conn, "UPDATE branches SET deleted_at = now(), status = 'closed' WHERE id = %s", (bid,))
    return Message(message="branch deleted")


# ---- staff ---------------------------------------------------------------------------------------------------
class StaffUser(Out):
    id: uuid.UUID
    full_name: str
    email: str | None
    phone: str | None


class StaffOut(Out):
    id: uuid.UUID
    user: StaffUser
    role: Role
    status: Literal["invited", "active", "suspended"]
    branch_id: uuid.UUID | None


class StaffIn(Model):
    full_name: Name
    email: EmailStr | None = None
    phone: Phone | None = None
    role: Role
    branch_id: uuid.UUID | None = None
    initial_password: Annotated[str, StringConstraints(min_length=10, max_length=128)] | None = None

    @model_validator(mode="after")
    def _identity(self) -> StaffIn:
        if self.email is None and self.phone is None:
            raise ValueError("email or phone is required")
        return self


class StaffPatch(Model):
    role: Role | None = None
    status: Literal["active", "suspended"] | None = None
    branch_id: uuid.UUID | None = None


_STAFF_SQL = (
    "SELECT m.public_id AS id, m.role, m.status, b.public_id AS branch_id, u.public_id AS user_public_id,"
    " u.full_name, u.email, u.phone, u.id AS user_internal_id "
    "FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN branches b ON b.org_id = m.org_id AND b.id = m.branch_id"
)


def _staff(row: dict[str, Any]) -> StaffOut:
    return StaffOut(
        id=row["id"],
        user=StaffUser(
            id=row["user_public_id"], full_name=row["full_name"], email=row["email"], phone=row["phone"]
        ),
        role=row["role"],
        status=row["status"],
        branch_id=row["branch_id"],
    )


def _may_assign(actor_role: str, target_role: str) -> None:
    if target_role in _PRIVILEGED_ROLES and actor_role != "owner":
        raise Forbidden("Only the owner can grant or change owner/admin roles")


@router.get("/staff", response_model=Page[StaffOut])
async def list_staff(
    p: Annotated[Principal, Depends(require("staff:read"))], db: DB, pg: Paging
) -> Page[StaffOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn, f"{_STAFF_SQL} ORDER BY m.id LIMIT %s OFFSET %s", (pg.limit + 1, pg.offset)
        )
    has_more = len(rows) > pg.limit
    return Page[StaffOut](
        items=[_staff(r) for r in rows[: pg.limit]], limit=pg.limit, offset=pg.offset, has_more=has_more
    )


@router.post(
    "/staff",
    response_model=StaffOut,
    status_code=201,
    summary="Add a staff member (new account or invitation)",
)
async def add_staff(
    body: StaffIn, p: Annotated[Principal, Depends(require("staff:manage"))], db: DB
) -> StaffOut:
    _may_assign(p.role, body.role)
    email = str(body.email).lower() if body.email else None
    async with db.tx(p.session()) as conn:
        branch_internal = await resolve_opt(conn, "branches", body.branch_id, what="branch")
    if p.branch_id is not None and branch_internal not in (None, p.branch_id):
        raise Forbidden("You can add staff only to your own branch")
    if p.branch_id is not None:
        branch_internal = p.branch_id  # staff of a branch can never create center-wide staff
    # Users are global; creating one and attaching it to this center is done by the auth identity in one transaction.
    async with db.auth_tx(p.session()) as conn:
        existing = await fetch_one(
            conn,
            "SELECT id FROM users WHERE (%(e)s::citext IS NOT NULL AND email = %(e)s::citext)"
            " OR (%(p)s::text IS NOT NULL AND phone = %(p)s::text)",
            {"e": email, "p": body.phone},
        )
        if existing is None:
            if body.initial_password is None:
                raise Unprocessable("initial_password is required for a new account")
            user = await fetch_one(
                conn,
                "INSERT INTO users (email, phone, full_name, password_hash) VALUES (%s, %s, %s, %s) RETURNING id",
                (email, body.phone, body.full_name, await hash_password(body.initial_password)),
            )
            assert user is not None
            user_id, status = user["id"], "active"
        else:
            user_id, status = (
                existing["id"],
                "invited",
            )  # an existing account must accept, never silently joins
        try:
            row = await fetch_one(
                conn,
                "INSERT INTO memberships (org_id, user_id, role, branch_id, status) VALUES (%s, %s, %s, %s, %s) RETURNING public_id",
                (p.org_id, user_id, body.role, branch_internal, status),
            )
        except UniqueViolation as exc:
            raise Conflict("This person is already a member of the center") from exc
        assert row is not None
    async with db.tx(p.session()) as conn:
        out = await fetch_one(conn, f"{_STAFF_SQL} WHERE m.public_id = %s", (row["public_id"],))
    assert out is not None
    return _staff(out)


@router.patch("/staff/{membership_id}", response_model=StaffOut)
async def patch_staff(
    membership_id: uuid.UUID,
    body: StaffPatch,
    p: Annotated[Principal, Depends(require("staff:manage"))],
    db: DB,
) -> StaffOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        cur = await fetch_one(
            conn,
            "SELECT id, user_id, role, status FROM memberships WHERE public_id = %s FOR UPDATE",
            (membership_id,),
        )
        if cur is None:
            raise NotFound("staff member not found")
        if cur["user_id"] == p.user_id and ({"role", "status"} & changes.keys()):
            raise Forbidden("You cannot change your own role or status")
        if cur["role"] in _PRIVILEGED_ROLES and p.role != "owner":
            raise Forbidden("Only the owner can modify owner/admin members")
        if "role" in changes:
            _may_assign(p.role, changes["role"])
        if "branch_id" in changes:
            changes["branch_id"] = await resolve_opt(conn, "branches", changes["branch_id"], what="branch")
            if p.branch_id is not None and changes["branch_id"] != p.branch_id:
                raise Forbidden(
                    "Staff of a branch cannot move people to another branch or make them center-wide"
                )
        leaves_owner = cur["role"] == "owner" and (
            changes.get("role", "owner") != "owner" or changes.get("status", cur["status"]) != "active"
        )
        if leaves_owner:
            owners = await fetch_one(
                conn,
                "SELECT count(*) AS n FROM memberships WHERE role = 'owner' AND status = 'active' AND id <> %s",
                (cur["id"],),
            )
            assert owners is not None
            if owners["n"] == 0:
                raise Conflict("The center must keep at least one active owner")
        if changes:
            sets = ", ".join(f"{k} = %({k})s" for k in changes)
            await execute(
                conn, f"UPDATE memberships SET {sets} WHERE id = %(_id)s", {**changes, "_id": cur["id"]}
            )
        out = await fetch_one(conn, f"{_STAFF_SQL} WHERE m.id = %s", (cur["id"],))
    assert out is not None
    return _staff(out)


__all__ = ["router"]
_ = make_page
