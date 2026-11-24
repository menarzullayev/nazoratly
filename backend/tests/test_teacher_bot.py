"""The teacher's Telegram bot and the Mini App sign-in. Telegram is a fake transport: nothing real is ever called."""

from __future__ import annotations

import itertools
import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlencode

import httpx
import pytest
import pytest_asyncio
from pydantic import SecretStr

from nazoratly.main import create_app
from nazoratly.telegram_auth import BadInitData, sign_init_data, verify_init_data
from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, mk_teacher, ok, org_today
from tests.test_teacher_app import PW, center, family, invite, lesson, sql

TOKEN = "123456:TEST-BOT-TOKEN"
SECRET = "teacher-hook-secret-0123456789"
HDR = {"X-Telegram-Bot-Api-Secret-Token": SECRET}
_ids = itertools.count(1_000)


class Bot:
    """A running app with the bot configured and a recording Telegram."""

    def __init__(self, client: httpx.AsyncClient, calls: list[tuple[str, dict[str, Any]]]) -> None:
        self.http, self.calls = client, calls

    async def send(self, update: dict[str, Any], headers: dict[str, str] | None = None) -> httpx.Response:
        return await self.http.post(
            "/hooks/teacher-bot", json=update, headers=HDR if headers is None else headers
        )

    async def say(self, uid: int, text: str, **extra: Any) -> list[tuple[str, dict[str, Any]]]:
        return await self.update(
            {
                "update_id": next(_ids),
                "message": {
                    "message_id": 1,
                    "from": {"id": uid, "first_name": "Botir"},
                    "chat": {"id": uid, "type": "private"},
                    "text": text,
                    **extra,
                },
            }
        )

    async def tap(self, uid: int, data: str, message_id: int = 10) -> list[tuple[str, dict[str, Any]]]:
        return await self.update(
            {
                "update_id": next(_ids),
                "callback_query": {
                    "id": f"cb{next(_ids)}",
                    "from": {"id": uid},
                    "message": {"message_id": message_id, "chat": {"id": uid, "type": "private"}},
                    "data": data,
                },
            }
        )

    async def update(self, update: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        before = len(self.calls)
        r = await self.send(update)
        assert r.status_code == 200, r.text
        return self.calls[before:]


@pytest_asyncio.fixture
async def bot(settings: Any) -> AsyncIterator[Bot]:
    app = create_app(
        settings.model_copy(
            update={
                "telegram_bot_token": SecretStr(TOKEN),
                "tg_teacher_secret": SecretStr(SECRET),
                "telegram_bot_username": "nazoratly_ustoz_bot",
            }
        )
    )
    calls: list[tuple[str, dict[str, Any]]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert f"/bot{TOKEN}/" in str(req.url)
        calls.append((str(req.url).rsplit("/", 1)[1], json.loads(req.content)))
        return httpx.Response(200, json={"ok": True, "result": {}})

    async with app.router.lifespan_context(app):
        app.state.outbound_transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://bot") as c:
            yield Bot(c, calls)


def texts(calls: list[tuple[str, dict[str, Any]]]) -> list[str]:
    return [p["text"] for m, p in calls if m in ("sendMessage", "editMessageText")]


def buttons(calls: list[tuple[str, dict[str, Any]]]) -> list[tuple[str, str]]:
    out = []
    for m, p in calls:
        if (
            m in ("sendMessage", "editMessageText")
            and "reply_markup" in p
            and "inline_keyboard" in p["reply_markup"]
        ):
            out += [
                (b["text"], b["callback_data"]) for row in p["reply_markup"]["inline_keyboard"] for b in row
            ]
    return out


def uid() -> int:
    return 10_000_000 + uuid.uuid4().int % 1_000_000_000


# ---- the webhook itself ---------------------------------------------------------------------------------------------
async def test_hook_is_closed_until_configured_and_checks_the_secret(
    client: httpx.AsyncClient, bot: Bot
) -> None:
    assert (await client.post("/hooks/teacher-bot", json={})).status_code == 404  # the default app has no bot
    assert (await bot.http.post("/hooks/teacher-bot", json={})).status_code == 403
    assert (
        await bot.http.post(
            "/hooks/teacher-bot", json={}, headers={"X-Telegram-Bot-Api-Secret-Token": "nope"}
        )
    ).status_code == 403
    assert (await bot.http.post("/hooks/teacher-bot", content="not json", headers=HDR)).status_code == 400
    assert (await bot.send({"update_id": next(_ids)})).status_code == 200  # an update of a kind we do not use
    assert bot.calls == []


async def test_group_chats_and_forwarded_ids_are_ignored_and_updates_run_once(bot: Bot) -> None:
    u = uid()
    group = {
        "update_id": next(_ids),
        "message": {
            "message_id": 1,
            "from": {"id": u},
            "chat": {"id": -5, "type": "group"},
            "text": "/bugun",
        },
    }
    assert (await bot.update(group)) == []
    other_chat = {
        "update_id": next(_ids),
        "message": {
            "message_id": 1,
            "from": {"id": u},
            "chat": {"id": u + 1, "type": "private"},
            "text": "/bugun",
        },
    }
    assert (await bot.update(other_chat)) == []
    same = {
        "update_id": next(_ids),
        "message": {
            "message_id": 1,
            "from": {"id": u},
            "chat": {"id": u, "type": "private"},
            "text": "/yordam",
        },
    }
    first = await bot.update(same)
    again = await bot.update(same)  # Telegram retried the same update_id
    assert len(first) == 1 and again == []


# ---- linking ----------------------------------------------------------------------------------------------------------------
async def test_teacher_links_the_telegram_account_with_the_invitation_code(
    client: httpx.AsyncClient, tenant: Tenant, bot: Bot, super_dsn: str
) -> None:
    prof = await mk_teacher(tenant)
    inv = await invite(tenant, prof)
    assert inv["link"] is None  # the default test app has no bot username
    with_link = await ok(
        await bot.http.post(f"/v1/teachers/{(await mk_teacher(tenant))['id']}/invitations", headers=tenant.h),
        201,
    )
    assert with_link["link"] == f"https://t.me/nazoratly_ustoz_bot?start={with_link['code']}"
    u = uid()
    stranger_reply = await bot.say(u, "/bugun")
    assert "taklif kodi" in texts(stranger_reply)[0]  # not linked yet
    bad = await bot.say(u, "/start T-ABCDEFGH")
    assert "topilmadi" in texts(bad)[0]
    garbage = await bot.say(u, "/start hello")
    assert "T-XXXXXXXX" in texts(garbage)[0]
    ok_reply = await bot.say(u, f"/start {inv['code']}")
    assert (
        "Ulandi" in texts(ok_reply)[0]
        and prof["full_name"] in texts(ok_reply)[0]
        and "/bugun" in texts(ok_reply)[0]
    )
    listed = {i["id"]: i for i in (await ok(await tenant.get("/v1/teacher-invitations")))["items"]}
    assert listed[inv["id"]]["status"] == "used" and listed[inv["id"]]["used_via"] == "bot"
    assert sql(super_dsn, "SELECT count(*) FROM users WHERE telegram_user_id = %s", (u,)) == [(1,)]
    assert sql(
        super_dsn,
        "SELECT m.role FROM memberships m JOIN users x ON x.id = m.user_id WHERE x.telegram_user_id = %s",
        (u,),
    ) == [("teacher",)]
    # the same code again, from anybody
    assert "allaqachon ishlatilgan" in texts(await bot.say(uid(), f"/start {inv['code']}"))[0]
    # a code pasted as a plain message links too
    prof2 = await mk_teacher(tenant)
    inv2 = await invite(tenant, prof2)
    u2 = uid()
    assert "Ulandi" in texts(await bot.say(u2, inv2["code"].lower()))[0]
    # an account that is linked to another teacher cannot take a second profile as a teacher of the same center
    prof3 = await mk_teacher(tenant)
    inv3 = await invite(tenant, prof3)
    again = await bot.say(u2, f"/start {inv3['code']}")
    assert texts(
        again
    )  # the account is already a teacher of this center: the membership is reused and the profile linked
    # a revoked and an expired invitation
    prof4 = await mk_teacher(tenant)
    inv4 = await invite(tenant, prof4)
    await ok(await tenant.delete(f"/v1/teacher-invitations/{inv4['id']}"))
    assert "bekor qilingan" in texts(await bot.say(uid(), f"/start {inv4['code']}"))[0]


# ---- the working flows ------------------------------------------------------------------------------------------------------
async def test_today_roll_call_by_buttons_and_the_rest(
    client: httpx.AsyncClient, tenant: Tenant, bot: Bot, super_dsn: str
) -> None:
    c = await center(client, tenant)
    u = uid()
    sql(
        super_dsn,
        "UPDATE users SET telegram_user_id = %s WHERE id = (SELECT user_id FROM teachers WHERE public_id = %s)",
        (u, uuid.UUID(c.profile["id"])),
    )
    today = org_today()
    les = await lesson(tenant, c.group, today, "10:00:00", "11:00:00")
    second = await lesson(tenant, c.group, today, "12:00:00", "13:00:00")
    extra = []
    for i in range(8):  # 10 students: two pages
        s = await mk_student(tenant, f"Extra {i}")
        await enroll(tenant, c.group["id"], s["id"], "2026-01-01")
        extra.append(s)

    out = await bot.say(u, "/bugun")
    assert (
        "10:00-11:00" in texts(out)[0]
        and c.group["name"] in texts(out)[0]
        and "belgilanmagan" in texts(out)[0]
    )
    btn = buttons(out)
    assert len(btn) == 2 and btn[0][1] == f"l:{uuid.UUID(les['id']).hex}"

    roster = await bot.tap(u, btn[0][1])
    page1 = [b for b in buttons(roster) if b[1].startswith("a:")]
    assert (
        len(page1) == 8 * 4
        and any(b[1].startswith("r:") for b in buttons(roster))
        and "1/2" in texts(roster)[0]
    )
    first_tap = next(b for b in page1 if b[1].endswith(":p:0"))
    reply = await bot.tap(u, first_tap[1])
    assert any(m == "answerCallbackQuery" and p.get("text") == "Saqlandi" for m, p in reply)
    rows = (await ok(await tenant.get(f"/v1/lessons/{les['id']}/attendance")))["entries"]
    assert sorted(e["status"] or "-" for e in rows).count("present") == 1
    # absent, late, excused through the same buttons; page 2 is reachable and keeps its page
    second_page = await bot.tap(u, f"r:{uuid.UUID(les['id']).hex}:1")
    p2 = [b for b in buttons(second_page) if b[1].startswith("a:")]
    assert len(p2) == 2 * 4 and "2/2" in texts(second_page)[0]
    for code, status in (("a", "absent"), ("l", "late"), ("e", "excused")):
        pick = next(b for b in p2 if b[1].split(":")[3] == code and b[1].split(":")[2] == p2[0][1].split(":")[2])
        await bot.tap(u, pick[1])
        sid8 = pick[1].split(":")[2]
        entry = next(
            e
            for e in (await ok(await tenant.get(f"/v1/lessons/{les['id']}/attendance")))["entries"]
            if e["student_id"].replace("-", "").startswith(sid8)
        )
        assert entry["status"] == status
    assert any(m == "editMessageText" for m, _ in await bot.tap(u, p2[0][1]))
    # a lesson that is not the teacher's, a wrong student prefix, a malformed callback
    other = await mk_group(tenant, teacher_id=(await mk_teacher(tenant))["id"])
    theirs = await lesson(tenant, other, today)
    denied = await bot.tap(u, f"l:{uuid.UUID(theirs['id']).hex}")
    assert any(m == "answerCallbackQuery" and "own lessons" in p.get("text", "") for m, p in denied)
    nothing = await bot.tap(u, f"a:{uuid.UUID(les['id']).hex}:deadbeef:p:0")
    assert any(m == "answerCallbackQuery" and "topilmadi" in p.get("text", "") for m, p in nothing)
    assert [m for m, _ in await bot.tap(u, "zzz")] == ["answerCallbackQuery"]
    assert [m for m, _ in await bot.tap(u, "n")] == ["answerCallbackQuery"]

    assert "Guruhlarim" in texts(await bot.say(u, "/guruhlar"))[0]
    assert (
        c.group["name"] in texts(await bot.say(u, "/guruhlar"))[0]
        and "10 o'quvchi" in texts(await bot.say(u, "/guruhlar"))[0]
    )
    week = texts(await bot.say(u, "/jadval"))[0]
    assert "Shu hafta" in week and "10:00-11:00" in week
    pay = texts(await bot.say(u, "/oylik"))[0]
    assert "ta dars" in pay and "so'm" in pay
    assert (
        "/bugun" in texts(await bot.say(u, "/yordam"))[0] and "/bugun" in texts(await bot.say(u, "salom"))[0]
    )
    # a cancelled lesson has no roll-call button
    await ok(await tenant.patch(f"/v1/lessons/{second['id']}", {"status": "cancelled"}))
    cancelled = await bot.say(u, "/bugun")
    assert "bekor" in texts(cancelled)[0] and len(buttons(cancelled)) == 1


async def test_messages_to_guardians_through_the_bot(
    client: httpx.AsyncClient, tenant: Tenant, bot: Bot, super_dsn: str
) -> None:
    c = await center(client, tenant)
    u = uid()
    sql(
        super_dsn,
        "UPDATE users SET telegram_user_id = %s WHERE id = (SELECT user_id FROM teachers WHERE public_id = %s)",
        (u, uuid.UUID(c.profile["id"])),
    )
    a = c.students[0]
    groups = await bot.say(u, "/xabar")
    pick = buttons(groups)
    assert pick == [(f"{c.group['name']} (2)", f"m1:{uuid.UUID(c.group['id']).hex}")]
    students = buttons(await bot.tap(u, pick[0][1]))
    assert {t for t, _ in students} == {s["full_name"] for s in c.students}
    sd = next(d for t, d in students if t == a["full_name"])
    templates = buttons(await bot.tap(u, sd))
    assert [d.split(":")[2] for _, d in templates if d.startswith("m3:")] == [
        "absent",
        "late",
        "homework",
        "praise",
        "meeting",
    ]
    sent = await bot.tap(u, next(d for _, d in templates if d.endswith(":praise")))
    assert "1 ta vasiyga" in texts(sent)[0] and "19" in texts(sent)[0]
    # free text: the bot asks for a reply, the reply is the text
    ask = await bot.tap(u, next(d for _, d in templates if d.startswith("m4:")))
    prompt = ask[0][1]
    assert prompt["reply_markup"]["force_reply"] is True and "#" + uuid.UUID(a["id"]).hex in prompt["text"]
    done = await bot.say(u, "Ertaga kelishsin.", reply_to_message={"message_id": 5, "text": prompt["text"]})
    assert "1 ta vasiyga" in texts(done)[0]
    # a stray text without a prompt is not a message to anybody
    assert "/bugun" in texts(await bot.say(u, "Ertaga kelishsin."))[0]
    log = (await ok(await tenant.get("/v1/teacher-messages")))["items"]
    assert [m["template"] for m in log] == [None, "praise"] and log[0]["body"].startswith("Ertaga kelishsin.")
    # the student without a reachable guardian
    b = c.students[1]
    refused = await bot.tap(u, f"m3:{uuid.UUID(b['id']).hex}:praise")
    assert "yozib bo'lmaydi" in texts(refused)[0]
    # a foreign student, an unknown template
    alien = await mk_student(tenant, "Alien")
    await family(tenant, alien, 4040)
    assert "guruhingizda emas" in texts(await bot.tap(u, f"m3:{uuid.UUID(alien['id']).hex}:praise"))[0]
    assert (await bot.tap(u, f"m3:{uuid.UUID(a['id']).hex}:bogus")) != []
    assert len((await ok(await tenant.get("/v1/teacher-messages")))["items"]) == 2
    # the owner switches the right off: the bot says so at the first step
    await ok(await tenant.patch(f"/v1/teachers/{c.profile['id']}/messaging", {"enabled": False}))
    assert "o'chirilgan" in texts(await bot.say(u, "/xabar"))[0]
    assert "o'chirilgan" in texts(await bot.tap(u, f"m3:{uuid.UUID(a['id']).hex}:praise"))[0]
    # daily limit
    await ok(await tenant.patch(f"/v1/teachers/{c.profile['id']}/messaging", {"enabled": True}))
    await ok(await tenant.patch("/v1/teacher-app/settings", {"guardian_daily_limit": 2}))
    assert "limiti tugadi" in texts(await bot.tap(u, f"m3:{uuid.UUID(a['id']).hex}:praise"))[0]


# ---- Mini App sign-in -------------------------------------------------------------------------------------------------------------
def init_data(
    user_id: int,
    *,
    token: str = TOKEN,
    age: int = 0,
    tamper: bool = False,
    extra: dict[str, str] | None = None,
) -> str:
    fields = {
        "auth_date": str(int(time.time()) - age),
        "query_id": "AAH",
        "user": json.dumps({"id": user_id, "first_name": "Botir"}),
    }
    fields.update(extra or {})
    h = sign_init_data(fields, token)
    if tamper:
        fields["user"] = json.dumps({"id": user_id + 1, "first_name": "Botir"})
    return urlencode({**fields, "hash": h})


def test_init_data_verification_rules() -> None:
    assert verify_init_data(init_data(7), TOKEN).id == 7
    with pytest.raises(BadInitData):
        verify_init_data(init_data(7, tamper=True), TOKEN)  # data changed after signing
    with pytest.raises(BadInitData):
        verify_init_data(init_data(7, token="999:OTHER"), TOKEN)  # another bot's signature
    with pytest.raises(BadInitData):
        verify_init_data(init_data(7, age=2 * 86400), TOKEN)  # replayed after a day
    with pytest.raises(BadInitData):
        verify_init_data(init_data(7, age=-3600), TOKEN)  # from the future
    with pytest.raises(BadInitData):
        verify_init_data("auth_date=1&user=%7B%7D", TOKEN)  # no hash
    with pytest.raises(BadInitData):
        verify_init_data(init_data(7) + "&hash=" + "0" * 64, TOKEN)  # a duplicated hash field
    with pytest.raises(BadInitData):
        verify_init_data("x" * 5000, TOKEN)
    nobody = {"auth_date": str(int(time.time()))}
    with pytest.raises(BadInitData):
        verify_init_data(urlencode({**nobody, "hash": sign_init_data(nobody, TOKEN)}), TOKEN)  # no user


async def test_mini_app_login(client: httpx.AsyncClient, tenant: Tenant, bot: Bot, super_dsn: str) -> None:
    c = await center(client, tenant)
    u = uid()
    body = {"init_data": init_data(u)}
    assert (
        await client.post("/v1/auth/telegram-miniapp", json=body)
    ).status_code == 404  # the default app has no bot token
    r = await bot.http.post("/v1/auth/telegram-miniapp", json=body)
    assert r.status_code == 403  # a valid Telegram signature, but nobody is linked to this id
    sql(
        super_dsn,
        "UPDATE users SET telegram_user_id = %s WHERE id = (SELECT user_id FROM teachers WHERE public_id = %s)",
        (u, uuid.UUID(c.profile["id"])),
    )
    data = await ok(await bot.http.post("/v1/auth/telegram-miniapp", json=body))
    assert data["org"]["role"] == "teacher"
    me = await ok(
        await bot.http.get("/v1/teacher/me", headers={"Authorization": f"Bearer {data['access_token']}"})
    )
    assert me["teacher_id"] == c.profile["id"]
    for bad in (init_data(u, tamper=True), init_data(u, age=2 * 86400), init_data(u, token="999:OTHER")):
        assert (await bot.http.post("/v1/auth/telegram-miniapp", json={"init_data": bad})).status_code == 401
    assert (await bot.http.post("/v1/auth/telegram-miniapp", json={"init_data": "short"})).status_code == 422
    # a suspended membership cannot sign in
    sql(
        super_dsn,
        "UPDATE memberships SET status = 'suspended' WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = %s)",
        (u,),
    )
    assert (await bot.http.post("/v1/auth/telegram-miniapp", json=body)).status_code == 403
