"""Password hashing (Argon2id), JWT access tokens, opaque refresh/agent tokens."""

from __future__ import annotations

import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any

import anyio
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from nazoratly.config import Settings
from nazoratly.errors import Unauthorized

_hasher = PasswordHasher()  # Argon2id with the library's current recommended parameters
_DUMMY_HASH = _hasher.hash("nazoratly-timing-equaliser")


async def hash_password(password: str) -> str:
    return await anyio.to_thread.run_sync(_hasher.hash, password)


async def verify_password(password_hash: str | None, password: str) -> bool:
    """Constant-ish time: an unknown user still pays for one Argon2 verification."""

    def _check() -> bool:
        try:
            return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    return await anyio.to_thread.run_sync(_check)


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def sha256(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


def new_opaque_token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


@dataclass(frozen=True)
class AccessClaims:
    user_id: int
    user_public_id: uuid.UUID
    org_id: int | None
    jti: str


def issue_access_token(
    settings: Settings, *, user_id: int, user_public_id: uuid.UUID, org_id: int | None
) -> tuple[str, int]:
    now = int(time.time())
    ttl = settings.access_token_ttl_s
    payload: dict[str, Any] = {
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "sub": str(user_public_id),
        "uid": user_id,
        "org": org_id,
        "jti": uuid.uuid4().hex,
        "iat": now,
        "exp": now + ttl,
        "typ": "access",
    }
    return jwt.encode(payload, settings.jwt_secret.get_secret_value(), algorithm="HS256"), ttl


def decode_access_token(settings: Settings, token: str) -> AccessClaims:
    keys = [
        settings.jwt_secret.get_secret_value(),
        *(k.get_secret_value() for k in settings.jwt_previous_secrets),
    ]
    last: Exception | None = None
    for key in keys:
        try:
            data = jwt.decode(
                token,
                key,
                algorithms=["HS256"],
                audience=settings.jwt_audience,
                issuer=settings.jwt_issuer,
                options={"require": ["exp", "iat", "sub", "uid", "typ"]},
            )
        except jwt.InvalidSignatureError as e:
            last = e
            continue
        except jwt.PyJWTError as e:
            raise Unauthorized("Invalid or expired token") from e
        if data.get("typ") != "access":
            raise Unauthorized("Invalid token type")
        org = data.get("org")
        return AccessClaims(
            user_id=int(data["uid"]),
            user_public_id=uuid.UUID(data["sub"]),
            org_id=int(org) if org is not None else None,
            jti=str(data.get("jti", "")),
        )
    raise Unauthorized("Invalid or expired token") from last
