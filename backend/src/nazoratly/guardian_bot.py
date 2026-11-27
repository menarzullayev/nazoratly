"""The guardian side of the bots (stage 1 of the cabinet): inline-keyboard buttons over the same service the Mini App and
the portal use. `nazoratly.telegram_dispatch` routes updates here; callback data is `g:<epoch>:...` and the conversation
only reaches the centers of its scope (`nazoratly.telegram_scope`).

The bot only ever ANSWERS: to a message, a tap or a shared contact of the guardian himself. It never starts a
conversation, so nothing is sent to a guardian by automation (Model B); every request a guardian makes through it waits
for the center's approval. State is kept in the messages themselves (callback data, a marker in a force-reply prompt),
so the bot has no session of its own. All Telegram calls go through `TelegramApi` (a fake transport in tests)."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from nazoratly.accounting import org_today
from nazoratly.config import Settings
from nazoratly.db import Database, Session, execute, fetch_all, fetch_one
from nazoratly.guardian_service import (
    LINK_ATTEMPTS_PER_HOUR,
    GuardianCtx,
    attendance_view,
    balance_view,
    cabinet_settings,
    create_absence,
    create_makeup,
    create_promise,
    documents_view,
    ensure_guardian,
    grant_consent,
    link_student,
    linked_students,
    list_requests,
    makeup_view,
    results_view,
    schedule_view,
    sha256_hex,
    tok,
    upcoming_lessons_for_absence,
)
from nazoratly.guardian_telegram import TelegramApi, contact_keyboard
from nazoratly.rules import guardian as G
from nazoratly.telegram_scope import Scope, keyboard

_ANON = Session(user_id=None, org_id=None, actor_type="system")
QR_CODE = re.compile(r"^NZQ1-[A-HJ-NP-Z2-9]{20}$")
STATUS_TEXT = {
    "pending": "⏳ kutilmoqda",
    "approved": "✅ tasdiqlandi",
    "rejected": "❌ rad etildi",
    "cancelled": "↩️ bekor qilindi",
}
KIND_TEXT = {
    "absence_reason": "Darsga kela olmaslik",
    "payment_promise": "To'lov va'dasi",
    "makeup_choice": "Qoplash darsi",
}
STATUS_ATT = {"present": "keldi", "late": "kechikdi", "absent": "kelmadi", "excused": "sababli"}
WEEKDAY = ["", "Du", "Se", "Chor", "Pay", "Ju", "Sha", "Yak"]


def som(v: Any) -> str:
    return f"{round(float(v)):,}".replace(",", " ") + " so'm"


def hm(t: Any) -> str:
    return str(t)[:5]


@dataclass(frozen=True)
class Linked:
    ctx: GuardianCtx
    center: str


class GuardianBot:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        api: TelegramApi,
        *,
        scope: Scope,
        epoch: int,
        activate: Callable[[], Awaitable[int]],
        menu_rows: list[list[tuple[str, str]]] | None = None,
        miniapp_url: str | None = None,
    ) -> None:
        self.db = db
        self.cfg = settings
        self.api = api
        self.scope = scope
        self.epoch = epoch
        self.activate = activate  # a successful link makes "guardian" the chosen role; returns the new epoch
        self.menu_rows = menu_rows or []
        self.miniapp_url = miniapp_url

    def _kb(self, rows: list[list[tuple[str, str]]]) -> dict[str, Any]:
        return keyboard("g", self.epoch, rows)

    # ---- who is this ---------------------------------------------------------------------------------------------
    async def _linked(self, tg: int) -> list[Linked]:
        async with self.db.tx(_ANON) as conn:
            rows = await fetch_all(conn, "SELECT * FROM guardian_find_by_telegram(%s)", (tg,))
        return [
            Linked(GuardianCtx(int(r["org_id"]), int(r["guardian_id"]), None, ""), str(r["center_name"]))
            for r in rows
            if self.scope.allows(int(r["org_id"]))
        ]

    async def _find_student(self, tg: int, token: str) -> tuple[Linked, dict[str, Any]] | None:
        for lk in await self._linked(tg):
            async with self.db.tx(lk.ctx.session()) as conn:
                for s in await linked_students(conn, lk.ctx.guardian_id):
                    if tok(s["id"]) == token:
                        return lk, s
        return None

    # ---- entry points of the dispatcher --------------------------------------------------------------------------
    async def on_marker(self, tg: int, text: str, reply_to: str) -> bool:
        """A reply to a prompt of this bot (the reason of an absence). False when the prompt is not one of ours."""
        marker = re.search(r"#g\d{1,9}:a:([0-9a-f]{12}):([0-9a-f]{12})", reply_to)
        if marker is None:
            return False
        await self._absence_reason(tg, marker.group(2), marker.group(1), text)
        return True

    async def on_code(self, tg: int, name: str | None, text: str) -> None:
        await self._code_or_qr(tg, name, text)

    async def on_contact(self, tg: int, contact: dict[str, Any]) -> None:
        await self._contact(tg, contact)

    async def on_home(self, tg: int) -> None:
        await self._home(tg)

    async def _home(self, tg: int) -> None:
        linked = await self._linked(tg)
        if not linked:
            await self.api.send_message(
                tg,
                "Assalomu alaykum! Farzandingiz ma'lumotlarini ko'rish uchun markaz bergan bir martalik kodni yuboring "
                "(masalan: AB3K9XZM) yoki o'quvchi kartasidagi kodni (NZQ1-...) yuboring.\n"
                "Markazda telefon raqamingiz saqlangan bo'lsa, quyidagi tugma orqali raqamingizni ulashing.",
                contact_keyboard(),
            )
            return
        students: list[tuple[Linked, dict[str, Any]]] = []
        for lk in linked:
            async with self.db.tx(lk.ctx.session()) as conn:
                students += [(lk, s) for s in await linked_students(conn, lk.ctx.guardian_id)]
        if len(students) == 1:
            await self._student_menu(tg, students[0][0], students[0][1])
            return
        picks = [[(f"{s['full_name']} · {lk.center}", f"o:{tok(s['id'])}")] for lk, s in students][:20]
        await self.api.send_message(tg, "Farzandni tanlang:", self._kb(picks + self.menu_rows))

    async def _student_menu(self, tg: int, lk: Linked, s: dict[str, Any]) -> None:
        if not s["consent"]:
            await self._consent_prompt(tg, s)
            return
        t = tok(s["id"])
        rows = [
            [("📅 Davomat", f"a:{t}"), ("💰 Qarz va to'lov", f"b:{t}")],
            [("🧾 Hujjatlar", f"d:{t}"), ("🗓 Jadval", f"s:{t}")],
            [("📊 Natijalar", f"r:{t}"), ("📝 So'rovlarim", "q")],
            [("🚫 Darsga kela olmayman", f"x:{t}"), ("🤝 To'lov va'dasi", f"p:{t}")],
            [("🔁 Qoplash darsi", f"m:{t}"), ("🔑 Veb-portal", "l")],
        ]
        markup = self._kb(rows + self.menu_rows)
        if self.miniapp_url:
            markup["inline_keyboard"].append(
                [{"text": "📱 Kabinetni ochish", "web_app": {"url": self.miniapp_url}}]
            )
        await self.api.send_message(tg, f"{s['full_name']} ({lk.center})\nNimani ko'rmoqchisiz?", markup)

    async def _consent_prompt(self, tg: int, s: dict[str, Any]) -> None:
        await self.api.send_message(
            tg,
            f"{s['full_name']} ma'lumotlarini (davomat, to'lov, jadval, natijalar) ko'rish uchun shaxsiy ma'lumotlarni qayta "
            "ishlashga rozilik kerak. Rozilikni istalgan vaqtda markazga murojaat qilib qaytarib olishingiz mumkin.",
            self._kb([[("✅ Roziman", f"c:{tok(s['id'])}"), ("Rad etaman", "n")]]),
        )

    # ---- linking -------------------------------------------------------------------------------------------------
    async def _blocked(self, tg: int) -> bool:
        async with self.db.tx(_ANON) as conn:
            await execute(
                conn, "DELETE FROM guardian_link_attempts WHERE attempted_at < now() - interval '1 day'"
            )
            n = await fetch_one(
                conn,
                "SELECT count(*) AS n FROM guardian_link_attempts WHERE telegram_user_id = %s AND attempted_at > now() - interval '1 hour'",
                (tg,),
            )
        return bool(n and n["n"] >= LINK_ATTEMPTS_PER_HOUR)

    async def _fail(self, tg: int) -> None:
        async with self.db.tx(_ANON) as conn:
            await execute(conn, "INSERT INTO guardian_link_attempts (telegram_user_id) VALUES (%s)", (tg,))

    async def _code_or_qr(self, tg: int, name: str | None, text: str) -> None:
        raw = text.strip()
        qr = raw.upper()
        code = G.normalize_code(raw)
        if QR_CODE.match(qr):
            await self._qr(tg, name, qr)
        elif G.code_format_valid(code):
            await self._code(tg, name, code)
        else:
            await self.api.send_message(tg, "Kod noto'g'ri formatda. Markaz bergan 8 belgili kodni yuboring.")

    async def _code(self, tg: int, name: str | None, code: str) -> None:
        if await self._blocked(tg):
            await self.api.send_message(
                tg,
                "Juda ko'p noto'g'ri urinish. Bir soatdan keyin qayta urinib ko'ring yoki markazga murojaat qiling.",
            )
            return
        async with self.db.tx(_ANON) as conn:
            row = await fetch_one(
                conn, "SELECT *, now() AS now FROM guardian_find_code(%s)", (sha256_hex(code),)
            )
        state = (
            "unknown"
            if row is None
            else G.code_state(
                expires_at=row["expires_at"],
                now=row["now"],
                used=row["used_at"] is not None,
                revoked=row["revoked_at"] is not None,
            )
        )
        if row is not None and (note := self.scope.moved_note(int(row["org_id"]))):
            await self.api.send_message(tg, note)
            return
        if row is None or state != "ok" or not self.scope.allows(int(row["org_id"])):
            await self._fail(tg)
            await self.api.send_message(
                tg, "Kod noto'g'ri, ishlatilgan yoki muddati tugagan. Markazdan yangi kod so'rang."
            )
            return
        ctx = GuardianCtx(int(row["org_id"]), 0, None, "")
        async with self.db.tx(Session(user_id=None, org_id=ctx.org_id, actor_type="system")) as conn:
            claimed = await execute(
                conn,
                "UPDATE guardian_link_codes SET used_at = now() WHERE id = %s AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
                (row["code_id"],),
            )
            if not claimed:
                await self._fail(tg)
                await self.api.send_message(
                    tg, "Kod noto'g'ri, ishlatilgan yoki muddati tugagan. Markazdan yangi kod so'rang."
                )
                return
            decision = G.link_decision(method="code", phone_verified=False, phone_matches=False)
            assert decision == "active"
            gid = await ensure_guardian(
                conn,
                org_id=ctx.org_id,
                telegram_user_id=tg,
                name=name,
                phone=None,
                guardian_id=row["guardian_id"],
            )
            await link_student(
                conn,
                org_id=ctx.org_id,
                student_id=int(row["student_id"]),
                guardian_id=gid,
                relation=str(row["relation"]),
                via="code",
            )
            await execute(
                conn,
                "UPDATE guardian_link_codes SET used_by_guardian_id = %s WHERE id = %s",
                (gid, row["code_id"]),
            )
        self.epoch = await self.activate()
        await self.api.send_message(tg, "✅ Ulandi.")
        await self._home(tg)

    async def _qr(self, tg: int, name: str | None, qr: str) -> None:
        if await self._blocked(tg):
            await self.api.send_message(
                tg, "Juda ko'p noto'g'ri urinish. Bir soatdan keyin qayta urinib ko'ring."
            )
            return
        async with self.db.tx(_ANON) as conn:
            hit = await fetch_one(conn, "SELECT * FROM guardian_find_student_by_qr(%s)", (qr,))
        if hit is not None and (note := self.scope.moved_note(int(hit["org_id"]))):
            await self.api.send_message(tg, note)
            return
        if hit is None or not self.scope.allows(int(hit["org_id"])):
            await self._fail(tg)
            await self.api.send_message(
                tg, "Bu kartaga o'quvchi topilmadi. Kodni tekshiring yoki markazga murojaat qiling."
            )
            return
        decision = G.link_decision(method="qr", phone_verified=False, phone_matches=False)
        assert decision == "pending"
        async with self.db.tx(Session(user_id=None, org_id=int(hit["org_id"]), actor_type="system")) as conn:
            await execute(
                conn,
                "INSERT INTO guardian_link_requests (org_id, student_id, telegram_user_id, telegram_name) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (student_id, telegram_user_id) WHERE status = 'pending' DO NOTHING",
                (hit["org_id"], hit["student_id"], tg, name),
            )
        await self.api.send_message(
            tg,
            "So'rovingiz markazga yuborildi. Markaz tasdiqlagach, /start yuborib kabinetni oching.",
        )

    async def _contact(self, tg: int, contact: dict[str, Any]) -> None:
        verified = (
            contact.get("user_id") == tg
        )  # Telegram sets user_id only for the sender's own contact card
        key = G.phone_key(str(contact.get("phone_number") or ""))
        if await self._blocked(tg):
            await self.api.send_message(tg, "Juda ko'p urinish. Bir soatdan keyin qayta urinib ko'ring.")
            return
        async with self.db.tx(_ANON) as conn:
            found = await fetch_all(conn, "SELECT * FROM guardian_find_by_phone(%s)", (key,)) if key else []
        linked_any = False
        for f in [f for f in found if self.scope.allows(int(f["org_id"]))]:
            decision = G.link_decision(method="phone", phone_verified=verified, phone_matches=True)
            if decision != "active":
                continue
            async with self.db.tx(
                Session(user_id=None, org_id=int(f["org_id"]), actor_type="system")
            ) as conn:
                has_students = await fetch_one(
                    conn,
                    "SELECT 1 AS x FROM student_guardians WHERE guardian_id = %s LIMIT 1",
                    (f["guardian_id"],),
                )
                cur = await fetch_one(
                    conn, "SELECT telegram_chat_id FROM guardians WHERE id = %s", (f["guardian_id"],)
                )
                if has_students is None or cur is None or cur["telegram_chat_id"] not in (None, tg):
                    continue
                await execute(
                    conn, "UPDATE guardians SET telegram_chat_id = %s WHERE id = %s", (tg, f["guardian_id"])
                )
                await execute(
                    conn,
                    "UPDATE student_guardians SET linked_via = COALESCE(linked_via, 'phone') WHERE guardian_id = %s",
                    (f["guardian_id"],),
                )
                linked_any = True
        if not linked_any:
            await self._fail(tg)
            await self.api.send_message(
                tg,
                "Bu raqam bo'yicha o'quvchi topilmadi yoki raqam boshqa hisobga ulangan. Markaz bergan kodni yuboring.",
            )
            return
        self.epoch = await self.activate()
        await self.api.send_message(tg, "✅ Raqamingiz tasdiqlandi va ulandi.", {"remove_keyboard": True})
        await self._home(tg)

    # ---- callbacks -----------------------------------------------------------------------------------------------
    async def on_callback(self, tg: int, data: str, callback_id: str) -> None:
        await self.api.answer_callback(callback_id)
        verb, _, rest = data.partition(":")
        if data == "n":
            await self.api.send_message(
                tg,
                "Rozilik berilmaguncha ma'lumotlar ko'rsatilmaydi. Istasangiz, /start orqali qaytadan boshlang.",
            )
            return
        if data == "q":
            await self._my_requests(tg)
            return
        if data == "l":
            base = (self.cfg.public_base_url or "").rstrip("/")
            await self.api.send_message(
                tg,
                f"Veb-portal: {base}/ui/guardian\nTelefon raqamingizni kiriting, kod shu chatga keladi."
                if base
                else "Veb-portal hozircha sozlanmagan.",
            )
            return
        parts = rest.split(":")
        found = await self._find_student(tg, parts[0]) if parts and parts[0] else None
        if found is None:
            await self.api.send_message(tg, "O'quvchi topilmadi. /start yuboring.")
            return
        lk, s = found
        if verb == "c":
            async with self.db.tx(lk.ctx.session()) as conn:
                await grant_consent(
                    conn, org_id=lk.ctx.org_id, student_id=int(s["sid"]), guardian_id=lk.ctx.guardian_id
                )
            s = {**s, "consent": True}
            await self._student_menu(tg, lk, s)
            return
        if not s["consent"]:
            await self._consent_prompt(tg, s)
            return
        handler = {
            "o": self._cb_menu,
            "a": self._cb_attendance,
            "b": self._cb_balance,
            "d": self._cb_documents,
            "s": self._cb_schedule,
            "r": self._cb_results,
            "x": self._cb_absence_pick,
            "p": self._cb_promise_pick,
            "m": self._cb_makeup_pick,
            "xl": self._cb_absence_prompt,
            "pd": self._cb_promise_make,
            "mk": self._cb_makeup_make,
            "D": self._cb_send_document,
            "R": self._cb_send_report,
        }.get(verb)
        if handler is None:
            return
        await handler(tg, lk, s, parts[1:])

    async def _cb_menu(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        await self._student_menu(tg, lk, s)

    async def _cb_attendance(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            v = await attendance_view(conn, int(s["sid"]), 90)
        c = v["counts"]
        lines = [
            f"📅 {s['full_name']}: oxirgi 90 kun",
            f"Keldi {c['present']} · kechikdi {c['late']} · kelmadi {c['absent']} · sababli {c['excused']}",
        ]
        for r in v["records"][:8]:
            lines.append(
                f"{r['lesson_date']:%d.%m} {hm(r['start_time'])} {r['group_name']}: {STATUS_ATT[r['status']]}"
            )
        await self.api.send_message(tg, "\n".join(lines))

    async def _cb_balance(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            v = await balance_view(conn, int(s["sid"]))
        lines = [
            f"💰 {s['full_name']}",
            f"Qarz: {som(v['outstanding_total'])} (shundan muddati o'tgan: {som(v['overdue_total'])})",
        ]
        if float(v["credit"]) > 0:
            lines.append(f"Avans: {som(v['credit'])}")
        for c in v["open_charges"]:
            lines.append(
                f"• {c['period_month']:%Y-%m}: {som(c['outstanding'])}, muddat {c['due_date']:%d.%m.%Y}"
            )
            plan = c["plan"]
            if plan:
                for it in plan["installments"]:
                    mark = "✓" if float(it["outstanding"]) == 0 else ("!" if it["overdue"] else "·")
                    lines.append(
                        f"   {mark} {it['due_date'][8:10]}.{it['due_date'][5:7]} — {som(it['amount'])}"
                    )
        for pr in v["promises"][:3]:
            lines.append(
                f"🤝 Va'da {pr['promise_date']:%d.%m}: {STATUS_TEXT.get(pr['status'], pr['status'])}"
            )
        await self.api.send_message(
            tg, "\n".join(lines), self._kb([[("🤝 To'lov va'dasi", f"p:{tok(s['id'])}")]])
        )

    async def _cb_documents(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            docs = await documents_view(conn, int(s["sid"]))
        if not docs:
            await self.api.send_message(tg, "Hujjat yo'q.")
            return
        rows = [
            [
                (
                    f"{'Kvitansiya' if d['kind'] == 'receipt' else 'Hisob-faktura'} {d['number']}",
                    f"D:{tok(s['id'])}:{tok(d['id'])}",
                )
            ]
            for d in docs[:8]
        ]
        await self.api.send_message(tg, "🧾 Hujjatni tanlang (PDF yuboriladi):", self._kb(rows))

    async def _cb_send_document(self, tg: int, lk: Linked, s: dict[str, Any], rest: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            row = await fetch_one(
                conn,
                "SELECT d.number, f.pdf FROM documents d JOIN document_files f ON f.org_id = d.org_id AND f.document_id = d.id "
                "WHERE d.student_id = %s AND replace(d.public_id::text, '-', '') LIKE %s",
                (s["sid"], f"{rest[0] if rest else ''}%"),
            )
        if row is None:
            await self.api.send_message(tg, "Hujjat topilmadi.")
            return
        await self.api.send_document(tg, f"{row['number']}.pdf", bytes(row["pdf"]))

    async def _cb_schedule(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            v = await schedule_view(conn, int(s["sid"]), 14)
        lines = [f"🗓 {s['full_name']}: yaqin 14 kun"]
        for lsn in v["lessons"][:12]:
            extra = (
                " (bekor)"
                if lsn["status"] == "cancelled"
                else (" (qoplash)" if lsn["kind"] == "makeup" else "")
            )
            lines.append(
                f"{lsn['lesson_date']:%d.%m} {WEEKDAY[lsn['lesson_date'].isoweekday()]} {hm(lsn['start_time'])}-{hm(lsn['end_time'])} {lsn['group_name']}{extra}"
            )
        if len(lines) == 1:
            lines.append("Dars yo'q.")
        await self.api.send_message(tg, "\n".join(lines))

    async def _cb_results(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            v = await results_view(conn, int(s["sid"]))
        lines = [f"📊 {s['full_name']}"]
        for m in v["marks"][:5]:
            when = m["month"] or f"{m['lesson_date']:%d.%m}"
            lines.append(f"• {when} {m['group_name']}: {m['grade'] or '-'} {m['note'] or ''}".rstrip())
        for e in v["exams"][:3]:
            lines.append(f"• Imtihon {e['title']}: {e['score']}/{e['max_score']}")
        if len(lines) == 1:
            lines.append("Hali natija yo'q.")
        rows = [[(f"Hisobot {r['month']} PDF", f"R:{tok(s['id'])}:{tok(r['id'])}")] for r in v["reports"][:4]]
        await self.api.send_message(tg, "\n".join(lines), self._kb(rows) if rows else None)

    async def _cb_send_report(self, tg: int, lk: Linked, s: dict[str, Any], rest: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            row = await fetch_one(
                conn,
                "SELECT to_char(r.period_month, 'YYYY-MM') AS month, f.pdf FROM progress_reports r "
                "JOIN progress_report_files f ON f.org_id = r.org_id AND f.report_id = r.id "
                "WHERE r.student_id = %s AND r.status = 'approved' AND replace(r.public_id::text, '-', '') LIKE %s",
                (s["sid"], f"{rest[0] if rest else ''}%"),
            )
        if row is None:
            await self.api.send_message(tg, "Hisobot topilmadi.")
            return
        await self.api.send_document(tg, f"hisobot-{row['month']}.pdf", bytes(row["pdf"]))

    # ---- requests ------------------------------------------------------------------------------------------------
    async def _cb_absence_pick(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            lessons = await upcoming_lessons_for_absence(conn, int(s["sid"]))
        if not lessons:
            await self.api.send_message(tg, "Yaqin kunlarda ogohlantirish mumkin bo'lgan dars yo'q.")
            return
        rows = [
            [
                (
                    f"{lsn['lesson_date']:%d.%m} {hm(lsn['start_time'])} {lsn['group_name']}",
                    f"xl:{tok(s['id'])}:{tok(lsn['id'])}",
                )
            ]
            for lsn in lessons[:8]
        ]
        await self.api.send_message(tg, "Qaysi darsga kela olmaysiz?", self._kb(rows))

    async def _cb_absence_prompt(self, tg: int, lk: Linked, s: dict[str, Any], rest: list[str]) -> None:
        lesson_tok = rest[0] if rest else ""
        await self.api.send_message(
            tg,
            f"{s['full_name']} nega kela olmaydi? Sababni shu xabarga javob qilib yozing.\n#g{self.epoch}:a:{lesson_tok}:{tok(s['id'])}",
            {"force_reply": True, "input_field_placeholder": "Sabab"},
        )

    async def _absence_reason(self, tg: int, student_tok: str, lesson_tok: str, reason: str) -> None:
        found = await self._find_student(tg, student_tok)
        if found is None:
            await self.api.send_message(tg, "O'quvchi topilmadi. /start yuboring.")
            return
        lk, s = found
        if not s["consent"]:
            await self._consent_prompt(tg, s)
            return
        async with self.db.tx(lk.ctx.session()) as conn:
            lesson = await fetch_one(
                conn,
                "SELECT public_id FROM lessons WHERE replace(public_id::text, '-', '') LIKE %s",
                (f"{lesson_tok}%",),
            )
            if lesson is None:
                await self.api.send_message(tg, "Dars topilmadi.")
                return
            await create_absence(conn, lk.ctx, s, lesson["public_id"], reason)
        await self.api.send_message(
            tg, '📨 So\'rov markazga yuborildi. Markaz tasdiqlagach davomatda "sababli" deb belgilanadi.'
        )

    async def _cb_promise_pick(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            _en, max_days = await cabinet_settings(conn)
            today = await org_today(conn)
        offsets = [d for d in (1, 3, 7, 14) if d <= max_days] or [max_days]
        rows = [
            [
                (
                    f"{(today + timedelta(days=d)):%d.%m.%Y} gacha",
                    f"pd:{tok(s['id'])}:{(today + timedelta(days=d)):%Y%m%d}",
                )
            ]
            for d in offsets
        ]
        await self.api.send_message(tg, "Qaysi sanagacha to'lashni va'da qilasiz?", self._kb(rows))

    async def _cb_promise_make(self, tg: int, lk: Linked, s: dict[str, Any], rest: list[str]) -> None:
        try:
            when = datetime.strptime(rest[0], "%Y%m%d").date()
        except (ValueError, IndexError):
            await self.api.send_message(tg, "Sana noto'g'ri.")
            return
        async with self.db.tx(lk.ctx.session()) as conn:
            await create_promise(conn, lk.ctx, s, when, None)
        await self.api.send_message(
            tg, f"📨 Va'da ({when:%d.%m.%Y}) markazga yuborildi. Tasdiqlash markazda."
        )

    async def _cb_makeup_pick(self, tg: int, lk: Linked, s: dict[str, Any], _: list[str]) -> None:
        async with self.db.tx(lk.ctx.session()) as conn:
            rights = await makeup_view(conn, int(s["sid"]))
        rows: list[list[tuple[str, str]]] = []
        for r in rights:
            for slot in r["slots"][:4]:
                rows.append(
                    [
                        (
                            f"{slot['date']:%d.%m} {hm(slot['start_time'])} {slot['group_name']}",
                            f"mk:{tok(s['id'])}:{tok(r['id'])}:{tok(slot['lesson_id'])}",
                        )
                    ]
                )
        if not rows:
            await self.api.send_message(tg, "Ochiq qoplash huquqi yoki tanlash mumkin bo'lgan vaqt yo'q.")
            return
        await self.api.send_message(tg, "🔁 Qoplash darsi uchun vaqtni tanlang:", self._kb(rows[:10]))

    async def _cb_makeup_make(self, tg: int, lk: Linked, s: dict[str, Any], rest: list[str]) -> None:
        if len(rest) < 2:
            return
        async with self.db.tx(lk.ctx.session()) as conn:
            rights = await makeup_view(conn, int(s["sid"]))
            hit = next(
                (
                    (r, sl)
                    for r in rights
                    if tok(r["id"]) == rest[0]
                    for sl in r["slots"]
                    if tok(sl["lesson_id"]) == rest[1]
                ),
                None,
            )
            if hit is None:
                await self.api.send_message(tg, "Bu vaqt endi mavjud emas. Qaytadan tanlang.")
                return
            await create_makeup(conn, lk.ctx, s, hit[0]["id"], hit[1]["lesson_id"])
        await self.api.send_message(
            tg, "📨 Tanlovingiz markazga yuborildi. Markaz tasdiqlagach dars jadvalga qo'shiladi."
        )

    async def _my_requests(self, tg: int) -> None:
        lines = ["📝 So'rovlarim"]
        for lk in await self._linked(tg):
            async with self.db.tx(lk.ctx.session()) as conn:
                rows = await list_requests(conn, guardian_id=lk.ctx.guardian_id, limit=8)
            for r in rows:
                lines.append(f"• {KIND_TEXT[r['kind']]} — {r['student_name']}: {STATUS_TEXT[r['status']]}")
        if len(lines) == 1:
            lines.append("Hali so'rov yo'q.")
        await self.api.send_message(tg, "\n".join(lines))
