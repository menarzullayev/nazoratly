"""FastAPI dependencies: authentication, tenant principal, RBAC, pagination."""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from nazoratly.config import Settings
from nazoratly.db import Database, Session, fetch_one
from nazoratly.errors import Forbidden, Unauthorized
from nazoratly.permissions import permissions_for
from nazoratly.security import decode_access_token

_bearer = HTTPBearer(auto_error=False, description="Access token from POST /v1/auth/login")


def get_db(request: Request) -> Database:
    db: Database = request.app.state.db
    return db


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def request_id_of(request: Request) -> str:
    return str(getattr(request.state, "request_id", ""))


DB = Annotated[Database, Depends(get_db)]
Cfg = Annotated[Settings, Depends(get_settings_dep)]


@dataclass(frozen=True)
class AuthUser:
    """An authenticated user, possibly without a selected center."""

    user_id: int
    user_public_id: uuid.UUID
    org_id: int | None
    request_id: str


@dataclass(frozen=True)
class Principal:
    """An authenticated staff member acting inside one center."""

    user_id: int
    user_public_id: uuid.UUID
    org_id: int
    role: str
    branch_id: int | None
    permissions: frozenset[str]
    request_id: str

    def session(self) -> Session:
        return Session(user_id=self.user_id, org_id=self.org_id, request_id=self.request_id)

    def can(self, permission: str) -> bool:
        return permission in self.permissions


async def current_user(
    request: Request,
    db: DB,
    settings: Cfg,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthUser:
    if creds is None or creds.scheme.lower() != "bearer":
        raise Unauthorized("Missing bearer token", headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = decode_access_token(settings, creds.credentials)
    except Unauthorized as e:
        e.headers = {"WWW-Authenticate": "Bearer"}
        raise
    rid = request_id_of(request)
    async with db.tx(Session(user_id=claims.user_id, org_id=None, request_id=rid)) as conn:
        row = await fetch_one(
            conn,
            "SELECT status FROM users WHERE id = %s AND public_id = %s",
            (claims.user_id, claims.user_public_id),
        )
    if row is None or row["status"] != "active":
        raise Unauthorized("Account is not active")
    return AuthUser(claims.user_id, claims.user_public_id, claims.org_id, rid)


async def principal(user: Annotated[AuthUser, Depends(current_user)], db: DB) -> Principal:
    if user.org_id is None:
        raise Forbidden("Select a center first (POST /v1/auth/switch)")
    async with db.tx(Session(user_id=user.user_id, org_id=user.org_id, request_id=user.request_id)) as conn:
        # RLS limits memberships to the token's center; a revoked/suspended role loses access immediately.
        m = await fetch_one(
            conn,
            "SELECT m.role, m.branch_id, m.status, o.status AS org_status FROM memberships m "
            "JOIN organizations o ON o.id = m.org_id WHERE m.user_id = %s",
            (user.user_id,),
        )
    if m is None or m["status"] != "active":
        raise Forbidden("No active membership in this center")
    if m["org_status"] != "active":
        raise Forbidden("Center is not active")
    return Principal(
        user_id=user.user_id,
        user_public_id=user.user_public_id,
        org_id=user.org_id,
        role=m["role"],
        branch_id=m["branch_id"],
        permissions=permissions_for(m["role"]),
        request_id=user.request_id,
    )


def require(*needed: str) -> Callable[..., Awaitable[Principal]]:
    """Dependency factory: the caller must hold ALL listed permissions."""

    async def _dep(p: Annotated[Principal, Depends(principal)]) -> Principal:
        missing = [n for n in needed if n not in p.permissions]
        if missing:
            raise Forbidden("Your role does not allow this action", details={"required": missing})
        return p

    return _dep


@dataclass(frozen=True)
class PageParams:
    limit: int
    offset: int


def page_params(
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
) -> PageParams:
    return PageParams(limit, offset)


Paging = Annotated[PageParams, Depends(page_params)]
