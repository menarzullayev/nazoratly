"""Capacity / waiting-list rules checked against the JSON cases shared with the TypeScript implementation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import capacity as C

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "capacity.json").read_text(encoding="utf-8")
)


def _entries(raw: list[dict[str, Any]]) -> list[C.WaitEntry]:
    return [C.WaitEntry(e["id"], e["group_id"], e["joined_at"], e["n"]) for e in raw]


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 34


@pytest.mark.parametrize("case", GOLDEN["free_seats"], ids=lambda c: c["name"])
def test_free_seats(case: dict[str, Any]) -> None:
    assert C.free_seats(case["in"]["capacity"], case["in"]["occupied"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["can_join_waitlist"], ids=lambda c: c["name"])
def test_can_join_waitlist(case: dict[str, Any]) -> None:
    assert C.can_join_waitlist(**case["in"]) is case["out"]


@pytest.mark.parametrize("case", GOLDEN["direct_enroll_allowed"], ids=lambda c: c["name"])
def test_direct_enroll_allowed(case: dict[str, Any]) -> None:
    assert C.direct_enroll_allowed(**case["in"]) is case["out"]


@pytest.mark.parametrize("case", GOLDEN["can_enroll_from_waitlist"], ids=lambda c: c["name"])
def test_can_enroll_from_waitlist(case: dict[str, Any]) -> None:
    assert C.can_enroll_from_waitlist(**case["in"]) is case["out"]


@pytest.mark.parametrize("case", GOLDEN["waitlist_order"], ids=lambda c: c["name"])
def test_waitlist_order(case: dict[str, Any]) -> None:
    assert [e.id for e in C.waitlist_order(_entries(case["in"]["entries"]))] == case["out"]


@pytest.mark.parametrize("case", GOLDEN["queue_position"], ids=lambda c: c["name"])
def test_queue_position(case: dict[str, Any]) -> None:
    assert C.queue_position(_entries(case["in"]["entries"]), case["in"]["id"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["offers"], ids=lambda c: c["name"])
def test_offers(case: dict[str, Any]) -> None:
    groups = [C.GroupSeats(g["group_id"], g["capacity"], g["occupied"]) for g in case["in"]["groups"]]
    got = C.offers(groups, _entries(case["in"]["entries"]))
    assert [
        {"group_id": o.group_id, "entry_id": o.entry_id, "position": o.position, "free_seats": o.free_seats}
        for o in got
    ] == case["out"]


@pytest.mark.parametrize("case", GOLDEN["offer_text"], ids=lambda c: c["name"])
def test_offer_text(case: dict[str, Any]) -> None:
    assert C.offer_text(**case["in"]) == case["out"]
