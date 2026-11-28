"""The staff panel's sessions: the same sign-in, rotation and logout as `/v1/auth/*`, but the refresh token travels only
in an HttpOnly cookie (`web_cookie`) and never appears in a response body. All four routes require the panel's `Origin`
(login and registration too: otherwise another site could sign a browser into an account it controls). The JSON routes
never read the cookie."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, Response

from nazoratly.config import Settings
from nazoratly.deps import DB, Cfg
from nazoratly.errors import Unauthorized
from nazoratly.routers.auth import (
    LoginIn,
    OrgRef,
    RegisterIn,
    SessionOver,
    SignedIn,
    org_ref,
    password_sign_in,
    register_account,
    revoke_family_of,
    rotate_session,
)
from nazoratly.schemas import Message, Model, Out
from nazoratly.web_cookie import (
    clear_session_cookie,
    clearing_header,
    read_session_cookie,
    require_panel_origin,
    set_session_cookie,
)


def _same_origin(request: Request, settings: Cfg) -> None:
    require_panel_origin(request, settings)


router = APIRouter(prefix="/v1/auth/web", tags=["auth"], dependencies=[Depends(_same_origin)])


class WebRefreshIn(Model):
    org_id: uuid.UUID | None = None


class WebUser(Out):
    id: uuid.UUID
    full_name: str
    email: str | None
    phone: str | None


class WebSessionOut(Out):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 - OAuth token type, not a secret
    expires_in: int
    user: WebUser
    org: OrgRef | None
    organizations: list[OrgRef]


def _signed_in(response: Response, settings: Settings, signed: SignedIn) -> WebSessionOut:
    access, ttl = signed.access_token(settings)
    set_session_cookie(response, settings, signed.refresh)
    user = signed.user
    return WebSessionOut(
        access_token=access,
        expires_in=ttl,
        user=WebUser(
            id=user["public_id"], full_name=user["full_name"], email=user["email"], phone=user["phone"]
        ),
        org=org_ref(signed.org) if signed.org else None,
        organizations=[org_ref(r) for r in signed.rows],
    )


@router.post("/login", response_model=WebSessionOut, summary="Panel: log in (refresh token in a cookie)")
async def web_login(
    body: LoginIn, request: Request, response: Response, db: DB, settings: Cfg
) -> WebSessionOut:
    return _signed_in(response, settings, await password_sign_in(body, request, db, settings))


@router.post(
    "/register",
    response_model=WebSessionOut,
    status_code=201,
    summary="Panel: create a center and its owner account",
)
async def web_register(
    body: RegisterIn, request: Request, response: Response, db: DB, settings: Cfg
) -> WebSessionOut:
    return _signed_in(response, settings, await register_account(body, request, db, settings))


@router.post("/refresh", response_model=WebSessionOut, summary="Panel: rotate the cookie session")
async def web_refresh(
    body: WebRefreshIn, request: Request, response: Response, db: DB, settings: Cfg
) -> WebSessionOut:
    token = read_session_cookie(request)
    if token is None:
        raise Unauthorized("Not signed in")
    try:
        signed = await rotate_session(token, body.org_id, request, db, settings)
    except SessionOver as exc:
        exc.headers = {**exc.headers, **clearing_header()}
        raise
    return _signed_in(response, settings, signed)


@router.post("/logout", response_model=Message, summary="Panel: end the cookie session")
async def web_logout(request: Request, response: Response, db: DB) -> Message:
    token = read_session_cookie(request)
    if token is not None:
        await revoke_family_of(db, token)
    clear_session_cookie(response)
    return Message(message="logged out")
