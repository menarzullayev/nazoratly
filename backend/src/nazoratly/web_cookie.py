"""The staff panel's session cookie: where the refresh token lives in a browser.

`__Secure-nz_refresh`: HttpOnly, Secure, SameSite=Strict, Path=/v1/auth/web, no Domain, lifetime = the refresh token's.
`SameSite=Strict` does not stop other sites of the same registrable domain (they are "same-site" to a browser), so every
route that reads or writes the cookie also demands an `Origin` header equal to the panel's own origin. A sibling
subdomain could also *plant* a cookie of the same name; a request carrying the name more than once is refused."""

from __future__ import annotations

from typing import Final

from starlette.requests import Request
from starlette.responses import Response

from nazoratly.config import Settings
from nazoratly.errors import Forbidden, Unauthorized

COOKIE_NAME: Final = "__Secure-nz_refresh"
COOKIE_PATH: Final = "/v1/auth/web"


def require_panel_origin(request: Request, settings: Settings) -> None:
    """403 unless `Origin` is exactly the configured panel origin. Without a configured origin the routes are closed."""
    expected = settings.panel_origin
    if expected is None or request.headers.getlist("origin") != [expected]:
        raise Forbidden("This request did not come from the staff panel")


def read_session_cookie(request: Request) -> str | None:
    """The refresh token in the cookie, or None. Parsed by hand: a parsed cookie dict would silently keep one of two
    cookies with the same name."""
    values = [
        value.strip()
        for header in request.headers.getlist("cookie")
        for name, sep, value in (part.partition("=") for part in header.split(";"))
        if sep and name.strip() == COOKIE_NAME
    ]
    if len(values) > 1:
        raise Unauthorized("Ambiguous session cookie")
    if not values or not 20 <= len(values[0]) <= 200:
        return None
    return values[0]


def set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.refresh_token_ttl_s,
        path=COOKIE_PATH,
        secure=True,
        httponly=True,
        samesite="strict",
    )


def clear_session_cookie(response: Response) -> None:
    response.set_cookie(
        COOKIE_NAME, "", max_age=0, path=COOKIE_PATH, secure=True, httponly=True, samesite="strict"
    )


def clearing_header() -> dict[str, str]:
    """The same deletion as a header dict, for error responses."""
    carrier = Response()
    clear_session_cookie(carrier)
    return {"set-cookie": carrier.headers["set-cookie"]}
