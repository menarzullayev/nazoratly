"""Receipt and invoice documents: the frozen snapshot, the PDF and the Telegram text.

A document is the center's INTERNAL document (no fiscal claim: the center has no YaTT/MChJ yet). It carries the center
name and its own requisites, a number from rules/documents.py and the footer text that says so. The snapshot is what
was true when the document was issued; the PDF is rendered from it once and stored, so a document never changes.
"""

from __future__ import annotations

import html
from datetime import date
from decimal import Decimal
from functools import cache
from io import BytesIO
from pathlib import Path
from typing import Literal

from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from nazoratly.rules.documents import FOOTER, INVOICE_TITLE, RECEIPT_TITLE, format_som

FONT_DIR = Path(__file__).parent / "assets" / "fonts"
REGULAR, BOLD = "DejaVuSans", "DejaVuSans-Bold"

KIND_LABEL = {
    "tuition": "O'qish haqi",
    "registration": "Ro'yxatdan o'tish",
    "materials": "Materiallar",
    "other": "Boshqa to'lov",
}
METHOD_LABEL = {
    "cash": "Naqd",
    "card": "Karta",
    "bank_transfer": "Bank o'tkazmasi",
    "payme": "Payme",
    "click": "Click",
    "other": "Boshqa",
}


class Line(BaseModel):
    label: str
    due_date: date | None = None
    amount: Decimal
    overdue: bool = False


class Snapshot(BaseModel):
    """Everything printed on the document; stored as JSON next to the PDF."""

    kind: Literal["receipt", "invoice"]
    number: str
    issued_on: date
    center_name: str
    requisites: str | None
    student_name: str
    payer_name: str | None = None
    method: str | None = None  # METHOD_LABEL value (receipt)
    paid_on: date | None = None  # receipt
    lines: list[Line]
    total: Decimal
    debt_after: Decimal | None = None  # receipt: what the student still owes after this payment


@cache
def _register_fonts() -> None:
    pdfmetrics.registerFont(TTFont(REGULAR, str(FONT_DIR / "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont(BOLD, str(FONT_DIR / "DejaVuSans-Bold.ttf")))
    pdfmetrics.registerFontFamily(REGULAR, normal=REGULAR, bold=BOLD, italic=REGULAR, boldItalic=BOLD)


def _p(text: str) -> str:
    """Escape text for a reportlab Paragraph (it parses a small XML dialect)."""
    return html.escape(text, quote=False).replace("\n", "<br/>")


def _title(snap: Snapshot) -> str:
    return RECEIPT_TITLE if snap.kind == "receipt" else INVOICE_TITLE


def _ddmmyyyy(d: date) -> str:
    return f"{d.day:02d}.{d.month:02d}.{d.year}"


def render_pdf(snap: Snapshot) -> bytes:
    _register_fonts()
    base = ParagraphStyle("base", fontName=REGULAR, fontSize=10, leading=14)
    small = ParagraphStyle(
        "small", parent=base, fontSize=8.5, leading=12, textColor=colors.HexColor("#555555")
    )
    center = ParagraphStyle("center", parent=base, fontName=BOLD, fontSize=15, leading=19)
    title = ParagraphStyle("title", parent=base, fontName=BOLD, fontSize=17, leading=22, spaceBefore=8)
    right = ParagraphStyle("right", parent=base, alignment=TA_RIGHT)
    right_bold = ParagraphStyle("rightb", parent=right, fontName=BOLD)
    bold = ParagraphStyle("bold", parent=base, fontName=BOLD)

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"{_title(snap)} {snap.number}",
        author=snap.center_name,
        subject=_title(snap),
        invariant=True,  # same input -> same bytes
    )
    story: list[object] = [Paragraph(_p(snap.center_name), center)]
    if snap.requisites:
        story.append(Paragraph(_p(snap.requisites), small))
    story.append(Paragraph(_p(f"{_title(snap)} № {snap.number}"), title))
    story.append(Paragraph(_p(f"Sana: {_ddmmyyyy(snap.issued_on)}"), base))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(f"O'quvchi: <b>{_p(snap.student_name)}</b>", base))
    if snap.payer_name:
        story.append(Paragraph(f"To'lovchi: {_p(snap.payer_name)}", base))
    if snap.method and snap.paid_on:
        story.append(Paragraph(_p(f"To'lov usuli: {snap.method}, sana: {_ddmmyyyy(snap.paid_on)}"), base))
    story.append(Spacer(1, 5 * mm))

    with_due = snap.kind == "invoice"
    head = ["№", "Nomi"] + (["Muddat"] if with_due else []) + ["Summa, so'm"]
    rows: list[list[Paragraph]] = [
        [Paragraph(_p(h), bold if h != "Summa, so'm" else right_bold) for h in head]
    ]
    for i, line in enumerate(snap.lines, start=1):
        cells = [Paragraph(str(i), base), Paragraph(_p(line.label), base)]
        if with_due:
            due = _ddmmyyyy(line.due_date) if line.due_date else ""
            cells.append(Paragraph(_p(due + (" (muddati o'tgan)" if line.overdue else "")), base))
        cells.append(Paragraph(_p(format_som(line.amount)), right))
        rows.append(cells)
    widths = [10 * mm, 80 * mm, 45 * mm, 35 * mm] if with_due else [10 * mm, 115 * mm, 45 * mm]
    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.black),
                ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#bbbbbb")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(table)
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(f"Jami: <b>{_p(format_som(snap.total))} so'm</b>", right))
    if snap.debt_after is not None and snap.debt_after > 0:
        story.append(Paragraph(_p(f"Qolgan qarz: {format_som(snap.debt_after)} so'm"), right))
    story.append(Spacer(1, 12 * mm))
    story.append(Paragraph(_p(FOOTER), small))
    doc.build(story)
    return buf.getvalue()


def delivery_text(snap: Snapshot) -> tuple[str, str]:
    """(plain text, rich HTML) for the Telegram message that accompanies the PDF."""
    what = "kvitansiya" if snap.kind == "receipt" else "to'lov hisobi"
    amount = f"{format_som(snap.total)} so'm"
    facts = [f"O'quvchi: {snap.student_name}", f"Summa: {amount}"]
    if snap.kind == "receipt" and snap.method:
        facts.append(f"To'lov usuli: {snap.method}")
    if snap.debt_after is not None and snap.debt_after > 0:
        facts.append(f"Qolgan qarz: {format_som(snap.debt_after)} so'm")
    if snap.kind == "invoice":
        due = [line.due_date for line in snap.lines if line.due_date]
        if due:
            facts.append(f"Eng yaqin muddat: {_ddmmyyyy(min(due))}")
    head = f"{snap.center_name}: {what} {snap.number}"
    plain = "\n".join([head, *facts, "PDF hujjat ilova qilingan.", FOOTER])
    rich = (
        f"<b>{html.escape(head, quote=False)}</b><br>"
        + "<br>".join(html.escape(f, quote=False) for f in facts)
        + f"<br><br>PDF hujjat ilova qilingan.<br><i>{html.escape(FOOTER, quote=False)}</i>"
    )
    return plain, rich
