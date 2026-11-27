"""Teacher app, ways in: accept the owner's invitation (new account or an existing one) and sign in from the Telegram Mini App.

The invitation code is the only thing a person needs to become a teacher; it is single use, expires in 7 days and only its
hash is stored. The bot accepts it too (`nazoratly.teacher_bot`)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from psycopg import errors as pgerr
from psycopg.errors import UniqueViolation
from pydantic import EmailStr, StringConstraints, model_validator

from nazoratly.db import Session, execute, fetch_all, fetch_one
from nazoratly.deps import DB, AuthUser, Cfg, current_user, request_id_of
from nazoratly.errors import Conflict, Forbidden, NotFound, Unauthorized
from nazoratly.routers.auth import (
    _MEMBERSHIPS_SQL,
    OrgRef,
    Password,
    TokenOut,
    _issue_refresh,
    _org_ref,
    _pick_org,
    _token_response,
    locked_rows,
)
from nazoratly.schemas import Model, Phone
from nazoratly.security import hash_password
from nazoratly.teacher_app import canonical_invite, invite_hash
from nazoratly.telegram_auth import BadInitData, verify_init_data
from nazoratly.telegram_registry import miniapp_signer

router = APIRouter(prefix="/v1", tags=["teacher app (sign-in)"])

_REASONS = {
    "invitation_unknown": (NotFound, "invitation_unknown", "This invitation code does not exist"),
    "invitation_used": (Conflict, "invitation_used", "This invitation was already used"),
    "invitation_revoked": (Conflict, "invitation_revoked", "This invitation was cancelled by the center"),
    "invitation_expired": (
        Conflict,
        "invitation_expired",
        "This invitation has expired: ask the center for a new one",
    ),
    "teacher_already_linked": (Conflict, "teacher_already_linked", "This teacher already has an account"),
    "user_has_other_role": (
        Conflict,
        "user_has_other_role",
        "This account already has another role in the center",
    ),
    "membership_suspended": (Forbidden, "membership_suspended", "This account is suspended in the center"),
}


def invite_error(reason: str) -> Exception:
    cls, code, message = _REASONS.get(
        reason, (Conflict, "invitation_invalid", "The invitation cannot be accepted")
    )
    err = cls(message)
    err.code = code
    return err


class AcceptInviteIn(Model):
    code: Annotated[str, StringConstraints(min_length=4, max_length=40)]
    full_name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)] | None
    ) = None
    email: EmailStr | None = None
    phone: Phone | None = None
    password: Password

    @model_validator(mode="after")
    def _identity(self) -> AcceptInviteIn:
        if self.email is None and self.phone is None:
            raise ValueError("email or phone is required")
        return self


@router.post(
    "/auth/accept-teacher-invite",
    response_model=TokenOut,
    status_code=201,
    summary="Accept a teacher invitation with a new account (email or phone + password)",
)
async def accept_teacher_invite(body: AcceptInviteIn, request: Request, db: DB, settings: Cfg) -> TokenOut:
    code_hash = invite_hash(canonical_invite(body.code))
    pw_hash = await hash_password(body.password)
    async with db.auth_tx(Session(None, None, request_id_of(request))) as conn:
        peek = await fetch_one(conn, "SELECT * FROM teacher_invite_peek(%s)", (code_hash,))
        if peek is None:
            raise invite_error("invitation_unknown")
        if peek["out_status"] != "pending":
            raise invite_error(f"invitation_{peek['out_status']}")
        try:
            async with conn.transaction():
                user = await fetch_one(
                    conn,
                    "INSERT INTO users (email, phone, full_name, password_hash) VALUES (%s, %s, %s, %s) RETURNING id, public_id",
                    (
                        str(body.email).lower() if body.email else None,
                        body.phone,
                        body.full_name or peek["teacher_name"],
                        pw_hash,
                    ),
                )
        except UniqueViolation as exc:
            raise Conflict(
                "An account with this email or phone already exists: sign in and accept the invitation there "
                "(POST /v1/me/accept-teacher-invite)"
            ) from exc
        assert user is not None
        try:
            await fetch_one(
                conn, "SELECT * FROM teacher_invite_accept(%s, %s, 'api')", (code_hash, user["id"])
            )
        except pgerr.CheckViolation as exc:
            raise invite_error(exc.diag.message_primary or "") from exc
        refresh = await _issue_refresh(
            conn, settings, user["id"], uuid.uuid4(), request.headers.get("user-agent")
        )
        rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user["id"],))
    org_public = next(r["id"] for r in rows if r["org_internal_id"] == peek["out_org_id"])
    return _token_response(settings, user, rows, _pick_org(rows, org_public), refresh)


class AcceptExistingIn(Model):
    code: Annotated[str, StringConstraints(min_length=4, max_length=40)]


@router.post(
    "/me/accept-teacher-invite",
    response_model=OrgRef,
    summary="Accept a teacher invitation with the account you are signed in with",
)
async def accept_teacher_invite_existing(
    body: AcceptExistingIn, user: Annotated[AuthUser, Depends(current_user)], db: DB
) -> OrgRef:
    user.require_unlocked()
    code_hash = invite_hash(canonical_invite(body.code))
    async with db.auth_tx(Session(user.user_id, None, user.request_id)) as conn:
        try:
            got = await fetch_one(
                conn, "SELECT * FROM teacher_invite_accept(%s, %s, 'api')", (code_hash, user.user_id)
            )
        except pgerr.CheckViolation as exc:
            raise invite_error(exc.diag.message_primary or "") from exc
        assert got is not None
        rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user.user_id,))
    return _org_ref(next(r for r in rows if r["org_internal_id"] == got["out_org_id"]))


class MiniAppLoginIn(Model):
    init_data: Annotated[str, StringConstraints(min_length=10, max_length=4096)]
    org_id: uuid.UUID | None = None
    bot: uuid.UUID | None = None  # the center's own bot the page was opened from (?bot= in its address)


@router.post(
    "/auth/telegram-miniapp",
    response_model=TokenOut,
    summary="Sign in from the Telegram Mini App (verified initData of an account linked through an invitation)",
)
async def telegram_miniapp_login(body: MiniAppLoginIn, request: Request, db: DB, settings: Cfg) -> TokenOut:
    signer = await miniapp_signer(db, settings, request.app.state.secrets_box, body.bot)
    if signer is None:
        raise NotFound("Telegram sign-in is not configured")
    try:
        tg = verify_init_data(body.init_data, signer.token)
    except BadInitData:
        raise Unauthorized("Invalid Telegram data") from None
    async with db.auth_tx(Session(None, None, request_id_of(request))) as conn:
        user = await fetch_one(
            conn, "SELECT id, public_id, status FROM users WHERE telegram_user_id = %s", (tg.id,)
        )
        if user is None or user["status"] != "active":
            raise Forbidden(
                "This Telegram account is not linked to a staff member: ask the center for an invitation"
            )
        rows = await fetch_all(conn, _MEMBERSHIPS_SQL, (user["id"],))
        lock = signer.only_org
        if lock is not None:  # the center's own bot: only this center, only as its teacher
            rows = locked_rows(rows, lock)
            if not rows:
                raise Forbidden("This Telegram account does not teach in the center of this bot")
        elif signer.moved:  # centers that stopped the shared bot are entered through their own bot
            rows = [r for r in rows if r["org_internal_id"] not in signer.moved]
        org = _pick_org(rows, body.org_id)
        if not any(r["membership_status"] == "active" for r in rows):
            raise Forbidden("No active membership")
        await execute(conn, "UPDATE users SET last_login_at = now() WHERE id = %s", (user["id"],))
        refresh = await _issue_refresh(
            conn, settings, user["id"], uuid.uuid4(), request.headers.get("user-agent"), lock
        )
    return _token_response(settings, user, rows, org, refresh, lock)
