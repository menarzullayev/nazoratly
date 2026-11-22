"""Migration runner: python -m nazoratly.migrate {up|down|status|roles}.

Runs db/migrations/NNNN_name.{up,down}.sql with the OWNER connection (NAZORATLY_MIGRATE_URL; a superuser or a role
with BYPASSRLS), each file in its own transaction, tracked in schema_migrations. Role passwords are never stored in
migrations: `roles` sets LOGIN + password for the three application roles from the environment.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import psycopg
from psycopg import sql

ROLES = {
    "NAZORATLY_APP_PASSWORD": "nazoratly_app",
    "NAZORATLY_AUTH_PASSWORD": "nazoratly_auth",
    "NAZORATLY_AGENT_PASSWORD": "nazoratly_agent",
    "NAZORATLY_WORKER_PASSWORD": "nazoratly_worker",
}
_NAME = re.compile(r"^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$")


def _dir() -> Path:
    return Path(
        os.environ.get("NAZORATLY_MIGRATIONS_DIR", Path(__file__).resolve().parents[3] / "db" / "migrations")
    )


def discover(directory: Path) -> dict[str, dict[str, Path]]:
    found: dict[str, dict[str, Path]] = {}
    for f in sorted(directory.glob("*.sql")):
        m = _NAME.match(f.name)
        if m:
            found.setdefault(f"{m.group(1)}_{m.group(2)}", {})[m.group(3)] = f
    for version, files in found.items():
        if set(files) != {"up", "down"}:
            raise SystemExit(f"migration {version} needs both .up.sql and .down.sql")
    return found


def _connect() -> psycopg.Connection[tuple[object, ...]]:
    url = os.environ.get("NAZORATLY_MIGRATE_URL")
    if not url:
        raise SystemExit("NAZORATLY_MIGRATE_URL is not set")
    return psycopg.connect(url, autocommit=True)


def _ensure_table(conn: psycopg.Connection[tuple[object, ...]]) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    )


def applied(conn: psycopg.Connection[tuple[object, ...]]) -> list[str]:
    _ensure_table(conn)
    return [
        str(r[0]) for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
    ]


def up(steps: int | None = None) -> list[str]:
    migrations = discover(_dir())
    done: list[str] = []
    with _connect() as conn:
        have = set(applied(conn))
        unknown = have - set(migrations)
        if unknown:
            raise SystemExit(f"database has migrations unknown to this build: {sorted(unknown)}")
        for version in sorted(migrations):
            if version in have:
                continue
            if steps is not None and len(done) >= steps:
                break
            with conn.transaction():
                conn.execute(migrations[version]["up"].read_text(encoding="utf-8"))
                conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (version,))
            done.append(version)
    return done


def down(steps: int = 1) -> list[str]:
    migrations = discover(_dir())
    undone: list[str] = []
    with _connect() as conn:
        for version in reversed(applied(conn)):
            if len(undone) >= steps:
                break
            if version not in migrations:
                raise SystemExit(f"cannot roll back unknown migration {version}")
            with conn.transaction():
                conn.execute(migrations[version]["down"].read_text(encoding="utf-8"))
                conn.execute("DELETE FROM schema_migrations WHERE version = %s", (version,))
            undone.append(version)
    return undone


def set_role_passwords() -> list[str]:
    """ALTER ROLE ... LOGIN PASSWORD for each role whose *_PASSWORD env var is set."""
    changed: list[str] = []
    with _connect() as conn:
        for env, role in ROLES.items():
            password = os.environ.get(env)
            if not password:
                continue
            conn.execute(
                sql.SQL("ALTER ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(role), sql.Literal(password))
            )
            changed.append(role)
    return changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nazoratly.migrate")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_up = sub.add_parser("up", help="apply pending migrations")
    p_up.add_argument("--steps", type=int, default=None)
    p_down = sub.add_parser("down", help="roll back the latest migrations")
    p_down.add_argument("--steps", type=int, default=1)
    sub.add_parser("status", help="list applied/pending migrations")
    sub.add_parser("roles", help="set LOGIN passwords of the application roles from NAZORATLY_*_PASSWORD")
    args = parser.parse_args(argv)

    if args.cmd == "up":
        done = up(args.steps)
        print("applied:", ", ".join(done) if done else "nothing (up to date)")
    elif args.cmd == "down":
        undone = down(args.steps)
        print("rolled back:", ", ".join(undone) if undone else "nothing")
    elif args.cmd == "status":
        with _connect() as conn:
            have = set(applied(conn))
        for version in sorted(discover(_dir())):
            print(f"{'applied' if version in have else 'pending':8} {version}")
    else:
        print("roles updated:", ", ".join(set_role_passwords()) or "none (no *_PASSWORD variables set)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
