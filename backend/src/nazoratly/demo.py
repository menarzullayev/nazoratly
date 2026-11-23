"""Demo mode: a sample center (teachers, groups, students, lessons, attendance, charges, payments, expenses, leads and a
waiting list) written with `is_demo = true`. Demo money never enters the books: demo payments and expenses are excluded
from journal postings (`accounting._sources`), so the immutable journal and its hash chain are never touched. Clearing
goes through the database function `demo_clear()`, which deletes only flagged rows of the caller's center and refuses
when a real row references one."""

from __future__ import annotations

import json
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from nazoratly.db import Conn, execute, fetch_one

TABLES = [
    "students",
    "teachers",
    "courses",
    "study_groups",
    "enrollments",
    "lessons",
    "attendance",
    "charges",
    "payments",
    "expenses",
    "leads",
    "waitlist_entries",
]
STUDENTS = [
    "Aziz Rahimov", "Madina Tursunova", "Jasur Qodirov", "Nigora Ismoilova",
    "Bobur Saidov", "Lola Xasanova", "Otabek Mirzaev", "Zarina Yusupova",
]  # fmt: skip
WAITING = ["Kamola Nurmatova", "Davron Sodiqov", "Feruza Olimova"]
LEADS = [
    ("Sherzod Abdullayev", "new", "Instagram"),
    ("Mohira Ergasheva", "contacted", "Do'st tavsiyasi"),
    ("Anvar Toshpulatov", "trial_scheduled", "Instagram"),
    ("Dildora Karimova", "lost", "Telegram kanal"),
]


def month_start(d: date) -> date:
    return d.replace(day=1)


def prev_month(d: date) -> date:
    return month_start(month_start(d) - timedelta(days=1))


async def counts(conn: Conn) -> dict[str, int]:
    out: dict[str, int] = {}
    for t in TABLES:
        row = await fetch_one(conn, f"SELECT count(*) AS n FROM {t} WHERE is_demo")
        assert row is not None
        if row["n"]:
            out[t] = int(row["n"])
    return out


async def seed(conn: Conn, org_id: int, today: date) -> dict[str, int]:
    """Writes the sample center. Everything is flagged; names carry '(demo)' where a unique name is required."""
    cur = month_start(today)
    prev1 = prev_month(cur)
    prev2 = prev_month(prev1)

    async def one(sql: str, params: tuple[Any, ...]) -> int:
        row = await fetch_one(conn, sql + " RETURNING id", params)
        assert row is not None
        return int(row["id"])

    courses = [
        await one(
            "INSERT INTO courses (org_id, name, default_monthly_fee, is_demo) VALUES (%s, %s, %s, true)",
            (org_id, name, fee),
        )
        for name, fee in (("IELTS (demo)", 600_000), ("Matematika (demo)", 400_000))
    ]
    teachers = [
        await one(
            "INSERT INTO teachers (org_id, full_name, pay_model, pay_rate, status, is_demo) "
            "VALUES (%s, %s, %s, %s, 'active', true)",
            (org_id, name, model, rate),
        )
        for name, model, rate in (
            ("Dilnoza Karimova", "per_lesson", 90_000),
            ("Sardor Aliyev", "percent", 40),
        )
    ]
    groups = [
        await one(
            "INSERT INTO study_groups (org_id, course_id, teacher_id, name, monthly_fee, capacity, start_date, status, is_demo) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, 'active', true)",
            (org_id, courses[i], teachers[i], name, fee, cap, prev2.replace(day=1)),
        )
        for i, (name, fee, cap) in enumerate((("IELTS 6.5 kechki (demo)", 600_000, 4), ("Matematika 9-sinf (demo)", 400_000, 5)))
    ]  # fmt: skip
    weekdays = {0: (1, 3), 1: (2, 4)}  # Mon/Wed and Tue/Thu
    for gi, days in weekdays.items():
        for wd in days:
            await execute(
                conn,
                "INSERT INTO group_schedules (org_id, group_id, weekday, start_time, end_time, is_demo) "
                "VALUES (%s, %s, %s, '18:00', '19:30', true)",
                (org_id, groups[gi], wd),
            )

    students: list[int] = []
    enrollments: list[tuple[int, int, int, int]] = []  # (student, enrollment, group index, fee)
    for i, name in enumerate(STUDENTS):
        sid = await one(
            "INSERT INTO students (org_id, full_name, phone, status, joined_on, is_demo) "
            "VALUES (%s, %s, %s, 'active', %s, true)",
            (org_id, name, f"+99890123{4000 + i}", prev2.replace(day=5)),
        )
        students.append(sid)
        gi = i % 2
        discount = Decimal(10) if i == 3 else Decimal(0)
        eid = await one(
            "INSERT INTO enrollments (org_id, student_id, group_id, started_on, discount_percent, is_demo) "
            "VALUES (%s, %s, %s, %s, %s, true)",
            (org_id, sid, groups[gi], prev2.replace(day=5), discount),
        )
        fee = (600_000, 400_000)[gi]
        enrollments.append((sid, eid, gi, int(Decimal(fee) * (1 - discount / 100))))

    # lessons: the last four weeks of the schedule (past = held, today and the next week = planned)
    lesson_ids: dict[int, list[tuple[int, date]]] = {0: [], 1: []}
    for gi, days in weekdays.items():
        d = today - timedelta(days=28)
        while d <= today + timedelta(days=7):
            if d.isoweekday() in days:
                lid = await one(
                    "INSERT INTO lessons (org_id, group_id, teacher_id, lesson_date, start_time, end_time, status, is_demo) "
                    "VALUES (%s, %s, %s, %s, '18:00', '19:30', %s, true)",
                    (org_id, groups[gi], teachers[gi], d, "held" if d < today else "planned"),
                )
                if d < today:
                    lesson_ids[gi].append((lid, d))
            d += timedelta(days=1)
    for k, (sid, _eid, gi, _fee) in enumerate(enrollments):
        for j, (lid, _d) in enumerate(lesson_ids[gi]):
            status = "absent" if (k + j) % 7 == 0 else "late" if (k + j) % 5 == 0 else "present"
            await execute(
                conn,
                "INSERT INTO attendance (org_id, lesson_id, student_id, status, minutes_late, is_demo) "
                "VALUES (%s, %s, %s, %s, %s, true)",
                (org_id, lid, sid, status, 10 if status == "late" else 0),
            )

    # charges for the last three months; most families paid on time, two are behind
    months = [prev2, prev1, cur]
    for k, (sid, eid, _gi, fee) in enumerate(enrollments):
        paid_months = 1 if k == 1 else 0 if k == 4 else 2 if k == 5 else 3
        for mi, m in enumerate(months):
            ch = await one(
                "INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, description, amount, due_date, is_demo) "
                "VALUES (%s, %s, %s, 'tuition', %s, %s, %s, %s, true)",
                (org_id, sid, eid, m, f"Tuition {m:%Y-%m} (demo)", fee, m.replace(day=10)),
            )
            if mi < paid_months:
                paid_on = min(m.replace(day=8 + k), today)
                pay = await one(
                    "INSERT INTO payments (org_id, student_id, amount, method, paid_at, is_demo) "
                    "VALUES (%s, %s, %s, %s, %s::date, true)",
                    (org_id, sid, fee, ("cash", "card", "payme", "click")[(k + mi) % 4], paid_on),
                )
                await execute(
                    conn,
                    "INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount, is_demo) "
                    "VALUES (%s, %s, %s, %s, true)",
                    (org_id, pay, ch, fee),
                )
    for m in months:
        for cat, amount, day, note in (
            ("rent", 3_000_000, 3, "Ijara (demo)"),
            ("utilities", 450_000, 5, "Kommunal (demo)"),
        ):
            if m.replace(day=day) <= today:
                await execute(
                    conn,
                    "INSERT INTO expenses (org_id, category, amount, spent_at, description, is_demo) "
                    "VALUES (%s, %s, %s, %s, %s, true)",
                    (org_id, cat, amount, m.replace(day=day), note),
                )

    # leads
    source_ids: dict[str, int] = {}
    for name, stage, source in LEADS:
        if source not in source_ids:
            source_ids[source] = await one(
                "INSERT INTO lead_sources (org_id, name, is_demo) VALUES (%s, %s, true)",
                (org_id, source + " (demo)"),
            )
        await execute(
            conn,
            "INSERT INTO leads (org_id, full_name, phone, source_id, stage, next_follow_up_on, is_demo) "
            "VALUES (%s, %s, %s, %s, %s, %s, true)",
            (org_id, name, f"+99893555{1000 + len(source_ids) * 10 + len(name) % 10}", source_ids[source], stage,
             today + timedelta(days=2) if stage in ("new", "contacted") else None),
        )  # fmt: skip

    # waiting list: the IELTS group is full (two wait), the math group has a free seat for the one in line
    for i, name in enumerate(WAITING):
        sid = await one(
            "INSERT INTO students (org_id, full_name, status, is_demo) VALUES (%s, %s, 'lead', true)",
            (org_id, name),
        )
        await execute(
            conn,
            "INSERT INTO waitlist_entries (org_id, group_id, student_id, note, joined_at, is_demo) "
            "VALUES (%s, %s, %s, %s, now() - make_interval(days => %s), true)",
            (org_id, groups[0 if i < 2 else 1], sid, "demo", 3 - i),
        )
    return await counts(conn)


def blockers(detail: str | None) -> list[dict[str, Any]]:
    """The JSON detail that demo_clear() raises with: which tables hold real rows that reference demo rows."""
    try:
        data = json.loads(detail or "[]")
    except ValueError:
        return []
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []
