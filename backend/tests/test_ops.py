from __future__ import annotations

from typing import Any

import httpx
import psycopg
import pytest

from nazoratly import migrate
from tests.conftest import ROLE_PW


def test_migration_runner_up_down_status_roles(
    pg_server: dict[str, Any], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    with psycopg.connect(pg_server["super"], autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS migtest")
        c.execute("CREATE DATABASE migtest")
    url = pg_server["super"].rsplit("/", 1)[0] + "/migtest"
    monkeypatch.setenv("NAZORATLY_MIGRATE_URL", url)
    monkeypatch.setenv("NAZORATLY_APP_PASSWORD", "pw-with-'quote")

    versions = sorted(migrate.discover(migrate._dir()))
    assert versions[0].startswith("0001") and len(versions) >= 7
    assert migrate.up() == versions
    assert migrate.up() == []  # idempotent
    assert migrate.down(1) == [versions[-1]]  # agent_authenticate removed
    assert migrate.down(1) == [
        versions[-2]
    ]  # backend support removed (0005 is not rolled back: roles are cluster-wide)
    assert migrate.up() == versions[-2:]
    assert migrate.main(["status"]) == 0
    assert "applied" in capsys.readouterr().out
    try:
        assert migrate.set_role_passwords() == [
            "nazoratly_app"
        ]  # a quote inside the password is handled safely
        host_port = pg_server["super"].split("@", 1)[1]
        with psycopg.connect(
            f"postgresql://nazoratly_app:pw-with-%27quote@{host_port.rsplit('/', 1)[0]}/migtest"
        ) as c:
            assert c.execute("SELECT current_user").fetchone() == ("nazoratly_app",)
    finally:  # roles are cluster-wide: restore the password the rest of the suite uses
        with psycopg.connect(pg_server["super"], autocommit=True) as c:
            c.execute(f"ALTER ROLE nazoratly_app PASSWORD '{ROLE_PW}'")  # type: ignore[arg-type]
    with psycopg.connect(url) as c:
        n = c.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"
        ).fetchone()
        assert n is not None and n[0] >= 30


def test_runner_rejects_unpaired_migration(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "0001_x.up.sql").write_text("SELECT 1;")
    monkeypatch.setenv("NAZORATLY_MIGRATIONS_DIR", str(tmp_path))
    with pytest.raises(SystemExit):
        migrate.discover(migrate._dir())


async def test_ready_reports_database_outage(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def down() -> bool:
        return False

    monkeypatch.setattr(app.state.db, "ping", down)
    r = await client.get("/ready")
    assert r.status_code == 503 and r.json()["status"] == "database_unavailable"
    assert (await client.get("/health")).status_code == 200  # liveness is independent of the database


async def test_unknown_route_and_method_use_error_model(client: httpx.AsyncClient) -> None:
    r = await client.get("/v1/does-not-exist")
    assert (
        r.status_code == 404 and r.json()["error"]["code"] == "not_found" and r.json()["error"]["request_id"]
    )
    r = await client.put("/health")
    assert r.status_code == 405 and r.json()["error"]["code"] == "method_not_allowed"


async def test_rate_limit_and_security_headers(settings: Any, pg_server: dict[str, Any]) -> None:
    from nazoratly.main import create_app

    limited = settings.model_copy(update={"auth_rate_limit_per_minute": 3, "rate_limit_per_minute": 1000})
    app = create_app(limited)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            codes = [
                (
                    await c.post("/v1/auth/login", json={"identifier": "x@example.com", "password": "pw"})
                ).status_code
                for _ in range(5)
            ]
            assert codes == [401, 401, 401, 429, 429]
            r = await c.post("/v1/auth/login", json={"identifier": "x@example.com", "password": "pw"})
            assert r.headers["retry-after"] and r.headers["cache-control"] == "no-store"
            assert (await c.get("/health")).status_code == 200  # probes are never limited


async def test_cors_only_for_configured_origins(settings: Any) -> None:
    from nazoratly.main import create_app

    app = create_app(settings.model_copy(update={"cors_origins": ["https://app.example.uz"]}))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            ok_pre = await c.options(
                "/v1/me", headers={"Origin": "https://app.example.uz", "Access-Control-Request-Method": "GET"}
            )
            assert ok_pre.headers.get("access-control-allow-origin") == "https://app.example.uz"
            bad = await c.options(
                "/v1/me", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"}
            )
            assert "access-control-allow-origin" not in bad.headers


def test_settings_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    from nazoratly.config import Settings

    base: dict[str, Any] = {"database_url_app": "postgresql://a", "database_url_auth": "postgresql://b"}
    with pytest.raises(ValueError, match="at least 32"):
        Settings(jwt_secret="short", **base)
    with pytest.raises(ValueError, match="wildcard CORS"):
        Settings(jwt_secret="x" * 40, env="prod", cors_origins=["*"], **base)
    with pytest.raises(ValueError, match="db_pool_max"):
        Settings(jwt_secret="x" * 40, db_pool_min=5, db_pool_max=2, **base)


async def test_concurrent_enrollment_respects_capacity(tenant: Any) -> None:
    import asyncio

    from tests.helpers import mk_group, mk_student, ok

    grp = await mk_group(tenant, capacity=1)
    students = [await mk_student(tenant) for _ in range(6)]
    results = await asyncio.gather(
        *[
            tenant.post(
                f"/v1/groups/{grp['id']}/enrollments", {"student_id": s["id"], "started_on": "2026-01-01"}
            )
            for s in students
        ]
    )
    assert sorted(r.status_code for r in results) == [201, 409, 409, 409, 409, 409]
    members = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/enrollments")))["items"]
    assert len(members) == 1


async def test_concurrent_requests_with_same_idempotency_key(tenant: Any) -> None:
    import asyncio
    import uuid

    from tests.helpers import ok

    key = uuid.uuid4().hex
    results = await asyncio.gather(
        *[
            tenant.post("/v1/students", {"full_name": "Raced"}, headers={"Idempotency-Key": key})
            for _ in range(5)
        ]
    )
    codes = sorted(r.status_code for r in results)
    assert codes.count(201) >= 1 and set(codes) <= {
        201,
        409,
    }  # in-flight duplicates are refused, never re-executed
    created = [s for s in (await ok(await tenant.get("/v1/students")))["items"] if s["full_name"] == "Raced"]
    assert len(created) == 1


async def test_get_by_id_endpoints_and_room_patch(tenant: Any) -> None:
    from tests.helpers import mk_course, mk_group, mk_teacher, ok

    course, teacher = await mk_course(tenant), await mk_teacher(tenant)
    await mk_group(tenant, course_id=course["id"], teacher_id=teacher["id"])
    assert (await ok(await tenant.get(f"/v1/courses/{course['id']}")))["name"] == course["name"]
    assert (await ok(await tenant.get(f"/v1/teachers/{teacher['id']}")))["full_name"] == teacher["full_name"]
    branch = await ok(await tenant.post("/v1/branches", {"name": "B1"}), 201)
    assert (await ok(await tenant.get(f"/v1/branches/{branch['id']}")))["name"] == "B1"
    room = await ok(
        await tenant.post("/v1/rooms", {"branch_id": branch["id"], "name": "R1", "capacity": 10}), 201
    )
    upd = await ok(await tenant.patch(f"/v1/rooms/{room['id']}", {"capacity": 12}))
    assert upd["capacity"] == 12


def test_blank_optional_settings_mean_unset() -> None:
    from nazoratly.config import Settings

    s = Settings(
        database_url_app="postgresql://a",
        database_url_auth="postgresql://b",
        jwt_secret="x" * 40,
        secrets_key="",
        sentry_dsn="",
        otel_exporter_otlp_endpoint="",
    )  # type: ignore[arg-type]
    assert s.secrets_key is None and s.sentry_dsn is None and s.otel_exporter_otlp_endpoint is None


async def test_worker_without_bot_token_has_no_telegram_sender(pg_server: dict[str, Any]) -> None:
    from nazoratly.worker import Worker, WorkerSettings

    w = Worker(WorkerSettings(database_url_worker=pg_server["worker"], telegram_bot_token=""))  # type: ignore[arg-type]
    assert set(w.senders) == {"sms"}
    await w.close()
