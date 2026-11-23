"""Builders shared by tests (all go through the real HTTP API)."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from tests.conftest import Tenant

ORG_TZ = ZoneInfo("Asia/Tashkent")  # the default organizations.timezone; the server's "today" follows it


def org_today() -> date:
    """The organization's calendar date. Tests must not use date.today(): between 19:00 and 24:00 UTC the
    server date (Asia/Tashkent) is one day ahead of the machine date and date-sensitive assertions break."""
    return datetime.now(UTC).astimezone(ORG_TZ).date()


async def ok(r: Any, status: int = 200) -> Any:
    assert r.status_code == status, f"{r.request.method} {r.request.url} -> {r.status_code}: {r.text}"
    return r.json()


async def mk_student(t: Tenant, name: str | None = None, **kw: Any) -> dict[str, Any]:
    return await ok(
        await t.post("/v1/students", {"full_name": name or f"Student {uuid.uuid4().hex[:6]}", **kw}), 201
    )


async def mk_guardian(t: Tenant, name: str = "Parent One", phone: str | None = None) -> dict[str, Any]:
    phone = phone or f"+99890{uuid.uuid4().int % 10_000_000:07d}"
    return await ok(await t.post("/v1/guardians", {"full_name": name, "phone": phone}), 201)


async def mk_course(t: Tenant, name: str | None = None, fee: str = "500000.00") -> dict[str, Any]:
    return await ok(
        await t.post(
            "/v1/courses", {"name": name or f"Course {uuid.uuid4().hex[:6]}", "default_monthly_fee": fee}
        ),
        201,
    )


async def mk_teacher(t: Tenant, **kw: Any) -> dict[str, Any]:
    body = {
        "full_name": f"Teacher {uuid.uuid4().hex[:6]}",
        "pay_model": "per_lesson",
        "pay_rate": "100000",
        **kw,
    }
    return await ok(await t.post("/v1/teachers", body), 201)


async def mk_group(
    t: Tenant, course_id: str | None = None, teacher_id: str | None = None, **kw: Any
) -> dict[str, Any]:
    course_id = course_id or (await mk_course(t))["id"]
    body: dict[str, Any] = {
        "course_id": course_id,
        "name": f"Group {uuid.uuid4().hex[:6]}",
        "start_date": date(2026, 1, 1).isoformat(),
        "status": "active",
        **kw,
    }
    if teacher_id:
        body["teacher_id"] = teacher_id
    return await ok(await t.post("/v1/groups", body), 201)


async def enroll(
    t: Tenant, group_id: str, student_id: str, started_on: str = "2026-01-01", **kw: Any
) -> dict[str, Any]:
    return await ok(
        await t.post(
            f"/v1/groups/{group_id}/enrollments", {"student_id": student_id, "started_on": started_on, **kw}
        ),
        201,
    )


async def consent(t: Tenant, student_id: str, purpose: str, guardian_id: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"purpose": purpose, "policy_version": "2026-11"}
    if guardian_id:
        body["given_by_guardian_id"] = guardian_id
    else:
        body["given_by_self"] = True
    return await ok(await t.post(f"/v1/students/{student_id}/consents", body), 201)
