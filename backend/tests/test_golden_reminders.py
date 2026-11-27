"""Golden cases of the debt reminder drafts, shared with the Sheets edition (sheets/test/golden.reminders.test.ts)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import reminders as R

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "reminders.json").read_text(encoding="utf-8")
)["cases"]


def _ref(raw: dict[str, Any] | None) -> R.InstallmentRef | None:
    if raw is None:
        return None
    return R.InstallmentRef(
        raw["seq"], raw["count"], date.fromisoformat(raw["due_date"]), Decimal(raw["outstanding"])
    )


def test_enough_cases() -> None:
    assert len(CASES) >= 8


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_golden(case: dict[str, Any]) -> None:
    given = case["in"]
    students = {
        s["id"]: R.StudentFacts(
            s["id"],
            s["name"],
            s["status"],
            s["guardian"],
            s["has_chat"],
            s["consent"],
            date.fromisoformat(s["last_reminded_on"]) if s["last_reminded_on"] else None,
        )
        for s in given["students"]
    }
    debts = [
        R.DebtFacts(
            d["student_id"],
            Decimal(d["overdue"]),
            d["max_days_overdue"],
            _ref(d["overdue_installment"]),
            _ref(d["next_installment"]),
        )
        for d in given["debts"]
    ]
    drafts, skipped = R.plan(
        debts=debts,
        students=students,
        today=date.fromisoformat(given["today"]),
        cooldown_days=given["cooldown_days"],
        min_overdue=Decimal(given["min_overdue"]),
        remind_days=given["remind_days"],
        template=given["template"] or R.DEFAULT_TEMPLATE,
        center=given["center"],
    )
    assert [{"student_id": d.student_id, "kind": d.kind, "text": d.text} for d in drafts] == case["out"][
        "drafts"
    ]
    assert [{"student_id": s.student_id, "reason": s.reason} for s in skipped] == case["out"]["skipped"]
