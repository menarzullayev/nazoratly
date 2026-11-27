"""The multi-tenant relay of the Sheets edition: one record and secret per connection, Apps Script web apps only, and
nothing of an update stored or logged. The targets are a fake transport."""

from __future__ import annotations

import io
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import pytest_asyncio
from psycopg import errors as pgerr
from pydantic import SecretStr

from nazoratly import relays
from nazoratly.main import create_app
from tests.test_teacher_app import sql

SECRET_A = "a" * 64
SECRET_B = "b" * 64
TARGET_A = "https://script.google.com/macros/s/AKfycb_A-1/exec"
TARGET_B = "https://script.google.com/a/macros/ziyo.uz/s/AKfycb_B-2/exec"
BAD_TARGETS = (
    "http://script.google.com/macros/s/ID/exec",
    "https://script.google.com.evil.example/macros/s/ID/exec",
    "https://evil.example/macros/s/ID/exec",
    "https://user@script.google.com/macros/s/ID/exec",
    "https://script.google.com@evil.example/macros/s/ID/exec",
    "https://script.google.com:8443/macros/s/ID/exec",
    "https://script.google.com/macros/s/ID/dev",
    "https://script.google.com/macros/s/ID/exec?next=https://evil.example",
    "https://script.google.com/macros/s/ID/exec#x",
    "https://script.google.com/macros/s/../exec",
    "https://script.google.com/macros/s/ID/exec\n",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/macros/s/ID/exec",
)


class Relays:
    def __init__(self, app: Any, http: httpx.AsyncClient, seen: list[httpx.Request], dsn: str) -> None:
        self.app, self.http, self.seen, self.dsn = app, http, seen, dsn

    async def add(self, label: str, target: str, secret: str) -> str:
        url = await relays.add(
            self.app.state.db,
            self.app.state.settings,
            self.app.state.secrets_box,
            label=label,
            target=target,
            secret=secret,
        )
        assert url.startswith("https://nazoratly.test/hooks/relay/")
        return url.removeprefix("https://nazoratly.test")

    async def post(self, path: str, secret: str, content: str = '{"update_id":1}') -> httpx.Response:
        headers = {"X-Telegram-Bot-Api-Secret-Token": secret, "content-type": "application/json"}
        return await self.http.post(path, content=content, headers=headers)


@pytest_asyncio.fixture
async def relay(settings: Any, super_dsn: str) -> AsyncIterator[Relays]:
    app = create_app(settings.model_copy(update={"public_base_url": "https://nazoratly.test"}))
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(302, headers={"Location": "https://script.googleusercontent.com/echo"})

    async with app.router.lifespan_context(app):
        app.state.outbound_transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://relay") as http:
            try:
                yield Relays(app, http, seen, super_dsn)
            finally:
                sql(super_dsn, "DELETE FROM sheet_relays")


async def test_each_connection_has_its_own_address_secret_and_target(relay: Relays) -> None:
    a = await relay.add("A", TARGET_A, SECRET_A)
    b = await relay.add("B", TARGET_B, SECRET_B)
    update = '{"update_id":5,"message":{"text":"/qarz"}}'
    assert (await relay.post(a, SECRET_A, update)).json() == {"ok": True}
    assert (await relay.post(b, SECRET_B, update)).status_code == 200
    first, second = relay.seen
    assert str(first.url) == f"{TARGET_A}?s={SECRET_A}" and str(second.url) == f"{TARGET_B}?s={SECRET_B}"
    assert first.content == update.encode()
    # another connection's secret, a wrong one, none: nothing is forwarded
    for path, secret in ((a, SECRET_B), (b, SECRET_A), (a, "nope"), (a, "")):
        assert (await relay.post(path, secret)).status_code == 403
    for path in (f"/hooks/relay/{uuid.uuid4()}", "/hooks/relay/not-a-uuid"):
        assert (await relay.post(path, SECRET_A)).status_code == 404
    assert len(relay.seen) == 2
    assert await relays.disable(relay.app.state.db, uuid.UUID(a.rsplit("/", 1)[1])) is True
    assert (await relay.post(a, SECRET_A)).status_code == 404
    assert (await relay.post(b, SECRET_B)).status_code == 200
    listed = "\n".join(await relays.listing(relay.app.state.db))
    assert "disabled" in listed and SECRET_A not in listed and SECRET_B not in listed


async def test_only_apps_script_web_apps_can_be_registered_or_called(relay: Relays) -> None:
    for bad in BAD_TARGETS:
        assert not relays.allowed_target(bad), bad
        with pytest.raises(relays.RelayError):
            await relay.add("x", bad, SECRET_A)
    assert sql(relay.dsn, "SELECT count(*) FROM sheet_relays") == [(0,)]
    # the database refuses it too
    with pytest.raises(pgerr.CheckViolation):
        sql(
            relay.dsn,
            "INSERT INTO sheet_relays (label, target_url, secret_ciphertext) VALUES ('x', 'https://evil.example/', 'x')",
        )
    # the single connection from the environment obeys the same rule
    app = create_app(
        relay.app.state.settings.model_copy(
            update={"tg_relay_target": "https://evil.example/hook", "tg_relay_secret": SecretStr(SECRET_A)}
        )
    )
    async with app.router.lifespan_context(app):
        app.state.outbound_transport = relay.app.state.outbound_transport
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://env") as c:
            r = await c.post(
                "/hooks/telegram", content="{}", headers={"X-Telegram-Bot-Api-Secret-Token": SECRET_A}
            )
            assert r.status_code == 502 and "evil.example" not in r.text
    assert relay.seen == []


async def test_bad_secrets_and_an_unready_server_are_refused(relay: Relays) -> None:
    for bad in ("short", "has space " * 3, "x" * 300, "q?s=1&" * 4):
        with pytest.raises(relays.RelayError):
            await relay.add("x", TARGET_A, bad)
    with pytest.raises(relays.RelayError):
        await relays.add(
            relay.app.state.db, relay.app.state.settings, None, label="x", target=TARGET_A, secret=SECRET_A
        )


async def test_the_content_and_the_secrets_are_neither_stored_nor_logged(
    relay: Relays, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    from nazoratly.observability import configure_logging

    path = await relay.add("A", TARGET_A, SECRET_A)
    marker = "PRIVATE-MESSAGE-TEXT-91827"
    update = f'{{"update_id":9,"message":{{"text":"{marker}"}}}}'
    log = io.StringIO()
    handler = logging.StreamHandler(log)
    configure_logging(relay.app.state.settings.model_copy(update={"log_level": "DEBUG"}))
    logging.getLogger().addHandler(handler)
    try:
        with caplog.at_level(logging.DEBUG):
            assert (await relay.post(path, SECRET_A, update)).status_code == 200

            def down(req: httpx.Request) -> httpx.Response:
                raise httpx.ConnectError(f"no route to {req.url}")

            for transport in (down, lambda req: httpx.Response(500, text=marker)):
                relay.app.state.outbound_transport = httpx.MockTransport(transport)
                r = await relay.post(path, SECRET_A, update)
                assert r.status_code == 502 and marker not in r.text and SECRET_A not in r.text
        out = capsys.readouterr()
        everything = caplog.text + out.out + out.err + log.getvalue()
        assert "relay_failed" in everything and "relay_target_error" in everything
        for hidden in (marker, SECRET_A, "AKfycb_A-1"):
            assert hidden not in everything
    finally:
        logging.getLogger().removeHandler(handler)
        configure_logging(relay.app.state.settings.model_copy(update={"log_level": "WARNING"}))
    ((row,),) = sql(relay.dsn, "SELECT to_jsonb(s)::text FROM sheet_relays s")
    assert marker not in row and SECRET_A not in row
