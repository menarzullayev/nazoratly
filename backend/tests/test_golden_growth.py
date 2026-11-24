"""Growth rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.growth import (
    CreditFact,
    LeadFact,
    SourceCost,
    SourceLead,
    growth_credit_summary,
    lead_reminders,
    promo_discount,
    promo_state,
    referral_condition_met,
    referral_reward_amount,
    source_roi,
    split_credit,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "growth.json").read_text(encoding="utf-8")
)
D = Decimal


def _d(x: str | None) -> date | None:
    return date.fromisoformat(x) if x else None


def _s(x: Any) -> Any:
    return None if x is None else str(x)


@pytest.mark.parametrize("case", GOLDEN["referral_reward_amount"], ids=lambda c: c["name"])
def test_referral_reward_amount(case: dict[str, Any]) -> None:
    i = case["in"]
    got = referral_reward_amount(
        reward_type=i["reward_type"],
        reward_value=D(i["reward_value"]),
        monthly_fee=D(i["monthly_fee"]),
        lessons_in_month=i["lessons_in_month"],
    )
    assert str(got) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["split_credit"], ids=lambda c: c["name"])
def test_split_credit(case: dict[str, Any]) -> None:
    i = case["in"]
    assert [str(x) for x in split_credit(amount=D(i["amount"]), monthly_fee=D(i["monthly_fee"]))] == case[
        "out"
    ]


@pytest.mark.parametrize("case", GOLDEN["referral_condition"], ids=lambda c: c["name"])
def test_referral_condition(case: dict[str, Any]) -> None:
    i = case["in"]
    got = referral_condition_met(
        condition=i["condition"],
        min_paid=D(i["min_paid"]),
        invited_enrolled=i["invited_enrolled"],
        invited_paid=D(i["invited_paid"]),
    )
    assert got is case["out"]


@pytest.mark.parametrize("case", GOLDEN["promo_state"], ids=lambda c: c["name"])
def test_promo_state(case: dict[str, Any]) -> None:
    i = case["in"]
    got = promo_state(
        active=i["active"],
        valid_from=date.fromisoformat(i["valid_from"]),
        valid_to=_d(i["valid_to"]),
        max_uses=i["max_uses"],
        used=i["used"],
        today=date.fromisoformat(i["today"]),
    )
    assert got == case["out"]


@pytest.mark.parametrize("case", GOLDEN["promo_discount"], ids=lambda c: c["name"])
def test_promo_discount(case: dict[str, Any]) -> None:
    i = case["in"]
    assert str(promo_discount(kind=i["kind"], value=D(i["value"]), fee=D(i["fee"]))) == case["out"]


def _plain(v: dict[str, Any]) -> dict[str, Any]:
    return {k: (x if isinstance(x, int) else _s(x)) for k, x in v.items()}


@pytest.mark.parametrize("case", GOLDEN["growth_credit_summary"], ids=lambda c: c["name"])
def test_growth_credit_summary(case: dict[str, Any]) -> None:
    got = growth_credit_summary(
        [CreditFact(c["source"], c["label"], D(c["amount"]), c["status"]) for c in case["in"]["credits"]]
    )
    assert {"rows": [_plain(r) for r in got["rows"]], "totals": _plain(got["totals"])} == case["out"]


def _roi_row(v: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, x in v.items():
        if k in ("source", "leads", "paying"):
            out[k] = x
        elif k == "roi":
            out[k] = None if x is None else float(x)
        else:
            out[k] = _s(x)
    return out


@pytest.mark.parametrize("case", GOLDEN["source_roi"], ids=lambda c: c["name"])
def test_source_roi(case: dict[str, Any]) -> None:
    i = case["in"]
    got = source_roi(
        [SourceLead(x["source"], date.fromisoformat(x["created_on"]), D(x["revenue"])) for x in i["leads"]],
        [SourceCost(x["source"], date.fromisoformat(x["month"]), D(x["amount"])) for x in i["costs"]],
        date_from=date.fromisoformat(i["range"]["from"]),
        date_to=date.fromisoformat(i["range"]["to"]),
    )
    assert {"rows": [_roi_row(r) for r in got["rows"]], "total": _roi_row(got["total"])} == case["out"]


@pytest.mark.parametrize("case", GOLDEN["lead_reminders"], ids=lambda c: c["name"])
def test_lead_reminders(case: dict[str, Any]) -> None:
    i = case["in"]
    got = lead_reminders(
        [
            LeadFact(
                x["id"],
                x["stage"],
                date.fromisoformat(x["created_on"]),
                _d(x["last_contact_on"]),
                _d(x["next_follow_up_on"]),
            )
            for x in i["leads"]
        ],
        today=date.fromisoformat(i["today"]),
        silence_days=i["silence_days"],
    )
    assert got == case["out"]
