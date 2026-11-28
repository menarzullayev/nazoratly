"""Outbox sender: python -m nazoratly.worker.

Claims due messages through outbox_claim() (role nazoratly_worker: no table access), delivers them and reports the
outcome through outbox_complete(). Telegram is implemented against the Bot API. SMS has no provider configured: such
messages are failed permanently with a clear reason instead of being silently dropped or faked.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Protocol

import httpx
import structlog
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from nazoratly.observability import quiet_http_client_logs
from nazoratly.rules import reminders as R
from nazoratly.secrets_box import SecretsBox
from nazoratly.telegram_delivery import (
    MARK_UNREACHABLE_SQL,
    ROUTES_SQL,
    UNDELIVERABLE,
    paid_callback,
    refused_for_good,
    resolve_routes,
)

log = structlog.get_logger("worker")


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NAZORATLY_", env_file=".env", extra="ignore")

    database_url_worker: SecretStr
    telegram_bot_token: SecretStr | None = None  # the shared bot; empty = only centers' own bots (if any)
    secrets_key: SecretStr | None = None  # decrypts the bot tokens in the registry (centers' own bots)
    telegram_api_base: str = "https://api.telegram.org"
    eskiz_email: str | None = None  # SMS via Eskiz.uz; empty = SMS not configured
    eskiz_password: SecretStr | None = None
    eskiz_from: str = "4546"  # sender id/nickname registered with Eskiz
    eskiz_api_base: str = "https://notify.eskiz.uz"
    worker_poll_interval_s: float = Field(default=2.0, gt=0)
    worker_batch: int = Field(default=20, ge=1, le=100)
    worker_http_timeout_s: float = Field(default=10.0, gt=0)


@dataclass(frozen=True)
class Message:
    message_id: int
    channel: str
    body: str
    telegram_chat_id: int | None
    phone: str | None
    body_html: str | None = None  # rich text of a document message
    has_document: bool = False
    text_delivered: bool = False  # the rich text already reached the chat (a retry must not repeat it)


@dataclass(frozen=True)
class Outcome:
    ok: bool
    error: str | None = None
    retry_after_s: int | None = None
    permanent: bool = False
    status_code: int | None = None
    refused: bool = False  # this bot cannot message this chat: another route may


class Sender(Protocol):
    async def send(self, msg: Message) -> Outcome: ...


class TelegramSender:
    def __init__(self, token: str, base_url: str, client: httpx.AsyncClient) -> None:
        self._base = f"{base_url.rstrip('/')}/bot{token}"
        self._client = client

    async def _call(
        self,
        method: str,
        *,
        json: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> Outcome:
        try:
            r = await self._client.post(f"{self._base}/{method}", json=json, data=data, files=files)
        except httpx.HTTPError as exc:  # never include str(exc): it contains the URL with the bot token
            return Outcome(False, f"network error: {type(exc).__name__}")
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code == 200 and body.get("ok") is True:
            return Outcome(True, status_code=200)
        desc = str(body.get("description", ""))[:200]
        if r.status_code == 429:
            retry = int(body.get("parameters", {}).get("retry_after", 30))
            return Outcome(False, f"telegram rate limit: {desc}", retry_after_s=retry + 1, status_code=429)
        if r.status_code in (
            400,
            401,
            403,
            404,
        ):  # blocked bot, chat not found, bad token: retrying cannot help
            return Outcome(
                False,
                f"telegram {r.status_code}: {desc}",
                permanent=True,
                status_code=r.status_code,
                refused=refused_for_good(r.status_code, desc),
            )
        return Outcome(False, f"telegram {r.status_code}: {desc}", status_code=r.status_code)

    async def send(self, msg: Message) -> Outcome:
        if msg.telegram_chat_id is None:
            return Outcome(False, "guardian has no Telegram chat", permanent=True)
        return await self._call(
            "sendMessage",
            json={
                "chat_id": msg.telegram_chat_id,
                "text": msg.body,
                "link_preview_options": {"is_disabled": True},
            },
        )

    async def send_rich(self, msg: Message) -> Outcome:
        """Rich message (Bot API 10.1+); when Telegram rejects it (400/404) the plain text is sent instead."""
        if msg.telegram_chat_id is None:
            return Outcome(False, "guardian has no Telegram chat", permanent=True)
        if msg.body_html:
            out = await self._call(
                "sendRichMessage",
                json={"chat_id": msg.telegram_chat_id, "rich_message": {"html": msg.body_html}},
            )
            if out.ok or out.status_code not in (400, 404):
                return out
        return await self.send(msg)

    async def send_reminder(self, msg: Message) -> Outcome:
        """A debt reminder as the Sheets edition sends it: rich, or the same content as plain text when Telegram
        rejects the rich message (the buttons are lost with it)."""
        assert msg.body_html is not None
        if msg.telegram_chat_id is None:
            return Outcome(False, "guardian has no Telegram chat", permanent=True)
        out = await self._call(
            "sendRichMessage",
            json={"chat_id": msg.telegram_chat_id, "rich_message": {"html": msg.body_html}},
        )
        if out.ok or out.status_code not in (400, 404):
            return out
        return await self.send(replace(msg, body=R.strip_html(msg.body_html)))

    async def send_document(self, chat_id: int, filename: str, pdf: bytes) -> Outcome:
        return await self._call(
            "sendDocument",
            data={"chat_id": str(chat_id)},
            files={"document": (filename, pdf, "application/pdf")},
        )


class NoSmsProvider:
    async def send(self, msg: Message) -> Outcome:
        return Outcome(False, "no SMS provider is configured", permanent=True)


class EskizSender:
    """SMS through Eskiz.uz (notify.eskiz.uz): POST /api/auth/login -> data.token, then POST /api/message/sms/send
    (form fields mobile_phone, message, from). The token is cached; a 401 triggers one re-login."""

    def __init__(
        self, email: str, password: str, sender: str, base_url: str, client: httpx.AsyncClient
    ) -> None:
        self._email, self._password, self._from = email, password, sender
        self._base = base_url.rstrip("/")
        self._client = client
        self._token: str | None = None
        self._lock = asyncio.Lock()

    async def _login(self) -> str | None:
        r = await self._client.post(
            f"{self._base}/api/auth/login", data={"email": self._email, "password": self._password}
        )
        if r.status_code != 200:
            return None
        token = (r.json().get("data") or {}).get("token")
        return str(token) if token else None

    async def _post_sms(self, token: str, msg: Message) -> httpx.Response:
        phone = (msg.phone or "").lstrip("+")
        return await self._client.post(
            f"{self._base}/api/message/sms/send",
            headers={"Authorization": f"Bearer {token}"},
            data={"mobile_phone": phone, "message": msg.body, "from": self._from},
        )

    async def send(self, msg: Message) -> Outcome:
        if not msg.phone:
            return Outcome(False, "guardian has no phone number", permanent=True)
        try:
            async with self._lock:
                if self._token is None:
                    self._token = await self._login()
                    if self._token is None:
                        return Outcome(False, "eskiz login failed (check credentials)", permanent=True)
            r = await self._post_sms(self._token, msg)
            if r.status_code == 401:  # token expired (Eskiz tokens live ~30 days): log in again once
                async with self._lock:
                    self._token = await self._login()
                if self._token is None:
                    return Outcome(False, "eskiz login failed (check credentials)", permanent=True)
                r = await self._post_sms(self._token, msg)
        except httpx.HTTPError as exc:
            return Outcome(False, f"network error: {type(exc).__name__}")
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code == 200 and str(data.get("status", "")).lower() in ("waiting", "success", "ok"):
            return Outcome(True)
        note = str(data.get("message", ""))[:200]
        if r.status_code == 429 or r.status_code >= 500:
            return Outcome(False, f"eskiz {r.status_code}: {note}")
        return Outcome(False, f"eskiz {r.status_code}: {note}", permanent=True)


class Worker:
    def __init__(self, settings: WorkerSettings, http: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._http = http or httpx.AsyncClient(timeout=settings.worker_http_timeout_s)
        self.pool: AsyncConnectionPool[AsyncConnection[DictRow]] = AsyncConnectionPool(
            settings.database_url_worker.get_secret_value(),
            min_size=1,
            max_size=3,
            open=False,
            name="worker",
            connection_class=AsyncConnection[DictRow],
            kwargs={"row_factory": dict_row, "application_name": "nazoratly-worker"},
        )
        token = settings.telegram_bot_token
        self.senders: dict[str, Sender] = {"sms": NoSmsProvider()}
        key = settings.secrets_key
        self.box = SecretsBox(key.get_secret_value()) if key and key.get_secret_value().strip() else None
        self._env_token = (
            token.get_secret_value() if token is not None and token.get_secret_value().strip() else None
        )
        pw = settings.eskiz_password
        if settings.eskiz_email and pw is not None and pw.get_secret_value():
            self.senders["sms"] = EskizSender(
                settings.eskiz_email,
                pw.get_secret_value(),
                settings.eskiz_from,
                settings.eskiz_api_base,
                self._http,
            )

    async def open(self) -> None:
        await self.pool.open(wait=True, timeout=15)

    async def close(self) -> None:
        await self.pool.close()
        await self._http.aclose()

    async def run_once(self) -> int:
        return await self._run_outbox() + await self._run_staff_notices()

    async def _run_staff_notices(self) -> int:
        """Internal reminders to staff (G8): the same claim/complete pattern, delivered to the person's own Telegram chat."""
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT * FROM staff_notice_claim(%s)", (self.settings.worker_batch,))
            claimed = list(await cur.fetchall())
        for row in claimed:
            notice = Message(int(row["notice_id"]), "telegram", row["body"], row["telegram_chat_id"], None)
            outcome = await self._through_routes(int(row["org_id"]), notice, TelegramSender.send)
            async with self.pool.connection() as conn:
                await conn.execute(
                    "SELECT staff_notice_complete(%s, %s, %s, %s, %s)",
                    (row["notice_id"], outcome.ok, outcome.error, outcome.retry_after_s, outcome.permanent),
                )
            log.info("staff_notice_processed", notice_id=row["notice_id"], ok=outcome.ok, error=outcome.error)
        return len(claimed)

    async def _run_outbox(self) -> int:
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT * FROM outbox_claim(%s)", (self.settings.worker_batch,))
            claimed = list(await cur.fetchall())
        for row in claimed:
            msg = Message(
                row["message_id"],
                row["channel"],
                row["body"],
                row["telegram_chat_id"],
                row["phone"],
                row["body_html"],
                row["has_document"],
                row["text_delivered"],
            )
            if msg.channel == "telegram":
                deliver = self._deliver_document if msg.has_document else TelegramSender.send
                if not msg.has_document and (html := await self._reminder_html(msg)) is not None:
                    msg, deliver = replace(msg, body_html=html), TelegramSender.send_reminder
                outcome = await self._through_routes(int(row["org_id"]), msg, deliver)
            elif msg.has_document:
                outcome = Outcome(False, "documents are delivered through Telegram only", permanent=True)
            elif (sender := self.senders.get(msg.channel)) is None:
                outcome = Outcome(False, f"channel {msg.channel} is not configured", permanent=True)
            else:
                outcome = await sender.send(msg)
            async with self.pool.connection() as conn:
                await conn.execute(
                    "SELECT outbox_complete(%s, %s, %s, %s, %s)",
                    (msg.message_id, outcome.ok, outcome.error, outcome.retry_after_s, outcome.permanent),
                )
            log.info(
                "message_processed",
                message_id=msg.message_id,
                channel=msg.channel,
                ok=outcome.ok,
                error=outcome.error,
            )
        return len(claimed)

    async def _reminder_html(self, msg: Message) -> str | None:
        """What a debt reminder looks like at this very moment (owner decision 43): the approved text plus what the
        student owes NOW, the center's payment requisites and the buttons. None = not a debt reminder."""
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT * FROM outbox_reminder_facts(%s)", (msg.message_id,))
            rows = list(await cur.fetchall())
        if not rows:
            return None
        return R.reminder_rich(
            text=msg.body,
            paid_data=paid_callback(rows[0]["student_public_id"]),
            charges=[
                R.OpenCharge(r["period_month"], r["due_date"], r["outstanding"])
                for r in rows
                if r["outstanding"] is not None
            ],
            pay_info=rows[0]["pay_info"] or "",
        )

    async def _through_routes(
        self, org_id: int, msg: Message, deliver: Callable[[TelegramSender, Message], Awaitable[Outcome]]
    ) -> Outcome:
        """Send through the bot the person can be reached on: the center's own, else the shared one (0068). A bot that is
        refused is remembered and the next one is tried; no bot left = a visible, permanent "undeliverable"."""
        if msg.telegram_chat_id is None:
            return Outcome(False, "recipient has no Telegram chat", permanent=True)
        async with self.pool.connection() as conn:
            cur = await conn.execute(ROUTES_SQL, (org_id, msg.telegram_chat_id))
            rows = list(await cur.fetchall())
        routes = resolve_routes(rows, self._env_token, self.box)
        if not routes:
            if self._env_token is None and not any(r["secret_ciphertext"] for r in rows):
                return Outcome(False, "channel telegram is not configured", permanent=True)
            return Outcome(False, UNDELIVERABLE, permanent=True)
        outcome = Outcome(False, UNDELIVERABLE, permanent=True)
        for route in routes:
            sender = TelegramSender(route.token, self.settings.telegram_api_base, self._http)
            outcome = await deliver(sender, msg)
            if not outcome.refused:
                return outcome
            async with self.pool.connection() as conn:
                await conn.execute(MARK_UNREACHABLE_SQL, (route.bot_id, msg.telegram_chat_id))
        return Outcome(False, f"{UNDELIVERABLE}; last answer: {outcome.error}", permanent=True)

    async def _deliver_document(self, sender: TelegramSender, msg: Message) -> Outcome:
        """Rich text first, then the PDF. A retry after a failed upload skips the text that was already delivered."""
        assert msg.telegram_chat_id is not None
        if not msg.text_delivered:
            text = await sender.send_rich(msg)
            if not text.ok:
                return text
            async with self.pool.connection() as conn:
                await conn.execute("SELECT outbox_mark_text_delivered(%s)", (msg.message_id,))
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT filename, pdf FROM outbox_document(%s)", (msg.message_id,))
            doc = await cur.fetchone()
        if doc is None:
            return Outcome(False, "document file is missing", permanent=True)
        return await sender.send_document(msg.telegram_chat_id, doc["filename"], bytes(doc["pdf"]))

    async def run_forever(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                n = await self.run_once()
                touch_heartbeat()
            except Exception as exc:
                log.error("worker_cycle_failed", error=type(exc).__name__)
                n = 0
            if n == 0:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), timeout=self.settings.worker_poll_interval_s)


HEARTBEAT_PATH = Path(os.environ.get("NAZORATLY_WORKER_HEARTBEAT", "/tmp/nazoratly-worker.alive"))  # noqa: S108
HEARTBEAT_MAX_AGE_S = 90.0


def touch_heartbeat(path: Path = HEARTBEAT_PATH) -> None:
    """Written after every polling cycle that finished without an error; the container healthcheck reads it."""
    with contextlib.suppress(OSError):
        path.touch()


def heartbeat_fresh(path: Path = HEARTBEAT_PATH, max_age_s: float = HEARTBEAT_MAX_AGE_S) -> bool:
    try:
        return time.time() - path.stat().st_mtime <= max_age_s
    except OSError:
        return False


async def _main() -> None:
    settings = WorkerSettings()
    worker = Worker(settings)
    await worker.open()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):  # Windows
            loop.add_signal_handler(sig, stop.set)
    log.info(
        "worker_started",
        shared_bot=settings.telegram_bot_token is not None,
        center_bots=settings.secrets_key is not None,
    )
    try:
        await worker.run_forever(stop)
    finally:
        await worker.close()


def main() -> None:
    if "--healthcheck" in sys.argv[1:]:  # used by the container healthcheck
        sys.exit(0 if heartbeat_fresh() else 1)
    import structlog as _s

    quiet_http_client_logs()
    _s.configure(
        processors=[
            _s.processors.add_log_level,
            _s.processors.TimeStamper(fmt="iso", utc=True),
            _s.processors.JSONRenderer(),
        ]
    )
    if sys.platform == "win32":  # psycopg async needs a selector loop
        asyncio.run(_main(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(_main())


if __name__ == "__main__":
    main()
