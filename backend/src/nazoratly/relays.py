"""Relay connections of the Sheets edition: which web app each one forwards to, and the operator command.

    docker compose exec api python -m nazoratly.relays add --label "Ziyo markazi" --target https://script.google.com/macros/s/.../exec
    docker compose exec api python -m nazoratly.relays list
    docker compose exec api python -m nazoratly.relays disable <id>

`add` asks for the secret the Sheet shows ("Webhook relay sozlamalari"); it is read without echo and never taken from the
command line, so it does not stay in the shell history. It prints the relay address to enter in the Sheet."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import re
import sys
import uuid
from dataclasses import dataclass, field

from nazoratly.config import Settings, get_settings
from nazoratly.db import Database, execute, fetch_all, fetch_one
from nazoratly.secrets_box import SecretsBox
from nazoratly.telegram_registry import ANON

# Apps Script web app deployments only (the same shape the database CHECK of migration 0071 enforces).
_TARGET = re.compile(
    r"https://script\.google\.com/(?:macros|a/macros/[A-Za-z0-9.-]+)/s/[A-Za-z0-9_-]+/exec", re.ASCII
)
# Telegram's secret_token alphabet; the Sheet generates 64 hex characters.
_SECRET = re.compile(r"[A-Za-z0-9_-]{16,256}", re.ASCII)


class RelayError(Exception):
    pass


def allowed_target(url: str) -> bool:
    return _TARGET.fullmatch(url) is not None


@dataclass(frozen=True)
class Relay:
    target: str
    secret: str = field(repr=False)


async def find(db: Database, box: SecretsBox | None, public_id: uuid.UUID) -> Relay | None:
    async with db.tx(ANON) as conn:
        row = await fetch_one(
            conn,
            "SELECT target_url, secret_ciphertext FROM sheet_relays WHERE public_id = %s AND status = 'active'",
            (public_id,),
        )
    if row is None or box is None:
        return None
    secret = box.decrypt(bytes(row["secret_ciphertext"]))
    return None if secret is None else Relay(str(row["target_url"]), secret)


async def add(
    db: Database, settings: Settings, box: SecretsBox | None, *, label: str, target: str, secret: str
) -> str:
    """Register a connection; returns the webhook address to enter in the Sheet."""
    base = settings.public_base_url
    if box is None:
        raise RelayError("NAZORATLY_SECRETS_KEY is not set")
    if not base or not base.startswith("https://"):
        raise RelayError("NAZORATLY_PUBLIC_BASE_URL must be the public https address of this server")
    if not allowed_target(target):
        raise RelayError(
            "the target must be an Apps Script web app: https://script.google.com/macros/s/<id>/exec"
        )
    if not _SECRET.fullmatch(secret):
        raise RelayError("the secret must be 16-256 characters of A-Z a-z 0-9 _ -")
    if not label.strip():
        raise RelayError("give the connection a label")
    async with db.tx(ANON) as conn:
        row = await fetch_one(
            conn,
            "INSERT INTO sheet_relays (label, target_url, secret_ciphertext) VALUES (%s, %s, %s) RETURNING public_id",
            (label.strip()[:100], target, box.encrypt(secret)),
        )
    assert row is not None
    return f"{base.rstrip('/')}/hooks/relay/{row['public_id']}"


async def disable(db: Database, public_id: uuid.UUID) -> bool:
    async with db.tx(ANON) as conn:
        return bool(
            await execute(
                conn,
                "UPDATE sheet_relays SET status = 'disabled' WHERE public_id = %s AND status = 'active'",
                (public_id,),
            )
        )


async def listing(db: Database) -> list[str]:
    async with db.tx(ANON) as conn:
        rows = await fetch_all(conn, "SELECT public_id, label, status FROM sheet_relays ORDER BY id")
    return [f"{r['public_id']}  {r['status']:8}  {r['label']}" for r in rows]


async def _run(args: argparse.Namespace, secret: str) -> int:
    settings = get_settings()
    db = Database(settings)
    await db.open()
    try:
        box = SecretsBox(settings.secrets_key.get_secret_value()) if settings.secrets_key else None
        if args.cmd == "add":
            url = await add(db, settings, box, label=args.label, target=args.target, secret=secret)
            print(f"relay added. Enter this address in the Sheet (Telegram sozlash):\n{url}")
        elif args.cmd == "list":
            print("\n".join(await listing(db)) or "no relays")
        else:
            if not await disable(db, uuid.UUID(args.id)):
                print("no active relay with this id", file=sys.stderr)
                return 1
            print("disabled")
    except (RelayError, ValueError) as exc:
        print(f"failed: {exc}", file=sys.stderr)
        return 1
    finally:
        await db.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nazoratly.relays")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_add = sub.add_parser("add", help="add a Sheets connection")
    p_add.add_argument("--label", required=True)
    p_add.add_argument("--target", required=True, help="the Sheet's web app address (.../exec)")
    sub.add_parser("list", help="list connections (never their secrets)")
    p_off = sub.add_parser("disable", help="stop forwarding for a connection")
    p_off.add_argument("id")
    args = parser.parse_args(argv)
    secret = getpass.getpass("Secret shown by the Sheet: ").strip() if args.cmd == "add" else ""
    if sys.platform == "win32":  # psycopg async needs a selector loop
        return asyncio.run(_run(args, secret), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(_run(args, secret))


if __name__ == "__main__":
    sys.exit(main())
