#!/bin/bash
# No shared/deployed database: one bounded, disposable PG16 per invocation.
set -euo pipefail
cd "$(dirname "$0")/.."
id=$(docker run --rm -d --memory 1g --cpus 1 \
  -e POSTGRES_PASSWORD=synthetic-test-only \
  -p 127.0.0.1::5432 postgres:16-bookworm@sha256:0ea6700a3b4f0ae6ce746519073558aed4d88a79d8d07622a9a644946c7319c4)
trap 'docker rm -f "$id" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
ready=0
for ((i=0; i<60; i++)); do
  # The image's temporary init server listens only on a unix socket. Probe the
  # main TCP listener inside the container (5432), not its mapped host port.
  if docker exec "$id" pg_isready -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo 'disposable PostgreSQL failed to start' >&2; exit 1; fi
port=$(docker port "$id" 5432/tcp)
export ABELE_TEST_PG_URL="postgres://postgres:synthetic-test-only@${port}/postgres"
node scripts/test-sql.mjs "$@"
