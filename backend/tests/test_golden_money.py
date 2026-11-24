"""Money rules (G1) checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.accounting import posting_lines
from nazoratly.rules.money import (
    DiscountInput,
    cash_close_errors,
    cash_difference,
    early_discount,
    early_granted,
    early_pay_by,
    family_percent,
    lasting_discounts,
    leaving_split,
    package_remainder,
    refund_errors,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "money.json").read_text(encoding="utf-8")
)
D = date.fromisoformat


def dec(x: Any) -> Decimal:
    return Decimal(str(x))


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 70


@pytest.mark.parametrize("case", GOLDEN["family_percent"], ids=lambda c: c["name"])
def test_family_percent(case: dict[str, Any]) -> None:
    i = case["in"]
    assert family_percent(rank=i["rank"], second=dec(i["second"]), third=dec(i["third"])) == dec(case["out"])


@pytest.mark.parametrize("case", GOLDEN["lasting_discounts"], ids=lambda c: c["name"])
def test_lasting_discounts(case: dict[str, Any]) -> None:
    i = case["in"]
    got = lasting_discounts(
        base=dec(i["base"]),
        discounts=[
            DiscountInput(
                d["kind"],
                dec(d["percent"]) if "percent" in d else None,
                dec(d["amount"]) if "amount" in d else None,
            )
            for d in i["discounts"]
        ],
    )
    assert [{"index": x.index, "kind": x.kind, "amount": int(x.amount)} for x in got.lines] == case["out"][
        "lines"
    ]
    assert got.net == dec(case["out"]["net"])


@pytest.mark.parametrize("case", GOLDEN["early_discount"], ids=lambda c: c["name"])
def test_early_discount(case: dict[str, Any]) -> None:
    i = case["in"]
    assert early_discount(net=dec(i["net"]), percent=dec(i["percent"])) == dec(case["out"])


@pytest.mark.parametrize("case", GOLDEN["early_pay_by"], ids=lambda c: c["name"])
def test_early_pay_by(case: dict[str, Any]) -> None:
    assert early_pay_by(D(case["in"]["month"]), case["in"]["day"]) == D(case["out"])


@pytest.mark.parametrize("case", GOLDEN["early_granted"], ids=lambda c: c["name"])
def test_early_granted(case: dict[str, Any]) -> None:
    i = case["in"]
    got = early_granted(
        pay_by=D(i["pay_by"]),
        payments=[(D(p["on"]), dec(p["amount"])) for p in i["payments"]],
        amount=dec(i["amount"]),
        early=dec(i["early"]),
    )
    assert (got.granted, got.on_time, got.excess) == (
        case["out"]["granted"],
        dec(case["out"]["on_time"]),
        dec(case["out"]["excess"]),
    )


@pytest.mark.parametrize("case", GOLDEN["leaving"], ids=lambda c: c["name"])
def test_leaving(case: dict[str, Any]) -> None:
    i = case["in"]
    got = leaving_split(
        amount=dec(i["amount"]), paid=dec(i["paid"]), left_on=D(i["left_on"]), month=D(i["month"])
    )
    assert (got.used, got.reduction, got.refund) == (
        dec(case["out"]["used"]),
        dec(case["out"]["reduction"]),
        dec(case["out"]["refund"]),
    )


@pytest.mark.parametrize("case", GOLDEN["package_remainder"], ids=lambda c: c["name"])
def test_package_remainder(case: dict[str, Any]) -> None:
    i = case["in"]
    got = package_remainder(
        price=dec(i["price"]),
        package_lessons=i["package_lessons"],
        remaining_lessons=i["remaining_lessons"],
        paid=dec(i["paid"]),
        keep_lessons=i.get("keep_lessons", 0),
    )
    assert got == dec(case["out"])


@pytest.mark.parametrize("case", GOLDEN["refund_errors"], ids=lambda c: c["name"])
def test_refund_errors(case: dict[str, Any]) -> None:
    i = case["in"]
    assert (
        refund_errors(
            kind=i["kind"], payout=i["payout"], amount=dec(i["amount"]), available=dec(i["available"])
        )
        == case["out"]
    )


@pytest.mark.parametrize("case", GOLDEN["cash_difference"], ids=lambda c: c["name"])
def test_cash_difference(case: dict[str, Any]) -> None:
    i = case["in"]
    got = cash_difference(book=dec(i["book"]), counted=dec(i["counted"]))
    assert (got.difference, got.status) == (dec(case["out"]["difference"]), case["out"]["status"])


@pytest.mark.parametrize("case", GOLDEN["cash_close_errors"], ids=lambda c: c["name"])
def test_cash_close_errors(case: dict[str, Any]) -> None:
    i = case["in"]
    assert (
        cash_close_errors(counted=dec(i["counted"]), difference=dec(i["difference"]), note=i["note"])
        == case["out"]
    )


def test_money_posting_events_are_balanced_and_reverse_nothing_for_credit() -> None:
    cash = posting_lines({"event": "refund", "payout": "cash", "amount": Decimal(1000)})
    assert cash == [("4200", Decimal(1000), Decimal(0)), ("1000", Decimal(0), Decimal(1000))]
    assert posting_lines({"event": "refund", "payout": "credit", "amount": Decimal(1000)}) == []
