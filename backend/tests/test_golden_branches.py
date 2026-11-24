"""Branch rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.branches import (
    branch_totals,
    cash_close_branch,
    effective_value,
    resolve_scope,
    row_visible,
    stamp_branch,
    transfer_check,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "branches.json").read_text(encoding="utf-8")
)


def test_golden_file_is_substantial() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 40


@pytest.mark.parametrize("case", GOLDEN["stamp_branch"], ids=lambda c: c["name"])
def test_stamp_branch(case: dict[str, Any]) -> None:
    assert stamp_branch(**case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["row_visible"], ids=lambda c: c["name"])
def test_row_visible(case: dict[str, Any]) -> None:
    assert row_visible(**case["in"]) is case["out"]


@pytest.mark.parametrize("case", GOLDEN["branch_totals"], ids=lambda c: c["name"])
def test_branch_totals(case: dict[str, Any]) -> None:
    got = branch_totals(case["in"]["branches"], case["in"]["facts"])
    assert got == case["out"]
    # invariant: the total is the sum of the per-branch rows and the unassigned row
    parts = [*got["rows"], *([got["unassigned"]] if got["unassigned"] else [])]
    for key in ("revenue", "charges", "expenses", "net"):
        assert sum(int(p[key]) for p in parts) == int(got["total"][key])


@pytest.mark.parametrize("case", GOLDEN["transfer_check"], ids=lambda c: c["name"])
def test_transfer_check(case: dict[str, Any]) -> None:
    i = case["in"]
    got = transfer_check(
        from_branch=i["from"],
        to_branch=i["to"],
        to_status=i["to_status"],
        enrollment_branches=i["enrollment_branches"],
        end_enrollments=i["end_enrollments"],
    )
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["effective_value"], ids=lambda c: c["name"])
def test_effective_value(case: dict[str, Any]) -> None:
    assert effective_value(**case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["cash_close_branch"], ids=lambda c: c["name"])
def test_cash_close_branch(case: dict[str, Any]) -> None:
    assert cash_close_branch(**case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["resolve_scope"], ids=lambda c: c["name"])
def test_resolve_scope(case: dict[str, Any]) -> None:
    assert resolve_scope(**case["in"]) == case["out"]
