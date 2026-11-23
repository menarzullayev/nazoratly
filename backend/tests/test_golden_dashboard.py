"""Dashboard rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.dashboard import (
    EnrollmentFact,
    MoneyOn,
    PackageWait,
    PayrollMonth,
    RightWait,
    StudentMoney,
    TrialWait,
    monthly_finance,
    payment_status,
    student_movement,
    waiting_items,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "dashboard.json").read_text(encoding="utf-8")
)
D = date.fromisoformat


def _opt(s: str | None) -> date | None:
    return D(s) if s else None


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 45


@pytest.mark.parametrize("case", GOLDEN["payment_status"], ids=lambda c: c["name"])
def test_payment_status(case: dict[str, Any]) -> None:
    got = payment_status(
        [
            StudentMoney(s["id"], Decimal(s["outstanding"]), Decimal(s["overdue"]), s["package_debt_lessons"])
            for s in case["in"]["students"]
        ]
    )
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["student_movement"], ids=lambda c: c["name"])
def test_student_movement(case: dict[str, Any]) -> None:
    i = case["in"]
    got = student_movement(
        [
            EnrollmentFact(
                e["student"],
                e["status"],
                D(e["started_on"]),
                _opt(e["accepted_on"]),
                _opt(e["ended_on"]),
                e["dropped_trial"],
            )
            for e in i["enrollments"]
        ],
        date_from=D(i["range"]["from"]),
        date_to=D(i["range"]["to"]),
    )
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["monthly_finance"], ids=lambda c: c["name"])
def test_monthly_finance(case: dict[str, Any]) -> None:
    i = case["in"]
    got = monthly_finance(
        payments=[MoneyOn(D(p["on"]), Decimal(p["amount"])) for p in i["payments"]],
        expenses=[MoneyOn(D(p["on"]), Decimal(p["amount"])) for p in i["expenses"]],
        payroll=[PayrollMonth(D(p["month"]), Decimal(p["amount"])) for p in i["payroll"]],
        today=D(i["today"]),
    )
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["waiting"], ids=lambda c: c["name"])
def test_waiting(case: dict[str, Any]) -> None:
    i = case["in"]
    got = waiting_items(
        trials=[TrialWait(t["id"], D(t["started_on"]), t["lessons_attended"]) for t in i["trials"]],
        packages=[PackageWait(p["id"], p["available"], _opt(p["next_expiry"])) for p in i["packages"]],
        rights=[RightWait(r["id"], r["kind"], r["status"], D(r["expires_on"])) for r in i["rights"]],
        today=D(i["today"]),
        window_days=i["window_days"],
        free_lessons=i["free_lessons"],
        free_days=i["free_days"],
        makeup_lapses=i["makeup_lapses"],
    )
    assert got == case["out"]
