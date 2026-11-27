#!/usr/bin/env bash
# Applies all migrations to a disposable PostgreSQL container, runs the schema tests, rolls everything back
# (down in reverse order), verifies the database is empty, then re-applies and re-tests (full cycle).
# Requires Docker. Nothing persists: the container uses tmpfs and --rm.
set -euo pipefail
cd "$(dirname "$0")/.."                       # -> db/
export MSYS_NO_PATHCONV=1                     # Git Bash on Windows: do not rewrite container paths
IMAGE="${PG_IMAGE:-postgres:16-alpine}"
NAME="nazoratly-schema-test-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=test --tmpfs /var/lib/postgresql/data "$IMAGE" >/dev/null
for i in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && docker exec "$NAME" psql -U postgres -tAc "select 1" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker cp migrations "$NAME:/tmp/migrations"
docker cp tests "$NAME:/tmp/tests"

psql_file() { docker exec "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q -f "$1"; }
psql_sql()  { docker exec "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -tAc "$1"; }

up()   { for f in $(docker exec "$NAME" sh -c 'ls /tmp/migrations/*.up.sql | sort'); do echo "UP   $(basename "$f")"; psql_file "$f"; done; }
down() { for f in $(docker exec "$NAME" sh -c 'ls /tmp/migrations/*.down.sql | sort -r'); do echo "DOWN $(basename "$f")"; psql_file "$f"; done; }

echo "== cycle 1: up + tests"
up
psql_file /tmp/tests/test_schema.sql | tail -3

echo "== down: rollback everything"
psql_sql "DROP FUNCTION IF EXISTS public.t_expect(text, text)" >/dev/null
down
left_tables=$(psql_sql "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
left_funcs=$(psql_sql "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')")
left_roles=$(psql_sql "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'nazoratly_%'")
left_types=$(psql_sql "SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'd'")
echo "left after down: tables=$left_tables functions=$left_funcs roles=$left_roles domains=$left_types"
[ "$left_tables" = "0" ] && [ "$left_funcs" = "0" ] && [ "$left_roles" = "0" ] && [ "$left_types" = "0" ] || { echo "DOWN MIGRATIONS LEFT OBJECTS BEHIND"; exit 1; }

echo "== cycle 2: up again + tests"
up
psql_file /tmp/tests/test_schema.sql | tail -3
echo "== index/constraint inventory"
psql_sql "SELECT count(*) || ' tables, ' || (SELECT count(*) FROM pg_indexes WHERE schemaname='public') || ' indexes, ' || (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal) || ' triggers, ' || (SELECT count(*) FROM pg_policies) || ' policies' FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
echo "== backfill: legacy data (state before the branch migrations) through up, backfill checks, down of 0055..0050"
psql_sql "DROP FUNCTION IF EXISTS public.t_expect(text, text)" >/dev/null
down
up_until() { for f in $(docker exec "$NAME" sh -c "ls /tmp/migrations/*.up.sql | sort"); do case "$(basename "$f")" in 00[5-9][0-9]_*) ;; *) echo "UP   $(basename "$f")"; psql_file "$f";; esac; done; }
up_from()  { for f in $(docker exec "$NAME" sh -c "ls /tmp/migrations/00[5-9]*.up.sql | sort"); do echo "UP   $(basename "$f")"; psql_file "$f"; done; }
down_from() { for f in $(docker exec "$NAME" sh -c "ls /tmp/migrations/00[5-9]*.down.sql | sort -r"); do echo "DOWN $(basename "$f")"; psql_file "$f"; done; }
up_until
psql_file /tmp/tests/legacy_seed.sql >/dev/null
up_from
psql_file /tmp/tests/test_backfill.sql
down_from
psql_file /tmp/tests/test_after_down.sql
echo "== legacy backfill cycle passed"
echo "MIGRATION TESTS PASSED"
