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


# ---- the message as it is sent (rules/reminders.py: reminder_rich, strip_html and the paid-claim texts) -------------
_FILE = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "reminders.json").read_text(encoding="utf-8")
)
MESSAGES = _FILE["messages"]


@pytest.mark.parametrize("case", MESSAGES, ids=[c["name"] for c in MESSAGES])
def test_golden_message(case: dict[str, Any]) -> None:
    given = case["in"]
    html = R.reminder_rich(
        text=given["text"],
        paid_data=given["paid_data"],
        charges=[
            R.OpenCharge(
                date.fromisoformat(c["month"]), date.fromisoformat(c["due_date"]), Decimal(c["outstanding"])
            )
            for c in given["charges"]
        ],
        pay_info=given["pay_info"],
    )
    assert html == case["out"]["html"]
    assert R.strip_html(html) == case["out"]["plain"]


def test_golden_paid_texts() -> None:
    paid = _FILE["paid"]
    assert R.paid_note_line(date.fromisoformat(paid["today"])) == paid["note_line"]
    assert R.paid_owner_text(paid["student_name"]) == paid["owner_text"]
    assert (paid["thanks"], paid["not_linked"]) == (R.PAID_THANKS, R.PAID_NOT_LINKED)


PACKAGES = _FILE["packages"]


@pytest.mark.parametrize("case", PACKAGES, ids=[c["name"] for c in PACKAGES])
def test_golden_package_drafts(case: dict[str, Any]) -> None:
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
    drafts, skipped = R.plan_packages(
        balances=[
            R.PackageFacts(b["student_id"], b["need"], b["balance"], Decimal(b["debt_amount"]))
            for b in given["balances"]
        ],
        students=students,
        today=date.fromisoformat(given["today"]),
        cooldown_days=given["cooldown_days"],
        center=given["center"],
    )
    assert [{"student_id": d.student_id, "text": d.text} for d in drafts] == case["out"]["drafts"]
    assert [{"student_id": x.student_id, "reason": x.reason} for x in skipped] == case["out"]["skipped"]
