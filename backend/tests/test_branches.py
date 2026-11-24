"""Multi-branch (G6) through the real API: one center, one owner, one books, a branch mark on every row. Staff of a branch see
only their branch (row-level security), center-wide staff see the total or narrow the view with X-Branch; students move
between branches; cash, reports, prices and settings are per branch. The pure rules are the golden file
tests/golden/branches.json (test_golden_branches.py); the database layer is db/tests/test_schema.sql."""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import psycopg

from tests.conftest import Tenant
from tests.helpers import enroll, mk_course, mk_group, mk_student, ok, org_today
from tests.test_accounting import A, manual
from tests.test_tenancy_and_staff import _login

TODAY = org_today()
MONTH = TODAY.replace(day=1).isoformat()
PASSWORD = "staff-password-123"


async def mk_branch(t: Tenant, name: str | None = None) -> dict[str, Any]:
    return await ok(await t.post("/v1/branches", {"name": name or f"Filial {uuid.uuid4().hex[:6]}"}), 201)


async def default_branch(t: Tenant) -> dict[str, Any]:
    page = await ok(await t.get("/v1/branches"))
    (d,) = [b for b in page["items"] if b["is_default"]]
    return d


async def branch_staff(
    client: httpx.AsyncClient, owner: Tenant, branch_id: str, role: str = "admin"
) -> Tenant:
    """A staff member tied to one branch, logged in."""
    email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
    await ok(
        await owner.post(
            "/v1/staff",
            {
                "full_name": f"{role} of a branch",
                "email": email,
                "role": role,
                "branch_id": branch_id,
                "initial_password": PASSWORD,
            },
        ),
        201,
    )
    return await _login(client, email, PASSWORD)


def view(branch: dict[str, Any]) -> dict[str, str]:
    return {"X-Branch": branch["id"]}


async def pay(t: Tenant, student_id: str, amount: str = "100000", **kw: Any) -> dict[str, Any]:
    return await ok(
        await t.post("/v1/payments", {"student_id": student_id, "amount": amount, "method": "cash"}, **kw),
        201,
    )


async def sql(dsn: str, query: str, *args: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(dsn) as c:
        return c.execute(query, args).fetchall()  # type: ignore[arg-type]


# ---- the default branch and the view scope ----------------------------------------------------------------------
async def test_every_center_starts_with_one_default_branch(tenant: Tenant) -> None:
    page = await ok(await tenant.get("/v1/branches"))
    assert [(b["name"], b["is_default"], b["status"]) for b in page["items"]] == [
        ("Asosiy filial", True, "active")
    ]
    scope = await ok(await tenant.get("/v1/branch-scope"))
    assert scope["center_wide"] and scope["member_branch_id"] is None and scope["view_branch_id"] is None


async def test_center_wide_staff_can_narrow_the_view_with_x_branch(tenant: Tenant) -> None:
    b = await mk_branch(tenant)
    scope = await ok(await tenant.get("/v1/branch-scope", headers=view(b)))
    assert scope["view_branch_id"] == b["id"] and scope["view_branch_name"] == b["name"]
    assert (await tenant.get("/v1/branch-scope", headers={"X-Branch": str(uuid.uuid4())})).status_code == 404
    assert (await tenant.get("/v1/branch-scope", headers={"X-Branch": "not-a-uuid"})).status_code == 422


async def test_a_branch_of_another_center_is_not_reachable(tenant: Tenant, tenant_b: Tenant) -> None:
    other = await default_branch(tenant_b)
    assert (await tenant.get("/v1/students", headers=view(other))).status_code == 404


# ---- separation by branch ----------------------------------------------------------------------------------------
async def test_staff_of_a_branch_sees_only_its_branch(client: httpx.AsyncClient, tenant: Tenant) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    in_a = await mk_student(tenant, "Alisher A")
    in_b = await mk_student(tenant, "Bahrom B", branch_id=b["id"])
    assert in_a["branch_id"] == a["id"] and in_b["branch_id"] == b["id"]

    staff_b = await branch_staff(client, tenant, b["id"])
    names = [s["full_name"] for s in (await ok(await staff_b.get("/v1/students")))["items"]]
    assert names == ["Bahrom B"]
    assert (await staff_b.get(f"/v1/students/{in_a['id']}")).status_code == 404
    assert (await staff_b.patch(f"/v1/students/{in_a['id']}", {"notes": "x"})).status_code == 404
    mine = await ok(await staff_b.post("/v1/students", {"full_name": "Made in B"}), 201)
    assert mine["branch_id"] == b["id"]  # the session's branch is stamped
    assert (
        await staff_b.post("/v1/students", {"full_name": "Smuggled", "branch_id": a["id"]})
    ).status_code == 404

    # the owner sees both, narrowed to one branch only that one
    assert len((await ok(await tenant.get("/v1/students")))["items"]) == 3
    only_a = (await ok(await tenant.get("/v1/students", headers=view(a))))["items"]
    assert [s["full_name"] for s in only_a] == ["Alisher A"]


async def test_staff_of_a_branch_cannot_look_at_another_branch(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    staff_b = await branch_staff(client, tenant, b["id"])
    assert (await staff_b.get("/v1/students", headers=view(a))).status_code == 403
    assert (await staff_b.get("/v1/students", headers={"X-Branch": str(uuid.uuid4())})).status_code == 403
    own = await ok(await staff_b.get("/v1/branch-scope", headers=view(b)))
    assert not own["center_wide"] and own["view_branch_id"] == b["id"]
    # the branch list is its own branch only
    assert [x["id"] for x in (await ok(await staff_b.get("/v1/branches")))["items"]] == [b["id"]]


async def test_branch_administration_is_for_center_wide_staff(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    staff_b = await branch_staff(client, tenant, b["id"])
    assert (await staff_b.post("/v1/branches", {"name": "Hacker"})).status_code == 403
    assert (await staff_b.patch(f"/v1/branches/{b['id']}", {"name": "Renamed"})).status_code == 403
    assert (await staff_b.post(f"/v1/branches/{b['id']}/default")).status_code == 403
    assert (await staff_b.delete(f"/v1/branches/{b['id']}")).status_code == 403
    # the default branch can be neither closed nor deleted; swapping it works
    assert (await tenant.patch(f"/v1/branches/{a['id']}", {"status": "closed"})).status_code == 409
    assert (await tenant.delete(f"/v1/branches/{a['id']}")).status_code == 409
    await ok(await tenant.post(f"/v1/branches/{b['id']}/default"))
    assert (await default_branch(tenant))["id"] == b["id"]
    await ok(await tenant.patch(f"/v1/branches/{a['id']}", {"status": "closed"}))
    assert (await tenant.post(f"/v1/branches/{a['id']}/default")).status_code == 409  # closed


async def test_a_branch_with_people_in_it_cannot_be_deleted(tenant: Tenant) -> None:
    b = await mk_branch(tenant)
    await mk_student(tenant, branch_id=b["id"])
    r = await tenant.delete(f"/v1/branches/{b['id']}")
    assert r.status_code == 409 and r.json()["error"]["details"]["students"] == 1


async def test_staff_of_a_branch_adds_staff_only_to_its_own_branch(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    staff_b = await branch_staff(client, tenant, b["id"])
    body = {"full_name": "New teacher", "email": f"t-{uuid.uuid4().hex[:6]}@example.com", "role": "teacher",
            "initial_password": PASSWORD}  # fmt: skip
    r = await ok(await staff_b.post("/v1/staff", body), 201)
    assert r["branch_id"] == b["id"]  # never center-wide
    other = {**body, "email": f"u-{uuid.uuid4().hex[:6]}@example.com", "branch_id": a["id"]}
    assert (await staff_b.post("/v1/staff", other)).status_code in (403, 404)
    seen = [m["branch_id"] for m in (await ok(await staff_b.get("/v1/staff")))["items"]]
    assert seen and set(seen) == {b["id"]}  # the owner (center-wide) and other branches' staff are not listed
    assert (await staff_b.patch(f"/v1/staff/{r['id']}", {"branch_id": None})).status_code == 403


# ---- rows follow their branch ------------------------------------------------------------------------------------
async def test_groups_enrollments_and_money_follow_the_branch(tenant: Tenant, super_dsn: str) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    course = await mk_course(tenant, fee="300000")
    g_a = await mk_group(tenant, course["id"], monthly_fee="300000")
    g_b = await mk_group(tenant, course["id"], monthly_fee="200000", branch_id=b["id"])
    assert (g_a["branch_id"], g_b["branch_id"]) == (a["id"], b["id"])
    s_a = await mk_student(tenant, "A student")
    s_b = await mk_student(tenant, "B student", branch_id=b["id"])
    # a student cannot join a group of another branch (the move comes first)
    r = await tenant.post(
        f"/v1/groups/{g_b['id']}/enrollments", {"student_id": s_a["id"], "started_on": "2026-01-01"}
    )
    assert r.status_code == 422 and "different branches" in r.text
    await enroll(tenant, g_a["id"], s_a["id"])
    await enroll(tenant, g_b["id"], s_b["id"])
    gen = await ok(await tenant.post("/v1/charges/generate", {"month": MONTH}))
    assert gen["created"] == 2
    await pay(tenant, s_a["id"], "300000")
    await pay(tenant, s_b["id"], "120000")

    marks = dict(
        await sql(
            super_dsn,
            "SELECT s.public_id::text, br.public_id::text FROM students s JOIN branches br ON br.id = s.branch_id "
            "WHERE s.public_id = ANY(%s::uuid[])",
            [s_a["id"], s_b["id"]],
        )
    )
    assert marks == {s_a["id"]: a["id"], s_b["id"]: b["id"]}
    # every money row carries its branch: charges follow the enrollment, payments the student
    rows = await sql(
        super_dsn,
        "SELECT 'charge', br.public_id::text, c.amount FROM charges c JOIN branches br ON br.id = c.branch_id "
        "JOIN students s ON s.id = c.student_id WHERE s.public_id = ANY(%s::uuid[]) "
        "UNION ALL SELECT 'payment', br.public_id::text, p.amount FROM payments p JOIN branches br ON br.id = p.branch_id "
        "JOIN students s ON s.id = p.student_id WHERE s.public_id = ANY(%s::uuid[])",
        [s_a["id"], s_b["id"]],
        [s_a["id"], s_b["id"]],
    )
    got = {(k, br): str(amount) for k, br, amount in rows}
    assert got == {
        ("charge", a["id"]): "300000.00",
        ("charge", b["id"]): "200000.00",
        ("payment", a["id"]): "300000.00",
        ("payment", b["id"]): "120000.00",
    }


async def test_report_per_branch_and_total(client: httpx.AsyncClient, tenant: Tenant) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant, "Chilonzor")
    s_a = await mk_student(tenant, "A")
    s_b = await mk_student(tenant, "B", branch_id=b["id"])
    await pay(tenant, s_a["id"], "500000")
    await pay(tenant, s_b["id"], "150000")
    await ok(
        await tenant.post(
            "/v1/expenses",
            {"category": "rent", "amount": "50000", "spent_at": TODAY.isoformat(), "branch_id": b["id"]},
        ),
        201,
    )
    rep = await ok(await tenant.get("/v1/branch-report"))
    rows = {r["branch_id"]: r for r in rep["rows"]}
    assert (rows[a["id"]]["revenue"], rows[a["id"]]["expenses"], rows[a["id"]]["net"]) == (
        "500000.00",
        "0.00",
        "500000.00",
    )
    assert (rows[b["id"]]["revenue"], rows[b["id"]]["expenses"], rows[b["id"]]["net"]) == (
        "150000.00",
        "50000.00",
        "100000.00",
    )
    assert rows[a["id"]]["students_active"] == 1 and rows[b["id"]]["students_active"] == 1
    assert (
        rows[a["id"]]["cash_balance"] == "500000.00" and rows[b["id"]]["cash_balance"] == "100000.00"
    )  # rent paid from cash
    tot = rep["total"]
    assert tot["branch_id"] is None
    for key in ("revenue", "charges", "expenses", "net", "debt", "cash_balance"):
        assert sum(float(r[key]) for r in rep["rows"]) == float(tot[key]), key
    assert (tot["revenue"], tot["net"]) == ("650000.00", "600000.00")

    # staff of a branch get their own row and a total that is only theirs
    staff_b = await branch_staff(client, tenant, b["id"], "manager")
    mine = await ok(await staff_b.get("/v1/branch-report"))
    assert [r["branch_id"] for r in mine["rows"]] == [b["id"]]
    assert mine["total"]["revenue"] == "150000.00"


async def test_payments_and_expenses_lists_are_per_branch(client: httpx.AsyncClient, tenant: Tenant) -> None:
    b = await mk_branch(tenant)
    s_a = await mk_student(tenant)
    s_b = await mk_student(tenant, branch_id=b["id"])
    await pay(tenant, s_a["id"])
    await pay(tenant, s_b["id"], "70000")
    acc_b = await branch_staff(client, tenant, b["id"], "accountant")
    pays = (await ok(await acc_b.get("/v1/payments")))["items"]
    assert [p["amount"] for p in pays] == ["70000.00"]
    assert len((await ok(await tenant.get("/v1/payments")))["items"]) == 2
    # the accountant of branch B records a payment of its own student only
    assert (
        await acc_b.post("/v1/payments", {"student_id": s_a["id"], "amount": "1", "method": "cash"})
    ).status_code == 404
    spent = await ok(
        await acc_b.post(
            "/v1/expenses", {"category": "other", "amount": "1000", "spent_at": TODAY.isoformat()}
        ),
        201,
    )
    assert spent["branch_id"] == b["id"]


# ---- the ledger: one chain, branch views -------------------------------------------------------------------------
async def test_one_hash_chain_for_the_center_while_branches_write_and_read_separately(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    b = await mk_branch(tenant)
    acc_b = await branch_staff(client, tenant, b["id"], "accountant")
    s_a = await mk_student(tenant)
    s_b = await mk_student(tenant, branch_id=b["id"])
    await pay(tenant, s_a["id"], "100000")  # entries 1: branch A (posted by the owner)
    await pay(
        acc_b, s_b["id"], "40000"
    )  # entry 2: branch B (posted by its own accountant, continuing the chain)
    await manual(acc_b, TODAY.isoformat(), [("1000", "10", "0"), ("4000", "0", "10")], "B manual")
    await manual(tenant, TODAY.isoformat(), [("1000", "5", "0"), ("4000", "0", "5")], "A manual")

    chain = await ok(await tenant.get(f"{A}/verify"))
    assert chain["ok"] is True and chain["lines"] == 8
    own = (await ok(await acc_b.get(f"{A}/entries")))["items"]
    assert sorted(e["memo"] for e in own if e["memo"] in ("B manual", "A manual")) == ["B manual"]
    assert len(own) == 2  # its payment and its manual entry
    assert len((await ok(await tenant.get(f"{A}/entries")))["items"]) == 4
    narrowed = (await ok(await tenant.get(f"{A}/entries", headers=view(b))))["items"]
    assert len(narrowed) == 2
    # the chain is one per center: a branch cannot verify it or close a month
    assert (await acc_b.get(f"{A}/verify")).status_code == 403
    assert (await acc_b.post(f"{A}/periods/2020-01/close")).status_code in (403, 422)


async def test_reversal_stays_in_the_branch_of_the_entry(client: httpx.AsyncClient, tenant: Tenant) -> None:
    b = await mk_branch(tenant)
    acc_b = await branch_staff(client, tenant, b["id"], "accountant")
    s_b = await mk_student(tenant, branch_id=b["id"])
    p = await pay(acc_b, s_b["id"], "30000")
    await ok(await acc_b.post(f"/v1/payments/{p['id']}/void", {"reason": "mistake"}))
    own = (await ok(await acc_b.get(f"{A}/entries")))["items"]
    assert len(own) == 2  # the payment and its reversal, both visible to the branch
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


# ---- cash close per branch ---------------------------------------------------------------------------------------
async def test_cash_close_is_per_branch(client: httpx.AsyncClient, tenant: Tenant) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    s_a = await mk_student(tenant)
    s_b = await mk_student(tenant, branch_id=b["id"])
    await pay(tenant, s_a["id"], "300000")
    await pay(tenant, s_b["id"], "80000")
    # several active branches and none chosen: the cash desk must be named
    r = await tenant.post("/v1/cash-close", {"counted": "300000"})
    assert r.status_code == 422 and "branch_required" in r.text
    assert (await tenant.get("/v1/cash-close/preview")).status_code == 422
    pa = await ok(await tenant.get("/v1/cash-close/preview", params={"branch_id": a["id"]}))
    pb = await ok(await tenant.get("/v1/cash-close/preview", headers=view(b)))
    assert (pa["book_balance"], pb["book_balance"]) == ("300000.00", "80000.00")
    assert (pa["branch_id"], pb["branch_id"]) == (a["id"], b["id"])
    ca = await ok(await tenant.post("/v1/cash-close", {"counted": "300000", "branch_id": a["id"]}), 201)
    cb = await ok(
        await tenant.post("/v1/cash-close", {"counted": "75000", "note": "5000 short", "branch_id": b["id"]}),
        201,
    )
    assert (ca["shift_no"], cb["shift_no"]) == (1, 1)  # shifts are numbered per branch
    assert (ca["difference"], cb["difference"]) == ("0.00", "-5000.00")
    assert (ca["branch_id"], cb["branch_id"]) == (a["id"], b["id"])
    # the cashier of a branch closes its own cash desk and no other
    cashier = await branch_staff(client, tenant, b["id"], "accountant")
    again = await ok(await cashier.post("/v1/cash-close", {"counted": "80000"}), 201)
    assert again["shift_no"] == 2 and again["branch_id"] == b["id"]
    assert (await cashier.post("/v1/cash-close", {"counted": "1", "branch_id": a["id"]})).status_code == 403
    listed = (await ok(await cashier.get("/v1/cash-close")))["items"]
    assert {c["branch_id"] for c in listed} == {b["id"]}
    assert len((await ok(await tenant.get("/v1/cash-close")))["items"]) == 3


async def test_cash_close_needs_no_choice_with_a_single_branch(tenant: Tenant) -> None:
    a = await default_branch(tenant)
    c = await ok(await tenant.post("/v1/cash-close", {"counted": "0"}), 201)
    assert c["branch_id"] == a["id"] and c["shift_no"] == 1


# ---- moving a student --------------------------------------------------------------------------------------------
async def test_student_transfer_keeps_history_in_the_old_branch(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    course = await mk_course(tenant)
    g_a = await mk_group(tenant, course["id"], monthly_fee="300000")
    g_b = await mk_group(tenant, course["id"], monthly_fee="250000", branch_id=b["id"])
    st = await mk_student(tenant, "Mover")
    await enroll(tenant, g_a["id"], st["id"])
    await ok(await tenant.post("/v1/charges/generate", {"month": MONTH}))
    await pay(tenant, st["id"], "100000")

    # refused while he is enrolled in a group of the old branch
    r = await tenant.post(f"/v1/students/{st['id']}/transfer", {"branch_id": b["id"]})
    assert r.status_code == 409 and r.json()["error"]["details"]["errors"] == ["enrollments_in_old_branch"]
    assert (
        await tenant.post(f"/v1/students/{st['id']}/transfer", {"branch_id": a["id"]})
    ).status_code == 409  # same branch

    done = await ok(
        await tenant.post(
            f"/v1/students/{st['id']}/transfer",
            {"branch_id": b["id"], "end_enrollments": True, "reason": "ko'chib o'tdi"},
        )
    )
    assert (done["from_branch_id"], done["to_branch_id"], done["ended_enrollments"]) == (a["id"], b["id"], 1)
    moved = await ok(await tenant.get(f"/v1/students/{st['id']}"))
    assert moved["branch_id"] == b["id"]
    assert moved["status"] == "active"
    # now he can join a group of the new branch, and the old group no longer holds him
    await enroll(tenant, g_b["id"], st["id"])
    assert (
        await tenant.post(
            f"/v1/groups/{g_a['id']}/enrollments", {"student_id": st["id"], "started_on": "2026-01-01"}
        )
    ).status_code == 422

    # money and history stay where they arose: branch A keeps the charge and the payment
    rep = {r["branch_id"]: r for r in (await ok(await tenant.get("/v1/branch-report")))["rows"]}
    assert rep[a["id"]]["revenue"] == "100000.00" and rep[a["id"]]["charges"] == "300000.00"
    assert rep[b["id"]]["revenue"] == "0.00"
    assert rep[a["id"]]["students_active"] == 0 and rep[b["id"]]["students_active"] == 1

    staff_a = await branch_staff(client, tenant, a["id"], "manager")
    staff_b = await branch_staff(client, tenant, b["id"], "manager")
    # the branch left keeps READ access (its payments and attendance still name him) but can no longer change him
    seen = await ok(await staff_a.get(f"/v1/students/{st['id']}"))
    assert seen["branch_id"] is None  # the new branch is not visible to them
    assert (await staff_a.patch(f"/v1/students/{st['id']}", {"notes": "x"})).status_code == 403
    assert (await staff_b.get(f"/v1/students/{st['id']}")).status_code == 200
    assert (await staff_b.patch(f"/v1/students/{st['id']}", {"notes": "ok"})).status_code == 200
    # the history is visible to the branch left and the branch joined
    for who in (staff_a, staff_b, tenant):
        moves = await ok(await who.get(f"/v1/students/{st['id']}/branch-moves"))
        assert [m["ended_enrollments"] for m in moves] == [1]
    # only center-wide staff move people between branches
    assert (
        await staff_a.post(f"/v1/students/{st['id']}/transfer", {"branch_id": a["id"]})
    ).status_code == 403
    assert (
        await staff_b.post(f"/v1/students/{st['id']}/transfer", {"branch_id": a["id"]})
    ).status_code == 403


async def test_transfer_to_a_closed_branch_is_refused(tenant: Tenant) -> None:
    b = await mk_branch(tenant)
    await ok(await tenant.patch(f"/v1/branches/{b['id']}", {"status": "closed"}))
    st = await mk_student(tenant)
    r = await tenant.post(f"/v1/students/{st['id']}/transfer", {"branch_id": b["id"]})
    assert r.status_code == 422 and "target_closed" in r.text
    assert (
        await tenant.post(f"/v1/students/{st['id']}/transfer", {"branch_id": str(uuid.uuid4())})
    ).status_code == 404


# ---- prices and settings per branch ------------------------------------------------------------------------------
async def test_group_fee_default_follows_the_branch_price(client: httpx.AsyncClient, tenant: Tenant) -> None:
    b = await mk_branch(tenant)
    course = await mk_course(tenant, fee="400000")
    prices = await ok(await tenant.get(f"/v1/branches/{b['id']}/prices"))
    assert [(p["course_fee"], p["branch_fee"], p["effective_fee"]) for p in prices] == [
        ("400000.00", None, "400000.00")
    ]
    put = await ok(
        await tenant.put(f"/v1/branches/{b['id']}/prices/{course['id']}", {"monthly_fee": "350000"})
    )
    assert (put["branch_fee"], put["effective_fee"]) == ("350000.00", "350000.00")
    g_b = await ok(
        await tenant.post(
            "/v1/groups",
            {"course_id": course["id"], "name": "B group", "start_date": "2026-01-01", "branch_id": b["id"]},
        ),
        201,
    )
    g_a = await ok(
        await tenant.post(
            "/v1/groups", {"course_id": course["id"], "name": "A group", "start_date": "2026-01-01"}
        ),
        201,
    )
    assert (g_b["monthly_fee"], g_a["monthly_fee"]) == ("350000.00", "400000.00")
    staff_b = await branch_staff(client, tenant, b["id"])
    g_own = await ok(
        await staff_b.post(
            "/v1/groups", {"course_id": course["id"], "name": "Own", "start_date": "2026-01-01"}
        ),
        201,
    )
    assert g_own["monthly_fee"] == "350000.00" and g_own["branch_id"] == b["id"]
    assert (
        await staff_b.put(f"/v1/branches/{b['id']}/prices/{course['id']}", {"monthly_fee": "1"})
    ).status_code == 403
    await ok(await tenant.delete(f"/v1/branches/{b['id']}/prices/{course['id']}"))
    after = await ok(await tenant.get(f"/v1/branches/{b['id']}/prices"))
    assert after[0]["branch_fee"] is None
    assert (
        await tenant.put(f"/v1/branches/{b['id']}/prices/{course['id']}", {"monthly_fee": "-5"})
    ).status_code == 422


async def test_settings_per_branch_inherit_and_override(client: httpx.AsyncClient, tenant: Tenant) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    base = await ok(await tenant.get("/v1/settings"))
    got = await ok(
        await tenant.patch(
            f"/v1/branches/{b['id']}/settings", {"trial_free_days": 14, "excused_mode": "credit"}
        )
    )
    assert got["overrides"]["trial_free_days"] == 14 and got["effective"]["trial_free_days"] == 14
    assert got["effective"]["trial_free_lessons"] == base["trial_free_lessons"]  # inherited
    # the narrowed view and the branch's own staff see the branch's values, the center keeps its own
    narrowed = await ok(await tenant.get("/v1/settings", headers=view(b)))
    assert (narrowed["trial_free_days"], narrowed["excused_mode"]) == (14, "credit")
    assert (await ok(await tenant.get("/v1/settings")))["trial_free_days"] == base["trial_free_days"]
    assert (await ok(await tenant.get("/v1/settings", headers=view(a))))["trial_free_days"] == base[
        "trial_free_days"
    ]
    staff_b = await branch_staff(client, tenant, b["id"])
    assert (await ok(await staff_b.get("/v1/settings")))["trial_free_days"] == 14
    # a branch admin changes its own branch's values only; the AI switches stay center-wide
    changed = await ok(await staff_b.patch("/v1/settings", {"lead_reminder_days": 9}))
    assert changed["lead_reminder_days"] == 9
    assert (await ok(await tenant.get("/v1/settings")))["lead_reminder_days"] == base["lead_reminder_days"]
    assert (await staff_b.patch("/v1/settings", {"ai_daily_limit": 5})).status_code in (403, 422)
    # null makes the branch inherit again; a wrong value is refused
    cleared = await ok(await tenant.patch(f"/v1/branches/{b['id']}/settings", {"trial_free_days": None}))
    assert (
        cleared["overrides"]["trial_free_days"] is None
        and cleared["effective"]["trial_free_days"] == base["trial_free_days"]
    )
    assert (
        await tenant.patch(f"/v1/branches/{b['id']}/settings", {"trial_free_days": 999})
    ).status_code == 422
    assert (
        await staff_b.patch(f"/v1/branches/{b['id']}/settings", {"trial_free_days": 3})
    ).status_code == 403
    assert (
        await tenant.patch("/v1/settings", {"lead_reminder_days": 5}, headers=view(b))
    ).status_code == 200  # narrowed = the branch's


async def test_family_discount_rule_of_a_branch_applies_to_its_students(tenant: Tenant) -> None:
    """Charge generation follows the settings of the branch of each enrollment, not one center-wide value."""
    b = await mk_branch(tenant)
    await ok(await tenant.patch("/v1/settings", {"family_discount_2nd_percent": "10"}))  # the center: 10%
    await ok(await tenant.patch(f"/v1/branches/{b['id']}/settings", {"family_discount_2nd_percent": "50"}))
    course = await mk_course(tenant, fee="100000")
    g_a = await mk_group(tenant, course["id"], monthly_fee="100000")
    g_b = await mk_group(tenant, course["id"], monthly_fee="100000", branch_id=b["id"])
    g1 = (
        await ok(
            await tenant.post(
                "/v1/guardians",
                {"full_name": "Mother A", "phone": f"+99890{uuid.uuid4().int % 10_000_000:07d}"},
            ),
            201,
        )
    )["id"]
    g2 = (
        await ok(
            await tenant.post(
                "/v1/guardians",
                {"full_name": "Mother B", "phone": f"+99891{uuid.uuid4().int % 10_000_000:07d}"},
            ),
            201,
        )
    )["id"]
    kids = []
    for guardian, group, branch in ((g1, g_a, None), (g1, g_a, None), (g2, g_b, b["id"]), (g2, g_b, b["id"])):
        extra: dict[str, Any] = {} if branch is None else {"branch_id": branch}
        s = await mk_student(tenant, **extra)
        await ok(
            await tenant.post(
                f"/v1/students/{s['id']}/guardians",
                {"guardian_id": guardian, "relation": "mother", "is_primary": True},
            ),
            201,
        )
        await enroll(tenant, group["id"], s["id"])
        kids.append(s)
    await ok(await tenant.post("/v1/charges/generate", {"month": MONTH}))
    amounts = {}
    for s in kids:
        ch = (await ok(await tenant.get("/v1/charges", params={"student_id": s["id"]})))["items"]
        amounts[s["id"]] = ch[0]["amount"]
    first_a, second_a, first_b, second_b = (amounts[s["id"]] for s in kids)
    assert (first_a, first_b) == ("100000.00", "100000.00")  # the first child pays in full
    assert second_a == "90000.00"  # center rule: 10%
    assert second_b == "50000.00"  # the branch's own rule: 50%


# ---- growth rows per branch --------------------------------------------------------------------------------------
async def test_lead_source_cost_is_per_branch(client: httpx.AsyncClient, tenant: Tenant) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    src = await ok(await tenant.post("/v1/lead-sources", {"name": "Instagram"}), 201)
    month = MONTH
    await ok(
        await tenant.put(f"/v1/lead-sources/{src['id']}/costs/{month}", {"amount": "100000"})
    )  # default branch
    await ok(
        await tenant.put(f"/v1/lead-sources/{src['id']}/costs/{month}", {"amount": "40000"}, headers=view(b))
    )
    costs = await ok(await tenant.get("/v1/lead-source-costs"))
    assert sorted((c["branch_id"], c["amount"]) for c in costs) == sorted(
        [(a["id"], "100000.00"), (b["id"], "40000.00")]
    )
    staff_b = await branch_staff(client, tenant, b["id"], "accountant")
    own = await ok(await staff_b.get("/v1/lead-source-costs"))
    assert [(c["branch_id"], c["amount"]) for c in own] == [(b["id"], "40000.00")]
    await ok(
        await staff_b.put(f"/v1/lead-sources/{src['id']}/costs/{month}", {"amount": "45000"})
    )  # replaces its own only
    again = await ok(await tenant.get("/v1/lead-source-costs"))
    assert sorted(c["amount"] for c in again) == ["100000.00", "45000.00"]


async def test_teachers_and_lessons_follow_their_branch(client: httpx.AsyncClient, tenant: Tenant) -> None:
    b = await mk_branch(tenant)
    t_a = await ok(await tenant.post("/v1/teachers", {"full_name": "Teacher A"}), 201)
    t_b = await ok(await tenant.post("/v1/teachers", {"full_name": "Teacher B", "branch_id": b["id"]}), 201)
    assert t_b["branch_id"] == b["id"] and t_a["branch_id"] != b["id"]
    staff_b = await branch_staff(client, tenant, b["id"], "teacher")
    names = [t["full_name"] for t in (await ok(await staff_b.get("/v1/teachers")))["items"]]
    assert names == ["Teacher B"]
    course = await mk_course(tenant)
    g_b = await mk_group(tenant, course["id"], teacher_id=t_b["id"], branch_id=b["id"])
    manager_b = await branch_staff(client, tenant, b["id"], "manager")
    mine = (await ok(await manager_b.get("/v1/groups")))["items"]
    assert [g["id"] for g in mine] == [g_b["id"]]
    # a group that already has people cannot be moved to another branch
    st = await mk_student(tenant, branch_id=b["id"])
    await enroll(tenant, g_b["id"], st["id"])
    a = await default_branch(tenant)
    r = await tenant.patch(f"/v1/groups/{g_b['id']}", {"branch_id": a["id"]})
    assert r.status_code == 422 and "cannot move" in r.text


async def test_idempotent_replay_does_not_cross_branches(tenant: Tenant) -> None:
    a = await default_branch(tenant)
    b = await mk_branch(tenant)
    key = f"key-{uuid.uuid4().hex}"
    first = await ok(
        await tenant.post(
            "/v1/students", {"full_name": "Once"}, headers={"Idempotency-Key": key, "X-Branch": a["id"]}
        ),
        201,
    )
    again = await tenant.post(
        "/v1/students", {"full_name": "Once"}, headers={"Idempotency-Key": key, "X-Branch": b["id"]}
    )
    assert again.status_code == 422 and "different request" in again.text  # the branch is part of the request
    same = await ok(
        await tenant.post(
            "/v1/students", {"full_name": "Once"}, headers={"Idempotency-Key": key, "X-Branch": a["id"]}
        ),
        201,
    )
    assert same["id"] == first["id"]
