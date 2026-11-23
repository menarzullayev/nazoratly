"""Interactive import: preview (mapping, errors, duplicates), commit (one transaction), tenant isolation, limits."""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest

from tests.conftest import Tenant
from tests.helpers import enroll, mk_course, mk_group, mk_student, mk_teacher, ok
from tests.test_capacity import full_group, queue

STUDENT_CSV = (
    "Ism,Telefon,Tug'ilgan sana,Guruh,Ota-ona,Ota-ona telefoni\n"
    "Ali Karimov,90 123 45 67,17.05.2010,{group},Dilnoza opa,+998 93 111 22 33\n"
    "Vali Aliyev,+998 91 000 11 22,,,,\n"
    "Madina Tursunova,901112233,2011-03-04,,,\n"
)


async def students_of(t: Tenant) -> list[dict[str, Any]]:
    return (await ok(await t.get("/v1/students", params={"limit": 200})))["items"]


async def preview(t: Tenant, entity: str, text: str, **kw: Any) -> dict[str, Any]:
    return await ok(await t.post(f"/v1/imports/{entity}/preview", {"text": text, **kw}))


async def commit(t: Tenant, entity: str, text: str, status: int = 201, **kw: Any) -> Any:
    r = await t.post(f"/v1/imports/{entity}/commit", {"text": text, **kw})
    assert r.status_code == status, r.text
    return r.json()


# ---- students: preview ---------------------------------------------------------------------------------------
async def test_preview_maps_columns_and_reports_each_row(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="1")
    text = STUDENT_CSV.format(group=grp["name"]) + "Bad Phone,12345,,,,\n,901234500,,,,\nFuture Kid,,2999-01-01,,,\n"
    p = await preview(tenant, "students", text)
    assert p["mapping"] == {"full_name": 0, "phone": 1, "birth_date": 2, "guardian_name": 4, "guardian_phone": 5, "group": 3, "notes": None}
    assert p["columns"][0] == "Ism" and p["required"] == ["full_name"] and p["required_missing"] == []
    assert p["summary"] == {"total": 6, "ok": 3, "errors": 3, "duplicates": 0}
    rows = {r["row"]: r for r in p["rows"]}
    assert rows[2]["status"] == "ok" and rows[2]["values"]["phone"] == "+998901234567" and rows[2]["values"]["birth_date"] == "2010-05-17"
    assert rows[5]["errors"][0]["code"] == "invalid_phone" and "phone" in rows[5]["errors"][0]["message"].lower()
    assert rows[6]["errors"][0] == {"field": "full_name", "code": "required", "message": "required value is missing"}
    assert rows[7]["errors"][0]["code"] == "future_date"
    assert await students_of(tenant) == []  # a preview never writes


async def test_preview_detects_duplicates_in_the_file_and_in_the_database(tenant: Tenant) -> None:
    await mk_student(tenant, "Existing Phone", phone="+998901234567")
    await mk_student(tenant, "Existing Born", birth_date="2010-05-17")
    text = (
        "name,phone,birth_date\n"
        "New Person,90 123 45 67,\n"  # same phone as an existing student
        "existing  born,,17.05.2010\n"  # same name and birth date
        "Twin,931112233,\n"
        "Twin Again,93 111 22 33,\n"  # same phone as the row above
        "Unique One,,\n"
        "Unique One,,\n"  # bare name twice
    )
    p = await preview(tenant, "students", text)
    got = [(r["row"], r["status"], r["duplicate"]) for r in p["rows"]]
    assert got == [
        (2, "duplicate", {"kind": "existing", "of_row": None}),
        (3, "duplicate", {"kind": "existing", "of_row": None}),
        (4, "ok", None),
        (5, "duplicate", {"kind": "file", "of_row": 4}),
        (6, "ok", None),
        (7, "duplicate", {"kind": "file", "of_row": 6}),
    ]
    assert p["summary"] == {"total": 6, "ok": 2, "errors": 0, "duplicates": 4}


async def test_unknown_closed_and_full_groups_are_row_errors(tenant: Tenant) -> None:
    grp, _ = await full_group(tenant, 1)
    closed = await mk_group(tenant, monthly_fee="1")
    await ok(await tenant.patch(f"/v1/groups/{closed['id']}", {"status": "finished"}))
    roomy = await mk_group(tenant, capacity=2, monthly_fee="1")
    text = (
        "ism,guruh\n"
        f"A,{grp['name']}\n"
        f"B,NO SUCH GROUP\n"
        f"C,{closed['name']}\n"
        f"D,{roomy['name'].upper()}\n"  # case-insensitive
        f"E,{roomy['name']}\n"
        f"F,{roomy['name']}\n"  # the third student for two seats
    )
    p = await preview(tenant, "students", text)
    codes = {r["row"]: [e["code"] for e in r["errors"]] for r in p["rows"]}
    assert codes == {2: ["group_full"], 3: ["unknown_group"], 4: ["group_closed"], 5: [], 6: [], 7: ["group_full"]}


async def test_free_seats_reserved_for_the_waiting_list_are_not_given_away(tenant: Tenant) -> None:
    grp, members = await full_group(tenant, 2)
    await queue(tenant, grp["id"], "Waiting")
    await ok(await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "finished"}))
    p = await preview(tenant, "students", f"ism,guruh\nPushy,{grp['name']}\n")
    assert [e["code"] for e in p["rows"][0]["errors"]] == ["seats_reserved"]


async def test_mapping_override_and_headerless_files(tenant: Tenant) -> None:
    text = "col a;col b\nAli Karimov;90 123 45 67\n"
    guess = await preview(tenant, "students", text)
    assert guess["mapping"]["full_name"] is None and guess["required_missing"] == ["full_name"] and guess["rows"] == []
    p = await preview(tenant, "students", text, mapping={"full_name": 0, "phone": 1})
    assert p["summary"]["ok"] == 1 and p["rows"][0]["values"] == {"full_name": "Ali Karimov", "phone": "+998901234567"}
    nohead = await preview(tenant, "students", "Ali Karimov,90 123 45 67\n", has_header=False, mapping={"full_name": 0, "phone": 1})
    assert nohead["rows"][0]["row"] == 1 and nohead["summary"]["ok"] == 1
    bad = await tenant.post("/v1/imports/students/preview", {"text": text, "mapping": {"full_name": 0, "phone": 0}})
    assert bad.status_code == 422  # one column cannot feed two fields
    assert (await tenant.post("/v1/imports/students/preview", {"text": text, "mapping": {"full_name": 7}})).status_code == 422
    assert (await tenant.post("/v1/imports/students/preview", {"text": text, "mapping": {"nope": 0}})).status_code == 422


async def test_input_limits_and_formats(tenant: Tenant) -> None:
    assert (await tenant.post("/v1/imports/students/preview", {"text": ""})).status_code == 422
    assert (await tenant.post("/v1/imports/students/preview", {"text": " \n\n"})).status_code == 422
    assert (await tenant.post("/v1/imports/people/preview", {"text": "a"})).status_code == 422
    many = "ism\n" + "\n".join(f"Kid {i}" for i in range(5001))
    r = await tenant.post("/v1/imports/students/preview", {"text": many})
    assert r.status_code == 422 and "5000" in r.json()["error"]["message"]
    exact = "ism\n" + "\n".join(f"Kid {i}" for i in range(600))
    p = await preview(tenant, "students", exact)
    assert p["summary"]["total"] == 600 and len(p["rows"]) == 500 and p["rows_truncated"] is True
    bom = "﻿ism;telefon\r\nAli;901234567\r\n"
    assert (await preview(tenant, "students", bom))["summary"]["ok"] == 1


# ---- students: commit -----------------------------------------------------------------------------------------
async def test_commit_writes_students_guardians_and_enrollments_once(tenant: Tenant) -> None:
    grp = await mk_group(tenant, capacity=5, monthly_fee="1")
    text = STUDENT_CSV.format(group=grp["name"])
    done = await commit(tenant, "students", text)
    assert done["created"] == {"students": 3, "guardians": 1, "enrollments": 1}
    assert done["skipped_errors"] == 0 and done["skipped_duplicates"] == 0
    names = sorted(s["full_name"] for s in await students_of(tenant))
    assert names == ["Ali Karimov", "Madina Tursunova", "Vali Aliyev"]
    ali = next(s for s in await students_of(tenant) if s["full_name"] == "Ali Karimov")
    assert ali["phone"] == "+998901234567" and ali["birth_date"] == "2010-05-17"
    members = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/enrollments")))["items"]
    assert [m["student_name"] for m in members] == ["Ali Karimov"]
    detail = await ok(await tenant.get(f"/v1/students/{ali['id']}"))
    assert [(g["full_name"], g["relation"], g["is_primary"]) for g in detail["guardians"]] == [("Dilnoza opa", "guardian", True)]
    # the same file again creates nothing: every row is a duplicate now
    again = await commit(tenant, "students", text)
    assert again["created"] == {} and again["skipped_duplicates"] == 3
    assert len(await students_of(tenant)) == 3


async def test_commit_skips_error_rows_or_aborts_everything(tenant: Tenant) -> None:
    text = "ism,telefon\nGood One,901234567\nBad One,12345\nGood Two,931112233\n"
    aborted = await commit(tenant, "students", text, 422, on_error="abort")
    assert aborted["error"]["details"]["errors"][0]["row"] == 3
    assert await students_of(tenant) == []  # nothing was written
    done = await commit(tenant, "students", text)
    assert done["created"] == {"students": 2} and done["skipped_errors"] == 1
    assert sorted(r["result"] for r in done["rows"]) == ["created", "created", "skipped_error"]


async def test_duplicates_can_be_created_on_request(tenant: Tenant) -> None:
    await mk_student(tenant, "Same Name", phone="+998901234567")
    text = "ism,telefon\nSame Name,901234567\n"
    assert (await commit(tenant, "students", text))["created"] == {}
    done = await commit(tenant, "students", text, duplicates="create")
    assert done["created"] == {"students": 1} and done["skipped_duplicates"] == 0
    assert len(await students_of(tenant)) == 2


async def test_commit_is_all_or_nothing_when_a_write_fails(tenant: Tenant, monkeypatch: pytest.MonkeyPatch) -> None:
    import nazoratly.imports as imp

    grp = await mk_group(tenant, capacity=9, monthly_fee="1")
    real = imp.insert_enrollment
    calls = {"n": 0}

    async def flaky(*a: Any, **k: Any) -> int:
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("disk on fire")
        return await real(*a, **k)

    monkeypatch.setattr(imp, "insert_enrollment", flaky)
    text = "ism,guruh\n" + "".join(f"Kid {i},{grp['name']}\n" for i in range(5))
    r = await tenant.post("/v1/imports/students/commit", {"text": text})
    assert r.status_code == 500 and calls["n"] == 3
    assert await students_of(tenant) == []  # the two students and enrollments written before the failure are gone
    assert (await ok(await tenant.get(f"/v1/groups/{grp['id']}/enrollments")))["items"] == []


async def test_commit_replays_with_the_same_idempotency_key(tenant: Tenant) -> None:
    key = {"Idempotency-Key": str(uuid.uuid4())}
    body = {"text": "ism\nOnce Only\n"}
    first = await tenant.post("/v1/imports/students/commit", body, headers=key)
    second = await tenant.post("/v1/imports/students/commit", body, headers=key)
    assert first.status_code == 201 and second.status_code == 201 and second.json() == first.json()
    assert len(await students_of(tenant)) == 1


async def test_a_full_group_is_never_overfilled_by_an_import(tenant: Tenant) -> None:
    grp = await mk_group(tenant, capacity=2, monthly_fee="1")
    text = "ism,guruh\n" + "".join(f"Kid {i},{grp['name']}\n" for i in range(4))
    done = await commit(tenant, "students", text)
    assert done["created"] == {"students": 2, "enrollments": 2} and done["skipped_errors"] == 2
    assert len((await ok(await tenant.get(f"/v1/groups/{grp['id']}/enrollments")))["items"]) == 2


# ---- groups ---------------------------------------------------------------------------------------------------
async def test_groups_import_resolves_course_and_teacher_by_name(tenant: Tenant) -> None:
    course = await mk_course(tenant, "IELTS")
    teacher = await mk_teacher(tenant, full_name="Dilnoza Karimova")
    text = (
        "Guruh nomi;Kurs;O'qituvchi;Oylik to'lov;Sig'im;Boshlanish sanasi\n"
        "IELTS 6.5;ielts;Dilnoza Karimova;600 000;12;2026-12-01\n"
        "IELTS 7;IELTS;;700000;;01.12.2026\n"
        "Bad Course;Chemistry;;1;;2026-12-01\n"
        "Bad Teacher;IELTS;Nobody;1;;2026-12-01\n"
        "IELTS 6.5;IELTS;;1;;2026-12-01\n"  # same name as row 2
    )
    p = await preview(tenant, "groups", text)
    codes = {r["row"]: [e["code"] for e in r["errors"]] for r in p["rows"]}
    assert codes == {2: [], 3: [], 4: ["unknown_course"], 5: ["unknown_teacher"], 6: []}
    assert p["rows"][4]["status"] == "duplicate" and p["rows"][4]["duplicate"] == {"kind": "file", "of_row": 2}
    done = await commit(tenant, "groups", text)
    assert done["created"] == {"groups": 2} and done["skipped_errors"] == 2 and done["skipped_duplicates"] == 1
    groups = (await ok(await tenant.get("/v1/groups")))["items"]
    g = next(x for x in groups if x["name"] == "IELTS 6.5")
    assert (g["monthly_fee"], g["capacity"], g["course_name"], g["teacher_name"], g["status"]) == ("600000.00", 12, "IELTS", teacher["full_name"], "planned")
    assert course["id"]


async def test_ambiguous_teacher_names_are_not_guessed(tenant: Tenant) -> None:
    await mk_course(tenant, "Math")
    await mk_teacher(tenant, full_name="Same Teacher")
    await mk_teacher(tenant, full_name="Same Teacher")
    p = await preview(tenant, "groups", "name,course,teacher,monthly_fee,start_date\nG1,Math,Same Teacher,1,2026-12-01\n")
    assert [e["code"] for e in p["rows"][0]["errors"]] == ["ambiguous_teacher"]


# ---- leads ----------------------------------------------------------------------------------------------------
async def test_leads_import_creates_sources_and_detects_duplicates(tenant: Tenant) -> None:
    await ok(await tenant.post("/v1/lead-sources", {"name": "Instagram"}), 201)
    existing = await ok(await tenant.post("/v1/leads", {"full_name": "Old Lead", "phone": "+998931112233"}), 201)
    text = (
        "Ism,Telefon,Manba,Izoh\n"
        "New Lead,901234567,instagram,call back\n"
        "Another,911112233,Telegram kanal,\n"
        "Third,951112233,Telegram kanal,\n"
        "Old Again,93 111 22 33,Instagram,\n"
    )
    p = await preview(tenant, "leads", text)
    assert p["summary"] == {"total": 4, "ok": 3, "errors": 0, "duplicates": 1}
    done = await commit(tenant, "leads", text)
    assert done["created"] == {"leads": 3, "lead_sources": 1} and done["skipped_duplicates"] == 1
    leads = (await ok(await tenant.get("/v1/leads", params={"limit": 50})))["items"]
    assert sorted(x["full_name"] for x in leads) == ["Another", "New Lead", "Old Lead", "Third"]
    sources = await ok(await tenant.get("/v1/lead-sources"))
    assert sorted(s["name"] for s in sources) == ["Instagram", "Telegram kanal"]
    assert existing["id"]


# ---- isolation and permissions --------------------------------------------------------------------------------
async def test_import_is_tenant_isolated(tenant: Tenant, tenant_b: Tenant) -> None:
    await mk_student(tenant_b, "Other Center Student", phone="+998901234567")
    course_b = await mk_course(tenant_b, "OnlyB")
    grp_b = await mk_group(tenant_b, course_id=course_b["id"], monthly_fee="1")
    # B's phone is not a duplicate for A, B's group and course names do not resolve for A
    p = await preview(tenant, "students", f"ism,telefon,guruh\nX,901234567,{grp_b['name']}\n")
    assert [e["code"] for e in p["rows"][0]["errors"]] == ["unknown_group"]
    p = await preview(tenant, "students", "ism,telefon\nX,901234567\n")
    assert p["summary"]["ok"] == 1 and p["summary"]["duplicates"] == 0
    g = await preview(tenant, "groups", "name,course,monthly_fee,start_date\nG,OnlyB,1,2026-12-01\n")
    assert [e["code"] for e in g["rows"][0]["errors"]] == ["unknown_course"]
    await commit(tenant, "students", "ism,telefon\nX,901234567\n")
    assert [s["full_name"] for s in await students_of(tenant_b)] == ["Other Center Student"]


async def test_import_needs_write_permissions(client: httpx.AsyncClient, tenant: Tenant) -> None:
    for role in ("viewer", "teacher", "accountant"):
        email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
        await ok(await tenant.post("/v1/staff", {"full_name": role, "email": email, "role": role, "initial_password": "staff-password-123"}), 201)
        data = await ok(await client.post("/v1/auth/login", json={"identifier": email, "password": "staff-password-123"}))
        who = Tenant(client, data, email, "staff-password-123")
        assert (await who.post("/v1/imports/students/preview", {"text": "ism\nA\n"})).status_code == 403, role
        assert (await who.post("/v1/imports/students/commit", {"text": "ism\nA\n"})).status_code == 403, role
    unauth = await client.post("/v1/imports/students/preview", json={"text": "ism\nA\n"})
    assert unauth.status_code == 401
    assert await students_of(tenant) == []


async def test_enrolled_import_student_can_be_enrolled_again_only_through_the_rules(tenant: Tenant) -> None:
    grp = await mk_group(tenant, capacity=1, monthly_fee="1")
    await commit(tenant, "students", f"ism,guruh\nSeat Taker,{grp['name']}\n")
    s = await mk_student(tenant)
    r = await tenant.post(f"/v1/groups/{grp['id']}/enrollments", {"student_id": s["id"], "started_on": "2026-02-01"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "group_full"
    _ = enroll
