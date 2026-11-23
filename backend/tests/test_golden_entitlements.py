"""Entitlement rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.entitlements import (
    apply_credits,
    entitlement_expires_on,
    entitlement_state,
    lesson_credit_amount,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "entitlements.json").read_text(
        encoding="utf-8"
    )
)
D = date.fromisoformat


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 23


@pytest.mark.parametrize("case", GOLDEN["expires_on"], ids=lambda c: c["name"])
def test_expires_on(case: dict[str, Any]) -> None:
    i = case["in"]
    assert entitlement_expires_on(D(i["missed_on"]), i["expiry_days"]) == D(case["out"])


@pytest.mark.parametrize("case", GOLDEN["state"], ids=lambda c: c["name"])
def test_state(case: dict[str, Any]) -> None:
    i = case["in"]
    got = entitlement_state(
        status=i["status"], expires_on=D(i["expires_on"]), today=D(i["today"]), lapses=i["lapses"]
    )
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["lesson_credit_amount"], ids=lambda c: c["name"])
def test_lesson_credit_amount(case: dict[str, Any]) -> None:
    i = case["in"]
    got = lesson_credit_amount(monthly_fee=Decimal(i["monthly_fee"]), lessons_in_month=i["lessons_in_month"])
    assert got == Decimal(case["out"])


@pytest.mark.parametrize("case", GOLDEN["apply_credits"], ids=lambda c: c["name"])
def test_apply_credits(case: dict[str, Any]) -> None:
    i = case["in"]
    got = apply_credits(fee=Decimal(i["fee"]), credits=[Decimal(c) for c in i["credits"]])
    assert (got.amount, got.used) == (Decimal(case["out"]["amount"]), case["out"]["used"])
