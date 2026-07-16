#!/usr/bin/env bash
# Backup technical PostgreSQL databases (architecture foundation).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
: "${POSTGRES_USER:=coopfuturo_admin}"
: "${POSTGRES_HOST:=127.0.0.1}"
: "${POSTGRES_PORT:=5432}"

for db in db_pilot_core db_whatsapp db_documents db_handoff; do
  file="$OUT/${db}_${STAMP}.sql"
  echo "backing up $db -> $file"
  PGPASSWORD="${POSTGRES_PASSWORD:?}" pg_dump -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" "$db" >"$file"
done
echo "backup complete under $OUT"
echo "RPO proposed: 24h | RTO proposed: 4h (pending approval)"
echo "NOTE (AUD-022): also run backup_ops_sqlite.sh — Postgres alone omits Ops SQLite state"
