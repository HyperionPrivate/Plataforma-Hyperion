#!/usr/bin/env bash

# Stub: offsite copy requires external infrastructure. See docs/ops/OFFSITE-BACKUP.md.

set -Eeuo pipefail

fail() {
  printf 'Offsite copy failed: %s\n' "$1" >&2
  exit 1
}

archive="${HYPERION_OFFSITE_ARCHIVE:-${1:-}}"
[[ -n "${archive}" ]] || fail "HYPERION_OFFSITE_ARCHIVE (or argv[1]) is required"
[[ -f "${archive}" && ! -L "${archive}" ]] || fail "offsite source must be a regular file"

if [[ -n "${HYPERION_OFFSITE_COPY_COMMAND:-}" ]]; then
  # Operator-supplied transport (rclone, aws s3 cp, scp wrapper, etc.).
  # The command receives the archive path as $1.
  # shellcheck disable=SC2086
  exec ${HYPERION_OFFSITE_COPY_COMMAND} "${archive}"
fi

fail "no offsite transport configured. Set HYPERION_OFFSITE_COPY_COMMAND to an external copy tool, or integrate the host backup agent. See docs/ops/OFFSITE-BACKUP.md"
