#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

fail() {
  printf 'Backup failed: %s\n' "$1" >&2
  exit 1
}

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_directory}/../.." && pwd -P)"
script_file="${script_directory}/${BASH_SOURCE[0]##*/}"
production_root="/opt/hyperion-platform"
backup_directory="${HYPERION_BACKUP_DIR:-${repository_root}/backups}"
compose_file="${HYPERION_COMPOSE_FILE:-${repository_root}/infra/docker-compose.yml}"
environment_file="${HYPERION_ENV_FILE:-${repository_root}/.env}"
timestamp_override="${HYPERION_BACKUP_TIMESTAMP:-}"
test_mode="${HYPERION_BACKUP_TEST_MODE:-0}"

[[ "${test_mode}" == "0" || "${test_mode}" == "1" ]] || fail "invalid test mode"
[[ -n "${backup_directory}" && "${backup_directory}" != "/" ]] || fail "unsafe backup directory"
[[ ! -L "${backup_directory}" ]] || fail "backup directory must not be a symbolic link"

for required_command in docker gzip sha256sum install mktemp find chmod stat ln awk id sync realpath; do
  command -v "${required_command}" >/dev/null 2>&1 || fail "required command unavailable: ${required_command}"
done

if [[ "${test_mode}" == "1" ]]; then
  [[ "${repository_root}" != "${production_root}" ]] || fail "test mode is forbidden in production"
  test_root="${HYPERION_BACKUP_TEST_ROOT:-}"
  [[ -n "${test_root}" && -d "${test_root}" && ! -L "${test_root}" ]] || fail "invalid test root"
  [[ ! -L "${compose_file}" && ! -L "${environment_file}" ]] || fail "test control files must not be symbolic links"
  test_root="$(realpath -e -- "${test_root}")"
  [[ "${test_root}" == */hyperion-backup-test.* ]] || fail "test root is not isolated"
  backup_directory="$(realpath -m -- "${backup_directory}")"
  compose_file="$(realpath -e -- "${compose_file}")"
  environment_file="$(realpath -e -- "${environment_file}")"
  [[ "${backup_directory}" == "${test_root}/"* ]] || fail "test backup directory escaped its root"
  [[ "${compose_file}" == "${test_root}/"* ]] || fail "test Compose file escaped its root"
  [[ "${environment_file}" == "${test_root}/"* ]] || fail "test environment file escaped its root"
  expected_uid="$(id -u)"
  expected_gid="$(id -g)"
  timestamp="${timestamp_override:-$(date -u +%Y%m%dT%H%M%SZ)}"
else
  ((EUID == 0)) || fail "production backups must run as root"
  [[ -z "${timestamp_override}" ]] || fail "production timestamp overrides are forbidden"
  [[ "${repository_root}" == "${production_root}" ]] || fail "production repository path must be canonical"
  [[ "${backup_directory}" == "${repository_root}/backups" ]] || fail "production backup directory must be canonical"
  [[ "${compose_file}" == "${repository_root}/infra/docker-compose.yml" ]] || fail "production Compose file must be canonical"
  [[ "${environment_file}" == "${repository_root}/.env" ]] || fail "production environment file must be canonical"
  for protected_directory in \
    "${repository_root}" \
    "${repository_root}/scripts" \
    "${script_directory}" \
    "${repository_root}/infra"; do
    [[ -d "${protected_directory}" && ! -L "${protected_directory}" ]] || fail "invalid protected directory"
    [[ "$(stat -c '%u:%g' -- "${protected_directory}")" == "0:0" ]] \
      || fail "protected directory owner must be root:root"
    protected_mode="$(stat -c '%a' -- "${protected_directory}")"
    (( (8#${protected_mode} & 8#022) == 0 )) \
      || fail "protected directory must not be writable by group or others"
  done
  for protected_file in "${script_file}" "${compose_file}" "${environment_file}"; do
    [[ -f "${protected_file}" && ! -L "${protected_file}" ]] || fail "invalid protected file"
    [[ "$(stat -c '%u:%g' -- "${protected_file}")" == "0:0" ]] \
      || fail "protected file owner must be root:root"
    [[ "$(stat -c '%h' -- "${protected_file}")" == "1" ]] \
      || fail "protected file must not have multiple hard links"
    protected_mode="$(stat -c '%a' -- "${protected_file}")"
    (( (8#${protected_mode} & 8#022) == 0 )) \
      || fail "protected file must not be writable by group or others"
  done
  environment_mode="$(stat -c '%a' -- "${environment_file}")"
  (( (8#${environment_mode} & 8#077) == 0 )) || fail "environment file permissions must be private"
  expected_uid="0"
  expected_gid="0"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
fi

[[ -f "${compose_file}" ]] || fail "Compose file not found"
[[ -f "${environment_file}" ]] || fail "environment file not found"
[[ "${timestamp}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "invalid UTC timestamp"

install -d -m 700 -- "${backup_directory}"
[[ ! -L "${backup_directory}" ]] || fail "backup directory became a symbolic link"
[[ "$(stat -c '%u:%g' -- "${backup_directory}")" == "${expected_uid}:${expected_gid}" ]] \
  || fail "backup directory has an unexpected owner"
chmod 700 -- "${backup_directory}"

while IFS= read -r -d '' existing_archive; do
  [[ "$(stat -c '%u:%g' -- "${existing_archive}")" == "${expected_uid}:${expected_gid}" ]] \
    || fail "an existing backup has an unexpected owner"
  [[ "$(stat -c '%h' -- "${existing_archive}")" == "1" ]] \
    || fail "an existing backup has multiple hard links"
  chmod 600 -- "${existing_archive}"
done < <(find "${backup_directory}" -mindepth 1 -maxdepth 1 -type f -print0)

backup_name="hyperion-${timestamp}.dump.gz"
final_archive="${backup_directory}/${backup_name}"
[[ ! -e "${final_archive}" && ! -L "${final_archive}" ]] || fail "backup already exists: ${backup_name}"

temporary_archive=""
cleanup() {
  if [[ -n "${temporary_archive:-}" && -e "${temporary_archive}" ]]; then
    rm -f -- "${temporary_archive}"
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

temporary_archive="$(mktemp "${backup_directory}/.${backup_name}.tmp.XXXXXX")"
[[ "$(stat -c '%u:%g' -- "${temporary_archive}")" == "${expected_uid}:${expected_gid}" ]] \
  || fail "temporary archive has an unexpected owner"
chmod 600 -- "${temporary_archive}"

compose=(docker compose --env-file "${environment_file}" -f "${compose_file}")

"${compose[@]}" exec -T postgres \
  sh -eu -c 'exec pg_dump -Fc --compress=0 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip -n -c >"${temporary_archive}"

[[ -s "${temporary_archive}" ]] || fail "compressed archive is empty"
gzip -t -- "${temporary_archive}"

catalog_entries="$({
  gzip -dc -- "${temporary_archive}" \
    | "${compose[@]}" exec -T postgres pg_restore --list \
    | awk 'NF && $1 !~ /^;/ { count += 1 } END { print count + 0 }'
})"
[[ "${catalog_entries}" =~ ^[0-9]+$ ]] || fail "invalid pg_restore catalog count"
((catalog_entries > 0)) || fail "pg_restore catalog is empty"

archive_size="$(stat -c '%s' -- "${temporary_archive}")"
[[ "${archive_size}" =~ ^[0-9]+$ ]] && ((archive_size > 0)) || fail "invalid archive size"

archive_sha256="$(sha256sum -- "${temporary_archive}" | awk '{ print $1 }')"
[[ "${archive_sha256}" =~ ^[a-f0-9]{64}$ ]] || fail "invalid SHA-256"

chmod 600 -- "${temporary_archive}"
temporary_identity="$(stat -c '%d:%i' -- "${temporary_archive}")"
sync -f -- "${temporary_archive}"
ln -T -- "${temporary_archive}" "${final_archive}" || fail "backup already exists: ${backup_name}"
[[ -f "${final_archive}" && ! -L "${final_archive}" ]] || fail "published backup is not a regular file"
[[ "$(stat -c '%d:%i' -- "${final_archive}")" == "${temporary_identity}" ]] \
  || fail "published backup identity mismatch"
[[ "$(stat -c '%h' -- "${final_archive}")" == "2" ]] || fail "unexpected publication link count"
rm -f -- "${temporary_archive}"
temporary_archive=""
sync -f -- "${backup_directory}"
[[ "$(stat -c '%h' -- "${final_archive}")" == "1" ]] || fail "unexpected final link count"

printf 'BACKUP_FILE=%s\n' "${backup_name}"
printf 'BACKUP_SIZE_BYTES=%s\n' "${archive_size}"
printf 'BACKUP_CATALOG_ENTRIES=%s\n' "${catalog_entries}"
printf 'BACKUP_SHA256=%s\n' "${archive_sha256}"
printf 'BACKUP_DIRECTORY_MODE=%s\n' "$(stat -c '%a' -- "${backup_directory}")"
printf 'BACKUP_DIRECTORY_OWNER=%s\n' "$(stat -c '%U:%G' -- "${backup_directory}")"
printf 'BACKUP_FILE_MODE=%s\n' "$(stat -c '%a' -- "${final_archive}")"
printf 'BACKUP_FILE_OWNER=%s\n' "$(stat -c '%U:%G' -- "${final_archive}")"
