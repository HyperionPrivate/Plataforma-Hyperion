#!/usr/bin/env bash
# Restore a single technical database dump.
set -euo pipefail
DB="${1:?db name}"
FILE="${2:?dump file}"
: "${POSTGRES_USER:=coopfuturo_admin}"
: "${POSTGRES_HOST:=127.0.0.1}"
: "${POSTGRES_PORT:=5432}"
PGPASSWORD="${POSTGRES_PASSWORD:?}" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$DB" -f "$FILE"
echo "restored $FILE into $DB"
