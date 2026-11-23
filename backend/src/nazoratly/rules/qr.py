"""QR attendance rules. Pure functions, mirrored in TypeScript (sheets/src/domain/qr.ts, qrcode.ts); both are checked
against the same cases in tests/golden/qr.json. The QR carries only the random student code, never personal data."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from reportlab.graphics.barcode import qrencoder

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 symbols, no I O 0 1
PREFIX = "NZQ1-"
CODE_LEN = 20
_CODE = re.compile(rf"^{PREFIX}[{ALPHABET}]{{{CODE_LEN}}}$")

ScanResult = Literal[
    "marked", "already_present", "not_in_group", "lesson_cancelled", "unknown_code", "bad_code"
]


def new_code(random_bytes: bytes) -> str:
    """Builds a code from CODE_LEN random bytes (5 bits each: 100 bits of entropy)."""
    if len(random_bytes) < CODE_LEN:
        raise ValueError("need 20 random bytes")
    return PREFIX + "".join(ALPHABET[b & 31] for b in random_bytes[:CODE_LEN])


def is_valid_code(text: str) -> bool:
    return bool(_CODE.match(text))


def qr_payload(code: str) -> str:
    return code


def parse_payload(text: str) -> str | None:
    """Canonical code from scanner output (trims whitespace, any case); None when it is not one of ours."""
    t = text.strip().upper()
    return t if is_valid_code(t) else None


@dataclass(frozen=True)
class ScanDecision:
    result: ScanResult
    write: bool  # the caller must store `present`
    previous: str | None  # the mark that was overwritten, if any


def scan_decision(
    *,
    code_text: str,
    known: bool,
    lesson_status: str,
    in_roster: bool,
    existing: str | None,
) -> ScanDecision:
    """What a scan does. Order matters: a malformed code is reported before any lookup result is used."""
    if parse_payload(code_text) is None:
        return ScanDecision("bad_code", False, None)
    if not known:
        return ScanDecision("unknown_code", False, None)
    if lesson_status == "cancelled":
        return ScanDecision("lesson_cancelled", False, None)
    if not in_roster:
        return ScanDecision("not_in_group", False, None)
    if existing in ("present", "late"):
        return ScanDecision("already_present", False, existing)
    return ScanDecision("marked", True, existing)  # absent / excused / nothing yet


def qr_matrix(text: str) -> list[list[int]]:
    """Reference matrix (1 = dark) from reportlab's encoder, error correction M, smallest version that fits."""
    qr = qrencoder.QRCode(None, qrencoder.QRErrorCorrectLevel.M)
    qr.addData(text)
    qr.make()
    n = qr.getModuleCount()
    return [[1 if qr.isDark(r, c) else 0 for c in range(n)] for r in range(n)]
