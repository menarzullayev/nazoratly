"""The lifecycle rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.lifecycle import first_month_charge, trial_status

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "lifecycle.json").read_text(encoding="utf-8")
)


def test_golden_file_has_enough_cases() -> None:
    assert len(GOLDEN["trial_status"]) >= 8
    assert len(GOLDEN["first_month_charge"]) >= 9


@pytest.mark.parametrize("case", GOLDEN["trial_status"], ids=lambda c: c["name"])
def test_trial_status(case: dict[str, Any]) -> None:
    i = case["in"]
    got = trial_status(
        started_on=date.fromisoformat(i["started_on"]),
        today=date.fromisoformat(i["today"]),
        lessons_attended=i["lessons_attended"],
        free_lessons=i["free_lessons"],
        free_days=i["free_days"],
    )
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["first_month_charge"], ids=lambda c: c["name"])
def test_first_month_charge(case: dict[str, Any]) -> None:
    i = case["in"]
    got = first_month_charge(
        mode=i["mode"],
        monthly_fee=Decimal(str(i["monthly_fee"])),
        accepted_on=date.fromisoformat(i["accepted_on"]),
        lesson_dates=[date.fromisoformat(d) for d in i["lesson_dates"]],
    )
    assert got.amount == Decimal(case["out"]["amount"])
    assert got.fallback_to_full is case["out"]["fallback_to_full"]
