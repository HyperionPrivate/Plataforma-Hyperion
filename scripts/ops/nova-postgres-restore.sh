#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

fail() {
  printf 'NOVA restore failed: %s\n' "$1" >&2
  exit 1
}

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_directory}/../.." && pwd -P)"
script_file="${script_directory}/${BASH_SOURCE[0]##*/}"
restore_script="${script_directory}/postgres-restore.sh"
test_mode="${NOVA_OPS_TEST_MODE:-0}"
archive="${NOVA_RESTORE_ARCHIVE:-}"
target_database="${NOVA_RESTORE_DATABASE:-}"
expected_sha256="${NOVA_RESTORE_SHA256:-}"
confirmation="${NOVA_RESTORE_CONFIRM:-}"

[[ "${test_mode}" == "0" || "${test_mode}" == "1" ]] || fail "invalid test mode"
[[ "${target_database}" =~ ^hyperion_nova(_[a-z0-9_]+)?$ ]] \
  || fail "NOVA_RESTORE_DATABASE must explicitly name a hyperion_nova logical database"
[[ "${expected_sha256}" =~ ^[a-f0-9]{64}$ && ! "${expected_sha256}" =~ ^0{64}$ ]] \
  || fail "NOVA_RESTORE_SHA256 must be an exact non-zero SHA-256"
expected_confirmation="RESTORE NOVA ${target_database} SHA256 ${expected_sha256}"
[[ "${confirmation}" == "${expected_confirmation}" ]] \
  || fail "NOVA_RESTORE_CONFIRM must equal '${expected_confirmation}'"
[[ -f "${restore_script}" && ! -L "${restore_script}" ]] || fail "base restore script is unavailable"
for required_command in bash env realpath sha256sum awk stat; do
  command -v "${required_command}" >/dev/null 2>&1 || fail "required command unavailable: ${required_command}"
done

if [[ "${test_mode}" == "1" ]]; then
  test_root="${NOVA_OPS_TEST_ROOT:-}"
  [[ -n "${test_root}" ]] || fail "NOVA_OPS_TEST_ROOT is required in test mode"
  backup_directory="${NOVA_BACKUP_DIR:-${test_root}/backups/nova}"
  compose_file="${NOVA_OPS_COMPOSE_FILE:-}"
  environment_file="${NOVA_OPS_ENV_FILE:-}"
  [[ -n "${compose_file}" && -n "${environment_file}" ]] \
    || fail "test mode requires NOVA_OPS_COMPOSE_FILE and NOVA_OPS_ENV_FILE"
else
  test_root=""
  backup_directory="${repository_root}/backups/nova"
  compose_file="${repository_root}/infra/docker-compose.nova-ops.yml"
  environment_file="${repository_root}/.env.nova-ops"
  [[ -f "${script_file}" && ! -L "${script_file}" ]] || fail "wrapper must be a regular file"
  [[ "$(stat -c '%u:%g' -- "${script_file}")" == "0:0" ]] || fail "wrapper owner must be root:root"
  [[ "$(stat -c '%h' -- "${script_file}")" == "1" ]] || fail "wrapper must not have multiple hard links"
  wrapper_mode="$(stat -c '%a' -- "${script_file}")"
  (( (8#${wrapper_mode} & 8#022) == 0 )) || fail "wrapper must not be writable by group or others"
fi

[[ "${backup_directory}" == */nova ]] || fail "NOVA restores must use the dedicated nova backup directory"
[[ -n "${archive}" ]] || fail "NOVA_RESTORE_ARCHIVE is required"
archive="$(realpath -e -- "${archive}")"
backup_directory="$(realpath -m -- "${backup_directory}")"
[[ "${archive}" == "${backup_directory}/"* ]] || fail "restore archive is outside the NOVA backup directory"
[[ "$(basename -- "${archive}")" =~ ^nova-[0-9]{8}T[0-9]{6}Z\.dump\.gz$ ]] \
  || fail "NOVA restore archive must use the nova-<UTC timestamp>.dump.gz name"
actual_sha256="$(sha256sum -- "${archive}" | awk '{ print $1 }')"
[[ "${actual_sha256}" == "${expected_sha256}" ]] || fail "restore archive SHA-256 does not match NOVA_RESTORE_SHA256"

sanitized_environment=(env -i "PATH=${PATH}" "HOME=${HOME:-/}" "LANG=C" "LC_ALL=C" "TZ=UTC")
if [[ "${test_mode}" == "1" && "$(uname -s)" =~ ^(MINGW|MSYS|CYGWIN) && -n "${PROGRAMFILES:-}" ]]; then
  # Docker Desktop discovers CLI plugins (including Compose) below ProgramFiles.
  # Preserve only that locator in the otherwise empty Windows drill environment.
  sanitized_environment+=("PROGRAMFILES=${PROGRAMFILES}")
fi

exec "${sanitized_environment[@]}" \
  HYPERION_RESTORE_PROFILE=nova \
  HYPERION_RESTORE_ARCHIVE="${archive}" \
  HYPERION_RESTORE_DATABASE="${target_database}" \
  HYPERION_RESTORE_OWNER=hyperion_nova_migrator \
  HYPERION_RESTORE_SHA256="${expected_sha256}" \
  HYPERION_RESTORE_CONFIRM="${expected_confirmation}" \
  HYPERION_COMPOSE_FILE="${compose_file}" \
  HYPERION_ENV_FILE="${environment_file}" \
  HYPERION_RESTORE_TEST_MODE="${test_mode}" \
  HYPERION_RESTORE_TEST_ROOT="${test_root}" \
  bash "${restore_script}"
