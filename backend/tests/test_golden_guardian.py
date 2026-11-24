"""Guardian cabinet rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import guardian as G

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "guardian.json").read_text(encoding="utf-8")
)


def _dt(x: str) -> datetime:
    return datetime.fromisoformat(x)


def _d(x: str) -> date:
    return date.fromisoformat(x)


def _text(x: str) -> str:
    m = re.fullmatch(r"x(\d+)", x)
    return "x" * int(m.group(1)) if m else x


def _cases(key: str) -> Any:
    return pytest.mark.parametrize("case", GOLDEN[key], ids=[c["name"] for c in GOLDEN[key]])


def test_enough_cases() -> None:
    assert sum(len(v) for v in GOLDEN.values()) >= 75


@_cases("normalize_code")
def test_normalize_code(case: dict[str, Any]) -> None:
    assert G.normalize_code(case["in"]["text"]) == case["out"]


@_cases("code_format_valid")
def test_code_format_valid(case: dict[str, Any]) -> None:
    assert G.code_format_valid(case["in"]["code"]) is case["out"]


@_cases("code_state")
def test_code_state(case: dict[str, Any]) -> None:
    i = case["in"]
    got = G.code_state(
        expires_at=_dt(i["expires_at"]), now=_dt(i["now"]), used=i["used"], revoked=i["revoked"]
    )
    assert got == case["out"]


@_cases("link_decision")
def test_link_decision(case: dict[str, Any]) -> None:
    i = case["in"]
    got = G.link_decision(
        method=i["method"], phone_verified=i["phone_verified"], phone_matches=i["phone_matches"]
    )
    assert got == case["out"]


@_cases("phone_key")
def test_phone_key(case: dict[str, Any]) -> None:
    assert G.phone_key(case["in"]["phone"]) == case["out"]


@_cases("login_code_state")
def test_login_code_state(case: dict[str, Any]) -> None:
    i = case["in"]
    got = G.login_code_state(
        expires_at=_dt(i["expires_at"]),
        now=_dt(i["now"]),
        attempts=i["attempts"],
        max_attempts=i["max_attempts"],
        used=i["used"],
    )
    assert got == case["out"]


@_cases("absence_check")
def test_absence_check(case: dict[str, Any]) -> None:
    i = case["in"]
    got = G.absence_check(
        reason=_text(i["reason"]),
        lesson_start=_dt(i["lesson_start"]),
        now=_dt(i["now"]),
        lesson_status=i["lesson_status"],
        in_group=i["in_group"],
        existing_mark=i["existing_mark"],
    )
    assert got == case["out"]


@_cases("promise_check")
def test_promise_check(case: dict[str, Any]) -> None:
    i = case["in"]
    got = G.promise_check(
        today=_d(i["today"]),
        promise_date=_d(i["promise_date"]),
        outstanding=Decimal(i["outstanding"]),
        amount=None if i["amount"] is None else Decimal(i["amount"]),
        max_days=i["max_days"],
        has_active=i["has_active"],
    )
    assert got == case["out"]


@_cases("promise_state")
def test_promise_state(case: dict[str, Any]) -> None:
    i = case["in"]
    got = G.promise_state(
        status=i["status"],
        promise_date=_d(i["promise_date"]),
        today=_d(i["today"]),
        outstanding=Decimal(i["outstanding"]),
    )
    assert got == case["out"]


@_cases("makeup_options")
def test_makeup_options(case: dict[str, Any]) -> None:
    i = case["in"]
    cands = [G.SlotCandidate(c["id"], _d(c["date"]), c["start"], c["seats_left"]) for c in i["candidates"]]
    got = G.makeup_options(
        candidates=cands, today=_d(i["today"]), expires_on=_d(i["expires_on"]), limit=i["limit"]
    )
    assert got == case["out"]


@_cases("makeup_check")
def test_makeup_check(case: dict[str, Any]) -> None:
    i = case["in"]
    got = G.makeup_check(
        kind=i["kind"],
        status=i["status"],
        expires_on=_d(i["expires_on"]),
        today=_d(i["today"]),
        slot=i["slot"],
        options=i["options"],
    )
    assert got == case["out"]


@_cases("request_transition")
def test_request_transition(case: dict[str, Any]) -> None:
    assert G.request_transition(**case["in"]) == case["out"]


@_cases("request_effect")
def test_request_effect(case: dict[str, Any]) -> None:
    assert G.request_effect(**case["in"]) == case["out"]
