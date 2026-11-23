"""Lead funnel: sources, leads, interactions, atomic conversion into a trial enrollment, and the funnel report."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field

from nazoratly.db import Conn, execute, fetch_all, fetch_one, patch_row, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.academics import _ENR_SQL, EnrollmentOut, insert_enrollment
from nazoratly.routers.students import like_pattern
from nazoratly.rules.funnel import LeadFact, funnel_report
from nazoratly.schemas import LongText, Model, Name, Out, Page, Phone, make_page

router = APIRouter(prefix="/v1", tags=["leads"], route_class=IdempotentRoute)

Stage = Literal["new", "contacted", "trial_scheduled", "trial_attended", "enrolled", "lost"]
# `enrolled` is reached only through the conversion endpoint
SettableStage = Literal["new", "contacted", "trial_scheduled", "trial_attended", "lost"]
Kind = Literal["call", "message", "meeting", "trial", "note"]


class DuplicateStudent(Conflict):
    code = "duplicate_student"


# ---- sources -------------------------------------------------------------------------------------------------
class SourceIn(Model):
    name: Name


class SourceOut(Out):
    id: uuid.UUID
    name: str


@router.post("/lead-sources", response_model=SourceOut, status_code=201)
async def create_source(
    body: SourceIn, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> SourceOut:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            "INSERT INTO lead_sources (org_id, name) VALUES (%s, %s) RETURNING public_id AS id, name",
            (p.org_id, body.name),
        )
    assert row is not None
    return SourceOut.model_validate(row)


@router.get("/lead-sources", response_model=list[SourceOut])
async def list_sources(p: Annotated[Principal, Depends(require("students:read"))], db: DB) -> list[SourceOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(conn, "SELECT public_id AS id, name FROM lead_sources ORDER BY lower(name)")
    return [SourceOut.model_validate(r) for r in rows]


# ---- leads ---------------------------------------------------------------------------------------------------
class LeadIn(Model):
    full_name: Name
    phone: Phone | None = None
    source_id: uuid.UUID | None = None
    note: LongText | None = None
    next_follow_up_on: date | None = None


class LeadPatch(Model):
    full_name: Name | None = None
    phone: Phone | None = None
    source_id: uuid.UUID | None = None
    stage: SettableStage | None = None
    note: LongText | None = None
    next_follow_up_on: date | None = None


class LeadOut(Out):
    id: uuid.UUID
    full_name: str
    phone: str | None
    source: str | None
    source_id: uuid.UUID | None
    stage: Stage
    next_follow_up_on: date | None
    note: str | None
    student_id: uuid.UUID | None
    converted_at: datetime | None
    created_at: datetime


class InteractionIn(Model):
    happened_on: date
    kind: Kind
    summary: Annotated[str, Field(min_length=1, max_length=4000)]
    next_follow_up_on: date | None = None


class InteractionOut(Out):
    id: uuid.UUID
    happened_on: date
    kind: Kind
    summary: str
    next_follow_up_on: date | None
    created_at: datetime


class LeadDetail(LeadOut):
    interactions: list[InteractionOut]


_LEAD_SQL = (
    "SELECT l.public_id AS id, l.full_name, l.phone, src.name AS source, src.public_id AS source_id, l.stage, "
    "l.next_follow_up_on, l.note, st.public_id AS student_id, l.converted_at, l.created_at "
    "FROM leads l LEFT JOIN lead_sources src ON src.org_id = l.org_id AND src.id = l.source_id "
    "LEFT JOIN students st ON st.org_id = l.org_id AND st.id = l.student_id"
)


async def _lead(conn: Conn, lead_id: int) -> LeadOut:
    row = await fetch_one(conn, f"{_LEAD_SQL} WHERE l.id = %s", (lead_id,))
    assert row is not None
    return LeadOut.model_validate(row)


@router.post("/leads", response_model=LeadOut, status_code=201)
async def create_lead(
    body: LeadIn, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> LeadOut:
    async with db.tx(p.session()) as conn:
        src = await resolve_opt(conn, "lead_sources", body.source_id, what="lead source")
        row = await fetch_one(
            conn,
            "INSERT INTO leads (org_id, full_name, phone, source_id, note, next_follow_up_on) "
            "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, body.full_name, body.phone, src, body.note, body.next_follow_up_on),
        )
        assert row is not None
        return await _lead(conn, row["id"])


@router.get("/leads", response_model=Page[LeadOut])
async def list_leads(
    p: Annotated[Principal, Depends(require("students:read"))],
    db: DB,
    pg: Paging,
    stage: Stage | None = None,
    source_id: uuid.UUID | None = None,
    follow_up_before: date | None = None,
    q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
) -> Page[LeadOut]:
    where, params = ["l.deleted_at IS NULL"], []  # type: list[str], list[Any]
    if stage:
        where.append("l.stage = %s")
        params.append(stage)
    if source_id:
        where.append("src.public_id = %s")
        params.append(source_id)
    if follow_up_before:
        where.append("l.next_follow_up_on <= %s AND l.stage NOT IN ('enrolled', 'lost')")
        params.append(follow_up_before)
    if q:
        where.append("l.full_name ILIKE %s")
        params.append(like_pattern(q))
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_LEAD_SQL} WHERE {' AND '.join(where)} ORDER BY l.next_follow_up_on NULLS LAST, l.id DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, LeadOut)


@router.get("/leads/{lead_id}", response_model=LeadDetail)
async def get_lead(
    lead_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:read"))], db: DB
) -> LeadDetail:
    async with db.tx(p.session()) as conn:
        lid = await resolve(conn, "leads", lead_id, what="lead")
        lead = await _lead(conn, lid)
        rows = await fetch_all(
            conn,
            "SELECT public_id AS id, happened_on, kind, summary, next_follow_up_on, created_at "
            "FROM lead_interactions WHERE lead_id = %s ORDER BY happened_on DESC, id DESC",
            (lid,),
        )
    return LeadDetail(**lead.model_dump(), interactions=[InteractionOut.model_validate(r) for r in rows])


@router.patch("/leads/{lead_id}", response_model=LeadOut)
async def patch_lead(
    lead_id: uuid.UUID,
    body: LeadPatch,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> LeadOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        lid = await resolve(conn, "leads", lead_id, what="lead")
        if "source_id" in changes:
            changes["source_id"] = await resolve_opt(
                conn, "lead_sources", changes["source_id"], what="lead source"
            )
        if changes.get("full_name") is None:
            changes.pop("full_name", None)
        await patch_row(conn, "leads", lid, changes)
        return await _lead(conn, lid)


@router.post("/leads/{lead_id}/interactions", response_model=InteractionOut, status_code=201)
async def add_interaction(
    lead_id: uuid.UUID,
    body: InteractionIn,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> InteractionOut:
    if not body.summary.strip():
        raise Unprocessable("summary must not be blank")
    async with db.tx(p.session()) as conn:
        lid = await resolve(conn, "leads", lead_id, what="lead")
        row = await fetch_one(
            conn,
            "INSERT INTO lead_interactions (org_id, lead_id, happened_on, kind, summary, next_follow_up_on, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) "
            "RETURNING public_id AS id, happened_on, kind, summary, next_follow_up_on, created_at",
            (
                p.org_id,
                lid,
                body.happened_on,
                body.kind,
                body.summary.strip(),
                body.next_follow_up_on,
                p.user_id,
            ),
        )
        if body.next_follow_up_on is not None:
            await execute(
                conn, "UPDATE leads SET next_follow_up_on = %s WHERE id = %s", (body.next_follow_up_on, lid)
            )
    assert row is not None
    return InteractionOut.model_validate(row)


# ---- conversion ----------------------------------------------------------------------------------------------
class EnrollTrialIn(Model):
    group_id: uuid.UUID
    started_on: date | None = Field(default=None, description="defaults to today")
    link_existing: bool = Field(default=False, description="use the existing student that has the same phone")


class EnrollTrialOut(Out):
    lead: LeadOut
    student_id: uuid.UUID
    enrollment: EnrollmentOut


async def _student_with_phone(conn: Conn, phone: str) -> dict[str, Any] | None:
    return await fetch_one(
        conn,
        "SELECT s.id, s.public_id FROM students s WHERE s.phone = %(p)s AND s.deleted_at IS NULL "
        "UNION SELECT s.id, s.public_id FROM students s JOIN student_guardians sg ON sg.org_id = s.org_id AND sg.student_id = s.id "
        "JOIN guardians g ON g.org_id = sg.org_id AND g.id = sg.guardian_id "
        "WHERE g.phone = %(p)s AND s.deleted_at IS NULL AND g.deleted_at IS NULL LIMIT 1",
        {"p": phone},
    )


@router.post(
    "/leads/{lead_id}/enroll-trial",
    response_model=EnrollTrialOut,
    summary="Atomically turn a lead into a student with a trial enrollment (repeat calls return the first result)",
)
async def enroll_trial(
    lead_id: uuid.UUID,
    body: EnrollTrialIn,
    p: Annotated[Principal, Depends(require("students:write", "academics:write"))],
    db: DB,
) -> EnrollTrialOut:
    async with db.tx(p.session()) as conn:
        lid = await resolve(conn, "leads", lead_id, what="lead")
        gid = await resolve(conn, "study_groups", body.group_id, what="group")
        lead = await fetch_one(
            conn, "SELECT full_name, phone, student_id FROM leads WHERE id = %s FOR UPDATE", (lid,)
        )
        assert lead is not None
        if lead["student_id"] is not None:  # already converted: return the original result
            sid = int(lead["student_id"])
            existing = await fetch_one(
                conn,
                f"{_ENR_SQL} WHERE e.student_id = %s AND e.group_id = %s ORDER BY e.id DESC LIMIT 1",
                (sid, gid),
            )
            if existing is None:
                raise Conflict("This lead was already converted and is not enrolled in that group")
            pub = await fetch_one(conn, "SELECT public_id FROM students WHERE id = %s", (sid,))
            assert pub is not None
            return EnrollTrialOut(
                lead=await _lead(conn, lid),
                student_id=pub["public_id"],
                enrollment=EnrollmentOut.model_validate(existing),
            )
        if lead["phone"]:
            dup = await _student_with_phone(conn, lead["phone"])
            if dup is not None and not body.link_existing:
                raise DuplicateStudent(
                    "A student with this phone already exists",
                    details={"student_id": str(dup["public_id"])},
                )
        else:
            dup = None
        if dup is not None:
            sid = int(dup["id"])
        else:
            row = await fetch_one(
                conn,
                "INSERT INTO students (org_id, full_name, phone) VALUES (%s, %s, %s) RETURNING id",
                (p.org_id, lead["full_name"], lead["phone"]),
            )
            assert row is not None
            sid = int(row["id"])
        eid = await insert_enrollment(
            conn,
            org_id=p.org_id,
            student_id=sid,
            group_id=gid,
            started_on=body.started_on or date.today(),
            status="trial",
        )
        await execute(
            conn,
            "UPDATE leads SET stage = 'trial_scheduled', student_id = %s, converted_at = now() WHERE id = %s",
            (sid, lid),
        )
        out = await fetch_one(conn, f"{_ENR_SQL} WHERE e.id = %s", (eid,))
        assert out is not None
        pub = await fetch_one(conn, "SELECT public_id FROM students WHERE id = %s", (sid,))
        assert pub is not None
        return EnrollTrialOut(
            lead=await _lead(conn, lid),
            student_id=pub["public_id"],
            enrollment=EnrollmentOut.model_validate(out),
        )


# ---- funnel report -------------------------------------------------------------------------------------------
class SourceStat(Out):
    source: str | None
    leads: int
    enrolled: int
    conversion: float


class FunnelOut(Out):
    stages: dict[str, int]
    by_source: list[SourceStat]
    trial_to_enrolled: float


async def load_funnel(conn: Conn, date_from: date, date_to: date) -> FunnelOut:
    """Funnel of the leads created in the range (shared with the dashboard)."""
    rows = await fetch_all(
        conn,
        "SELECT l.stage, src.name AS source, (l.created_at AT TIME ZONE 'Asia/Tashkent')::date AS created_on "
        "FROM leads l LEFT JOIN lead_sources src ON src.org_id = l.org_id AND src.id = l.source_id "
        "WHERE l.deleted_at IS NULL AND (l.created_at AT TIME ZONE 'Asia/Tashkent')::date BETWEEN %s AND %s",
        (date_from, date_to),
    )
    report = funnel_report(
        [LeadFact(r["stage"], r["source"], r["created_on"]) for r in rows],
        date_from=date_from,
        date_to=date_to,
    )
    return FunnelOut.model_validate(report)


@router.get("/reports/funnel", response_model=FunnelOut, summary="Lead funnel for leads created in the range")
async def funnel(
    p: Annotated[Principal, Depends(require("reports:read"))], db: DB, date_from: date, date_to: date
) -> FunnelOut:
    if date_to < date_from or (date_to - date_from).days > 1830:
        raise Unprocessable("date range must be 0-1830 days")
    async with db.tx(p.session()) as conn:
        return await load_funnel(conn, date_from, date_to)
