"""A center's own bot: connecting it by token, the staged move from the shared bot, what it may reach, and sign-ins
through it. Telegram is a fake transport: nothing real is ever called."""

# ruff: noqa: F811 - the `server` fixture is imported from the dispatcher tests

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import time
import uuid
from typing import Any
from urllib.parse import urlencode

import httpx
import pytest

from tests.conftest import Tenant, make_tenant
from tests.helpers import mk_student, mk_teacher, ok
from tests.telegram_support import chat_state, next_update_id
from tests.test_teacher_app import center, family, invite, sql
from tests.test_telegram_dispatch import (
    CENTER_TOKEN,
    SHARED_SECRET,
    SHARED_TOKEN,
    Server,
    buttons,
    dual,
    message,
    new_uid,
    server,  # noqa: F401 - fixture
    texts,
    toasts,
)

OTHER_TOKEN = "700003:SECOND-center-token-not-real"


def bot_answers(srv: Server, token: str, username: str) -> None:
    """The fake Bot API knows this token: getMe answers with its id."""
    me = {"id": int(token.split(":", maxsplit=1)[0]), "is_bot": True, "username": username}
    srv.tg.answers[(token, "getMe")] = (200, {"ok": True, "result": me})


class OwnBot:
    """A connected center bot: its webhook path and the secret Telegram was given."""

    def __init__(self, path: str, secret: str, body: dict[str, Any]) -> None:
        self.path, self.secret, self.body = path, secret, body


async def put_bot(srv: Server, t: Tenant, token: str) -> httpx.Response:
    return await srv.http.put("/v1/telegram/bot", json={"token": token}, headers=t.h)


async def connect(srv: Server, t: Tenant, token: str = CENTER_TOKEN, username: str = "markaz_bot") -> OwnBot:
    bot_answers(srv, token, username)
    body = await ok(await put_bot(srv, t, token))
    hook = [p for tk, m, p in srv.tg.calls if tk == token and m == "setWebhook"][-1]
    return OwnBot(hook["url"].removeprefix("https://nazoratly.test"), hook["secret_token"], body)


async def on(srv: Server, bot: OwnBot, uid: int, text: str, **extra: Any) -> list[Any]:
    return await srv.say(uid, text, path=bot.path, secret=bot.secret, **extra)


async def tap_on(srv: Server, bot: OwnBot, uid: int, data: str) -> list[Any]:
    return await srv.tap(uid, data, path=bot.path, secret=bot.secret)


def live_rows(srv: Server, t: Tenant) -> list[tuple[Any, ...]]:
    return sql(
        srv.dsn,
        "SELECT b.status, b.method, b.secret_ciphertext, b.token_hash FROM telegram_bots b JOIN organizations o "
        "ON o.id = b.org_id WHERE o.public_id = %s AND b.status <> 'disabled'",
        (uuid.UUID(t.org_id),),
    )


# ---- connecting -------------------------------------------------------------------------------------------------------
async def test_the_owner_connects_a_bot_and_the_token_never_comes_back(
    server: Server, tenant: Tenant, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    assert (await ok(await server.http.get("/v1/telegram/bot", headers=tenant.h)))["connected"] is False
    with caplog.at_level(logging.DEBUG):
        own = await connect(server, tenant)
    shown = await ok(await server.http.get("/v1/telegram/bot", headers=tenant.h))
    audit = await tenant.get("/v1/audit", params={"limit": 200})
    out = capsys.readouterr()
    everything = json.dumps([own.body, shown]) + audit.text + caplog.text + out.out + out.err
    for hidden in (CENTER_TOKEN, CENTER_TOKEN.split(":")[1], own.secret):
        assert hidden not in everything
    assert shown["connected"] and shown["username"] == "markaz_bot" and shown["method"] == "token"
    assert shown["miniapp_urls"]["guardian"].endswith(f"/ui/guardian?bot={own.path.rsplit('/', 1)[1]}")
    ((status, method, cipher, hashed),) = live_rows(server, tenant)
    assert (status, method) == ("active", "token")
    assert (
        server.box.decrypt(bytes(cipher)) == CENTER_TOKEN
        and hashed == hashlib.sha256(own.secret.encode()).hexdigest()
    )
    (hook,) = [p for _, m, p in server.tg.calls if m == "setWebhook"]
    assert hook["allowed_updates"] == ["message", "callback_query"]


async def test_bad_tokens_are_refused_without_being_echoed(server: Server, tenant: Tenant) -> None:
    for bad in ("not-a-token-SECRETPART", "123:short", ""):
        r = await put_bot(server, tenant, bad)
        assert r.status_code == 422 and "SECRETPART" not in r.text
    r = await server.http.put("/v1/telegram/bot", json={"token": ["SECRETPART" * 3]}, headers=tenant.h)
    assert r.status_code == 422 and "SECRETPART" not in r.text
    server.tg.answers[(CENTER_TOKEN, "getMe")] = (401, {"ok": False, "description": "Unauthorized"})
    r = await put_bot(server, tenant, CENTER_TOKEN)
    assert (
        r.status_code == 422
        and r.json()["error"]["code"] == "telegram_refused"
        and CENTER_TOKEN not in r.text
    )
    assert live_rows(server, tenant) == []
    # Telegram refuses the webhook: nothing stays half connected
    bot_answers(server, CENTER_TOKEN, "markaz_bot")
    server.tg.answers[(CENTER_TOKEN, "setWebhook")] = (
        400,
        {"ok": False, "description": "Bad Request: bad webhook"},
    )
    r = await put_bot(server, tenant, CENTER_TOKEN)
    assert r.status_code == 422 and CENTER_TOKEN not in r.text and live_rows(server, tenant) == []


async def test_a_bot_belongs_to_one_center_and_a_center_has_one_bot(
    client: httpx.AsyncClient, server: Server, tenant: Tenant, tenant_b: Tenant
) -> None:
    own = await connect(server, tenant)
    before = len(server.tg.calls)
    r = await put_bot(server, tenant_b, CENTER_TOKEN)  # another center pastes the same token
    assert r.status_code == 409 and r.json()["error"]["code"] == "bot_in_use"
    assert not any(m in ("setWebhook", "deleteWebhook") for _, m, _ in server.tg.calls[before:])  # untouched
    assert await on(server, own, new_uid(), "/start")  # the owner's bot still works
    r = await put_bot(server, tenant_b, SHARED_TOKEN)
    assert r.status_code == 409 and r.json()["error"]["code"] == "bot_in_use"
    bot_answers(server, OTHER_TOKEN, "ikkinchi_bot")
    r = await put_bot(server, tenant, OTHER_TOKEN)
    assert r.status_code == 409 and r.json()["error"]["code"] == "another_bot_connected"
    # the same bot again: new webhook secret, same address, the old secret stops working
    again = await connect(server, tenant)
    assert again.path == own.path and again.secret != own.secret
    update = {"update_id": next_update_id(), **message(new_uid(), "/start")}
    assert (await server.post(own.path, update, own.secret)).status_code == 403
    assert (await server.post(own.path, update, again.secret)).status_code == 200


async def test_only_the_owner_manages_the_bot_and_the_server_must_be_ready(
    client: httpx.AsyncClient, server: Server, tenant: Tenant
) -> None:
    c = await center(client, tenant)
    for method, path, body in (
        ("GET", "/v1/telegram/bot", None),
        ("PUT", "/v1/telegram/bot", {"token": CENTER_TOKEN}),
        ("DELETE", "/v1/telegram/bot", None),
        ("GET", "/v1/telegram/bot/migration", None),
        ("PUT", "/v1/telegram/bot/shared", {"stopped": True}),
    ):
        r = await server.http.request(method, path, json=body, headers=c.teacher.h)
        assert r.status_code == 403, (method, path)
        assert (await server.http.request(method, path, json=body)).status_code == 401
    assert (
        await server.http.put("/v1/telegram/bot/shared", json={"stopped": True}, headers=tenant.h)
    ).status_code == 409
    settings = server.app.state.settings
    server.app.state.settings = settings.model_copy(update={"public_base_url": None})
    try:
        r = await put_bot(server, tenant, CENTER_TOKEN)
        assert r.status_code == 409 and r.json()["error"]["code"] == "telegram_not_configured"
    finally:
        server.app.state.settings = settings


async def test_disconnecting_forgets_the_token_and_closes_the_address(server: Server, tenant: Tenant) -> None:
    own = await connect(server, tenant)
    await ok(await server.http.put("/v1/telegram/bot/shared", json={"stopped": True}, headers=tenant.h))
    await ok(await server.http.delete("/v1/telegram/bot", headers=tenant.h))
    assert (CENTER_TOKEN, "deleteWebhook") in [(tk, m) for tk, m, _ in server.tg.calls]
    assert live_rows(server, tenant) == []
    assert sql(
        server.dsn,
        "SELECT count(*) FROM telegram_bots WHERE secret_ciphertext IS NOT NULL AND org_id IS NOT NULL "
        "AND username = 'markaz_bot' AND status = 'disabled'",
    ) == [(0,)]
    update = {"update_id": next_update_id(), **message(new_uid(), "/start")}
    assert (await server.post(own.path, update, own.secret)).status_code == 404
    assert sql(server.dsn, "SELECT count(*) FROM tg_stopped_centers()") == [(0,)]
    assert (await server.http.delete("/v1/telegram/bot", headers=tenant.h)).status_code == 404


# ---- what a center's bot may reach -------------------------------------------------------------------------------------
async def test_a_center_bot_reaches_nothing_of_another_center(
    client: httpx.AsyncClient, server: Server, tenant: Tenant, tenant_b: Tenant
) -> None:
    own = await connect(server, tenant)
    other = await center(client, tenant_b)
    student = other.students[1]
    stranger = new_uid()
    # another center's guardian code, teacher invitation, student card and phone number
    code = (await ok(await tenant_b.post("/v1/guardian/codes", {"student_id": student["id"]}), 201))["code"]
    inv = await invite(tenant_b, await mk_teacher(tenant_b))
    qr = (await ok(await tenant_b.post(f"/v1/students/{student['id']}/qr", {})))["code"]
    assert "noto'g'ri" in texts(await on(server, own, stranger, code))[0]
    assert "topilmadi" in texts(await on(server, own, stranger, f"/start {inv['code']}"))[0]
    assert "topilmadi" in texts(await on(server, own, stranger, qr))[0]
    contact = message(stranger, "")
    contact["message"] = {
        **contact["message"],
        "contact": {"phone_number": "+998901112233", "user_id": stranger},
    }
    assert "topilmadi" in texts(await server.deliver(contact, own.path, own.secret))[0]
    assert sql(server.dsn, "SELECT count(*) FROM users WHERE telegram_user_id = %s", (stranger,)) == [(0,)]
    assert sql(server.dsn, "SELECT count(*) FROM guardians WHERE telegram_chat_id = %s", (stranger,)) == [
        (0,)
    ]
    assert sql(
        server.dsn, "SELECT count(*) FROM guardian_link_requests WHERE telegram_user_id = %s", (stranger,)
    ) == [(0,)]
    listed = await ok(await tenant_b.get("/v1/guardian/codes"))
    assert all(row["state"] == "ok" for row in listed)  # the code was not consumed
    # someone who teaches in two centers sees only this bot's center through it
    d = await dual(client, server.dsn)
    mine = await connect(server, d.a.owner, OTHER_TOKEN, "a_markaz_bot")
    await on(server, mine, d.uid, "/start")
    menu = buttons(await on(server, mine, d.uid, "/rol"))
    assert f"Ustoz – {d.a_name}" in menu and f"Ustoz – {d.b_name}" not in menu
    got = await tap_on(server, mine, d.uid, f"role:t:{uuid.UUID(d.b.owner.org_id).hex}")
    assert toasts(got) == ["Bu rol sizga ochiq emas."]
    state = chat_state(server.dsn, d.uid, mine.path)
    assert state is None or state[1] is None


# ---- the staged move ------------------------------------------------------------------------------------------------
def move_code(calls: list[Any]) -> str:
    url = next(
        b["url"]
        for _, m, p in calls
        if m == "sendMessage"
        for row in p.get("reply_markup", {}).get("inline_keyboard", [])
        for b in row
        if "url" in b
    )
    assert url.startswith("https://t.me/markaz_bot?start=NZM-")
    return url.split("start=")[1]


async def test_people_move_with_a_one_time_code_bound_to_their_account(
    client: httpx.AsyncClient, server: Server, tenant: Tenant
) -> None:
    c = await center(client, tenant)
    teacher, mother = new_uid(), new_uid()
    sql(
        server.dsn,
        "UPDATE users SET telegram_user_id = %s WHERE id = (SELECT user_id FROM teachers WHERE public_id = %s)",
        (teacher, uuid.UUID(c.profile["id"])),
    )
    sql(
        server.dsn,
        "UPDATE guardians SET telegram_chat_id = %s WHERE public_id = %s",
        (mother, uuid.UUID(c.guardian["id"])),
    )
    assert not any(v.startswith("role:m:") for v in buttons(await server.say(teacher, "/start")).values())
    own = await connect(server, tenant)
    # until a person moves, the shared bot keeps serving and offers the move
    home = await server.say(teacher, "/yordam")
    offer = next(v for v in buttons(home).values() if v.startswith("role:m:"))
    code = move_code(await server.tap(teacher, offer))
    assert sql(
        server.dsn, "SELECT count(*) FROM telegram_migration_codes WHERE token_hash = %s", (code,)
    ) == [(0,)]
    # someone else's code: refused and left unused
    for thief in (new_uid(), new_uid()):
        got = await on(server, own, thief, f"/start {code}")
        assert "O'tish kodi noto'g'ri" in texts(got)[0] and len(got) == 1
    assert "markazning o'z boti uchun" in texts(await server.say(teacher, f"/start {code}"))[0]
    done = await on(server, own, teacher, f"/start {code}")
    assert "o'tdingiz" in texts(done)[0] and "/bugun" in texts(done)[1]
    assert "O'tish kodi noto'g'ri" in texts(await on(server, own, teacher, f"/start {code}"))[0]  # once only
    # an expired code does nothing
    again = move_code(
        await server.tap(
            mother,
            next(v for v in buttons(await server.say(mother, "/start")).values() if v.startswith("role:m:")),
        )
    )
    sql(server.dsn, "UPDATE telegram_migration_codes SET expires_at = now() - interval '1 second'")
    assert "O'tish kodi noto'g'ri" in texts(await on(server, own, mother, f"/start {again}"))[0]

    report = await ok(await server.http.get("/v1/telegram/bot/migration", headers=tenant.h))
    moved = {(p["role"], p["moved"], p["moved_via"]) for p in report["people"]}
    assert ("teacher", True, "code") in moved
    assert report["total"] >= 2 and report["moved"] == sum(1 for p in report["people"] if p["moved"])
    # who has moved gets no more offers
    assert not any(v.startswith("role:m:") for v in buttons(await server.say(teacher, "/yordam")).values())


async def test_after_the_center_stops_the_shared_bot_it_only_points_to_the_new_one(
    client: httpx.AsyncClient, server: Server, tenant: Tenant
) -> None:
    c = await center(client, tenant)
    mother = new_uid()
    sql(
        server.dsn,
        "UPDATE guardians SET telegram_chat_id = %s WHERE public_id = %s",
        (mother, uuid.UUID(c.guardian["id"])),
    )
    before = buttons(await server.say(mother, "/start"))
    old_button = next(v for v in before.values() if v.startswith("g:"))
    await connect(server, tenant)
    stopped = await ok(
        await server.http.put("/v1/telegram/bot/shared", json={"stopped": True}, headers=tenant.h)
    )
    assert stopped["shared_bot_stopped"] is True
    got = await server.say(mother, "/start")
    assert "o'z boti" in texts(got)[0] and [v[:7] for v in buttons(got).values()] == ["role:m:"]
    assert "Ulanish uchun" in texts(await server.tap(mother, old_button))[-1] or toasts(
        await server.tap(mother, old_button)
    )
    code = await ok(await tenant.post("/v1/guardian/codes", {"student_id": c.students[1]["id"]}), 201)
    assert (
        code["deep_link"] == f"https://t.me/markaz_bot?start={code['code']}"
    )  # new links point to the center's bot
    assert "o'z botiga o'tgan" in texts(await server.say(new_uid(), code["code"]))[0]
    inv = await invite(tenant, await mk_teacher(tenant))
    assert inv["link"].startswith("https://t.me/markaz_bot?")
    assert "o'z botiga o'tgan" in texts(await server.say(new_uid(), f"/start {inv['code']}"))[0]
    # resumed: the shared bot serves them again
    await ok(await server.http.put("/v1/telegram/bot/shared", json={"stopped": False}, headers=tenant.h))
    assert any(v.startswith("g:") for v in buttons(await server.say(mother, "/start")).values())


# ---- Mini App sign-ins through a center's bot --------------------------------------------------------------------------
def init_data(user_id: int, token: str) -> str:
    params = {
        "auth_date": str(int(time.time())),
        "query_id": "q",
        "user": json.dumps({"id": user_id, "first_name": "A"}),
    }
    check = "\n".join(f"{k}={params[k]}" for k in sorted(params))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    return urlencode({**params, "hash": hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()})


async def test_a_sign_in_through_a_center_bot_is_locked_to_that_center(
    client: httpx.AsyncClient, server: Server
) -> None:
    d = await dual(client, server.dsn)
    own = await connect(server, d.a.owner)
    bot_id = own.path.rsplit("/", 1)[1]
    login = "/v1/auth/telegram-miniapp"
    signed = init_data(d.uid, CENTER_TOKEN)
    # the data of one bot is not accepted for another
    assert (await server.http.post(login, json={"init_data": signed})).status_code == 401
    r = await server.http.post(login, json={"init_data": init_data(d.uid, SHARED_TOKEN), "bot": bot_id})
    assert r.status_code == 401
    assert (
        await server.http.post(login, json={"init_data": signed, "bot": str(uuid.uuid4())})
    ).status_code == 404
    # whoever holds the center's bot token can sign anything: it must never open another center
    r = await server.http.post(login, json={"init_data": signed, "bot": bot_id, "org_id": d.b.owner.org_id})
    assert r.status_code == 403
    data = await ok(await server.http.post(login, json={"init_data": signed, "bot": bot_id}))
    assert data["org"]["id"] == d.a.owner.org_id and [o["id"] for o in data["organizations"]] == [
        d.a.owner.org_id
    ]
    h = {"Authorization": f"Bearer {data['access_token']}"}
    await ok(await server.http.get("/v1/teacher/me", headers=h))
    me = await ok(await server.http.get("/v1/me", headers=h))
    assert me["email"] is None and me["phone"] is None and len(me["organizations"]) == 1
    for method, path, body in (
        ("POST", "/v1/auth/switch", {"org_id": d.b.owner.org_id}),
        ("POST", "/v1/auth/switch", {"org_id": d.a.owner.org_id}),
        ("POST", "/v1/auth/password", {"current_password": "x" * 12, "new_password": "y" * 12}),
        ("POST", "/v1/me/accept-teacher-invite", {"code": "T-ABCDEFGH"}),
        ("POST", f"/v1/me/invitations/{d.b.owner.org_id}/accept", None),
    ):
        r = await server.http.request(method, path, json=body, headers=h)
        assert r.status_code == 403, (path, r.text)
    r = await server.http.post(
        "/v1/auth/refresh", json={"refresh_token": data["refresh_token"], "org_id": d.b.owner.org_id}
    )
    assert r.status_code == 401
    fresh = await ok(
        await server.http.post("/v1/auth/refresh", json={"refresh_token": data["refresh_token"]})
    )
    assert [o["id"] for o in fresh["organizations"]] == [d.a.owner.org_id]
    locked = {"Authorization": f"Bearer {fresh['access_token']}"}
    assert (
        await server.http.post("/v1/auth/switch", json={"org_id": d.b.owner.org_id}, headers=locked)
    ).status_code == 403
    # an account that is not a teacher of this center (here: its owner) cannot be entered this way
    owner_tg = new_uid()
    sql(server.dsn, "UPDATE users SET telegram_user_id = %s WHERE email = %s", (owner_tg, d.a.owner.email))
    r = await server.http.post(login, json={"init_data": init_data(owner_tg, CENTER_TOKEN), "bot": bot_id})
    assert r.status_code == 403
    # a teacher who is later given a wider role does not carry it into the locked sign-in
    sql(
        server.dsn,
        "UPDATE memberships SET role = 'admin' WHERE org_id = (SELECT id FROM organizations WHERE public_id = %s) "
        "AND role = 'teacher'",
        (uuid.UUID(d.a.owner.org_id),),
    )
    assert (await server.http.get("/v1/students", headers=locked)).status_code == 403
    r = await server.http.post("/v1/auth/refresh", json={"refresh_token": fresh["refresh_token"]})
    assert r.status_code == 401


async def test_disconnecting_ends_the_sign_ins_made_through_the_bot(
    client: httpx.AsyncClient, server: Server, tenant: Tenant
) -> None:
    c = await center(client, tenant)
    u = new_uid()
    sql(
        server.dsn,
        "UPDATE users SET telegram_user_id = %s WHERE id = (SELECT user_id FROM teachers WHERE public_id = %s)",
        (u, uuid.UUID(c.profile["id"])),
    )
    own = await connect(server, tenant)
    body = {"init_data": init_data(u, CENTER_TOKEN), "bot": own.path.rsplit("/", 1)[1]}
    data = await ok(await server.http.post("/v1/auth/telegram-miniapp", json=body))
    await ok(await server.http.delete("/v1/telegram/bot", headers=tenant.h))
    r = await server.http.post("/v1/auth/refresh", json={"refresh_token": data["refresh_token"]})
    assert r.status_code == 401
    assert (await server.http.post("/v1/auth/telegram-miniapp", json=body)).status_code == 404


async def test_the_guardian_mini_app_of_a_center_bot_shows_that_center_only(
    client: httpx.AsyncClient, server: Server
) -> None:
    mother = new_uid()
    first, second = await make_tenant(client, "mini-a"), await make_tenant(client, "mini-b")
    for t in (first, second):
        await family(t, await mk_student(t), mother)
    own = await connect(server, first)
    bot_id = own.path.rsplit("/", 1)[1]
    url = "/v1/cabinet/auth/telegram"
    signed = init_data(mother, CENTER_TOKEN)
    assert (await server.http.post(url, json={"init_data": signed})).status_code == 401
    got = await ok(
        await server.http.post(url, json={"init_data": signed, "bot": bot_id})
    )  # one center: no choice
    h = {"Authorization": f"Bearer {got['token']}"}
    name = sql(server.dsn, "SELECT name FROM organizations WHERE public_id = %s", (uuid.UUID(first.org_id),))[
        0
    ][0]
    assert (await ok(await server.http.get("/v1/cabinet/me", headers=h)))["center"] == name
    assert re.match(r"^gs_", got["token"])
    # the shared bot leaves out a center that stopped it
    await ok(await server.http.put("/v1/telegram/bot/shared", json={"stopped": True}, headers=first.h))
    got = await ok(await server.http.post(url, json={"init_data": init_data(mother, SHARED_TOKEN)}))
    h = {"Authorization": f"Bearer {got['token']}"}
    assert (await ok(await server.http.get("/v1/cabinet/me", headers=h)))["center"] != name
    assert SHARED_SECRET not in got["token"]
