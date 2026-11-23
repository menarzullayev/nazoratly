"""Document numbering and wording shared by both products. Pure; mirrored in sheets/src/domain/documents.ts and
checked against tests/golden/documents.json."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

DocumentKind = Literal["receipt", "invoice"]

# The documents are the center's internal documents: no fiscal claim (no YaTT/MChJ yet).
FOOTER = "Ichki hujjat. Fiskal chek yoki soliq hisob-fakturasi emas."
RECEIPT_TITLE = "KVITANSIYA"
INVOICE_TITLE = "TO'LOV HISOBI"

_PREFIX: dict[DocumentKind, str] = {"receipt": "KV", "invoice": "TH"}


def document_number(kind: DocumentKind, year: int, serial: int) -> str:
    return f"{_PREFIX[kind]}-{year}-{serial:06d}"


def format_som(amount: Decimal) -> str:
    """Whole so'm, rounded half up, thousands separated by a space."""
    whole = int(amount.quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return f"{whole:,}".replace(",", " ")
