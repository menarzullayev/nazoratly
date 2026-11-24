"""Learning-results rules: grades, attendance percent, exam percent, report wording, certificate eligibility, number,
verification code and the privacy mask of a holder's name. Pure functions, mirrored in TypeScript
(sheets/src/domain/results.ts); both are checked against the same cases in tests/golden/results.json."""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

GRADE_MIN, GRADE_MAX = 1, 5

MONTHS_UZ = (
    "yanvar", "fevral", "mart", "aprel", "may", "iyun",
    "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr",
)  # fmt: skip

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 symbols, no I O 0 1 (same as the QR codes)
CODE_PREFIX = "NZC"
CODE_LEN = 12  # three groups of four symbols: 60 bits
_CODE = re.compile(rf"^{CODE_PREFIX}-[{ALPHABET}]{{4}}-[{ALPHABET}]{{4}}-[{ALPHABET}]{{4}}$")

CERTIFICATE_TITLE = "SERTIFIKAT"
REPORT_TITLE = "OYLIK HISOBOT"


def _half_up(x: Decimal, places: str) -> Decimal:
    return x.quantize(Decimal(places), rounding=ROUND_HALF_UP)


def is_valid_grade(grade: int) -> bool:
    """A lesson or month grade is a whole number 1..5."""
    return GRADE_MIN <= grade <= GRADE_MAX


def attendance_summary(statuses: list[str]) -> dict[str, Any]:
    """Counts of a student's marks in a month and the attendance percent. `late` counts as attended; `excused` lessons
    stay out of the denominator; no counted lesson = no percent (None)."""
    c = {k: statuses.count(k) for k in ("present", "late", "absent", "excused")}
    counted = c["present"] + c["late"] + c["absent"]
    percent = None if counted == 0 else int(_half_up(Decimal(c["present"] + c["late"]) * 100 / counted, "1"))
    return {**c, "counted": counted, "percent": percent}


def average_grade(grades: list[int]) -> str | None:
    """Mean of the grades with one decimal, half up ("4.5"); None when there is no grade."""
    if not grades:
        return None
    return str(_half_up(Decimal(sum(grades)) / len(grades), "0.1"))


def exam_percent(score: Decimal, max_score: Decimal) -> int:
    """Whole percent of an exam score, half up."""
    return int(_half_up(score * 100 / max_score, "1"))


def month_label(year: int, month: int) -> str:
    return f"{year} yil {MONTHS_UZ[month - 1]}"


def report_caption(
    center: str, student: str, label: str, percent: int | None, average: str | None
) -> str:
    """The text that travels with the report PDF (the same wording in both products)."""
    facts = [f"O'quvchi: {student}", f"Davr: {label}"]
    facts.append(f"Davomat: {percent}%" if percent is not None else "Davomat: ma'lumot yo'q")
    facts.append(f"O'rtacha baho: {average}" if average is not None else "O'rtacha baho: baho qo'yilmagan")
    return "\n".join([f"{center}: oylik hisobot", *facts, "PDF hujjat ilova qilingan."])


def certificate_eligible(enrollment_status: str, group_status: str) -> bool:
    """A certificate is for a completed course: the enrollment is finished, or it is active in a finished group.
    Trial and frozen enrollments never qualify."""
    if enrollment_status == "finished":
        return True
    return enrollment_status == "active" and group_status == "finished"


def certificate_number(year: int, serial: int) -> str:
    return f"SR-{year}-{serial:06d}"


def new_certificate_code(random_bytes: bytes) -> str:
    """Builds a code from CODE_LEN random bytes (5 bits each: 60 bits of entropy), shown as NZC-XXXX-XXXX-XXXX."""
    if len(random_bytes) < CODE_LEN:
        raise ValueError("need 12 random bytes")
    s = "".join(ALPHABET[b & 31] for b in random_bytes[:CODE_LEN])
    return f"{CODE_PREFIX}-{s[0:4]}-{s[4:8]}-{s[8:12]}"


def parse_certificate_code(text: str) -> str | None:
    """Canonical code from what a person typed (any case; spaces, dashes or none between the groups); None if it is
    not one of ours."""
    t = re.sub(r"[\s-]+", "", text).upper()
    if not t.startswith(CODE_PREFIX) or len(t) != len(CODE_PREFIX) + CODE_LEN:
        return None
    body = t[len(CODE_PREFIX) :]
    code = f"{CODE_PREFIX}-{body[0:4]}-{body[4:8]}-{body[8:12]}"
    return code if _CODE.match(code) else None


def mask_name(name: str) -> str:
    """Public verification never shows a full name: each word keeps its first letter, the rest become '*'."""
    return " ".join(w[0] + "*" * (len(w) - 1) for w in name.split())


def certificate_caption(center: str, student: str, course: str, number: str, code: str) -> str:
    return "\n".join(
        [
            f"{center}: sertifikat {number}",
            f"O'quvchi: {student}",
            f"Kurs: {course}",
            f"Tekshirish kodi: {code}",
            "PDF hujjat ilova qilingan.",
        ]
    )
