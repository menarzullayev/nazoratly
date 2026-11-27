"""Guardian cabinet, the center's side: one-time codes, linking (QR requests, manual) and the approval of what guardians ask.

Every action of a guardian waits here: nothing is changed (attendance, make-up lessons, promises) until a person with
`guardians:manage` approves it (Model B). Rules: `rules/guardian.py`, shared with the Sheets edition."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response

from nazoratly.db import execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Cfg, Principal, require
from nazoratly.errors import Conflict, NotFound
from nazoratly.guardian_service import (
    decide_request,
    ensure_guardian,
    issue_link_code,
    link_student,
    list_requests,
    unlink_student,
)
from nazoratly.idempotency import IdempotentRoute
from nazoratly.rules import guardian as G
from nazoratly.schemas import Model, Out
from nazoratly.telegram_registry import link_username

router = APIRouter(prefix="/v1/guardian", tags=["guardian cabinet (staff)"], route_class=IdempotentRoute)
Relation = Literal["mother", "father", "guardian", "self", "other"]


# ---- one-time codes ----------------------------------------------------------------------------------------------
class CodeIn(Model):
    student_id: uuid.UUID
    guardian_id: uuid.UUID | None = None
    relation: Relation = "guardian"


class CodeIssued(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    guardian_id: uuid.UUID | None
    code: str
    expires_at: datetime
    deep_link: str | None


class CodeRow(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    guardian_id: uuid.UUID | None
    relation: str
    state: Literal["ok", "used", "expired", "revoked"]
    expires_at: datetime
    used_at: datetime | None
    created_at: datetime


@router.post(
    "/codes",
    response_model=CodeIssued,
    status_code=201,
    summary="Issue a one-time link code for a student (shown once; only its hash is stored; valid 72 hours)",
)
async def issue_code(
    body: CodeIn, p: Annotated[Principal, Depends(require("guardians:manage"))], db: DB, cfg: Cfg
) -> CodeIssued:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        gid = None
        if body.guardian_id is not None:
            gid = await resolve(conn, "guardians", body.guardian_id, what="guardian")
            linked = await fetch_one(
                conn,
                "SELECT 1 AS x FROM student_guardians WHERE student_id = %s AND guardian_id = %s",
                (sid, gid),
            )
            if linked is None:
                raise Conflict("This guardian is not a guardian of the student: link them first")
        code, row = await issue_link_code(
            conn, org_id=p.org_id, student_id=sid, guardian_id=gid, relation=body.relation, user_id=p.user_id
        )
        username = await link_username(conn, p.org_id, cfg)
    link = f"https://t.me/{username}?start={code}" if username else None
    return CodeIssued(
        id=row["public_id"],
        student_id=body.student_id,
        guardian_id=body.guardian_id,
        code=code,
        expires_at=row["expires_at"],
        deep_link=link,
    )


@router.get("/codes", response_model=list[CodeRow], summary="Codes of a center (never the code itself)")
async def list_codes(
    p: Annotated[Principal, Depends(require("guardians:manage"))],
    db: DB,
    student_id: uuid.UUID | None = None,
) -> list[CodeRow]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT c.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, g.public_id AS guardian_id, "
            "c.relation, c.expires_at, c.used_at, c.revoked_at, c.created_at, now() AS now "
            "FROM guardian_link_codes c JOIN students s ON s.org_id = c.org_id AND s.id = c.student_id "
            "LEFT JOIN guardians g ON g.org_id = c.org_id AND g.id = c.guardian_id "
            "WHERE (%s::uuid IS NULL OR s.public_id = %s) ORDER BY c.id DESC LIMIT 200",
            (student_id, student_id),
        )
    out = []
    for r in rows:
        r["state"] = G.code_state(
            expires_at=r["expires_at"],
            now=r["now"],
            used=r["used_at"] is not None,
            revoked=r["revoked_at"] is not None,
        )
        out.append(CodeRow.model_validate(r))
    return out


@router.post("/codes/{code_id}/revoke", status_code=204, summary="Revoke an unused code")
async def revoke_code(
    code_id: uuid.UUID, p: Annotated[Principal, Depends(require("guardians:manage"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            "SELECT id, used_at, revoked_at FROM guardian_link_codes WHERE public_id = %s FOR UPDATE",
            (code_id,),
        )
        if row is None:
            raise NotFound("code not found")
        if row["used_at"] is not None:
            raise Conflict("The code was already used")
        await execute(
            conn,
            "UPDATE guardian_link_codes SET revoked_at = COALESCE(revoked_at, now()) WHERE id = %s",
            (row["id"],),
        )
    return Response(status_code=204)


# ---- links -------------------------------------------------------------------------------------------------------
class LinkRow(Out):
    student_id: uuid.UUID
    student_name: str
    guardian_id: uuid.UUID
    guardian_name: str
    relation: str
    linked_via: str | None
    telegram_linked: bool


@router.get("/links", response_model=list[LinkRow], summary="Who is linked to whom, and how")
async def list_links(
    p: Annotated[Principal, Depends(require("guardians:manage"))],
    db: DB,
    student_id: uuid.UUID | None = None,
) -> list[LinkRow]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT s.public_id AS student_id, s.full_name AS student_name, g.public_id AS guardian_id, g.full_name AS guardian_name, "
            "sg.relation, sg.linked_via, (g.telegram_chat_id IS NOT NULL) AS telegram_linked "
            "FROM student_guardians sg JOIN students s ON s.org_id = sg.org_id AND s.id = sg.student_id "
            "JOIN guardians g ON g.org_id = sg.org_id AND g.id = sg.guardian_id "
            "WHERE g.deleted_at IS NULL AND (%s::uuid IS NULL OR s.public_id = %s) ORDER BY s.full_name, g.full_name LIMIT 500",
            (student_id, student_id),
        )
    return [LinkRow.model_validate(r) for r in rows]


class ManualLinkIn(Model):
    student_id: uuid.UUID
    guardian_id: uuid.UUID
    telegram_chat_id: int
    relation: Relation = "guardian"


@router.post(
    "/links",
    response_model=LinkRow,
    status_code=201,
    summary="Link a guardian's Telegram account to a student by hand",
)
async def manual_link(
    body: ManualLinkIn, p: Annotated[Principal, Depends(require("guardians:manage"))], db: DB
) -> LinkRow:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        gid = await resolve(conn, "guardians", body.guardian_id, what="guardian")
        taken = await fetch_one(
            conn,
            "SELECT 1 AS x FROM guardians WHERE telegram_chat_id = %s AND id <> %s AND deleted_at IS NULL",
            (body.telegram_chat_id, gid),
        )
        if taken is not None:
            raise Conflict("This Telegram account is already linked to another guardian record of the center")
        await ensure_guardian(
            conn,
            org_id=p.org_id,
            telegram_user_id=body.telegram_chat_id,
            name=None,
            phone=None,
            guardian_id=gid,
        )
        await link_student(
            conn, org_id=p.org_id, student_id=sid, guardian_id=gid, relation=body.relation, via="manual"
        )
        await execute(
            conn,
            "UPDATE student_guardians SET linked_via = 'manual' WHERE student_id = %s AND guardian_id = %s",
            (sid, gid),
        )
        row = await fetch_one(
            conn,
            "SELECT s.public_id AS student_id, s.full_name AS student_name, g.public_id AS guardian_id, g.full_name AS guardian_name, "
            "sg.relation, sg.linked_via, (g.telegram_chat_id IS NOT NULL) AS telegram_linked "
            "FROM student_guardians sg JOIN students s ON s.org_id = sg.org_id AND s.id = sg.student_id "
            "JOIN guardians g ON g.org_id = sg.org_id AND g.id = sg.guardian_id WHERE sg.student_id = %s AND sg.guardian_id = %s",
            (sid, gid),
        )
    assert row is not None
    return LinkRow.model_validate(row)


@router.delete(
    "/links",
    status_code=204,
    summary="Remove a guardian from a student (his sessions end when no student is left)",
)
async def remove_link(
    student_id: uuid.UUID,
    guardian_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("guardians:manage"))],
    db: DB,
) -> Response:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        gid = await resolve(conn, "guardians", guardian_id, what="guardian")
        if not await unlink_student(conn, student_id=sid, guardian_id=gid):
            raise NotFound("link not found")
    return Response(status_code=204)


# ---- QR card requests (the center decides) -----------------------------------------------------------------------
class LinkRequestRow(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    telegram_user_id: int
    telegram_name: str | None
    status: Literal["pending", "approved", "rejected"]
    created_at: datetime
    decided_at: datetime | None


_LR_SQL = (
    "SELECT r.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, r.telegram_user_id, r.telegram_name, "
    "r.status, r.created_at, r.decided_at FROM guardian_link_requests r "
    "JOIN students s ON s.org_id = r.org_id AND s.id = r.student_id"
)


@router.get(
    "/link-requests",
    response_model=list[LinkRequestRow],
    summary="Link requests made with a student's QR card",
)
async def list_link_requests(
    p: Annotated[Principal, Depends(require("guardians:manage"))],
    db: DB,
    status: Literal["pending", "approved", "rejected"] | None = "pending",
) -> list[LinkRequestRow]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_LR_SQL} WHERE (%s::text IS NULL OR r.status = %s) ORDER BY r.id DESC LIMIT 200",
            (status, status),
        )
    return [LinkRequestRow.model_validate(r) for r in rows]


class ApproveLinkIn(Model):
    guardian_id: uuid.UUID | None = None  # an existing guardian record to attach the Telegram account to
    full_name: str | None = None  # name of the new guardian record (default: the Telegram name)
    relation: Relation = "guardian"


@router.post(
    "/link-requests/{request_id}/approve",
    response_model=LinkRequestRow,
    summary="Approve a QR-card link request",
)
async def approve_link_request(
    request_id: uuid.UUID,
    body: ApproveLinkIn,
    p: Annotated[Principal, Depends(require("guardians:manage"))],
    db: DB,
) -> LinkRequestRow:
    async with db.tx(p.session()) as conn:
        req = await fetch_one(
            conn,
            "SELECT id, student_id, telegram_user_id, telegram_name, status FROM guardian_link_requests WHERE public_id = %s FOR UPDATE",
            (request_id,),
        )
        if req is None:
            raise NotFound("link request not found")
        if req["status"] != "pending":
            raise Conflict(f"The request is already {req['status']}")
        gid_in = (
            await resolve(conn, "guardians", body.guardian_id, what="guardian") if body.guardian_id else None
        )
        gid = await ensure_guardian(
            conn,
            org_id=p.org_id,
            telegram_user_id=int(req["telegram_user_id"]),
            name=body.full_name or req["telegram_name"],
            phone=None,
            guardian_id=gid_in,
        )
        await link_student(
            conn,
            org_id=p.org_id,
            student_id=int(req["student_id"]),
            guardian_id=gid,
            relation=body.relation,
            via="qr",
        )
        await execute(
            conn,
            "UPDATE guardian_link_requests SET status = 'approved', guardian_id = %s, decided_by_user_id = %s, decided_at = now() WHERE id = %s",
            (gid, p.user_id, req["id"]),
        )
        row = await fetch_one(conn, f"{_LR_SQL} WHERE r.id = %s", (req["id"],))
    assert row is not None
    return LinkRequestRow.model_validate(row)


@router.post(
    "/link-requests/{request_id}/reject",
    response_model=LinkRequestRow,
    summary="Reject a QR-card link request",
)
async def reject_link_request(
    request_id: uuid.UUID, p: Annotated[Principal, Depends(require("guardians:manage"))], db: DB
) -> LinkRequestRow:
    async with db.tx(p.session()) as conn:
        req = await fetch_one(
            conn,
            "SELECT id, status FROM guardian_link_requests WHERE public_id = %s FOR UPDATE",
            (request_id,),
        )
        if req is None:
            raise NotFound("link request not found")
        if req["status"] != "pending":
            raise Conflict(f"The request is already {req['status']}")
        await execute(
            conn,
            "UPDATE guardian_link_requests SET status = 'rejected', decided_by_user_id = %s, decided_at = now() WHERE id = %s",
            (p.user_id, req["id"]),
        )
        row = await fetch_one(conn, f"{_LR_SQL} WHERE r.id = %s", (req["id"],))
    assert row is not None
    return LinkRequestRow.model_validate(row)


# ---- what guardians ask ------------------------------------------------------------------------------------------
class RequestRow(Out):
    id: uuid.UUID
    kind: Literal["absence_reason", "payment_promise", "makeup_choice"]
    status: Literal["pending", "approved", "rejected", "cancelled"]
    student_id: uuid.UUID
    student_name: str
    guardian_id: uuid.UUID
    guardian_name: str
    reason: str | None
    lesson_date: date | None
    promise_date: date | None
    promise_amount: Decimal | None
    slot_date: date | None
    created_at: datetime
    decided_at: datetime | None
    decision_note: str | None


class DecideIn(Model):
    note: str | None = None


@router.get(
    "/requests",
    response_model=list[RequestRow],
    summary="What guardians asked for (default: waiting for a decision)",
)
async def requests_list(
    p: Annotated[Principal, Depends(require("guardians:manage"))],
    db: DB,
    status: Annotated[Literal["pending", "approved", "rejected", "cancelled"] | None, Query()] = "pending",
    kind: Literal["absence_reason", "payment_promise", "makeup_choice"] | None = None,
) -> list[RequestRow]:
    async with db.tx(p.session()) as conn:
        rows = await list_requests(conn, status=status, kind=kind, limit=200)
    return [RequestRow.model_validate(r) for r in rows]


async def _decide(request_id: uuid.UUID, action: str, body: DecideIn, p: Principal, db: Any) -> RequestRow:
    async with db.tx(p.session()) as conn:
        row = await decide_request(conn, p, request_id, action, body.note)
    return RequestRow.model_validate(row)


@router.post(
    "/requests/{request_id}/approve",
    response_model=RequestRow,
    summary="Approve a request and apply it: absence -> attendance `excused`, make-up -> lesson scheduled, promise -> recorded",
)
async def approve_request(
    request_id: uuid.UUID,
    body: DecideIn,
    p: Annotated[Principal, Depends(require("guardians:manage"))],
    db: DB,
) -> RequestRow:
    return await _decide(request_id, "approve", body, p, db)


@router.post(
    "/requests/{request_id}/reject", response_model=RequestRow, summary="Reject a request (nothing changes)"
)
async def reject_request(
    request_id: uuid.UUID,
    body: DecideIn,
    p: Annotated[Principal, Depends(require("guardians:manage"))],
    db: DB,
) -> RequestRow:
    return await _decide(request_id, "reject", body, p, db)
