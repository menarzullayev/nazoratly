"""Schedule rules checked against the JSON cases shared with the TypeScript implementation."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import schedule as S

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "schedule.json").read_text(encoding="utf-8")
)


def _slot(d: dict[str, Any]) -> S.Slot:
    return S.Slot(d["id"], d["date"], d["start"], d["end"], d["room"], d["teacher"], d["cancelled"])


def _tp(d: dict[str, Any] | None) -> S.TeacherPay | None:
    return None if d is None else S.TeacherPay(d["id"], d["pay_model"], Decimal(d["pay_rate"]))


def test_golden_file_has_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 60


@pytest.mark.parametrize("case", GOLDEN["overlaps"], ids=lambda c: c["name"])
def test_overlaps(case: dict[str, Any]) -> None:
    assert S.overlaps(**case["in"]) is case["out"]


@pytest.mark.parametrize("case", GOLDEN["find_conflicts"], ids=lambda c: c["name"])
def test_find_conflicts(case: dict[str, Any]) -> None:
    got = S.find_conflicts(_slot(case["in"]["candidate"]), [_slot(o) for o in case["in"]["others"]])
    assert [{"kind": c.kind, "other_id": c.other_id} for c in got] == case["out"]


@pytest.mark.parametrize("case", GOLDEN["capacity_check"], ids=lambda c: c["name"])
def test_capacity_check(case: dict[str, Any]) -> None:
    assert S.capacity_check(**case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["effective_teacher"], ids=lambda c: c["name"])
def test_effective_teacher(case: dict[str, Any]) -> None:
    assert (S.effective_teacher(**case["in"]) or None) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["payroll_effect"], ids=lambda c: c["name"])
def test_payroll_effect(case: dict[str, Any]) -> None:
    i = case["in"]
    got = S.payroll_effect(
        kind=i["kind"],
        old_date=i["old_date"],
        new_date=i["new_date"],
        teacher=_tp(i["teacher"]),
        substitute=_tp(i["substitute"]),
    )
    assert [(e.teacher, e.month, e.delta) for e in got] == [
        (o["teacher"], o["month"], Decimal(o["delta"])) for o in case["out"]
    ]


@pytest.mark.parametrize("case", GOLDEN["change_message"], ids=lambda c: c["name"])
def test_change_message(case: dict[str, Any]) -> None:
    assert S.change_message(**case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["parse_schedule"], ids=lambda c: c["name"])
def test_parse_schedule(case: dict[str, Any]) -> None:
    got = S.parse_schedule(case["in"]["text"])
    assert (
        None if got is None else [{"weekday": s.weekday, "start": s.start, "end": s.end} for s in got]
    ) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["week_range"], ids=lambda c: c["name"])
def test_week_range(case: dict[str, Any]) -> None:
    assert S.week_range(**case["in"]) == (case["out"]["monday"], case["out"]["sunday"])


def test_unknown_kinds_are_rejected() -> None:
    with pytest.raises(ValueError):
        S.payroll_effect(kind="teleport", old_date="2026-12-01", new_date=None, teacher=None)
    with pytest.raises(ValueError):
        S.change_message(
            kind="substitute",
            guardian="G",
            student="S",
            group="Grp",
            old_date="2026-12-01",
            old_start="10:00",
            new_date=None,
            new_start=None,
            reason=None,
            center="C",
        )
