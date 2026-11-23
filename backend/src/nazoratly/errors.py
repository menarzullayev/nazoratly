"""Uniform error model: {"error": {"code", "message", "details", "request_id"}} and DB-error translation."""

from __future__ import annotations

from typing import Any

import psycopg
import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg import errors as pgerr
from starlette.exceptions import HTTPException as StarletteHTTPException

log = structlog.get_logger()


class ApiError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}
        self.headers = headers or {}


class NotFound(ApiError):
    status_code, code = 404, "not_found"


class Unauthorized(ApiError):
    status_code, code = 401, "unauthorized"


class Forbidden(ApiError):
    status_code, code = 403, "forbidden"


class Conflict(ApiError):
    status_code, code = 409, "conflict"


class EnrollmentNotTrial(Conflict):
    code = "enrollment_not_trial"


class AlreadyAccepted(Conflict):
    code = "already_accepted"


class NotOpen(Conflict):
    code = "not_open"


class NothingOwed(Conflict):
    code = "nothing_owed"


class Unprocessable(ApiError):
    status_code, code = 422, "unprocessable"


class TooManyRequests(ApiError):
    status_code, code = 429, "rate_limited"


class Retryable(ApiError):
    status_code, code = 503, "retry"

    def __init__(self) -> None:
        super().__init__("Temporary conflict, please retry", headers={"Retry-After": "1"})


def body(
    code: str, message: str, request_id: str | None, details: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details or {}, "request_id": request_id}}


def translate_db_error(exc: psycopg.Error) -> ApiError | None:
    """Map integrity errors raised by constraints/triggers to client errors. Unknown errors -> None (HTTP 500)."""
    d = exc.diag
    constraint = d.constraint_name
    detail = {"constraint": constraint} if constraint else {}
    if isinstance(exc, pgerr.UniqueViolation):
        return Conflict("A record with the same unique value already exists", details=detail)
    if isinstance(exc, pgerr.ForeignKeyViolation):
        return Unprocessable(
            d.message_primary or "Referenced record is missing or belongs elsewhere", details=detail
        )
    if isinstance(exc, pgerr.CheckViolation):
        return Unprocessable(d.message_primary or "Value violates a business rule", details=detail)
    if isinstance(exc, pgerr.NotNullViolation):
        return Unprocessable("A required value is missing", details={"column": d.column_name})
    if isinstance(exc, pgerr.RestrictViolation):
        return Conflict(d.message_primary or "Operation is not allowed")
    if isinstance(exc, pgerr.InsufficientPrivilege):
        return Forbidden("Operation is not permitted")
    if isinstance(exc, pgerr.SerializationFailure | pgerr.DeadlockDetected):
        return Retryable()
    if isinstance(
        exc, pgerr.InvalidTextRepresentation | pgerr.NumericValueOutOfRange | pgerr.DatetimeFieldOverflow
    ):
        return Unprocessable("A value is out of range or malformed")
    return None


def install(app: FastAPI) -> None:
    def rid(request: Request) -> str | None:
        value = getattr(request.state, "request_id", None)
        return value if isinstance(value, str) else None

    @app.exception_handler(ApiError)
    async def _api(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            body(exc.code, exc.message, rid(request), exc.details),
            status_code=exc.status_code,
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        errs = [{"loc": [str(x) for x in e["loc"]], "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        return JSONResponse(
            body("validation_error", "Request validation failed", rid(request), {"errors": errs}),
            status_code=422,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return JSONResponse(
            body(code, str(exc.detail), rid(request)),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(psycopg.Error)
    async def _db(request: Request, exc: psycopg.Error) -> JSONResponse:
        api = translate_db_error(exc)
        if api is None:
            log.error("db_error_unhandled", sqlstate=exc.sqlstate, error=str(exc))
            return JSONResponse(
                body("internal_error", "Internal server error", rid(request)), status_code=500
            )
        return JSONResponse(
            body(api.code, api.message, rid(request), api.details),
            status_code=api.status_code,
            headers=api.headers,
        )
