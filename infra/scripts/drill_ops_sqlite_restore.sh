#!/usr/bin/env bash
# AUD2-008: non-destructive restore drill — backup → temp restore → schema check.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${1:-$ROOT/backups/ops_drill_$$}"
mkdir -p "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

export PULSO_DATA_DIR="${PULSO_DATA_DIR:-$ROOT/data/pulso}"
mkdir -p "$PULSO_DATA_DIR"
# Ensure a minimal sqlite file exists for the drill when empty.
if [[ ! -f "$PULSO_DATA_DIR/pulso_ops.sqlite3" ]]; then
  python - <<'PY'
import os, sqlite3
from pathlib import Path
p = Path(os.environ["PULSO_DATA_DIR"]) / "pulso_ops.sqlite3"
conn = sqlite3.connect(p)
conn.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
conn.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('drill','1')")
conn.commit()
conn.close()
print("seeded", p)
PY
fi

bash "$ROOT/infra/scripts/backup_ops_sqlite.sh" "$WORK/bak"
LATEST="$(ls -1d "$WORK/bak"/ops_* | tail -n1)"
RESTORE_DIR="$WORK/restore"
mkdir -p "$RESTORE_DIR"
DB_SRC="$LATEST/pulso_ops.backup.sqlite3"
[[ -f "$DB_SRC" ]] || DB_SRC="$LATEST/pulso_ops.sqlite3"
cp -f "$DB_SRC" "$RESTORE_DIR/pulso_ops.sqlite3"
python - <<PY
import sqlite3
from pathlib import Path
db = Path(r"$RESTORE_DIR") / "pulso_ops.sqlite3"
conn = sqlite3.connect(db)
# Must open and list tables
tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
assert tables, "restored db has no tables"
conn.close()
print("DRILL_OK tables=", sorted(tables)[:12])
PY
