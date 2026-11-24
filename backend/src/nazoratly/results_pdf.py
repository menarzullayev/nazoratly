"""Progress-report and certificate PDFs. Rendered once from a frozen snapshot (same input -> same bytes); fonts are the
bundled DejaVu family, so Cyrillic and Uzbek apostrophes print correctly (see documents.py)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from io import BytesIO

from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from nazoratly.documents import BOLD, REGULAR, _ddmmyyyy, _p, _register_fonts
from nazoratly.rules.results import CERTIFICATE_TITLE, REPORT_TITLE


class ReportLesson(BaseModel):
    lesson_date: date
    grade: int | None = None
    note: str | None = None


class ReportExam(BaseModel):
    title: str
    held_on: date
    score: Decimal
    max_score: Decimal
    percent: int


class ReportSnapshot(BaseModel):
    """Everything printed on a progress report; stored as JSON next to the PDF."""

    center_name: str
    requisites: str | None = None
    student_name: str
    group_name: str
    course_name: str
    teacher_name: str | None = None
    period_month: date
    month_label: str
    present: int
    late: int
    absent: int
    excused: int
    attendance_percent: int | None
    average_grade: str | None
    month_grade: int | None = None
    month_note: str | None = None
    lessons: list[ReportLesson]
    exams: list[ReportExam]
    generated_on: date


class CertificateSnapshot(BaseModel):
    center_name: str
    requisites: str | None = None
    student_name: str
    course_name: str
    group_name: str
    started_on: date
    completed_on: date
    issued_on: date
    number: str
    code: str


def _num(d: Decimal) -> str:
    """12.50 -> 12.5, 100.00 -> 100."""
    t = format(d.normalize(), "f")
    return t


def render_report_pdf(snap: ReportSnapshot) -> bytes:
    _register_fonts()
    base = ParagraphStyle("base", fontName=REGULAR, fontSize=10, leading=14)
    small = ParagraphStyle(
        "small", parent=base, fontSize=8.5, leading=12, textColor=colors.HexColor("#555555")
    )
    center = ParagraphStyle("center", parent=base, fontName=BOLD, fontSize=15, leading=19)
    title = ParagraphStyle("title", parent=base, fontName=BOLD, fontSize=17, leading=22, spaceBefore=8)
    h2 = ParagraphStyle(
        "h2", parent=base, fontName=BOLD, fontSize=11.5, leading=16, spaceBefore=10, spaceAfter=3
    )
    bold = ParagraphStyle("bold", parent=base, fontName=BOLD)
    right = ParagraphStyle("right", parent=base, alignment=TA_RIGHT)

    def table(rows: list[list[Paragraph]], widths: list[float]) -> Table:
        t = Table(rows, colWidths=widths, repeatRows=1)
        t.setStyle(
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
        return t

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"{REPORT_TITLE} {snap.month_label}: {snap.student_name}",
        author=snap.center_name,
        subject=REPORT_TITLE,
        invariant=True,
    )
    story: list[object] = [Paragraph(_p(snap.center_name), center)]
    if snap.requisites:
        story.append(Paragraph(_p(snap.requisites), small))
    story.append(Paragraph(_p(f"{REPORT_TITLE}: {snap.month_label}"), title))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph(f"O'quvchi: <b>{_p(snap.student_name)}</b>", base))
    story.append(Paragraph(_p(f"Guruh: {snap.group_name} ({snap.course_name})"), base))
    if snap.teacher_name:
        story.append(Paragraph(_p(f"O'qituvchi: {snap.teacher_name}"), base))

    story.append(Paragraph("Davomat", h2))
    pct = f"{snap.attendance_percent}%" if snap.attendance_percent is not None else "ma'lumot yo'q"
    story.append(
        Paragraph(
            _p(
                f"Keldi: {snap.present}, kechikdi: {snap.late}, kelmadi: {snap.absent}, "
                f"sababli: {snap.excused}. Davomat: {pct}"
            ),
            base,
        )
    )

    story.append(Paragraph("Baho", h2))
    avg = snap.average_grade if snap.average_grade is not None else "baho qo'yilmagan"
    story.append(Paragraph(_p(f"O'rtacha baho (1-5): {avg}"), base))
    if snap.month_grade is not None:
        story.append(Paragraph(_p(f"Oy bahosi: {snap.month_grade}"), base))
    if snap.month_note:
        story.append(Paragraph(_p(f"O'qituvchi izohi: {snap.month_note}"), base))

    if snap.lessons:
        story.append(Paragraph("Darslar bo'yicha", h2))
        rows = [[Paragraph(h, bold) for h in ("Sana", "Baho", "Izoh")]]
        for ls in snap.lessons:
            rows.append(
                [
                    Paragraph(_p(_ddmmyyyy(ls.lesson_date)), base),
                    Paragraph(str(ls.grade) if ls.grade is not None else "", base),
                    Paragraph(_p(ls.note or ""), base),
                ]
            )
        story.append(table(rows, [28 * mm, 18 * mm, 124 * mm]))

    if snap.exams:
        story.append(Paragraph("Imtihon va testlar", h2))
        rows = [[Paragraph(h, bold) for h in ("Nomi", "Sana", "Ball", "Foiz")]]
        for ex in snap.exams:
            rows.append(
                [
                    Paragraph(_p(ex.title), base),
                    Paragraph(_p(_ddmmyyyy(ex.held_on)), base),
                    Paragraph(_p(f"{_num(ex.score)} / {_num(ex.max_score)}"), base),
                    Paragraph(f"{ex.percent}%", right),
                ]
            )
        story.append(table(rows, [75 * mm, 28 * mm, 40 * mm, 27 * mm]))

    story.append(Spacer(1, 10 * mm))
    story.append(Paragraph(_p(f"Hisobot sanasi: {_ddmmyyyy(snap.generated_on)}"), small))
    doc.build(story)
    return buf.getvalue()


def render_certificate_pdf(snap: CertificateSnapshot) -> bytes:
    _register_fonts()
    c = ParagraphStyle("c", fontName=REGULAR, fontSize=13, leading=20, alignment=TA_CENTER)
    centre = ParagraphStyle("centre", parent=c, fontName=BOLD, fontSize=18, leading=24)
    head = ParagraphStyle("head", parent=c, fontName=BOLD, fontSize=34, leading=42, spaceBefore=6)
    name = ParagraphStyle(
        "name", parent=c, fontName=BOLD, fontSize=24, leading=30, spaceBefore=10, spaceAfter=6
    )
    small = ParagraphStyle("small", parent=c, fontSize=9, leading=13, textColor=colors.HexColor("#555555"))

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=25 * mm,
        rightMargin=25 * mm,
        topMargin=20 * mm,
        bottomMargin=18 * mm,
        title=f"{CERTIFICATE_TITLE} {snap.number}",
        author=snap.center_name,
        subject=CERTIFICATE_TITLE,
        invariant=True,
    )

    def frame(canvas: object, _doc: object) -> None:
        canvas.saveState()  # type: ignore[attr-defined]
        canvas.setStrokeColor(colors.HexColor("#1a3c6e"))  # type: ignore[attr-defined]
        canvas.setLineWidth(2.2)  # type: ignore[attr-defined]
        w, h = landscape(A4)
        canvas.rect(10 * mm, 10 * mm, w - 20 * mm, h - 20 * mm)  # type: ignore[attr-defined]
        canvas.setLineWidth(0.6)  # type: ignore[attr-defined]
        canvas.rect(13 * mm, 13 * mm, w - 26 * mm, h - 26 * mm)  # type: ignore[attr-defined]
        canvas.restoreState()  # type: ignore[attr-defined]

    story: list[object] = [
        Paragraph(_p(snap.center_name), centre),
        Paragraph(CERTIFICATE_TITLE, head),
        Paragraph(_p(f"№ {snap.number}"), c),
        Spacer(1, 6 * mm),
        Paragraph("Ushbu sertifikat", c),
        Paragraph(_p(snap.student_name), name),
        Paragraph(_p(f"«{snap.course_name}» kursini muvaffaqiyatli tamomlagani uchun beriladi."), c),
        Paragraph(
            _p(
                f"Guruh: {snap.group_name}. O'qish davri: {_ddmmyyyy(snap.started_on)} - {_ddmmyyyy(snap.completed_on)}."
            ),
            c,
        ),
        Spacer(1, 8 * mm),
        Paragraph(_p(f"Berilgan sana: {_ddmmyyyy(snap.issued_on)}"), c),
        Spacer(1, 5 * mm),
        Paragraph(f"Tekshirish kodi: <b>{_p(snap.code)}</b>", c),
        Paragraph(
            "Sertifikat haqiqiyligini shu kod bilan markazdan yoki tekshirish xizmatida aniqlash mumkin.",
            small,
        ),
    ]
    if snap.requisites:
        story.append(Spacer(1, 3 * mm))
        story.append(Paragraph(_p(snap.requisites), small))
    doc.build(story, onFirstPage=frame, onLaterPages=frame)
    return buf.getvalue()
