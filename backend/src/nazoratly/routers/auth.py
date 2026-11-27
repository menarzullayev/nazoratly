"""Authentication: registration (creates a center + its owner), login, refresh rotation, logout, center switching."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, Request, Response
from psycopg.errors import UniqueViolation
from pydantic import EmailStr, Field, StringConstraints, model_validator

from nazoratly.config import Settings
from nazoratly.db import Conn, Database, Session, execute, fetch_all, fetch_one
from nazoratly.deps import DB, AuthUser, Cfg, current_user, request_id_of
from nazoratly.errors import ApiError, Conflict, Forbidden, InvalidResetCode, TooManyRequests, Unauthorized
from nazoratly.middleware import request_ip
from nazoratly.permissions import permissions_for
from nazoratly.schemas import Message, Model, Out, Phone
from nazoratly.security import (
    hash_password,
    issue_access_token,
    needs_rehash,
    new_opaque_token,
    sha256,
    verify_password,
)
from nazoratly.web_cookie import clear_session_cookie

router = APIRouter(prefix="/v1", tags=["auth"])
log = structlog.get_logger()

Password = Annotated[str, StringConstraints(min_length=10, max_length=128)]
_PHONE_LIKE = re.compile(r"^\+[1-9][0-9]{7,14}$")


class RegisterIn(Model):
    full_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    center_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    email: EmailStr | None = None
    phone: Phone | None = None
    password: Password

    @model_validator(mode="after")
    def _identity(self) -> RegisterIn:
        if self.email is None and self.phone is None:
            raise ValueError("email or phone is required")
        return self


class LoginIn(Model):
    identifier: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=254)] = (
        Field(description="email or E.164 phone")
    )
    password: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    org_id: uuid.UUID | None = Field(
        default=None, description="center to enter; optional when the user has one"
    )


class RefreshIn(Model):
    refresh_token: Annotated[str, StringConstraints(min_length=20, max_length=200)]
    org_id: uuid.UUID | None = None


class LogoutIn(Model):
    refresh_token: Annotated[str, StringConstraints(min_length=20, max_length=200)]


class SwitchIn(Model):
    org_id: uuid.UUID


class PasswordChangeIn(Model):
    current_password: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    new_password: Password


class OrgRef(Out):
    id: uuid.UUID
    name: str
    role: str
    membership_status: str


class TokenOut(Out):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 - OAuth token type, not a secret
    expires_in: int
    refresh_token: str
    org: OrgRef | None = Field(
        description="selected center; null when the user belongs to several and none was chosen"
    )
    organizations: list[OrgRef]


class AccessOut(Out):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 - OAuth token type, not a secret
    expires_in: int
    org: OrgRef


class MeOut(Out):
    id: uuid.UUID
    full_name: str
    email: str | None
    phone: str | None
    org: OrgRef | None
    organizations: list[OrgRef]
    permissions: list[str] = Field(
        description="what the role may do in the selected center (empty without one); the server enforces it anyway"
    )
    branch_id: uuid.UUID | None = Field(
        description="the branch this staff member is restricted to; null = all branches (or no center selected)"
    )


class ResetIn(Model):
    code: Annotated[str, StringConstraints(min_length=20, max_length=200)]
    new_password: Password


_MEMBERSHIPS_SQL = (
    "SELECT o.id AS org_internal_id, o.public_id AS id, o.name, m.role, m.status AS membership_status, "
    "m.public_id AS membership_public_id "
    "FROM memberships m JOIN organizations o ON o.id = m.org_id "
    "WHERE m.user_id = %s AND o.deleted_at IS NULL AND o.status = 'active' AND m.status <> 'suspended' "
    "ORDER BY o.name, o.id"
)


def org_ref(row: dict[str, Any]) -> OrgRef:
    return OrgRef(
        id=row["id"], name=row["name"], role=row["role"], membership_status=row["membership_status"]
    )


async def _issue_refresh(
    conn: Conn,
    settings: Settings,
    user_id: int,
    family_id: uuid.UUID,
    user_agent: str | None,
    org_lock: int | None = None,
) -> str:
    token = new_opaque_token("nzr")
    await execute(
        conn,
        "INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, org_lock) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (
            user_id,
            family_id,
            sha256(token),
            datetime.now(UTC) + timedelta(seconds=settings.refresh_token_ttl_s),
            (user_agent or "")[:300] or None,
            org_lock,
        ),
    )
    return token


def locked_rows(rows: list[dict[str, Any]], org_lock: int) -> list[dict[str, Any]]:
    """What a sign-in locked to a center may see and enter: that center, and only while teaching in it."""
    return [r for r in rows if r["org_internal_id"] == org_lock and r["role"] == "teacher"]


def _pick_org(rows: list[dict[str, Any]], wanted: uuid.UUID | None) -> dict[str, Any] | None:
    active = [r for r in rows if r["membership_status"] == "active"]
    if wanted is not None:
        for r in active:
            if r["id"] == wanted:
                return r
        raise Forbidden("You are not an active member of that center")
    return active[0] if len(active) == 1 else None


@dataclass(frozen=True)
class SignedIn:
    """What a successful sign-in produced; the JSON routes and the panel's cookie routes render it differently."""

    user: dict[str, Any]  # id, public_id, full_name, email, phone
    rows: list[dict[str, Any]]
    org: dict[str, Any] | None
    refresh: str
    org_lock: int | None = None

    def access_token(self, settings: Settings) -> tuple[str, int]:
        return issue_access_token(
            settings,
            user_id=self.user["id"],
            user_public_id=self.user["public_id"],
            org_id=self.org["org_internal_id"] if self.org else None,
            org_lock=self.org_lock,
        )


def _token_response(settings: Settings, signed: SignedIn) -> TokenOut:
    access, ttl = signed.access_token(settings)
    return TokenOut(
        access_token=access,
        expires_in=ttl,
        refresh_token=signed.refresh,
        org=org_ref(signed.org) if signed.org else None,
        organizations=[org_ref(r) for r in signed.rows],
    )


async def revoke_family_of(db: Database, token: str) -> None:
    async with db.auth_tx() as conn:
        await execute(
            conn,
            "UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND family_id = "
            "(SELECT family_id FROM refresh_tokens WHERE token_hash = %s)",
            (sha256(token),),
        )


@router.post(
    "/auth/register",
    response_model=TokenOut,
    status_code=201,
    summary="Create a center and its owner account",
)
async def register(body: RegisterIn, request: Request, db: DB, settings: Cfg) -> TokenOut:
    return _token_response(settings, await register_account(body, request, db, settings))


async def register_account(body: RegisterIn, request: Request, db: Database, settings: Settings) -> SignedIn:
    pw_hash = await hash_password(body.password)
    rid = request_id_of(request)
    async with db.auth_tx(Session(None, None, rid)) as conn:
        try:
            async with (
                conn.transaction()
            ):  # savepoint: a duplicate identity must not poison the outer transaction
                user = await fetch_one(
                    conn,
                    "INSERT INTO users (email, phone, full_name, password_hash) VALUES (%s, %s, %s, %s) "
                    "RETURNING id, public_id, full_name, email, phone",
                    (str(body.email).lower() if body.email else None, body.phone, body.full_name, pw_hash),
                )
        except Exception as exc:
            if isinstance(exc, UniqueViolation):
                raise Conflict("An account with this email or phone already exists") from exc
            raise
        assert user is not None
        org = await fetch_one(
            conn, "INSERT INTO organizations (name) VALUES (%s) RETURNING id, public_id", (body.center_name,)
        )
        assert org is not None
        await conn.execute("SELECT set_config('app.user_id', %s, true)", (str(user["id"]),))
        await execute(
            conn,
            "INSERT INTO memberships (org_id, user_id, role, status) VALUES (%s, %s, 'owner', 'active')",
            (org["id"], user["id"]),
        )
        refresh = await _issue_refresh(
            conn, settings, user["id"], uuid.uuid4(), request.headers.get("user-agent")
        )
        rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user["id"],))
    return SignedIn(user, rows, _pick_org(rows, org["public_id"]), refresh)


def _identifier_columns(identifier: str) -> tuple[str, str]:
    ident = identifier.strip()
    if ident.startswith("+"):
        if not _PHONE_LIKE.match(ident):
            raise Unauthorized("Invalid credentials")
        return "phone", ident
    return "email", ident.lower()


@router.post("/auth/login", response_model=TokenOut, summary="Log in with email/phone and password")
async def login(body: LoginIn, request: Request, db: DB, settings: Cfg) -> TokenOut:
    return _token_response(settings, await password_sign_in(body, request, db, settings))


async def password_sign_in(body: LoginIn, request: Request, db: Database, settings: Settings) -> SignedIn:
    """Password check with the shared failure counter and lockout: the one way a password opens a session."""
    column, ident = _identifier_columns(body.identifier)
    ip = request_ip(request, settings)
    rid = request_id_of(request)
    failure: Unauthorized | TooManyRequests | None = None
    result: SignedIn | None = None
    async with db.auth_tx(Session(None, None, rid)) as conn:
        await execute(conn, "DELETE FROM login_attempts WHERE created_at < now() - interval '2 days'")
        failures = await fetch_one(
            conn,
            "SELECT count(*) AS n FROM login_attempts WHERE identifier = %s AND NOT succeeded "
            "AND created_at > now() - make_interval(secs => %s) "
            "AND created_at > COALESCE((SELECT max(created_at) FROM login_attempts WHERE identifier = %s AND succeeded), '-infinity')",
            (ident, settings.login_lockout_window_s, ident),
        )
        assert failures is not None
        if failures["n"] >= settings.login_max_failures:
            failure = TooManyRequests(
                "Too many failed attempts, try again later",
                headers={"Retry-After": str(settings.login_lockout_window_s)},
            )
        else:
            user = await fetch_one(
                conn,
                f"SELECT id, public_id, password_hash, status, full_name, email, phone FROM users WHERE {column} = %s",
                (ident,),
            )
            ok = await verify_password(user["password_hash"] if user else None, body.password)
            if not (ok and user and user["status"] == "active"):
                await execute(
                    conn,
                    "INSERT INTO login_attempts (identifier, ip, succeeded) VALUES (%s, %s, false)",
                    (ident, ip),
                )
                failure = Unauthorized("Invalid credentials")
            else:
                await conn.execute("SELECT set_config('app.user_id', %s, true)", (str(user["id"]),))
                rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user["id"],))
                try:
                    org = _pick_org(rows, body.org_id)
                except Forbidden as exc:
                    failure = Unauthorized(exc.message)  # do not reveal which centers exist
                else:
                    await execute(
                        conn,
                        "INSERT INTO login_attempts (identifier, ip, succeeded) VALUES (%s, %s, true)",
                        (ident, ip),
                    )
                    if user["password_hash"] and needs_rehash(user["password_hash"]):
                        await execute(
                            conn,
                            "UPDATE users SET password_hash = %s WHERE id = %s",
                            (await hash_password(body.password), user["id"]),
                        )
                    await execute(conn, "UPDATE users SET last_login_at = now() WHERE id = %s", (user["id"],))
                    refresh = await _issue_refresh(
                        conn, settings, user["id"], uuid.uuid4(), request.headers.get("user-agent")
                    )
                    result = SignedIn(user, rows, org, refresh)
    if failure is not None:  # raised after the transaction committed so the failed attempt is recorded
        raise failure
    assert result is not None
    return result


@router.post("/auth/refresh", response_model=TokenOut, summary="Rotate a refresh token")
async def refresh_token(body: RefreshIn, request: Request, db: DB, settings: Cfg) -> TokenOut:
    signed = await rotate_session(body.refresh_token, body.org_id, request, db, settings)
    return _token_response(settings, signed)


class SessionOver(Unauthorized):
    """The presented refresh token can never work again (unknown, revoked, expired, reused, account disabled). A plain
    `Unauthorized` from `rotate_session` means only the requested center was refused and the token is still good."""


async def rotate_session(
    token: str, org_id: uuid.UUID | None, request: Request, db: Database, settings: Settings
) -> SignedIn:
    failure: Unauthorized | None = None
    result: SignedIn | None = None
    rid = request_id_of(request)
    async with db.auth_tx(Session(None, None, rid)) as conn:
        tok = await fetch_one(
            conn,
            "SELECT id, user_id, family_id, used_at, revoked_at, expires_at, org_lock FROM refresh_tokens "
            "WHERE token_hash = %s FOR UPDATE",
            (sha256(token),),
        )
        now = datetime.now(UTC)
        if tok is None or tok["revoked_at"] is not None or tok["expires_at"] <= now:
            failure = SessionOver("Invalid refresh token")
        elif tok["used_at"] is not None:
            # a rotated token was presented again: assume theft and kill the whole session family
            await execute(
                conn,
                "UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = %s AND revoked_at IS NULL",
                (tok["family_id"],),
            )
            failure = SessionOver("Refresh token reuse detected; please log in again")
        else:
            user = await fetch_one(
                conn,
                "SELECT id, public_id, status, full_name, email, phone FROM users WHERE id = %s",
                (tok["user_id"],),
            )
            if user is None or user["status"] != "active":
                failure = SessionOver("Account is not active")
            else:
                await conn.execute("SELECT set_config('app.user_id', %s, true)", (str(user["id"]),))
                rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user["id"],))
                lock = tok["org_lock"]
                if lock is not None:
                    rows = locked_rows(rows, lock)
                try:
                    org = _pick_org(rows, org_id)
                    if lock is not None and org is None:
                        raise Forbidden("You no longer teach in that center")
                except Forbidden as exc:
                    failure = Unauthorized(exc.message)
                else:
                    await execute(
                        conn, "UPDATE refresh_tokens SET used_at = now() WHERE id = %s", (tok["id"],)
                    )
                    new = await _issue_refresh(
                        conn, settings, user["id"], tok["family_id"], request.headers.get("user-agent"), lock
                    )
                    result = SignedIn(user, rows, org, new, lock)
    if failure is not None:
        raise failure
    assert result is not None
    return result


@router.post("/auth/logout", response_model=Message, summary="Revoke the session of a refresh token")
async def logout(body: LogoutIn, db: DB) -> Message:
    await revoke_family_of(db, body.refresh_token)
    return Message(message="logged out")


@router.post(
    "/auth/switch", response_model=AccessOut, summary="Get an access token for another of your centers"
)
async def switch_org(
    body: SwitchIn, user: Annotated[AuthUser, Depends(current_user)], db: DB, settings: Cfg
) -> AccessOut:
    user.require_unlocked()
    async with db.auth_tx(Session(user.user_id, None, user.request_id)) as conn:
        rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user.user_id,))
    try:
        org = _pick_org(rows, body.org_id)
    except Forbidden:
        raise
    if org is None:
        raise Forbidden("You are not an active member of that center")
    access, ttl = issue_access_token(
        settings, user_id=user.user_id, user_public_id=user.user_public_id, org_id=org["org_internal_id"]
    )
    return AccessOut(access_token=access, expires_in=ttl, org=org_ref(org))


@router.post("/auth/password", response_model=Message, summary="Change password and sign out everywhere")
async def change_password(
    body: PasswordChangeIn,
    response: Response,
    user: Annotated[AuthUser, Depends(current_user)],
    db: DB,
) -> Message:
    user.require_unlocked()
    new_hash = await hash_password(body.new_password)
    ok = False
    async with db.auth_tx(Session(user.user_id, None, user.request_id)) as conn:
        row = await fetch_one(conn, "SELECT password_hash FROM users WHERE id = %s", (user.user_id,))
        if row is not None and await verify_password(row["password_hash"], body.current_password):
            ok = True
            await execute(conn, "UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, user.user_id))
            await execute(
                conn,
                "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = %s AND revoked_at IS NULL",
                (user.user_id,),
            )
    if not ok:
        raise Unauthorized("Current password is incorrect")
    clear_session_cookie(response)  # a panel in this browser must sign in again
    return Message(message="password changed; all sessions were signed out")


@router.get("/me", response_model=MeOut, summary="Current user and centers")
async def me(user: Annotated[AuthUser, Depends(current_user)], db: DB) -> MeOut:
    async with db.auth_tx(Session(user.user_id, None, user.request_id)) as conn:
        u = await fetch_one(
            conn, "SELECT public_id, full_name, email, phone FROM users WHERE id = %s", (user.user_id,)
        )
        rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user.user_id,))
    assert u is not None
    if user.org_lock is not None:
        rows = locked_rows(rows, user.org_lock)
    current = next((r for r in rows if r["org_internal_id"] == user.org_id), None)
    permissions: list[str] = []
    branch: uuid.UUID | None = None
    if current is not None and current["membership_status"] == "active":
        permissions = sorted(permissions_for(current["role"]))
        async with db.tx(Session(user.user_id, user.org_id, user.request_id)) as conn:
            m = await fetch_one(
                conn,
                "SELECT b.public_id AS branch_id FROM memberships m LEFT JOIN branches b "
                "ON b.org_id = m.org_id AND b.id = m.branch_id WHERE m.user_id = %s",
                (user.user_id,),
            )
        branch = None if m is None else m["branch_id"]
    return MeOut(
        id=u["public_id"],
        full_name=u["full_name"],
        email=u["email"] if user.org_lock is None else None,
        phone=u["phone"] if user.org_lock is None else None,
        org=org_ref(current) if current else None,
        organizations=[org_ref(r) for r in rows],
        permissions=permissions,
        branch_id=branch,
    )


_RESET_REFUSED = "This reset link is not valid. Ask for a new one."
RESET_MAX_FAILURES = 10  # per client address inside the login lockout window


@router.post("/auth/reset", response_model=Message, summary="Set a new password with a one-time reset code")
async def reset_password(body: ResetIn, request: Request, db: DB, settings: Cfg) -> Message:
    """The code comes from a link an operator issued (`python -m nazoratly.password_reset`). A wrong, used, expired and
    replaced code all get the same answer. Success signs the account out everywhere and lifts its login lockout."""
    new_hash = await hash_password(body.new_password)  # before the lookup: every request costs the same
    ip = request_ip(request, settings)
    attempts = f"reset:{ip}"
    failure: ApiError | None = None
    done: dict[str, Any] | None = None
    async with db.auth_tx(Session(None, None, request_id_of(request))) as conn:
        failed = await fetch_one(
            conn,
            "SELECT count(*) AS n FROM login_attempts WHERE identifier = %s AND NOT succeeded "
            "AND created_at > now() - make_interval(secs => %s)",
            (attempts, settings.login_lockout_window_s),
        )
        assert failed is not None
        if failed["n"] >= RESET_MAX_FAILURES:
            failure = TooManyRequests(
                "Too many failed attempts, try again later",
                headers={"Retry-After": str(settings.login_lockout_window_s)},
            )
        else:
            code = await fetch_one(
                conn,
                "SELECT c.id, c.user_id, u.email, u.phone FROM password_reset_codes c "
                "JOIN users u ON u.id = c.user_id WHERE c.code_hash = %s AND c.used_at IS NULL "
                "AND c.revoked_at IS NULL AND c.expires_at > now() AND u.status = 'active' FOR UPDATE OF c",
                (sha256(body.code),),
            )
            if code is None:
                await execute(
                    conn,
                    "INSERT INTO login_attempts (identifier, ip, succeeded) VALUES (%s, %s, false)",
                    (attempts, ip),
                )
                failure = InvalidResetCode(_RESET_REFUSED)
            else:
                await execute(
                    conn, "UPDATE password_reset_codes SET used_at = now() WHERE id = %s", (code["id"],)
                )
                await execute(
                    conn, "UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, code["user_id"])
                )
                await execute(
                    conn,
                    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = %s AND revoked_at IS NULL",
                    (code["user_id"],),
                )
                for identifier in (code["email"], code["phone"]):
                    if identifier:  # a success row ends the lockout: only later failures are counted
                        await execute(
                            conn,
                            "INSERT INTO login_attempts (identifier, ip, succeeded) VALUES (%s, %s, true)",
                            (str(identifier).lower(), ip),
                        )
                done = code
    if failure is not None:  # raised after the commit so the failed attempt is recorded
        raise failure
    assert done is not None
    log.info("password_reset_used", reset_id=done["id"], user_id=done["user_id"])
    return Message(message="password changed; all sessions were signed out")


@router.post(
    "/me/invitations/{org_id}/accept", response_model=OrgRef, summary="Accept an invitation to a center"
)
async def accept_invitation(
    org_id: uuid.UUID, user: Annotated[AuthUser, Depends(current_user)], db: DB
) -> OrgRef:
    user.require_unlocked()
    async with db.auth_tx(Session(user.user_id, None, user.request_id)) as conn:
        rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user.user_id,))
        target = next((r for r in rows if r["id"] == org_id and r["membership_status"] == "invited"), None)
        if target is None:
            raise Forbidden("No pending invitation for that center")
        await execute(
            conn,
            "UPDATE memberships SET status = 'active' WHERE user_id = %s AND org_id = %s AND status = 'invited'",
            (user.user_id, target["org_internal_id"]),
        )
        target["membership_status"] = "active"
    return org_ref(target)


_ = Database  # re-export for type checkers
