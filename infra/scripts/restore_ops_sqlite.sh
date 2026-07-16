#!/usr/bin/env bash
# AUD2-008: restore Ops SQLite + documents from a backup_ops_sqlite.sh destination.
# Destructive — stops writing by copying into the live data dir / container.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${1:-}"
if [[ -z "$SRC" || ! -d "$SRC" ]]; then
  echo "Usage: $0 <backup_dir_from_backup_ops_sqlite.sh>" >&2
  exit 2
fi
if [[ ! -f "$SRC/pulso_ops.sqlite3" && ! -f "$SRC/pulso_ops.backup.sqlite3" ]]; then
  echo "ERROR: no pulso_ops.sqlite3 (or .backup) in $SRC" >&2
  exit 1
fi

CONTAINER="${PILOT_CORE_CONTAINER:-pulso-pilot-core-1}"
DATA_IN_CONTAINER="${PULSO_DATA_DIR_IN_CONTAINER:-/data}"
DB_SRC="$SRC/pulso_ops.backup.sqlite3"
[[ -f "$DB_SRC" ]] || DB_SRC="$SRC/pulso_ops.sqlite3"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Restoring into $CONTAINER:$DATA_IN_CONTAINER (destructive)"
  docker cp "$DB_SRC" "$CONTAINER:$DATA_IN_CONTAINER/pulso_ops.sqlite3"
  if [[ -d "$SRC/documents" ]]; then
    docker cp "$SRC/documents/." "$CONTAINER:$DATA_IN_CONTAINER/documents/" 2>/dev/null || true
  fi
  echo "restore complete — restart pilot-core and hit /ready"
else
  HOST_DATA="${PULSO_DATA_DIR:-$ROOT/data/pulso}"
  mkdir -p "$HOST_DATA"
  cp -f "$DB_SRC" "$HOST_DATA/pulso_ops.sqlite3"
  echo "host restore complete -> $HOST_DATA/pulso_ops.sqlite3"
fi
