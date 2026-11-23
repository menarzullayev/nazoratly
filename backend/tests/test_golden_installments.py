"""Installment rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.installments import (
    Installment,
    PlanRuleError,
    equal_installments,
    installment_balances,
    next_open_due,
    plan_overdue,
    validate_plan,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "installments.json").read_text(
        encoding="utf-8"
    )
)
D = date.fromisoformat


def plan(rows: list[dict[str, str]]) -> list[Installment]:
    return [Installment(Decimal(r["amount"]), D(r["due_date"])) for r in rows]


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 30


@pytest.mark.parametrize("case", GOLDEN["equal"], ids=lambda c: c["name"])
def test_equal(case: dict[str, Any]) -> None:
    i = case["in"]
    if isinstance(case["out"], dict):
        with pytest.raises(PlanRuleError) as err:
            equal_installments(total=Decimal(i["total"]), count=i["count"], first_due=D(i["first_due"]))
        assert err.value.code == case["out"]["error"]
        return
    got = equal_installments(total=Decimal(i["total"]), count=i["count"], first_due=D(i["first_due"]))
    assert got == plan(case["out"])


@pytest.mark.parametrize("case", GOLDEN["validate"], ids=lambda c: c["name"])
def test_validate(case: dict[str, Any]) -> None:
    i = case["in"]
    assert validate_plan(total=Decimal(i["total"]), installments=plan(i["installments"])) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["balances"], ids=lambda c: c["name"])
def test_balances(case: dict[str, Any]) -> None:
    i = case["in"]
    rows = installment_balances(
        installments=plan(i["installments"]), paid=Decimal(i["paid"]), today=D(i["today"])
    )
    got = [{"paid": str(r.paid), "outstanding": str(r.outstanding), "overdue": r.overdue} for r in rows]
    assert got == case["out"]["rows"]
    assert plan_overdue(rows) == Decimal(case["out"]["overdue"])
    expected = case["out"]["next_open_due"]
    assert next_open_due(rows) == (D(expected) if expected else None)
