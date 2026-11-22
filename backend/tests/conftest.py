"""Test harness: a disposable PostgreSQL 16 container (tmpfs) with all migrations applied and the three
application roles given LOGIN, then the real FastAPI app on top of it (no mocks of the database)."""

from __future__ import annotations

import os
import subprocess
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest
import pytest_asyncio
from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "db" / "migrations"
PG_IMAGE = os.environ.get("PG_IMAGE", "postgres:16-alpine")
ROLE_PW = "test-role-pw"
SUPER_PW = "test-super-pw"


def pytest_asyncio_loop_factories(config: Any, item: Any) -> dict[str, Any]:
    """psycopg's async mode cannot run on Windows' default ProactorEventLoop."""
    import asyncio
    import selectors
    import sys

    if sys.platform == "win32":
        return {"selector": lambda: asyncio.SelectorEventLoop(selectors.SelectSelector())}
    return {"default": asyncio.new_event_loop}


def _docker(*args: str) -> str:
    return subprocess.run(["docker", *args], check=True, capture_output=True, text=True).stdout.strip()  # noqa: S603, S607


@pytest.fixture(scope="session")
def pg_server() -> Iterator[dict[str, Any]]:
    name = f"nazoratly-api-test-{uuid.uuid4().hex[:8]}"
    _docker(
        "run", "-d", "--rm", "--name", name, "-e", f"POSTGRES_PASSWORD={SUPER_PW}",
        "-p", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data", PG_IMAGE,
        "-c", "max_connections=200", "-c", "fsync=off",
    )  # fmt: skip
    try:
        port = int(_docker("port", name, "5432/tcp").splitlines()[0].rsplit(":", 1)[1])
        dsn = f"postgresql://postgres:{SUPER_PW}@127.0.0.1:{port}/postgres"
        deadline = time.time() + 60
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
                c.execute(f.read_text(encoding="utf-8"))  # type: ignore[arg-type]  # multi-statement, no params
            for role in ("nazoratly_app", "nazoratly_auth", "nazoratly_agent", "nazoratly_worker"):
                c.execute(f"ALTER ROLE {role} LOGIN PASSWORD '{ROLE_PW}'")  # type: ignore[arg-type]
        yield {
            "name": name,
            "port": port,
            "super": dsn,
            "app": f"postgresql://nazoratly_app:{ROLE_PW}@127.0.0.1:{port}/postgres",
            "auth": f"postgresql://nazoratly_auth:{ROLE_PW}@127.0.0.1:{port}/postgres",
            "agent": f"postgresql://nazoratly_agent:{ROLE_PW}@127.0.0.1:{port}/postgres",
            "worker": f"postgresql://nazoratly_worker:{ROLE_PW}@127.0.0.1:{port}/postgres",
        }
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)  # noqa: S603, S607


@pytest.fixture(scope="session")
def settings(pg_server: dict[str, Any]) -> Any:
    from nazoratly.config import Settings

    return Settings(
        env="test",
        log_json=False,
        log_level="WARNING",
        database_url_app=pg_server["app"],  # type: ignore[arg-type]
        database_url_auth=pg_server["auth"],  # type: ignore[arg-type]
        jwt_secret="test-secret-test-secret-test-secret-0123",  # type: ignore[arg-type]
        rate_limit_per_minute=100_000,
        auth_rate_limit_per_minute=100_000,
        secrets_key=Fernet.generate_key().decode(),  # type: ignore[arg-type]
        login_max_failures=5,
        db_pool_max=20,
    )


@pytest_asyncio.fixture(scope="session")
async def app(settings: Any) -> AsyncIterator[Any]:
    from nazoratly.main import create_app

    application = create_app(settings)
    async with application.router.lifespan_context(application):
        yield application


@pytest_asyncio.fixture(scope="session")
async def client(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class Tenant:
    """A registered center with its owner and authenticated headers."""

    def __init__(self, client: httpx.AsyncClient, data: dict[str, Any], email: str, password: str) -> None:
        self.client = client
        self.email = email
        self.password = password
        self.access: str = data["access_token"]
        self.refresh: str = data["refresh_token"]
        self.org_id: str = data["org"]["id"]

    @property
    def h(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access}"}

    def _hdr(self, kw: dict[str, Any]) -> dict[str, str]:
        return {**self.h, **kw.pop("headers", {})}

    async def get(self, url: str, **kw: Any) -> httpx.Response:
        return await self.client.get(url, headers=self._hdr(kw), **kw)

    async def post(self, url: str, json: Any = None, **kw: Any) -> httpx.Response:
        return await self.client.post(url, json=json, headers=self._hdr(kw), **kw)

    async def patch(self, url: str, json: Any = None, **kw: Any) -> httpx.Response:
        return await self.client.patch(url, json=json, headers=self._hdr(kw), **kw)

    async def put(self, url: str, json: Any = None, **kw: Any) -> httpx.Response:
        return await self.client.put(url, json=json, headers=self._hdr(kw), **kw)

    async def delete(self, url: str, **kw: Any) -> httpx.Response:
        return await self.client.delete(url, headers=self._hdr(kw), **kw)


async def make_tenant(client: httpx.AsyncClient, label: str = "t") -> Tenant:
    email = f"{label}-{uuid.uuid4().hex[:10]}@example.com"
    password = "correct-horse-battery"
    r = await client.post(
        "/v1/auth/register",
        json={
            "full_name": f"Owner {label}",
            "center_name": f"Center {label} {uuid.uuid4().hex[:6]}",
            "email": email,
            "password": password,
        },
    )
    assert r.status_code == 201, r.text
    return Tenant(client, r.json(), email, password)


@pytest_asyncio.fixture
async def tenant(client: httpx.AsyncClient) -> Tenant:
    return await make_tenant(client)


@pytest_asyncio.fixture
async def tenant_b(client: httpx.AsyncClient) -> Tenant:
    return await make_tenant(client, "b")


@pytest.fixture(scope="session")
def super_dsn(pg_server: dict[str, Any]) -> str:
    return str(pg_server["super"])
