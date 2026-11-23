"""Lesson package rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.packages import (
    PackageInput,
    consumes_lesson,
    credited_lessons,
    lessons_money,
    package_balance,
    package_expires_on,
    package_reminder_text,
    payment_need,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "packages.json").read_text(encoding="utf-8")
)
D = date.fromisoformat


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 40


@pytest.mark.parametrize("case", GOLDEN["credited"], ids=lambda c: c["name"])
def test_credited(case: dict[str, Any]) -> None:
    i = case["in"]
    got = credited_lessons(paid=Decimal(i["paid"]), price=Decimal(i["price"]), lessons=i["lessons"])
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["expires_on"], ids=lambda c: c["name"])
def test_expires_on(case: dict[str, Any]) -> None:
    i = case["in"]
    assert package_expires_on(D(i["purchased_on"]), i["expiry_days"]) == D(case["out"])


@pytest.mark.parametrize("case", GOLDEN["consumes"], ids=lambda c: c["name"])
def test_consumes(case: dict[str, Any]) -> None:
    i = case["in"]
    assert (
        consumes_lesson(status=i["status"], is_makeup=i["is_makeup"], excused_mode=i["excused_mode"])
        is case["out"]
    )


@pytest.mark.parametrize("case", GOLDEN["balance"], ids=lambda c: c["name"])
def test_balance(case: dict[str, Any]) -> None:
    i = case["in"]
    got = package_balance(
        packages=[
            PackageInput(p["credited"], D(p["purchased_on"]), D(p["expires_on"])) for p in i["packages"]
        ],
        consumed_on=[D(x) for x in i["consumed_on"]],
        today=D(i["today"]),
    )
    out = case["out"]
    assert (got.available, got.burned, got.uncovered, got.balance) == (
        out["available"],
        out["burned"],
        out["uncovered"],
        out["balance"],
    )
    assert got.next_expiry == (D(out["next_expiry"]) if out["next_expiry"] else None)


@pytest.mark.parametrize("case", GOLDEN["lessons_money"], ids=lambda c: c["name"])
def test_lessons_money(case: dict[str, Any]) -> None:
    i = case["in"]
    got = lessons_money(lessons=i["lessons"], price=Decimal(i["price"]), package_lessons=i["package_lessons"])
    assert got == Decimal(case["out"])


@pytest.mark.parametrize("case", GOLDEN["payment_need"], ids=lambda c: c["name"])
def test_payment_need(case: dict[str, Any]) -> None:
    i = case["in"]
    assert payment_need(balance=i["balance"], low_lessons=i["low_lessons"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["reminder_text"], ids=lambda c: c["name"])
def test_reminder_text(case: dict[str, Any]) -> None:
    i = case["in"]
    got = package_reminder_text(
        need=i["need"],
        guardian=i["guardian"],
        student=i["student"],
        balance=i["balance"],
        debt_amount=Decimal(i["debt_amount"]),
        center=i["center"],
    )
    assert got == case["out"]
