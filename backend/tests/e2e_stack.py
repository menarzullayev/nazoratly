"""Throw-away stack for the browser end-to-end tests of the API-served pages (guardian portal, teacher Mini App, calendar,
QR scan, import). Started by Playwright's global setup, never by hand against live data:

    uv run python -m tests.e2e_stack

It starts a disposable PostgreSQL 16 (Docker, tmpfs, random port, unique name), applies every migration, runs the real FastAPI
app on a random port and a small *control* server on another random port, then prints one line ``READY {json}`` and waits until
its stdin closes (or it is killed). Telegram is a fake transport (no network): the control server exposes the fake outbox so a
test can read the login code "sent to the guardian's chat", signs ``initData`` with a TEST bot token only, and builds fresh
fixtures on demand (every fixture is its own center, so tests never depend on each other). It never touches the live compose
project on 8010/8012.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import selectors
import socket
import subprocess
import sys
import time
import traceback
import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
import psycopg
import uvicorn
from cryptography.fernet import Fernet
from pydantic import SecretStr
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from nazoratly.password_reset import issue_link
from tests.conftest import MIGRATIONS, PG_IMAGE, ROLE_PW, SUPER_PW, Tenant, make_tenant
from tests.helpers import consent, enroll, mk_group, mk_guardian, mk_student, mk_teacher, ok, org_today
from tests.telegram_support import next_update_id, register_shared

BOT_TOKEN = "123456:TEST-bot-token-not-real"
HOOK_SECRET = "hook-secret-for-tests-123"
TEACHER_PW = "teacher-password-123"
TODAY = org_today()
TOMORROW = TODAY + timedelta(days=1)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def docker(*args: str) -> str:
    r = subprocess.run(["docker", *args], capture_output=True, text=True, check=False)  # noqa: S603, S607
    if r.returncode:
        raise RuntimeError(f"docker {' '.join(args[:2])} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def docker_retry(*args: str, tries: int = 8) -> str:
    """Docker Desktop answers 500 for a few seconds now and then while it is busy; a plain retry is the right answer."""
    for attempt in range(tries):
        try:
            return docker(*args)
        except RuntimeError:
            if attempt == tries - 1:
                raise
            time.sleep(5)
    raise AssertionError("unreachable")


def start_postgres() -> dict[str, Any]:
    name = f"nazoratly-e2e-web-{uuid.uuid4().hex[:8]}"
    docker_retry(
        "run", "-d", "--rm", "--name", name, "-e", f"POSTGRES_PASSWORD={SUPER_PW}",
        "-p", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data", PG_IMAGE,
        "-c", "max_connections=200", "-c", "fsync=off",
    )  # fmt: skip
    port = int(docker("port", name, "5432/tcp").splitlines()[0].rsplit(":", 1)[1])
    dsn = f"postgresql://postgres:{SUPER_PW}@127.0.0.1:{port}/postgres"
    deadline = time.time() + 90
    while True:
        try:
            with psycopg.connect(dsn, connect_timeout=2) as c:
                c.execute("SELECT 1")
            break
        except psycopg.OperationalError:
            if time.time() > deadline:
                raise
            time.sleep(0.5)
    with psycopg.connect(dsn, autocommit=True) as c:
        for f in sorted(MIGRATIONS.glob("*.up.sql")):
            c.execute(f.read_text(encoding="utf-8"))  # type: ignore[arg-type]
        for role in ("nazoratly_app", "nazoratly_auth", "nazoratly_agent", "nazoratly_worker"):
            c.execute(f"ALTER ROLE {role} LOGIN PASSWORD '{ROLE_PW}'")  # type: ignore[arg-type]
    return {"name": name, "port": port, "super": dsn}


def role_dsn(pg: dict[str, Any], role: str) -> str:
    return f"postgresql://{role}:{ROLE_PW}@127.0.0.1:{pg['port']}/postgres"


# ---- fake Telegram -------------------------------------------------------------------------------------------------
class FakeBot:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        method = req.url.path.rsplit("/", 1)[1]
        if method == "sendDocument":
            m = re.search(rb'name="chat_id"\r\n\r\n(\d+)', req.content)
            self.calls.append({"method": method, "chat": int(m.group(1)) if m else None})
        else:
            payload = json.loads(req.content)
            self.calls.append({"method": method, "chat": payload.get("chat_id"), "json": payload})
        return httpx.Response(200, json={"ok": True})

    def texts(self, chat: int) -> list[str]:
        return [c["json"]["text"] for c in self.calls if c["method"] == "sendMessage" and c["chat"] == chat]


def init_data(user_id: int, *, age_s: int = 0, tamper: bool = False, token: str = BOT_TOKEN) -> str:
    """Telegram Mini App launch data signed exactly as Telegram does it, with the TEST bot token."""
    params = {
        "auth_date": str(int(time.time()) - age_s),
        "query_id": "AAHtest",
        "user": json.dumps({"id": user_id, "first_name": "Ali", "language_code": "uz"}),
    }
    check = "\n".join(f"{k}={params[k]}" for k in sorted(params))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    sig = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if tamper:
        params["user"] = json.dumps({"id": user_id + 1})
    return urlencode({**params, "hash": sig})


def new_chat() -> int:
    return 5_000_000 + uuid.uuid4().int % 900_000_000


# ---- fixtures ------------------------------------------------------------------------------------------------------
class Factory:
    def __init__(self, client: httpx.AsyncClient, pg: dict[str, Any], bot: FakeBot) -> None:
        self.client, self.pg, self.bot = client, pg, bot
        self.app: Any = None
        self.hook_path = ""  # the registered shared bot's webhook

    def sql(self, query: str, params: tuple[Any, ...] = ()) -> None:
        with psycopg.connect(self.pg["super"], autocommit=True) as c:
            c.execute(query, params)  # type: ignore[arg-type]

    async def owner(self) -> dict[str, Any]:
        t = await make_tenant(self.client, "owner")
        return {"email": t.email, "password": t.password, "org_id": t.org_id, "_t": t}

    async def lessons_group(
        self,
        t: Tenant,
        *,
        past: bool = False,
        teacher_id: str | None = None,
        course_id: str | None = None,
        start: str = "10:00:00",
    ) -> dict[str, Any]:
        grp = await mk_group(t, course_id, teacher_id=teacher_id)
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

    async def lesson_at(self, t: Tenant, group_id: str, day: Any) -> dict[str, Any]:
        items = (
            await ok(
                await t.get(
                    "/v1/lessons",
                    params={"date_from": day.isoformat(), "date_to": day.isoformat(), "group_id": group_id},
                )
            )
        )["items"]
        return items[0]  # type: ignore[no-any-return]

    async def family(self, *, rich: bool = True, link: bool = True, accepted: bool = True) -> dict[str, Any]:
        """A center with one student and one guardian whose Telegram chat is linked; ``rich`` adds data for every tab."""
        o = await self.owner()
        t: Tenant = o["_t"]
        chat = new_chat()
        grp = await self.lessons_group(t, past=True)
        student = await mk_student(t, f"Karimov Ali {uuid.uuid4().hex[:4]}")
        guardian = await mk_guardian(t, "Karimova Dilnoza")
        enrollment = await enroll(t, grp["id"], student["id"], "2026-01-01")
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
        out: dict[str, Any] = {
            "owner": {k: v for k, v in o.items() if k != "_t"},
            "chat": chat,
            "phone": guardian["phone"],
            "student": {"id": student["id"], "name": student["full_name"]},
            "guardian": {"id": guardian["id"], "name": guardian["full_name"]},
            "group": {"id": grp["id"], "name": grp["name"]},
            "enrollment_id": enrollment["id"],
        }
        if rich:
            out.update(await self._rich(t, grp, student, guardian))
        return out

    async def _rich(
        self, t: Tenant, grp: dict[str, Any], student: dict[str, Any], guardian: dict[str, Any]
    ) -> dict[str, Any]:
        sid = student["id"]
        await ok(
            await t.patch("/v1/settings", {"requisites": "Toshkent sh., Chilonzor 9\nTel: +998 90 123 45 67"})
        )
        past = await self.lesson_at(t, grp["id"], TODAY - timedelta(days=2))
        await ok(
            await t.put(
                f"/v1/lessons/{past['id']}/attendance",
                {"records": [{"student_id": sid, "status": "late", "minutes_late": 7}]},
            )
        )
        charge = await ok(
            await t.post(
                "/v1/charges",
                {
                    "student_id": sid,
                    "kind": "tuition",
                    "period_month": TODAY.isoformat(),
                    "amount": "600000",
                    "due_date": (TODAY - timedelta(days=10)).isoformat(),
                },
            ),
            201,
        )
        await ok(
            await t.put(
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
            await t.post("/v1/payments", {"student_id": sid, "amount": "100000", "method": "cash"}), 201
        )
        receipt = await ok(await t.post("/v1/documents/receipts", {"payment_id": pay["id"]}), 201)
        invoice = await ok(await t.post("/v1/documents/invoices", {"student_id": sid}), 201)
        await ok(
            await t.put(
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
        exam = await ok(
            await t.post(
                f"/v1/groups/{grp['id']}/exams",
                {
                    "title": "Oraliq test",
                    "held_on": (TODAY - timedelta(days=1)).isoformat(),
                    "max_score": "40",
                },
            ),
            201,
        )
        await ok(
            await t.put(f"/v1/exams/{exam['id']}/results", {"records": [{"student_id": sid, "score": "30"}]})
        )
        report = await ok(
            await t.post(
                "/v1/reports/progress",
                {"student_id": sid, "group_id": grp["id"], "month": TODAY.isoformat()[:7]},
            ),
            201,
        )
        await consent(t, sid, "notifications", guardian["id"])
        await ok(
            await t.post(f"/v1/reports/progress/{report['id']}/approve", {"guardian_id": guardian["id"]}), 201
        )
        return {
            "receipt": receipt["number"],
            "invoice": invoice["number"],
            "report_month": TODAY.isoformat()[:7],
        }

    async def certificate_family(self) -> dict[str, Any]:
        f = await self.family(rich=False)
        t: Tenant = await self._tenant_of(f)
        await ok(await t.patch(f"/v1/enrollments/{f['enrollment_id']}", {"status": "finished"}))
        cert = await ok(await t.post("/v1/certificates", {"enrollment_id": f["enrollment_id"]}), 201)
        f["certificate"] = cert["number"]
        return f

    async def _tenant_of(self, f: dict[str, Any]) -> Tenant:
        r = await self.client.post(
            "/v1/auth/login", json={"identifier": f["owner"]["email"], "password": f["owner"]["password"]}
        )
        return Tenant(self.client, await ok(r), f["owner"]["email"], f["owner"]["password"])

    async def makeup_family(self) -> dict[str, Any]:
        """A linked student with an excused absence tomorrow (a make-up right) and another group of the same course."""
        f = await self.family(rich=False)
        t = await self._tenant_of(f)
        grp_info = await ok(await t.get(f"/v1/groups/{f['group']['id']}"))
        other = await self.lessons_group(t, course_id=grp_info["course_id"], start="15:00:00")
        missed = await self.lesson_at(t, f["group"]["id"], TOMORROW)
        await ok(
            await t.put(
                f"/v1/lessons/{missed['id']}/attendance",
                {"records": [{"student_id": f["student"]["id"], "status": "excused"}]},
            )
        )
        f["other_group"] = other["name"]
        return f

    async def unlinked(self, method: str) -> dict[str, Any]:
        """A student whose guardian is NOT yet linked, with what the center must hand over for ``method``
        (code | phone | qr | manual). The test then plays the guardian in the fake bot and opens the cabinet."""
        f = await self.family(rich=False, link=False, accepted=False)
        t = await self._tenant_of(f)
        sid, gid = f["student"]["id"], f["guardian"]["id"]
        if method == "code":
            f["code"] = (
                await ok(await t.post("/v1/guardian/codes", {"student_id": sid, "relation": "father"}), 201)
            )["code"]
        elif method == "qr":
            f["qr"] = (await ok(await t.post(f"/v1/students/{sid}/qr", {})))["code"]
        elif method == "phone":
            await ok(
                await t.post(f"/v1/students/{sid}/guardians", {"guardian_id": gid, "relation": "mother"}), 201
            )
        elif method == "manual":
            await ok(
                await t.post(
                    "/v1/guardian/links",
                    {
                        "student_id": sid,
                        "guardian_id": gid,
                        "telegram_chat_id": f["chat"],
                        "relation": "mother",
                    },
                ),
                201,
            )
            await consent(t, sid, "data_processing", gid)
        return f

    async def teacher_center(self) -> dict[str, Any]:
        o = await self.owner()
        t: Tenant = o["_t"]
        prof = await mk_teacher(t, pay_rate="100000")
        inv = await ok(await t.post(f"/v1/teachers/{prof['id']}/invitations"), 201)
        email = f"teacher-{uuid.uuid4().hex[:8]}@example.com"
        await ok(
            await self.client.post(
                "/v1/auth/accept-teacher-invite",
                json={"code": inv["code"], "email": email, "password": TEACHER_PW},
            ),
            201,
        )
        chat = new_chat()
        self.sql("UPDATE users SET telegram_user_id = %s WHERE email = %s", (chat, email))
        grp = await mk_group(t, teacher_id=prof["id"], name=f"Ingliz {uuid.uuid4().hex[:4]}")
        students = []
        for i in range(3):
            s = await mk_student(t, f"O'quvchi {i} {uuid.uuid4().hex[:4]}")
            await enroll(t, grp["id"], s["id"], "2026-01-01")
            students.append({"id": s["id"], "name": s["full_name"]})
        g = await ok(
            await t.post("/v1/guardians", {"full_name": "Mama", "telegram_chat_id": new_chat()}), 201
        )
        await ok(
            await t.post(
                f"/v1/students/{students[0]['id']}/guardians", {"guardian_id": g["id"], "relation": "mother"}
            ),
            201,
        )
        await consent(t, students[0]["id"], "notifications", g["id"])
        lesson = await ok(
            await t.post(
                "/v1/lessons",
                {
                    "group_id": grp["id"],
                    "lesson_date": TODAY.isoformat(),
                    "start_time": "10:00:00",
                    "end_time": "11:30:00",
                },
            ),
            201,
        )
        # a QR card for every student: the scan page needs a real code
        for s in students:
            s["qr"] = (await ok(await t.post(f"/v1/students/{s['id']}/qr", {})))["code"]
        return {
            "owner": {k: v for k, v in o.items() if k != "_t"},
            "teacher": {"email": email, "password": TEACHER_PW, "chat": chat, "name": prof["full_name"]},
            "group": {"id": grp["id"], "name": grp["name"]},
            "lesson": {"id": lesson["id"]},
            "students": students,
        }

    async def panel_center(self) -> dict[str, Any]:
        """The staff panel's world: one account for every role, a second branch with its own manager and student, a
        group with a lesson today, a student with an overdue charge and a reachable guardian, and a second center."""
        out = await self.teacher_center()
        t = await self._tenant_of(out)
        main = next(b for b in (await ok(await t.get("/v1/branches")))["items"] if b["is_default"])
        second = await ok(await t.post("/v1/branches", {"name": "Chilonzor filiali"}), 201)
        accounts = {"owner": out["owner"], "teacher": {**out["teacher"], "password": TEACHER_PW}}
        for key, role, branch in (
            ("admin", "admin", None),
            ("manager", "manager", None),
            ("accountant", "accountant", None),
            ("viewer", "viewer", None),
            ("branch_manager", "manager", second["id"]),
        ):
            email = f"{key.replace('_', '-')}-{uuid.uuid4().hex[:8]}@example.com"
            body = {"full_name": f"Xodim {key}", "email": email, "role": role, "initial_password": TEACHER_PW}
            if branch:
                body["branch_id"] = branch
            await ok(await t.post("/v1/staff", body), 201)
            accounts[key] = {"email": email, "password": TEACHER_PW}
        far = await mk_student(t, f"Filial o'quvchisi {uuid.uuid4().hex[:4]}", branch_id=second["id"])
        debtor = out["students"][0]
        await ok(
            await t.post(
                "/v1/charges",
                {
                    "student_id": debtor["id"],
                    "kind": "tuition",
                    "period_month": TODAY.replace(day=1).isoformat(),
                    "amount": "600000",
                    "due_date": (TODAY - timedelta(days=10)).isoformat(),
                },
            ),
            201,
        )
        other = await make_tenant(self.client, "other")
        theirs = await mk_student(other, f"Begona o'quvchi {uuid.uuid4().hex[:4]}")
        out.update(
            accounts=accounts,
            branches={"main": main["id"], "second": second["id"], "second_name": second["name"]},
            far_student={"id": far["id"], "name": far["full_name"]},
            other={
                "email": other.email,
                "password": other.password,
                "student": {"id": theirs["id"], "name": theirs["full_name"]},
            },
        )
        return out

    async def calendar_center(self) -> dict[str, Any]:
        """Owner with a group, today's lessons, and one cancelled lesson whose guardian draft waits for approval."""
        f = await self.family(rich=False)
        t = await self._tenant_of(f)
        grp = f["group"]
        await consent(t, f["student"]["id"], "notifications", f["guardian"]["id"])
        les = await ok(
            await t.post(
                "/v1/lessons",
                {
                    "group_id": grp["id"],
                    "lesson_date": TODAY.isoformat(),
                    "start_time": "14:00:00",
                    "end_time": "15:00:00",
                },
            ),
            201,
        )
        cancel_me = await ok(
            await t.post(
                "/v1/lessons",
                {
                    "group_id": grp["id"],
                    "lesson_date": TOMORROW.isoformat(),
                    "start_time": "16:00:00",
                    "end_time": "17:00:00",
                },
            ),
            201,
        )
        await ok(await t.post(f"/v1/lessons/{cancel_me['id']}/cancel", {"reason": "qor"}))
        f["lesson"] = {"id": les["id"]}
        return f

    async def hook(self, update: dict[str, Any]) -> int:
        r = await self.client.post(
            self.hook_path,
            json={"update_id": next_update_id(), **update},
            headers={"X-Telegram-Bot-Api-Secret-Token": HOOK_SECRET},
        )
        return r.status_code


def make_control(factory: Factory, bot: FakeBot, api_url: str) -> Starlette:
    async def state(_: Request) -> JSONResponse:
        return JSONResponse({"api": api_url, "today": TODAY.isoformat(), "bot_token_hint": "TEST"})

    async def make(request: Request) -> JSONResponse:
        kind = request.path_params["kind"]
        arg = request.query_params.get("arg", "")
        builders = {
            "family": factory.family,
            "family-bare": lambda: factory.family(rich=False),
            "family-unconsented": lambda: factory.family(rich=False, accepted=False),
            "certificate": factory.certificate_family,
            "makeup": factory.makeup_family,
            "unlinked": lambda: factory.unlinked(arg),
            "teacher": factory.teacher_center,
            "calendar": factory.calendar_center,
            "panel": factory.panel_center,
            "owner": factory.owner,
        }
        if kind not in builders:
            return JSONResponse({"error": "unknown fixture"}, status_code=404)
        try:
            data = await builders[kind]()
        except Exception:  # the test must see why a fixture failed
            return JSONResponse({"error": traceback.format_exc()}, status_code=500)
        data.pop("_t", None)
        return JSONResponse(data)

    async def qr_matrix_of(request: Request) -> JSONResponse:
        from nazoratly.rules.qr import qr_matrix

        return JSONResponse({"matrix": qr_matrix(request.query_params["code"])})

    async def initdata(request: Request) -> JSONResponse:
        q = request.query_params
        return JSONResponse(
            {
                "init_data": init_data(
                    int(q["user"]), age_s=int(q.get("age", "0")), tamper=q.get("tamper") == "1"
                )
            }
        )

    async def reset_link(request: Request) -> JSONResponse:
        """What the operator's command does (python -m nazoratly.password_reset)."""
        body = await request.json()
        assert factory.app is not None
        link = await issue_link(
            factory.app.state.db, factory.app.state.settings, identifier=body["email"], operator="e2e"
        )
        if body.get("expired"):
            factory.sql(
                "UPDATE password_reset_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL AND revoked_at IS NULL"
            )
        return JSONResponse({"link": link})

    async def messages(request: Request) -> JSONResponse:
        return JSONResponse({"texts": bot.texts(int(request.query_params["chat"]))})

    async def hook(request: Request) -> JSONResponse:
        return JSONResponse({"status": await factory.hook(await request.json())})

    return Starlette(
        routes=[
            Route("/state", state),
            Route("/make/{kind}", make, methods=["POST"]),
            Route("/initdata", initdata),
            Route("/qr-matrix", qr_matrix_of),
            Route("/messages", messages),
            Route("/reset-link", reset_link, methods=["POST"]),
            Route("/bot", hook, methods=["POST"]),
        ]
    )


async def main() -> None:
    from nazoratly.config import Settings
    from nazoratly.main import create_app

    pg = await asyncio.to_thread(start_postgres)
    try:
        settings = Settings(
            env="test",
            log_json=False,
            log_level="WARNING",
            database_url_app=role_dsn(pg, "nazoratly_app"),  # type: ignore[arg-type]
            database_url_auth=role_dsn(pg, "nazoratly_auth"),  # type: ignore[arg-type]
            jwt_secret="test-secret-test-secret-test-secret-0123",  # type: ignore[arg-type]
            rate_limit_per_minute=100_000,
            auth_rate_limit_per_minute=100_000,
            secrets_key=Fernet.generate_key().decode(),  # type: ignore[arg-type]
            login_max_failures=50,
            db_pool_max=20,
            telegram_bot_token=SecretStr(BOT_TOKEN),
            # the panel's tests serve /app and /v1 on one origin of their own (panel/e2e/global-setup.ts)
            public_base_url=os.environ.get("NZ_PANEL_ORIGIN", "http://127.0.0.1"),
        )
        app = create_app(settings)
        bot = FakeBot()
        api_port, ctl_port = free_port(), free_port()
        api_url, ctl_url = f"http://127.0.0.1:{api_port}", f"http://127.0.0.1:{ctl_port}"
        async with app.router.lifespan_context(app):
            app.state.outbound_transport = httpx.MockTransport(bot)
            seed_client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://seed")
            factory = Factory(seed_client, pg, bot)
            factory.app = app
            factory.hook_path = register_shared(pg["super"], app.state.secrets_box, BOT_TOKEN, HOOK_SECRET)
            servers = [
                uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=api_port, log_level="warning")),
                uvicorn.Server(
                    uvicorn.Config(
                        make_control(factory, bot, api_url),
                        host="127.0.0.1",
                        port=ctl_port,
                        log_level="warning",
                    )
                ),
            ]
            tasks = [asyncio.create_task(s.serve()) for s in servers]
            while not all(s.started for s in servers):  # noqa: ASYNC110  (uvicorn exposes a flag, not an event)
                await asyncio.sleep(0.05)
            print("READY " + json.dumps({"api": api_url, "control": ctl_url, "pg": pg["name"]}), flush=True)
            # live until the parent closes our stdin or kills us
            await asyncio.get_running_loop().run_in_executor(None, sys.stdin.read)
            for s in servers:
                s.should_exit = True
            await asyncio.gather(*tasks)
            await seed_client.aclose()
    finally:
        subprocess.run(["docker", "rm", "-fv", pg["name"]], capture_output=True, check=False)  # noqa: S603, S607, ASYNC221


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.run(main(), loop_factory=lambda: asyncio.SelectorEventLoop(selectors.SelectSelector()))
    else:
        asyncio.run(main())
