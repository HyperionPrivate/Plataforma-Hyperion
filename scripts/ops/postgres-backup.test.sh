#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backup_script="${script_directory}/postgres-backup.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/hyperion-backup-test.XXXXXX")"
escape_root="$(mktemp -d "${TMPDIR:-/tmp}/hyperion-backup-test.escape.XXXXXX")"

cleanup() {
  if [[ -n "${test_root:-}" && -d "${test_root}" && "${test_root}" == *hyperion-backup-test.* ]]; then
    rm -rf -- "${test_root}"
  fi
  if [[ -n "${escape_root:-}" && -d "${escape_root}" && "${escape_root}" == *hyperion-backup-test.escape.* ]]; then
    rm -rf -- "${escape_root}"
  fi
}
trap cleanup EXIT

fail() {
  printf 'Test failed: %s\n' "$1" >&2
  exit 1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  [[ "${actual}" == "${expected}" ]] || fail "${label}: expected ${expected}, got ${actual}"
}

assert_no_temporaries() {
  local directory="$1"
  local temporary
  temporary="$(find "${directory}" -mindepth 1 -maxdepth 1 -type f -name '.*.tmp.*' -print -quit)"
  [[ -z "${temporary}" ]] || fail "temporary archive was not cleaned"
}

bash -n "${backup_script}" "$0"
[[ -x "${backup_script}" ]] || fail "backup script is not executable"
[[ -x "$0" ]] || fail "backup test script is not executable"
grep -F 'set -Eeuo pipefail' "${backup_script}" >/dev/null || fail "strict Bash mode is missing"
grep -F 'umask 077' "${backup_script}" >/dev/null || fail "umask 077 is missing"
grep -F 'install -d -m 700' "${backup_script}" >/dev/null || fail "directory mode enforcement is missing"
grep -F 'ln -T --' "${backup_script}" >/dev/null || fail "no-clobber publication is missing"

mock_bin="${test_root}/mock-bin"
mkdir -p -- "${mock_bin}"
cat >"${mock_bin}/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail

arguments=" $* "
if [[ "${arguments}" == *" pg_restore --list "* ]]; then
  [[ "${MOCK_RESTORE_FAIL:-0}" != "1" ]] || exit 42
  payload="$(cat)"
  [[ "${payload}" == "MOCK_CUSTOM_DUMP_V1" ]] || exit 43
  if [[ "${MOCK_ZERO_ENTRIES:-0}" == "1" ]]; then
    printf '; empty mock archive\n'
  else
    printf '; mock archive\n1; 0 0 TABLE public first postgres\n2; 0 0 TABLE public second postgres\n'
  fi
  exit 0
fi

if [[ "${arguments}" == *"pg_dump -Fc --compress=0"* ]]; then
  [[ "${MOCK_DUMP_FAIL:-0}" != "1" ]] || exit 41
  printf 'MOCK_CUSTOM_DUMP_V1'
  exit 0
fi

printf 'Unexpected docker invocation\n' >&2
exit 64
MOCK_DOCKER
chmod 700 -- "${mock_bin}/docker"

compose_file="${test_root}/docker-compose.yml"
environment_file="${test_root}/.env"
: >"${compose_file}"
: >"${environment_file}"

run_backup() {
  local directory="$1"
  local timestamp="$2"
  env \
    PATH="${mock_bin}:${PATH}" \
    HYPERION_BACKUP_DIR="${directory}" \
    HYPERION_BACKUP_TIMESTAMP="${timestamp}" \
    HYPERION_COMPOSE_FILE="${compose_file}" \
    HYPERION_ENV_FILE="${environment_file}" \
    HYPERION_BACKUP_TEST_ROOT="${test_root}" \
    HYPERION_BACKUP_TEST_MODE=1 \
    bash "${backup_script}"
}

permission_probe="${test_root}/permission-probe"
mkdir -p -- "${permission_probe}"
probe_file="${permission_probe}/file"
: >"${probe_file}"
chmod 700 -- "${permission_probe}"
chmod 600 -- "${probe_file}"
posix_permissions=true
if [[ "$(stat -c '%a' -- "${permission_probe}")" != "700" || "$(stat -c '%a' -- "${probe_file}")" != "600" ]]; then
  posix_permissions=false
fi

if [[ "${posix_permissions}" == "false" ]]; then
  cat >"${mock_bin}/install" <<'MOCK_INSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail
target="${*: -1}"
mkdir -p -- "${target}"
MOCK_INSTALL
  chmod 700 -- "${mock_bin}/install"
fi

success_directory="${test_root}/backup directory"
mkdir -p -- "${success_directory}"
existing_file="${success_directory}/existing.dump.gz"
printf 'existing' >"${existing_file}"
chmod 644 -- "${existing_file}"

success_timestamp="20260710T170000Z"
success_output="$(run_backup "${success_directory}" "${success_timestamp}")"
success_archive="${success_directory}/hyperion-${success_timestamp}.dump.gz"
[[ -s "${success_archive}" ]] || fail "successful archive is missing"
grep -F 'BACKUP_CATALOG_ENTRIES=2' <<<"${success_output}" >/dev/null || fail "catalog count was not reported"
grep -E '^BACKUP_SHA256=[a-f0-9]{64}$' <<<"${success_output}" >/dev/null || fail "SHA-256 was not reported"
assert_no_temporaries "${success_directory}"

if [[ "${posix_permissions}" == "true" ]]; then
  assert_equal "700" "$(stat -c '%a' -- "${success_directory}")" "backup directory mode"
  assert_equal "600" "$(stat -c '%a' -- "${success_archive}")" "new backup mode"
  assert_equal "600" "$(stat -c '%a' -- "${existing_file}")" "existing backup mode"
else
  printf 'POSIX permission assertions skipped on this filesystem; CI executes them on Linux.\n'
fi

original_sha="$(sha256sum -- "${success_archive}" | awk '{ print $1 }')"
if run_backup "${success_directory}" "${success_timestamp}" >/dev/null 2>&1; then
  fail "existing backup was overwritten"
fi
assert_equal "${original_sha}" "$(sha256sum -- "${success_archive}" | awk '{ print $1 }')" "existing archive hash"
assert_no_temporaries "${success_directory}"

dump_failure_directory="${test_root}/dump-failure"
if MOCK_DUMP_FAIL=1 run_backup "${dump_failure_directory}" "20260710T170001Z" >/dev/null 2>&1; then
  fail "pg_dump failure was accepted"
fi
[[ ! -e "${dump_failure_directory}/hyperion-20260710T170001Z.dump.gz" ]] || fail "dump failure left a final archive"
assert_no_temporaries "${dump_failure_directory}"

restore_failure_directory="${test_root}/restore-failure"
if MOCK_RESTORE_FAIL=1 run_backup "${restore_failure_directory}" "20260710T170002Z" >/dev/null 2>&1; then
  fail "pg_restore failure was accepted"
fi
[[ ! -e "${restore_failure_directory}/hyperion-20260710T170002Z.dump.gz" ]] || fail "restore failure left a final archive"
assert_no_temporaries "${restore_failure_directory}"

empty_catalog_directory="${test_root}/empty-catalog"
if MOCK_ZERO_ENTRIES=1 run_backup "${empty_catalog_directory}" "20260710T170003Z" >/dev/null 2>&1; then
  fail "empty pg_restore catalog was accepted"
fi
[[ ! -e "${empty_catalog_directory}/hyperion-20260710T170003Z.dump.gz" ]] || fail "empty catalog left a final archive"
assert_no_temporaries "${empty_catalog_directory}"

unsafe_directory="${TMPDIR:-/tmp}/hyperion-unsafe-backup-${RANDOM}-${RANDOM}"
[[ ! -e "${unsafe_directory}" ]] || fail "unsafe test path already exists"
if env \
  PATH="${mock_bin}:${PATH}" \
  HYPERION_BACKUP_DIR="${unsafe_directory}" \
  HYPERION_BACKUP_TIMESTAMP="20260710T170004Z" \
  HYPERION_COMPOSE_FILE="${compose_file}" \
  HYPERION_ENV_FILE="${environment_file}" \
  HYPERION_BACKUP_TEST_ROOT="${test_root}" \
  HYPERION_BACKUP_TEST_MODE=1 \
  bash "${backup_script}" >/dev/null 2>&1; then
  fail "unsafe backup directory was accepted"
fi
[[ ! -e "${unsafe_directory}" ]] || fail "unsafe backup directory was modified"

traversal_directory="${test_root}/nested/../../${escape_root##*/}/escaped-backups"
if env \
  PATH="${mock_bin}:${PATH}" \
  HYPERION_BACKUP_DIR="${traversal_directory}" \
  HYPERION_BACKUP_TIMESTAMP="20260710T170005Z" \
  HYPERION_COMPOSE_FILE="${compose_file}" \
  HYPERION_ENV_FILE="${environment_file}" \
  HYPERION_BACKUP_TEST_ROOT="${test_root}" \
  HYPERION_BACKUP_TEST_MODE=1 \
  bash "${backup_script}" >/dev/null 2>&1; then
  fail "test path traversal was accepted"
fi
[[ ! -e "${escape_root}/escaped-backups" ]] || fail "test path traversal modified its target"

symlink_directory="${test_root}/symlink-collision"
symlink_target="${test_root}/symlink-target"
mkdir -p -- "${symlink_directory}" "${symlink_target}"
symlink_timestamp="20260710T170006Z"
symlink_archive="${symlink_directory}/hyperion-${symlink_timestamp}.dump.gz"
if ln -s -- "${symlink_target}" "${symlink_archive}" 2>/dev/null && [[ -L "${symlink_archive}" ]]; then
  if run_backup "${symlink_directory}" "${symlink_timestamp}" >/dev/null 2>&1; then
    fail "symlink destination was accepted"
  fi
  [[ ! -e "${symlink_target}/.${symlink_archive##*/}" ]] || fail "backup was linked through a symlink"
fi

if [[ "$(id -u)" == "0" ]]; then
  owner_directory="${test_root}/owner-mismatch"
  mkdir -p -- "${owner_directory}"
  owner_file="${owner_directory}/existing.dump.gz"
  printf 'existing' >"${owner_file}"
  chown 1:1 -- "${owner_file}"
  if run_backup "${owner_directory}" "20260710T170007Z" >/dev/null 2>&1; then
    fail "unexpected existing owner was accepted"
  fi
  [[ ! -e "${owner_directory}/hyperion-20260710T170007Z.dump.gz" ]] || fail "owner failure left a final archive"
fi

printf 'Production backup script tests passed.\n'
