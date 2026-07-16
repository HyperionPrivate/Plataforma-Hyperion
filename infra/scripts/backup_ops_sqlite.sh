#!/usr/bin/env bash
# AUD-022: backup functional Ops SQLite + local documents tree (PULSO_DATA_DIR).
# Prefer docker volume copy; falls back to host path.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/backups/ops}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

CONTAINER="${PILOT_CORE_CONTAINER:-pulso-pilot-core-1}"
DATA_IN_CONTAINER="${PULSO_DATA_DIR_IN_CONTAINER:-/data}"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  DEST="$OUT/ops_${STAMP}"
  mkdir -p "$DEST"
  echo "copying $CONTAINER:$DATA_IN_CONTAINER -> $DEST"
  docker cp "$CONTAINER:$DATA_IN_CONTAINER/." "$DEST/"
  # Consistent SQLite snapshot if sqlite3 is available in the container.
  if docker exec "$CONTAINER" sh -c "command -v sqlite3 >/dev/null && test -f $DATA_IN_CONTAINER/pulso_ops.sqlite3"; then
    docker exec "$CONTAINER" sqlite3 "$DATA_IN_CONTAINER/pulso_ops.sqlite3" ".backup '$DATA_IN_CONTAINER/pulso_ops.backup.sqlite3'" || true
    docker cp "$CONTAINER:$DATA_IN_CONTAINER/pulso_ops.backup.sqlite3" "$DEST/pulso_ops.backup.sqlite3" 2>/dev/null || true
  fi
  echo "ops sqlite/documents backup complete -> $DEST"
else
  HOST_DATA="${PULSO_DATA_DIR:-$ROOT/data/pulso}"
  if [[ -d "$HOST_DATA" ]]; then
    DEST="$OUT/ops_${STAMP}"
    mkdir -p "$DEST"
    cp -a "$HOST_DATA/." "$DEST/"
    echo "host ops data copied -> $DEST"
  else
    echo "ERROR: neither container $CONTAINER nor host path $HOST_DATA found" >&2
    exit 1
  fi
fi
echo "RPO proposed: 24h | include this path in restore drills (AUD-022)"
