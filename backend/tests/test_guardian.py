"""Guardian cabinet (G7) through the real API: one-time codes, the four ways of linking, Mini App / portal sign-in, what a
guardian reads, and the three requests that need the center's approval. The pure rules are the golden file
tests/golden/guardian.json (test_golden_guardian.py); the database fence is tested in db/tests/test_schema.sql.
Telegram is a fake transport: no real message is ever sent."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
import psycopg
import pytest_asyncio
from pydantic import SecretStr

from tests.conftest import Tenant, make_tenant
from tests.helpers import consent, enroll, mk_course, mk_group, mk_guardian, mk_student, ok, org_today
from tests.telegram_support import (
    chat_state,
    drop_bots,
    has_ns,
    next_update_id,
    register_shared,
    strip_ns,
)
from tests.test_branches import branch_staff, mk_branch, view
from tests.test_documents import set_requisites
from tests.test_tenancy_and_staff import _login

BOT_TOKEN = "123456:TEST-bot-token-not-real"
HOOK_SECRET = "hook-secret-for-tests-123"
BOT: dict[str, Any] = {}  # the registered shared bot of the running test
TODAY = org_today()
TOMORROW = TODAY + timedelta(days=1)


# ---- fake Telegram --------------------------------------------------------------------------------------------
class FakeBot:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        method = req.url.path.rsplit("/", 1)[1]
        if method == "sendDocument":
            m = re.search(rb'name="chat_id"\r\n\r\n(\d+)', req.content)
            self.calls.append({"method": method, "chat": int(m.group(1)) if m else None, "file": req.content})
        else:
            payload = json.loads(req.content)
            self.calls.append({"method": method, "chat": payload.get("chat_id"), "json": payload})
        return httpx.Response(200, json={"ok": True})

    def texts(self, chat: int) -> list[str]:
        return [c["json"]["text"] for c in self.calls if c["method"] == "sendMessage" and c["chat"] == chat]

    def last(self, chat: int) -> str:
        return self.texts(chat)[-1]

    def raw_keyboard(self, chat: int) -> list[dict[str, Any]]:
        msgs = [c for c in self.calls if c["method"] == "sendMessage" and c["chat"] == chat]
        return [b for row in msgs[-1]["json"].get("reply_markup", {}).get("inline_keyboard", []) for b in row]

    def keyboard(self, chat: int) -> list[dict[str, Any]]:
        """The buttons with the role namespace (`g:<epoch>:`) taken off; `hook` puts the current one back."""
        return [
            {**b, "callback_data": strip_ns(b["callback_data"])} if "callback_data" in b else b
            for b in self.raw_keyboard(chat)
        ]

    def documents(self, chat: int) -> list[dict[str, Any]]:
        return [c for c in self.calls if c["method"] == "sendDocument" and c["chat"] == chat]

    def chats(self) -> set[int]:
        return {c["chat"] for c in self.calls if c["chat"] is not None}


@pytest_asyncio.fixture
async def tg(app: Any, super_dsn: str) -> AsyncIterator[FakeBot]:
    fake = FakeBot()
    s = app.state.settings
    old = (s.telegram_bot_token, s.public_base_url)
    s.telegram_bot_token = SecretStr(BOT_TOKEN)
    s.public_base_url = "https://nazoratly.test"
    BOT["path"] = register_shared(super_dsn, app.state.secrets_box, BOT_TOKEN, HOOK_SECRET)
    BOT["dsn"], BOT["fake"] = super_dsn, fake
    app.state.outbound_transport = httpx.MockTransport(fake)
    yield fake
    s.telegram_bot_token, s.public_base_url = old
    app.state.outbound_transport = None
    drop_bots(super_dsn)


def init_data(user_id: int, *, token: str = BOT_TOKEN, age_s: int = 0, tamper: bool = False) -> str:
    params = {
        "auth_date": str(int(time.time()) - age_s),
        "query_id": "AAHtest",
        "user": json.dumps({"id": user_id, "first_name": "Ali", "language_code": "uz"}),
    }
    check = "\n".join(f"{k}={params[k]}" for k in sorted(params))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    h = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if tamper:
        params["user"] = json.dumps({"id": user_id + 1})
    return urlencode({**params, "hash": h})


def new_chat() -> int:
    return 5_000_000 + uuid.uuid4().int % 900_000_000


async def _post(client: httpx.AsyncClient, update: dict[str, Any], secret: str) -> httpx.Response:
    return await client.post(
        BOT["path"],
        json={"update_id": next_update_id(), **update},
        headers={"X-Telegram-Bot-Api-Secret-Token": secret},
    )


async def hook(
    client: httpx.AsyncClient, update: dict[str, Any], secret: str = HOOK_SECRET
) -> httpx.Response:
    """Deliver an update the way Telegram does. A tap with bare callback data gets the guardian namespace of the
    conversation, as the buttons the bot sent would carry it."""
    cq = update.get("callback_query")
    if cq is not None and not has_ns(cq["data"]):
        chat = cq["from"]["id"]
        state = chat_state(BOT["dsn"], chat)
        if state is None or state[0] != "guardian":  # the person has not been shown a menu yet
            before = len(BOT["fake"].calls)
            await _post(client, msg(chat, "/start"), secret)
            del BOT["fake"].calls[before:]
            state = chat_state(BOT["dsn"], chat)
        assert state is not None
        update = {"callback_query": {**cq, "data": f"g:{state[2]}:{cq['data']}"}}
    return await _post(client, update, secret)


def msg(chat: int, text: str, **extra: Any) -> dict[str, Any]:
    return {
        "message": {
            "chat": {"id": chat, "type": "private"},
            "from": {"id": chat, "first_name": "Dilnoza"},
            "text": text,
            **extra,
        }
    }


def tap(chat: int, data: str) -> dict[str, Any]:
    return {
        "callback_query": {
            "id": f"cb{uuid.uuid4().hex[:6]}",
            "from": {"id": chat},
            "data": data,
            "message": {"message_id": 1, "chat": {"id": chat, "type": "private"}},
        }
    }


def contact(chat: int, phone: str, user_id: int | None = None) -> dict[str, Any]:
    return {
        "message": {
            "chat": {"id": chat, "type": "private"},
            "from": {"id": chat, "first_name": "Dilnoza"},
            "contact": {"phone_number": phone, "user_id": chat if user_id is None else user_id},
        }
    }


def tok(public_id: str) -> str:
    return public_id.replace("-", "")[:12]


# ---- builders -------------------------------------------------------------------------------------------------
async def lessons_group(
    t: Tenant,
    course_id: str | None = None,
    capacity: int | None = None,
    past: bool = False,
    start: str = "10:00:00",
) -> dict[str, Any]:
    body: dict[str, Any] = {} if capacity is None else {"capacity": capacity}
    grp = await mk_group(t, course_id, **body)
    await ok(
        await t.put(
            f"/v1/groups/{grp['id']}/schedule",
            [
                {"weekday": d, "start_time": start, "end_time": f"{int(start[:2]) + 1:02d}:00:00"}
                for d in range(1, 8)
            ],
        )
    )
    first = (TODAY - timedelta(days=5)) if past else TOMORROW
    await ok(
        await t.post(
            f"/v1/groups/{grp['id']}/lessons/generate",
            {"date_from": first.isoformat(), "date_to": (TODAY + timedelta(days=12)).isoformat()},
        )
    )
    return grp


async def lesson_at(t: Tenant, group_id: str, day: Any) -> dict[str, Any]:
    items = (
        await ok(
            await t.get(
                "/v1/lessons",
                params={"date_from": day.isoformat(), "date_to": day.isoformat(), "group_id": group_id},
            )
        )
    )["items"]
    return items[0]  # type: ignore[no-any-return]


class Fam:
    def __init__(
        self, t: Tenant, student: dict[str, Any], guardian: dict[str, Any], chat: int, group: dict[str, Any]
    ) -> None:
        self.t, self.student, self.guardian, self.chat, self.group = t, student, guardian, chat, group


async def family(
    t: Tenant, *, link: bool = True, accepted: bool = True, group: dict[str, Any] | None = None
) -> Fam:
    chat = new_chat()
    student = await mk_student(t, f"Karimov {uuid.uuid4().hex[:4]}")
    guardian = await mk_guardian(t, "Karimova Dilnoza")
    grp = group or await lessons_group(t)
    await enroll(t, grp["id"], student["id"], "2026-01-01")
    if link:
        await ok(
            await t.post(
                "/v1/guardian/links",
                {
                    "student_id": student["id"],
                    "guardian_id": guardian["id"],
                    "telegram_chat_id": chat,
                    "relation": "mother",
                },
            ),
            201,
        )
    if accepted:
        await consent(t, student["id"], "data_processing", guardian["id"] if link else None)
    return Fam(t, student, guardian, chat, grp)


async def sign_in(client: httpx.AsyncClient, chat: int) -> dict[str, str]:
    r = await client.post("/v1/cabinet/auth/telegram", json={"init_data": init_data(chat)})
    return {"Authorization": f"Bearer {(await ok(r))['token']}"}


async def debt(t: Tenant, student: dict[str, Any], amount: str = "600000", due: int = 5) -> dict[str, Any]:
    return await ok(  # type: ignore[no-any-return]
        await t.post(
            "/v1/charges",
            {
                "student_id": student["id"],
                "kind": "tuition",
                "period_month": TODAY.isoformat(),
                "amount": amount,
                "due_date": (TODAY + timedelta(days=due)).isoformat(),
            },
        ),
        201,
    )


def outbox_count(super_dsn: str, org_public: str) -> int:
    with psycopg.connect(super_dsn) as c:
        row = c.execute(
            "SELECT count(*) FROM outbox_messages o JOIN organizations g ON g.id = o.org_id WHERE g.public_id::text = %s",
            (org_public,),
        ).fetchone()
    return int(row[0]) if row else -1


# =============================================================================================================
# staff: one-time codes
# =============================================================================================================
async def test_code_is_shown_once_and_only_its_hash_is_stored(tenant: Tenant, super_dsn: str) -> None:
    fam = await family(tenant, link=False, accepted=False)
    issued = await ok(await tenant.post("/v1/guardian/codes", {"student_id": fam.student["id"]}), 201)
    code = issued["code"]
    assert len(code) == 8 and issued["deep_link"] is None  # no bot username configured outside the tg fixture
    listing = await ok(await tenant.get("/v1/guardian/codes", params={"student_id": fam.student["id"]}))
    assert [r["state"] for r in listing] == ["ok"] and "code" not in listing[0]
    with psycopg.connect(super_dsn) as c:
        hashes = [
            r[0]
            for r in c.execute(
                "SELECT code_hash FROM guardian_link_codes WHERE public_id = %s", (issued["id"],)
            )
        ]
    assert hashes == [hashlib.sha256(code.encode()).hexdigest()] and code not in hashes[0]


async def test_codes_need_permission_and_stay_in_their_center(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    teacher_email = f"teacher-{uuid.uuid4().hex[:8]}@example.com"
    await ok(
        await tenant.post(
            "/v1/staff",
            {
                "full_name": "T",
                "email": teacher_email,
                "role": "teacher",
                "initial_password": "staff-password-123",
            },
        ),
        201,
    )
    teacher = await _login(client, teacher_email, "staff-password-123")
    r = await teacher.post("/v1/guardian/codes", {"student_id": fam.student["id"]})
    assert r.status_code == 403
    assert (await tenant_b.post("/v1/guardian/codes", {"student_id": fam.student["id"]})).status_code == 404
    issued = await ok(await tenant.post("/v1/guardian/codes", {"student_id": fam.student["id"]}), 201)
    assert (await tenant_b.post(f"/v1/guardian/codes/{issued['id']}/revoke")).status_code == 404
    assert (await tenant_b.get("/v1/guardian/requests")).json() == []


async def test_code_for_a_guardian_who_is_not_linked_is_refused(tenant: Tenant) -> None:
    fam = await family(tenant, link=False, accepted=False)
    g = await mk_guardian(tenant, "Boshqa vasiy")
    r = await tenant.post("/v1/guardian/codes", {"student_id": fam.student["id"], "guardian_id": g["id"]})
    assert r.status_code == 409


# =============================================================================================================
# linking through the bot
# =============================================================================================================
async def test_one_time_code_links_once_then_is_used(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    code = (
        await ok(
            await tenant.post("/v1/guardian/codes", {"student_id": fam.student["id"], "relation": "father"}),
            201,
        )
    )["code"]
    chat = new_chat()
    assert (await hook(client, msg(chat, f"/start {code}"))).status_code == 200
    links = await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]}))
    assert (
        len(links) == 1
        and links[0]["linked_via"] == "code"
        and links[0]["relation"] == "father"
        and links[0]["telegram_linked"]
    )
    assert "Roziman" in json.dumps(tg.calls[-1]["json"], ensure_ascii=False)  # the consent comes first
    # a second Telegram user cannot reuse it
    other = new_chat()
    await hook(client, msg(other, code))
    assert "noto'g'ri" in tg.last(other)
    assert (
        len(await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]}))) == 1
    )
    states = [
        r["state"]
        for r in await ok(await tenant.get("/v1/guardian/codes", params={"student_id": fam.student["id"]}))
    ]
    assert states == ["used"]


async def test_code_can_be_typed_in_any_case_with_dashes(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    code = (await ok(await tenant.post("/v1/guardian/codes", {"student_id": fam.student["id"]}), 201))["code"]
    chat = new_chat()
    await hook(client, msg(chat, f" {code[:4].lower()}-{code[4:].lower()} "))
    assert (
        len(await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]}))) == 1
    )


async def test_revoked_expired_and_unknown_codes_do_not_link(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    revoked = await ok(await tenant.post("/v1/guardian/codes", {"student_id": fam.student["id"]}), 201)
    assert (await tenant.post(f"/v1/guardian/codes/{revoked['id']}/revoke")).status_code == 204
    expired = await ok(await tenant.post("/v1/guardian/codes", {"student_id": fam.student["id"]}), 201)
    with psycopg.connect(super_dsn) as c:
        c.execute(
            "UPDATE guardian_link_codes SET expires_at = now() - interval '1 minute' WHERE public_id = %s",
            (expired["id"],),
        )
        c.commit()
    for code in (revoked["code"], expired["code"], "ZZZZZZZZ"):
        chat = new_chat()
        await hook(client, msg(chat, code))
        assert "noto'g'ri" in tg.last(chat)
    assert await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]})) == []
    assert (await tenant.post(f"/v1/guardian/codes/{revoked['id']}/revoke")).status_code == 204  # idempotent


async def test_guessing_codes_is_rate_limited_even_for_a_valid_code(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    good = (await ok(await tenant.post("/v1/guardian/codes", {"student_id": fam.student["id"]}), 201))["code"]
    chat = new_chat()
    for _ in range(10):
        await hook(client, msg(chat, "ZZZZZZZZ"))
    await hook(client, msg(chat, good))
    assert "Juda ko'p" in tg.last(chat)
    assert await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]})) == []


async def test_qr_card_waits_for_the_center_then_links(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    qr = (await ok(await tenant.post(f"/v1/students/{fam.student['id']}/qr", {})))["code"]
    chat = new_chat()
    await hook(client, msg(chat, qr))
    assert "markazga yuborildi" in tg.last(chat)
    await hook(client, msg(chat, qr))  # asking twice keeps one request
    pending = await ok(await tenant.get("/v1/guardian/link-requests"))
    assert (
        len(pending) == 1
        and pending[0]["student_id"] == fam.student["id"]
        and pending[0]["telegram_user_id"] == chat
    )
    assert (
        await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]})) == []
    )  # nothing yet
    done = await ok(
        await tenant.post(f"/v1/guardian/link-requests/{pending[0]['id']}/approve", {"relation": "mother"})
    )
    assert done["status"] == "approved"
    links = await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]}))
    assert links[0]["linked_via"] == "qr" and links[0]["telegram_linked"]
    assert (
        await tenant.post(f"/v1/guardian/link-requests/{pending[0]['id']}/approve", {})
    ).status_code == 409


async def test_qr_request_can_be_rejected_and_unknown_card_is_refused(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    qr = (await ok(await tenant.post(f"/v1/students/{fam.student['id']}/qr", {})))["code"]
    chat = new_chat()
    await hook(client, msg(chat, qr))
    (req,) = await ok(await tenant.get("/v1/guardian/link-requests"))
    assert (await ok(await tenant.post(f"/v1/guardian/link-requests/{req['id']}/reject")))[
        "status"
    ] == "rejected"
    assert await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]})) == []
    other = new_chat()
    await hook(client, msg(other, "NZQ1-" + "A" * 20))
    assert "topilmadi" in tg.last(other)


async def test_qr_requests_of_one_center_are_invisible_to_another(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    qr = (await ok(await tenant.post(f"/v1/students/{fam.student['id']}/qr", {})))["code"]
    await hook(client, msg(new_chat(), qr))
    assert await ok(await tenant_b.get("/v1/guardian/link-requests")) == []
    (req,) = await ok(await tenant.get("/v1/guardian/link-requests"))
    assert (await tenant_b.post(f"/v1/guardian/link-requests/{req['id']}/approve", {})).status_code == 404


async def test_phone_link_needs_telegram_to_vouch_for_the_number(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=False)
    await ok(
        await tenant.post(
            f"/v1/students/{fam.student['id']}/guardians",
            {"guardian_id": fam.guardian["id"], "relation": "mother"},
        ),
        201,
    )
    chat = new_chat()
    # somebody else's contact card (user_id differs) is not proof
    await hook(client, contact(chat, fam.guardian["phone"], user_id=chat + 1))
    assert "topilmadi" in tg.last(chat)
    links = await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]}))
    assert links[0]["telegram_linked"] is False
    # an unknown number
    await hook(client, contact(chat, "+998900000001"))
    assert "topilmadi" in tg.last(chat)
    # his own, known number
    await hook(client, contact(chat, fam.guardian["phone"].replace("+998", "+998 ")))
    links = await ok(await tenant.get("/v1/guardian/links", params={"student_id": fam.student["id"]}))
    assert links[0]["telegram_linked"] is True and links[0]["linked_via"] == "phone"
    # another Telegram user cannot take over the same guardian record
    thief = new_chat()
    await hook(client, contact(thief, fam.guardian["phone"]))
    assert "topilmadi" in tg.last(thief)


async def test_manual_link_unlink_and_session_end(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=True)
    r = await ok(
        await tenant.post(
            "/v1/guardian/links",
            {
                "student_id": fam.student["id"],
                "guardian_id": fam.guardian["id"],
                "telegram_chat_id": fam.chat,
            },
        ),
        201,
    )
    assert r["linked_via"] == "manual"
    other = await mk_guardian(tenant, "Boshqa")
    clash = await tenant.post(
        "/v1/guardian/links",
        {"student_id": fam.student["id"], "guardian_id": other["id"], "telegram_chat_id": fam.chat},
    )
    assert clash.status_code == 409
    h = await sign_in(client, fam.chat)
    assert (await client.get("/v1/cabinet/me", headers=h)).status_code == 200
    assert (
        await tenant.delete(
            "/v1/guardian/links", params={"student_id": fam.student["id"], "guardian_id": fam.guardian["id"]}
        )
    ).status_code == 204
    assert (
        await client.get("/v1/cabinet/me", headers=h)
    ).status_code == 401  # nothing left to see: the session ended
    assert (
        await tenant.delete(
            "/v1/guardian/links", params={"student_id": fam.student["id"], "guardian_id": fam.guardian["id"]}
        )
    ).status_code == 404


# =============================================================================================================
# sign-in
# =============================================================================================================
async def test_mini_app_sign_in_checks_signature_age_and_link(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant)
    ok_r = await client.post("/v1/cabinet/auth/telegram", json={"init_data": init_data(fam.chat)})
    body = await ok(ok_r)
    assert body["token"].startswith("gs_") and body["kind"] == "miniapp"
    for bad in (
        init_data(fam.chat, tamper=True),
        init_data(fam.chat, token="999:other-token"),
        init_data(fam.chat, age_s=90_000),
    ):
        assert (await client.post("/v1/cabinet/auth/telegram", json={"init_data": bad})).status_code == 401
    stranger = await client.post("/v1/cabinet/auth/telegram", json={"init_data": init_data(new_chat())})
    assert stranger.status_code == 403 and stranger.json()["error"]["details"]["reason"] == "not_linked"


async def test_sign_in_is_off_without_a_bot_token(client: httpx.AsyncClient, tenant: Tenant) -> None:
    r = await client.post("/v1/cabinet/auth/telegram", json={"init_data": init_data(1)})
    assert r.status_code == 404


async def test_portal_code_login(client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot) -> None:
    fam = await family(tenant)
    assert (
        await client.post("/v1/cabinet/auth/code/request", json={"phone": fam.guardian["phone"]})
    ).status_code == 202
    text = tg.last(fam.chat)
    code = re.search(r"kodi: (\d{6})", text).group(1)  # type: ignore[union-attr]
    assert (
        await client.post(
            "/v1/cabinet/auth/code/verify", json={"phone": fam.guardian["phone"], "code": "000000"}
        )
    ).status_code == 401
    r = await client.post("/v1/cabinet/auth/code/verify", json={"phone": fam.guardian["phone"], "code": code})
    body = await ok(r)
    assert body["kind"] == "portal"
    assert (
        await client.get("/v1/cabinet/me", headers={"Authorization": f"Bearer {body['token']}"})
    ).status_code == 200
    again = await client.post(
        "/v1/cabinet/auth/code/verify", json={"phone": fam.guardian["phone"], "code": code}
    )
    assert again.status_code == 401  # a code is single use


async def test_login_code_locks_after_five_wrong_attempts(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant)
    await client.post("/v1/cabinet/auth/code/request", json={"phone": fam.guardian["phone"]})
    code = re.search(r"kodi: (\d{6})", tg.last(fam.chat)).group(1)  # type: ignore[union-attr]
    wrong = "111111" if code != "111111" else "222222"
    for _ in range(5):
        assert (
            await client.post(
                "/v1/cabinet/auth/code/verify", json={"phone": fam.guardian["phone"], "code": wrong}
            )
        ).status_code == 401
    assert (
        await client.post("/v1/cabinet/auth/code/verify", json={"phone": fam.guardian["phone"], "code": code})
    ).status_code == 401


async def test_login_code_never_reveals_whether_the_phone_is_known(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, link=False, accepted=False)  # known number, but no Telegram: nowhere to send
    a = await client.post("/v1/cabinet/auth/code/request", json={"phone": fam.guardian["phone"]})
    b = await client.post("/v1/cabinet/auth/code/request", json={"phone": "+998900000009"})
    c = await client.post("/v1/cabinet/auth/code/request", json={"phone": "12"})
    assert (a.status_code, b.status_code, c.status_code) == (
        202,
        202,
        202,
    ) and a.json() == b.json() == c.json()
    assert tg.calls == []


async def test_expired_login_code_is_refused(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    fam = await family(tenant)
    await client.post("/v1/cabinet/auth/code/request", json={"phone": fam.guardian["phone"]})
    code = re.search(r"kodi: (\d{6})", tg.last(fam.chat)).group(1)  # type: ignore[union-attr]
    with psycopg.connect(super_dsn) as c:
        c.execute("UPDATE guardian_login_codes SET expires_at = now() - interval '1 second'")
        c.commit()
    assert (
        await client.post("/v1/cabinet/auth/code/verify", json={"phone": fam.guardian["phone"], "code": code})
    ).status_code == 401


async def test_tokens_are_not_interchangeable_and_logout_ends_the_session(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant)
    h = await sign_in(client, fam.chat)
    assert (await client.get("/v1/cabinet/me")).status_code == 401
    assert (
        await client.get("/v1/cabinet/me", headers=tenant.h)
    ).status_code == 401  # a staff token is not a guardian token
    assert (
        await client.get("/v1/guardian/requests", headers=h)
    ).status_code == 401  # and the other way round
    assert (
        await client.get("/v1/cabinet/me", headers={"Authorization": "Bearer gs_nope"})
    ).status_code == 401
    assert (await client.post("/v1/cabinet/auth/logout", headers=h)).status_code == 204
    assert (await client.get("/v1/cabinet/me", headers=h)).status_code == 401


async def test_center_can_switch_the_cabinet_off(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    fam = await family(tenant)
    h = await sign_in(client, fam.chat)
    with psycopg.connect(super_dsn) as c:
        c.execute(
            "INSERT INTO org_settings (org_id, guardian_cabinet_enabled) SELECT id, false FROM organizations WHERE public_id::text = %s "
            "ON CONFLICT (org_id) DO UPDATE SET guardian_cabinet_enabled = false",
            (tenant.org_id,),
        )
        c.commit()
    r = await client.get("/v1/cabinet/me", headers=h)
    assert r.status_code == 403 and r.json()["error"]["details"]["reason"] == "cabinet_disabled"
    assert (
        await client.post("/v1/cabinet/auth/telegram", json={"init_data": init_data(fam.chat)})
    ).status_code == 403


# =============================================================================================================
# what a guardian reads
# =============================================================================================================
async def test_nothing_is_shown_before_the_consent_is_accepted(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, accepted=False)
    h = await sign_in(client, fam.chat)
    me = await ok(await client.get("/v1/cabinet/me", headers=h))
    assert me["students"][0]["consent"] is False
    sid = fam.student["id"]
    for part in ("attendance", "balance", "documents", "schedule", "results", "makeup", "absence-lessons"):
        r = await client.get(f"/v1/cabinet/students/{sid}/{part}", headers=h)
        assert r.status_code == 403 and r.json()["error"]["details"]["reason"] == "consent_required", part
    await ok(await client.post(f"/v1/cabinet/students/{sid}/consent", headers=h))
    assert (await client.get(f"/v1/cabinet/students/{sid}/attendance", headers=h)).status_code == 200
    assert (await ok(await client.get("/v1/cabinet/me", headers=h)))["students"][0]["consent"] is True


async def test_guardian_sees_attendance_debt_plan_documents_schedule_and_results(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    grp = await lessons_group(tenant, past=True)
    fam = await family(tenant, group=grp)
    sid = fam.student["id"]
    past = await lesson_at(tenant, grp["id"], TODAY - timedelta(days=2))
    await ok(
        await tenant.put(
            f"/v1/lessons/{past['id']}/attendance",
            {"records": [{"student_id": sid, "status": "late", "minutes_late": 7}]},
        )
    )
    charge = await debt(tenant, fam.student, "600000", due=-10)
    await ok(
        await tenant.put(
            f"/v1/charges/{charge['id']}/plan",
            {
                "installments": [
                    {"amount": "300000", "due_date": (TODAY - timedelta(days=10)).isoformat()},
                    {"amount": "300000", "due_date": (TODAY + timedelta(days=20)).isoformat()},
                ]
            },
        )
    )
    pay = await ok(
        await tenant.post("/v1/payments", {"student_id": sid, "amount": "100000", "method": "cash"}), 201
    )
    await ok(
        await tenant.put(
            "/v1/marks",
            {
                "student_id": sid,
                "group_id": grp["id"],
                "scope": "lesson",
                "lesson_id": past["id"],
                "grade": 5,
                "note": "Zo'r",
            },
        ),
        201,
    )
    h = await sign_in(client, fam.chat)

    att = await ok(await client.get(f"/v1/cabinet/students/{sid}/attendance", headers=h))
    assert att["counts"]["late"] == 1 and att["records"][0]["minutes_late"] == 7
    bal = await ok(await client.get(f"/v1/cabinet/students/{sid}/balance", headers=h))
    assert (
        bal["outstanding_total"] == "500000.00" and bal["open_charges"][0]["plan"]["installments"][0]["paid"]
    )
    assert bal["recent_payments"][0]["amount"] == "100000.00"
    sch = await ok(await client.get(f"/v1/cabinet/students/{sid}/schedule", headers=h))
    assert (
        sch["lessons"] and sch["weekly"] and all(les["lesson_date"] >= str(TODAY) for les in sch["lessons"])
    )
    res = await ok(await client.get(f"/v1/cabinet/students/{sid}/results", headers=h))
    assert res["marks"][0]["grade"] == 5 and res["marks"][0]["note"] == "Zo'r"
    assert pay["id"]


async def test_receipt_pdf_download_and_foreign_documents_are_hidden(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    await set_requisites(tenant)
    mine, other = await family(tenant), await family(tenant)
    docs: dict[str, dict[str, Any]] = {}
    for f in (mine, other):
        await debt(tenant, f.student, "400000")
        payment = await ok(
            await tenant.post(
                "/v1/payments", {"student_id": f.student["id"], "amount": "400000", "method": "cash"}
            ),
            201,
        )
        docs[str(f.chat)] = await ok(
            await tenant.post("/v1/documents/receipts", {"payment_id": payment["id"]}), 201
        )
    h = await sign_in(client, mine.chat)
    listing = await ok(await client.get(f"/v1/cabinet/students/{mine.student['id']}/documents", headers=h))
    assert [d["id"] for d in listing] == [docs[str(mine.chat)]["id"]]
    pdf = await client.get(f"/v1/cabinet/documents/{listing[0]['id']}/pdf", headers=h)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    assert (
        await client.get(f"/v1/cabinet/documents/{docs[str(other.chat)]['id']}/pdf", headers=h)
    ).status_code == 404


async def test_a_guardian_cannot_reach_another_family_or_center(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant, tg: FakeBot
) -> None:
    mine, other = await family(tenant), await family(tenant)
    foreign = await family(tenant_b)
    h = await sign_in(client, mine.chat)
    for sid in (other.student["id"], foreign.student["id"], str(uuid.uuid4())):
        for part in ("attendance", "balance", "documents", "schedule", "results", "makeup"):
            assert (await client.get(f"/v1/cabinet/students/{sid}/{part}", headers=h)).status_code == 404, (
                sid,
                part,
            )
        assert (await client.post(f"/v1/cabinet/students/{sid}/consent", headers=h)).status_code == 404
    me = await ok(await client.get("/v1/cabinet/me", headers=h))
    assert [s["id"] for s in me["students"]] == [mine.student["id"]]
    # the sibling case: one guardian with two children sees both, nothing else
    sib = await mk_student(tenant, "Sibling")
    await enroll(tenant, mine.group["id"], sib["id"], "2026-01-01")
    await ok(
        await tenant.post(
            "/v1/guardian/links",
            {"student_id": sib["id"], "guardian_id": mine.guardian["id"], "telegram_chat_id": mine.chat},
        ),
        201,
    )
    await consent(tenant, sib["id"], "data_processing", mine.guardian["id"])
    me = await ok(await client.get("/v1/cabinet/me", headers=h))
    assert {s["id"] for s in me["students"]} == {mine.student["id"], sib["id"]}


# =============================================================================================================
# requests: absence reason
# =============================================================================================================
async def mark_of(t: Tenant, lesson: dict[str, Any], student_id: str) -> str | None:
    roster = (await ok(await t.get(f"/v1/lessons/{lesson['id']}/attendance")))["entries"]
    return next(e["status"] for e in roster if e["student_id"] == student_id)  # type: ignore[no-any-return]


async def test_absence_request_changes_nothing_until_the_center_approves(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    fam = await family(tenant)
    h = await sign_in(client, fam.chat)
    options = await ok(
        await client.get(f"/v1/cabinet/students/{fam.student['id']}/absence-lessons", headers=h)
    )
    lesson = options[0]
    req = await ok(
        await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "absence_reason",
                "student_id": fam.student["id"],
                "lesson_id": lesson["id"],
                "reason": "Kasal bo'ldi",
            },
        ),
        201,
    )
    assert req["status"] == "pending"
    assert await mark_of(tenant, lesson, fam.student["id"]) is None  # nothing marked
    inbox = await ok(await tenant.get("/v1/guardian/requests"))
    assert [r["id"] for r in inbox] == [req["id"]] and inbox[0]["reason"] == "Kasal bo'ldi"
    done = await ok(await tenant.post(f"/v1/guardian/requests/{req['id']}/approve", {"note": "Tuzalsin"}))
    assert done["status"] == "approved" and done["decision_note"] == "Tuzalsin"
    assert await mark_of(tenant, lesson, fam.student["id"]) == "excused"
    rights = await ok(await tenant.get("/v1/entitlements", params={"student_id": fam.student["id"]}))
    assert rights["items"] and rights["items"][0]["kind"] == "makeup"  # the existing make-up rule ran
    mine = await ok(await client.get("/v1/cabinet/requests", headers=h))
    assert mine[0]["status"] == "approved" and mine[0]["decision_note"] == "Tuzalsin"
    assert (await tenant.post(f"/v1/guardian/requests/{req['id']}/approve", {})).status_code == 409
    assert outbox_count(super_dsn, tenant.org_id) == 0  # nothing was queued for any guardian


async def test_rejected_absence_changes_nothing_and_cannot_be_decided_twice(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant)
    h = await sign_in(client, fam.chat)
    lesson = (
        await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/absence-lessons", headers=h))
    )[0]
    req = await ok(
        await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "absence_reason",
                "student_id": fam.student["id"],
                "lesson_id": lesson["id"],
                "reason": "Sayohat",
            },
        ),
        201,
    )
    again = await client.post(
        "/v1/cabinet/requests",
        headers=h,
        json={
            "kind": "absence_reason",
            "student_id": fam.student["id"],
            "lesson_id": lesson["id"],
            "reason": "Yana",
        },
    )
    assert again.status_code == 409  # one open request per lesson
    assert (
        await ok(
            await tenant.post(f"/v1/guardian/requests/{req['id']}/reject", {"note": "Sabab yetarli emas"})
        )
    )["status"] == "rejected"
    assert await mark_of(tenant, lesson, fam.student["id"]) is None
    assert (await tenant.post(f"/v1/guardian/requests/{req['id']}/approve", {})).status_code == 409
    assert (await tenant.post(f"/v1/guardian/requests/{req['id']}/reject", {})).status_code == 409
    assert (await client.post(f"/v1/cabinet/requests/{req['id']}/cancel", headers=h)).status_code == 409


async def test_guardian_can_withdraw_a_waiting_request(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant)
    h = await sign_in(client, fam.chat)
    lesson = (
        await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/absence-lessons", headers=h))
    )[0]
    req = await ok(
        await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "absence_reason",
                "student_id": fam.student["id"],
                "lesson_id": lesson["id"],
                "reason": "Kasal",
            },
        ),
        201,
    )
    assert (await ok(await client.post(f"/v1/cabinet/requests/{req['id']}/cancel", headers=h)))[
        "status"
    ] == "cancelled"
    assert (await tenant.post(f"/v1/guardian/requests/{req['id']}/approve", {})).status_code == 409
    assert await ok(await tenant.get("/v1/guardian/requests")) == []
    # the same lesson can be announced again after a withdrawal
    assert (
        await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "absence_reason",
                "student_id": fam.student["id"],
                "lesson_id": lesson["id"],
                "reason": "Yana kasal",
            },
        )
    ).status_code == 201
    # and nobody else's guardian can withdraw it
    other = await family(tenant)
    ho = await sign_in(client, other.chat)
    assert (await client.post(f"/v1/cabinet/requests/{req['id']}/cancel", headers=ho)).status_code == 404


async def test_absence_rules_are_enforced_with_a_reason_for_the_guardian(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    past_group = await lessons_group(tenant, past=True)
    fam = await family(tenant, group=past_group)
    stranger_group = await lessons_group(tenant)
    h = await sign_in(client, fam.chat)

    async def ask(lesson_id: str, reason: str = "Kasal") -> httpx.Response:
        return await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "absence_reason",
                "student_id": fam.student["id"],
                "lesson_id": lesson_id,
                "reason": reason,
            },
        )

    future = await lesson_at(tenant, past_group["id"], TOMORROW)
    started = await lesson_at(tenant, past_group["id"], TODAY - timedelta(days=2))
    foreign = await lesson_at(tenant, stranger_group["id"], TOMORROW)
    assert (await ask(future["id"], "   ")).json()["error"]["details"]["reason"] == "reason_required"
    assert (await ask(future["id"], "x" * 301)).status_code == 422
    r = await ask(started["id"])
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "lesson_started"
    assert (
        await ask(foreign["id"])
    ).status_code == 404  # a lesson of a group the student is not in is not even visible
    await ok(
        await tenant.put(
            f"/v1/lessons/{future['id']}/attendance",
            {"records": [{"student_id": fam.student["id"], "status": "present"}]},
        )
    )
    assert (await ask(future["id"])).json()["error"]["details"]["reason"] == "already_marked"
    assert (await ask(str(uuid.uuid4()))).status_code == 404


# =============================================================================================================
# requests: payment promise
# =============================================================================================================
async def test_promise_checks_and_approval(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    fam = await family(tenant)
    h = await sign_in(client, fam.chat)
    sid = fam.student["id"]

    async def promise(days: int, amount: str | None = None) -> httpx.Response:
        body: dict[str, Any] = {
            "kind": "payment_promise",
            "student_id": sid,
            "promise_date": (TODAY + timedelta(days=days)).isoformat(),
        }
        if amount:
            body["amount"] = amount
        return await client.post("/v1/cabinet/requests", headers=h, json=body)

    r = await promise(3)
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "no_debt"
    await debt(tenant, fam.student, "600000", due=2)
    assert (await promise(-1)).json()["error"]["details"]["reason"] == "date_past"
    assert (await promise(15)).json()["error"]["details"]["reason"] == "date_too_far"
    assert (await promise(3, "600001")).json()["error"]["details"]["reason"] == "amount_invalid"
    assert (await promise(3, "0")).status_code == 422
    made = await ok(await promise(3, "250000"), 201)
    assert made["status"] == "pending" and made["promise_amount"] == "250000.00"
    assert (await promise(4)).json()["error"]["details"]["reason"] == "duplicate"
    bal = await ok(await client.get(f"/v1/cabinet/students/{sid}/balance", headers=h))
    assert bal["promises"][0]["state"] == "pending"
    await ok(await tenant.post(f"/v1/guardian/requests/{made['id']}/approve", {}))
    bal = await ok(await client.get(f"/v1/cabinet/students/{sid}/balance", headers=h))
    assert bal["promises"][0]["state"] == "active"
    assert (await promise(5)).json()["error"]["details"][
        "reason"
    ] == "duplicate"  # the approved promise still holds
    approved = await ok(
        await tenant.get("/v1/guardian/requests", params={"status": "approved", "kind": "payment_promise"})
    )
    assert len(approved) == 1 and approved[0]["promise_date"] == (TODAY + timedelta(days=3)).isoformat()
    # the debt is paid: the promise counts as kept
    await ok(
        await tenant.post("/v1/payments", {"student_id": sid, "amount": "600000", "method": "cash"}), 201
    )
    bal = await ok(await client.get(f"/v1/cabinet/students/{sid}/balance", headers=h))
    assert bal["promises"][0]["state"] == "kept"
    assert outbox_count(super_dsn, tenant.org_id) == 0


async def test_promise_horizon_is_the_centers_setting(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    fam = await family(tenant)
    await debt(tenant, fam.student)
    with psycopg.connect(super_dsn) as c:
        c.execute(
            "INSERT INTO org_settings (org_id, guardian_promise_max_days) SELECT id, 30 FROM organizations WHERE public_id::text = %s "
            "ON CONFLICT (org_id) DO UPDATE SET guardian_promise_max_days = 30",
            (tenant.org_id,),
        )
        c.commit()
    h = await sign_in(client, fam.chat)
    assert (await ok(await client.get("/v1/cabinet/me", headers=h)))["promise_max_days"] == 30
    r = await client.post(
        "/v1/cabinet/requests",
        headers=h,
        json={
            "kind": "payment_promise",
            "student_id": fam.student["id"],
            "promise_date": (TODAY + timedelta(days=30)).isoformat(),
        },
    )
    assert r.status_code == 201


# =============================================================================================================
# requests: make-up slot
# =============================================================================================================
async def makeup_setup(
    t: Tenant, client: httpx.AsyncClient
) -> tuple[Fam, dict[str, Any], dict[str, Any], dict[str, str]]:
    """A student with an open make-up right (an excused absence) and another group of the same course with a lesson."""
    course = await mk_course(t)
    home = await lessons_group(t, course["id"])
    other = await lessons_group(t, course["id"], capacity=2, start="15:00:00")
    fam = await family(t, group=home)
    missed = await lesson_at(t, home["id"], TOMORROW)
    await ok(
        await t.put(
            f"/v1/lessons/{missed['id']}/attendance",
            {"records": [{"student_id": fam.student["id"], "status": "excused"}]},
        )
    )
    return fam, home, other, await sign_in(client, fam.chat)


async def test_makeup_slots_are_other_groups_of_the_course_with_a_free_seat(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam, home, other, h = await makeup_setup(tenant, client)
    rights = await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/makeup", headers=h))
    assert len(rights) == 1 and rights[0]["slots"]
    assert all(s["group_name"] == other["name"] for s in rights[0]["slots"])
    assert all(s["date"] > str(TODAY) for s in rights[0]["slots"])
    # fill the other group (capacity 2) and its slots disappear
    for i in range(2):
        s = await mk_student(tenant, f"Filler {i}")
        await enroll(tenant, other["id"], s["id"], "2026-01-01")
    assert (await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/makeup", headers=h)))[0][
        "slots"
    ] == []


async def test_makeup_choice_is_scheduled_only_after_approval(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    fam, home, other, h = await makeup_setup(tenant, client)
    right = (await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/makeup", headers=h)))[0]
    slot = right["slots"][0]
    req = await ok(
        await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "makeup_choice",
                "student_id": fam.student["id"],
                "entitlement_id": right["id"],
                "slot_lesson_id": slot["lesson_id"],
            },
        ),
        201,
    )
    ent = (await ok(await tenant.get("/v1/entitlements", params={"student_id": fam.student["id"]})))["items"][
        0
    ]
    assert ent["status"] == "open" and ent["makeup_lesson_id"] is None  # still nothing scheduled
    dup = await client.post(
        "/v1/cabinet/requests",
        headers=h,
        json={
            "kind": "makeup_choice",
            "student_id": fam.student["id"],
            "entitlement_id": right["id"],
            "slot_lesson_id": right["slots"][-1]["lesson_id"],
        },
    )
    assert dup.status_code == 409
    await ok(await tenant.post(f"/v1/guardian/requests/{req['id']}/approve", {}))
    ent = (await ok(await tenant.get("/v1/entitlements", params={"student_id": fam.student["id"]})))["items"][
        0
    ]
    assert ent["status"] == "scheduled" and ent["makeup_date"] == slot["date"]
    # the guardian now sees the make-up lesson in his schedule and no open right
    sch = await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/schedule", headers=h))
    assert any(les["kind"] == "makeup" and les["lesson_date"] == slot["date"] for les in sch["lessons"])
    assert await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/makeup", headers=h)) == []
    assert outbox_count(super_dsn, tenant.org_id) == 0


async def test_makeup_choice_validation(client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot) -> None:
    fam, home, other, h = await makeup_setup(tenant, client)
    right = (await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/makeup", headers=h)))[0]

    async def choose(entitlement: str, slot: str) -> httpx.Response:
        return await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "makeup_choice",
                "student_id": fam.student["id"],
                "entitlement_id": entitlement,
                "slot_lesson_id": slot,
            },
        )

    not_offered = await lesson_at(
        tenant, home["id"], TOMORROW + timedelta(days=2)
    )  # a lesson of his OWN group is not a slot
    r = await choose(right["id"], not_offered["id"])
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "slot_unavailable"
    assert (await choose(str(uuid.uuid4()), right["slots"][0]["lesson_id"])).status_code == 404
    # a right that expired in the meantime
    await ok(
        await tenant.post(
            f"/v1/entitlements/{(await ok(await tenant.get('/v1/entitlements', params={'student_id': fam.student['id']})))['items'][0]['id']}/cancel"
        )
    )
    r = await choose(right["id"], right["slots"][0]["lesson_id"])
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "not_open"


async def test_approving_a_makeup_whose_slot_filled_up_is_refused(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam, home, other, h = await makeup_setup(tenant, client)
    right = (await ok(await client.get(f"/v1/cabinet/students/{fam.student['id']}/makeup", headers=h)))[0]
    req = await ok(
        await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "makeup_choice",
                "student_id": fam.student["id"],
                "entitlement_id": right["id"],
                "slot_lesson_id": right["slots"][0]["lesson_id"],
            },
        ),
        201,
    )
    for i in range(2):
        s = await mk_student(tenant, f"Late filler {i}")
        await enroll(tenant, other["id"], s["id"], "2026-01-01")
    r = await tenant.post(f"/v1/guardian/requests/{req['id']}/approve", {})
    assert r.status_code == 409
    still = await ok(await tenant.get("/v1/guardian/requests"))
    assert still[0]["status"] == "pending"  # nothing half-applied


# =============================================================================================================
# branches
# =============================================================================================================
async def test_staff_of_a_branch_decide_only_their_own_branch(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    b1, b2 = await mk_branch(tenant), await mk_branch(tenant)
    admin1 = await branch_staff(client, tenant, b1["id"])
    admin2 = await branch_staff(client, tenant, b2["id"])
    fams = []
    for b in (b1, b2):
        s = await ok(
            await tenant.post("/v1/students", {"full_name": f"Branch student {b['name']}"}, headers=view(b)),
            201,
        )
        g = await mk_guardian(tenant, "Vasiy")
        chat = new_chat()
        await ok(
            await tenant.post(
                "/v1/guardian/links",
                {"student_id": s["id"], "guardian_id": g["id"], "telegram_chat_id": chat},
            ),
            201,
        )
        await consent(tenant, s["id"], "data_processing", g["id"])
        await debt(tenant, s)
        fams.append((s, chat))
    ids = []
    for s, chat in fams:
        h = await sign_in(client, chat)
        r = await ok(
            await client.post(
                "/v1/cabinet/requests",
                headers=h,
                json={
                    "kind": "payment_promise",
                    "student_id": s["id"],
                    "promise_date": (TODAY + timedelta(days=2)).isoformat(),
                },
            ),
            201,
        )
        ids.append(r["id"])
    assert [r["id"] for r in await ok(await admin1.get("/v1/guardian/requests"))] == [ids[0]]
    assert [r["id"] for r in await ok(await admin2.get("/v1/guardian/requests"))] == [ids[1]]
    assert (await admin1.post(f"/v1/guardian/requests/{ids[1]}/approve", {})).status_code == 404
    assert (await admin2.post(f"/v1/guardian/requests/{ids[1]}/approve", {})).status_code == 200
    assert {r["id"] for r in await ok(await tenant.get("/v1/guardian/requests"))} == {ids[0]}


# =============================================================================================================
# the bot
# =============================================================================================================
async def test_bot_rejects_a_wrong_secret_and_is_off_without_configuration(
    client: httpx.AsyncClient, tg: FakeBot, app: Any
) -> None:
    assert (await hook(client, msg(1, "/start"), secret="wrong")).status_code == 403
    assert (await hook(client, msg(1, "/start"), secret="")).status_code == 403
    assert tg.calls == []
    unknown = await client.post(
        "/hooks/bot/00000000-0000-0000-0000-000000000000",
        json={"update_id": 1},
        headers={"X-Telegram-Bot-Api-Secret-Token": HOOK_SECRET},
    )
    assert unknown.status_code == 404


async def test_bot_start_for_a_stranger_asks_for_a_code_or_the_contact(
    client: httpx.AsyncClient, tg: FakeBot
) -> None:
    chat = new_chat()
    await hook(client, msg(chat, "/start"))
    first = tg.calls[-1]["json"]
    assert "kod" in first["text"] and first["reply_markup"]["keyboard"][0][0]["request_contact"] is True
    await hook(client, msg(chat, "salom"))
    assert len(tg.texts(chat)) == 2
    group_chat = {"message": {"chat": {"id": -100, "type": "group"}, "from": {"id": chat}, "text": "/start"}}
    await hook(client, group_chat)
    assert len(tg.texts(chat)) == 2 and -100 not in tg.chats()  # a group is ignored


async def test_bot_menu_and_read_buttons(client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot) -> None:
    fam = await family(tenant)
    charge = await debt(tenant, fam.student, "600000", due=-3)
    await ok(
        await tenant.put(
            f"/v1/charges/{charge['id']}/plan",
            {
                "installments": [
                    {"amount": "300000", "due_date": (TODAY - timedelta(days=3)).isoformat()},
                    {"amount": "300000", "due_date": (TODAY + timedelta(days=9)).isoformat()},
                ]
            },
        )
    )
    await hook(client, msg(fam.chat, "/start"))
    labels = [b["text"] for b in tg.keyboard(fam.chat)]
    assert any("Davomat" in t for t in labels) and any("Kabinetni ochish" in t for t in labels)
    web = next(b for b in tg.keyboard(fam.chat) if "web_app" in b)
    assert web["web_app"]["url"] == "https://nazoratly.test/ui/guardian"
    t = tok(fam.student["id"])
    await hook(client, tap(fam.chat, f"b:{t}"))
    text = tg.last(fam.chat)
    assert "600 000 so'm" in text and "300 000" in text and "!" in text  # the overdue installment is flagged
    await hook(client, tap(fam.chat, f"s:{t}"))
    assert "Dars" in tg.last(fam.chat) or fam.group["name"] in tg.last(fam.chat)
    await hook(client, tap(fam.chat, f"a:{t}"))
    assert "Keldi 0" in tg.last(fam.chat)
    assert tg.chats() == {fam.chat}  # the bot only ever answered the guardian who wrote


async def test_bot_asks_for_consent_first_and_nothing_else_until_it_is_given(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant, accepted=False)
    t = tok(fam.student["id"])
    await hook(client, msg(fam.chat, "/start"))
    assert (
        "rozilik" in tg.last(fam.chat) and next(b["callback_data"] for b in tg.keyboard(fam.chat)) == f"c:{t}"
    )
    await hook(client, tap(fam.chat, f"b:{t}"))
    assert "rozilik" in tg.last(fam.chat)  # still the consent prompt: no balance leaked
    await hook(client, tap(fam.chat, f"c:{t}"))
    assert any("Davomat" in b["text"] for b in tg.keyboard(fam.chat))
    detail = await ok(await tenant.get(f"/v1/students/{fam.student['id']}"))
    assert {c["purpose"] for c in detail["consents"] if c["revoked_at"] is None} >= {
        "data_processing",
        "notifications",
    }


async def test_bot_sends_a_receipt_pdf_only_to_its_owner_chat(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    await set_requisites(tenant)
    fam = await family(tenant)
    await debt(tenant, fam.student, "400000")
    payment = await ok(
        await tenant.post(
            "/v1/payments", {"student_id": fam.student["id"], "amount": "400000", "method": "cash"}
        ),
        201,
    )
    doc = await ok(await tenant.post("/v1/documents/receipts", {"payment_id": payment["id"]}), 201)
    t = tok(fam.student["id"])
    await hook(client, tap(fam.chat, f"d:{t}"))
    btn = next(b for b in tg.keyboard(fam.chat) if b["callback_data"].startswith("D:"))
    await hook(client, tap(fam.chat, btn["callback_data"]))
    (sent,) = tg.documents(fam.chat)
    assert b"%PDF" in sent["file"] and doc["number"].encode() in sent["file"]
    # another guardian cannot fetch it by guessing the token
    other = await family(tenant)
    await hook(client, tap(other.chat, btn["callback_data"].replace(t, tok(other.student["id"]))))
    assert tg.documents(other.chat) == []


async def test_bot_absence_flow_through_a_force_reply(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot
) -> None:
    fam = await family(tenant)
    t = tok(fam.student["id"])
    await hook(client, tap(fam.chat, f"x:{t}"))
    pick = tg.keyboard(fam.chat)[0]["callback_data"]
    assert pick.startswith(f"xl:{t}:")
    await hook(client, tap(fam.chat, pick))
    prompt = tg.calls[-1]["json"]
    assert prompt["reply_markup"]["force_reply"] is True and re.search(r"#g\d+:a:", prompt["text"])
    await hook(client, msg(fam.chat, "Isitma bor", reply_to_message={"text": prompt["text"]}))
    assert "markazga yuborildi" in tg.last(fam.chat)
    (req,) = await ok(await tenant.get("/v1/guardian/requests"))
    assert req["kind"] == "absence_reason" and req["reason"] == "Isitma bor" and req["status"] == "pending"
    # answering with an empty reason or a command does not create a second request
    await hook(client, msg(fam.chat, "Yana", reply_to_message={"text": prompt["text"]}))
    assert "⚠️" in tg.last(fam.chat)  # one open request per lesson
    assert len(await ok(await tenant.get("/v1/guardian/requests"))) == 1


async def test_bot_promise_and_makeup_flows(client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot) -> None:
    fam, home, other, _h = await makeup_setup(tenant, client)
    await debt(tenant, fam.student)
    t = tok(fam.student["id"])
    await hook(client, tap(fam.chat, f"p:{t}"))
    first = tg.keyboard(fam.chat)[0]["callback_data"]
    assert first.startswith(f"pd:{t}:")
    await hook(client, tap(fam.chat, first))
    assert "markazga yuborildi" in tg.last(fam.chat)
    await hook(client, tap(fam.chat, first))  # a second promise while one waits
    assert "⚠️" in tg.last(fam.chat)
    await hook(client, tap(fam.chat, f"m:{t}"))
    slot = tg.keyboard(fam.chat)[0]["callback_data"]
    assert slot.startswith(f"mk:{t}:")
    await hook(client, tap(fam.chat, slot))
    assert "markazga yuborildi" in tg.last(fam.chat)
    kinds = sorted(r["kind"] for r in await ok(await tenant.get("/v1/guardian/requests")))
    assert kinds == ["makeup_choice", "payment_promise"]
    await hook(client, tap(fam.chat, "q"))
    assert "kutilmoqda" in tg.last(fam.chat)
    assert tg.chats() == {fam.chat}


async def test_bot_never_messages_anyone_when_staff_decide(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    fam = await family(tenant)
    await debt(tenant, fam.student)
    h = await sign_in(client, fam.chat)
    req = await ok(
        await client.post(
            "/v1/cabinet/requests",
            headers=h,
            json={
                "kind": "payment_promise",
                "student_id": fam.student["id"],
                "promise_date": (TODAY + timedelta(days=2)).isoformat(),
            },
        ),
        201,
    )
    before = len(tg.calls)
    await ok(await tenant.post(f"/v1/guardian/requests/{req['id']}/approve", {}))
    assert len(tg.calls) == before and outbox_count(super_dsn, tenant.org_id) == 0  # pull, not push (Model B)


async def test_unlinked_or_foreign_students_are_unreachable_through_the_bot(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant, tg: FakeBot
) -> None:
    mine, other = await family(tenant), await family(tenant_b)
    await hook(client, tap(mine.chat, f"b:{tok(other.student['id'])}"))
    assert "topilmadi" in tg.last(mine.chat)
    assert tg.chats() == {mine.chat}


async def test_tenant_fixture_still_isolated_after_guardian_activity(tenant: Tenant) -> None:
    other = await make_tenant(tenant.client, "iso")
    assert await ok(await other.get("/v1/guardian/links")) == []


# =============================================================================================================
# the page
# =============================================================================================================
async def test_cabinet_page_is_served_for_telegram_and_calls_only_documented_endpoints(
    client: httpx.AsyncClient,
) -> None:
    r = await client.get("/ui/guardian")
    assert (
        r.status_code == 200
        and r.headers["content-type"].startswith("text/html")
        and "<script>" not in r.text
    )
    csp = r.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "'unsafe-inline'" not in csp and "web.telegram.org" in csp
    assert r.headers["cache-control"] == "no-store" and "camera=()" in r.headers["permissions-policy"]
    js = await client.get("/ui/static/guardian.js")
    css = await client.get("/ui/static/guardian.css")
    assert (
        js.status_code == 200
        and css.status_code == 200
        and "script-src 'self'" in js.headers["content-security-policy"]
    )
    spec = (await client.get("/openapi.json")).json()["paths"]
    called = set(re.findall(r'"(/v1/cabinet/[a-z/_{}-]*)', js.text))
    assert called
    for path in called:
        assert any(p.startswith(path.rstrip("/")) for p in spec), path
    # the page never puts the session token into a URL
    # nothing secret travels in the address: the only thing read from the query is the public id of a center's bot
    assert "?token" not in js.text
    assert (
        js.text.count("location.search") == 1 and 'new URLSearchParams(location.search).get("bot")' in js.text
    )
