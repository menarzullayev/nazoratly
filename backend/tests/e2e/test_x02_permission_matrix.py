"""Role x endpoint matrix. The expectations below are written by hand from docs/API.md ("Rollar va ruxsatlar"), NOT derived from
the code under test, so a permission that drifts in permissions.py or a router is caught. Each role calls each endpoint with a
random id and an empty body: 403 means refused by the role, anything else means the role got past the permission check
(a 404/422 is "allowed, but nothing there").

A second test sweeps EVERY write route of the API as the two least privileged staff roles: they never succeed and never
crash the server."""

from __future__ import annotations

import re
import uuid
from typing import Any

import httpx
import pytest

from tests.conftest import Tenant
from tests.e2e.journeys import api_routes
from tests.test_tenancy_and_staff import _add_staff, _login

ALL = {"owner", "admin", "manager", "accountant", "teacher", "viewer"}
OFFICE = {"owner", "admin", "manager", "accountant"}
WRITE_STUDENTS = {"owner", "admin", "manager"}
ID = "00000000-0000-4000-8000-000000000001"

# (method, path, roles that pass the permission check)
MATRIX: list[tuple[str, str, set[str]]] = [
    ("GET", "/v1/organization", ALL),
    ("PATCH", "/v1/organization", {"owner"}),
    ("GET", "/v1/staff", {"owner", "admin", "manager"}),
    ("POST", "/v1/staff", {"owner", "admin"}),
    ("POST", "/v1/branches", {"owner", "admin"}),
    ("GET", "/v1/students", {"owner", "admin", "manager", "accountant", "viewer"}),
    ("POST", "/v1/students", WRITE_STUDENTS),
    ("GET", "/v1/guardians", {"owner", "admin", "manager", "accountant", "viewer"}),
    ("POST", "/v1/guardians", WRITE_STUDENTS),
    ("GET", "/v1/groups", ALL),
    ("POST", "/v1/groups", WRITE_STUDENTS),
    ("POST", "/v1/courses", WRITE_STUDENTS),
    ("POST", "/v1/teachers", WRITE_STUDENTS),
    ("PUT", f"/v1/lessons/{ID}/attendance", {"owner", "admin", "manager", "teacher"}),
    ("GET", "/v1/payments", OFFICE),
    ("POST", "/v1/payments", OFFICE),
    ("POST", f"/v1/payments/{ID}/void", OFFICE),
    ("GET", "/v1/charges", OFFICE),
    ("POST", "/v1/charges", OFFICE),
    ("POST", "/v1/charges/generate", OFFICE),
    ("POST", "/v1/discounts", OFFICE),
    ("POST", "/v1/refunds", OFFICE),
    ("POST", "/v1/cash-close", OFFICE),
    ("GET", "/v1/reports/debtors", OFFICE),
    ("GET", "/v1/reports/summary", {"owner", "admin", "manager", "accountant", "viewer"}),
    ("GET", "/v1/dashboard", {"owner", "admin", "manager", "accountant", "viewer"}),
    ("POST", "/v1/expenses", {"owner", "admin", "accountant"}),
    ("GET", "/v1/payrolls", {"owner", "admin", "accountant"}),
    ("POST", "/v1/payrolls/generate", {"owner", "admin", "accountant"}),
    ("POST", f"/v1/payrolls/{ID}/approve", {"owner", "admin"}),
    ("GET", "/v1/accounting/entries", OFFICE),
    ("POST", "/v1/accounting/entries", {"owner", "admin", "accountant"}),
    ("POST", "/v1/accounting/periods/2026-01/close", {"owner", "admin"}),
    ("GET", "/v1/accounting/verify", OFFICE),
    ("GET", "/v1/audit", {"owner", "admin"}),
    ("POST", "/v1/agents", {"owner", "admin"}),
    (
        "GET",
        "/v1/outbox",
        {"owner", "admin", "manager", "accountant", "viewer"},
    ),  # students:read, like the student list
    ("PUT", "/v1/marks", {"owner", "admin", "manager", "teacher"}),
    ("POST", "/v1/certificates", {"owner", "admin", "manager"}),
    ("POST", "/v1/guardian/codes", {"owner", "admin", "manager"}),
    ("POST", "/v1/ai/reports", {"owner", "admin", "manager", "accountant", "viewer"}),
    ("POST", f"/v1/teachers/{ID}/invitations", {"owner", "admin"}),
]


@pytest.fixture
async def staff_by_role(client: httpx.AsyncClient, tenant: Tenant) -> dict[str, Tenant]:
    out = {"owner": tenant}
    for role in ("admin", "manager", "accountant", "teacher", "viewer"):
        _, email = await _add_staff(tenant, role)
        out[role] = await _login(client, email, "staff-password-123")
    return out


async def call(t: Tenant, method: str, path: str) -> httpx.Response:
    body = {} if method in {"POST", "PUT", "PATCH"} else None
    return await t.client.request(method, path, headers=t.h, json=body)


async def test_hand_written_matrix(staff_by_role: dict[str, Tenant]) -> None:
    wrong: list[str] = []
    for method, path, allowed in MATRIX:
        for role, who in staff_by_role.items():
            r = await call(who, method, path)
            passed = r.status_code != 403
            assert r.status_code < 500, (role, method, path, r.status_code, r.text)
            if passed != (role in allowed):
                wrong.append(
                    f"{role:10} {method:6} {path} -> {r.status_code} (expected {'allowed' if role in allowed else '403'})"
                )
    assert wrong == [], "\n" + "\n".join(wrong)


def write_routes(app: Any) -> list[tuple[str, str]]:
    return [(m, p) for m, p in api_routes(app) if p.startswith("/v1/") and m != "GET"]


# write routes that a read-only role may legitimately reach (own account, public, or an actor-less form)
PUBLIC_OR_OWN = re.compile(r"^/v1/(auth/|me/|me$|cabinet/|verify/|waitlist/offers|ai/reports$)")


async def test_read_only_and_teacher_roles_never_succeed_on_any_write_route(
    app: Any, staff_by_role: dict[str, Tenant]
) -> None:
    routes = write_routes(app)
    assert len(routes) > 150
    teacher_ok = re.compile(
        r"/v1/(lessons/[^/]+/attendance|attendance/scan|marks|exams/[^/]+/results|teacher/|notifications/)"
    )
    problems: list[str] = []
    for role in ("viewer", "teacher"):
        who = staff_by_role[role]
        for method, path in routes:
            if PUBLIC_OR_OWN.match(path):
                continue
            url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
            r = await call(who, method, url)
            if r.status_code >= 500:
                problems.append(f"{role} {method} {path} -> {r.status_code} CRASH")
            elif r.status_code < 400:
                problems.append(f"{role} {method} {path} -> {r.status_code} SUCCEEDED")
            elif role == "viewer" and r.status_code != 403 and not teacher_ok.search(path):
                problems.append(f"{role} {method} {path} -> {r.status_code} (not 403)")
    assert problems == [], "\n" + "\n".join(problems)
