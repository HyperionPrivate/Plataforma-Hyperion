#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backup_hook="${script_directory}/lumen-postgres-backup.sh"
restore_hook="${script_directory}/lumen-postgres-restore.sh"
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
  printf 'LUMEN PostgreSQL hook test failed: %s\n' "$1" >&2
  exit 1
}

bash -n "${backup_hook}" "${restore_hook}" "$0"
[[ -x "${backup_hook}" && -x "${restore_hook}" && -x "$0" ]] || fail "LUMEN scripts must be executable"

mock_bin="${backup_root}/mock-bin"
mkdir -p -- "${mock_bin}"
cat >"${mock_bin}/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ -z "${PULSO_DATABASE_PASSWORD+x}" && -z "${NOVA_DATABASE_PASSWORD+x}" \
  && -z "${LUMEN_DATABASE_PASSWORD+x}" ]] || exit 90
arguments=" $* "
[[ "${arguments}" == *" --profile lumen-ops "* ]] || exit 91
if [[ "${arguments}" == *" pg_restore --list "* ]]; then
  [[ "$(cat)" == "MOCK_LUMEN_DUMP" ]] || exit 42
  printf '; archive\n1; 0 0 TABLE lumen encounters hyperion_lumen_migrator\n'
elif [[ "${arguments}" == *"pg_dump -Fc --compress=0"* ]]; then
  [[ "${arguments}" == *" _ hyperion_lumen_test "* ]] || exit 43
  printf 'MOCK_LUMEN_DUMP'
elif [[ "${arguments}" == *"pg_restore --clean"* ]]; then
  [[ "${arguments}" == *" hyperion_lumen_migrator hyperion_lumen_restore_drill "* ]] || exit 44
  [[ "$(cat)" == "MOCK_LUMEN_DUMP" ]] || exit 45
elif [[ "${arguments}" == *"REVOKE ALL ON DATABASE"* ]]; then
  [[ "${arguments}" == *"hyperion_lumen_restore_drill"* \
    && "${arguments}" == *"FROM PUBLIC"* \
    && "${arguments}" == *"hyperion_lumen_migrator"* \
    && "${arguments}" == *"hyperion_lumen"* \
    && "${arguments}" == *"REVOKE CREATE, TEMPORARY"* ]] || exit 47
elif [[ "${arguments}" == *" exec -T postgres "* ]]; then
  [[ "${arguments}" == *"hyperion_lumen_restore_drill"* \
    && "${arguments}" == *"hyperion_lumen_migrator"* ]] || exit 46
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

backup_compose="${backup_root}/docker-compose.lumen-ops.yml"
backup_env="${backup_root}/.env.lumen-ops"
: >"${backup_compose}"
: >"${backup_env}"
backup_directory="${backup_root}/backups/lumen"
timestamp="20260718T120000Z"
backup_output="$(env PATH="${mock_bin}:${PATH}" PULSO_DATABASE_PASSWORD=forbidden NOVA_DATABASE_PASSWORD=forbidden \
  LUMEN_DATABASE_PASSWORD=forbidden LUMEN_OPS_TEST_MODE=1 LUMEN_OPS_TEST_ROOT="${backup_root}" \
  LUMEN_OPS_COMPOSE_FILE="${backup_compose}" LUMEN_OPS_ENV_FILE="${backup_env}" \
  LUMEN_BACKUP_DIR="${backup_directory}" LUMEN_BACKUP_TIMESTAMP="${timestamp}" \
  LUMEN_POSTGRES_DB=hyperion_lumen_test bash "${backup_hook}")"
backup_archive="${backup_directory}/lumen-${timestamp}.dump.gz"
[[ -s "${backup_archive}" ]] || fail "LUMEN archive was not created"
grep -F 'BACKUP_PROFILE=lumen' <<<"${backup_output}" >/dev/null || fail "backup profile missing"
grep -F 'BACKUP_DATABASE=hyperion_lumen_test' <<<"${backup_output}" >/dev/null || fail "backup database missing"
grep -E '^BACKUP_SHA256=[a-f0-9]{64}$' <<<"${backup_output}" >/dev/null || fail "backup SHA missing"

if env PATH="${mock_bin}:${PATH}" LUMEN_OPS_TEST_MODE=1 LUMEN_OPS_TEST_ROOT="${backup_root}" \
  LUMEN_OPS_COMPOSE_FILE="${backup_compose}" LUMEN_OPS_ENV_FILE="${backup_env}" \
  LUMEN_BACKUP_DIR="${backup_directory}" LUMEN_BACKUP_TIMESTAMP=20260718T120001Z LUMEN_POSTGRES_DB=hyperion \
  bash "${backup_hook}" >/dev/null 2>&1; then
  fail "backup accepted a non-LUMEN database"
fi

restore_compose="${restore_root}/docker-compose.lumen-ops.yml"
restore_env="${restore_root}/.env.lumen-ops"
restore_directory="${restore_root}/backups/lumen"
mkdir -p -- "${restore_directory}"
: >"${restore_compose}"
: >"${restore_env}"
restore_archive="${restore_directory}/${backup_archive##*/}"
cp -- "${backup_archive}" "${restore_archive}"
restore_sha="$(sha256sum -- "${restore_archive}" | awk '{ print $1 }')"
restore_database=hyperion_lumen_restore_drill
confirmation="RESTORE LUMEN ${restore_database} SHA256 ${restore_sha}"
restore_output="$(env PATH="${mock_bin}:${PATH}" PULSO_DATABASE_PASSWORD=forbidden NOVA_DATABASE_PASSWORD=forbidden \
  LUMEN_DATABASE_PASSWORD=forbidden HYPERION_RESTORE_OWNER=forbidden \
  LUMEN_OPS_TEST_MODE=1 LUMEN_OPS_TEST_ROOT="${restore_root}" \
  LUMEN_OPS_COMPOSE_FILE="${restore_compose}" LUMEN_OPS_ENV_FILE="${restore_env}" \
  LUMEN_BACKUP_DIR="${restore_directory}" LUMEN_RESTORE_ARCHIVE="${restore_archive}" \
  LUMEN_RESTORE_DATABASE="${restore_database}" LUMEN_RESTORE_SHA256="${restore_sha}" \
  LUMEN_RESTORE_CONFIRM="${confirmation}" bash "${restore_hook}")"
grep -F 'RESTORE_PROFILE=lumen' <<<"${restore_output}" >/dev/null || fail "restore profile missing"
grep -F 'RESTORE_OWNER=hyperion_lumen_migrator' <<<"${restore_output}" >/dev/null || fail "restore owner missing"
grep -F "RESTORE_SHA256=${restore_sha}" <<<"${restore_output}" >/dev/null || fail "restore SHA missing"

if env PATH="${mock_bin}:${PATH}" LUMEN_OPS_TEST_MODE=1 LUMEN_OPS_TEST_ROOT="${restore_root}" \
  LUMEN_OPS_COMPOSE_FILE="${restore_compose}" LUMEN_OPS_ENV_FILE="${restore_env}" \
  LUMEN_BACKUP_DIR="${restore_directory}" LUMEN_RESTORE_ARCHIVE="${restore_archive}" \
  LUMEN_RESTORE_DATABASE="${restore_database}" LUMEN_RESTORE_SHA256="${restore_sha}" \
  LUMEN_RESTORE_CONFIRM='RESTORE LUMEN' bash "${restore_hook}" >/dev/null 2>&1; then
  fail "restore accepted a non-exact confirmation"
fi

wrong_sha="$(printf '0%.0s' {1..63})1"
if env PATH="${mock_bin}:${PATH}" LUMEN_OPS_TEST_MODE=1 LUMEN_OPS_TEST_ROOT="${restore_root}" \
  LUMEN_OPS_COMPOSE_FILE="${restore_compose}" LUMEN_OPS_ENV_FILE="${restore_env}" \
  LUMEN_BACKUP_DIR="${restore_directory}" LUMEN_RESTORE_ARCHIVE="${restore_archive}" \
  LUMEN_RESTORE_DATABASE="${restore_database}" LUMEN_RESTORE_SHA256="${wrong_sha}" \
  LUMEN_RESTORE_CONFIRM="RESTORE LUMEN ${restore_database} SHA256 ${wrong_sha}" \
  bash "${restore_hook}" >/dev/null 2>&1; then
  fail "restore accepted an incorrect archive SHA"
fi

printf 'LUMEN PostgreSQL backup/restore hooks passed.\n'
