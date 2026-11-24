"""Courses, teachers, rooms, study groups (+ weekly schedule) and enrollments."""

from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, model_validator

from nazoratly.accounting import org_today
from nazoratly.branches import default_branch
from nazoratly.db import Conn, execute, fetch_all, fetch_one, patch_row, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Forbidden, GroupFull, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.branches import price_for_new_group
from nazoratly.routers.students import like_pattern
from nazoratly.rules import capacity as seats
from nazoratly.scheduling import ScheduleConflict, weekly_check
from nazoratly.schemas import (
    Dec2,
    LongText,
    Message,
    Model,
    Money,
    Name,
    Out,
    Page,
    Phone,
    PositiveMoney,
    make_page,
)

router = APIRouter(prefix="/v1", tags=["academics"], route_class=IdempotentRoute)


async def my_teacher_id(conn: Conn, p: Principal) -> int | None:
    """For role 'teacher' the internal id of their teacher profile (None if they have none)."""
    row = await fetch_one(
        conn, "SELECT id FROM teachers WHERE user_id = %s AND deleted_at IS NULL", (p.user_id,)
    )
    return int(row["id"]) if row else None


async def assert_group_access(conn: Conn, p: Principal, group_id: int) -> None:
    """Teachers may touch only groups they teach; every other role with the permission may touch any group."""
    if p.role != "teacher":
        return
    mine = await my_teacher_id(conn, p)
    row = await fetch_one(conn, "SELECT teacher_id FROM study_groups WHERE id = %s", (group_id,))
    if mine is None or row is None or row["teacher_id"] != mine:
        raise Forbidden("Teachers can access only their own groups")


# ---- courses -------------------------------------------------------------------------------------------------
class CourseIn(Model):
    name: Name
    description: LongText | None = None
    default_monthly_fee: Money = Decimal(0)


class CoursePatch(Model):
    name: Name | None = None
    description: LongText | None = None
    default_monthly_fee: Money | None = None
    status: Literal["active", "archived"] | None = None


class CourseOut(Out):
    id: uuid.UUID
    name: str
    description: str | None
    default_monthly_fee: Dec2
    status: str


_COURSE = "public_id AS id, name, description, default_monthly_fee, status"


@router.post("/courses", response_model=CourseOut, status_code=201)
async def create_course(
    body: CourseIn, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> CourseOut:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            f"INSERT INTO courses (org_id, name, description, default_monthly_fee) VALUES (%s, %s, %s, %s) RETURNING {_COURSE}",
            (p.org_id, body.name, body.description, body.default_monthly_fee),
        )
    assert row is not None
    return CourseOut.model_validate(row)


@router.get("/courses", response_model=Page[CourseOut])
async def list_courses(
    p: Annotated[Principal, Depends(require("academics:read"))],
    db: DB,
    pg: Paging,
    status: Literal["active", "archived"] | None = None,
) -> Page[CourseOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"SELECT {_COURSE} FROM courses WHERE deleted_at IS NULL AND (%s::text IS NULL OR status = %s) "
            "ORDER BY lower(name), id LIMIT %s OFFSET %s",
            (status, status, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, CourseOut)


@router.get("/courses/{course_id}", response_model=CourseOut)
async def get_course(
    course_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:read"))], db: DB
) -> CourseOut:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "courses", course_id, what="course")
        row = await fetch_one(conn, f"SELECT {_COURSE} FROM courses WHERE id = %s", (cid,))
    assert row is not None
    return CourseOut.model_validate(row)


@router.patch("/courses/{course_id}", response_model=CourseOut)
async def patch_course(
    course_id: uuid.UUID,
    body: CoursePatch,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> CourseOut:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "courses", course_id, what="course")
        await patch_row(conn, "courses", cid, body.model_dump(exclude_unset=True))
        row = await fetch_one(conn, f"SELECT {_COURSE} FROM courses WHERE id = %s", (cid,))
    assert row is not None
    return CourseOut.model_validate(row)


@router.delete(
    "/courses/{course_id}", response_model=Message, summary="Soft-delete a course without live groups"
)
async def delete_course(
    course_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> Message:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "courses", course_id, what="course")
        n = await fetch_one(
            conn, "SELECT count(*) AS n FROM study_groups WHERE course_id = %s AND deleted_at IS NULL", (cid,)
        )
        assert n is not None
        if n["n"]:
            raise Conflict("Course still has groups")
        await execute(
            conn, "UPDATE courses SET deleted_at = now(), status = 'archived' WHERE id = %s", (cid,)
        )
    return Message(message="course deleted")


# ---- teachers ------------------------------------------------------------------------------------------------
PayModel = Literal["fixed", "per_lesson", "percent"]


class TeacherIn(Model):
    full_name: Name
    phone: Phone | None = None
    pay_model: PayModel = "per_lesson"
    pay_rate: Money = Decimal(0)
    hired_on: date | None = None
    staff_id: uuid.UUID | None = Field(
        default=None, description="membership id of the teacher's login, if any"
    )
    branch_id: uuid.UUID | None = Field(
        default=None,
        description="the teacher's home branch; default: the branch you work in, else the default branch",
    )

    @model_validator(mode="after")
    def _percent(self) -> TeacherIn:
        if self.pay_model == "percent" and self.pay_rate > 100:
            raise ValueError("percent rate cannot exceed 100")
        return self


class TeacherPatch(Model):
    full_name: Name | None = None
    phone: Phone | None = None
    pay_model: PayModel | None = None
    pay_rate: Money | None = None
    hired_on: date | None = None
    status: Literal["active", "inactive"] | None = None
    staff_id: uuid.UUID | None = None


class TeacherOut(Out):
    id: uuid.UUID
    branch_id: uuid.UUID = Field(description="the teacher's home branch")
    full_name: str
    phone: str | None
    pay_model: str
    pay_rate: Dec2
    status: str
    hired_on: date | None
    has_login: bool


_TEACHER = "t.public_id AS id, (SELECT b.public_id FROM branches b WHERE b.org_id = t.org_id AND b.id = t.branch_id) AS branch_id, t.full_name, t.phone, t.pay_model, t.pay_rate, t.status, t.hired_on, (t.user_id IS NOT NULL) AS has_login"


async def _user_of_staff(conn: Conn, staff_id: uuid.UUID | None) -> int | None:
    if staff_id is None:
        return None
    row = await fetch_one(conn, "SELECT user_id FROM memberships WHERE public_id = %s", (staff_id,))
    if row is None:
        raise NotFound("staff member not found")
    return int(row["user_id"])


@router.post("/teachers", response_model=TeacherOut, status_code=201)
async def create_teacher(
    body: TeacherIn, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> TeacherOut:
    async with db.tx(p.session()) as conn:
        uid = await _user_of_staff(conn, body.staff_id)
        bid = await resolve_opt(conn, "branches", body.branch_id, what="branch")
        row = await fetch_one(
            conn,
            "INSERT INTO teachers (org_id, branch_id, user_id, full_name, phone, pay_model, pay_rate, hired_on) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, bid, uid, body.full_name, body.phone, body.pay_model, body.pay_rate, body.hired_on),
        )
        assert row is not None
        out = await fetch_one(conn, f"SELECT {_TEACHER} FROM teachers t WHERE t.id = %s", (row["id"],))
    assert out is not None
    return TeacherOut.model_validate(out)


@router.get("/teachers", response_model=Page[TeacherOut])
async def list_teachers(
    p: Annotated[Principal, Depends(require("academics:read"))],
    db: DB,
    pg: Paging,
    status: Literal["active", "inactive"] | None = None,
) -> Page[TeacherOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"SELECT {_TEACHER} FROM teachers t WHERE t.deleted_at IS NULL AND (%s::text IS NULL OR t.status = %s) "
            "ORDER BY lower(t.full_name), t.id LIMIT %s OFFSET %s",
            (status, status, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, TeacherOut)


@router.get("/teachers/{teacher_id}", response_model=TeacherOut)
async def get_teacher(
    teacher_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:read"))], db: DB
) -> TeacherOut:
    async with db.tx(p.session()) as conn:
        tid = await resolve(conn, "teachers", teacher_id, what="teacher")
        out = await fetch_one(conn, f"SELECT {_TEACHER} FROM teachers t WHERE t.id = %s", (tid,))
    assert out is not None
    return TeacherOut.model_validate(out)


@router.patch("/teachers/{teacher_id}", response_model=TeacherOut)
async def patch_teacher(
    teacher_id: uuid.UUID,
    body: TeacherPatch,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> TeacherOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        tid = await resolve(conn, "teachers", teacher_id, what="teacher")
        if "staff_id" in changes:
            changes["user_id"] = await _user_of_staff(conn, changes.pop("staff_id"))
        await patch_row(conn, "teachers", tid, changes)
        out = await fetch_one(conn, f"SELECT {_TEACHER} FROM teachers t WHERE t.id = %s", (tid,))
    assert out is not None
    return TeacherOut.model_validate(out)


@router.delete(
    "/teachers/{teacher_id}", response_model=Message, summary="Soft-delete a teacher without live groups"
)
async def delete_teacher(
    teacher_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> Message:
    async with db.tx(p.session()) as conn:
        tid = await resolve(conn, "teachers", teacher_id, what="teacher")
        n = await fetch_one(
            conn,
            "SELECT count(*) AS n FROM study_groups WHERE teacher_id = %s AND deleted_at IS NULL AND status IN ('planned','active')",
            (tid,),
        )
        assert n is not None
        if n["n"]:
            raise Conflict("Teacher still leads active groups")
        await execute(
            conn, "UPDATE teachers SET deleted_at = now(), status = 'inactive' WHERE id = %s", (tid,)
        )
    return Message(message="teacher deleted")


# ---- rooms ---------------------------------------------------------------------------------------------------
class RoomIn(Model):
    branch_id: uuid.UUID
    name: Name
    capacity: Annotated[int, Field(gt=0, le=10_000)] | None = None


class RoomOut(Out):
    id: uuid.UUID
    branch_id: uuid.UUID
    name: str
    capacity: int | None


_ROOM = "r.public_id AS id, b.public_id AS branch_id, r.name, r.capacity"
_ROOM_FROM = "FROM rooms r JOIN branches b ON b.org_id = r.org_id AND b.id = r.branch_id"


@router.post("/rooms", response_model=RoomOut, status_code=201)
async def create_room(
    body: RoomIn, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> RoomOut:
    async with db.tx(p.session()) as conn:
        bid = await resolve(conn, "branches", body.branch_id, what="branch")
        row = await fetch_one(
            conn,
            "INSERT INTO rooms (org_id, branch_id, name, capacity) VALUES (%s, %s, %s, %s) RETURNING id",
            (p.org_id, bid, body.name, body.capacity),
        )
        assert row is not None
        out = await fetch_one(conn, f"SELECT {_ROOM} {_ROOM_FROM} WHERE r.id = %s", (row["id"],))
    assert out is not None
    return RoomOut.model_validate(out)


@router.get("/rooms", response_model=Page[RoomOut])
async def list_rooms(
    p: Annotated[Principal, Depends(require("academics:read"))], db: DB, pg: Paging
) -> Page[RoomOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"SELECT {_ROOM} {_ROOM_FROM} ORDER BY b.name, r.name, r.id LIMIT %s OFFSET %s",
            (pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, RoomOut)


class RoomPatch(Model):
    name: Name | None = None
    capacity: Annotated[int, Field(gt=0, le=10_000)] | None = None


@router.patch("/rooms/{room_id}", response_model=RoomOut)
async def patch_room(
    room_id: uuid.UUID, body: RoomPatch, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> RoomOut:
    async with db.tx(p.session()) as conn:
        rid = await resolve(conn, "rooms", room_id, what="room")
        await patch_row(conn, "rooms", rid, body.model_dump(exclude_unset=True))
        out = await fetch_one(conn, f"SELECT {_ROOM} {_ROOM_FROM} WHERE r.id = %s", (rid,))
    assert out is not None
    return RoomOut.model_validate(out)


@router.delete("/rooms/{room_id}", response_model=Message)
async def delete_room(
    room_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> Message:
    async with db.tx(p.session()) as conn:
        rid = await resolve(conn, "rooms", room_id, what="room")
        await execute(
            conn, "DELETE FROM rooms WHERE id = %s", (rid,)
        )  # FK RESTRICT -> 422 when lessons/schedules use it
    return Message(message="room deleted")


# ---- groups --------------------------------------------------------------------------------------------------
GroupStatus = Literal["planned", "active", "finished", "cancelled"]


class ScheduleSlot(Model):
    weekday: Annotated[int, Field(ge=1, le=7, description="ISO weekday, 1 = Monday")]
    start_time: time
    end_time: time
    room_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _order(self) -> ScheduleSlot:
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


BillingMode = Literal["monthly", "package"]


def billing_shape_error(mode: str, lessons: int | None, price: Decimal | None) -> str | None:
    """A package-billed group needs lessons and price; a monthly group carries neither."""
    if mode == "package" and (lessons is None or price is None):
        return "a package-billed group needs package_lessons and package_price"
    if mode == "monthly" and (lessons is not None or price is not None):
        return "package_lessons and package_price are only for package-billed groups"
    return None


class ScheduleSlotOut(Out):
    weekday: int
    start_time: time
    end_time: time
    room_id: uuid.UUID | None


class GroupIn(Model):
    course_id: uuid.UUID
    name: Name
    teacher_id: uuid.UUID | None = None
    branch_id: uuid.UUID | None = None
    monthly_fee: Money | None = Field(default=None, description="defaults to the course's default fee")
    capacity: Annotated[int, Field(gt=0, le=10_000)] | None = None
    start_date: date
    end_date: date | None = None
    status: GroupStatus = "planned"
    billing_mode: BillingMode = "monthly"
    package_lessons: Annotated[int, Field(ge=1, le=200)] | None = Field(
        default=None, description="lessons in one package (package-billed groups only)"
    )
    package_price: PositiveMoney | None = Field(
        default=None, description="price of one package (package-billed groups only)"
    )

    @model_validator(mode="after")
    def _dates(self) -> GroupIn:
        if self.end_date is not None and self.end_date < self.start_date:
            raise ValueError("end_date cannot be before start_date")
        if (
            msg := billing_shape_error(self.billing_mode, self.package_lessons, self.package_price)
        ) is not None:
            raise ValueError(msg)
        return self


class GroupPatch(Model):
    name: Name | None = None
    teacher_id: uuid.UUID | None = None
    branch_id: uuid.UUID | None = None
    monthly_fee: Money | None = None
    capacity: Annotated[int, Field(gt=0, le=10_000)] | None = None
    start_date: date | None = None
    end_date: date | None = None
    status: GroupStatus | None = None
    billing_mode: BillingMode | None = None
    package_lessons: Annotated[int, Field(ge=1, le=200)] | None = None
    package_price: PositiveMoney | None = None


class GroupOut(Out):
    id: uuid.UUID
    name: str
    course_id: uuid.UUID
    course_name: str
    teacher_id: uuid.UUID | None
    teacher_name: str | None
    branch_id: uuid.UUID | None
    monthly_fee: Dec2
    capacity: int | None
    start_date: date
    end_date: date | None
    status: str
    billing_mode: BillingMode
    package_lessons: int | None
    package_price: Dec2 | None
    active_students: int


class GroupDetail(GroupOut):
    schedule: list[ScheduleSlotOut]


class ScheduleSaved(GroupDetail):
    conflicts: list[dict[str, Any]] = Field(
        default_factory=list,
        description="weekly slots that clash with another group (only when allow_conflict=true)",
    )
    capacity_warnings: list[dict[str, Any]] = Field(
        default_factory=list, description="rooms that hold fewer students than the group allows or has"
    )


_GROUP_SQL = (
    "SELECT g.public_id AS id, g.name, c.public_id AS course_id, c.name AS course_name, t.public_id AS teacher_id,"
    " t.full_name AS teacher_name, b.public_id AS branch_id, g.monthly_fee, g.capacity, g.start_date, g.end_date, g.status, g.billing_mode, g.package_lessons, g.package_price,"
    " (SELECT count(*) FROM enrollments e WHERE e.group_id = g.id AND e.status = 'active') AS active_students "
    "FROM study_groups g JOIN courses c ON c.org_id = g.org_id AND c.id = g.course_id "
    "LEFT JOIN teachers t ON t.org_id = g.org_id AND t.id = g.teacher_id "
    "LEFT JOIN branches b ON b.org_id = g.org_id AND b.id = g.branch_id"
)


async def _group_detail(conn: Conn, gid: int) -> GroupDetail:
    row = await fetch_one(conn, f"{_GROUP_SQL} WHERE g.id = %s", (gid,))
    if row is None:
        raise NotFound("group not found")
    sched = await fetch_all(
        conn,
        "SELECT s.weekday, s.start_time, s.end_time, r.public_id AS room_id FROM group_schedules s "
        "LEFT JOIN rooms r ON r.org_id = s.org_id AND r.id = s.room_id WHERE s.group_id = %s ORDER BY s.weekday, s.start_time",
        (gid,),
    )
    return GroupDetail(
        **GroupOut.model_validate(row).model_dump(),
        schedule=[ScheduleSlotOut.model_validate(s) for s in sched],
    )


@router.post("/groups", response_model=GroupDetail, status_code=201)
async def create_group(
    body: GroupIn, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> GroupDetail:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "courses", body.course_id, what="course")
        tid = await resolve_opt(conn, "teachers", body.teacher_id, what="teacher")
        bid = await resolve_opt(conn, "branches", body.branch_id, what="branch")
        if bid is None:  # the branch the staff member works in, else the center's default branch
            bid = p.scope_branch_id if p.scope_branch_id is not None else await default_branch(conn, p.org_id)
        fee = body.monthly_fee
        if fee is None:  # the branch's own price of the course, else the course's default fee
            fee = await price_for_new_group(conn, bid, cid)
        row = await fetch_one(
            conn,
            "INSERT INTO study_groups (org_id, branch_id, course_id, teacher_id, name, monthly_fee, capacity, start_date, end_date, status, "
            "billing_mode, package_lessons, package_price) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                bid,
                cid,
                tid,
                body.name,
                fee,
                body.capacity,
                body.start_date,
                body.end_date,
                body.status,
                body.billing_mode,
                body.package_lessons,
                body.package_price,
            ),
        )
        assert row is not None
        return await _group_detail(conn, row["id"])


@router.get("/groups", response_model=Page[GroupOut])
async def list_groups(
    p: Annotated[Principal, Depends(require("academics:read"))],
    db: DB,
    pg: Paging,
    status: GroupStatus | None = None,
    course_id: uuid.UUID | None = None,
    teacher_id: uuid.UUID | None = None,
    q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
) -> Page[GroupOut]:
    where: list[str] = ["g.deleted_at IS NULL"]
    params: list[Any] = []
    if status:
        where.append("g.status = %s")
        params.append(status)
    if course_id:
        where.append("c.public_id = %s")
        params.append(course_id)
    if teacher_id:
        where.append("t.public_id = %s")
        params.append(teacher_id)
    if q:
        where.append("g.name ILIKE %s")
        params.append(like_pattern(q))
    async with db.tx(p.session()) as conn:
        if p.role == "teacher":
            where.append("g.teacher_id = %s")
            params.append(await my_teacher_id(conn, p) or -1)
        rows = await fetch_all(
            conn,
            f"{_GROUP_SQL} WHERE {' AND '.join(where)} ORDER BY lower(g.name), g.id LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, GroupOut)


@router.get("/groups/{group_id}", response_model=GroupDetail)
async def get_group(
    group_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:read"))], db: DB
) -> GroupDetail:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        await assert_group_access(conn, p, gid)
        return await _group_detail(conn, gid)


@router.patch("/groups/{group_id}", response_model=GroupDetail)
async def patch_group(
    group_id: uuid.UUID,
    body: GroupPatch,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> GroupDetail:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        if "teacher_id" in changes:
            changes["teacher_id"] = await resolve_opt(conn, "teachers", changes["teacher_id"], what="teacher")
        if "branch_id" in changes:
            changes["branch_id"] = await resolve_opt(conn, "branches", changes["branch_id"], what="branch")
        if changes.get("capacity") is not None:
            cur = await fetch_one(
                conn,
                "SELECT count(*) AS n FROM enrollments WHERE group_id = %s AND status IN ('trial', 'active')",
                (gid,),
            )
            assert cur is not None
            if cur["n"] > changes["capacity"]:
                raise Conflict("Capacity is below the current number of active students")
        if {"billing_mode", "package_lessons", "package_price"} & changes.keys():
            cur_billing = await fetch_one(
                conn,
                "SELECT billing_mode, package_lessons, package_price FROM study_groups WHERE id = %s",
                (gid,),
            )
            assert cur_billing is not None
            mode = changes.get("billing_mode", cur_billing["billing_mode"])
            if mode == "monthly" and changes.get("billing_mode") == "monthly":
                changes.setdefault(
                    "package_lessons", None
                )  # switching back to monthly drops the package fields
                changes.setdefault("package_price", None)
            msg = billing_shape_error(
                mode,
                changes.get("package_lessons", cur_billing["package_lessons"]),
                changes.get("package_price", cur_billing["package_price"]),
            )
            if msg is not None:
                raise Unprocessable(msg)
            changes["billing_mode"] = mode
        await patch_row(conn, "study_groups", gid, changes)
        return await _group_detail(conn, gid)


@router.delete(
    "/groups/{group_id}", response_model=Message, summary="Soft-delete a group without open enrollments"
)
async def delete_group(
    group_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> Message:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        n = await fetch_one(
            conn,
            "SELECT count(*) AS n FROM enrollments WHERE group_id = %s AND status IN ('active','frozen')",
            (gid,),
        )
        assert n is not None
        if n["n"]:
            raise Conflict("Group still has open enrollments")
        await execute(conn, "UPDATE study_groups SET deleted_at = now() WHERE id = %s", (gid,))
    return Message(message="group deleted")


@router.put(
    "/groups/{group_id}/schedule", response_model=ScheduleSaved, summary="Replace the weekly schedule"
)
async def put_schedule(
    group_id: uuid.UUID,
    body: list[ScheduleSlot],
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
    allow_conflict: Annotated[bool, Query(description="save although a room or the teacher is busy")] = False,
) -> ScheduleSaved:
    if len({(s.weekday, s.start_time) for s in body}) != len(body):
        raise Unprocessable("Duplicate weekday/start_time slots")
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        slots: list[tuple[int, time, time, int | None]] = []
        for s in body:
            slots.append(
                (
                    s.weekday,
                    s.start_time,
                    s.end_time,
                    await resolve_opt(conn, "rooms", s.room_id, what="room"),
                )
            )
        teacher = await fetch_one(conn, "SELECT teacher_id FROM study_groups WHERE id = %s", (gid,))
        assert teacher is not None
        # a group's own slots must not overlap each other when they share the room or the teacher
        for i, a in enumerate(slots):
            for b in slots[i + 1 :]:
                if (
                    a[0] == b[0]
                    and a[1] < b[2]
                    and b[1] < a[2]
                    and (teacher["teacher_id"] is not None or (a[3] is not None and a[3] == b[3]))
                ):
                    raise Unprocessable("The group's own weekly slots overlap")
        check = await weekly_check(conn, group_id=gid, teacher_id=teacher["teacher_id"], slots=slots)
        if check.conflicts and not allow_conflict:
            raise ScheduleConflict(
                "A room or the teacher is already busy in the weekly schedule (pass allow_conflict=true to save anyway)",
                details={"conflicts": check.conflicts},
            )
        await execute(conn, "DELETE FROM group_schedules WHERE group_id = %s", (gid,))
        for weekday, start, end, rid in slots:
            await execute(
                conn,
                "INSERT INTO group_schedules (org_id, group_id, weekday, start_time, end_time, room_id) VALUES (%s, %s, %s, %s, %s, %s)",
                (p.org_id, gid, weekday, start, end, rid),
            )
        detail = await _group_detail(conn, gid)
        return ScheduleSaved(
            **detail.model_dump(), conflicts=check.conflicts, capacity_warnings=check.capacity
        )


# ---- enrollments ---------------------------------------------------------------------------------------------
EnrollStatus = Literal["active", "frozen", "finished"]
EnrollStatusFilter = Literal["trial", "active", "frozen", "finished"]


class EnrollmentIn(Model):
    student_id: uuid.UUID
    started_on: date
    status: Literal["trial", "active"] = "active"
    monthly_fee_override: Money | None = None
    discount_percent: Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)] = Decimal(0)
    ignore_waitlist: bool = Field(
        default=False,
        description="owner override: take a free seat although waiting students are entitled to it",
    )


class EnrollmentPatch(Model):
    status: EnrollStatus | None = None
    ended_on: date | None = None
    monthly_fee_override: Money | None = None
    discount_percent: Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)] | None = None


class EnrollmentOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_id: uuid.UUID
    group_name: str
    started_on: date
    ended_on: date | None
    status: str
    monthly_fee_override: Dec2 | None
    discount_percent: Dec2
    effective_monthly_fee: Dec2
    accepted_on: date | None
    first_month_mode: str | None
    created_at: datetime


_ENR_SQL = (
    "SELECT e.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, g.public_id AS group_id, g.name AS group_name,"
    " e.started_on, e.ended_on, e.status, e.monthly_fee_override, e.discount_percent, e.created_at, e.accepted_on, e.first_month_mode,"
    " round(COALESCE(e.monthly_fee_override, g.monthly_fee) * (1 - e.discount_percent / 100), 2) AS effective_monthly_fee "
    "FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
    "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id"
)


async def seat_counts(conn: Conn, group_id: int) -> tuple[int, int]:
    """(occupied seats, waiting students) of a group. Trials count as seats; a frozen student holds none."""
    row = await fetch_one(
        conn,
        "SELECT (SELECT count(*) FROM enrollments WHERE group_id = %s AND status IN ('trial', 'active')) AS occupied, "
        "(SELECT count(*) FROM waitlist_entries WHERE group_id = %s AND status = 'waiting') AS waiting",
        (group_id, group_id),
    )
    assert row is not None
    return int(row["occupied"]), int(row["waiting"])


async def insert_enrollment(
    conn: Conn,
    *,
    org_id: int,
    student_id: int,
    group_id: int,
    started_on: date,
    status: Literal["trial", "active"] = "active",
    monthly_fee_override: Decimal | None = None,
    discount_percent: Decimal = Decimal(0),
    ignore_waitlist: bool = False,
) -> int:
    """Seat check and insert; the group row is locked so that concurrent enrollments are serialised.

    Rules (`rules/capacity.py`, golden-tested): trials count as seats; a student who waits for this group may take a free
    seat only when first in line; anybody else needs a free seat that no waiting student is entitled to (override:
    `ignore_waitlist`). A waiting entry of the enrolled student is closed with the new enrollment."""
    grp = await fetch_one(
        conn, "SELECT capacity, status FROM study_groups WHERE id = %s FOR UPDATE", (group_id,)
    )
    assert grp is not None
    if grp["status"] in ("finished", "cancelled"):
        raise Conflict(f"Group is {grp['status']}")
    own = await fetch_one(
        conn,
        "SELECT id, joined_at FROM waitlist_entries WHERE group_id = %s AND student_id = %s AND status = 'waiting'",
        (group_id, student_id),
    )
    capacity = grp["capacity"]
    if capacity is not None:
        occupied, waiting = await seat_counts(conn, group_id)
        details = {"capacity": capacity, "occupied": occupied, "waiting": waiting}
        if own is not None:
            ahead = await fetch_one(
                conn,
                "SELECT count(*) AS n FROM waitlist_entries WHERE group_id = %s AND status = 'waiting' "
                "AND (joined_at, id) <= (%s, %s)",
                (group_id, own["joined_at"], own["id"]),
            )
            assert ahead is not None
            if not seats.can_enroll_from_waitlist(
                capacity=capacity, occupied=occupied, position=int(ahead["n"])
            ):
                raise GroupFull("No seat for this place in the waiting list yet", details=details)
        elif not seats.direct_enroll_allowed(
            capacity=capacity, occupied=occupied, waiting=waiting, ignore_waitlist=ignore_waitlist
        ):
            msg = (
                "Group is full; add the student to its waiting list"
                if occupied >= capacity
                else "Free seats are reserved for the waiting list"
            )
            raise GroupFull(msg, details=details)
    row = await fetch_one(
        conn,
        "INSERT INTO enrollments (org_id, student_id, group_id, started_on, monthly_fee_override, discount_percent, status) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (org_id, student_id, group_id, started_on, monthly_fee_override, discount_percent, status),
    )
    assert row is not None
    if own is not None:
        await execute(
            conn,
            "UPDATE waitlist_entries SET status = 'enrolled', resolved_at = now(), enrollment_id = %s WHERE id = %s",
            (row["id"], own["id"]),
        )
    return int(row["id"])


@router.post("/groups/{group_id}/enrollments", response_model=EnrollmentOut, status_code=201)
async def enroll(
    group_id: uuid.UUID,
    body: EnrollmentIn,
    p: Annotated[Principal, Depends(require("academics:write", "students:read"))],
    db: DB,
) -> EnrollmentOut:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        sid = await resolve(conn, "students", body.student_id, what="student")
        eid = await insert_enrollment(
            conn,
            org_id=p.org_id,
            student_id=sid,
            group_id=gid,
            started_on=body.started_on,
            status=body.status,
            monthly_fee_override=body.monthly_fee_override,
            discount_percent=body.discount_percent,
            ignore_waitlist=body.ignore_waitlist,
        )
        out = await fetch_one(conn, f"{_ENR_SQL} WHERE e.id = %s", (eid,))
    assert out is not None
    return EnrollmentOut.model_validate(out)


@router.get(
    "/groups/{group_id}/enrollments", response_model=Page[EnrollmentOut], summary="Members of a group"
)
async def group_members(
    group_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("academics:read"))],
    db: DB,
    pg: Paging,
    status: EnrollStatusFilter | None = "active",
) -> Page[EnrollmentOut]:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        await assert_group_access(conn, p, gid)
        rows = await fetch_all(
            conn,
            f"{_ENR_SQL} WHERE e.group_id = %s AND (%s::text IS NULL OR e.status = %s) "
            "ORDER BY lower(s.full_name), e.id LIMIT %s OFFSET %s",
            (gid, status, status, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, EnrollmentOut)


@router.get("/students/{student_id}/enrollments", response_model=list[EnrollmentOut])
async def student_enrollments(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:read"))], db: DB
) -> list[EnrollmentOut]:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        rows = await fetch_all(
            conn, f"{_ENR_SQL} WHERE e.student_id = %s ORDER BY e.started_on DESC, e.id DESC", (sid,)
        )
    return [EnrollmentOut.model_validate(r) for r in rows]


@router.get("/enrollments/{enrollment_id}", response_model=EnrollmentOut)
async def get_enrollment(
    enrollment_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("academics:read", "students:read"))],
    db: DB,
) -> EnrollmentOut:
    async with db.tx(p.session()) as conn:
        eid = await resolve(conn, "enrollments", enrollment_id, what="enrollment")
        out = await fetch_one(conn, f"{_ENR_SQL} WHERE e.id = %s", (eid,))
    assert out is not None
    return EnrollmentOut.model_validate(out)


@router.patch("/enrollments/{enrollment_id}", response_model=EnrollmentOut)
async def patch_enrollment(
    enrollment_id: uuid.UUID,
    body: EnrollmentPatch,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> EnrollmentOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        eid = await resolve(conn, "enrollments", enrollment_id, what="enrollment")
        cur = await fetch_one(
            conn,
            "SELECT status, started_on, ended_on, group_id FROM enrollments WHERE id = %s FOR UPDATE",
            (eid,),
        )
        assert cur is not None
        if (
            changes.get("status") == "finished"
            and changes.get("ended_on") is None
            and cur["ended_on"] is None
        ):
            changes["ended_on"] = await org_today(conn)
        if cur["status"] == "trial" and changes.get("status") is not None:
            raise Conflict("A trial is accepted or dropped through /accept and /drop")
        if changes.get("status") == "active" and cur["status"] == "finished":
            raise Conflict("A finished enrollment cannot be reopened; enroll the student again")
        if changes.get("status") == "active" and cur["status"] == "frozen":
            # a frozen student holds no seat: coming back needs a free one (the group row is locked like at enrollment)
            grp = await fetch_one(
                conn, "SELECT capacity FROM study_groups WHERE id = %s FOR UPDATE", (cur["group_id"],)
            )
            assert grp is not None
            if grp["capacity"] is not None:
                occupied, waiting = await seat_counts(conn, cur["group_id"])
                if seats.free_seats(grp["capacity"], occupied) == 0:
                    raise GroupFull(
                        "Group is full; the frozen student cannot return yet",
                        details={"capacity": grp["capacity"], "occupied": occupied, "waiting": waiting},
                    )
        await patch_row(conn, "enrollments", eid, changes)
        out = await fetch_one(conn, f"{_ENR_SQL} WHERE e.id = %s", (eid,))
    assert out is not None
    return EnrollmentOut.model_validate(out)


_ = Any
