from __future__ import annotations

from typing import Any

import httpx
from pydantic import SecretStr

from nazoratly.main import create_app

SECRET = "relay-secret-0123456789abcdef"
TARGET = "https://script.google.com/macros/s/ID/exec"


async def _app(settings: Any, **update: Any) -> Any:
    return create_app(settings.model_copy(update=update))


async def test_relay_forwards_authenticated_updates(settings: Any) -> None:
    app = await _app(settings, tg_relay_target=TARGET, tg_relay_secret=SecretStr(SECRET))
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(302, headers={"Location": "https://script.googleusercontent.com/echo"})

    async with app.router.lifespan_context(app):
        app.state.outbound_transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            update = '{"update_id":1,"message":{"text":"/qarz"}}'
            hdr = {"X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json"}
            r = await c.post("/hooks/telegram", content=update, headers=hdr)
            assert r.status_code == 200 and r.json() == {"ok": True}
            assert len(seen) == 1 and seen[0].url.params["s"] == SECRET
            assert seen[0].content == update.encode() and str(seen[0].url).startswith(TARGET)
            # a wrong or missing secret never reaches the target
            assert (
                await c.post(
                    "/hooks/telegram", content=update, headers={"X-Telegram-Bot-Api-Secret-Token": "nope"}
                )
            ).status_code == 403
            assert (await c.post("/hooks/telegram", content=update)).status_code == 403
            assert len(seen) == 1


async def test_relay_reports_target_failures_and_missing_config(settings: Any) -> None:
    app = await _app(settings, tg_relay_target=TARGET, tg_relay_secret=SecretStr(SECRET))
    async with app.router.lifespan_context(app):
        app.state.outbound_transport = httpx.MockTransport(lambda req: httpx.Response(500))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post(
                "/hooks/telegram", content="{}", headers={"X-Telegram-Bot-Api-Secret-Token": SECRET}
            )
            assert r.status_code == 502  # Telegram will retry

        def boom(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down")

        app.state.outbound_transport = httpx.MockTransport(boom)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            assert (
                await c.post(
                    "/hooks/telegram", content="{}", headers={"X-Telegram-Bot-Api-Secret-Token": SECRET}
                )
            ).status_code == 502

    off = await _app(settings)
    async with off.router.lifespan_context(off):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=off), base_url="http://t") as c:
            assert (
                await c.post(
                    "/hooks/telegram", content="{}", headers={"X-Telegram-Bot-Api-Secret-Token": SECRET}
                )
            ).status_code == 404
