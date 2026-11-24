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
from nazoratly.errors import Forbidden, NotFound, Unauthorized, Unprocessable
from nazoratly.permissions import permissions_for
from nazoratly.rules.branches import resolve_scope
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
    branch_id: (
        int | None
    )  # the branch of the membership: None = center-wide staff, set = restricted to that branch
    permissions: frozenset[str]
    request_id: str
    scope_branch_id: int | None = (
        None  # the branch this request works in (RLS scope): the membership's, or the X-Branch view
    )

    def session(self, *, unscoped: bool = False) -> Session:
        """The tenant session of this request. Restricted staff are always scoped to their branch; center-wide staff are
        scoped only when they narrowed the view with X-Branch. `unscoped=True` is for work on the whole center (ledger
        chain, branch administration) and is only for center-wide staff."""
        if unscoped:
            self.require_center_wide()
            return Session(user_id=self.user_id, org_id=self.org_id, request_id=self.request_id)
        return Session(
            user_id=self.user_id,
            org_id=self.org_id,
            request_id=self.request_id,
            branch_id=self.scope_branch_id,
        )

    @property
    def center_wide(self) -> bool:
        return self.branch_id is None

    def require_center_wide(self) -> None:
        if self.branch_id is not None:
            raise Forbidden("Only center-wide staff (not tied to one branch) can do this")

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


BRANCH_HEADER = "X-Branch"


async def principal(request: Request, user: Annotated[AuthUser, Depends(current_user)], db: DB) -> Principal:
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
        requested_raw = request.headers.get(BRANCH_HEADER)
        requested_id: int | None = None
        if requested_raw and m is not None:
            try:
                public = uuid.UUID(requested_raw.strip())
            except ValueError:
                raise Unprocessable(f"{BRANCH_HEADER} must be the id of a branch") from None
            row = await fetch_one(
                conn, "SELECT id FROM branches WHERE public_id = %s AND deleted_at IS NULL", (public,)
            )
            requested_id = None if row is None else int(row["id"])
    if m is None or m["status"] != "active":
        raise Forbidden("No active membership in this center")
    if m["org_status"] != "active":
        raise Forbidden("Center is not active")
    scope_branch: int | None = m["branch_id"]
    if requested_raw:
        if requested_id is None:
            # restricted staff learn nothing about other branches: a missing branch reads "forbidden" for them
            if m["branch_id"] is not None:
                raise Forbidden("This branch is not available to your account")
            raise NotFound("branch not found")
        decided = resolve_scope(member_branch=m["branch_id"], requested=requested_id, known=[requested_id])
        if decided["error"] == "forbidden_branch":
            raise Forbidden("This branch is not available to your account")
        scope_branch = decided["scope"]
    return Principal(
        user_id=user.user_id,
        user_public_id=user.user_public_id,
        org_id=user.org_id,
        role=m["role"],
        branch_id=m["branch_id"],
        permissions=permissions_for(m["role"]),
        request_id=user.request_id,
        scope_branch_id=scope_branch,
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
