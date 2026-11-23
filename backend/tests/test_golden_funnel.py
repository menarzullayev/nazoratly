"""The lead funnel report checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.funnel import LeadFact, funnel_report

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "funnel.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", GOLDEN["funnel_report"], ids=lambda c: c["name"])
def test_funnel_report(case: dict[str, Any]) -> None:
    i = case["in"]
    got = funnel_report(
        [LeadFact(x["stage"], x["source"], date.fromisoformat(x["created_on"])) for x in i["leads"]],
        date_from=date.fromisoformat(i["range"]["from"]),
        date_to=date.fromisoformat(i["range"]["to"]),
    )
    assert got == case["out"]
