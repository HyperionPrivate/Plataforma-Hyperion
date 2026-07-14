#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
restore_script="${script_directory}/postgres-restore.sh"
offsite_script="${script_directory}/postgres-offsite-copy.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/hyperion-restore-test.XXXXXX")"

cleanup() {
  if [[ -n "${test_root:-}" && -d "${test_root}" && "${test_root}" == *hyperion-restore-test.* ]]; then
    rm -rf -- "${test_root}"
  fi
}
trap cleanup EXIT

fail() {
  printf 'Restore test failed: %s\n' "$1" >&2
  exit 1
}

bash -n "${restore_script}" "$0" "${offsite_script}"
[[ -x "${restore_script}" ]] || fail "restore script is not executable"
[[ -x "${offsite_script}" ]] || fail "offsite stub is not executable"
grep -F 'HYPERION_RESTORE_CONFIRM' "${restore_script}" >/dev/null || fail "restore confirmation gate is missing"
grep -F 'HYPERION_OFFSITE_COPY_COMMAND' "${offsite_script}" >/dev/null || fail "offsite command hook is missing"

mock_bin="${test_root}/mock-bin"
mkdir -p -- "${mock_bin}"
cat >"${mock_bin}/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
arguments=" $* "
if [[ "${arguments}" == *" pg_restore --list "* ]]; then
  payload="$(cat)"
  [[ "${payload}" == "MOCK_CUSTOM_DUMP_V1" ]] || exit 43
  printf '; mock archive\n1; 0 0 TABLE public first postgres\n'
  exit 0
fi
if [[ "${arguments}" == *" pg_restore "* ]]; then
  payload="$(cat)"
  [[ "${payload}" == "MOCK_CUSTOM_DUMP_V1" ]] || exit 44
  printf 'MOCK_RESTORE_OK\n' >&2
  exit 0
fi
if [[ "${arguments}" == *" exec -T postgres "* ]]; then
  # drop/create or other admin SQL against the approved target database
  exit 0
fi
printf 'Unexpected docker invocation: %s\n' "${arguments}" >&2
exit 64
MOCK_DOCKER
chmod 700 -- "${mock_bin}/docker"

compose_file="${test_root}/docker-compose.yml"
environment_file="${test_root}/.env"
archive="${test_root}/hyperion-20260713T120000Z.dump.gz"
: >"${compose_file}"
: >"${environment_file}"
printf 'MOCK_CUSTOM_DUMP_V1' | gzip -n -c >"${archive}"
expected_sha="$(sha256sum -- "${archive}" | awk '{ print $1 }')"

output="$(
  env \
    PATH="${mock_bin}:${PATH}" \
    HYPERION_RESTORE_TEST_MODE=1 \
    HYPERION_RESTORE_TEST_ROOT="${test_root}" \
    HYPERION_COMPOSE_FILE="${compose_file}" \
    HYPERION_ENV_FILE="${environment_file}" \
    HYPERION_RESTORE_ARCHIVE="${archive}" \
    HYPERION_RESTORE_DATABASE="hyperion_restore_probe" \
    HYPERION_RESTORE_CONFIRM="RESTORE hyperion_restore_probe" \
    HYPERION_RESTORE_SHA256="${expected_sha}" \
    bash "${restore_script}"
)"

grep -F 'RESTORE_DATABASE=hyperion_restore_probe' <<<"${output}" >/dev/null || fail "restore database was not reported"
grep -F "RESTORE_SHA256=${expected_sha}" <<<"${output}" >/dev/null || fail "restore SHA was not reported"

if env \
  PATH="${mock_bin}:${PATH}" \
  HYPERION_RESTORE_TEST_MODE=1 \
  HYPERION_RESTORE_TEST_ROOT="${test_root}" \
  HYPERION_COMPOSE_FILE="${compose_file}" \
  HYPERION_ENV_FILE="${environment_file}" \
  HYPERION_RESTORE_ARCHIVE="${archive}" \
  HYPERION_RESTORE_DATABASE="hyperion_restore_probe" \
  HYPERION_RESTORE_CONFIRM="yes" \
  bash "${restore_script}" >/dev/null 2>&1; then
  fail "missing confirmation was accepted"
fi

if HYPERION_OFFSITE_ARCHIVE="${archive}" bash "${offsite_script}" >/dev/null 2>&1; then
  fail "offsite stub must fail closed without a transport"
fi

copied_marker="${test_root}/offsite-copied"
cat >"${mock_bin}/fake-offsite" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "\$1" >"${copied_marker}"
EOF
chmod 700 -- "${mock_bin}/fake-offsite"

HYPERION_OFFSITE_ARCHIVE="${archive}" \
  HYPERION_OFFSITE_COPY_COMMAND="${mock_bin}/fake-offsite" \
  PATH="${mock_bin}:${PATH}" \
  bash "${offsite_script}"
[[ -f "${copied_marker}" ]] || fail "offsite transport was not invoked"

printf 'Production restore and offsite stub tests passed.\n'
