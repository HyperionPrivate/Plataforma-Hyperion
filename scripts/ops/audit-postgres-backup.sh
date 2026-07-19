#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

fail() {
  printf 'Audit backup failed: %s\n' "$1" >&2
  exit 1
}

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_directory}/../.." && pwd -P)"
script_file="${script_directory}/${BASH_SOURCE[0]##*/}"
backup_script="${script_directory}/postgres-backup.sh"
test_mode="${AUDIT_OPS_TEST_MODE:-0}"
database="${AUDIT_POSTGRES_DB:-}"

[[ "${test_mode}" == "0" || "${test_mode}" == "1" ]] || fail "invalid test mode"
[[ "${database}" =~ ^hyperion_audit(_[a-z0-9_]+)?$ ]] \
  || fail "AUDIT_POSTGRES_DB must explicitly name a hyperion_audit logical database"
[[ -f "${backup_script}" && ! -L "${backup_script}" ]] || fail "base backup script is unavailable"
for required_command in bash env stat; do
  command -v "${required_command}" >/dev/null 2>&1 || fail "required command unavailable: ${required_command}"
done

if [[ "${test_mode}" == "1" ]]; then
  test_root="${AUDIT_OPS_TEST_ROOT:-}"
  [[ -n "${test_root}" ]] || fail "AUDIT_OPS_TEST_ROOT is required in test mode"
  backup_directory="${AUDIT_BACKUP_DIR:-${test_root}/backups/audit}"
  compose_file="${AUDIT_OPS_COMPOSE_FILE:-}"
  environment_file="${AUDIT_OPS_ENV_FILE:-}"
  timestamp="${AUDIT_BACKUP_TIMESTAMP:-}"
  [[ -n "${compose_file}" && -n "${environment_file}" ]] \
    || fail "test mode requires AUDIT_OPS_COMPOSE_FILE and AUDIT_OPS_ENV_FILE"
else
  test_root=""
  backup_directory="${repository_root}/backups/audit"
  compose_file="${repository_root}/infra/docker-compose.audit-ops.yml"
  environment_file="${repository_root}/.env.audit-ops"
  timestamp=""
  [[ -f "${script_file}" && ! -L "${script_file}" ]] || fail "wrapper must be a regular file"
  [[ "$(stat -c '%u:%g' -- "${script_file}")" == "0:0" ]] || fail "wrapper owner must be root:root"
  [[ "$(stat -c '%h' -- "${script_file}")" == "1" ]] || fail "wrapper must not have multiple hard links"
  wrapper_mode="$(stat -c '%a' -- "${script_file}")"
  (( (8#${wrapper_mode} & 8#022) == 0 )) || fail "wrapper must not be writable by group or others"
fi

[[ "${backup_directory}" == */audit ]] || fail "Audit backups must use a dedicated audit directory"

sanitized_environment=(env -i "PATH=${PATH}" "HOME=${HOME:-/}" "LANG=C" "LC_ALL=C" "TZ=UTC")
if [[ "${test_mode}" == "1" && "$(uname -s)" =~ ^(MINGW|MSYS|CYGWIN) && -n "${PROGRAMFILES:-}" ]]; then
  sanitized_environment+=("PROGRAMFILES=${PROGRAMFILES}")
fi

exec "${sanitized_environment[@]}" \
  HYPERION_BACKUP_PROFILE=audit \
  HYPERION_BACKUP_DATABASE="${database}" \
  HYPERION_BACKUP_PREFIX=audit \
  HYPERION_BACKUP_DIR="${backup_directory}" \
  HYPERION_COMPOSE_FILE="${compose_file}" \
  HYPERION_ENV_FILE="${environment_file}" \
  HYPERION_BACKUP_TEST_MODE="${test_mode}" \
  HYPERION_BACKUP_TEST_ROOT="${test_root}" \
  HYPERION_BACKUP_TIMESTAMP="${timestamp}" \
  bash "${backup_script}"
