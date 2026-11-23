from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import httpx

from nazoratly.tools.sheets_import import Importer
from tests.conftest import Tenant
from tests.helpers import ok


class AsgiApi:
    def __init__(self, t: Tenant) -> None:
        self.t = t

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None, key: str | None = None
    ) -> httpx.Response:
        headers = dict(self.t.h)
        if key and method == "POST":
            headers["Idempotency-Key"] = key
        return await self.t.client.request(method, path, json=body, headers=headers)


def write(d: Path, name: str, header: list[str], rows: list[list[str]]) -> None:
    with (d / f"{name}.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def export(d: Path) -> None:
    write(
        d,
        "O'qituvchilar",
        ["ID", "F.I.Sh.", "Oylik turi", "Stavka", "Holat"],
        [
            ["T0001", "Dilnoza Karimova", "Dars uchun", "90 000", "Faol"],
            ["T0002", "Sardor Aliyev", "Foiz", "40", "Faol"],
        ],
    )
    write(
        d,
        "Guruhlar",
        ["ID", "Guruh nomi", "O'qituvchi ID", "Oylik narx (so'm)", "Jadval", "Holat"],
        [
            ["G0001", "IELTS", "T0001", "600,000", "", "Faol"],
            ["G0002", "Matematika", "T0002", "400,000", "", "Faol"],
        ],
    )
    write(
        d,
        "O'quvchilar",
        [
            "ID",
            "F.I.Sh.",
            "Holat",
            "Telefon",
            "Vasiy ismi",
            "Telegram chat ID",
            "Bildirishnoma roziligi",
            "Rozilik sanasi",
            "Siyosat versiyasi",
            "Ulash kodi",
            "Ulash havolasi",
            "Izoh",
        ],
        [
            [
                "S0001",
                "Aziz Rahimov",
                "Faol",
                "+998901234001",
                "Karim",
                "7001",
                "Ha",
                "2026-03-01",
                "2026-11",
                "",
                "",
                "",
            ],
            [
                "S0002",
                "Madina Tursunova",
                "Faol",
                "not-a-phone",
                "Dilfuza",
                "",
                "Yo'q",
                "",
                "",
                "",
                "",
                "Izoh bor",
            ],
            ["S0003", "Jasur Qodirov", "To'xtatilgan", "+998901234003", "", "", "Yo'q", "", "", "", "", ""],
        ],
    )
    write(
        d,
        "Yozilishlar",
        ["ID", "O'quvchi ID", "Guruh ID", "Boshlangan sana", "Tugagan sana", "Chegirma %", "Holat"],
        [
            ["E0001", "S0001", "G0001", "2026-01-12", "", "10", "Faol"],
            ["E0002", "S0002", "G0002", "2026-01-12", "", "0", "Faol"],
            ["E0003", "S0003", "G0001", "2026-01-12", "2026-02-28", "0", "Tugagan"],
            ["E0004", "S9999", "G0001", "2026-01-12", "", "0", "Faol"],
        ],
    )
    write(
        d,
        "Hisoblar",
        ["ID", "O'quvchi ID", "Yozilish ID", "Oy", "Summa", "To'lov muddati", "Izoh", "Bekor qilingan"],
        [
            ["C0001", "S0001", "E0001", "2026-01-01", "540 000", "2026-01-10", "O'qish haqi", "Yo'q"],
            ["C0002", "S0001", "E0001", "2026-02-01", "540 000", "2026-02-10", "", "Yo'q"],
            ["C0003", "S0001", "E0001", "2026-03-01", "540 000", "2026-03-10", "xato hisob", "Ha"],
            ["C0004", "S0002", "E0002", "2026-01-01", "400 000", "2026-01-10", "", "Yo'q"],
        ],
    )
    write(
        d,
        "To'lovlar",
        ["ID", "O'quvchi ID", "Sana", "Summa", "Usul", "Izoh", "Bekor qilingan"],
        [
            ["P0002", "S0001", "2026-02-12", "100 000", "Payme", "", "Yo'q"],
            ["P0001", "S0001", "2026-01-12", "540 000", "Naqd", "", "Yo'q"],
            ["P0003", "S0002", "2026-01-15", "400 000", "Karta", "xato kiritilgan", "Ha"],
        ],
    )
    write(
        d,
        "Davomat",
        ["Sana", "Guruh ID", "O'quvchi ID", "Holat", "Kechikish (daq)"],
        [
            ["2026-03-02", "G0001", "S0001", "Kechikdi", "12"],
            ["2026-03-02", "G0002", "S0002", "Keldi", "0"],
            ["2026-03-04", "G0001", "S0001", "Kelmadi", "0"],
            ["2026-03-04", "G0001", "S9999", "Keldi", "0"],
        ],
    )


async def test_import_end_to_end_idempotent_and_reports_bad_rows(tenant: Tenant, tmp_path: Path) -> None:
    export(tmp_path)
    api = AsgiApi(tenant)
    report = await Importer(api, tmp_path).run()

    assert dict(report.created) == {
        "course": 1,
        "teacher": 2,
        "group": 2,
        "student": 3,
        "guardian": 1,
        "enrollment": 3,
        "charge": 4,
        "payment": 3,
        "lesson": 3,
        "attendance": 3,
    }
    # rows referring to things that do not exist are reported, never silently dropped or imported wrongly
    assert any(e.startswith("enrollment E0004") for e in report.errors)  # unknown student S9999
    assert any(
        e.startswith("guardian S0002") and "aloqa" in e for e in report.errors
    )  # no usable contact -> reported
    assert not any("S0003" in e for e in report.errors)  # no guardian name at all is simply nothing to import

    students = {s["full_name"]: s for s in (await ok(await tenant.get("/v1/students")))["items"]}
    assert set(students) == {"Aziz Rahimov", "Madina Tursunova", "Jasur Qodirov"}
    assert (
        students["Jasur Qodirov"]["status"] == "paused"
        and students["Madina Tursunova"]["notes"] == "Izoh bor"
    )
    assert students["Madina Tursunova"]["phone"] is None  # invalid phone was not imported

    aziz = await ok(await tenant.get(f"/v1/students/{students['Aziz Rahimov']['id']}"))
    assert [g["full_name"] for g in aziz["guardians"]] == ["Karim"]
    consent = [c for c in aziz["consents"] if c["purpose"] == "notifications"]
    assert (
        len(consent) == 1
        and consent[0]["revoked_at"] is None
        and consent[0]["given_by_guardian_id"] == aziz["guardians"][0]["guardian_id"]
    )
    # FIFO balance: charges 540k + 540k (the voided third one ignored), payments 540k + 100k -> 440k outstanding
    bal = await ok(await tenant.get(f"/v1/students/{aziz['id']}/balance"))
    assert (bal["outstanding_total"], bal["credit"]) == ("440000.00", "0.00")
    charges = (
        await ok(await tenant.get("/v1/charges", params={"student_id": aziz["id"], "state": "voided"}))
    )["items"]
    assert len(charges) == 1 and charges[0]["amount"] == "540000.00"
    madina = await ok(await tenant.get(f"/v1/students/{students['Madina Tursunova']['id']}/balance"))
    assert madina["outstanding_total"] == "400000.00"  # her payment was voided in the sheet
    payments = (await ok(await tenant.get("/v1/payments", params={"include_voided": True, "limit": 50})))[
        "items"
    ]
    assert sorted((p["method"], p["voided"]) for p in payments) == [
        ("card", True),
        ("cash", False),
        ("payme", False),
    ]

    enr = {
        e["student_name"]: e
        for e in (
            await ok(
                await tenant.get(
                    f"/v1/groups/{(await ok(await tenant.get('/v1/groups')))['items'][0]['id']}/enrollments",
                    params={"status": "finished"},
                )
            )
        )["items"]
    }
    assert "Jasur Qodirov" in enr and enr["Jasur Qodirov"]["ended_on"] == "2026-02-28"

    lessons = (
        await ok(await tenant.get("/v1/lessons", params={"date_from": "2026-03-01", "date_to": "2026-03-31"}))
    )["items"]
    assert sorted((x["lesson_date"], x["group_name"]) for x in lessons) == [
        ("2026-03-02", "IELTS"),
        ("2026-03-02", "Matematika"),
        ("2026-03-04", "IELTS"),
    ]
    absences = await ok(
        await tenant.get(
            "/v1/reports/absences",
            params={"date_from": "2026-03-01", "date_to": "2026-03-31", "min_absences": 1},
        )
    )
    assert [a["student_name"] for a in absences] == ["Aziz Rahimov"]

    # re-running creates nothing and changes nothing
    state = json.loads((tmp_path / "import_state.json").read_text())
    assert len(state["student"]) == 3
    again = await Importer(api, tmp_path).run()
    assert dict(again.created) == {} and again.skipped["student"] == 3 and again.skipped["payment"] == 3
    assert len((await ok(await tenant.get("/v1/students")))["items"]) == 3
    assert (
        len(
            (await ok(await tenant.get("/v1/payments", params={"include_voided": True, "limit": 50})))[
                "items"
            ]
        )
        == 3
    )


async def test_dry_run_writes_nothing(tenant: Tenant, tmp_path: Path) -> None:
    export(tmp_path)
    report = await Importer(AsgiApi(tenant), tmp_path, dry_run=True).run()
    assert report.created["student"] == 3 and report.created["payment"] == 3
    assert (await ok(await tenant.get("/v1/students")))["items"] == []
    assert not (tmp_path / "import_state.json").exists()


async def test_api_rejections_are_reported_not_fatal(tenant: Tenant, tmp_path: Path) -> None:
    write(
        tmp_path,
        "O'quvchilar",
        ["ID", "F.I.Sh.", "Holat"],
        [["S1", "Valid Student", "Faol"], ["S2", "", "Faol"]],
    )
    write(
        tmp_path,
        "To'lovlar",
        ["ID", "O'quvchi ID", "Sana", "Summa", "Usul", "Izoh", "Bekor qilingan"],
        [
            ["P1", "S1", "2026-01-01", "0", "Naqd", "", "Yo'q"],
            ["P2", "S1", "2026-01-02", "5 000", "Naqd", "", "Yo'q"],
        ],
    )
    report = await Importer(AsgiApi(tenant), tmp_path).run()
    assert report.created["student"] == 1 and report.created["payment"] == 1
    assert any("student S2" in e for e in report.errors) and any("payment P1" in e for e in report.errors)
