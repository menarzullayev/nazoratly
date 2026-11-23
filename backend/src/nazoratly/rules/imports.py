"""Interactive import rules: delimited-text parsing, column detection, per-row validation, duplicate keys.
Pure functions, mirrored in TypeScript (sheets/src/domain/imports.ts); both are checked against the same cases in
tests/golden/import.json."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Literal

Entity = Literal["students", "groups", "leads"]

FIELDS: dict[str, list[str]] = {
    "students": ["full_name", "phone", "birth_date", "guardian_name", "guardian_phone", "group", "notes"],
    "groups": ["name", "course", "teacher", "monthly_fee", "capacity", "start_date"],
    "leads": ["full_name", "phone", "source", "note"],
}
REQUIRED: dict[str, list[str]] = {
    "students": ["full_name"],
    "groups": ["name", "course", "monthly_fee", "start_date"],
    "leads": ["full_name"],
}
_PHONE = ["phone", "telefon", "tel", "raqam", "telefon raqam", "telefon raqami", "phone number", "телефон", "номер"]
ALIASES: dict[str, dict[str, list[str]]] = {
    "students": {
        "full_name": ["full name", "fullname", "name", "ism", "ismi", "ism familiya", "familiya ism", "fio", "f i o",
                      "oquvchi", "o'quvchi", "student", "имя", "фио", "ф и о", "ученик", "o'quvchi ismi"],
        "phone": _PHONE,
        "birth_date": ["birth date", "birthdate", "birthday", "dob", "tugilgan sana", "tug'ilgan sana",
                       "tug'ilgan kun", "tugilgan kun", "дата рождения", "рождения"],
        "guardian_name": ["guardian", "guardian name", "vasiy", "vasiy ismi", "ota ona", "ota onasi", "parent",
                          "parent name", "родитель", "опекун"],
        "guardian_phone": ["guardian phone", "vasiy telefon", "vasiy telefoni", "ota ona telefon",
                           "ota ona telefoni", "parent phone", "телефон родителя"],
        "group": ["group", "guruh", "группа"],
        "notes": ["notes", "note", "izoh", "izohlar", "комментарий", "примечание"],
    },
    "groups": {
        "name": ["name", "group", "group name", "guruh", "guruh nomi", "nomi", "название", "группа"],
        "course": ["course", "kurs", "fan", "курс", "subject"],
        "teacher": ["teacher", "oqituvchi", "o'qituvchi", "ustoz", "учитель", "преподаватель"],
        "monthly_fee": ["monthly fee", "fee", "price", "narx", "oylik", "oylik to'lov", "oylik tolov", "tolov",
                        "to'lov", "цена", "стоимость"],
        "capacity": ["capacity", "sigim", "sig'im", "max", "limit", "o'rinlar", "orinlar", "вместимость"],
        "start_date": ["start date", "start", "boshlanish", "boshlanish sanasi", "boshlanadi", "дата начала"],
    },
    "leads": {
        "full_name": ["full name", "fullname", "name", "ism", "ismi", "ism familiya", "fio", "имя", "фио"],
        "phone": _PHONE,
        "source": ["source", "manba", "qayerdan", "источник", "channel", "kanal"],
        "note": ["note", "notes", "izoh", "izohlar", "комментарий", "примечание"],
    },
}
_QUOTES = str.maketrans({"ʻ": "'", "ʼ": "'", "’": "'", "‘": "'", "`": "'", "´": "'"})
_MAX_TEXT = 200


def norm_header(text: str) -> str:
    t = text.translate(_QUOTES).lower().strip()
    return re.sub(r"[\s_\-.]+", " ", t).strip()


def norm_name(text: str) -> str:
    t = text.translate(_QUOTES).lower()
    return re.sub(r"\s+", " ", re.sub(r"[.\-_]", " ", t)).strip()


# ---- delimited text ----------------------------------------------------------------------------------------------
def parse_delimited(text: str) -> list[list[str]]:
    """Rows of cells. Delimiter = the most frequent of , ; TAB in the first line outside quotes. Handles a BOM, quoted
    cells with doubled quotes and newlines, CRLF. Rows with only empty cells are dropped."""
    if text.startswith("﻿"):
        text = text[1:]
    counts = {",": 0, ";": 0, "\t": 0}
    inq = False
    for ch in text:
        if ch == '"':
            inq = not inq
        elif not inq and ch in "\r\n":
            break
        elif not inq and ch in counts:
            counts[ch] += 1
    delim = max(counts, key=lambda k: counts[k]) if any(counts.values()) else ","
    rows: list[list[str]] = []
    row: list[str] = []
    cell: list[str] = []
    inq = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if inq:
            if ch == '"':
                if i + 1 < n and text[i + 1] == '"':
                    cell.append('"')
                    i += 1
                else:
                    inq = False
            else:
                cell.append(ch)
        elif ch == '"' and not cell:
            inq = True
        elif ch == delim:
            row.append("".join(cell))
            cell = []
        elif ch in "\r\n":
            if ch == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1
            row.append("".join(cell))
            cell = []
            rows.append(row)
            row = []
        else:
            cell.append(ch)
        i += 1
    if cell or row:
        row.append("".join(cell))
        rows.append(row)
    return [[c.strip() for c in r] for r in rows if any(c.strip() for c in r)]


# ---- column detection --------------------------------------------------------------------------------------------
def detect_columns(entity: str, headers: list[str]) -> dict[str, int | None]:
    """field -> column index. Exact alias match wins over a partial one; every column serves at most one field."""
    hs = [norm_header(h) for h in headers]
    scored: list[tuple[float, int, int, str]] = []
    for fi, fld in enumerate(FIELDS[entity]):
        al = [norm_header(a) for a in ALIASES[entity][fld]] + [norm_header(fld)]
        for ci, h in enumerate(hs):
            if not h:
                continue
            if h in al:
                scored.append((1.0, ci, fi, fld))
            elif any(len(a) >= 4 and a in h for a in al):
                scored.append((0.6, ci, fi, fld))
    scored.sort(key=lambda t: (-t[0], t[2], t[1]))
    out: dict[str, int | None] = {f: None for f in FIELDS[entity]}
    used: set[int] = set()
    for _score, ci, _fi, fld in scored:
        if out[fld] is None and ci not in used:
            out[fld] = ci
            used.add(ci)
    return out


# ---- value parsing -----------------------------------------------------------------------------------------------
def normalize_phone(text: str) -> str | None:
    """E.164 or None when the text is not a plausible number. Nine digits are Uzbek local numbers (+998)."""
    t = re.sub(r"[\s().\-]", "", text)
    if not t:
        return None
    if t.startswith("00"):
        t = "+" + t[2:]
    if t.startswith("+"):
        digits = t[1:]
        if digits.isdigit() and 8 <= len(digits) <= 15 and digits[0] != "0":
            return "+" + digits
        return None
    if not t.isdigit():
        return None
    if len(t) == 9:
        return "+998" + t
    if len(t) == 12 and t.startswith("998"):
        return "+" + t
    return None


_DATE_FORMS = [
    (re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$"), (0, 1, 2)),
    (re.compile(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$"), (2, 1, 0)),
]


def parse_date(text: str) -> str | None:
    t = text.strip()
    for rx, (yi, mi, di) in _DATE_FORMS:
        m = rx.match(t)
        if m:
            try:
                return date(int(m.group(yi + 1)), int(m.group(mi + 1)), int(m.group(di + 1))).isoformat()
            except ValueError:
                return None
    return None


def parse_whole(text: str) -> int | None:
    t = re.sub(r"[\s' ]", "", text)
    if re.fullmatch(r"\d+(\.0+)?", t):
        return int(t.split(".")[0])
    if re.fullmatch(r"\d{1,3}(,\d{3})+(\.0+)?", t):
        return int(t.split(".")[0].replace(",", ""))
    return None


# ---- rows --------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class RowError:
    field: str
    code: str


@dataclass
class RowCheck:
    values: dict[str, object] = field(default_factory=dict)
    errors: list[RowError] = field(default_factory=list)


def validate_row(entity: str, raw: dict[str, str], *, today: date) -> RowCheck:
    """Normalises one row. `raw` holds the cell text per field (missing = empty). Errors are per field and coded."""
    out = RowCheck()

    def text(f: str, *, required: bool = False) -> None:
        v = raw.get(f, "").strip()
        if not v:
            if required:
                out.errors.append(RowError(f, "required"))
            return
        if len(v) > _MAX_TEXT:
            out.errors.append(RowError(f, "too_long"))
            return
        out.values[f] = v

    def phone(f: str) -> None:
        v = raw.get(f, "").strip()
        if not v:
            return
        p = normalize_phone(v)
        if p is None:
            out.errors.append(RowError(f, "invalid_phone"))
        else:
            out.values[f] = p

    def day(f: str, *, required: bool = False, past: bool = False) -> None:
        v = raw.get(f, "").strip()
        if not v:
            if required:
                out.errors.append(RowError(f, "required"))
            return
        d = parse_date(v)
        if d is None:
            out.errors.append(RowError(f, "invalid_date"))
        elif past and d > today.isoformat():
            out.errors.append(RowError(f, "future_date"))
        elif past and d < "1900-01-01":
            out.errors.append(RowError(f, "invalid_date"))
        else:
            out.values[f] = d

    def whole(f: str, *, lo: int, hi: int, required: bool = False) -> None:
        v = raw.get(f, "").strip()
        if not v:
            if required:
                out.errors.append(RowError(f, "required"))
            return
        n = parse_whole(v)
        if n is None:
            out.errors.append(RowError(f, "invalid_number"))
        elif not lo <= n <= hi:
            out.errors.append(RowError(f, "out_of_range"))
        else:
            out.values[f] = n

    if entity == "students":
        text("full_name", required=True)
        phone("phone")
        day("birth_date", past=True)
        text("guardian_name")
        phone("guardian_phone")
        text("group")
        text("notes")
    elif entity == "groups":
        text("name", required=True)
        text("course", required=True)
        text("teacher")
        whole("monthly_fee", lo=0, hi=999_999_999_999, required=True)
        whole("capacity", lo=1, hi=10_000)
        day("start_date", required=True)
    else:
        text("full_name", required=True)
        phone("phone")
        text("source")
        text("note")
    return out


def duplicate_keys(entity: str, values: dict[str, object]) -> list[str]:
    """Identity keys of a normalised row. Students/leads: the phone, or name + birth date; a row with neither a phone nor
    a birth date falls back to the bare name. Groups: the name."""
    if entity == "groups":
        n = norm_name(str(values.get("name", "")))
        return [f"name:{n}"] if n else []
    keys: list[str] = []
    phone = values.get("phone")
    name = norm_name(str(values.get("full_name", "")))
    birth = values.get("birth_date")
    if phone:
        keys.append(f"phone:{phone}")
    if name and birth:
        keys.append(f"name:{name}|{birth}")
    if name and not phone and not birth:
        keys.append(f"name:{name}")
    return keys


@dataclass(frozen=True)
class Duplicate:
    kind: Literal["file", "existing"]
    of: int | None  # row index of the first occurrence in the file


def find_duplicates(
    entity: str, rows: list[dict[str, object] | None], existing: set[str]
) -> list[Duplicate | None]:
    """Per row: None, or how it duplicates something. `rows` holds normalised values, None for rows with errors (they
    neither count as duplicates nor claim a key)."""
    seen: dict[str, int] = {}
    out: list[Duplicate | None] = []
    for i, values in enumerate(rows):
        if values is None:
            out.append(None)
            continue
        keys = duplicate_keys(entity, values)
        hit: Duplicate | None = None
        for k in keys:
            if k in existing:
                hit = Duplicate("existing", None)
                break
        if hit is None:
            for k in keys:
                if k in seen:
                    hit = Duplicate("file", seen[k])
                    break
        if hit is None:
            for k in keys:
                seen.setdefault(k, i)
        out.append(hit)
    return out
