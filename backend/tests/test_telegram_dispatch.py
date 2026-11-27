"""The bot dispatcher: one webhook per bot, the role-and-center menu, refusal of stale buttons, duplicate updates, and
delivery through the bot a person can be reached on. Telegram is a fake transport: nothing real is ever called."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import pytest
import pytest_asyncio
from pydantic import SecretStr

from nazoratly.main import create_app
from nazoratly.secrets_box import SecretsBox
from nazoratly.telegram_setup import SetupError, setup_shared
from nazoratly.worker import Worker, WorkerSettings
from tests.conftest import Tenant, make_tenant
from tests.helpers import mk_student, ok, org_today
from tests.telegram_support import (
    chat_state,
    drop_bots,
    next_update_id,
    register_center,
    register_shared,
)
from tests.test_teacher_app import center, family, lesson, sql

SHARED_TOKEN = "700001:SHARED-test-token-not-real"
SHARED_SECRET = "shared-hook-secret-0000000000"
CENTER_TOKEN = "700002:CENTER-test-token-not-real"
CENTER_SECRET = "center-hook-secret-1111111111"


class Telegram:
    """The fake Bot API: records every call with the token it was made with; `answers` overrides a (token, method)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []  # token, method, payload
        self.answers: dict[tuple[str, str], tuple[int, dict[str, Any]]] = {}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        head, method = req.url.path.rsplit("/", 1)
        token = head.removeprefix("/bot")
        payload = json.loads(req.content) if req.content else {}
        self.calls.append((token, method, payload))
        status, body = self.answers.get((token, method), (200, {"ok": True, "result": {}}))
        return httpx.Response(status, json=body)

    def sent(self) -> list[dict[str, Any]]:
        return [p for _, m, p in self.calls if m in ("sendMessage", "editMessageText")]


class Server:
    def __init__(self, app: Any, http: httpx.AsyncClient, tg: Telegram, dsn: str) -> None:
        self.app, self.http, self.tg, self.dsn = app, http, tg, dsn
        self.box: SecretsBox = app.state.secrets_box
        self.shared = register_shared(dsn, self.box, SHARED_TOKEN, SHARED_SECRET)

    async def post(self, path: str, update: dict[str, Any], secret: str) -> httpx.Response:
        return await self.http.post(path, json=update, headers={"X-Telegram-Bot-Api-Secret-Token": secret})

    async def deliver(
        self, update: dict[str, Any], path: str | None = None, secret: str = SHARED_SECRET
    ) -> list[Any]:
        before = len(self.tg.calls)
        r = await self.post(path or self.shared, {"update_id": next_update_id(), **update}, secret)
        assert r.status_code == 200, r.text
        return self.tg.calls[before:]

    async def say(
        self, uid: int, text: str, path: str | None = None, secret: str = SHARED_SECRET, **extra: Any
    ) -> list[Any]:
        return await self.deliver(message(uid, text, **extra), path, secret)

    async def tap(
        self, uid: int, data: str, path: str | None = None, secret: str = SHARED_SECRET
    ) -> list[Any]:
        return await self.deliver(callback(uid, data), path, secret)


def message(uid: int, text: str, **extra: Any) -> dict[str, Any]:
    return {
        "message": {
            "message_id": 1,
            "from": {"id": uid, "first_name": "Aziza"},
            "chat": {"id": uid, "type": "private"},
            "text": text,
            **extra,
        }
    }


def callback(uid: int, data: str) -> dict[str, Any]:
    return {
        "callback_query": {
            "id": f"cb{uuid.uuid4().hex[:8]}",
            "from": {"id": uid},
            "message": {"message_id": 7, "chat": {"id": uid, "type": "private"}},
            "data": data,
        }
    }


def texts(calls: list[Any]) -> list[str]:
    return [p["text"] for _, m, p in calls if m in ("sendMessage", "editMessageText")]


def toasts(calls: list[Any]) -> list[str]:
    return [p.get("text", "") for _, m, p in calls if m == "answerCallbackQuery"]


def buttons(calls: list[Any]) -> dict[str, str]:
    """label -> callback data of every inline button sent."""
    out: dict[str, str] = {}
    for _, m, p in calls:
        if m in ("sendMessage", "editMessageText"):
            for row in p.get("reply_markup", {}).get("inline_keyboard", []):
                out.update({b["text"]: b["callback_data"] for b in row if "callback_data" in b})
    return out


def new_uid() -> int:
    return 20_000_000 + uuid.uuid4().int % 1_000_000_000


@pytest_asyncio.fixture
async def server(settings: Any, super_dsn: str) -> AsyncIterator[Server]:
    app = create_app(
        settings.model_copy(
            update={
                "telegram_bot_token": SecretStr(SHARED_TOKEN),
                "public_base_url": "https://nazoratly.test",
            }
        )
    )
    tg = Telegram()
    async with app.router.lifespan_context(app):
        app.state.outbound_transport = httpx.MockTransport(tg)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://bots") as http:
            try:
                yield Server(app, http, tg, super_dsn)
            finally:
                drop_bots(super_dsn)


class Dual:
    """One Telegram account: a teacher in two centers and a guardian in the first one."""

    uid: int
    a: Any
    b: Any
    a_name: str
    b_name: str


async def dual(client: httpx.AsyncClient, dsn: str) -> Dual:
    d = Dual()
    d.uid = new_uid()
    first, second = await make_tenant(client, "dual-a"), await make_tenant(client, "dual-b")
    d.a, d.b = await center(client, first), await center(client, second)
    by_profile = "SELECT org_id, user_id FROM teachers WHERE public_id = %s"
    ((_, user_a),) = sql(dsn, by_profile, (uuid.UUID(d.a.profile["id"]),))
    ((org_b, user_b),) = sql(dsn, by_profile, (uuid.UUID(d.b.profile["id"]),))
    sql(dsn, "UPDATE users SET telegram_user_id = %s WHERE id = %s", (d.uid, user_a))
    # the same person teaches in the second center too
    sql(
        dsn, "UPDATE memberships SET user_id = %s WHERE org_id = %s AND user_id = %s", (user_a, org_b, user_b)
    )
    sql(dsn, "UPDATE teachers SET user_id = %s WHERE org_id = %s AND user_id = %s", (user_a, org_b, user_b))
    sql(
        dsn,
        "UPDATE guardians SET telegram_chat_id = %s WHERE public_id = %s",
        (d.uid, uuid.UUID(d.a.guardian["id"])),
    )
    name = "SELECT name FROM organizations WHERE public_id = %s"
    d.a_name = sql(dsn, name, (uuid.UUID(first.org_id),))[0][0]
    d.b_name = sql(dsn, name, (uuid.UUID(second.org_id),))[0][0]
    return d


# ---- who gets in -------------------------------------------------------------------------------------------------------
async def test_a_wrong_or_foreign_secret_and_an_unknown_bot_are_refused(
    server: Server, tenant: Tenant
) -> None:
    own = register_center(server.dsn, server.box, tenant.org_id, CENTER_TOKEN, CENTER_SECRET, "markaz_bot")
    update = {"update_id": next_update_id(), **message(new_uid(), "/start")}
    for path, secret in (
        (server.shared, "wrong"),
        (server.shared, ""),
        (server.shared, CENTER_SECRET),  # another bot's secret
        (own, SHARED_SECRET),
    ):
        assert (await server.post(path, update, secret)).status_code == 403, (path, secret)
    for path in ("/hooks/bot/00000000-0000-0000-0000-000000000000", "/hooks/bot/not-a-uuid"):
        assert (await server.post(path, update, SHARED_SECRET)).status_code == 404
    sql(
        server.dsn,
        "UPDATE telegram_bots SET status = 'disabled', secret_ciphertext = NULL, token_hash = NULL "
        "WHERE username = 'markaz_bot'",
    )
    assert (await server.post(own, update, CENTER_SECRET)).status_code == 404  # a disconnected bot
    for old in ("/hooks/guardian-bot", "/hooks/teacher-bot"):  # the two old entries are gone
        assert (await server.post(old, update, SHARED_SECRET)).status_code == 404
    assert server.tg.calls == []


async def test_a_stranger_only_learns_how_to_link(server: Server) -> None:
    u = new_uid()
    for text in ("/start", "/bugun", "/qarz", "/rol", "salom"):
        got = await server.say(u, text)
        assert len(got) == 1 and "Ulanish uchun" in texts(got)[0], text
        assert got[0][2]["reply_markup"]["keyboard"][0][0]["request_contact"] is True
    for data in ("g:1:q", "t:1:m1", "role:g", f"role:t:{uuid.uuid4().hex}", "a:123456789012"):
        got = await server.tap(u, data)
        assert toasts(got) == ["Avval ulaning"] and "Ulanish uchun" in texts(got)[0], data


async def test_a_duplicate_update_runs_once_even_after_a_restart(server: Server, settings: Any) -> None:
    update = {"update_id": next_update_id(), **message(new_uid(), "/start")}
    assert (await server.post(server.shared, update, SHARED_SECRET)).status_code == 200
    assert (await server.post(server.shared, update, SHARED_SECRET)).status_code == 200
    assert len(server.tg.sent()) == 1
    # the memory is in the database: a second server process refuses it too
    other = create_app(settings.model_copy(update={"telegram_bot_token": SecretStr(SHARED_TOKEN)}))
    async with other.router.lifespan_context(other):
        other.state.outbound_transport = httpx.MockTransport(server.tg)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=other), base_url="http://two") as c:
            headers = {"X-Telegram-Bot-Api-Secret-Token": SHARED_SECRET}
            assert (await c.post(server.shared, json=update, headers=headers)).status_code == 200
    assert len(server.tg.sent()) == 1
    assert (
        await server.post(server.shared, {"message": {}}, SHARED_SECRET)
    ).status_code == 400  # no update id


# ---- one menu for role and center --------------------------------------------------------------------------------------
async def test_role_and_center_are_chosen_in_one_menu_and_old_buttons_stop_working(
    client: httpx.AsyncClient, server: Server
) -> None:
    d = await dual(client, server.dsn)
    today = org_today()
    la = await lesson(d.a.owner, d.a.group, today)
    await lesson(d.b.owner, d.b.group, today)
    menu = buttons(await server.say(d.uid, "/start"))
    assert set(menu) == {f"Ustoz – {d.a_name}", f"Ustoz – {d.b_name}", "Ota-ona"}

    home_a = await server.tap(d.uid, menu[f"Ustoz – {d.a_name}"])
    assert "/bugun" in texts(home_a)[0] and "🔄 Rol / markazni almashtirish" in buttons(home_a)
    today_a = await server.say(d.uid, "/bugun")
    assert d.a.group["name"] in texts(today_a)[0] and d.b.group["name"] not in texts(today_a)[0]
    open_a = next(v for v in buttons(today_a).values() if v.endswith(uuid.UUID(la["id"]).hex))
    assert buttons(await server.tap(d.uid, open_a))  # the roll call of center A opens

    pick_group = next(iter(buttons(await server.say(d.uid, "/xabar")).values()))
    students = buttons(await server.tap(d.uid, pick_group))
    templates = buttons(await server.tap(d.uid, next(iter(students.values()))))
    prompt = texts(await server.tap(d.uid, templates["✍️ Erkin matn"]))[0]

    # switch to center B: every button and open question of A is dead
    switch = buttons(await server.say(d.uid, "/rol"))
    await server.tap(d.uid, switch[f"Ustoz – {d.b_name}"])
    old = await server.tap(d.uid, open_a)
    assert "eskirgan" in toasts(old)[0] and not any(m == "editMessageText" for _, m, _ in old)
    count = "SELECT count(*) FROM teacher_guardian_messages"
    sent_before = sql(server.dsn, count)
    reply = await server.say(d.uid, "Ertaga kelsin", reply_to_message={"message_id": 3, "text": prompt})
    assert "eskirgan" in texts(reply)[0]
    assert sql(server.dsn, count) == sent_before
    # even with the current numbering, center A's lesson stays out of reach from center B (checked on the server)
    state = chat_state(server.dsn, d.uid)
    assert state is not None
    forged = await server.tap(d.uid, f"t:{state[2]}:l:{uuid.UUID(la['id']).hex}")
    assert not buttons(forged) and d.a.group["name"] not in " ".join(texts(forged))
    today_b = await server.say(d.uid, "/bugun")
    assert d.b.group["name"] in texts(today_b)[0] and d.a.group["name"] not in texts(today_b)[0]

    # as a guardian: teacher buttons of B are dead, the guardian side opens
    teacher_b_button = next(v for v in buttons(today_b).values() if v.startswith("t:"))
    home_g = await server.tap(d.uid, "role:g")
    state = chat_state(server.dsn, d.uid)
    assert state is not None and state[0] == "guardian"
    assert "eskirgan" in toasts(await server.tap(d.uid, teacher_b_button))[0]
    guardian_button = next(v for v in buttons(home_g).values() if v.startswith("g:"))
    await server.tap(d.uid, buttons(home_a)["🔄 Rol / markazni almashtirish"])
    await server.tap(d.uid, f"role:t:{uuid.UUID(d.a.owner.org_id).hex}")
    assert "eskirgan" in toasts(await server.tap(d.uid, guardian_button))[0]
    # back in A, the buttons of the earlier stay in A are still dead
    assert "eskirgan" in toasts(await server.tap(d.uid, open_a))[0]


async def test_the_menu_only_gives_roles_the_account_has(
    client: httpx.AsyncClient, server: Server, tenant: Tenant
) -> None:
    d = await dual(client, server.dsn)
    await server.say(d.uid, "/start")
    for data in (f"role:t:{uuid.UUID(tenant.org_id).hex}", f"role:t:{uuid.uuid4().hex}"):
        got = await server.tap(d.uid, data)
        assert toasts(got) == ["Bu rol sizga ochiq emas."], data
    state = chat_state(server.dsn, d.uid)
    assert state is not None and state[0] is None
    # a suspended membership disappears from the menu at once, even while chosen
    await server.tap(d.uid, f"role:t:{uuid.UUID(d.b.owner.org_id).hex}")
    sql(
        server.dsn,
        "UPDATE memberships SET status = 'suspended' WHERE org_id = "
        "(SELECT id FROM organizations WHERE public_id = %s) AND role = 'teacher'",
        (uuid.UUID(d.b.owner.org_id),),
    )
    got = await server.say(d.uid, "/bugun")
    assert set(buttons(got)) == {f"Ustoz – {d.a_name}", "Ota-ona"}


# ---- which bot sends -----------------------------------------------------------------------------------------------------
def worker(
    pg_server: dict[str, Any], transport: Callable[[httpx.Request], httpx.Response], key: str
) -> Worker:
    settings = WorkerSettings(
        database_url_worker=pg_server["worker"],
        telegram_bot_token=SHARED_TOKEN,  # type: ignore[arg-type]
        secrets_key=key,  # type: ignore[arg-type]
        worker_batch=100,
    )
    return Worker(settings, httpx.AsyncClient(transport=httpx.MockTransport(transport)))


async def deliveries(w: Worker) -> None:
    await w.open()
    try:
        while await w.run_once():
            pass
    finally:
        await w.close()


async def queue(owner: Tenant, chat: int) -> str:
    student = await mk_student(owner)
    g = await family(owner, student, chat)
    body = {"student_id": student["id"], "guardian_id": g["id"], "channel": "telegram", "body": "Salom"}
    return str((await ok(await owner.post("/v1/outbox", body), 201))["id"])


async def outbox(owner: Tenant, msg_id: str) -> dict[str, Any]:
    items = (await ok(await owner.get("/v1/outbox", params={"limit": 200})))["items"]
    return next(m for m in items if m["id"] == msg_id)


async def test_the_worker_sends_through_the_bot_the_person_can_be_reached_on(
    server: Server, tenant: Tenant, pg_server: dict[str, Any], settings: Any
) -> None:
    key = settings.secrets_key.get_secret_value()
    await deliveries(worker(pg_server, server.tg, key))  # whatever earlier tests left queued
    moved, not_moved, blocked = new_uid(), new_uid(), new_uid()
    own = register_center(server.dsn, server.box, tenant.org_id, CENTER_TOKEN, CENTER_SECRET, "markaz_bot")
    for u in (moved, blocked):  # they opened the center's bot
        await server.say(u, "/start", path=own, secret=CENTER_SECRET)
    ids = {u: await queue(tenant, u) for u in (moved, not_moved, blocked)}
    server.tg.calls.clear()

    def blocking(req: httpx.Request) -> httpx.Response:
        answer = server.tg(req)
        if CENTER_TOKEN in str(req.url) and json.loads(req.content)["chat_id"] == blocked:
            return httpx.Response(
                403, json={"ok": False, "description": "Forbidden: bot was blocked by the user"}
            )
        return answer

    await deliveries(worker(pg_server, blocking, key))
    used = {u: [t for t, _, p in server.tg.calls if p.get("chat_id") == u] for u in ids}
    assert used[moved] == [CENTER_TOKEN]
    assert used[not_moved] == [SHARED_TOKEN]
    assert used[blocked] == [CENTER_TOKEN, SHARED_TOKEN]  # the shared bot still reaches this person
    for msg_id in ids.values():
        assert (await outbox(tenant, msg_id))["status"] == "sent"

    # the center stops the shared bot: who has not opened its bot is reported as undeliverable, nothing is sent
    sql(server.dsn, "UPDATE telegram_bots SET shared_stopped_at = now() WHERE username = 'markaz_bot'")
    stranger = new_uid()
    lost = await queue(tenant, stranger)
    server.tg.calls.clear()
    await deliveries(worker(pg_server, server.tg, key))
    assert [p for _, _, p in server.tg.calls if p.get("chat_id") == stranger] == []
    row = await outbox(tenant, lost)
    assert row["status"] == "failed" and row["last_error"].startswith("undeliverable")


# ---- the shared bot's setup, and the token staying secret ------------------------------------------------------------
async def test_the_setup_command_registers_the_shared_bot_and_sets_its_webhook(server: Server) -> None:
    drop_bots(server.dsn)
    me = {"ok": True, "result": {"id": 700001, "username": "nz_shared_bot"}}
    server.tg.answers[(SHARED_TOKEN, "getMe")] = (200, me)
    settings, db = server.app.state.settings, server.app.state.db
    transport = server.app.state.outbound_transport
    done = await setup_shared(db, settings, server.box, transport)
    (hook,) = [p for _, m, p in server.tg.calls if m == "setWebhook"]
    assert hook["url"] == f"https://nazoratly.test/hooks/bot/{done.public_id}"
    assert "managed_bot" in hook["allowed_updates"]
    assert SHARED_TOKEN not in json.dumps(hook) and SHARED_TOKEN not in repr(done)
    ((cipher, hashed),) = sql(
        server.dsn,
        "SELECT secret_ciphertext, token_hash FROM telegram_bots WHERE org_id IS NULL AND status = 'active'",
    )
    assert SHARED_TOKEN.encode() not in bytes(cipher) and hook["secret_token"] != hashed
    assert server.box.decrypt(bytes(cipher)) == SHARED_TOKEN
    path = f"/hooks/bot/{done.public_id}"
    assert (await server.post(path, {"update_id": next_update_id()}, hook["secret_token"])).status_code == 200
    # running it again keeps the same address and replaces the secret
    again = await setup_shared(db, settings, server.box, transport)
    assert again.public_id == done.public_id
    assert (await server.post(path, {"update_id": next_update_id()}, hook["secret_token"])).status_code == 403
    with pytest.raises(SetupError):
        await setup_shared(db, settings.model_copy(update={"public_base_url": None}), server.box, transport)


async def test_the_token_never_reaches_responses_or_logs(
    server: Server, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    from nazoratly.observability import configure_logging

    configure_logging(server.app.state.settings.model_copy(update={"log_level": "DEBUG"}))
    try:
        with caplog.at_level(logging.DEBUG):
            seen: list[str] = []

            def failing(req: httpx.Request) -> httpx.Response:
                raise httpx.ConnectError(f"cannot reach {req.url}")

            for transport in (server.tg, failing):
                server.app.state.outbound_transport = httpx.MockTransport(transport)
                for secret in (SHARED_SECRET, "wrong"):
                    update = {"update_id": next_update_id(), **message(new_uid(), "/start")}
                    r = await server.post(server.shared, update, secret)
                    seen.append(r.text + str(r.headers))
        out = capsys.readouterr()
        everything = caplog.text + out.out + out.err + "".join(seen)
        assert "telegram_call_failed" in everything  # the failure itself is reported
        for hidden in (SHARED_TOKEN, SHARED_TOKEN.split(":")[1], SHARED_SECRET):
            assert hidden not in everything
    finally:
        configure_logging(server.app.state.settings.model_copy(update={"log_level": "WARNING"}))
