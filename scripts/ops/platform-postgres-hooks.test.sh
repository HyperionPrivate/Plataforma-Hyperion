#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backup_root="$(mktemp -d "${TMPDIR:-/tmp}/hyperion-backup-test.XXXXXX")"
restore_root="$(mktemp -d "${TMPDIR:-/tmp}/hyperion-restore-test.XXXXXX")"

cleanup() {
  [[ -n "${backup_root:-}" && -d "${backup_root}" && "${backup_root}" == *hyperion-backup-test.* ]] \
    && rm -rf -- "${backup_root}"
  [[ -n "${restore_root:-}" && -d "${restore_root}" && "${restore_root}" == *hyperion-restore-test.* ]] \
    && rm -rf -- "${restore_root}"
}
trap cleanup EXIT

fail() {
  printf 'Platform PostgreSQL hook test failed: %s\n' "$1" >&2
  exit 1
}

scripts=(
  "${script_directory}/access-postgres-backup.sh"
  "${script_directory}/access-postgres-restore.sh"
  "${script_directory}/audit-postgres-backup.sh"
  "${script_directory}/audit-postgres-restore.sh"
  "$0"
)
bash -n "${scripts[@]}"
for script in "${scripts[@]}"; do
  [[ -x "${script}" ]] || fail "${script##*/} must be executable"
done

mock_bin="${backup_root}/mock-bin"
mkdir -p -- "${mock_bin}"
cat >"${mock_bin}/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ -z "${NOVA_DATABASE_PASSWORD+x}" && -z "${LUMEN_DATABASE_PASSWORD+x}" \
  && -z "${PULSO_DATABASE_PASSWORD+x}" && -z "${IDENTITY_DATABASE_PASSWORD+x}" \
  && -z "${TENANT_DATABASE_PASSWORD+x}" && -z "${AUDIT_DATABASE_PASSWORD+x}" ]] || exit 90
arguments=" $* "
if [[ "${arguments}" == *" --profile access-ops "* ]]; then
  provider=access
  dump=MOCK_ACCESS_DUMP
  source_database=hyperion_access_test
  restore_database=hyperion_access_restore_drill
  owner=hyperion_access_migrator
elif [[ "${arguments}" == *" --profile audit-ops "* ]]; then
  provider=audit
  dump=MOCK_AUDIT_DUMP
  source_database=hyperion_audit_test
  restore_database=hyperion_audit_restore_drill
  owner=hyperion_audit_migrator
else
  exit 91
fi
if [[ "${arguments}" == *" pg_restore --list "* ]]; then
  [[ "$(cat)" == "${dump}" ]] || exit 42
  printf '; archive\n1; 0 0 TABLE platform recovery %s\n' "${owner}"
elif [[ "${arguments}" == *"pg_dump -Fc --compress=0"* ]]; then
  [[ "${arguments}" == *" _ ${source_database} "* ]] || exit 43
  printf '%s' "${dump}"
elif [[ "${arguments}" == *"pg_restore --clean"* ]]; then
  [[ "${arguments}" == *" ${owner} ${restore_database} "* ]] || exit 44
  [[ "$(cat)" == "${dump}" ]] || exit 45
elif [[ "${arguments}" == *" exec -T postgres "* ]]; then
  [[ "${arguments}" == *"${restore_database}"* && "${arguments}" == *"${owner}"* \
    && "${arguments}" == *"REVOKE ALL ON DATABASE"* && "${arguments}" == *"FROM PUBLIC"* \
    && "${arguments}" == *"REVOKE CREATE, TEMPORARY"* ]] || exit 46
else
  printf 'Unexpected docker invocation: %s\n' "${arguments}" >&2
  exit 64
fi
MOCK_DOCKER
chmod 700 -- "${mock_bin}/docker"

cat >"${mock_bin}/install" <<'MOCK_INSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail
target="${*: -1}"
mkdir -p -- "${target}"
MOCK_INSTALL
chmod 700 -- "${mock_bin}/install"

run_provider() {
  local provider="$1"
  local prefix="$2"
  local source_database="$3"
  local restore_database="$4"
  local owner="$5"
  local timestamp="$6"
  local backup_hook="${script_directory}/${provider}-postgres-backup.sh"
  local restore_hook="${script_directory}/${provider}-postgres-restore.sh"
  local backup_compose="${backup_root}/docker-compose.${provider}-ops.yml"
  local backup_env="${backup_root}/.${provider}-ops.env"
  local backup_directory="${backup_root}/backups/${provider}"
  local restore_compose="${restore_root}/docker-compose.${provider}-ops.yml"
  local restore_env="${restore_root}/.${provider}-ops.env"
  local restore_directory="${restore_root}/backups/${provider}"
  : >"${backup_compose}"
  : >"${backup_env}"
  : >"${restore_compose}"
  : >"${restore_env}"

  local backup_output
  backup_output="$(env PATH="${mock_bin}:${PATH}" NOVA_DATABASE_PASSWORD=forbidden \
    LUMEN_DATABASE_PASSWORD=forbidden PULSO_DATABASE_PASSWORD=forbidden \
    IDENTITY_DATABASE_PASSWORD=forbidden TENANT_DATABASE_PASSWORD=forbidden AUDIT_DATABASE_PASSWORD=forbidden \
    "${prefix}_OPS_TEST_MODE=1" "${prefix}_OPS_TEST_ROOT=${backup_root}" \
    "${prefix}_OPS_COMPOSE_FILE=${backup_compose}" "${prefix}_OPS_ENV_FILE=${backup_env}" \
    "${prefix}_BACKUP_DIR=${backup_directory}" "${prefix}_BACKUP_TIMESTAMP=${timestamp}" \
    "${prefix}_POSTGRES_DB=${source_database}" bash "${backup_hook}")"
  local backup_archive="${backup_directory}/${provider}-${timestamp}.dump.gz"
  [[ -s "${backup_archive}" ]] || fail "${provider} archive was not created"
  grep -F "BACKUP_PROFILE=${provider}" <<<"${backup_output}" >/dev/null || fail "${provider} backup profile missing"
  grep -F "BACKUP_DATABASE=${source_database}" <<<"${backup_output}" >/dev/null \
    || fail "${provider} backup database missing"
  grep -E '^BACKUP_SHA256=[a-f0-9]{64}$' <<<"${backup_output}" >/dev/null \
    || fail "${provider} backup SHA missing"

  if env PATH="${mock_bin}:${PATH}" "${prefix}_OPS_TEST_MODE=1" "${prefix}_OPS_TEST_ROOT=${backup_root}" \
    "${prefix}_OPS_COMPOSE_FILE=${backup_compose}" "${prefix}_OPS_ENV_FILE=${backup_env}" \
    "${prefix}_BACKUP_DIR=${backup_directory}" "${prefix}_BACKUP_TIMESTAMP=20260718T210001Z" \
    "${prefix}_POSTGRES_DB=hyperion" bash "${backup_hook}" >/dev/null 2>&1; then
    fail "${provider} backup accepted a foreign database namespace"
  fi

  mkdir -p -- "${restore_directory}"
  local restore_archive="${restore_directory}/${backup_archive##*/}"
  cp -- "${backup_archive}" "${restore_archive}"
  local restore_sha
  restore_sha="$(sha256sum -- "${restore_archive}" | awk '{ print $1 }')"
  local confirmation="RESTORE ${prefix} ${restore_database} SHA256 ${restore_sha}"
  local restore_output
  restore_output="$(env PATH="${mock_bin}:${PATH}" NOVA_DATABASE_PASSWORD=forbidden \
    LUMEN_DATABASE_PASSWORD=forbidden PULSO_DATABASE_PASSWORD=forbidden \
    IDENTITY_DATABASE_PASSWORD=forbidden TENANT_DATABASE_PASSWORD=forbidden AUDIT_DATABASE_PASSWORD=forbidden \
    HYPERION_RESTORE_OWNER=forbidden "${prefix}_OPS_TEST_MODE=1" \
    "${prefix}_OPS_TEST_ROOT=${restore_root}" "${prefix}_OPS_COMPOSE_FILE=${restore_compose}" \
    "${prefix}_OPS_ENV_FILE=${restore_env}" "${prefix}_BACKUP_DIR=${restore_directory}" \
    "${prefix}_RESTORE_ARCHIVE=${restore_archive}" "${prefix}_RESTORE_DATABASE=${restore_database}" \
    "${prefix}_RESTORE_SHA256=${restore_sha}" "${prefix}_RESTORE_CONFIRM=${confirmation}" \
    bash "${restore_hook}")"
  grep -F "RESTORE_PROFILE=${provider}" <<<"${restore_output}" >/dev/null || fail "${provider} restore profile missing"
  grep -F "RESTORE_OWNER=${owner}" <<<"${restore_output}" >/dev/null || fail "${provider} restore owner missing"
  grep -F "RESTORE_SHA256=${restore_sha}" <<<"${restore_output}" >/dev/null || fail "${provider} restore SHA missing"

  if env PATH="${mock_bin}:${PATH}" "${prefix}_OPS_TEST_MODE=1" "${prefix}_OPS_TEST_ROOT=${restore_root}" \
    "${prefix}_OPS_COMPOSE_FILE=${restore_compose}" "${prefix}_OPS_ENV_FILE=${restore_env}" \
    "${prefix}_BACKUP_DIR=${restore_directory}" "${prefix}_RESTORE_ARCHIVE=${restore_archive}" \
    "${prefix}_RESTORE_DATABASE=${restore_database}" "${prefix}_RESTORE_SHA256=${restore_sha}" \
    "${prefix}_RESTORE_CONFIRM=RESTORE ${prefix}" bash "${restore_hook}" >/dev/null 2>&1; then
    fail "${provider} restore accepted a non-exact confirmation"
  fi
}

run_provider access ACCESS hyperion_access_test hyperion_access_restore_drill hyperion_access_migrator 20260718T210000Z
run_provider audit AUDIT hyperion_audit_test hyperion_audit_restore_drill hyperion_audit_migrator 20260718T210100Z

printf 'Access and Audit PostgreSQL backup/restore hooks passed.\n'
