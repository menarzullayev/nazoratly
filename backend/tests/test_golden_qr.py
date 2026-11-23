"""QR attendance rules checked against the JSON cases shared with the TypeScript implementation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import qr as Q

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "qr.json").read_text(encoding="utf-8")
)


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 30


@pytest.mark.parametrize("case", GOLDEN["new_code"], ids=lambda c: c["name"])
def test_new_code(case: dict[str, Any]) -> None:
    code = Q.new_code(bytes(case["in"]["bytes"]))
    assert code == case["out"]
    assert Q.is_valid_code(code)


@pytest.mark.parametrize("case", GOLDEN["parse_payload"], ids=lambda c: c["name"])
def test_parse_payload(case: dict[str, Any]) -> None:
    assert Q.parse_payload(case["in"]["text"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["scan_decision"], ids=lambda c: c["name"])
def test_scan_decision(case: dict[str, Any]) -> None:
    d = Q.scan_decision(**case["in"])
    assert {"result": d.result, "write": d.write, "previous": d.previous} == case["out"]


@pytest.mark.parametrize("case", GOLDEN["matrix"], ids=lambda c: c["name"])
def test_reference_matrix_is_stable(case: dict[str, Any]) -> None:
    """The matrices come from reportlab's encoder (which prints the cards); the TypeScript encoder must equal them."""
    assert ["".join(map(str, r)) for r in Q.qr_matrix(case["in"]["text"])] == case["out"]


def test_new_code_needs_enough_randomness() -> None:
    with pytest.raises(ValueError, match="20 random bytes"):
        Q.new_code(b"\x00" * 19)


def test_payload_carries_nothing_but_the_code() -> None:
    code = Q.new_code(bytes(range(20)))
    assert Q.qr_payload(code) == code
    assert len(code) == 25
