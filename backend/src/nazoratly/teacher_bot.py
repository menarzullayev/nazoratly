"""The teacher's Telegram bot (G8): link with an invitation code, today's lessons, roll call by buttons, groups, schedule,
hours and pay, and direct messages to guardians (templates or free text).

The dispatcher (`nazoratly.telegram_dispatch`) routes updates here and replies go out through `TgClient` (tests inject a
fake httpx transport; nothing real is ever called from here by itself). It works as the teacher of ONE center (the one the
person chose): every action runs through the same functions and rules the API uses, with a teacher Principal, so a teacher
can never reach a foreign group or lesson from the bot either.

Callback data (<= 64 bytes, sent as `t:<epoch>:` + the following, see `nazoratly.telegram_scope`): `l:<lesson32>` open a roll call, `r:<lesson32>:<page>` page it,
`a:<lesson32>:<student8>:<p|a|l|e>:<page>` mark one student, `m1` pick a group, `m1:<group32>` its students,
`m2:<student32>` pick a template, `m3:<student32>:<code>` send a template, `m4:<student32>` ask for free text (a reply to the
prompt carrying `#<student32>` is the text), `n` nothing."""

from __future__ import annotations

import re
import uuid
from datetime import date, timedelta
from typing import Any

import httpx
import structlog

from nazoratly.db import Database, Session, fetch_all, fetch_one
from nazoratly.deps import Principal
from nazoratly.errors import ApiError
from nazoratly.permissions import permissions_for
from nazoratly.routers.lessons import AttendanceIn, MarkIn, get_roster, put_attendance
from nazoratly.routers.teacher_me import teacher_pay
from nazoratly.rules import teacher as R
from nazoratly.teacher_app import (
    canonical_invite,
    invite_hash,
    load_app_settings,
    messages_today,
    org_now,
    own_groups,
    require_teacher,
    send_guardian_message,
)
from nazoratly.telegram_scope import Scope, keyboard

log = structlog.get_logger("teacher_bot")

PAGE = 8
STATUS_ICON = {"present": "✅", "absent": "❌", "late": "⏰", "excused": "🟡", None: "▫️"}
HELP = (
    "Ustoz boti buyruqlari:\n"
    "/bugun - bugungi darslar va davomat\n"
    "/guruhlar - mening guruhlarim\n"
    "/jadval - shu haftaning jadvali\n"
    "/oylik - soatlar va oylik\n"
    "/xabar - vasiyga xabar yozish\n"
    "/yordam - shu ro'yxat"
)
INVITE_ERRORS = {
    "invitation_unknown": "Bunday taklif kodi topilmadi. Kodni tekshiring.",
    "invitation_used": "Bu kod allaqachon ishlatilgan. Markazdan yangisini so'rang.",
    "invitation_revoked": "Bu taklif bekor qilingan. Markazdan yangisini so'rang.",
    "invitation_expired": "Taklifning muddati tugagan. Markazdan yangisini so'rang.",
    "teacher_already_linked": "Bu o'qituvchi allaqachon boshqa hisobga ulangan.",
    "user_has_other_role": "Bu Telegram hisobi markazda boshqa lavozimda. Markazga murojaat qiling.",
    "membership_suspended": "Hisobingiz to'xtatilgan. Markazga murojaat qiling.",
}
MESSAGE_ERRORS = {
    "messaging_off": "Sizga vasiylarga yozish huquqi o'chirilgan.",
    "not_own_student": "Bu o'quvchi sizning guruhingizda emas.",
    "no_recipient": "Bu o'quvchining vasiysiga Telegram orqali yozib bo'lmaydi (ulanmagan yoki rozilik yo'q).",
    "daily_limit": "Bugungi xabarlar limiti tugadi.",
}


class TgClient:
    """Minimal Bot API client. The token never appears in logs or exceptions."""

    def __init__(self, api_base: str, token: str, transport: httpx.AsyncBaseTransport | None) -> None:
        self._url = f"{api_base.rstrip('/')}/bot{token}"
        self._transport = transport

    async def call(self, method: str, payload: dict[str, Any]) -> None:
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=10) as http:
                r = await http.post(f"{self._url}/{method}", json=payload)
            if r.status_code >= 400:
                log.warning("telegram_call_failed", method=method, status=r.status_code)
        except httpx.HTTPError as exc:
            log.warning("telegram_call_error", method=method, error=type(exc).__name__)


class Ctx:
    """Everything one update needs: who writes, where to answer, which center he acts in."""

    def __init__(
        self,
        db: Database,
        tg: TgClient,
        chat_id: int,
        tg_user_id: int,
        *,
        org_id: int | None = None,
        epoch: int = 0,
        menu_rows: list[list[tuple[str, str]]] | None = None,
    ) -> None:
        self.db, self.tg, self.chat_id, self.tg_user_id = db, tg, chat_id, tg_user_id
        self.org_id, self.epoch = org_id, epoch
        self.menu_rows = menu_rows or []  # role switch etc., shown under the help text
        self.principal: Principal | None = None

    def kb(self, rows: list[list[tuple[str, str]]]) -> dict[str, Any]:
        return keyboard("t", self.epoch, rows)

    async def say(self, text: str, markup: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"chat_id": self.chat_id, "text": text}
        if markup:
            payload["reply_markup"] = markup
        await self.tg.call("sendMessage", payload)

    async def say_help(self, intro: str = "") -> None:
        await self.say(f"{intro}{HELP}", self.kb(self.menu_rows) if self.menu_rows else None)

    async def edit(self, message_id: int, text: str, markup: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"chat_id": self.chat_id, "message_id": message_id, "text": text}
        if markup:
            payload["reply_markup"] = markup
        await self.tg.call("editMessageText", payload)

    async def principal_or_none(self) -> Principal | None:
        """The teacher behind this Telegram account in the chosen center (checked against the database every time)."""
        if self.principal is not None:
            return self.principal
        if self.org_id is None:
            return None
        async with self.db.auth_tx(Session(None, None, None)) as conn:
            row = await fetch_one(
                conn,
                "SELECT u.id AS user_id, u.public_id AS user_public_id, m.org_id, m.role, m.branch_id "
                "FROM users u JOIN memberships m ON m.user_id = u.id JOIN organizations o ON o.id = m.org_id "
                "WHERE u.telegram_user_id = %s AND u.status = 'active' AND m.status = 'active' AND m.role = 'teacher' "
                "AND o.status = 'active' AND o.deleted_at IS NULL AND m.org_id = %s",
                (self.tg_user_id, self.org_id),
            )
        if row is None:
            return None
        self.principal = Principal(
            user_id=int(row["user_id"]),
            user_public_id=row["user_public_id"],
            org_id=int(row["org_id"]),
            role="teacher",
            branch_id=row["branch_id"],
            permissions=permissions_for("teacher"),
            request_id=f"bot-{uuid.uuid4()}",
            scope_branch_id=row["branch_id"],
        )
        return self.principal


def hex32(u: uuid.UUID) -> str:
    return u.hex


def uuid_of(h: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(hex=h)
    except ValueError:
        return None


# ---- linking ----------------------------------------------------------------------------------------------------------
async def link_account(ctx: Ctx, code_text: str, first_name: str, scope: Scope) -> tuple[int, str] | None:
    """Accept an invitation. Returns (center id, the confirmation to show) when the account became its teacher."""
    try:
        code = canonical_invite(code_text)
    except ApiError:
        await ctx.say("Taklif kodi T-XXXXXXXX ko'rinishida bo'ladi. Kodni tekshiring.")
        return None
    h = invite_hash(code)
    async with ctx.db.auth_tx(Session(None, None, None)) as conn:
        peek = await fetch_one(conn, "SELECT * FROM teacher_invite_peek(%s)", (h,))
        if peek is None:
            await ctx.say(INVITE_ERRORS["invitation_unknown"])
            return None
        if not scope.allows(int(peek["out_org_id"])):  # another center's code: tell nothing about it
            await ctx.say(scope.moved_note(int(peek["out_org_id"])) or INVITE_ERRORS["invitation_unknown"])
            return None
        if peek["out_status"] != "pending":
            await ctx.say(INVITE_ERRORS[f"invitation_{peek['out_status']}"])
            return None
        user = await fetch_one(
            conn, "SELECT id, status FROM users WHERE telegram_user_id = %s", (ctx.tg_user_id,)
        )
        try:
            async with conn.transaction():
                if user is None:
                    user = await fetch_one(
                        conn,
                        "INSERT INTO users (telegram_user_id, full_name) VALUES (%s, %s) RETURNING id, status",
                        (ctx.tg_user_id, peek["teacher_name"] or first_name or "O'qituvchi"),
                    )
                assert user is not None
                if user["status"] != "active":
                    await ctx.say(INVITE_ERRORS["membership_suspended"])
                    return None
                await fetch_one(conn, "SELECT * FROM teacher_invite_accept(%s, %s, 'bot')", (h, user["id"]))
        except Exception as exc:  # CheckViolation carries the reason in its message
            reason = getattr(getattr(exc, "diag", None), "message_primary", "") or ""
            if reason in INVITE_ERRORS:
                await ctx.say(INVITE_ERRORS[reason])
                return None
            raise
    return int(
        peek["out_org_id"]
    ), f"Ulandi! {peek['org_name']} markazi, o'qituvchi: {peek['teacher_name']}.\n\n"


# ---- commands ---------------------------------------------------------------------------------------------------------
def fmt_time(t: Any) -> str:
    return str(t.strftime("%H:%M"))


async def show_today(ctx: Ctx, p: Principal) -> None:
    async with ctx.db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        now = await org_now(conn)
        rows = await fetch_all(
            conn,
            "SELECT l.public_id, g.name AS group_name, l.start_time, l.end_time, l.status, "
            "(SELECT count(*) FROM attendance a WHERE a.org_id = l.org_id AND a.lesson_id = l.id) AS marked "
            "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
            "WHERE l.lesson_date = %s AND COALESCE(l.substitute_teacher_id, l.teacher_id, g.teacher_id) = %s "
            "ORDER BY l.start_time, l.id",
            (now.date(), t["id"]),
        )
    if not rows:
        await ctx.say("Bugun darsingiz yo'q.")
        return
    lines = [f"Bugungi darslar ({now.date().isoformat()}):"]
    buttons = []
    for r in rows:
        mark = (
            "bekor"
            if r["status"] == "cancelled"
            else (f"{r['marked']} belgilangan" if r["marked"] else "belgilanmagan")
        )
        lines.append(f"{fmt_time(r['start_time'])}-{fmt_time(r['end_time'])} {r['group_name']} ({mark})")
        if r["status"] != "cancelled":
            buttons.append(
                [(f"📋 {fmt_time(r['start_time'])} {r['group_name']}", f"l:{hex32(r['public_id'])}")]
            )
    await ctx.say("\n".join(lines), ctx.kb(buttons) if buttons else None)


async def roster_view(ctx: Ctx, p: Principal, lesson: uuid.UUID, page: int) -> tuple[str, dict[str, Any]]:
    roster = await get_roster(lesson, p, ctx.db)
    entries = roster.entries
    pages = max(1, (len(entries) + PAGE - 1) // PAGE)
    page = min(max(page, 0), pages - 1)
    chunk = entries[page * PAGE : (page + 1) * PAGE]
    async with ctx.db.tx(p.session()) as conn:
        info = await fetch_one(
            conn,
            "SELECT g.name, l.start_time, l.end_time FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
            "WHERE l.public_id = %s",
            (lesson,),
        )
    assert info is not None
    marked = sum(1 for e in entries if e.status)
    text = (
        f"{info['name']} {fmt_time(info['start_time'])}-{fmt_time(info['end_time'])}: davomat "
        f"({marked}/{len(entries)} belgilangan, {page + 1}/{pages})\n✅ keldi  ❌ kelmadi  ⏰ kechikdi  🟡 sababli"
    )
    rows: list[list[tuple[str, str]]] = []
    for e in chunk:
        sid = e.student_id.hex[:8]
        rows.append([(f"{STATUS_ICON[e.status]} {e.student_name}"[:40], "n")])
        rows.append(
            [
                (icon, f"a:{lesson.hex}:{sid}:{code}:{page}")
                for code, icon in (("p", "✅"), ("a", "❌"), ("l", "⏰"), ("e", "🟡"))
            ]
        )
    nav = []
    if page > 0:
        nav.append(("⬅️", f"r:{lesson.hex}:{page - 1}"))
    if page < pages - 1:
        nav.append(("➡️", f"r:{lesson.hex}:{page + 1}"))
    if nav:
        rows.append(nav)
    return text, ctx.kb(rows)


async def mark_one(ctx: Ctx, p: Principal, lesson: uuid.UUID, student8: str, code: str) -> str:
    status = {"p": "present", "a": "absent", "l": "late", "e": "excused"}.get(code)
    if status is None:
        return "Noma'lum belgi"
    roster = await get_roster(lesson, p, ctx.db)
    found = [e for e in roster.entries if e.student_id.hex.startswith(student8)]
    if len(found) != 1:
        return "O'quvchi topilmadi, ro'yxatni yangilang"
    await put_attendance(
        lesson,
        AttendanceIn(records=[MarkIn(student_id=found[0].student_id, status=status, minutes_late=0)]),
        p,
        ctx.db,
    )
    return "Saqlandi"


async def show_groups(ctx: Ctx, p: Principal) -> None:
    async with ctx.db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        groups = await own_groups(conn, int(t["id"]))
    if not groups:
        await ctx.say("Sizga biriktirilgan guruh yo'q.")
        return
    await ctx.say(
        "Guruhlarim:\n"
        + "\n".join(f"• {g['name']} ({g['course_name']}): {g['students']} o'quvchi" for g in groups)
    )


async def show_schedule(ctx: Ctx, p: Principal) -> None:
    async with ctx.db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        today = (await org_now(conn)).date()
        monday = today - timedelta(days=today.isoweekday() - 1)
        rows = await fetch_all(
            conn,
            "SELECT l.lesson_date, l.start_time, l.end_time, g.name AS group_name, l.status FROM lessons l "
            "JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
            "WHERE l.lesson_date BETWEEN %s AND %s AND COALESCE(l.substitute_teacher_id, l.teacher_id, g.teacher_id) = %s "
            "ORDER BY l.lesson_date, l.start_time, l.id",
            (monday, monday + timedelta(days=6), t["id"]),
        )
    if not rows:
        await ctx.say("Bu hafta darsingiz yo'q.")
        return
    lines = ["Shu hafta:"]
    day: date | None = None
    for r in rows:
        if r["lesson_date"] != day:
            day = r["lesson_date"]
            lines.append(f"\n{day.isoformat()}:")
        tag = " (bekor)" if r["status"] == "cancelled" else ""
        lines.append(f"  {fmt_time(r['start_time'])}-{fmt_time(r['end_time'])} {r['group_name']}{tag}")
    await ctx.say("\n".join(lines))


async def show_pay(ctx: Ctx, p: Principal) -> None:
    out = await teacher_pay(p, ctx.db, None)
    lines = [
        f"{out.month:%Y-%m}: {out.lessons} ta dars, {out.hours} soat.",
        f"Taxminiy oylik: {out.estimate:,} so'm".replace(",", " "),
    ]
    if out.payroll is not None:
        status = {"draft": "qoralama", "approved": "tasdiqlangan", "paid": "to'langan"}.get(
            out.payroll.status, out.payroll.status
        )
        lines.append(f"Hisoblangan oylik ({status}): {int(out.payroll.total):,} so'm".replace(",", " "))
    await ctx.say("\n".join(lines))


# ---- messages to guardians ----------------------------------------------------------------------------------------------
async def pick_group(ctx: Ctx, p: Principal) -> None:
    async with ctx.db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        groups = await own_groups(conn, int(t["id"]))
        settings = await load_app_settings(conn, p.org_id)
        left = max(0, int(settings["guardian_daily_limit"]) - await messages_today(conn, int(t["id"])))
    if not t["guardian_messaging_enabled"]:
        await ctx.say(MESSAGE_ERRORS["messaging_off"])
        return
    if not groups:
        await ctx.say("Sizga biriktirilgan guruh yo'q.")
        return
    await ctx.say(
        f"Qaysi guruh? (bugun yana {left} ta xabar yuborish mumkin)",
        ctx.kb([[(f"{g['name']} ({g['students']})", f"m1:{hex32(g['public_id'])}")] for g in groups]),
    )


async def pick_student(ctx: Ctx, p: Principal, group: uuid.UUID) -> None:
    async with ctx.db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        if group not in [g["public_id"] for g in await own_groups(conn, int(t["id"]))]:
            await ctx.say(MESSAGE_ERRORS["not_own_student"])
            return
        rows = await fetch_all(
            conn,
            "SELECT s.public_id, s.full_name FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
            "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
            "WHERE g.public_id = %s AND e.status = 'active' AND s.deleted_at IS NULL ORDER BY lower(s.full_name), s.id LIMIT 90",
            (group,),
        )
    if not rows:
        await ctx.say("Guruhda faol o'quvchi yo'q.")
        return
    await ctx.say(
        "Qaysi o'quvchining vasiysiga?",
        ctx.kb([[(r["full_name"][:40], f"m2:{hex32(r['public_id'])}")] for r in rows]),
    )


async def pick_template(ctx: Ctx, student: uuid.UUID) -> None:
    labels = {
        "absent": "Kelmadi",
        "late": "Kechikdi",
        "homework": "Uy vazifasi",
        "praise": "Maqtov",
        "meeting": "Suhbatga chaqirish",
    }
    rows = [[(labels[c], f"m3:{hex32(student)}:{c}")] for c in R.TEMPLATES]
    rows.append([("✍️ Erkin matn", f"m4:{hex32(student)}")])
    await ctx.say("Qaysi xabar?", ctx.kb(rows))


async def send_message(
    ctx: Ctx, p: Principal, student: uuid.UUID, template: str | None, text: str | None
) -> None:
    async with ctx.db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        s = await fetch_one(
            conn, "SELECT id FROM students WHERE public_id = %s AND deleted_at IS NULL", (student,)
        )
        if s is None:
            await ctx.say(MESSAGE_ERRORS["not_own_student"])
            return
        try:
            res = await send_guardian_message(
                conn,
                org_id=p.org_id,
                user_id=p.user_id,
                teacher=t,
                student_id=int(s["id"]),
                group_id=None,
                template=template,
                text=text,
            )
        except ApiError as exc:
            await ctx.say(MESSAGE_ERRORS.get(exc.code, exc.message))
            return
    await ctx.say(
        f"Yuborishga qo'yildi: {len(res['sent'])} ta vasiyga. Bugun yana {res['remaining_today']} ta mumkin."
    )


# ---- the update router ---------------------------------------------------------------------------------------------
_PROMPT_TAG = re.compile(r"#t\d{1,9}:([0-9a-f]{32})\b")


async def on_message(ctx: Ctx, p: Principal, msg: dict[str, Any]) -> None:
    text = str(msg.get("text", "")).strip()
    cmd = text.split()[0].lower().split("@")[0] if text.startswith("/") else ""
    reply_to = msg.get("reply_to_message") or {}
    tag = _PROMPT_TAG.search(str(reply_to.get("text", "")))
    if not cmd and tag and text:
        sid = uuid_of(tag.group(1))
        if sid is not None:
            await send_message(ctx, p, sid, None, text)
            return
    handlers = {
        "/bugun": show_today,
        "/darslar": show_today,
        "/guruhlar": show_groups,
        "/jadval": show_schedule,
        "/oylik": show_pay,
        "/xabar": pick_group,
    }
    handler = handlers.get(cmd)
    if handler is not None:
        await handler(ctx, p)
    else:
        await ctx.say_help()


async def on_callback(ctx: Ctx, p: Principal, data: str, cb_id: str, mid: Any) -> None:
    toast = ""
    parts = data.split(":")
    try:
        if parts[0] == "l" and len(parts) == 2 and (lesson := uuid_of(parts[1])):
            text, markup = await roster_view(ctx, p, lesson, 0)
            await ctx.say(text, markup)
        elif parts[0] == "r" and len(parts) == 3 and (lesson := uuid_of(parts[1])) and parts[2].isdigit():
            text, markup = await roster_view(ctx, p, lesson, int(parts[2]))
            await ctx.edit(int(mid), text, markup)
        elif parts[0] == "a" and len(parts) == 5 and (lesson := uuid_of(parts[1])) and parts[4].isdigit():
            toast = await mark_one(ctx, p, lesson, parts[2], parts[3])
            text, markup = await roster_view(ctx, p, lesson, int(parts[4]))
            await ctx.edit(int(mid), text, markup)
        elif parts[0] == "m1" and len(parts) == 1:
            await pick_group(ctx, p)
        elif parts[0] == "m1" and len(parts) == 2 and (group := uuid_of(parts[1])):
            await pick_student(ctx, p, group)
        elif parts[0] == "m2" and len(parts) == 2 and (student := uuid_of(parts[1])):
            await pick_template(ctx, student)
        elif parts[0] == "m3" and len(parts) == 3 and (student := uuid_of(parts[1])):
            await send_message(ctx, p, student, parts[2], None)
        elif parts[0] == "m4" and len(parts) == 2 and (student := uuid_of(parts[1])):
            await ctx.tg.call(
                "sendMessage",
                {
                    "chat_id": ctx.chat_id,
                    "text": f"Vasiyga yuboriladigan matnni shu xabarga javob qilib yozing. #t{ctx.epoch}:{hex32(student)}",
                    "reply_markup": {"force_reply": True, "input_field_placeholder": "Matn..."},
                },
            )
    except ApiError as exc:
        toast = exc.message
    await ctx.tg.call(
        "answerCallbackQuery", {"callback_query_id": cb_id, **({"text": toast} if toast else {})}
    )
