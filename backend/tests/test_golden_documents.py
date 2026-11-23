"""Document rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import documents

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "documents.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", GOLDEN["constants"], ids=lambda c: c["name"])
def test_constants(case: dict[str, Any]) -> None:
    assert getattr(documents, case["key"].upper()) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["number"], ids=lambda c: c["name"])
def test_number(case: dict[str, Any]) -> None:
    i = case["in"]
    assert documents.document_number(i["kind"], i["year"], i["serial"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["format_som"], ids=lambda c: c["name"])
def test_format_som(case: dict[str, Any]) -> None:
    assert documents.format_som(Decimal(case["in"])) == case["out"]
