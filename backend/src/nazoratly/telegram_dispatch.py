"""One entry for every bot: decide who is writing, in which role and center, and hand the update to that side.

Routing order (design 2026-11-27, section 5): a code or QR -> the marker of a prompt being answered -> the namespace of a
tapped button -> the chosen role -> the role menu -> for an unknown person only how to link.

The stored role only drives the menu. What a person may see or do is checked against the database on every action: the
roles are re-read for each update, and the handlers run in that center's tenant session."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
import psycopg
import structlog

from nazoratly import teacher_bot
from nazoratly.config import Settings
from nazoratly.db import Database, Session, fetch_all, fetch_one
from nazoratly.errors import ApiError, translate_db_error
from nazoratly.guardian_bot import QR_CODE, GuardianBot
from nazoratly.guardian_telegram import TelegramApi, contact_keyboard
from nazoratly.rules import guardian as G
from nazoratly.rules import teacher as R
from nazoratly.secrets_box import SecretsBox
from nazoratly.telegram_registry import ANON, BotInfo
from nazoratly.telegram_scope import CALLBACK, MARKER, MENU, Scope

log = structlog.get_logger("telegram_dispatch")

_START = re.compile(r"^/start(?:@\w+)?(?:\s+(\S+))?$", re.IGNORECASE)
_MENU_COMMANDS = ("/rol", "/role")
_HOME_COMMANDS = ("/start", "/menu", "/help")
_NS = {"g": "guardian", "t": "teacher"}
STALE = "Bu tugma yoki savol eskirgan: rol yoki markaz almashgan. Qaytadan tanlang."
MENU_TITLE = "Qaysi sifatda davom etasiz?"
LINK_HELP = (
    "Assalomu alaykum! Bu bot nazoratly o'quv markazlari uchun. Ulanish uchun:\n"
    "• ustozlar: markaz bergan taklif kodini yuboring (T-XXXXXXXX);\n"
    "• ota-onalar: markaz bergan 8 belgili bir martalik kodni (masalan AB3K9XZM) yoki o'quvchi kartasidagi kodni "
    "(NZQ1-...) yuboring;\n"
    "• markazda telefon raqamingiz saqlangan bo'lsa, quyidagi tugma orqali raqamingizni ulashing."
)


@dataclass(frozen=True)
class Role:
    kind: str  # "teacher" | "guardian"
    org_id: int | None  # the teacher's center; None for the guardian role (it spans the scope's centers)
    org_public: uuid.UUID | None
    label: str

    @property
    def data(self) -> str:
        return f"{MENU}g" if self.org_public is None else f"{MENU}t:{self.org_public.hex}"


@dataclass(frozen=True)
class State:
    role: str | None
    org_id: int | None
    epoch: int


class Dispatcher:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        box: SecretsBox | None,
        bot: BotInfo,
        transport: httpx.AsyncBaseTransport | None,
    ) -> None:
        self.db, self.settings, self.box, self.bot, self.transport = db, settings, box, bot, transport
        self.api = TelegramApi(settings.telegram_api_base, bot.token, transport)

    # ---- entry ---------------------------------------------------------------------------------------------------
    async def handle(self, update: dict[str, Any]) -> None:
        """Process one update. Never raises (Telegram would retry a failing update forever): errors are logged."""
        msg = update.get("message")
        cb = update.get("callback_query")
        if not isinstance(msg, dict) and not isinstance(cb, dict):
            return
        src = msg if isinstance(msg, dict) else (cb or {}).get("message") or {}
        sender = (msg if isinstance(msg, dict) else cb or {}).get("from") or {}
        chat = src.get("chat") or {}
        tg = sender.get("id")
        if chat.get("type") != "private" or not isinstance(tg, int) or chat.get("id") != tg:
            return
        try:
            if isinstance(msg, dict):
                await _Turn(self, tg).message(msg)
            else:
                assert cb is not None
                await _Turn(self, tg).callback(cb)
        except ApiError as exc:  # a rule said no: tell the person why
            await self.api.send_message(tg, f"⚠️ {exc.message}")
        except psycopg.Error as exc:
            mapped = translate_db_error(exc)
            if mapped is None:
                log.exception("telegram_dispatch_failed", bot=str(self.bot.public_id))
            else:
                await self.api.send_message(tg, f"⚠️ {mapped.message}")
        except Exception:
            log.exception(
                "telegram_dispatch_failed", bot=str(self.bot.public_id), update_id=update.get("update_id")
            )
            await self.api.send_message(tg, "Xatolik yuz berdi. Keyinroq urinib ko'ring.")


class _Turn:
    """One update of one person on one bot."""

    def __init__(self, dispatcher: Dispatcher, tg: int) -> None:
        self.d = dispatcher
        self.db = dispatcher.db
        self.bot = dispatcher.bot
        self.api = dispatcher.api
        self.tg = tg
        self.scope = Scope(only_org=dispatcher.bot.org_id)
        self.roles: list[Role] = []
        self.state = State(None, None, 0)

    # ---- who is this ---------------------------------------------------------------------------------------------
    async def load(self) -> None:
        async with self.db.tx(ANON) as conn:
            # opening a conversation makes this bot usable for messages to the person (and lifts an earlier block)
            row = await fetch_one(
                conn,
                "INSERT INTO telegram_chats (bot_id, telegram_user_id, opened_via) VALUES (%s, %s, 'direct') "
                "ON CONFLICT (bot_id, telegram_user_id) DO UPDATE SET last_seen_at = now(), unreachable_at = NULL "
                "RETURNING active_role, active_org_id, epoch",
                (self.bot.id, self.tg),
            )
            if self.bot.org_id is None:
                moved = await fetch_all(conn, "SELECT * FROM tg_stopped_centers()")
                self.scope = Scope(moved={int(r["org_id"]): str(r["username"]) for r in moved})
        assert row is not None
        self.state = State(row["active_role"], row["active_org_id"], int(row["epoch"]))
        await self.load_roles()

    async def load_roles(self) -> None:
        async with self.db.auth_tx(Session(None, None, None)) as conn:
            teaching = await fetch_all(
                conn,
                "SELECT m.org_id, o.public_id, o.name FROM users u JOIN memberships m ON m.user_id = u.id "
                "JOIN organizations o ON o.id = m.org_id WHERE u.telegram_user_id = %s AND u.status = 'active' "
                "AND m.status = 'active' AND m.role = 'teacher' AND o.status = 'active' AND o.deleted_at IS NULL "
                "ORDER BY o.name, o.id",
                (self.tg,),
            )
        async with self.db.tx(ANON) as conn:
            guarding = await fetch_all(conn, "SELECT * FROM guardian_find_by_telegram(%s)", (self.tg,))
        roles = [
            Role("teacher", int(r["org_id"]), r["public_id"], f"Ustoz – {r['name']}")  # noqa: RUF001
            for r in teaching
            if self.scope.allows(int(r["org_id"]))
        ]
        if any(self.scope.allows(int(r["org_id"])) for r in guarding):
            roles.append(Role("guardian", None, None, "Ota-ona"))
        self.roles = roles

    def find_role(self, kind: str | None, org_id: int | None) -> Role | None:
        return next((r for r in self.roles if r.kind == kind and r.org_id == org_id), None)

    def chosen(self) -> Role | None:
        return self.find_role(self.state.role, self.state.org_id)

    async def activate(self, kind: str, org_id: int | None) -> int:
        """Store the chosen role and center. Choosing another one moves the epoch on: old buttons stop working."""
        async with self.db.tx(ANON) as conn:
            row = await fetch_one(
                conn,
                "UPDATE telegram_chats SET epoch = epoch + (CASE WHEN active_role IS DISTINCT FROM %(r)s "
                "OR active_org_id IS DISTINCT FROM %(o)s THEN 1 ELSE 0 END), active_role = %(r)s, active_org_id = %(o)s "
                "WHERE bot_id = %(b)s AND telegram_user_id = %(u)s RETURNING epoch",
                {"r": kind, "o": org_id, "b": self.bot.id, "u": self.tg},
            )
        assert row is not None
        self.state = State(kind, org_id, int(row["epoch"]))
        return self.state.epoch

    async def current(self) -> Role | None:
        """The chosen role while it is still the person's; a single role is chosen without asking."""
        role = self.chosen()
        if role is None and len(self.roles) == 1:
            role = self.roles[0]
            await self.activate(role.kind, role.org_id)
        return role

    # ---- the two sides -------------------------------------------------------------------------------------------
    def menu_rows(self) -> list[list[tuple[str, str]]]:
        return [[("🔄 Rol / markazni almashtirish", f"{MENU}menu")]] if len(self.roles) > 1 else []

    def miniapp_url(self) -> str | None:
        base = self.d.settings.public_base_url
        if not base:
            return None
        suffix = "" if self.bot.shared else f"?bot={self.bot.public_id}"
        return f"{base.rstrip('/')}/ui/guardian{suffix}"

    def guardian(self) -> GuardianBot:
        async def activate() -> int:
            epoch = await self.activate("guardian", None)
            await self.load_roles()
            side.menu_rows = self.menu_rows()
            return epoch

        side = GuardianBot(
            self.db,
            self.d.settings,
            self.api,
            scope=self.scope,
            epoch=self.state.epoch,
            activate=activate,
            menu_rows=self.menu_rows(),
            miniapp_url=self.miniapp_url(),
        )
        return side

    def teacher(self) -> teacher_bot.Ctx:
        client = teacher_bot.TgClient(self.d.settings.telegram_api_base, self.bot.token, self.d.transport)
        return teacher_bot.Ctx(
            self.db,
            client,
            self.tg,
            self.tg,
            org_id=self.state.org_id,
            epoch=self.state.epoch,
            menu_rows=self.menu_rows(),
        )

    async def home(self, role: Role) -> None:
        if role.kind == "guardian":
            await self.guardian().on_home(self.tg)
        else:
            await self.teacher().say_help()

    async def unknown(self) -> None:
        await self.api.send_message(self.tg, LINK_HELP, contact_keyboard())

    async def show_menu(self, title: str = MENU_TITLE) -> None:
        if not self.roles:
            await self.unknown()
            return
        await self.api.send_message(
            self.tg,
            title,
            {"inline_keyboard": [[{"text": r.label[:60], "callback_data": r.data}] for r in self.roles[:20]]},
        )

    async def stale(self) -> None:
        if len(self.roles) > 1:
            await self.show_menu(STALE)
            return
        await self.api.send_message(self.tg, STALE)
        role = await self.current()
        await (self.home(role) if role is not None else self.unknown())

    # ---- messages ------------------------------------------------------------------------------------------------
    async def message(self, m: dict[str, Any]) -> None:
        await self.load()
        sender = m.get("from") or {}
        name = " ".join(x for x in (sender.get("first_name"), sender.get("last_name")) if x) or None
        contact = m.get("contact")
        if isinstance(contact, dict):
            await self.guardian().on_contact(self.tg, contact)
            return
        text = str(m.get("text") or "").strip()
        start = _START.match(text)
        payload = (start.group(1) or "") if start else ""
        reply_to = str((m.get("reply_to_message") or {}).get("text") or "")
        marker = MARKER.search(reply_to) if text and not text.startswith("/") else None
        if text and await self.code(payload if start else text, name, bare_allowed=marker is None):
            return
        if marker is not None:
            await self.answer_prompt(m, marker.group(1), int(marker.group(2)), reply_to)
            return
        command = text.split()[0].lower().split("@")[0] if text.startswith("/") else ""
        if command in _MENU_COMMANDS:
            await self.show_menu()
            return
        role = await self.current()
        if role is None:
            await self.show_menu()
        elif role.kind == "teacher":
            ctx = self.teacher()
            principal = await ctx.principal_or_none()
            if principal is None:
                await self.show_menu()
            elif command in _HOME_COMMANDS:
                await ctx.say_help()
            else:
                await teacher_bot.on_message(ctx, principal, m)
        else:
            await self.guardian().on_home(self.tg)

    async def code(self, candidate: str, name: str | None, *, bare_allowed: bool) -> bool:
        """Codes come first. Prefixed ones are unmistakable; the 8-character guardian code looks like an ordinary word, so
        a reply to one of the bot's questions is never read as one."""
        if not candidate:
            return False
        if R.normalize_invite_code(candidate) is not None:
            await self.link_teacher(candidate, name)
            return True
        if QR_CODE.match(candidate.upper()):
            await self.guardian().on_code(self.tg, name, candidate)
            return True
        if (
            bare_allowed
            and not candidate.startswith("/")
            and G.code_format_valid(G.normalize_code(candidate))
        ):
            await self.guardian().on_code(self.tg, name, candidate)
            return True
        return False

    async def link_teacher(self, code: str, name: str | None) -> None:
        ctx = self.teacher()
        linked = await teacher_bot.link_account(ctx, code, name or "", self.scope)
        if linked is None:
            return
        org_id, welcome = linked
        await self.activate("teacher", org_id)
        await self.load_roles()
        await self.teacher().say_help(welcome)

    async def answer_prompt(self, m: dict[str, Any], ns: str, epoch: int, reply_to: str) -> None:
        role = self.chosen()
        if role is None or role.kind != _NS[ns] or epoch != self.state.epoch:
            await self.stale()
            return
        if role.kind == "guardian":
            if not await self.guardian().on_marker(self.tg, str(m.get("text") or "").strip(), reply_to):
                await self.stale()
            return
        ctx = self.teacher()
        principal = await ctx.principal_or_none()
        if principal is None:
            await self.stale()
            return
        await teacher_bot.on_message(ctx, principal, m)

    # ---- buttons -------------------------------------------------------------------------------------------------
    async def callback(self, cq: dict[str, Any]) -> None:
        await self.load()
        data = str(cq.get("data") or "")
        cb_id = str(cq.get("id") or "")
        if not self.roles:
            await self.api.answer_callback(cb_id, "Avval ulaning", alert=True)
            await self.unknown()
            return
        if data.startswith(MENU):
            await self.menu_tap(data, cb_id)
            return
        match = CALLBACK.match(data)
        role = self.chosen()
        if (
            match is None
            or role is None
            or role.kind != _NS[match.group(1)]
            or int(match.group(2)) != self.state.epoch
        ):
            await self.api.answer_callback(cb_id, STALE, alert=True)
            await self.stale()
            return
        rest = match.group(3)
        if role.kind == "guardian":
            await self.guardian().on_callback(self.tg, rest, cb_id)
            return
        ctx = self.teacher()
        principal = await ctx.principal_or_none()
        if principal is None:
            await self.api.answer_callback(cb_id, STALE, alert=True)
            await self.stale()
            return
        await teacher_bot.on_callback(
            ctx, principal, rest, cb_id, (cq.get("message") or {}).get("message_id")
        )

    async def menu_tap(self, data: str, cb_id: str) -> None:
        if data == f"{MENU}menu":
            await self.api.answer_callback(cb_id)
            await self.show_menu()
            return
        role = next((r for r in self.roles if r.data == data), None)
        if role is None:  # a role the person does not (or no longer) have through this bot
            await self.api.answer_callback(cb_id, "Bu rol sizga ochiq emas.", alert=True)
            await self.show_menu()
            return
        await self.api.answer_callback(cb_id)
        await self.activate(role.kind, role.org_id)
        await self.home(role)
