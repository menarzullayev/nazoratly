"""Application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from nazoratly import __version__, errors
from nazoratly.config import Settings, get_settings
from nazoratly.db import Database
from nazoratly.middleware import BodyLimitMiddleware, RateLimitMiddleware, RequestContextMiddleware
from nazoratly.observability import configure_logging, configure_sentry, configure_tracing
from nazoratly.routers import health, pay, relay, v1
from nazoratly.secrets_box import SecretsBox

log = structlog.get_logger()

DESCRIPTION = (
    "Backend API of nazoratly: education-center management (students, groups, attendance, payments/debt, teacher "
    "payroll) and the control plane for the clients' AI agents (agent clients, drafts, approvals). All ids are UUIDs; "
    "money is a decimal string in UZS."
)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)
    sentry_on = configure_sentry(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = Database(settings)
        await db.open()
        app.state.db = db
        log.info("startup", version=__version__, env=settings.env, sentry=sentry_on)
        try:
            yield
        finally:
            await db.close()
            log.info("shutdown")

    app = FastAPI(
        title="nazoratly API",
        version=__version__,
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url=None if settings.env == "prod" else "/docs",
        redoc_url=None,
        openapi_url=None if settings.env == "prod" else "/openapi.json",
    )
    app.state.settings = settings
    app.state.secrets_box = (
        SecretsBox(settings.secrets_key.get_secret_value()) if settings.secrets_key else None
    )
    errors.install(app)

    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_body_bytes)
    app.add_middleware(RateLimitMiddleware, settings=settings)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
            expose_headers=["X-Request-ID", "Idempotent-Replayed", "Retry-After"],
            max_age=600,
        )
    app.add_middleware(RequestContextMiddleware, settings=settings)

    app.include_router(health.router)
    app.include_router(v1.router)
    app.include_router(pay.callbacks)
    app.include_router(relay.router)
    configure_tracing(app, settings)
    return app
