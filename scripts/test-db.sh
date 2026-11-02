#!/usr/bin/env bash
# Runs tests/db/*.test.mts against a REAL Postgres (the unit suite stubs Prisma).
#
#   npm run test:db                         # throwaway postgres:17-alpine container via Docker
#   TEST_DATABASE_URL=postgresql://... npm run test:db   # an existing DISPOSABLE database
#
# The tests TRUNCATE tables, so the harness (tests/db/_harness.mts) refuses a
# database whose name does not contain "test" or "ci". Never point this at a real one.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=""
cleanup() { [ -n "$NAME" ] && docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  command -v docker >/dev/null || { echo "docker not found; set TEST_DATABASE_URL to a disposable database" >&2; exit 1; }
  NAME="summonarr-testdb-$$"
  docker run -d --rm --name "$NAME" -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=summonarr_test \
    -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
  PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
  # The image restarts postgres once during init, so one successful query is not enough: require two in a row.
  ok=0
  for _ in $(seq 1 60); do
    if docker exec "$NAME" psql -U test -d summonarr_test -qtAc 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); else ok=0; fi
    [ "$ok" -ge 2 ] && break
    sleep 1
  done
  [ "$ok" -ge 2 ] || { echo "postgres did not become ready" >&2; exit 1; }
  TEST_DATABASE_URL="postgresql://test:test@127.0.0.1:${PORT}/summonarr_test?schema=public"
fi

export DATABASE_URL="$TEST_DATABASE_URL"
npx prisma db push >/dev/null
# One file at a time: the tests share one database and truncate between cases.
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/_loader.mjs --test --test-concurrency=1 tests/db/*.test.mts
