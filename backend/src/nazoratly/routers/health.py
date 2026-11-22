"""Liveness and readiness probes (no authentication, excluded from rate limiting and access logs)."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from nazoratly import __version__
from nazoratly.deps import DB

router = APIRouter(tags=["ops"])


class Health(BaseModel):
    status: str
    version: str


@router.get("/health", response_model=Health, summary="Liveness: the process is up")
async def health() -> Health:
    return Health(status="ok", version=__version__)


@router.get(
    "/ready",
    response_model=Health,
    summary="Readiness: the database answers",
    responses={503: {"model": Health}},
)
async def ready(db: DB) -> Health | JSONResponse:
    if await db.ping():
        return Health(status="ready", version=__version__)
    return JSONResponse({"status": "database_unavailable", "version": __version__}, status_code=503)
