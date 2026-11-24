"""Journey 6: one center, two branches. Each branch's staff see and change only their own branch (row-level security), the
owner sees the total or narrows the view, a student moves between branches with history and money left where they arose,
the cash desks close separately, and the shared books stay sound with one chain for the whole center."""

from __future__ import annotations

from typing import Any

import httpx

from tests.conftest import Tenant
from tests.e2e.journeys import A, assert_books_sound, money
from tests.helpers import enroll, mk_course, mk_group, mk_student, ok
from tests.test_branches import MONTH, branch_staff, default_branch, mk_branch, pay, view


def rows_by_branch(rep: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {r["branch_id"]: r for r in rep["rows"]}


async def test_two_branches_data_permissions_transfer_and_reports(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    t = tenant
    main = await default_branch(t)
    north = await mk_branch(t, "Shimol filiali")
    course = await mk_course(t, fee="300000")
    g_main = await mk_group(t, course["id"], monthly_fee="300000")
    g_north = await mk_group(t, course["id"], monthly_fee="200000", branch_id=north["id"])
    s_main = await mk_student(t, "Asosiy O'quvchi")
    s_north = await mk_student(t, "Shimol O'quvchi", branch_id=north["id"])
    mover = await mk_student(t, "Ko'chuvchi")
    await enroll(t, g_main["id"], s_main["id"])
    await enroll(t, g_north["id"], s_north["id"])
    await enroll(t, g_main["id"], mover["id"])

    mgr_main = await branch_staff(client, t, main["id"], "manager")
    acc_north = await branch_staff(client, t, north["id"], "accountant")
    mgr_north = await branch_staff(client, t, north["id"], "manager")

    # --- separation: each branch's staff see only their own students, groups and (via RLS) nothing else
    names_main = {s["full_name"] for s in (await ok(await mgr_main.get("/v1/students", params={"limit": 200})))["items"]}
    names_north = {s["full_name"] for s in (await ok(await mgr_north.get("/v1/students", params={"limit": 200})))["items"]}
    assert names_main == {"Asosiy O'quvchi", "Ko'chuvchi"} and names_north == {"Shimol O'quvchi"}
    assert (await mgr_main.get(f"/v1/students/{s_north['id']}")).status_code == 404
    assert (await mgr_north.get(f"/v1/students/{s_main['id']}")).status_code == 404
    assert (await mgr_main.get(f"/v1/groups/{g_north['id']}")).status_code == 404
    assert (await mgr_main.get("/v1/students", headers=view(north))).status_code == 403  # may not look at the other branch
    assert (await mgr_north.post("/v1/branches", {"name": "Wild branch"})).status_code == 403
    assert (await mgr_north.post("/v1/students", {"full_name": "Into main"}, headers=view(main))).status_code == 403

    # --- the owner sees the total, or narrows the view with X-Branch (writes follow the view)
    assert {s["full_name"] for s in (await ok(await t.get("/v1/students", params={"limit": 200})))["items"]} == names_main | names_north
    only_north = await ok(await t.get("/v1/students", headers=view(north), params={"limit": 200}))
    assert [s["full_name"] for s in only_north["items"]] == ["Shimol O'quvchi"]
    created = await ok(await t.post("/v1/students", {"full_name": "Created in view"}, headers=view(north)), 201)
    assert (await ok(await t.get(f"/v1/students/{created['id']}")))["branch_id"] == north["id"]

    # --- billing and money per branch; the cashier of a branch can only take money for its own students
    gen = await ok(await t.post("/v1/charges/generate", {"month": MONTH}))
    assert gen["created"] == 3
    await pay(t, s_main["id"], "300000")
    await pay(acc_north, s_north["id"], "120000")
    assert (await acc_north.post("/v1/payments", {"student_id": s_main["id"], "amount": "1000", "method": "cash"})).status_code in (403, 404)
    await pay(t, mover["id"], "100000")
    exp = await ok(await t.post("/v1/expenses", {"category": "rent", "amount": "50000", "spent_at": MONTH, "branch_id": north["id"]}), 201)
    assert exp["amount"] == "50000.00"

    # --- the report: a row per branch and a total that is always the sum of the rows
    rep = await ok(await t.get("/v1/branch-report"))
    rows = rows_by_branch(rep)
    assert (rows[main["id"]]["revenue"], rows[north["id"]]["revenue"]) == ("400000.00", "120000.00")
    assert money(rows[north["id"]]["expenses"]) == 50000
    for key in ("revenue", "charges", "expenses", "net", "debt", "cash_balance"):
        assert sum(float(r[key]) for r in rep["rows"]) == float(rep["total"][key]), key
    mine = await ok(await acc_north.get("/v1/branch-report"))
    assert [r["branch_id"] for r in mine["rows"]] == [north["id"]] and mine["total"]["revenue"] == "120000.00"

    # --- the cash desks: the owner must name the branch, each closes separately with its own shift numbers
    assert (await t.post("/v1/cash-close", {"counted": "1"})).status_code == 422
    c_main = await ok(await t.post("/v1/cash-close", {"counted": "400000", "branch_id": main["id"]}), 201)
    c_north = await ok(await acc_north.post("/v1/cash-close", {"counted": "70000"}), 201)  # 120000 in, 50000 rent out
    assert (c_main["shift_no"], c_north["shift_no"]) == (1, 1) and c_north["difference"] == "0.00"
    assert (await acc_north.post("/v1/cash-close", {"counted": "1", "branch_id": main["id"]})).status_code == 403

    # --- one chain for the center: branch staff cannot verify it or close a month, the owner can
    assert (await acc_north.get(f"{A}/verify")).status_code == 403
    assert (await acc_north.post(f"{A}/periods/2026-01/close")).status_code == 403
    await assert_books_sound(t)
    north_entries = (await ok(await acc_north.get(f"{A}/entries", params={"limit": 200})))["items"]
    assert [e["source_type"] for e in north_entries] == ["expense", "payment"]  # only the north branch's own postings

    # --- transfer: refused while enrolled in the old branch, then moved; history and money stay in the old branch
    r = await t.post(f"/v1/students/{mover['id']}/transfer", {"branch_id": north["id"]})
    assert r.status_code == 409
    done = await ok(await t.post(f"/v1/students/{mover['id']}/transfer", {"branch_id": north["id"], "end_enrollments": True, "reason": "moved house"}))
    assert (done["from_branch_id"], done["to_branch_id"], done["ended_enrollments"]) == (main["id"], north["id"], 1)
    await enroll(t, g_north["id"], mover["id"])
    assert (await mgr_main.patch(f"/v1/students/{mover['id']}", {"notes": "x"})).status_code == 403  # left: read-only
    assert (await mgr_north.patch(f"/v1/students/{mover['id']}", {"notes": "welcome"})).status_code == 200
    assert (await mgr_main.post(f"/v1/students/{mover['id']}/transfer", {"branch_id": main["id"]})).status_code == 403
    rep2 = rows_by_branch(await ok(await t.get("/v1/branch-report")))
    assert rep2[main["id"]]["revenue"] == "400000.00"  # the 100000 paid before the move stays in the old branch
    before = rows_by_branch(rep)
    assert rep2[main["id"]]["students_active"] == before[main["id"]]["students_active"] - 1
    assert rep2[north["id"]]["students_active"] == before[north["id"]]["students_active"] + 1
    for who in (mgr_main, mgr_north, t):
        assert len(await ok(await who.get(f"/v1/students/{mover['id']}/branch-moves"))) == 1
    await assert_books_sound(t)
