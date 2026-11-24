"""Cross-tenant attacks. Center B (a legitimate logged-in owner) tries to read, change or delete everything of center A.

Two layers are attacked separately:
 * the database: raw SQL as the application role with center B's session contract, over EVERY table with an org_id;
 * the HTTP API: every GET route is called with A's real ids, every PATCH/DELETE route likewise, and A's data must be
   byte-for-byte unchanged afterwards.
The seed deliberately touches every area (people, groups, schedule, money, accounting, documents, growth, results, guardian,
teacher, AI, branches) so the crawler has something real to protect."""

from __future__ import annotations

import json
import re
import uuid
from datetime import timedelta
from typing import Any

import httpx
import psycopg
import pytest

from tests.conftest import Tenant, make_tenant
from tests.e2e.journeys import TODAY, api_routes, pay
from tests.helpers import consent, enroll, mk_course, mk_group, mk_guardian, mk_student, mk_teacher, ok
from tests.test_branches import mk_branch
from tests.test_growth import campaign
from tests.test_schedule import mk_lesson, mk_room


# ---- a seed that touches every area of center A ----------------------------------------------------------------
async def seed_everything(t: Tenant, client: httpx.AsyncClient) -> dict[str, Any]:
    ids: dict[str, Any] = {}
    course = await mk_course(t, fee="400000")
    teacher = await mk_teacher(t)
    room = await mk_room(t, "Secret room")
    group = await mk_group(t, course["id"], teacher["id"], monthly_fee="400000", name="Secret group")
    await ok(
        await t.put(
            f"/v1/groups/{group['id']}/schedule",
            [{"weekday": 1, "start_time": "10:00:00", "end_time": "11:00:00"}],
        )
    )
    student = await mk_student(t, "Secret Student")
    guardian = await mk_guardian(t, "Secret Guardian")
    await ok(
        await t.post(
            f"/v1/students/{student['id']}/guardians", {"guardian_id": guardian["id"], "relation": "mother"}
        ),
        201,
    )
    await consent(t, student["id"], "notifications", guardian["id"])
    enr = await enroll(t, group["id"], student["id"], "2026-01-01")
    lesson = await mk_lesson(t, group["id"], "2026-12-07", room_id=room["id"])
    await ok(
        await t.put(
            f"/v1/lessons/{lesson['id']}/attendance",
            {"records": [{"student_id": student["id"], "status": "present"}]},
        )
    )
    charge = await ok(
        await t.post(
            "/v1/charges",
            {
                "student_id": student["id"],
                "kind": "tuition",
                "period_month": "2026-01-01",
                "amount": "400000",
                "due_date": TODAY.isoformat(),
            },
        ),
        201,
    )
    payment = await pay(t, student["id"], "150000")
    expense = await ok(
        await t.post("/v1/expenses", {"category": "rent", "amount": "50000", "spent_at": TODAY.isoformat()}),
        201,
    )
    await ok(await t.post("/v1/documents/receipts", {"payment_id": payment["id"]}), 201)
    src = await ok(await t.post("/v1/lead-sources", {"name": "Secret source"}), 201)
    lead = await ok(await t.post("/v1/leads", {"full_name": "Secret Lead", "source_id": src["id"]}), 201)
    promo = await campaign(t, code="SECRET50")
    exam = await ok(
        await t.post(
            f"/v1/groups/{group['id']}/exams",
            {"title": "Secret exam", "held_on": "2026-11-10", "max_score": "40"},
        ),
        201,
    )
    branch = await mk_branch(t, "Secret branch")
    await ok(await t.post("/v1/guardian/codes", {"student_id": student["id"]}), 201)
    await ok(await t.post("/v1/ai/reports", {"kind": "weekly_summary"}), 201)
    await ok(await t.post(f"/v1/teachers/{teacher['id']}/invitations"), 201)
    await ok(
        await t.put(
            "/v1/referral-program",
            {"reward_type": "percent", "reward_value": "10", "condition": "paid", "min_paid": "0"},
        )
    )
    await ok(await t.post("/v1/accounting/suppliers", {"name": "Secret supplier"}), 201)
    ids.update(
        course=course,
        teacher=teacher,
        room=room,
        group=group,
        student=student,
        guardian=guardian,
        enrollment=enr,
        lesson=lesson,
        charge=charge,
        payment=payment,
        expense=expense,
        lead=lead,
        promo=promo,
        exam=exam,
        branch=branch,
        source=src,
    )
    return ids


def flat_ids(node: Any, out: set[str]) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and (k == "id" or k.endswith("_id")) and re.fullmatch(r"[0-9a-f-]{36}", v):
                out.add(v)
            else:
                flat_ids(v, out)
    elif isinstance(node, list):
        for v in node:
            flat_ids(v, out)


async def snapshot(t: Tenant, paths: list[str]) -> dict[str, str]:
    snap: dict[str, str] = {}
    for p in paths:
        r = await t.get(p, params={"limit": 200})
        snap[p] = r.text if r.status_code == 200 else f"{r.status_code}"
    return snap


def listing_paths(app: Any) -> list[str]:
    """Every parameterless GET route of /v1 that a staff member can list."""
    return sorted({p for m, p in api_routes(app) if m == "GET" and p.startswith("/v1/") and "{" not in p})


SKIP_LIST = {"/v1/auth/", "/v1/cabinet/", "/v1/me", "/v1/verify/", "/v1/teacher/", "/v1/demo", "/v1/health"}


def attackable(path: str) -> bool:
    return not any(path.startswith(s) for s in SKIP_LIST)


# ---- the database layer ----------------------------------------------------------------------------------------
async def test_database_rls_holds_for_every_table_under_the_application_role(
    client: httpx.AsyncClient, pg_server: dict[str, Any], super_dsn: str
) -> None:
    a = await make_tenant(client, "rls-a")
    b = await make_tenant(client, "rls-b")
    await seed_everything(a, client)
    await mk_student(b, "B's only student")
    with psycopg.connect(super_dsn) as c:
        org_b = c.execute("SELECT id FROM organizations WHERE public_id = %s", (b.org_id,)).fetchone()
        assert org_b is not None
        tables = [
            r[0]
            for r in c.execute(
                "SELECT c.table_name FROM information_schema.columns c JOIN pg_class p ON p.relname = c.table_name "
                "JOIN pg_namespace n ON n.oid = p.relnamespace AND n.nspname = 'public' "
                "WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND p.relkind = 'r' ORDER BY 1"
            )
        ]
        no_rls = [
            t
            for t in tables
            if not c.execute("SELECT relrowsecurity FROM pg_class WHERE relname = %s", (t,)).fetchone()[0]
        ]  # type: ignore[index]
        bypass = c.execute("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'nazoratly_app'").fetchone()
    assert len(tables) > 40
    assert no_rls == [], f"tables with an org_id but without row-level security: {no_rls}"
    assert bypass == (False,)

    leaked: dict[str, int] = {}
    mutated: dict[str, int] = {}
    with psycopg.connect(pg_server["app"], autocommit=False) as conn:
        for table in tables:
            conn.execute("SELECT set_config('app.org_id', %s, true)", (str(org_b[0]),))
            n = conn.execute(f'SELECT count(*) FROM "{table}" WHERE org_id <> %s', (org_b[0],)).fetchone()  # type: ignore[arg-type]
            if n and n[0]:
                leaked[table] = n[0]
            conn.rollback()
            # nothing of another center can be changed or deleted either (immutable tables raise only on a matching row)
            for stmt in (
                f'UPDATE "{table}" SET org_id = org_id WHERE org_id <> %s',
                f'DELETE FROM "{table}" WHERE org_id <> %s',
            ):
                conn.execute("SELECT set_config('app.org_id', %s, true)", (str(org_b[0]),))
                try:
                    cur = conn.execute(stmt, (org_b[0],))  # type: ignore[arg-type]
                    if cur.rowcount:
                        mutated[table] = cur.rowcount
                except psycopg.Error:
                    pass  # a privilege or trigger refusal is also a refusal
                conn.rollback()
            # no tenant at all: nothing is visible
            conn.execute("SELECT set_config('app.org_id', '', true)")
            try:
                none = conn.execute(f'SELECT count(*) FROM "{table}"').fetchone()
                if none and none[0]:
                    leaked[f"{table} (no org)"] = none[0]
            except psycopg.Error:
                pass
            conn.rollback()
    assert leaked == {}, leaked
    assert mutated == {}, mutated


# ---- the API layer -----------------------------------------------------------------------------------------------
async def test_api_attack_from_another_center_reads_and_changes_nothing(
    client: httpx.AsyncClient, app: Any
) -> None:
    a = await make_tenant(client, "atk-a")
    b = await make_tenant(client, "atk-b")
    seeded = await seed_everything(a, client)
    mine = await mk_student(b, "B's student")
    await mk_group(b, name="B group")

    # harvest A's real ids from every list endpoint of A
    paths = [p for p in listing_paths(app) if attackable(p)]
    a_ids: set[str] = set()
    a_by_collection: dict[str, list[str]] = {}
    for p in paths:
        r = await a.get(p, params={"limit": 200})
        if r.status_code != 200:
            continue
        found: set[str] = set()
        flat_ids(r.json(), found)
        a_by_collection[p] = sorted(found)
        a_ids |= found
    assert len(a_ids) > 40, "the seed should produce many ids"
    for key in ("student", "group", "charge", "payment", "lead", "lesson"):
        assert seeded[key]["id"] in a_ids, key

    # 1. B's own lists never contain an id of A
    for p in paths:
        r = await b.get(p, params={"limit": 200})
        if r.status_code != 200:
            continue
        leak = {i for i in a_ids if i in r.text}
        assert not leak, f"{p} leaked ids of another center: {sorted(leak)[:3]}"

    # 2. every GET/PATCH/DELETE route with one id parameter, hit with A's ids of that resource, must refuse
    before = await snapshot(a, paths)
    attempts = 0
    problems: list[str] = []
    by_path: dict[str, set[str]] = {}
    for m, p in api_routes(app):
        by_path.setdefault(p, set()).add(m)
    for path, methods in by_path.items():
        params = re.findall(r"\{(\w+)\}", path)
        if not path.startswith("/v1/") or not attackable(path) or len(params) != 1:
            continue
        collection = path.split("{")[0].rstrip("/")
        pool = a_by_collection.get(collection) or a_by_collection.get(collection + "/", [])
        if not pool or not re.fullmatch(r"[0-9a-f-]{36}", pool[0]):
            continue
        for method in sorted(methods):
            if method not in {"GET", "PATCH", "DELETE", "POST", "PUT"}:
                continue
            url = path.replace("{" + params[0] + "}", pool[0])
            tail = url.split(pool[0], 1)[1]
            if method == "GET" and "pdf" in tail:
                pass
            body = {} if method in {"POST", "PATCH", "PUT"} else None
            r = await b.client.request(method, url, headers=b.h, json=body)
            attempts += 1
            if r.status_code < 400 or r.status_code not in (400, 401, 403, 404, 405, 409, 422):
                problems.append(f"{method} {path} -> {r.status_code}")
            elif r.status_code == 409:
                problems.append(f"{method} {path} -> 409 (existence leak?)")
    assert attempts > 60, attempts
    assert problems == [], problems

    # 3. A's data is byte-for-byte what it was
    assert await snapshot(a, paths) == before
    assert mine["id"] not in json.dumps(before)


async def test_a_logged_in_owner_cannot_use_another_centers_id_in_a_body(
    client: httpx.AsyncClient,
) -> None:
    """Foreign ids smuggled into request bodies (foreign keys of a create) are refused as not found, never accepted."""
    a = await make_tenant(client, "body-a")
    b = await make_tenant(client, "body-b")
    foreign_student = await mk_student(a, "A student")
    foreign_group = await mk_group(a)
    foreign_course = await mk_course(a)
    bad = str(uuid.uuid4())
    mine_group = await mk_group(b)
    mine_student = await mk_student(b, "B student")
    attempts = [
        ("/v1/payments", {"student_id": foreign_student["id"], "amount": "1000", "method": "cash"}),
        (
            "/v1/charges",
            {
                "student_id": foreign_student["id"],
                "kind": "tuition",
                "period_month": TODAY.isoformat(),
                "amount": "1",
                "due_date": TODAY.isoformat(),
            },
        ),
        (
            f"/v1/groups/{foreign_group['id']}/enrollments",
            {"student_id": mine_student["id"], "started_on": "2026-01-01"},
        ),
        (
            f"/v1/groups/{mine_group['id']}/enrollments",
            {"student_id": foreign_student["id"], "started_on": "2026-01-01"},
        ),
        (
            "/v1/groups",
            {"course_id": foreign_course["id"], "name": "x", "start_date": "2026-01-01", "status": "active"},
        ),
        (
            "/v1/lessons",
            {
                "group_id": foreign_group["id"],
                "lesson_date": (TODAY + timedelta(days=3)).isoformat(),
                "start_time": "10:00",
                "end_time": "11:00",
            },
        ),
        (
            f"/v1/students/{foreign_student['id']}/consents",
            {"purpose": "notifications", "policy_version": "1", "given_by_self": True},
        ),
        (
            "/v1/discounts",
            {
                "student_id": foreign_student["id"],
                "kind": "individual",
                "percent": "10",
                "reason": "attack attempt",
            },
        ),
        (
            "/v1/refunds",
            {
                "kind": "to_credit",
                "student_id": foreign_student["id"],
                "charge_id": bad,
                "amount": "1",
                "payout": "credit",
                "reason": "attack attempt",
            },
        ),
    ]
    for url, body in attempts:
        r = await b.post(url, body)
        assert r.status_code in (404, 422), (url, r.status_code, r.text)
        assert r.status_code != 201
    # nothing of A changed
    assert (await ok(await a.get(f"/v1/students/{foreign_student['id']}")))["consents"] == []
    assert (await ok(await a.get("/v1/payments")))["items"] == []
    pytest.importorskip("psycopg")
