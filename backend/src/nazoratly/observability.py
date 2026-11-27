"""Structured logging (structlog), Sentry, OpenTelemetry. External exporters are enabled only when configured."""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog
from fastapi import FastAPI

from nazoratly import __version__
from nazoratly.config import Settings

_SENSITIVE = {
    "authorization",
    "password",
    "password_hash",
    "token",
    "refresh_token",
    "access_token",
    "cookie",
}


def _redact(_: Any, __: str, event: dict[str, Any]) -> dict[str, Any]:
    for k in list(event):
        if k.lower() in _SENSITIVE:
            event[k] = "[redacted]"
    return event


def quiet_http_client_logs() -> None:
    """Outbound request lines carry full URLs, and Bot API and relay URLs carry secrets: they are never logged."""
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


def configure_logging(settings: Settings) -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level, force=True)
    quiet_http_client_logs()
    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _redact,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer() if settings.log_json else structlog.dev.ConsoleRenderer(),
    ]
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )


def _no_http_breadcrumbs(crumb: Any, _hint: Any) -> Any:
    return None if crumb.get("type") == "http" or crumb.get("category") == "httplib" else crumb


def configure_sentry(settings: Settings) -> bool:
    if settings.sentry_dsn is None:
        return False
    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.sentry_dsn.get_secret_value(),
        environment=settings.env,
        release=f"{settings.service_name}@{__version__}",
        send_default_pii=False,  # students' personal data must never reach a third party
        traces_sample_rate=0.0,
        max_request_body_size="never",
        before_breadcrumb=_no_http_breadcrumbs,
    )
    return True


def configure_tracing(app: FastAPI, settings: Settings) -> bool:
    if not settings.otel_exporter_otlp_endpoint:
        return False
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(
        resource=Resource.create({"service.name": settings.service_name, "service.version": __version__})
    )
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(endpoint=f"{settings.otel_exporter_otlp_endpoint.rstrip('/')}/v1/traces")
        )
    )
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider, excluded_urls="health,ready")
    return True
