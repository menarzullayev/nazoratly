"""AI assistant reports through the real HTTP API and database, with a FAKE AI transport (CI never calls `claude -p`).

The numbers and the order come from the shared rules (tests/golden/insights.json); these tests check that facts are loaded
correctly, the fallbacks (disabled, not configured, limit, unreachable, unusable answer), the privacy switch, permissions,
tenant isolation and that nothing is ever sent."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Callable
from datetime import timedelta
from typing import Any

import httpx
import psycopg
import pytest
import pytest_asyncio

from nazoratly.ai_transport import AiUnavailable
from tests.conftest import Tenant, make_tenant
from tests.helpers import enroll, mk_group, mk_student, ok, org_today
from tests.test_packages import lesson, mark
from tests.test_plans import TODAY as PLANS_TODAY
from tests.test_plans import charge as plans_charge
from tests.test_plans import pay
from tests.test_tenancy_and_staff import _add_staff, _login

TODAY = org_today()


def d(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


async def charge(t: Tenant, student_id: str, amount: str = "900000", due: int = -40) -> dict[str, Any]:
    """`tests.test_plans.charge` counts offsets from the UTC date; these reports count from the organization's
    date. They differ between 19:00 and 24:00 UTC, so shift the offset to land on the organization's day."""
    return await plans_charge(t, student_id, amount, due + (TODAY - PLANS_TODAY).days)


class FakeAi:
    """The AI worker's stand-in: records every prompt and answers from a function (or raises)."""

    model = "fake-haiku"

    def __init__(self, reply: Callable[[str], str] | Exception | str) -> None:
        self.reply = reply
        self.prompts: list[str] = []
        self.systems: list[str] = []

    async def complete(self, *, system: str, prompt: str) -> str:
        self.systems.append(system)
        self.prompts.append(prompt)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply(prompt) if callable(self.reply) else self.reply


def good_reply(prompt: str) -> str:
    """A well-behaved model: names the first code in the text and writes a draft stating the exact amount for each."""
    codes = re.findall(r"^(S\d{3})", prompt, re.MULTILINE)
    items: dict[str, str] = {}
    for code in codes:
        m = re.search(rf"^{code}[^\n]*?owes ([\d ]+) so'm", prompt, re.MULTILINE)
        items[code] = (
            f"Assalomu alaykum! {code} uchun {m.group(1).strip()} so'm to'lov bor. Sanani kelishib olamizmi?"
            if m
            else f"{code} bilan gaplashing."
        )
    first = codes[0] if codes else "hech kim"
    return json.dumps({"text": f"Avval {first} bilan bog'laning.", "items": items})


@pytest_asyncio.fixture
async def fake_ai(app: Any) -> AsyncIterator[Callable[[Any], FakeAi]]:
    """Installs a fake transport on the app for the duration of one test."""
    before = getattr(app.state, "ai_transport", None)

    def install(reply: Any) -> FakeAi:
        fake = FakeAi(reply)
        app.state.ai_transport = fake
        return fake

    try:
        yield install
    finally:
        app.state.ai_transport = before


async def generate(t: Tenant, kind: str, status: int = 201) -> dict[str, Any]:
    return await ok(await t.post("/v1/ai/reports", {"kind": kind}), status)


async def switch(t: Tenant, **changes: Any) -> dict[str, Any]:
    return await ok(await t.patch("/v1/settings", changes))


async def debtor(
    t: Tenant, name: str, amount: str = "900000", due: int = -40, group: dict[str, Any] | None = None
) -> dict[str, Any]:
    grp = group or await mk_group(t, monthly_fee="900000")
    st = await mk_student(t, name)
    await enroll(t, grp["id"], st["id"], d(-100))
    await charge(t, st["id"], amount, due)
    st["group"] = grp
    return st


# ---- rule-based reports (no AI configured) ------------------------------------------------------------------------
async def test_without_a_worker_every_report_is_rule_based_with_the_reason(tenant: Tenant, app: Any) -> None:
    app.state.ai_transport = None
    st = await debtor(tenant, "Ali Valiyev")
    await pay(tenant, st["id"], "250000")
    for kind in ("weekly_summary", "debt_followup", "churn_risk"):
        r = await generate(tenant, kind)
        assert (r["source"], r["model"], r["fallback_reason"]) == ("rules", None, "ai_not_configured")
        assert r["kind"] == kind and r["period_end"] == TODAY.isoformat() and r["anonymized"] is True


async def test_weekly_summary_numbers_come_from_the_books(tenant: Tenant, app: Any) -> None:
    app.state.ai_transport = None
    st = await debtor(tenant, "Ali Valiyev", "900000", -40)
    await pay(tenant, st["id"], "250000")
    r = await generate(tenant, "weekly_summary")
    s = r["data"]["summary"]
    assert s["income"] == 250000 and s["income_prev"] == 0 and s["income_change_percent"] is None
    assert (s["unpaid"], s["unpaid_total"], s["overdue"]) == (1, 650000, 1)
    assert s["attendance_percent"] is None and s["expenses"] == 0 and s["net"] == 250000
    assert r["content"].splitlines()[0] == "Haftalik xulosa (oxirgi 7 kun):"
    assert "Tushum: 250 000 so'm (o'tgan hafta: 0 so'm)." in r["content"]
    assert "Qarzdorlar: 1 ta, jami 650 000 so'm, shundan muddati o'tgan: 1 ta." in r["content"]
    assert [x["name"] for x in r["data"]["top_debtors"]] == ["Ali Valiyev"]


async def test_debt_followup_orders_by_urgency_and_drafts_the_tone(tenant: Tenant, app: Any) -> None:
    app.state.ai_transport = None
    grp = await mk_group(tenant, monthly_fee="900000")
    old = await debtor(tenant, "Eski Qarz", "300000", -40, grp)
    soft = await debtor(tenant, "Yangi Qarz", "300000", -3, grp)
    soon = await debtor(tenant, "Hali Muddat Bor", "300000", 10, grp)
    paid = await mk_student(tenant, "To'lagan")
    await enroll(tenant, grp["id"], paid["id"], d(-100))
    r = await generate(tenant, "debt_followup")
    items = r["data"]["items"]
    assert [(i["name"], i["tone"], i["age_days"]) for i in items] == [
        ("Eski Qarz", "final", 40),
        ("Yangi Qarz", "soft", 3),
        ("Hali Muddat Bor", "reminder", 0),
    ]
    assert (
        items[0]["student_id"] == old["id"]
        and items[1]["student_id"] == soft["id"]
        and items[2]["student_id"] == soon["id"]
    )
    assert all(i["draft_source"] == "rules" for i in items)
    assert items[0]["draft"].startswith("Assalomu alaykum! Eski Qarz uchun 300 000 so'm qarz 40 kundan beri")
    assert "1. Eski Qarz: 300 000 so'm, 40 kun, ohang: so'nggi." in r["content"]
    assert "To'lagan" not in r["content"]


async def test_churn_risk_lists_attendance_drop_debt_and_a_trial_without_answer(
    tenant: Tenant, app: Any
) -> None:
    app.state.ai_transport = None
    grp = await mk_group(tenant, monthly_fee="900000")
    drifting = await debtor(tenant, "Susayayotgan", "900000", -25, grp)
    steady = await mk_student(tenant, "Barqaror")
    await enroll(tenant, grp["id"], steady["id"], d(-100))
    waiting = await mk_student(tenant, "Sinovdan Keyin")
    await enroll(tenant, grp["id"], waiting["id"], d(-20), status="trial")
    offsets = [(-50, "present", "present"), (-45, "present", "present"), (-40, "present", "present"), (-35, "present", "present"),
               (-20, "absent", "present"), (-15, "absent", "present"), (-10, "absent", "present"), (-5, "absent", "present")]  # fmt: skip
    for off, drift_status, steady_status in offsets:
        les = await lesson(tenant, grp["id"], off)
        await mark(tenant, les["id"], drifting["id"], drift_status)
        await mark(tenant, les["id"], steady["id"], steady_status)
    r = await generate(tenant, "churn_risk")
    items = {i["name"]: i for i in r["data"]["items"]}
    assert set(items) == {"Susayayotgan", "Sinovdan Keyin"}  # a steady student is not a risk
    d1 = items["Susayayotgan"]
    assert (d1["score"], d1["level"], d1["reasons"]) == (65, "high", ["attendance_drop", "debt"])
    assert (d1["attendance_recent"], d1["attendance_prev"]) == (0, 100)
    t1 = items["Sinovdan Keyin"]  # 20 days on trial, limit 7 days: 13 over -> 10 + 20 points
    assert (t1["score"], t1["level"], t1["reasons"]) == (30, "medium", ["trial_no_answer"])
    assert t1["attendance_recent"] is None
    assert [i["name"] for i in r["data"]["items"]] == ["Susayayotgan", "Sinovdan Keyin"]
    assert r["content"].splitlines()[1].startswith("1. Susayayotgan: xavf balli 65 (yuqori)")


async def test_excused_absences_and_cancelled_lessons_do_not_count_as_a_drop(
    tenant: Tenant, app: Any
) -> None:
    app.state.ai_transport = None
    grp = await mk_group(tenant, monthly_fee="900000")
    st = await mk_student(tenant, "Uzrli")
    await enroll(tenant, grp["id"], st["id"], d(-100))
    for off, status in [
        (-50, "present"),
        (-45, "present"),
        (-20, "excused"),
        (-15, "excused"),
        (-10, "excused"),
    ]:
        les = await lesson(tenant, grp["id"], off)
        await mark(tenant, les["id"], st["id"], status)
    r = await generate(tenant, "churn_risk")
    assert r["data"]["items"] == []
    assert r["fallback_reason"] == "ai_not_configured"


async def test_an_empty_center_gets_a_plain_report_and_no_ai_call(tenant: Tenant, fake_ai: Any) -> None:
    fake = fake_ai(good_reply)
    for kind, text in (
        ("debt_followup", "Qarzdor o'quvchi yo'q."),
        ("churn_risk", "Ketish xavfi ostidagi o'quvchi yo'q."),
    ):
        r = await generate(tenant, kind)
        assert (r["source"], r["fallback_reason"], r["content"]) == ("rules", "nothing_to_report", text)
    assert fake.prompts == []


# ---- AI-written reports -------------------------------------------------------------------------------------------
async def test_an_ai_report_is_restored_locally_and_drafts_state_the_exact_amount(
    tenant: Tenant, fake_ai: Any
) -> None:
    fake = fake_ai(good_reply)
    a = await debtor(tenant, "Ali Valiyev", "1250000", -40)
    b = await debtor(tenant, "Bobur Karimov", "300000", -3, a["group"])
    r = await generate(tenant, "debt_followup")
    assert (r["source"], r["model"], r["fallback_reason"], r["anonymized"]) == (
        "ai",
        "fake-haiku",
        None,
        True,
    )
    assert r["content"] == "Avval Ali Valiyev bilan bog'laning."  # S001 restored to the real name
    first, second = r["data"]["items"]
    assert (first["student_id"], first["draft_source"]) == (a["id"], "ai")
    assert (
        first["draft"]
        == "Assalomu alaykum! Ali Valiyev uchun 1 250 000 so'm to'lov bor. Sanani kelishib olamizmi?"
    )
    assert (second["student_id"], second["draft_source"]) == (b["id"], "ai")
    assert "Bobur Karimov uchun 300 000 so'm" in second["draft"]
    assert len(fake.prompts) == 1 and "Never suggest fines" in fake.systems[0]


async def test_the_prompt_is_anonymized_by_default(tenant: Tenant, fake_ai: Any) -> None:
    fake = fake_ai(good_reply)
    st = await debtor(tenant, "Maxfiy Ismli", "900000", -40)
    await ok(await tenant.post("/v1/guardians", {"full_name": "Maxfiy Ota", "phone": "+998901112233"}), 201)
    for kind in ("weekly_summary", "debt_followup", "churn_risk"):
        await generate(tenant, kind)
    assert len(fake.prompts) >= 2
    for prompt in fake.prompts:
        for secret in ("Maxfiy", "+998", st["id"], tenant.org_id, st["group"]["name"], st["group"]["id"]):
            assert secret not in prompt, secret
    assert "S001: owes 900 000 so'm" in "\n".join(fake.prompts)


async def test_the_center_can_let_the_ai_see_names_and_the_report_says_so(
    tenant: Tenant, fake_ai: Any
) -> None:
    fake = fake_ai(good_reply)
    await debtor(tenant, "Ali Valiyev")
    s = await switch(tenant, ai_sees_names=True)
    assert s["ai_sees_names"] is True
    r = await generate(tenant, "debt_followup")
    assert "S001 (Ali Valiyev): owes 900 000 so'm" in fake.prompts[0]
    assert r["anonymized"] is False and r["source"] == "ai"
    assert r["content"] == "Avval Ali Valiyev bilan bog'laning."
    await switch(tenant, ai_sees_names=False)
    r2 = await generate(tenant, "debt_followup")
    assert "Ali" not in fake.prompts[1] and r2["anonymized"] is True


async def test_a_draft_without_the_exact_amount_or_with_a_link_keeps_the_rule_draft(
    tenant: Tenant, fake_ai: Any
) -> None:
    grp = await mk_group(tenant, monthly_fee="900000")
    await debtor(tenant, "Birinchi", "900000", -40, grp)
    await debtor(tenant, "Ikkinchi", "500000", -30, grp)
    await debtor(tenant, "Uchinchi", "400000", -20, grp)
    reply = {
        "text": "Matn.",
        "items": {
            "S001": "Assalomu alaykum! Iltimos to'lang.",  # no amount
            "S002": "Assalomu alaykum! 500 000 so'm: https://evil.example/pay",  # a link
            "S003": "Assalomu alaykum! S003 uchun 400 000 so'm qoldi.",  # fine
            "S999": "Hech kim uchun matn",  # a code that was never issued
        },
    }
    fake_ai(json.dumps(reply))
    r = await generate(tenant, "debt_followup")
    sources = {i["name"]: i["draft_source"] for i in r["data"]["items"]}
    assert sources == {"Birinchi": "rules", "Ikkinchi": "rules", "Uchinchi": "ai"}
    assert "evil.example" not in json.dumps(r)
    assert "S999" not in json.dumps(r)


async def test_unknown_codes_in_the_answer_are_left_as_text_not_guessed(tenant: Tenant, fake_ai: Any) -> None:
    await debtor(tenant, "Ali Valiyev")
    fake_ai(json.dumps({"text": "S001 va S777 haqida.", "items": {}}))
    r = await generate(tenant, "debt_followup")
    assert r["content"] == "Ali Valiyev va S777 haqida."


async def test_churn_suggestions_are_stored_per_student(tenant: Tenant, fake_ai: Any) -> None:
    grp = await mk_group(tenant, monthly_fee="900000")
    st = await debtor(tenant, "Qarzdor Sinovchi", "900000", -35, grp)
    fake_ai(lambda p: json.dumps({"text": "Umumiy fikr.", "items": {"S001": "Ota-onasi bilan gaplashing."}}))
    r = await generate(tenant, "churn_risk")
    item = r["data"]["items"][0]
    assert item["student_id"] == st["id"] and (item["suggestion"], item["suggestion_source"]) == (
        "Ota-onasi bilan gaplashing.",
        "ai",
    )


async def test_weekly_summary_prompt_carries_the_facts_and_no_per_student_texts(
    tenant: Tenant, fake_ai: Any
) -> None:
    fake = fake_ai(
        lambda p: json.dumps({"text": "Hafta yaxshi o'tdi.", "items": {"S001": "e'tiborga olinmaydi"}})
    )
    st = await debtor(tenant, "Ali Valiyev")
    await pay(tenant, st["id"], "250000")
    r = await generate(tenant, "weekly_summary")
    assert r["source"] == "ai" and r["content"] == "Hafta yaxshi o'tdi."
    assert (
        "Tushum: 250 000 so'm" in fake.prompts[0]
        and "Largest open debt: S001 owes 650 000 so'm" in fake.prompts[0]
    )
    assert "items" not in r["data"]  # the weekly report has no per-student texts


# ---- fallbacks ----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("reply", "reason"),
    [
        (AiUnavailable("worker down"), "ai_unavailable"),
        ("this is not json", "ai_bad_output"),
        ("[1, 2]", "ai_bad_output"),
        ('{"items": {}}', "ai_bad_output"),
        ('{"text": "   "}', "ai_bad_output"),
        ('{"text": 5}', "ai_bad_output"),
        ('{"text": "Batafsil: https://evil.example"}', "ai_bad_output"),
        ('{"text": "Batafsil: www.evil.example"}', "ai_bad_output"),
    ],
)
async def test_an_unusable_ai_answer_falls_back_to_rules_with_the_reason(
    tenant: Tenant, fake_ai: Any, reply: Any, reason: str
) -> None:
    fake_ai(reply)
    await debtor(tenant, "Ali Valiyev")
    r = await generate(tenant, "debt_followup")
    assert (r["source"], r["model"], r["fallback_reason"]) == ("rules", None, reason)
    assert "1. Ali Valiyev: 900 000 so'm" in r["content"]


async def test_code_fenced_json_is_accepted(tenant: Tenant, fake_ai: Any) -> None:
    fake_ai('```json\n{"text": "Yaxshi.", "items": {}}\n```')
    await debtor(tenant, "Ali Valiyev")
    r = await generate(tenant, "debt_followup")
    assert (r["source"], r["content"]) == ("ai", "Yaxshi.")


async def test_the_center_can_switch_the_ai_off(tenant: Tenant, fake_ai: Any) -> None:
    fake = fake_ai(good_reply)
    await debtor(tenant, "Ali Valiyev")
    await switch(tenant, ai_enabled=False)
    r = await generate(tenant, "debt_followup")
    assert (r["source"], r["fallback_reason"]) == ("rules", "ai_disabled")
    assert fake.prompts == []  # the worker is never called
    await switch(tenant, ai_enabled=True)
    assert (await generate(tenant, "debt_followup"))["source"] == "ai"


async def test_the_daily_limit_sends_the_rest_to_the_rule_based_text(tenant: Tenant, fake_ai: Any) -> None:
    fake = fake_ai(good_reply)
    await debtor(tenant, "Ali Valiyev")
    await switch(tenant, ai_daily_limit=2)
    sources = [(await generate(tenant, "debt_followup")) for _ in range(3)]
    assert [r["source"] for r in sources] == ["ai", "ai", "rules"]
    assert sources[2]["fallback_reason"] == "ai_limit_reached"
    assert len(fake.prompts) == 2
    await switch(tenant, ai_daily_limit=0)
    assert (await generate(tenant, "weekly_summary"))["fallback_reason"] == "ai_limit_reached"


async def test_failed_ai_attempts_do_not_use_up_the_daily_limit(tenant: Tenant, fake_ai: Any) -> None:
    await debtor(tenant, "Ali Valiyev")
    await switch(tenant, ai_daily_limit=1)
    fake_ai(AiUnavailable("down"))
    assert (await generate(tenant, "debt_followup"))["fallback_reason"] == "ai_unavailable"
    fake_ai(good_reply)
    assert (await generate(tenant, "debt_followup"))["source"] == "ai"


# ---- nothing is sent ----------------------------------------------------------------------------------------------
async def test_generating_reports_sends_nothing_and_drafts_nothing(
    tenant: Tenant, fake_ai: Any, super_dsn: str
) -> None:
    fake_ai(good_reply)

    def counts() -> tuple[int, int]:
        with psycopg.connect(super_dsn) as c:
            out = c.execute("SELECT count(*) FROM outbox_messages").fetchone()
            drafts = c.execute("SELECT count(*) FROM agent_drafts").fetchone()
            assert out is not None and drafts is not None
            return int(out[0]), int(drafts[0])

    await debtor(tenant, "Ali Valiyev")
    before = counts()
    for kind in ("weekly_summary", "debt_followup", "churn_risk"):
        await generate(tenant, kind)
    assert counts() == before


# ---- settings, permissions, isolation, validation -----------------------------------------------------------------
async def test_ai_switches_default_to_private_and_only_the_owner_can_change_them(
    tenant: Tenant, client: httpx.AsyncClient
) -> None:
    s = await ok(await tenant.get("/v1/settings"))
    assert (s["ai_enabled"], s["ai_sees_names"], s["ai_daily_limit"]) == (True, False, 20)
    _, manager_email = await _add_staff(tenant, "manager")
    manager = await _login(client, manager_email, "staff-password-123", tenant.org_id)
    assert (await manager.patch("/v1/settings", {"ai_sees_names": True})).status_code == 403
    assert (await manager.patch("/v1/settings", {"ai_enabled": False})).status_code == 403
    assert (
        await manager.patch("/v1/settings", {"trial_free_days": 9})
    ).status_code == 200  # other settings unchanged
    _, admin_email = await _add_staff(tenant, "admin")
    admin = await _login(client, admin_email, "staff-password-123", tenant.org_id)
    assert (
        await admin.patch("/v1/settings", {"ai_sees_names": True})
    ).status_code == 403  # admin has no org:manage
    assert (await ok(await tenant.get("/v1/settings")))["ai_sees_names"] is False


async def test_ai_switch_validation(tenant: Tenant) -> None:
    for bad in (
        {"ai_daily_limit": 201},
        {"ai_daily_limit": -1},
        {"ai_enabled": "maybe"},
        {"ai_sees_names": 5},
    ):
        assert (await tenant.patch("/v1/settings", bad)).status_code == 422, bad
    assert (await ok(await tenant.patch("/v1/settings", {"ai_daily_limit": 0})))["ai_daily_limit"] == 0


async def test_permissions(tenant: Tenant, client: httpx.AsyncClient, app: Any) -> None:
    app.state.ai_transport = None
    for role, status in (("teacher", 403), ("viewer", 201), ("accountant", 201), ("manager", 201)):
        _, email = await _add_staff(tenant, role)
        who = await _login(client, email, "staff-password-123", tenant.org_id)
        assert (await who.post("/v1/ai/reports", {"kind": "weekly_summary"})).status_code == status, role
        assert (await who.get("/v1/ai/reports")).status_code == (403 if status == 403 else 200), role
    anon = await client.post("/v1/ai/reports", json={"kind": "weekly_summary"})
    assert anon.status_code == 401


async def test_reports_are_tenant_isolated(tenant: Tenant, tenant_b: Tenant, app: Any) -> None:
    app.state.ai_transport = None
    mine = await generate(tenant, "weekly_summary")
    assert (await tenant_b.get(f"/v1/ai/reports/{mine['id']}")).status_code == 404
    assert await ok(await tenant_b.get("/v1/ai/reports")) == []
    assert (await ok(await tenant.get(f"/v1/ai/reports/{mine['id']}")))["id"] == mine["id"]


async def test_list_filters_orders_and_limits(tenant: Tenant, app: Any) -> None:
    app.state.ai_transport = None
    a = await generate(tenant, "weekly_summary")
    b = await generate(tenant, "debt_followup")
    c = await generate(tenant, "weekly_summary")
    assert [r["id"] for r in await ok(await tenant.get("/v1/ai/reports"))] == [c["id"], b["id"], a["id"]]
    assert [
        r["id"] for r in await ok(await tenant.get("/v1/ai/reports", params={"kind": "weekly_summary"}))
    ] == [c["id"], a["id"]]
    assert [r["id"] for r in await ok(await tenant.get("/v1/ai/reports", params={"limit": 1}))] == [c["id"]]
    for bad in ({"limit": 0}, {"limit": 101}, {"kind": "bogus"}):
        assert (await tenant.get("/v1/ai/reports", params=bad)).status_code == 422


async def test_request_validation(tenant: Tenant) -> None:
    for body in ({"kind": "bogus"}, {}, {"kind": 5}, {"kind": "weekly_summary", "extra": 1}):
        assert (await tenant.post("/v1/ai/reports", body)).status_code == 422, body
    assert (await tenant.get("/v1/ai/reports/not-a-uuid")).status_code == 422
    assert (await tenant.get("/v1/ai/reports/00000000-0000-0000-0000-000000000000")).status_code == 404


async def test_a_second_tenant_in_the_same_run_is_not_counted_in_my_limit(
    tenant: Tenant, fake_ai: Any, client: httpx.AsyncClient
) -> None:
    fake_ai(good_reply)
    other = await make_tenant(client, "limit")
    await debtor(other, "Boshqa Markaz")
    await debtor(tenant, "Ali Valiyev")
    await switch(tenant, ai_daily_limit=1)
    assert (await generate(other, "debt_followup"))["source"] == "ai"
    assert (await generate(tenant, "debt_followup"))["source"] == "ai"
