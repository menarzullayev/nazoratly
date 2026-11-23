"""Interactive import (students, groups, leads): preview with automatic column mapping, per-row validation and duplicate
detection; commit writes all clean rows in ONE transaction (or nothing). The page for it is served at /ui/import."""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import Field

from nazoratly.deps import DB, Principal, require
from nazoratly.errors import Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.imports import Analysis, analyse, write_rows
from nazoratly.rules import imports as R
from nazoratly.schemas import Model, Out

router = APIRouter(prefix="/v1", tags=["import"], route_class=IdempotentRoute)

Entity = Literal["students", "groups", "leads"]
PREVIEW_ROWS = 500  # rows returned in detail by the preview; the counts always cover the whole file


class ImportIn(Model):
    text: Annotated[str, Field(max_length=950_000, description="CSV / TSV text, first line = header")]
    has_header: bool = True
    mapping: dict[str, int | None] | None = Field(
        default=None, description="field -> column index (0-based); omitted fields keep the automatic guess"
    )


class CommitIn(ImportIn):
    on_error: Literal["skip", "abort"] = Field(
        default="skip", description="abort: write nothing when any row has an error"
    )
    duplicates: Literal["skip", "create"] = "skip"


class RowErrorOut(Out):
    field: str
    code: str
    message: str


class DuplicateOut(Out):
    kind: Literal["file", "existing"]
    of_row: int | None


class RowOut(Out):
    row: int
    status: Literal["ok", "error", "duplicate"]
    values: dict[str, Any]
    errors: list[RowErrorOut]
    duplicate: DuplicateOut | None


class SummaryOut(Out):
    total: int
    ok: int
    errors: int
    duplicates: int


class PreviewOut(Out):
    entity: Entity
    columns: list[str]
    mapping: dict[str, int | None]
    fields: list[str]
    required: list[str]
    required_missing: list[str]
    summary: SummaryOut
    rows: list[RowOut]
    rows_truncated: bool


class CommitOut(Out):
    entity: Entity
    created: dict[str, int]
    skipped_errors: int
    skipped_duplicates: int
    rows: list[dict[str, Any]]


def _preview(a: Analysis) -> PreviewOut:
    return PreviewOut(
        entity=a.entity,
        columns=a.columns,
        mapping=a.mapping,
        fields=R.FIELDS[a.entity],
        required=R.REQUIRED[a.entity],
        required_missing=a.required_missing,
        summary=SummaryOut(
            total=len(a.rows), ok=a.count("ok"), errors=a.count("error"), duplicates=a.count("duplicate")
        ),
        rows=[
            RowOut(
                row=r.row,
                status=r.status,
                values=r.values,
                errors=[RowErrorOut(**e) for e in r.errors],
                duplicate=DuplicateOut(**r.duplicate) if r.duplicate else None,
            )
            for r in a.rows[:PREVIEW_ROWS]
        ],
        rows_truncated=len(a.rows) > PREVIEW_ROWS,
    )


@router.post(
    "/imports/{entity}/preview",
    response_model=PreviewOut,
    summary="Check an uploaded CSV/TSV: column mapping, per-row errors, duplicates (writes nothing)",
)
async def preview(
    entity: Entity,
    body: ImportIn,
    p: Annotated[Principal, Depends(require("students:write", "academics:write"))],
    db: DB,
) -> PreviewOut:
    async with db.tx(p.session()) as conn:
        analysis = await analyse(
            conn,
            entity=entity,
            text=body.text,
            has_header=body.has_header,
            mapping=body.mapping,
            today=date.today(),
        )
    return _preview(analysis)


@router.post(
    "/imports/{entity}/commit",
    response_model=CommitOut,
    status_code=201,
    summary="Write the clean rows of the file in one transaction (all or nothing)",
)
async def commit(
    entity: Entity,
    body: CommitIn,
    p: Annotated[Principal, Depends(require("students:write", "academics:write"))],
    db: DB,
) -> CommitOut:
    """The file is analysed again here (the preview is never trusted). Rows with errors are skipped, or with
    `on_error = abort` nothing is written at all. Duplicates are skipped unless `duplicates = create`. Any failure while
    writing rolls the whole import back."""
    async with db.tx(p.session()) as conn:
        today = date.today()
        analysis = await analyse(
            conn,
            entity=entity,
            text=body.text,
            has_header=body.has_header,
            mapping=body.mapping,
            today=today,
            duplicates_create=body.duplicates == "create",
        )
        if analysis.required_missing:
            raise Unprocessable(
                "Required columns are not mapped", details={"required_missing": analysis.required_missing}
            )
        if body.on_error == "abort" and analysis.count("error"):
            raise Unprocessable(
                "The file has rows with errors; nothing was written",
                details={
                    "errors": [
                        {"row": r.row, "errors": r.errors} for r in analysis.rows if r.status == "error"
                    ][:50]
                },
            )
        written = await write_rows(
            conn,
            org_id=p.org_id,
            user_id=p.user_id,
            a=analysis,
            duplicates_create=body.duplicates == "create",
            today=today,
        )
    return CommitOut(
        entity=entity,
        created=written["created"],
        skipped_errors=analysis.count("error"),
        skipped_duplicates=0 if body.duplicates == "create" else analysis.count("duplicate"),
        rows=written["rows"],
    )
