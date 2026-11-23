"""Accounting rules (chart, posting, pending postings, reports, aging, reconciliation) checked against the JSON cases
shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.accounting import (
    CHART,
    account_statement,
    balance_sheet,
    income_statement,
    match_statement,
    payables_aging,
    pending_postings,
    posting_lines,
    reconciliation_summary,
    statement_foots,
    trial_balance,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "accounting.json").read_text(encoding="utf-8")
)


def totals(t: dict[str, list[str]]) -> dict[str, tuple[Decimal, Decimal]]:
    return {k: (Decimal(v[0]), Decimal(v[1])) for k, v in t.items()}


def fmt_lines(lines: list[tuple[str, Decimal, Decimal]]) -> list[list[str]]:
    return [[a, format(d, ".2f"), format(c, ".2f")] for a, d, c in lines]


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 90


def test_chart_template_matches() -> None:
    assert [[c, n, t] for c, n, t in CHART] == [[a["code"], a["name"], a["type"]] for a in GOLDEN["chart"]]


@pytest.mark.parametrize("c", GOLDEN["posting"], ids=lambda c: c["name"])
def test_posting_lines(c: dict[str, Any]) -> None:
    assert fmt_lines(posting_lines(c["event"])) == c["out"]


@pytest.mark.parametrize("c", GOLDEN["pending"], ids=lambda c: c["name"])
def test_pending_postings(c: dict[str, Any]) -> None:
    posted = {(t, k) for t, k in c["posted"]}
    assert pending_postings(c["sources"], posted, c["today"]) == c["out"]


@pytest.mark.parametrize("c", GOLDEN["trial_balance"], ids=lambda c: c["name"])
def test_trial_balance(c: dict[str, Any]) -> None:
    assert trial_balance(totals(c["totals"]), GOLDEN["chart"]) == c["out"]


@pytest.mark.parametrize("c", GOLDEN["income_statement"], ids=lambda c: c["name"])
def test_income_statement(c: dict[str, Any]) -> None:
    assert income_statement(totals(c["totals"]), GOLDEN["chart"]) == c["out"]


@pytest.mark.parametrize("c", GOLDEN["balance_sheet"], ids=lambda c: c["name"])
def test_balance_sheet(c: dict[str, Any]) -> None:
    assert balance_sheet(totals(c["totals"]), GOLDEN["chart"]) == c["out"]


@pytest.mark.parametrize("c", GOLDEN["account_statement"], ids=lambda c: c["name"])
def test_account_statement(c: dict[str, Any]) -> None:
    assert account_statement(Decimal(c["opening"]), c["side"], c["lines"]) == c["out"]


@pytest.mark.parametrize("c", GOLDEN["aging"], ids=lambda c: c["name"])
def test_payables_aging(c: dict[str, Any]) -> None:
    assert payables_aging(c["bills"], c["as_of"]) == c["out"]


@pytest.mark.parametrize("c", GOLDEN["match"], ids=lambda c: c["name"])
def test_match_statement(c: dict[str, Any]) -> None:
    assert match_statement(c["statement"], c["ledger"], c["tolerance"]) == c["out"]


@pytest.mark.parametrize("c", GOLDEN["foots"], ids=lambda c: c["name"])
def test_statement_foots(c: dict[str, Any]) -> None:
    assert statement_foots(Decimal(c["opening"]), Decimal(c["closing"]), c["lines"]) is c["out"]


@pytest.mark.parametrize("c", GOLDEN["summary"], ids=lambda c: c["name"])
def test_reconciliation_summary(c: dict[str, Any]) -> None:
    got = reconciliation_summary(
        Decimal(c["closing"]),
        Decimal(c["ledger"]),
        c["unmatched_statement"],
        c["unmatched_ledger"],
        c["foots"],
    )
    assert got == c["out"]
