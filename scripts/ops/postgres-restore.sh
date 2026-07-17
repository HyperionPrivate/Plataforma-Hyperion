#!/usr/bin/env bash

# Controlled PostgreSQL restore into an explicitly approved destination.
# Never restores onto a live production volume without HYPERION_RESTORE_CONFIRM.

set -Eeuo pipefail

umask 077

fail() {
  printf 'Restore failed: %s\n' "$1" >&2
  exit 1
}

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_directory}/../.." && pwd -P)"
production_root="/opt/hyperion-platform"
compose_file="${HYPERION_COMPOSE_FILE:-${repository_root}/infra/docker-compose.yml}"
environment_file="${HYPERION_ENV_FILE:-${repository_root}/.env}"
backup_archive="${HYPERION_RESTORE_ARCHIVE:-}"
target_database="${HYPERION_RESTORE_DATABASE:-}"
confirm="${HYPERION_RESTORE_CONFIRM:-}"
test_mode="${HYPERION_RESTORE_TEST_MODE:-0}"
expected_sha256="${HYPERION_RESTORE_SHA256:-}"

[[ "${test_mode}" == "0" || "${test_mode}" == "1" ]] || fail "invalid test mode"

for required_command in docker gzip sha256sum mktemp find chmod stat realpath; do
  command -v "${required_command}" >/dev/null 2>&1 || fail "required command unavailable: ${required_command}"
done

[[ -n "${backup_archive}" ]] || fail "HYPERION_RESTORE_ARCHIVE is required"
[[ -n "${target_database}" ]] || fail "HYPERION_RESTORE_DATABASE is required"
[[ "${target_database}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "unsafe restore database name"
[[ "${confirm}" == "RESTORE ${target_database}" ]] || fail "HYPERION_RESTORE_CONFIRM must equal 'RESTORE <database>'"

if [[ "${test_mode}" == "1" ]]; then
  [[ "${repository_root}" != "${production_root}" ]] || fail "test mode is forbidden in production"
  test_root="${HYPERION_RESTORE_TEST_ROOT:-}"
  [[ -n "${test_root}" && -d "${test_root}" && ! -L "${test_root}" ]] || fail "invalid test root"
  test_root="$(realpath -e -- "${test_root}")"
  [[ "${test_root}" == */hyperion-restore-test.* ]] || fail "test root is not isolated"
  backup_archive="$(realpath -e -- "${backup_archive}")"
  compose_file="$(realpath -e -- "${compose_file}")"
  environment_file="$(realpath -e -- "${environment_file}")"
  [[ "${backup_archive}" == "${test_root}/"* ]] || fail "restore archive escaped its root"
  [[ "${compose_file}" == "${test_root}/"* ]] || fail "test Compose file escaped its root"
  [[ "${environment_file}" == "${test_root}/"* ]] || fail "test environment file escaped its root"
else
  ((EUID == 0)) || fail "production restores must run as root"
  [[ "${repository_root}" == "${production_root}" ]] || fail "production repository path must be canonical"
  [[ "${compose_file}" == "${repository_root}/infra/docker-compose.yml" ]] || fail "production Compose file must be canonical"
  [[ "${environment_file}" == "${repository_root}/.env" ]] || fail "production environment file must be canonical"
  backup_archive="$(realpath -e -- "${backup_archive}")"
  [[ "${backup_archive}" == "${repository_root}/backups/"* ]] || fail "production restore archive must live under backups/"
fi

[[ -f "${backup_archive}" && ! -L "${backup_archive}" ]] || fail "restore archive must be a regular file"
[[ -f "${compose_file}" && ! -L "${compose_file}" ]] || fail "Compose file not found"
[[ -f "${environment_file}" && ! -L "${environment_file}" ]] || fail "environment file not found"

gzip -t -- "${backup_archive}" || fail "archive failed gzip integrity check"
archive_sha256="$(sha256sum -- "${backup_archive}" | awk '{ print $1 }')"
[[ "${archive_sha256}" =~ ^[a-f0-9]{64}$ ]] || fail "invalid SHA-256"
if [[ -n "${expected_sha256}" && "${expected_sha256}" != "${archive_sha256}" ]]; then
  fail "archive SHA-256 does not match HYPERION_RESTORE_SHA256"
fi

compose=(docker compose --env-file "${environment_file}" -f "${compose_file}")

catalog_entries="$({
  gzip -dc -- "${backup_archive}" \
    | "${compose[@]}" exec -T postgres pg_restore --list \
    | awk 'NF && $1 !~ /^;/ { count += 1 } END { print count + 0 }'
})"
[[ "${catalog_entries}" =~ ^[0-9]+$ ]] || fail "invalid pg_restore catalog count"
((catalog_entries > 0)) || fail "pg_restore catalog is empty"

# Drop and recreate only the explicitly confirmed target database, then restore.
# The target name was already validated as a safe SQL identifier above.
"${compose[@]}" exec -T postgres \
  sh -eu -c "
psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d postgres <<SQL
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname = '${target_database}'
   AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS \"${target_database}\";
CREATE DATABASE \"${target_database}\" OWNER \"\$POSTGRES_USER\";
SQL
"

gzip -dc -- "${backup_archive}" \
  | "${compose[@]}" exec -T postgres \
    pg_restore --clean --if-exists --no-owner --role="${POSTGRES_USER:-hyperion}" -U "${POSTGRES_USER:-hyperion}" -d "${target_database}"

printf 'RESTORE_FILE=%s\n' "$(basename -- "${backup_archive}")"
printf 'RESTORE_DATABASE=%s\n' "${target_database}"
printf 'RESTORE_CATALOG_ENTRIES=%s\n' "${catalog_entries}"
printf 'RESTORE_SHA256=%s\n' "${archive_sha256}"
