"""Student QR codes and the printable card (PDF).

The QR carries only the random code (`rules/qr.py`), never a name or a phone number: a lost card reveals nothing and is
replaced by rotating the code. Cards are drawn with the same module matrix the golden tests pin (reportlab's encoder)."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

from nazoratly.db import Conn, execute, fetch_one
from nazoratly.documents import BOLD, REGULAR, _register_fonts
from nazoratly.rules import qr as Q

COLS, ROWS = 2, 4  # cards per A4 page
CARD_W, CARD_H = 90 * mm, 62 * mm
HINT = ("Darsga kirishda", "shu kodni skanerlang")


@dataclass(frozen=True)
class Card:
    student_name: str
    code: str
    center_name: str
    group_name: str | None = None


async def ensure_code(conn: Conn, student_id: int, *, rotate: bool = False) -> tuple[str, bool]:
    """The student's code, created on first use; `rotate` replaces it (the old card stops working at once).
    Returns (code, created_or_rotated)."""
    row = await fetch_one(
        conn, "SELECT qr_code FROM students WHERE id = %s AND deleted_at IS NULL FOR UPDATE", (student_id,)
    )
    assert row is not None
    if row["qr_code"] is not None and not rotate:
        return str(row["qr_code"]), False
    for _ in range(5):  # a clash with another student's code is practically impossible; retry anyway
        code = Q.new_code(secrets.token_bytes(Q.CODE_LEN))
        if await fetch_one(conn, "SELECT 1 FROM students WHERE qr_code = %s", (code,)) is None:
            await execute(
                conn,
                "UPDATE students SET qr_code = %s, qr_issued_at = now() WHERE id = %s",
                (code, student_id),
            )
            return code, True
    raise RuntimeError("could not allocate a unique QR code")  # pragma: no cover


def _draw_qr(c: canvas.Canvas, code: str, x: float, y: float, size: float) -> None:
    m = Q.qr_matrix(Q.qr_payload(code))
    n = len(m)
    quiet = 2  # modules; the card's white background provides the rest of the quiet zone
    cell = size / (n + 2 * quiet)
    c.setFillColor(colors.white)
    c.rect(x, y, size, size, stroke=0, fill=1)
    c.setFillColor(colors.black)
    for r, row in enumerate(m):
        for col, dark in enumerate(row):
            if dark:
                c.rect(
                    x + (col + quiet) * cell,
                    y + size - (r + quiet + 1) * cell,
                    cell + 0.2,
                    cell + 0.2,
                    stroke=0,
                    fill=1,
                )


def _fit(c: canvas.Canvas, text: str, font: str, size: float, width: float) -> float:
    while size > 6 and c.stringWidth(text, font, size) > width:
        size -= 0.5
    return size


def _draw_card(c: canvas.Canvas, card: Card, x: float, y: float) -> None:
    c.setStrokeColor(colors.HexColor("#999999"))
    c.setDash(2, 2)
    c.rect(x, y, CARD_W, CARD_H, stroke=1, fill=0)
    c.setDash()
    pad = 5 * mm
    qr_size = 40 * mm
    _draw_qr(c, card.code, x + pad, y + (CARD_H - qr_size) / 2 - 2 * mm, qr_size)
    tx = x + pad + qr_size + 4 * mm
    tw = CARD_W - (tx - x) - pad
    c.setFillColor(colors.black)
    c.setFont(BOLD, _fit(c, card.center_name, BOLD, 10, tw))
    c.drawString(tx, y + CARD_H - 12 * mm, card.center_name)
    size = _fit(c, card.student_name, BOLD, 13, tw)
    c.setFont(BOLD, size)
    c.drawString(tx, y + CARD_H - 24 * mm, card.student_name)
    if card.group_name:
        c.setFont(REGULAR, _fit(c, card.group_name, REGULAR, 9, tw))
        c.setFillColor(colors.HexColor("#444444"))
        c.drawString(tx, y + CARD_H - 30 * mm, card.group_name)
    c.setFillColor(colors.HexColor("#444444"))
    c.setFont(REGULAR, 7.5)
    c.drawString(tx, y + 16 * mm, HINT[0])
    c.drawString(tx, y + 12.5 * mm, HINT[1])
    c.setFont(REGULAR, 6.5)
    c.setFillColor(colors.HexColor("#777777"))
    c.drawString(x + pad, y + 5 * mm, card.code)


def render_cards_pdf(cards: list[Card], *, title: str) -> bytes:
    """One card per student, eight to an A4 page (two columns), dashed cut lines. Same input, same bytes."""
    _register_fonts()
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=True)
    c.setTitle(title)
    page_w, page_h = A4
    left = (page_w - COLS * CARD_W) / 2
    top = page_h - (page_h - ROWS * CARD_H) / 2
    per_page = COLS * ROWS
    for i, card in enumerate(cards):
        slot = i % per_page
        if i and slot == 0:
            c.showPage()
        col, row = slot % COLS, slot // COLS
        _draw_card(c, card, left + col * CARD_W, top - (row + 1) * CARD_H)
    if not cards:
        c.setFont(REGULAR, 12)
        c.drawString(20 * mm, page_h - 30 * mm, "Kartalar yo'q")
    c.showPage()
    c.save()
    return buf.getvalue()


def card_filename(student_name: str) -> str:
    base = (
        "".join(ch if ch.isascii() and ch.isalnum() else "-" for ch in student_name).strip("-")[:40]
        or "student"
    )
    return f"qr-{base}.pdf"
