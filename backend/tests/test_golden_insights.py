"""Insight rules (debt follow-up, churn risk, weekly summary) checked against the JSON cases shared with the TypeScript
implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.insights import (
    DebtFact,
    RiskFact,
    WeekFacts,
    churn_risk,
    debt_followup,
    debt_line,
    debt_message,
    fmt_money,
    rate,
    risk_line,
    week_rate,
    weekly_summary,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "insights.json").read_text(encoding="utf-8")
)
D = date.fromisoformat


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 70


@pytest.mark.parametrize("case", GOLDEN["fmt_money"], ids=lambda c: str(c["n"]))
def test_fmt_money(case: dict[str, Any]) -> None:
    assert fmt_money(case["n"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["rate"], ids=lambda c: f"{c['attended']}/{c['marked']}")
def test_rate(case: dict[str, Any]) -> None:
    assert rate(case["attended"], case["marked"]) == case["out"]
    assert week_rate(case["attended"], case["marked"]) == case["week_out"]


@pytest.mark.parametrize("case", GOLDEN["debt_followup"], ids=lambda c: c["name"])
def test_debt_followup(case: dict[str, Any]) -> None:
    got = debt_followup(
        [
            DebtFact(s["id"], s["outstanding"], s["overdue"], D(s["oldest_due"]) if s["oldest_due"] else None)
            for s in case["in"]["students"]
        ],
        today=D(case["in"]["today"]),
    )
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["debt_message"], ids=lambda c: c["name"])
def test_debt_message(case: dict[str, Any]) -> None:
    i = case["in"]
    assert debt_message(i["tone"], i["student"], i["amount"], i["days"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["churn_risk"], ids=lambda c: c["name"])
def test_churn_risk(case: dict[str, Any]) -> None:
    got = churn_risk([RiskFact(**s) for s in case["in"]["students"]])
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["weekly_summary"], ids=lambda c: c["name"])
def test_weekly_summary(case: dict[str, Any]) -> None:
    assert weekly_summary(WeekFacts(**case["in"])) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["report_line"], ids=lambda c: c["name"])
def test_report_line(case: dict[str, Any]) -> None:
    i = case["in"]
    if case["kind"] == "debt":
        got = debt_line(i["rank"], i["name"], i["outstanding"], i["age_days"], i["tone"])
    else:
        got = risk_line(i["rank"], i["name"], i["score"], i["level"], i["reasons"])
    assert got == case["out"]
