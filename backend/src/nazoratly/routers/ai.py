"""AI assistant: weekly owner summary, debt follow-up advice, churn-risk list (suggestions only).

POST generates and stores a report; the text comes from the AI worker when the center allows it and the daily limit is not
reached, otherwise from the rule-based builders (`source` and `fallback_reason` say which). Nothing here sends anything to
a guardian, student or lead. The center's switches live in /v1/settings (`ai_enabled`, `ai_sees_names`, `ai_daily_limit`)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request

from nazoratly.accounting import org_today
from nazoratly.ai_reports import Kind, finish, get_report, list_reports, prepare, store
from nazoratly.ai_transport import AiTransport
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import NotFound
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.settings import load_settings
from nazoratly.schemas import Model, Out

router = APIRouter(prefix="/v1", tags=["ai"], route_class=IdempotentRoute)


class ReportRequest(Model):
    kind: Literal["weekly_summary", "debt_followup", "churn_risk"]


class AiReportOut(Out):
    id: uuid.UUID
    kind: Literal["weekly_summary", "debt_followup", "churn_risk"]
    period_end: date
    source: Literal["ai", "rules"]
    model: str | None
    fallback_reason: (
        Literal[
            "ai_disabled",
            "ai_not_configured",
            "ai_limit_reached",
            "ai_unavailable",
            "ai_bad_output",
            "nothing_to_report",
        ]
        | None
    )
    content: str
    data: dict[str, Any]
    anonymized: bool
    created_at: datetime


def _out(row: dict[str, Any]) -> AiReportOut:
    return AiReportOut.model_validate({**row, "id": row["public_id"]})


@router.post(
    "/ai/reports",
    response_model=AiReportOut,
    status_code=201,
    summary="Generate a suggestion report (weekly summary, debt follow-up, churn risk); nothing is sent",
)
async def create_report(
    body: ReportRequest, request: Request, p: Annotated[Principal, Depends(require("reports:read"))], db: DB
) -> AiReportOut:
    transport: AiTransport | None = getattr(request.app.state, "ai_transport", None)
    kind: Kind = body.kind
    async with db.tx(p.session()) as conn:  # facts first; no connection is held while the AI works
        today = await org_today(conn)
        cfg = await load_settings(conn, p.org_id)
        prep = await prepare(conn, kind=kind, today=today, cfg=cfg, transport=transport)
    fin = await finish(prep, transport)
    async with db.tx(p.session()) as conn:
        return _out(await store(conn, fin, user_id=p.user_id, org_id=p.org_id))


@router.get("/ai/reports", response_model=list[AiReportOut], summary="Latest generated reports, newest first")
async def reports(
    p: Annotated[Principal, Depends(require("reports:read"))],
    db: DB,
    kind: Literal["weekly_summary", "debt_followup", "churn_risk"] | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[AiReportOut]:
    async with db.tx(p.session()) as conn:
        return [_out(r) for r in await list_reports(conn, kind=kind, limit=limit)]


@router.get("/ai/reports/{report_id}", response_model=AiReportOut)
async def report(
    report_id: uuid.UUID, p: Annotated[Principal, Depends(require("reports:read"))], db: DB
) -> AiReportOut:
    async with db.tx(p.session()) as conn:
        row = await get_report(conn, report_id)
    if row is None:
        raise NotFound("report not found")
    return _out(row)
