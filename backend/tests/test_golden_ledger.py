"""Hash-chained journal rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules.ledger import (
    Head,
    Line,
    Period,
    canonical_line,
    make_period,
    reverse_lines,
    seal_entry,
    sha256_hex,
    validate_entry,
    verify_chain,
)

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "ledger.json").read_text(encoding="utf-8")
)


def line_of(d: dict[str, Any]) -> Line:
    return Line(
        seq=d["seq"],
        entry_no=d["entry_no"],
        date=d["date"],
        account=d["account"],
        debit=Decimal(d["debit"]),
        credit=Decimal(d["credit"]),
        source_type=d["source_type"],
        source_key=d["source_key"],
        memo=d["memo"],
        prev_hash=d.get("prev_hash", "0" * 64),
        hash=d.get("hash", ""),
    )


def period_of(d: dict[str, Any]) -> Period:
    return Period(
        d["month"],
        d["last_seq"],
        d["head_hash"],
        Decimal(d["total_debit"]),
        Decimal(d["total_credit"]),
        d["period_hash"],
    )


def lines_of(rows: list[list[str]]) -> list[tuple[str, Decimal, Decimal]]:
    return [(a, Decimal(d), Decimal(c)) for a, d, c in rows]


def dump(ln: Line) -> dict[str, Any]:
    return {
        "seq": ln.seq,
        "entry_no": ln.entry_no,
        "date": ln.date,
        "account": ln.account,
        "debit": format(ln.debit, ".2f"),
        "credit": format(ln.credit, ".2f"),
        "source_type": ln.source_type,
        "source_key": ln.source_key,
        "memo": ln.memo,
        "prev_hash": ln.prev_hash,
        "hash": ln.hash,
    }


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 60


@pytest.mark.parametrize("c", GOLDEN["sha256"], ids=lambda c: c["text"][:12] or "empty")
def test_sha256(c: dict[str, Any]) -> None:
    assert sha256_hex(c["text"]) == c["hex"]


@pytest.mark.parametrize("c", GOLDEN["canonical"], ids=lambda c: c["name"])
def test_canonical_and_hash(c: dict[str, Any]) -> None:
    ln = line_of(c["line"])
    assert canonical_line(c["prev"], ln) == c["canonical"]
    assert sha256_hex(canonical_line(c["prev"], ln)) == c["hash"]


@pytest.mark.parametrize("c", GOLDEN["seal"], ids=lambda c: c["name"])
def test_seal_entry(c: dict[str, Any]) -> None:
    h = c["head"]
    e = c["entry"]
    got = seal_entry(
        Head(h["seq"], h["entry_no"], h["hash"]),
        date=e["date"],
        memo=e["memo"],
        source_type=e["source_type"],
        source_key=e["source_key"],
        lines=lines_of(e["lines"]),
    )
    assert [dump(x) for x in got] == c["out"]


@pytest.mark.parametrize("c", GOLDEN["validate"], ids=lambda c: c["name"])
def test_validate_entry(c: dict[str, Any]) -> None:
    got = validate_entry(
        lines_of(c["lines"]), c["accounts"], date=c["date"], closed_months=set(c["closed_months"])
    )
    assert got == c["errors"]


@pytest.mark.parametrize("c", GOLDEN["verify"], ids=lambda c: c["name"])
def test_verify_chain(c: dict[str, Any]) -> None:
    got = verify_chain([line_of(x) for x in c["lines"]], [period_of(p) for p in c["periods"]])
    assert got.as_dict() == c["out"]


@pytest.mark.parametrize("c", GOLDEN["period"], ids=lambda c: c["name"])
def test_make_period(c: dict[str, Any]) -> None:
    p = make_period(c["month"], [line_of(x) for x in c["lines"]])
    assert p == period_of(c["out"])


@pytest.mark.parametrize("c", GOLDEN["reverse"])
def test_reverse(c: dict[str, Any]) -> None:
    assert reverse_lines(lines_of(c["lines"])) == lines_of(c["out"])
