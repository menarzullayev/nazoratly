"""Students, guardians, student-guardian links and personal-data consents."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints, model_validator

from nazoratly.db import Conn, execute, fetch_all, fetch_one, patch_row, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound
from nazoratly.idempotency import IdempotentRoute
from nazoratly.schemas import Dec2, LongText, Message, Model, Name, Out, Page, Phone, make_page

router = APIRouter(prefix="/v1", tags=["students"], route_class=IdempotentRoute)

StudentStatus = Literal["lead", "active", "paused", "graduated", "left"]
Relation = Literal["mother", "father", "guardian", "self", "other"]
Purpose = Literal["data_processing", "notifications", "ai_assistant_processing", "marketing"]


def like_pattern(q: str) -> str:
    """Escape LIKE wildcards in a user search string (the trigram index serves ILIKE '%q%')."""
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ---- students ------------------------------------------------------------------------------------------------
class StudentIn(Model):
    full_name: Name
    birth_date: date | None = None
    phone: Phone | None = None
    status: StudentStatus = "active"
    joined_on: date | None = None
    notes: LongText | None = None
    branch_id: uuid.UUID | None = Field(
        default=None,
        description="the branch of the new student; default: the branch you work in (X-Branch / your own), else the center's default",
    )


class StudentPatch(Model):
    full_name: Name | None = None
    birth_date: date | None = None
    phone: Phone | None = None
    status: StudentStatus | None = None
    joined_on: date | None = None
    notes: LongText | None = None


class StudentOut(Out):
    id: uuid.UUID
    branch_id: uuid.UUID | None = Field(
        description="the branch the student belongs to (move him with POST /students/{id}/transfer); "
        "None when he moved to a branch you cannot see"
    )
    full_name: str
    birth_date: date | None
    phone: str | None
    status: str
    joined_on: date | None
    notes: str | None
    created_at: datetime


class GuardianLink(Out):
    guardian_id: uuid.UUID
    full_name: str
    phone: str | None
    relation: str
    is_primary: bool
    receives_reminders: bool


class ConsentOut(Out):
    id: uuid.UUID
    purpose: str
    policy_version: str
    given_by_guardian_id: uuid.UUID | None
    given_by_self: bool
    evidence: str | None
    granted_at: datetime
    revoked_at: datetime | None


class BalanceOut(Out):
    outstanding_total: Dec2
    overdue_total: Dec2
    credit: Dec2


class StudentDetail(StudentOut):
    guardians: list[GuardianLink]
    consents: list[ConsentOut]
    balance: BalanceOut | None = None


_STUDENT = "public_id AS id, (SELECT b.public_id FROM branches b WHERE b.org_id = students.org_id AND b.id = students.branch_id) AS branch_id, full_name, birth_date, phone, status, joined_on, notes, created_at"


@router.post("/students", response_model=StudentOut, status_code=201)
async def create_student(
    body: StudentIn, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> StudentOut:
    async with db.tx(p.session()) as conn:
        bid = await resolve_opt(conn, "branches", body.branch_id, what="branch")
        row = await fetch_one(
            conn,
            f"INSERT INTO students (org_id, branch_id, full_name, birth_date, phone, status, joined_on, notes) "
            f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING {_STUDENT}",
            (
                p.org_id,
                bid,
                body.full_name,
                body.birth_date,
                body.phone,
                body.status,
                body.joined_on,
                body.notes,
            ),
        )
    assert row is not None
    return StudentOut.model_validate(row)


@router.get("/students", response_model=Page[StudentOut], summary="Search / list students")
async def list_students(
    p: Annotated[Principal, Depends(require("students:read"))],
    db: DB,
    pg: Paging,
    q: Annotated[str | None, Query(min_length=1, max_length=100, description="name fragment")] = None,
    status: StudentStatus | None = None,
) -> Page[StudentOut]:
    where: list[str] = ["deleted_at IS NULL"]
    params: list[Any] = []
    if q:
        where.append("full_name ILIKE %s")
        params.append(like_pattern(q))
    if status:
        where.append("status = %s")
        params.append(status)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"SELECT {_STUDENT} FROM students WHERE {' AND '.join(where)} ORDER BY lower(full_name), id LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, StudentOut)


async def _student_detail(conn: Conn, sid: int, with_balance: bool) -> StudentDetail:
    row = await fetch_one(conn, f"SELECT {_STUDENT} FROM students WHERE id = %s", (sid,))
    assert row is not None
    guardians = await fetch_all(
        conn,
        "SELECT g.public_id AS guardian_id, g.full_name, g.phone, sg.relation, sg.is_primary, sg.receives_reminders "
        "FROM student_guardians sg JOIN guardians g ON g.org_id = sg.org_id AND g.id = sg.guardian_id "
        "WHERE sg.student_id = %s AND g.deleted_at IS NULL ORDER BY sg.is_primary DESC, g.full_name",
        (sid,),
    )
    consents = await fetch_all(
        conn,
        "SELECT c.public_id AS id, c.purpose, c.policy_version, g.public_id AS given_by_guardian_id, c.given_by_self, "
        "c.evidence, c.granted_at, c.revoked_at FROM data_consents c "
        "LEFT JOIN guardians g ON g.org_id = c.org_id AND g.id = c.given_by_guardian_id "
        "WHERE c.student_id = %s ORDER BY c.granted_at DESC, c.id DESC",
        (sid,),
    )
    balance = None
    if with_balance:
        balance = await fetch_one(
            conn,
            "SELECT outstanding_total, overdue_total, credit FROM v_student_balance WHERE student_id = %s",
            (sid,),
        )
    return StudentDetail(
        **StudentOut.model_validate(row).model_dump(),
        guardians=[GuardianLink.model_validate(g) for g in guardians],
        consents=[ConsentOut.model_validate(c) for c in consents],
        balance=BalanceOut.model_validate(balance) if balance else None,
    )


@router.get("/students/{student_id}", response_model=StudentDetail)
async def get_student(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:read"))], db: DB
) -> StudentDetail:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        return await _student_detail(conn, sid, p.can("finance:read"))


@router.patch("/students/{student_id}", response_model=StudentOut)
async def patch_student(
    student_id: uuid.UUID,
    body: StudentPatch,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> StudentOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        await patch_row(conn, "students", sid, body.model_dump(exclude_unset=True))
        row = await fetch_one(conn, f"SELECT {_STUDENT} FROM students WHERE id = %s", (sid,))
    assert row is not None
    return StudentOut.model_validate(row)


@router.delete(
    "/students/{student_id}", response_model=Message, summary="Soft-delete a student without open debt"
)
async def delete_student(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> Message:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        bal = await fetch_one(
            conn, "SELECT outstanding_total FROM v_student_balance WHERE student_id = %s", (sid,)
        )
        if bal is not None and bal["outstanding_total"] > 0:
            raise Conflict(
                "Student has an outstanding balance; settle or void the charges first",
                details={"outstanding_total": str(bal["outstanding_total"])},
            )
        open_enr = await fetch_one(
            conn,
            "SELECT count(*) AS n FROM enrollments WHERE student_id = %s AND status IN ('active','frozen')",
            (sid,),
        )
        if open_enr is not None and open_enr["n"] > 0:
            raise Conflict("Student still has open enrollments")
        await execute(conn, "UPDATE students SET deleted_at = now(), status = 'left' WHERE id = %s", (sid,))
    return Message(message="student deleted")


# ---- guardians -----------------------------------------------------------------------------------------------
class GuardianIn(Model):
    full_name: Name
    phone: Phone | None = None
    telegram_chat_id: int | None = None

    @model_validator(mode="after")
    def _contact(self) -> GuardianIn:
        if self.phone is None and self.telegram_chat_id is None:
            raise ValueError("phone or telegram_chat_id is required")
        return self


class GuardianPatch(Model):
    full_name: Name | None = None
    phone: Phone | None = None
    telegram_chat_id: int | None = None


class GuardianOut(Out):
    id: uuid.UUID
    full_name: str
    phone: str | None
    telegram_chat_id: int | None


_GUARDIAN = "public_id AS id, full_name, phone, telegram_chat_id"


@router.post("/guardians", response_model=GuardianOut, status_code=201)
async def create_guardian(
    body: GuardianIn, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> GuardianOut:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            f"INSERT INTO guardians (org_id, full_name, phone, telegram_chat_id) VALUES (%s, %s, %s, %s) RETURNING {_GUARDIAN}",
            (p.org_id, body.full_name, body.phone, body.telegram_chat_id),
        )
    assert row is not None
    return GuardianOut.model_validate(row)


@router.get("/guardians", response_model=Page[GuardianOut])
async def list_guardians(
    p: Annotated[Principal, Depends(require("students:read"))],
    db: DB,
    pg: Paging,
    q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    phone: Phone | None = None,
) -> Page[GuardianOut]:
    where: list[str] = ["deleted_at IS NULL"]
    params: list[Any] = []
    if q:
        where.append("full_name ILIKE %s")
        params.append(like_pattern(q))
    if phone:
        where.append("phone = %s")
        params.append(phone)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"SELECT {_GUARDIAN} FROM guardians WHERE {' AND '.join(where)} ORDER BY lower(full_name), id LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, GuardianOut)


@router.get("/guardians/{guardian_id}", response_model=GuardianOut)
async def get_guardian(
    guardian_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:read"))], db: DB
) -> GuardianOut:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "guardians", guardian_id, what="guardian")
        row = await fetch_one(conn, f"SELECT {_GUARDIAN} FROM guardians WHERE id = %s", (gid,))
    assert row is not None
    return GuardianOut.model_validate(row)


@router.patch("/guardians/{guardian_id}", response_model=GuardianOut)
async def patch_guardian(
    guardian_id: uuid.UUID,
    body: GuardianPatch,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> GuardianOut:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "guardians", guardian_id, what="guardian")
        await patch_row(conn, "guardians", gid, body.model_dump(exclude_unset=True))
        row = await fetch_one(conn, f"SELECT {_GUARDIAN} FROM guardians WHERE id = %s", (gid,))
    assert row is not None
    return GuardianOut.model_validate(row)


@router.delete("/guardians/{guardian_id}", response_model=Message, summary="Soft-delete a guardian")
async def delete_guardian(
    guardian_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> Message:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "guardians", guardian_id, what="guardian")
        await execute(conn, "DELETE FROM student_guardians WHERE guardian_id = %s", (gid,))
        await execute(conn, "UPDATE guardians SET deleted_at = now() WHERE id = %s", (gid,))
    return Message(message="guardian deleted")


class LinkIn(Model):
    guardian_id: uuid.UUID
    relation: Relation
    is_primary: bool = False
    receives_reminders: bool = True


class LinkPatch(Model):
    relation: Relation | None = None
    is_primary: bool | None = None
    receives_reminders: bool | None = None


async def _link_out(conn: Conn, sid: int, gid: int) -> GuardianLink:
    row = await fetch_one(
        conn,
        "SELECT g.public_id AS guardian_id, g.full_name, g.phone, sg.relation, sg.is_primary, sg.receives_reminders "
        "FROM student_guardians sg JOIN guardians g ON g.org_id = sg.org_id AND g.id = sg.guardian_id "
        "WHERE sg.student_id = %s AND sg.guardian_id = %s",
        (sid, gid),
    )
    if row is None:
        raise NotFound("guardian is not linked to this student")
    return GuardianLink.model_validate(row)


@router.post("/students/{student_id}/guardians", response_model=GuardianLink, status_code=201)
async def link_guardian(
    student_id: uuid.UUID, body: LinkIn, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> GuardianLink:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        gid = await resolve(conn, "guardians", body.guardian_id, what="guardian")
        if body.is_primary:
            await execute(
                conn, "UPDATE student_guardians SET is_primary = false WHERE student_id = %s", (sid,)
            )
        await execute(
            conn,
            "INSERT INTO student_guardians (org_id, student_id, guardian_id, relation, is_primary, receives_reminders) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (p.org_id, sid, gid, body.relation, body.is_primary, body.receives_reminders),
        )
        return await _link_out(conn, sid, gid)


@router.patch("/students/{student_id}/guardians/{guardian_id}", response_model=GuardianLink)
async def patch_link(
    student_id: uuid.UUID,
    guardian_id: uuid.UUID,
    body: LinkPatch,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> GuardianLink:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        gid = await resolve(conn, "guardians", guardian_id, what="guardian")
        await _link_out(conn, sid, gid)  # 404 when not linked
        if changes.get("is_primary"):
            await execute(
                conn, "UPDATE student_guardians SET is_primary = false WHERE student_id = %s", (sid,)
            )
        if changes:
            sets = ", ".join(f"{k} = %({k})s" for k in changes)
            await conn.execute(
                f"UPDATE student_guardians SET {sets} WHERE student_id = %(s)s AND guardian_id = %(g)s",
                {**changes, "s": sid, "g": gid},
            )
        return await _link_out(conn, sid, gid)


@router.delete("/students/{student_id}/guardians/{guardian_id}", response_model=Message)
async def unlink_guardian(
    student_id: uuid.UUID,
    guardian_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> Message:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        gid = await resolve(conn, "guardians", guardian_id, what="guardian")
        n = await execute(
            conn, "DELETE FROM student_guardians WHERE student_id = %s AND guardian_id = %s", (sid, gid)
        )
        if n == 0:
            raise NotFound("guardian is not linked to this student")
    return Message(message="unlinked")


# ---- consents ------------------------------------------------------------------------------------------------
class ConsentIn(Model):
    purpose: Purpose
    policy_version: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    given_by_guardian_id: uuid.UUID | None = None
    given_by_self: bool = False
    evidence: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None

    @model_validator(mode="after")
    def _who(self) -> ConsentIn:
        if self.given_by_guardian_id is None and not self.given_by_self:
            raise ValueError("a consent must be given by a guardian or by the student")
        return self


async def _consent_out(conn: Conn, cid: int) -> ConsentOut:
    row = await fetch_one(
        conn,
        "SELECT c.public_id AS id, c.purpose, c.policy_version, g.public_id AS given_by_guardian_id, c.given_by_self, "
        "c.evidence, c.granted_at, c.revoked_at FROM data_consents c "
        "LEFT JOIN guardians g ON g.org_id = c.org_id AND g.id = c.given_by_guardian_id WHERE c.id = %s",
        (cid,),
    )
    assert row is not None
    return ConsentOut.model_validate(row)


@router.get("/students/{student_id}/consents", response_model=list[ConsentOut])
async def list_consents(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:read"))], db: DB
) -> list[ConsentOut]:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        return (await _student_detail(conn, sid, False)).consents if sid else []


@router.post("/students/{student_id}/consents", response_model=ConsentOut, status_code=201)
async def give_consent(
    student_id: uuid.UUID,
    body: ConsentIn,
    p: Annotated[Principal, Depends(require("consents:write"))],
    db: DB,
) -> ConsentOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        gid = None
        if body.given_by_guardian_id is not None:
            gid = await resolve(conn, "guardians", body.given_by_guardian_id, what="guardian")
            linked = await fetch_one(
                conn,
                "SELECT 1 AS x FROM student_guardians WHERE student_id = %s AND guardian_id = %s",
                (sid, gid),
            )
            if linked is None:
                raise NotFound("guardian is not linked to this student")
        row = await fetch_one(
            conn,
            "INSERT INTO data_consents (org_id, student_id, given_by_guardian_id, given_by_self, purpose, policy_version, evidence) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, sid, gid, body.given_by_self, body.purpose, body.policy_version, body.evidence),
        )
        assert row is not None
        return await _consent_out(conn, row["id"])


@router.post(
    "/consents/{consent_id}/revoke", response_model=ConsentOut, summary="Revoke a consent (never deleted)"
)
async def revoke_consent(
    consent_id: uuid.UUID, p: Annotated[Principal, Depends(require("consents:write"))], db: DB
) -> ConsentOut:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "data_consents", consent_id, what="consent")
        cur = await fetch_one(conn, "SELECT revoked_at FROM data_consents WHERE id = %s FOR UPDATE", (cid,))
        assert cur is not None
        if cur["revoked_at"] is not None:
            raise Conflict("Consent is already revoked")
        await execute(conn, "UPDATE data_consents SET revoked_at = now() WHERE id = %s", (cid,))
        return await _consent_out(conn, cid)


_ = Any
