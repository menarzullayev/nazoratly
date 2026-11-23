"""Interactive import: analyse a delimited text (preview) and write its clean rows in one transaction (commit).

Parsing, column detection, value normalisation and duplicate keys are the shared rules in `rules/imports.py` (golden
tests with the Sheets edition). This module adds what needs the database: groups, courses, teachers and lead sources
are matched by name, seats of full groups are counted row by row, and students/groups/leads that already exist are
detected so the same file can be uploaded twice without creating anything twice."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from nazoratly.db import Conn, execute, fetch_all, fetch_one
from nazoratly.errors import Unprocessable
from nazoratly.routers.academics import insert_enrollment, seat_counts
from nazoratly.rules import capacity as seats
from nazoratly.rules import imports as R

MAX_ROWS = 5000
MESSAGES = {
    "required": "required value is missing",
    "invalid_phone": "not a valid phone number (use +998 90 123 45 67 or 90 123 45 67)",
    "invalid_date": "not a valid date (use YYYY-MM-DD or DD.MM.YYYY)",
    "future_date": "the date is in the future",
    "invalid_number": "not a whole number",
    "out_of_range": "number is out of range",
    "too_long": "text is longer than 200 characters",
    "unknown_group": "no group with this name",
    "group_closed": "the group is finished or cancelled",
    "group_full": "the group is full",
    "seats_reserved": "the free seats of the group are reserved for its waiting list",
    "unknown_course": "no course with this name",
    "unknown_teacher": "no teacher with this name",
    "ambiguous_teacher": "several teachers have this name",
}


@dataclass
class RowReport:
    row: int  # line number in the file (the header is line 1)
    status: str = "ok"  # ok | error | duplicate
    values: dict[str, Any] = field(default_factory=dict)
    errors: list[dict[str, str]] = field(default_factory=list)
    duplicate: dict[str, Any] | None = None
    refs: dict[str, Any] = field(default_factory=dict)  # resolved database ids, never sent to the client


@dataclass
class Analysis:
    entity: str
    columns: list[str]
    mapping: dict[str, int | None]
    required_missing: list[str]
    rows: list[RowReport]

    def count(self, status: str) -> int:
        return sum(1 for r in self.rows if r.status == status)


def _err(code: str, fld: str) -> dict[str, str]:
    return {"field": fld, "code": code, "message": MESSAGES[code]}


def resolve_mapping(
    entity: str, headers: list[str], override: dict[str, int | None] | None
) -> dict[str, int | None]:
    detected = R.detect_columns(entity, headers)
    if override is None:
        return detected
    fields = set(R.FIELDS[entity])
    unknown = set(override) - fields
    if unknown:
        raise Unprocessable(f"Unknown fields in the mapping: {sorted(unknown)}")
    merged = {**detected, **override}
    used = [i for i in merged.values() if i is not None]
    if any(i < 0 or i >= len(headers) for i in used):
        raise Unprocessable("A mapped column does not exist in the file")
    if len(used) != len(set(used)):
        raise Unprocessable("One column cannot feed two fields")
    return merged


async def analyse(
    conn: Conn,
    *,
    entity: str,
    text: str,
    has_header: bool,
    mapping: dict[str, int | None] | None,
    today: date,
    duplicates_create: bool = False,
) -> Analysis:
    table = R.parse_delimited(text)
    if not table:
        raise Unprocessable("The file has no rows")
    headers = table[0] if has_header else [f"Ustun {i + 1}" for i in range(max(len(r) for r in table))]
    data = table[1:] if has_header else table
    if len(data) > MAX_ROWS:
        raise Unprocessable(f"Too many rows ({len(data)}); the limit is {MAX_ROWS} per import")
    mp = resolve_mapping(entity, headers, mapping)
    missing = [f for f in R.REQUIRED[entity] if mp[f] is None]
    out = Analysis(entity, headers, mp, missing, [])
    if missing:
        return out
    first_line = 2 if has_header else 1
    for i, cells in enumerate(data):
        raw = {f: (cells[idx] if idx < len(cells) else "") for f, idx in mp.items() if idx is not None}
        check = R.validate_row(entity, raw, today=today)
        rep = RowReport(first_line + i, values=check.values)
        rep.errors = [_err(e.code, e.field) for e in check.errors]
        rep.status = "error" if rep.errors else "ok"
        out.rows.append(rep)
    await _resolve_references(conn, out)
    existing = await _existing_keys(conn, entity)
    found = R.find_duplicates(
        entity, [dict(r.values) if r.status != "error" else None for r in out.rows], existing
    )
    for rep, dup in zip(out.rows, found, strict=True):
        if dup is not None:
            rep.status = "duplicate"
            rep.duplicate = {"kind": dup.kind, "of_row": out.rows[dup.of].row if dup.of is not None else None}
    if entity == "students":
        await _count_seats(conn, out, duplicates_create)
    return out


async def _resolve_references(conn: Conn, a: Analysis) -> None:
    if a.entity == "students":
        groups = {
            str(g["name"]).lower(): g
            for g in await fetch_all(
                conn,
                "SELECT id, name, capacity, status FROM study_groups WHERE deleted_at IS NULL",
            )
        }
        for rep in a.rows:
            name = str(rep.values.get("group", "")).strip()
            if rep.status == "error" or not name:
                continue
            g = groups.get(name.lower())
            if g is None:
                rep.errors.append(_err("unknown_group", "group"))
            elif g["status"] in ("finished", "cancelled"):
                rep.errors.append(_err("group_closed", "group"))
            else:
                rep.refs["group_id"] = int(g["id"])
                rep.refs["capacity"] = g["capacity"]
    elif a.entity == "groups":
        courses = {
            str(c["name"]).lower(): int(c["id"])
            for c in await fetch_all(
                conn, "SELECT id, name FROM courses WHERE deleted_at IS NULL AND status = 'active'"
            )
        }
        teachers: dict[str, list[int]] = {}
        for t in await fetch_all(conn, "SELECT id, full_name FROM teachers WHERE deleted_at IS NULL"):
            teachers.setdefault(str(t["full_name"]).lower(), []).append(int(t["id"]))
        for rep in a.rows:
            if rep.status == "error":
                continue
            cid = courses.get(str(rep.values.get("course", "")).lower())
            if cid is None:
                rep.errors.append(_err("unknown_course", "course"))
            else:
                rep.refs["course_id"] = cid
            tname = str(rep.values.get("teacher", "")).lower()
            if tname:
                found = teachers.get(tname, [])
                if not found:
                    rep.errors.append(_err("unknown_teacher", "teacher"))
                elif len(found) > 1:
                    rep.errors.append(_err("ambiguous_teacher", "teacher"))
                else:
                    rep.refs["teacher_id"] = found[0]
    for rep in a.rows:
        if rep.errors:
            rep.status = "error"


async def _existing_keys(conn: Conn, entity: str) -> set[str]:
    keys: set[str] = set()
    if entity == "students":
        rows = await fetch_all(
            conn, "SELECT full_name, phone::text AS phone, birth_date FROM students WHERE deleted_at IS NULL"
        )
        for r in rows:
            vals: dict[str, object] = {"full_name": r["full_name"]}
            if r["phone"]:
                vals["phone"] = r["phone"]
            if r["birth_date"]:
                vals["birth_date"] = r["birth_date"].isoformat()
            keys.update(R.duplicate_keys("students", vals))
    elif entity == "groups":
        for r in await fetch_all(conn, "SELECT name FROM study_groups WHERE deleted_at IS NULL"):
            keys.update(R.duplicate_keys("groups", {"name": r["name"]}))
    else:
        for r in await fetch_all(
            conn, "SELECT full_name, phone::text AS phone FROM leads WHERE deleted_at IS NULL"
        ):
            vals = {"full_name": r["full_name"]}
            if r["phone"]:
                vals["phone"] = r["phone"]
            keys.update(R.duplicate_keys("leads", vals))
    return keys


async def _count_seats(conn: Conn, a: Analysis, duplicates_create: bool) -> None:
    """Rows that will be written take seats in file order; a row that finds no seat is an error of its own."""
    state: dict[int, tuple[int, int]] = {}
    for rep in a.rows:
        gid = rep.refs.get("group_id")
        writable = rep.status == "ok" or (rep.status == "duplicate" and duplicates_create)
        if gid is None or not writable:
            continue
        if gid not in state:
            state[gid] = await seat_counts(conn, gid)
        occupied, waiting = state[gid]
        cap = rep.refs.get("capacity")
        if not seats.direct_enroll_allowed(
            capacity=cap, occupied=occupied, waiting=waiting, ignore_waitlist=False
        ):
            code = "group_full" if seats.free_seats(cap, occupied) == 0 else "seats_reserved"
            rep.errors.append(_err(code, "group"))
            rep.status = "error"
            continue
        state[gid] = (occupied + 1, waiting)


async def write_rows(
    conn: Conn, *, org_id: int, user_id: int, a: Analysis, duplicates_create: bool, today: date
) -> dict[str, Any]:
    """Writes every writable row. Runs inside the caller's transaction: an exception writes nothing."""
    created = {"students": 0, "guardians": 0, "enrollments": 0, "groups": 0, "leads": 0, "lead_sources": 0}
    results: list[dict[str, Any]] = []
    sources: dict[str, int] = {}
    if a.entity == "leads":
        for s in await fetch_all(conn, "SELECT id, name FROM lead_sources"):
            sources[str(s["name"]).lower()] = int(s["id"])
    for rep in a.rows:
        writable = rep.status == "ok" or (rep.status == "duplicate" and duplicates_create)
        if not writable:
            results.append({"row": rep.row, "result": "skipped_" + rep.status})
            continue
        v = rep.values
        if a.entity == "students":
            row = await fetch_one(
                conn,
                "INSERT INTO students (org_id, full_name, birth_date, phone, status, joined_on, notes) "
                "VALUES (%s, %s, %s, %s, 'active', %s, %s) RETURNING id, public_id",
                (org_id, v["full_name"], v.get("birth_date"), v.get("phone"), today, v.get("notes")),
            )
            assert row is not None
            created["students"] += 1
            if v.get("guardian_name"):
                created["guardians"] += await _link_guardian(
                    conn, org_id, int(row["id"]), str(v["guardian_name"]), v.get("guardian_phone")
                )
            if rep.refs.get("group_id") is not None:
                await insert_enrollment(
                    conn,
                    org_id=org_id,
                    student_id=int(row["id"]),
                    group_id=int(rep.refs["group_id"]),
                    started_on=today,
                )
                created["enrollments"] += 1
            results.append({"row": rep.row, "result": "created", "id": str(row["public_id"])})
        elif a.entity == "groups":
            row = await fetch_one(
                conn,
                "INSERT INTO study_groups (org_id, course_id, teacher_id, name, monthly_fee, capacity, start_date, status) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, 'planned') RETURNING public_id",
                (org_id, rep.refs["course_id"], rep.refs.get("teacher_id"), v["name"], v["monthly_fee"],
                 v.get("capacity"), v["start_date"]),
            )  # fmt: skip
            assert row is not None
            created["groups"] += 1
            results.append({"row": rep.row, "result": "created", "id": str(row["public_id"])})
        else:
            source_id = None
            if v.get("source"):
                key = str(v["source"]).lower()
                if key not in sources:
                    src = await fetch_one(
                        conn,
                        "INSERT INTO lead_sources (org_id, name) VALUES (%s, %s) RETURNING id",
                        (org_id, v["source"]),
                    )
                    assert src is not None
                    sources[key] = int(src["id"])
                    created["lead_sources"] += 1
                source_id = sources[key]
            row = await fetch_one(
                conn,
                "INSERT INTO leads (org_id, full_name, phone, source_id, note) VALUES (%s, %s, %s, %s, %s) RETURNING public_id",
                (org_id, v["full_name"], v.get("phone"), source_id, v.get("note")),
            )
            assert row is not None
            created["leads"] += 1
            results.append({"row": rep.row, "result": "created", "id": str(row["public_id"])})
    _ = user_id
    return {"created": {k: n for k, n in created.items() if n}, "rows": results}


async def _link_guardian(conn: Conn, org_id: int, student_id: int, name: str, phone: object) -> int:
    """Reuses a guardian with the same phone, otherwise creates one; returns 1 when a guardian was created."""
    gid: int | None = None
    made = 0
    if phone:
        found = await fetch_one(
            conn,
            "SELECT id FROM guardians WHERE phone = %s AND deleted_at IS NULL ORDER BY id LIMIT 1",
            (phone,),
        )
        gid = int(found["id"]) if found else None
    if gid is None:
        row = await fetch_one(
            conn,
            "INSERT INTO guardians (org_id, full_name, phone) VALUES (%s, %s, %s) RETURNING id",
            (org_id, name, phone),
        )
        assert row is not None
        gid = int(row["id"])
        made = 1
    await execute(
        conn,
        "INSERT INTO student_guardians (org_id, student_id, guardian_id, relation, is_primary) "
        "VALUES (%s, %s, %s, 'guardian', true)",
        (org_id, student_id, gid),
    )
    return made
