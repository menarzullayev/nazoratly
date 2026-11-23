"""Import rules checked against the JSON cases shared with the TypeScript implementation."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import imports as I

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "import.json").read_text(encoding="utf-8")
)


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 100


@pytest.mark.parametrize("case", GOLDEN["parse_delimited"], ids=lambda c: c["name"])
def test_parse_delimited(case: dict[str, Any]) -> None:
    assert I.parse_delimited(case["in"]["text"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["detect_columns"], ids=lambda c: c["name"])
def test_detect_columns(case: dict[str, Any]) -> None:
    assert I.detect_columns(case["in"]["entity"], case["in"]["headers"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["normalize_phone"], ids=lambda c: c["name"])
def test_normalize_phone(case: dict[str, Any]) -> None:
    assert I.normalize_phone(case["in"]["text"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["parse_date"], ids=lambda c: c["name"])
def test_parse_date(case: dict[str, Any]) -> None:
    assert I.parse_date(case["in"]["text"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["parse_whole"], ids=lambda c: c["name"])
def test_parse_whole(case: dict[str, Any]) -> None:
    assert I.parse_whole(case["in"]["text"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["validate_row"], ids=lambda c: c["name"])
def test_validate_row(case: dict[str, Any]) -> None:
    i = case["in"]
    r = I.validate_row(
        i["entity"], i["raw"], today=date.fromisoformat(i["today"]), required=i.get("required")
    )
    assert {"values": r.values, "errors": [{"field": e.field, "code": e.code} for e in r.errors]} == case[
        "out"
    ]


@pytest.mark.parametrize("case", GOLDEN["duplicate_keys"], ids=lambda c: c["name"])
def test_duplicate_keys(case: dict[str, Any]) -> None:
    assert I.duplicate_keys(case["in"]["entity"], case["in"]["values"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["find_duplicates"], ids=lambda c: c["name"])
def test_find_duplicates(case: dict[str, Any]) -> None:
    i = case["in"]
    got = I.find_duplicates(i["entity"], i["rows"], set(i["existing"]))
    assert [None if d is None else {"kind": d.kind, "of": d.of} for d in got] == case["out"]
