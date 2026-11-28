"""Operator command: issue a one-time password reset link.

    python -m nazoratly.password_reset --identifier owner@example.com --operator "Ali (support)"

Run it on the server (inside the api container) and hand the printed link to the person **after checking who they are**
(see docs/DEPLOY.md). No HTTP route creates such a link. The code is 256 random bits and only its SHA-256 is stored; it
sits in the URL fragment, which a browser never sends to a server or a proxy. A newer link cancels the older one.
"""

from __future__ import annotations

import argparse
import asyncio
import selectors
import sys
from datetime import UTC, datetime, timedelta

import structlog

from nazoratly.config import Settings, get_settings
from nazoratly.db import Database, execute, fetch_one
from nazoratly.security import new_opaque_token, sha256

log = structlog.get_logger()

DEFAULT_TTL_MINUTES = 30
MAX_TTL_MINUTES = 60


class ResetLinkError(Exception):
    pass


async def issue_link(
    db: Database,
    settings: Settings,
    *,
    identifier: str,
    operator: str,
    ttl_minutes: int = DEFAULT_TTL_MINUTES,
) -> str:
    origin = settings.panel_origin
    if origin is None:
        raise ResetLinkError("NAZORATLY_PUBLIC_BASE_URL must be set: the link opens the staff panel")
    if not 1 <= ttl_minutes <= MAX_TTL_MINUTES:
        raise ResetLinkError(f"the lifetime must be 1..{MAX_TTL_MINUTES} minutes")
    if not operator.strip():
        raise ResetLinkError("say who is issuing the link (--operator)")
    ident = identifier.strip()
    column, value = ("phone", ident) if ident.startswith("+") else ("email", ident.lower())
    code = new_opaque_token("nzp")
    async with db.auth_tx() as conn:
        user = await fetch_one(conn, f"SELECT id, status FROM users WHERE {column} = %s FOR UPDATE", (value,))
        if user is None:
            raise ResetLinkError("no account with this email or phone")
        if user["status"] != "active":
            raise ResetLinkError("this account is not active")
        await execute(
            conn,
            "UPDATE password_reset_codes SET revoked_at = now() "
            "WHERE user_id = %s AND used_at IS NULL AND revoked_at IS NULL",
            (user["id"],),
        )
        expires = datetime.now(UTC) + timedelta(minutes=ttl_minutes)
        row = await fetch_one(
            conn,
            "INSERT INTO password_reset_codes (user_id, code_hash, issued_by, expires_at) "
            "VALUES (%s, %s, %s, %s) RETURNING id",
            (user["id"], sha256(code), operator.strip()[:100], expires),
        )
    assert row is not None
    log.info("password_reset_issued", reset_id=row["id"], user_id=user["id"], ttl_minutes=ttl_minutes)
    return f"{origin}/app/reset#code={code}"


async def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    db = Database(settings)
    await db.open()
    try:
        link = await issue_link(
            db, settings, identifier=args.identifier, operator=args.operator, ttl_minutes=args.minutes
        )
    except ResetLinkError as exc:
        print(f"failed: {exc}", file=sys.stderr)
        return 1
    finally:
        await db.close()
    print(
        f"One-time link, valid for {args.minutes} minutes. Give it only to the person you identified:\n{link}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nazoratly.password_reset")
    parser.add_argument("--identifier", required=True, help="the account's email or +phone")
    parser.add_argument("--operator", required=True, help="who is issuing the link (kept in the record)")
    parser.add_argument("--minutes", type=int, default=DEFAULT_TTL_MINUTES)
    args = parser.parse_args(argv)
    if sys.platform == "win32":  # psycopg's async mode cannot use the Proactor loop
        with asyncio.Runner(loop_factory=lambda: asyncio.SelectorEventLoop(selectors.SelectSelector())) as r:
            return r.run(_run(args))
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
