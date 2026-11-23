"""Import a Google Sheets edition workbook (CSV export of each tab) into the nazoratly API.

    python -m nazoratly.tools.sheets_import --api https://host --token <owner access token> --dir ./export [--dry-run]

Export every tab as CSV (File > Download > CSV) and name the files after the tabs:
O'quvchilar.csv, Guruhlar.csv, Yozilishlar.csv, Hisoblar.csv, To'lovlar.csv, Davomat.csv, O'qituvchilar.csv.
The import goes through the public API, so every rule of the system (tenant isolation, consent, integrity) applies.
A state file (import_state.json in the export directory) maps sheet ids to API ids: re-running continues where a
previous run stopped and never creates a row twice. Rows that the API rejects are reported and skipped.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import httpx

LABELS = {
    "student_status": {"lead": "lead", "faol": "active", "to'xtatilgan": "paused", "ketgan": "left"},
    "group_status": {"rejada": "planned", "faol": "active", "tugagan": "finished", "bekor": "cancelled"},
    "enroll_status": {"faol": "active", "muzlatilgan": "frozen", "tugagan": "finished"},
    "attendance": {"keldi": "present", "kelmadi": "absent", "kechikdi": "late", "sababli": "excused"},
    "pay_model": {"qat'iy oylik": "fixed", "dars uchun": "per_lesson", "foiz": "percent"},
    "method": {
        "naqd": "cash",
        "karta": "card",
        "o'tkazma": "bank_transfer",
        "payme": "payme",
        "click": "click",
    },
}
E164 = re.compile(r"^\+[1-9][0-9]{7,14}$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Api(Protocol):
    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None, key: str | None = None
    ) -> httpx.Response: ...


class HttpApi:
    def __init__(self, base_url: str, token: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
            transport=transport,
        )

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None, key: str | None = None
    ) -> httpx.Response:
        headers = {"Idempotency-Key": key} if key and method == "POST" else {}
        return await self._client.request(method, path, json=body, headers=headers)

    async def close(self) -> None:
        await self._client.aclose()


def _num(v: str) -> int:
    s = re.sub(r"[\s,]", "", v or "")
    try:
        return round(float(s)) if s else 0
    except ValueError:
        return 0


def _yes(v: str) -> bool:
    return (v or "").strip().lower() in {"ha", "yes", "true", "1", "+"}


def _label(group: str, v: str, default: str) -> str:
    return LABELS[group].get((v or "").strip().lower(), default)


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [
            {k.strip(): (v or "").strip() for k, v in row.items() if k}
            for row in csv.DictReader(f)
            if any((v or "").strip() for v in row.values())
        ]


@dataclass
class Report:
    created: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    skipped: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    errors: list[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = [
            f"  {k}: {v} yaratildi" + (f", {self.skipped[k]} avval bor edi" if self.skipped.get(k) else "")
            for k, v in self.created.items()
        ]
        if self.errors:
            lines.append(f"  XATOLAR ({len(self.errors)}):")
            lines += [f"    - {e}" for e in self.errors[:50]]
        return "\n".join(lines)


class Importer:
    def __init__(
        self, api: Api, directory: Path, *, dry_run: bool = False, policy_version: str = "2026-11"
    ) -> None:
        self.api, self.dir, self.dry, self.policy = api, directory, dry_run, policy_version
        self.state_path = directory / "import_state.json"
        self.state: dict[str, dict[str, str]] = (
            json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        )
        self.report = Report()

    def _save(self) -> None:
        if not self.dry:
            self.state_path.write_text(json.dumps(self.state, indent=1, sort_keys=True))

    async def _make(
        self, table: str, sheet_id: str, method: str, path: str, body: dict[str, Any]
    ) -> str | None:
        """POST one row; returns the API id. Already imported rows are skipped, failures are reported."""
        known = self.state.setdefault(table, {})
        if sheet_id in known:
            self.report.skipped[table] += 1
            return known[sheet_id]
        if self.dry:
            self.report.created[table] += 1
            return f"dry-{table}-{sheet_id}"
        r = await self.api.call(
            method, path, body, key=f"sheets-import-{table}-{sheet_id}"[:255].ljust(8, "_")
        )
        if r.status_code not in (200, 201):
            self.report.errors.append(
                f"{table} {sheet_id}: HTTP {r.status_code} {r.json().get('error', {}).get('message', r.text)[:150]}"
            )
            return None
        known[sheet_id] = str(r.json().get("id", ""))
        self.report.created[table] += 1
        self._save()
        return known[sheet_id]

    async def _follow(
        self, table: str, what: str, method: str, path: str, body: dict[str, Any] | None = None
    ) -> None:
        if self.dry:
            return
        r = await self.api.call(method, path, body)
        if r.status_code not in (200, 201):
            self.report.errors.append(
                f"{table} {what}: HTTP {r.status_code} {r.json().get('error', {}).get('message', '')[:150]}"
            )

    async def run(self) -> Report:
        course = await self._make(
            "course",
            "default",
            "POST",
            "/v1/courses",
            {"name": "Umumiy (Sheets'dan)", "default_monthly_fee": "0"},
        )
        teachers = await self._teachers()
        groups = await self._groups(course, teachers)
        students = await self._students()
        enrollments = await self._enrollments(groups, students)
        await self._charges(students, enrollments)
        await self._payments(students)
        await self._attendance(groups, students)
        self._save()
        return self.report

    async def _teachers(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for r in read_csv(self.dir / "O'qituvchilar.csv"):
            model = _label("pay_model", r.get("Oylik turi", ""), "per_lesson")
            body = {
                "full_name": r["F.I.Sh."],
                "pay_model": model,
                "pay_rate": str(_num(r.get("Stavka", "0"))),
            }
            if tid := await self._make("teacher", r["ID"], "POST", "/v1/teachers", body):
                out[r["ID"]] = tid
        return out

    async def _groups(self, course: str | None, teachers: dict[str, str]) -> dict[str, str]:
        first_start: dict[str, str] = {}
        for e in read_csv(self.dir / "Yozilishlar.csv"):
            d = e.get("Boshlangan sana", "")
            if ISO.match(d) and d < first_start.get(e["Guruh ID"], "9999-99-99"):
                first_start[e["Guruh ID"]] = d
        out: dict[str, str] = {}
        for r in read_csv(self.dir / "Guruhlar.csv"):
            if course is None:
                break
            body: dict[str, Any] = {
                "course_id": course,
                "name": r["Guruh nomi"],
                "monthly_fee": str(_num(r.get("Oylik narx (so'm)", "0"))),
                "start_date": first_start.get(r["ID"], "2026-01-01"),
                "status": _label("group_status", r.get("Holat", ""), "active"),
            }
            if r.get("O'qituvchi ID") in teachers:
                body["teacher_id"] = teachers[r["O'qituvchi ID"]]
            if gid := await self._make("group", r["ID"], "POST", "/v1/groups", body):
                out[r["ID"]] = gid
        return out

    async def _students(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for r in read_csv(self.dir / "O'quvchilar.csv"):
            phone = r.get("Telefon", "")
            body: dict[str, Any] = {
                "full_name": r["F.I.Sh."],
                "status": _label("student_status", r.get("Holat", ""), "active"),
            }
            if E164.match(phone):
                body["phone"] = phone
            if r.get("Izoh"):
                body["notes"] = r["Izoh"]
            sid = await self._make("student", r["ID"], "POST", "/v1/students", body)
            if not sid:
                continue
            out[r["ID"]] = sid
            await self._guardian(r, sid, phone)
        return out

    async def _guardian(self, r: dict[str, str], student_api_id: str, phone: str) -> None:
        name, chat = r.get("Vasiy ismi", ""), r.get("Telegram chat ID", "")
        if not name:
            return
        body: dict[str, Any] = {"full_name": name}
        if chat.lstrip("-").isdigit():
            body["telegram_chat_id"] = int(chat)
        elif E164.match(phone):
            body["phone"] = phone
        else:
            self.report.errors.append(
                f"guardian {r['ID']}: aloqa (telefon/Telegram) yo'q, vasiy o'tkazib yuborildi"
            )
            return
        gid = await self._make("guardian", r["ID"], "POST", "/v1/guardians", body)
        if not gid:
            return
        if f"link-{r['ID']}" not in self.state.setdefault("link", {}):
            await self._follow(
                "link",
                r["ID"],
                "POST",
                f"/v1/students/{student_api_id}/guardians",
                {"guardian_id": gid, "relation": "guardian", "is_primary": True},
            )
            self.state["link"][f"link-{r['ID']}"] = "1"
        if _yes(r.get("Bildirishnoma roziligi", "")) and f"consent-{r['ID']}" not in self.state.setdefault(
            "consent", {}
        ):
            await self._follow(
                "consent",
                r["ID"],
                "POST",
                f"/v1/students/{student_api_id}/consents",
                {
                    "purpose": "notifications",
                    "policy_version": r.get("Siyosat versiyasi") or self.policy,
                    "given_by_guardian_id": gid,
                    "evidence": "Google Sheets'dan import qilindi (bot orqali olingan rozilik)",
                },
            )
            self.state["consent"][f"consent-{r['ID']}"] = "1"

    async def _enrollments(self, groups: dict[str, str], students: dict[str, str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for r in read_csv(self.dir / "Yozilishlar.csv"):
            g, s = groups.get(r["Guruh ID"]), students.get(r["O'quvchi ID"])
            if not (g and s):
                self.report.errors.append(f"enrollment {r['ID']}: guruh yoki o'quvchi import qilinmagan")
                continue
            body = {
                "student_id": s,
                "started_on": r.get("Boshlangan sana", ""),
                "discount_percent": str(_num(r.get("Chegirma %", "0"))),
            }
            eid = await self._make("enrollment", r["ID"], "POST", f"/v1/groups/{g}/enrollments", body)
            if not eid:
                continue
            out[r["ID"]] = eid
            status = _label("enroll_status", r.get("Holat", ""), "active")
            if status != "active" and f"status-{r['ID']}" not in self.state.setdefault(
                "enrollment_status", {}
            ):
                patch: dict[str, Any] = {"status": status}
                if status == "finished":
                    patch["ended_on"] = r.get("Tugagan sana") or r.get("Boshlangan sana", "")
                await self._follow("enrollment", r["ID"], "PATCH", f"/v1/enrollments/{eid}", patch)
                self.state["enrollment_status"][f"status-{r['ID']}"] = "1"
        return out

    async def _charges(self, students: dict[str, str], enrollments: dict[str, str]) -> None:
        for r in read_csv(self.dir / "Hisoblar.csv"):
            s = students.get(r["O'quvchi ID"])
            if not s:
                self.report.errors.append(f"charge {r['ID']}: o'quvchi import qilinmagan")
                continue
            body: dict[str, Any] = {
                "student_id": s,
                "kind": "tuition",
                "period_month": r["Oy"],
                "amount": str(_num(r["Summa"])),
                "due_date": r["To'lov muddati"],
                "description": r.get("Izoh") or None,
            }
            if r.get("Yozilish ID") in enrollments:
                body["enrollment_id"] = enrollments[r["Yozilish ID"]]
            cid = await self._make("charge", r["ID"], "POST", "/v1/charges", body)
            if (
                cid
                and _yes(r.get("Bekor qilingan", ""))
                and f"void-{r['ID']}" not in self.state.setdefault("void", {})
            ):
                await self._follow(
                    "charge",
                    r["ID"],
                    "POST",
                    f"/v1/charges/{cid}/void",
                    {"reason": "Sheets'da bekor qilingan"},
                )
                self.state["void"][f"void-{r['ID']}"] = "1"

    async def _payments(self, students: dict[str, str]) -> None:
        rows = sorted(read_csv(self.dir / "To'lovlar.csv"), key=lambda r: (r.get("Sana", ""), r["ID"]))
        for r in rows:
            s = students.get(r["O'quvchi ID"])
            if not s:
                self.report.errors.append(f"payment {r['ID']}: o'quvchi import qilinmagan")
                continue
            voided = _yes(r.get("Bekor qilingan", ""))
            body = {
                "student_id": s,
                "amount": str(_num(r["Summa"])),
                "method": _label("method", r.get("Usul", ""), "other"),
                "paid_at": f"{r['Sana']}T12:00:00+05:00",
                "note": r.get("Izoh") or None,
                "auto_allocate": not voided,
            }
            pid = await self._make("payment", r["ID"], "POST", "/v1/payments", body)
            if pid and voided and f"void-{r['ID']}" not in self.state.setdefault("void", {}):
                await self._follow(
                    "payment",
                    r["ID"],
                    "POST",
                    f"/v1/payments/{pid}/void",
                    {"reason": "Sheets'da bekor qilingan"},
                )
                self.state["void"][f"void-{r['ID']}"] = "1"

    async def _attendance(self, groups: dict[str, str], students: dict[str, str]) -> None:
        by_lesson: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
        for r in read_csv(self.dir / "Davomat.csv"):
            by_lesson[(r["Sana"], r["Guruh ID"])].append(r)
        for (day, gid), rows in sorted(by_lesson.items()):
            g = groups.get(gid)
            if not g:
                self.report.errors.append(f"attendance {day} {gid}: guruh import qilinmagan")
                continue
            lesson = await self._make(
                "lesson",
                f"{day}|{gid}",
                "POST",
                "/v1/lessons",
                {"group_id": g, "lesson_date": day, "start_time": "09:00:00", "end_time": "10:00:00"},
            )
            if not lesson:
                continue
            marks = [
                {
                    "student_id": students[r["O'quvchi ID"]],
                    "status": _label("attendance", r.get("Holat", ""), "present"),
                    "minutes_late": _num(r.get("Kechikish (daq)", "0"))
                    if _label("attendance", r.get("Holat", ""), "") == "late"
                    else 0,
                }
                for r in rows
                if r["O'quvchi ID"] in students
            ]
            if f"{day}|{gid}" in self.state.setdefault("attendance", {}):
                self.report.skipped["attendance"] += 1
                continue
            if self.dry:
                self.report.created["attendance"] += len(marks)
                continue
            resp = await self.api.call("PUT", f"/v1/lessons/{lesson}/attendance", {"records": marks})
            if resp.status_code == 200:
                self.state["attendance"][f"{day}|{gid}"] = "1"
                self.report.created["attendance"] += len(marks)
                self._save()
            else:
                self.report.errors.append(
                    f"attendance {day} {gid}: HTTP {resp.status_code} {resp.json().get('error', {}).get('message', '')[:150]}"
                )


async def _main(args: argparse.Namespace) -> int:
    api = HttpApi(args.api, args.token)
    try:
        report = await Importer(api, Path(args.dir), dry_run=args.dry_run).run()
    finally:
        await api.close()
    print(("[SINOV, hech narsa yozilmadi]\n" if args.dry_run else "") + report.summary())
    return 1 if report.errors else 0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--api", required=True)
    p.add_argument("--token", required=True, help="owner/admin access token (POST /v1/auth/login)")
    p.add_argument("--dir", required=True)
    p.add_argument("--dry-run", action="store_true")
    sys.exit(asyncio.run(_main(p.parse_args())))


if __name__ == "__main__":
    main()
