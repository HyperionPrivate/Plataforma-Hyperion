#!/usr/bin/env bash
# Mock object storage backup — copies local MinIO/mock directory if present.
set -euo pipefail
SRC="${OBJECT_STORE_PATH:-./data/object-store}"
OUT="${1:-./backups/objects}"
mkdir -p "$OUT"
if [[ -d "$SRC" ]]; then
  cp -a "$SRC" "$OUT/object-store-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "object store copied"
else
  echo "no object store at $SRC (ok for architecture foundation without MinIO yet)"
fi
