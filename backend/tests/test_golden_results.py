"""Learning-results rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import results

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "results.json").read_text(encoding="utf-8")
)


def ids(c: dict[str, Any]) -> str:
    return str(c["name"])


@pytest.mark.parametrize("case", GOLDEN["constants"], ids=ids)
def test_constants(case: dict[str, Any]) -> None:
    assert getattr(results, case["key"].upper()) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["grade"], ids=ids)
def test_grade(case: dict[str, Any]) -> None:
    assert results.is_valid_grade(case["in"]) is case["out"]


@pytest.mark.parametrize("case", GOLDEN["attendance"], ids=ids)
def test_attendance(case: dict[str, Any]) -> None:
    assert results.attendance_summary(case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["average"], ids=ids)
def test_average(case: dict[str, Any]) -> None:
    assert results.average_grade(case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["exam_percent"], ids=ids)
def test_exam_percent(case: dict[str, Any]) -> None:
    assert results.exam_percent(Decimal(case["score"]), Decimal(case["max"])) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["month_label"], ids=ids)
def test_month_label(case: dict[str, Any]) -> None:
    assert results.month_label(case["in"]["year"], case["in"]["month"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["report_caption"], ids=ids)
def test_report_caption(case: dict[str, Any]) -> None:
    i = case["in"]
    assert results.report_caption(i["center"], i["student"], i["label"], i["percent"], i["average"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["eligible"], ids=ids)
def test_eligible(case: dict[str, Any]) -> None:
    assert results.certificate_eligible(case["enrollment"], case["group"]) is case["out"]


@pytest.mark.parametrize("case", GOLDEN["number"], ids=ids)
def test_number(case: dict[str, Any]) -> None:
    assert results.certificate_number(case["in"]["year"], case["in"]["serial"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["new_code"], ids=ids)
def test_new_code(case: dict[str, Any]) -> None:
    assert results.new_certificate_code(bytes(case["in"])) == case["out"]


def test_new_code_needs_enough_bytes() -> None:
    with pytest.raises(ValueError):
        results.new_certificate_code(bytes(11))


@pytest.mark.parametrize("case", GOLDEN["parse_code"], ids=ids)
def test_parse_code(case: dict[str, Any]) -> None:
    assert results.parse_certificate_code(case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["mask"], ids=ids)
def test_mask(case: dict[str, Any]) -> None:
    assert results.mask_name(case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["certificate_caption"], ids=ids)
def test_certificate_caption(case: dict[str, Any]) -> None:
    i = case["in"]
    assert results.certificate_caption(i["center"], i["student"], i["course"], i["number"], i["code"]) == case["out"]
