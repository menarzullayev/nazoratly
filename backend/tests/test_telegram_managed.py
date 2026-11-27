"""Telegram Managed Bots: a bot belongs to a center only when its owner asked, confirmed from the creating account, and
that account created it. Telegram is a fake transport: nothing real is ever called."""

# ruff: noqa: F811 - the `server` fixture is imported from the dispatcher tests

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.telegram_support import next_update_id
from tests.test_teacher_app import sql
from tests.test_telegram_center_bot import bot_answers, connect, live_rows
from tests.test_telegram_dispatch import (
    SHARED_SECRET,
    SHARED_TOKEN,
    Server,
    new_uid,
    server,  # noqa: F401 - fixture
    texts,
)

START = "/v1/telegram/bot/managed"


def managed_token(bot_id: int) -> str:
    return f"{bot_id}:MANAGED-test-token-not-real-0000"


def new_bot_id() -> int:
    return 800_000_000 + uuid.uuid4().int % 100_000_000


def telegram_knows(srv: Server, bot_id: int, username: str = "markaz_yangi_bot") -> str:
    """The manager can fetch this managed bot's token, and the token works."""
    token = managed_token(bot_id)
    srv.tg.answers[(SHARED_TOKEN, "getManagedBotToken")] = (200, {"ok": True, "result": token})
    bot_answers(srv, token, username)
    return token


async def created(srv: Server, creator: int, bot_id: int, secret: str = SHARED_SECRET) -> list[Any]:
    """The `managed_bot` update Telegram sends the manager."""
    update = {
        "managed_bot": {
            "user": {"id": creator, "is_bot": False, "first_name": "X"},
            "bot": {"id": bot_id, "is_bot": True, "first_name": "B", "username": "markaz_yangi_bot"},
        }
    }
    return await srv.deliver(update, srv.shared, secret)


async def ask(srv: Server, t: Tenant, **body: Any) -> dict[str, Any]:
    r = await srv.http.post(START, json=body, headers=t.h)
    assert r.status_code == 201, r.text
    return r.json()  # type: ignore[no-any-return]


async def confirm(srv: Server, uid: int, request: dict[str, Any]) -> list[Any]:
    return await srv.say(uid, f"/start {request['confirm_link'].split('start=')[1]}")


async def state(srv: Server, t: Tenant) -> str:
    return str((await srv.http.get(START, headers=t.h)).json()["status"])


async def test_the_owner_connects_a_managed_bot(server: Server, tenant: Tenant) -> None:
    request = await ask(server, tenant, suggested_username="Ziyo_markaz_bot")
    assert request["confirm_link"].startswith("https://t.me/nazoratly_test_bot?start=NZC-")
    assert await state(server, tenant) == "waiting_confirmation"
    owner_tg, bot_id = new_uid(), new_bot_id()
    token = telegram_knows(server, bot_id)
    got = await confirm(server, owner_tg, request)
    (sent,) = [p for _, m, p in got if m == "sendMessage"]
    assert "https://t.me/newbot/nazoratly_test_bot/Ziyo_markaz_bot?name=" in sent["text"]
    button = sent["reply_markup"]["keyboard"][0][0]["request_managed_bot"]
    assert button["suggested_username"] == "Ziyo_markaz_bot" and button["request_id"] == 1
    assert await state(server, tenant) == "waiting_creation"
    got = await created(server, owner_tg, bot_id)
    assert "markazga ulandi" in texts(got)[-1]
    assert [p for tk, m, p in got if m == "getManagedBotToken"] == [{"user_id": bot_id}]
    ((status, method, cipher, _),) = live_rows(server, tenant)
    assert (status, method) == ("active", "managed") and server.box.decrypt(bytes(cipher)) == token
    (hook,) = [p for tk, m, p in got if m == "setWebhook" and tk == token]
    assert hook["url"].startswith("https://nazoratly.test/hooks/bot/")
    shown = (await server.http.get("/v1/telegram/bot", headers=tenant.h)).text
    assert await state(server, tenant) == "connected" and token not in shown + json.dumps(texts(got))
    # Telegram says the token was replaced: the new one is fetched and the webhook set again
    newer = managed_token(bot_id) + "NEW"
    server.tg.answers[(SHARED_TOKEN, "getManagedBotToken")] = (200, {"ok": True, "result": newer})
    bot_answers(server, newer, "markaz_yangi_bot")
    await created(server, owner_tg, bot_id)
    ((_, _, cipher, _),) = live_rows(server, tenant)
    assert server.box.decrypt(bytes(cipher)) == newer
    # the bot's owner changes: the center is disconnected, the new holder gets nothing
    before = len(server.tg.calls)
    await created(server, new_uid(), bot_id)
    assert live_rows(server, tenant) == []
    assert not any(m == "getManagedBotToken" for _, m, _ in server.tg.calls[before:])


async def test_a_bot_somebody_else_creates_is_connected_to_no_center(
    server: Server, tenant: Tenant, tenant_b: Tenant
) -> None:
    owner_tg, stranger, bot_id = new_uid(), new_uid(), new_bot_id()
    telegram_knows(server, bot_id)
    request = await ask(server, tenant)
    # before anybody confirms, a creation is nobody's
    assert "hech bir markazga ulanmadi" in texts(await created(server, owner_tg, bot_id))[0]
    await confirm(server, owner_tg, request)
    # the confirmation code works once: a second account cannot take the request over
    assert "noto'g'ri" in texts(await confirm(server, stranger, request))[0]
    before = len(server.tg.calls)
    assert "hech bir markazga ulanmadi" in texts(await created(server, stranger, bot_id))[0]
    assert not any(m in ("getManagedBotToken", "setWebhook") for _, m, _ in server.tg.calls[before:])
    assert live_rows(server, tenant) == [] and live_rows(server, tenant_b) == []
    assert await state(server, tenant) == "waiting_creation"
    # the right account still can
    await created(server, owner_tg, bot_id)
    assert len(live_rows(server, tenant)) == 1 and live_rows(server, tenant_b) == []


async def test_expired_cancelled_and_forged_requests_connect_nothing(server: Server, tenant: Tenant) -> None:
    owner_tg, bot_id = new_uid(), new_bot_id()
    telegram_knows(server, bot_id)
    old = await ask(server, tenant)
    fresh = await ask(server, tenant)  # a new request cancels the earlier one
    assert "noto'g'ri" in texts(await confirm(server, owner_tg, old))[0]
    await confirm(server, owner_tg, fresh)
    sql(server.dsn, "UPDATE telegram_managed_requests SET expires_at = now() - interval '1 second'")
    assert await state(server, tenant) == "expired"
    assert "hech bir markazga ulanmadi" in texts(await created(server, owner_tg, bot_id))[0]
    assert live_rows(server, tenant) == []
    # the asker is no longer the owner when the bot is created
    again = await ask(server, tenant)
    await confirm(server, owner_tg, again)
    sql(
        server.dsn,
        "UPDATE memberships SET role = 'admin' WHERE org_id = (SELECT id FROM organizations WHERE public_id = %s)",
        (uuid.UUID(tenant.org_id),),
    )
    assert "hech bir markazga ulanmadi" in texts(await created(server, owner_tg, bot_id))[0]
    # a forged update without the shared bot's secret is refused outright
    update = {"update_id": next_update_id(), "managed_bot": {"user": {"id": owner_tg}, "bot": {"id": bot_id}}}
    assert (await server.post(server.shared, update, "wrong-secret")).status_code == 403
    assert live_rows(server, tenant) == []


async def test_a_managed_bot_update_to_a_center_bot_is_ignored(
    server: Server, tenant: Tenant, tenant_b: Tenant
) -> None:
    own = await connect(server, tenant)
    owner_tg, bot_id = new_uid(), new_bot_id()
    telegram_knows(server, bot_id)
    await confirm(server, owner_tg, await ask(server, tenant_b))
    before = len(server.tg.calls)
    update = {"managed_bot": {"user": {"id": owner_tg}, "bot": {"id": bot_id, "username": "x_bot"}}}
    assert await server.deliver(update, own.path, own.secret) == []
    assert server.tg.calls[before:] == [] and live_rows(server, tenant_b) == []
    # and the confirmation code only works in the shared bot
    other = await ask(server, tenant_b)
    got = await server.say(
        new_uid(), f"/start {other['confirm_link'].split('start=')[1]}", own.path, own.secret
    )
    assert "umumiy nazoratly boti uchun" in texts(got)[0]


async def test_a_failed_connection_is_reported_and_can_be_retried(server: Server, tenant: Tenant) -> None:
    owner_tg, bot_id = new_uid(), new_bot_id()
    token = telegram_knows(server, bot_id)
    server.tg.answers[(token, "setWebhook")] = (400, {"ok": False, "description": "Bad Request: bad webhook"})
    await confirm(server, owner_tg, await ask(server, tenant))
    got = await created(server, owner_tg, bot_id)
    assert "ulab bo'lmadi" in texts(got)[-1] and token not in texts(got)[-1]
    status = (await server.http.get(START, headers=tenant.h)).json()
    assert status["status"] == "failed" and token not in status["failure"] and live_rows(server, tenant) == []
    del server.tg.answers[(token, "setWebhook")]
    await created(server, owner_tg, bot_id)
    assert len(live_rows(server, tenant)) == 1


async def test_requests_need_the_owner_the_shared_bot_and_a_free_center(
    client: httpx.AsyncClient, server: Server, tenant: Tenant
) -> None:
    assert (await server.http.post(START, json={})).status_code == 401
    assert (await server.http.get(START, headers=tenant.h)).status_code == 404
    r = await server.http.post(START, json={"suggested_username": "no spaces bot"}, headers=tenant.h)
    assert r.status_code == 422
    await connect(server, tenant)
    r = await server.http.post(START, json={}, headers=tenant.h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "another_bot_connected"
    sql(
        server.dsn,
        "UPDATE telegram_bots SET status = 'disabled', secret_ciphertext = NULL, token_hash = NULL",
    )
    r = await server.http.post(START, json={}, headers=tenant.h)  # no shared bot to manage with
    assert r.status_code == 409 and r.json()["error"]["code"] == "telegram_not_configured"
