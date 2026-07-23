#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

fail() {
  printf 'PULSO restore failed: %s\n' "$1" >&2
  exit 1
}

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_directory}/../.." && pwd -P)"
script_file="${script_directory}/${BASH_SOURCE[0]##*/}"
restore_script="${script_directory}/postgres-restore.sh"
test_mode="${PULSO_OPS_TEST_MODE:-0}"
archive="${PULSO_RESTORE_ARCHIVE:-}"
target_database="${PULSO_RESTORE_DATABASE:-}"
expected_sha256="${PULSO_RESTORE_SHA256:-}"
confirmation="${PULSO_RESTORE_CONFIRM:-}"
expected_docker_context="${PULSO_EXPECTED_DOCKER_CONTEXT:-}"
expected_docker_endpoint="${PULSO_EXPECTED_DOCKER_ENDPOINT:-}"

docker_routing_overrides=(
  DOCKER_HOST
  DOCKER_CONTEXT
  DOCKER_CONFIG
  DOCKER_CERT_PATH
  DOCKER_TLS
  DOCKER_TLS_VERIFY
)
for docker_routing_override in "${docker_routing_overrides[@]}"; do
  [[ -z "${!docker_routing_override+x}" ]] \
    || fail "${docker_routing_override} must be unset; PULSO operations use the default Docker context through HOME"
done

[[ "${test_mode}" == "0" || "${test_mode}" == "1" ]] || fail "invalid test mode"
[[ "${expected_docker_context}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
  || fail "PULSO_EXPECTED_DOCKER_CONTEXT must be an exact safe context name"
[[ -n "${expected_docker_endpoint}" && ${#expected_docker_endpoint} -le 2048 \
  && "${expected_docker_endpoint}" != *$'\n'* && "${expected_docker_endpoint}" != *$'\r'* ]] \
  || fail "PULSO_EXPECTED_DOCKER_ENDPOINT must be an exact single-line endpoint"
[[ "${target_database}" =~ ^hyperion_pulso(_[a-z0-9_]+)?$ ]] \
  || fail "PULSO_RESTORE_DATABASE must explicitly name a hyperion_pulso logical database"
[[ "${expected_sha256}" =~ ^[a-f0-9]{64}$ && ! "${expected_sha256}" =~ ^0{64}$ ]] \
  || fail "PULSO_RESTORE_SHA256 must be an exact non-zero SHA-256"
expected_confirmation="RESTORE PULSO ${target_database} SHA256 ${expected_sha256}"
[[ "${confirmation}" == "${expected_confirmation}" ]] \
  || fail "PULSO_RESTORE_CONFIRM must equal '${expected_confirmation}'"
[[ -f "${restore_script}" && ! -L "${restore_script}" ]] || fail "base restore script is unavailable"
for required_command in bash docker env realpath sha256sum awk stat uname; do
  command -v "${required_command}" >/dev/null 2>&1 || fail "required command unavailable: ${required_command}"
done

if [[ "${test_mode}" == "1" ]]; then
  test_root="${PULSO_OPS_TEST_ROOT:-}"
  [[ -n "${test_root}" ]] || fail "PULSO_OPS_TEST_ROOT is required in test mode"
  backup_directory="${PULSO_BACKUP_DIR:-${test_root}/backups/pulso}"
  compose_file="${PULSO_OPS_COMPOSE_FILE:-}"
  environment_file="${PULSO_OPS_ENV_FILE:-}"
  [[ -n "${compose_file}" && -n "${environment_file}" ]] \
    || fail "test mode requires PULSO_OPS_COMPOSE_FILE and PULSO_OPS_ENV_FILE"
else
  test_root=""
  backup_directory="${repository_root}/backups/pulso"
  compose_file="${repository_root}/infra/docker-compose.pulso-ops.yml"
  environment_file="${repository_root}/.env.pulso-ops"
  [[ -f "${script_file}" && ! -L "${script_file}" ]] || fail "wrapper must be a regular file"
  [[ "$(stat -c '%u:%g' -- "${script_file}")" == "0:0" ]] || fail "wrapper owner must be root:root"
  [[ "$(stat -c '%h' -- "${script_file}")" == "1" ]] || fail "wrapper must not have multiple hard links"
  wrapper_mode="$(stat -c '%a' -- "${script_file}")"
  (( (8#${wrapper_mode} & 8#022) == 0 )) || fail "wrapper must not be writable by group or others"
fi

[[ "${backup_directory}" == */pulso ]] || fail "PULSO restores must use the dedicated pulso backup directory"
[[ -n "${archive}" ]] || fail "PULSO_RESTORE_ARCHIVE is required"
archive="$(realpath -e -- "${archive}")"
backup_directory="$(realpath -m -- "${backup_directory}")"
[[ "${archive}" == "${backup_directory}/"* ]] || fail "restore archive is outside the PULSO backup directory"
[[ "$(basename -- "${archive}")" =~ ^pulso-[0-9]{8}T[0-9]{6}Z\.dump\.gz$ ]] \
  || fail "PULSO restore archive must use the pulso-<UTC timestamp>.dump.gz name"
actual_sha256="$(sha256sum -- "${archive}" | awk '{ print $1 }')"
[[ "${actual_sha256}" == "${expected_sha256}" ]] || fail "restore archive SHA-256 does not match PULSO_RESTORE_SHA256"

platform="$(uname -s)"
sanitized_environment=(env -i "PATH=${PATH}" "LANG=C" "LC_ALL=C" "TZ=UTC")
if [[ "${platform}" =~ ^(MINGW|MSYS|CYGWIN) ]]; then
  command -v cygpath >/dev/null 2>&1 || fail "cygpath is required to seal the Windows Docker home"
  [[ "${expected_docker_endpoint}" == npipe://* ]] \
    || fail "PULSO restore requires a local npipe:// Docker endpoint on Windows"
  for windows_home_variable in USERPROFILE HOMEDRIVE HOMEPATH; do
    [[ -n "${!windows_home_variable:-}" && "${!windows_home_variable}" != *$'\n'* \
      && "${!windows_home_variable}" != *$'\r'* ]] \
      || fail "${windows_home_variable} must be set to seal the Windows Docker home"
  done
  [[ "${USERPROFILE}" =~ ^[A-Za-z]:[\\/].+ && "${HOMEDRIVE}" =~ ^[A-Za-z]:$ \
    && "${HOMEPATH}" =~ ^[\\/] ]] || fail "Windows Docker home variables are malformed"
  normalized_userprofile="${USERPROFILE//\\//}"
  normalized_legacy_home="${HOMEDRIVE}${HOMEPATH}"
  normalized_legacy_home="${normalized_legacy_home//\\//}"
  normalized_userprofile="${normalized_userprofile%/}"
  normalized_legacy_home="${normalized_legacy_home%/}"
  [[ "${normalized_userprofile,,}" == "${normalized_legacy_home,,}" \
    && "${normalized_userprofile}" != *"/../"* && "${normalized_userprofile}" != */.. ]] \
    || fail "Windows Docker home variables do not identify the same canonical home"
  sanitized_home="$(cygpath -u -a -- "${USERPROFILE}")"
  [[ "${sanitized_home}" == /* && "${sanitized_home}" != *$'\n'* && "${sanitized_home}" != *$'\r'* ]] \
    || fail "could not canonicalize the Windows Docker home"
  sanitized_environment+=(
    "HOME=${sanitized_home}"
    "USERPROFILE=${USERPROFILE}"
    "HOMEDRIVE=${HOMEDRIVE}"
    "HOMEPATH=${HOMEPATH}"
  )
  if [[ "${test_mode}" == "1" && -n "${PROGRAMFILES:-}" ]]; then
    sanitized_environment+=("PROGRAMFILES=${PROGRAMFILES}")
  fi
else
  [[ -n "${HOME:-}" && "${HOME}" == /* && "${HOME}" != *$'\n'* && "${HOME}" != *$'\r'* ]] \
    || fail "HOME must be an absolute path to seal the Docker client configuration"
  [[ "${expected_docker_endpoint}" == unix://* ]] \
    || fail "PULSO restore requires a local unix:// Docker endpoint"
  sanitized_environment+=("HOME=${HOME}")
fi

actual_docker_context="$("${sanitized_environment[@]}" docker context show)" \
  || fail "could not resolve Docker context in the sanitized environment"
[[ "${actual_docker_context}" == "${expected_docker_context}" ]] \
  || fail "sanitized Docker context differs from the runner seal"
actual_docker_endpoint="$("${sanitized_environment[@]}" docker context inspect "${actual_docker_context}" \
  --format '{{.Endpoints.docker.Host}}')" \
  || fail "could not resolve Docker endpoint in the sanitized environment"
[[ "${actual_docker_endpoint}" == "${expected_docker_endpoint}" ]] \
  || fail "sanitized Docker endpoint differs from the runner seal"

exec "${sanitized_environment[@]}" \
  HYPERION_RESTORE_PROFILE=pulso \
  HYPERION_RESTORE_ARCHIVE="${archive}" \
  HYPERION_RESTORE_DATABASE="${target_database}" \
  HYPERION_RESTORE_OWNER=hyperion_pulso_migrator \
  HYPERION_RESTORE_SHA256="${expected_sha256}" \
  HYPERION_RESTORE_CONFIRM="${expected_confirmation}" \
  HYPERION_COMPOSE_FILE="${compose_file}" \
  HYPERION_ENV_FILE="${environment_file}" \
  HYPERION_RESTORE_TEST_MODE="${test_mode}" \
  HYPERION_RESTORE_TEST_ROOT="${test_root}" \
  HYPERION_DOCKER_CONTEXT="${expected_docker_context}" \
  HYPERION_DOCKER_ENDPOINT="${expected_docker_endpoint}" \
  bash "${restore_script}"
