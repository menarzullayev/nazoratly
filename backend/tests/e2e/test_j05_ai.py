"""Journey 5: the AI assistant, end to end with a fake AI transport.

A center with debtors asks for reports: first without a worker (rule-based text with the reason), then with the AI (the prompt
carries only anonymous codes, the answer is restored locally), then the owner lets the AI see names, a bad answer falls back
to rules, the daily limit and the master switch are respected. Reports are immutable and nothing is ever sent."""

from __future__ import annotations

import json
from typing import Any

import httpx
import psycopg
import pytest

from nazoratly.ai_transport import AiUnavailable
from tests.conftest import Tenant
from tests.e2e.journeys import outbox_rows
from tests.helpers import mk_group, ok
from tests.test_ai_reports import debtor, generate, good_reply, switch
from tests.test_tenancy_and_staff import _add_staff, _login


async def test_ai_reports_anonymized_with_fallbacks_and_nothing_sent(
    client: httpx.AsyncClient, tenant: Tenant, fake_ai: Any, app: Any, super_dsn: str
) -> None:
    t = tenant
    grp = await mk_group(t, monthly_fee="900000")
    ali = await debtor(t, "Ali Valiyev", "1250000", -40, grp)
    bobur = await debtor(t, "Bobur Karimov", "300000", -3, grp)
    phone_guardian = await ok(
        await t.post("/v1/guardians", {"full_name": "Karimov Ota", "phone": "+998909998877"}), 201
    )

    # --- 1. no AI worker at all: every report is the rule-based text and says why
    app.state.ai_transport = None
    rules = await generate(t, "debt_followup")
    assert (rules["source"], rules["fallback_reason"], rules["anonymized"]) == (
        "rules",
        "ai_not_configured",
        True,
    )
    assert [i["name"] for i in rules["data"]["items"]] == [
        "Ali Valiyev",
        "Bobur Karimov",
    ]  # the oldest debt first

    # --- 2. the AI is on: the prompt carries codes, never names/phones/ids; the answer is restored locally
    fake = fake_ai(good_reply)
    ai = await generate(t, "debt_followup")
    assert (ai["source"], ai["fallback_reason"], ai["anonymized"]) == ("ai", None, True)
    assert ai["content"] == "Avval Ali Valiyev bilan bog'laning."
    drafts = {i["name"]: i["draft"] for i in ai["data"]["items"]}
    assert "1 250 000 so'm" in drafts["Ali Valiyev"] and "300 000 so'm" in drafts["Bobur Karimov"]
    for kind in ("weekly_summary", "churn_risk"):
        await generate(t, kind)
    for prompt in fake.prompts:
        for secret in (
            "Valiyev",
            "Karimov",
            "+998",
            ali["id"],
            bobur["id"],
            t.org_id,
            grp["name"],
            phone_guardian["id"],
        ):
            assert secret not in prompt, secret
    assert "S001: owes 1 250 000 so'm" in fake.prompts[0]

    # --- 3. only the owner can let the AI see names; the report says so and the prompt then holds them
    manager_data, manager_email = await _add_staff(t, "manager")
    manager = await _login(client, manager_email, "staff-password-123")
    assert (await manager.patch("/v1/settings", {"ai_sees_names": True})).status_code == 403
    assert manager_data["role"] == "manager"
    await switch(t, ai_sees_names=True)
    named = await generate(t, "debt_followup")
    assert named["anonymized"] is False and "S001 (Ali Valiyev)" in fake.prompts[-1]
    await switch(t, ai_sees_names=False)
    again = await generate(t, "debt_followup")
    assert again["anonymized"] is True and "Valiyev" not in fake.prompts[-1]

    # --- 4. failures never break the report: unusable answers, an unreachable worker, a link in the answer
    for reply, reason in (
        (AiUnavailable("worker down"), "ai_unavailable"),
        ("not json", "ai_bad_output"),
        (json.dumps({"text": "See https://evil.example/pay"}), "ai_bad_output"),
    ):
        fake_ai(reply)
        r = await generate(t, "debt_followup")
        assert (r["source"], r["fallback_reason"]) == ("rules", reason)
        assert "evil.example" not in json.dumps(r)
        assert r["data"]["items"][0]["draft_source"] == "rules"  # still a usable, exact-amount draft

    # --- 5. the master switch and the daily limit send the rest to rules
    fake = fake_ai(good_reply)
    await switch(t, ai_enabled=False)
    off = await generate(t, "weekly_summary")
    assert (off["source"], off["fallback_reason"]) == ("rules", "ai_disabled")
    before = len(fake.prompts)
    await switch(t, ai_enabled=True, ai_daily_limit=0)
    capped = await generate(t, "weekly_summary")
    assert capped["fallback_reason"] == "ai_limit_reached" and len(fake.prompts) == before

    # --- 6. history: newest first, immutable in the API and in the database
    history = await ok(await t.get("/v1/ai/reports"))
    assert len(history) >= 10 and history[0]["id"] == capped["id"]
    one = await ok(await t.get(f"/v1/ai/reports/{rules['id']}"))
    assert one["content"] == rules["content"]
    assert (await t.patch(f"/v1/ai/reports/{rules['id']}", {"content": "x"})).status_code in (404, 405)
    assert (await t.delete(f"/v1/ai/reports/{rules['id']}")).status_code in (404, 405)
    with psycopg.connect(super_dsn) as c, pytest.raises(psycopg.Error):
        c.execute("UPDATE ai_reports SET content = 'tampered' WHERE public_id = %s", (rules["id"],))

    # --- 7. Model B: all that AI work wrote text only; no message, no draft, nothing outbound
    assert (await ok(await t.get("/v1/outbox")))["items"] == []
    assert outbox_rows(super_dsn, t.org_id) == []
    assert (await ok(await t.get("/v1/agent-drafts")))["items"] == []
