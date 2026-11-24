"""Teacher-app rules checked against the JSON cases shared with the TypeScript implementation (sheets/)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nazoratly.rules import teacher

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "golden" / "teacher.json").read_text(encoding="utf-8")
)


def ids(c: dict[str, Any]) -> str:
    return str(c["name"])


@pytest.mark.parametrize("case", GOLDEN["invite_normalize"], ids=ids)
def test_invite_normalize(case: dict[str, Any]) -> None:
    assert teacher.normalize_invite_code(case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["invite_state"], ids=ids)
def test_invite_state(case: dict[str, Any]) -> None:
    assert teacher.invite_state(case["status"], case["expires_at"], case["now"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["invite_expires"], ids=ids)
def test_invite_expires(case: dict[str, Any]) -> None:
    assert teacher.invite_expires_at(case["now"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["unmarked"], ids=ids)
def test_unmarked(case: dict[str, Any]) -> None:
    assert teacher.unmarked_lessons(case["lessons"], case["now"], case["after_hours"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["reminder_text"], ids=ids)
def test_reminder_text(case: dict[str, Any]) -> None:
    assert teacher.reminder_text(case["group"], case["day"], case["start"], case["end"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["digest_due"], ids=ids)
def test_digest_due(case: dict[str, Any]) -> None:
    got = teacher.digest_due(case["now"], case["digest_after"], case["today_count"], case["already_sent"])
    assert got is case["out"]


@pytest.mark.parametrize("case", GOLDEN["digest_text"], ids=ids)
def test_digest_text(case: dict[str, Any]) -> None:
    assert teacher.digest_text(case["day"], case["items"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["template"], ids=ids)
def test_template(case: dict[str, Any]) -> None:
    assert teacher.render_template(case["code"], case["student"], case["group"], case["day"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["signed"], ids=ids)
def test_signed(case: dict[str, Any]) -> None:
    assert teacher.signed_text(case["text"], case["teacher"], case["center"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["message_check"], ids=ids)
def test_message_check(case: dict[str, Any]) -> None:
    i = dict(case["in"])
    rep = i.pop("text_repeat", None)
    if rep is not None:
        i["text"] = rep["char"] * rep["count"]
    assert teacher.check_message(**i) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["month_summary"], ids=ids)
def test_month_summary(case: dict[str, Any]) -> None:
    got = teacher.month_summary(case["minutes"], case["pay_model"], case["pay_rate"], case["collected"])
    assert got == case["out"]
