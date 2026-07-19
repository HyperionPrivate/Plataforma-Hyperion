#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backup_hook="${script_directory}/pulso-postgres-backup.sh"
restore_hook="${script_directory}/pulso-postgres-restore.sh"
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
  printf 'PULSO PostgreSQL hook test failed: %s\n' "$1" >&2
  exit 1
}

bash -n "${backup_hook}" "${restore_hook}" "$0"
[[ -x "${backup_hook}" && -x "${restore_hook}" && -x "$0" ]] || fail "PULSO scripts must be executable"

mock_bin="${backup_root}/mock-bin"
mkdir -p -- "${mock_bin}"
cat >"${mock_bin}/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
mock_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: >"${mock_directory}/docker-invoked"
for forbidden in \
  PULSO_POSTGRES_ADMIN_PASSWORD PULSO_MIGRATOR_DATABASE_PASSWORD PULSO_DATABASE_PASSWORD \
  SOFIA_DATABASE_PASSWORD KNOWLEDGE_DATABASE_PASSWORD INTEGRATION_DATABASE_PASSWORD \
  CHANNEL_DATABASE_PASSWORD NOVA_DATABASE_PASSWORD LUMEN_DATABASE_PASSWORD; do
  [[ -z "${!forbidden+x}" ]] || exit 90
done
arguments=" $* "
if [[ "$(uname -s)" =~ ^(MINGW|MSYS|CYGWIN) ]]; then
  expected_endpoint='npipe:////./pipe/dockerDesktopLinuxEngine'
else
  expected_endpoint='unix:///var/run/docker.sock'
fi
if [[ "${arguments}" == " context show " ]]; then
  {
    printf 'HOME=%s\n' "${HOME-}"
    printf 'USERPROFILE=%s\n' "${USERPROFILE-}"
    printf 'HOMEDRIVE=%s\n' "${HOMEDRIVE-}"
    printf 'HOMEPATH=%s\n' "${HOMEPATH-}"
  } >"${mock_directory}/sanitized-docker-environment"
  printf 'pulso-test-context\n'
  exit 0
elif [[ "${arguments}" == *" context inspect pulso-test-context --format {{.Endpoints.docker.Host}} "* ]]; then
  printf '%s\n' "${expected_endpoint}"
  exit 0
fi
: >"${mock_directory}/docker-mutated"
[[ "${arguments}" == *" --host ${expected_endpoint} compose "* ]] || exit 92
[[ "${arguments}" == *" --profile pulso-ops "* ]] || exit 91
if [[ "${arguments}" == *" pg_restore --list "* ]]; then
  [[ "$(cat)" == "MOCK_PULSO_DUMP" ]] || exit 42
  printf '; archive\n1; 0 0 TABLE pulso_iris conversations hyperion_pulso_migrator\n'
elif [[ "${arguments}" == *"pg_dump -Fc --compress=0"* ]]; then
  [[ "${arguments}" == *" _ hyperion_pulso_test "* ]] || exit 43
  printf 'MOCK_PULSO_DUMP'
elif [[ "${arguments}" == *"pg_restore --clean"* ]]; then
  [[ "${arguments}" == *" hyperion_pulso_migrator hyperion_pulso_restore_drill "* ]] || exit 44
  [[ "$(cat)" == "MOCK_PULSO_DUMP" ]] || exit 45
elif [[ "${arguments}" == *"REVOKE ALL ON DATABASE"* ]]; then
  [[ "${arguments}" == *"hyperion_pulso_restore_drill"* \
    && "${arguments}" == *"FROM PUBLIC"* \
    && "${arguments}" == *"hyperion_pulso_migrator"* \
    && "${arguments}" == *"hyperion_pulso"* \
    && "${arguments}" == *"hyperion_sofia"* \
    && "${arguments}" == *"hyperion_knowledge"* \
    && "${arguments}" == *"hyperion_integration"* \
    && "${arguments}" == *"hyperion_channel"* \
    && "${arguments}" == *"REVOKE CREATE, TEMPORARY"* ]] || exit 47
elif [[ "${arguments}" == *" exec -T postgres "* ]]; then
  [[ "${arguments}" == *"hyperion_pulso_restore_drill"* \
    && "${arguments}" == *"hyperion_pulso_migrator"* ]] || exit 46
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

default_docker_environment=(
  env
  -u DOCKER_HOST
  -u DOCKER_CONTEXT
  -u DOCKER_CONFIG
  -u DOCKER_CERT_PATH
  -u DOCKER_TLS
  -u DOCKER_TLS_VERIFY
)
docker_routing_overrides=(
  DOCKER_HOST
  DOCKER_CONTEXT
  DOCKER_CONFIG
  DOCKER_CERT_PATH
  DOCKER_TLS
  DOCKER_TLS_VERIFY
)
docker_invocation_marker="${mock_bin}/docker-invoked"
docker_mutation_marker="${mock_bin}/docker-mutated"
sanitized_environment_receipt="${mock_bin}/sanitized-docker-environment"
expected_docker_context=pulso-test-context
if [[ "$(uname -s)" =~ ^(MINGW|MSYS|CYGWIN) ]]; then
  expected_docker_endpoint='npipe:////./pipe/dockerDesktopLinuxEngine'
else
  expected_docker_endpoint='unix:///var/run/docker.sock'
fi
sealed_docker_identity=(
  "PULSO_EXPECTED_DOCKER_CONTEXT=${expected_docker_context}"
  "PULSO_EXPECTED_DOCKER_ENDPOINT=${expected_docker_endpoint}"
)

exported_secrets=()
for secret in \
  PULSO_POSTGRES_ADMIN_PASSWORD=forbidden \
  PULSO_MIGRATOR_DATABASE_PASSWORD=forbidden \
  PULSO_DATABASE_PASSWORD=forbidden \
  SOFIA_DATABASE_PASSWORD=forbidden \
  KNOWLEDGE_DATABASE_PASSWORD=forbidden \
  INTEGRATION_DATABASE_PASSWORD=forbidden \
  CHANNEL_DATABASE_PASSWORD=forbidden \
  NOVA_DATABASE_PASSWORD=forbidden \
  LUMEN_DATABASE_PASSWORD=forbidden; do
  exported_secrets+=("${secret}")
done

backup_compose="${backup_root}/docker-compose.pulso-ops.yml"
backup_env="${backup_root}/.env.pulso-ops"
: >"${backup_compose}"
: >"${backup_env}"
backup_directory="${backup_root}/backups/pulso"
timestamp="20260718T120000Z"
for docker_routing_override in "${docker_routing_overrides[@]}"; do
  rm -f -- "${docker_invocation_marker}"
  if "${default_docker_environment[@]}" "${docker_routing_override}=" PATH="${mock_bin}:${PATH}" \
    "${sealed_docker_identity[@]}" \
    PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${backup_root}" \
    PULSO_OPS_COMPOSE_FILE="${backup_compose}" PULSO_OPS_ENV_FILE="${backup_env}" \
    PULSO_BACKUP_DIR="${backup_directory}" PULSO_BACKUP_TIMESTAMP="${timestamp}" \
    PULSO_POSTGRES_DB=hyperion_pulso_test bash "${backup_hook}" >/dev/null 2>&1; then
    fail "backup accepted ${docker_routing_override}"
  fi
  [[ ! -e "${docker_invocation_marker}" ]] \
    || fail "backup invoked Docker after rejecting ${docker_routing_override}"
done

backup_output="$("${default_docker_environment[@]}" PATH="${mock_bin}:${PATH}" "${sealed_docker_identity[@]}" \
  "${exported_secrets[@]}" \
  PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${backup_root}" \
  PULSO_OPS_COMPOSE_FILE="${backup_compose}" PULSO_OPS_ENV_FILE="${backup_env}" \
  PULSO_BACKUP_DIR="${backup_directory}" PULSO_BACKUP_TIMESTAMP="${timestamp}" \
  PULSO_POSTGRES_DB=hyperion_pulso_test bash "${backup_hook}")"
backup_archive="${backup_directory}/pulso-${timestamp}.dump.gz"
[[ -s "${backup_archive}" ]] || fail "PULSO archive was not created"
grep -F 'BACKUP_PROFILE=pulso' <<<"${backup_output}" >/dev/null || fail "backup profile missing"
grep -F 'BACKUP_DATABASE=hyperion_pulso_test' <<<"${backup_output}" >/dev/null || fail "backup database missing"
grep -E '^BACKUP_SHA256=[a-f0-9]{64}$' <<<"${backup_output}" >/dev/null || fail "backup SHA missing"
[[ -f "${sanitized_environment_receipt}" ]] || fail "sanitized Docker environment receipt missing"
if [[ "$(uname -s)" =~ ^(MINGW|MSYS|CYGWIN) ]]; then
  expected_sanitized_home="$(cygpath -u -a -- "${USERPROFILE}")"
  grep -Fx "HOME=${expected_sanitized_home}" "${sanitized_environment_receipt}" >/dev/null \
    || fail "sanitized Windows HOME differs from USERPROFILE"
  grep -Fx "USERPROFILE=${USERPROFILE}" "${sanitized_environment_receipt}" >/dev/null \
    || fail "sanitized Docker environment lost USERPROFILE"
  grep -Fx "HOMEDRIVE=${HOMEDRIVE}" "${sanitized_environment_receipt}" >/dev/null \
    || fail "sanitized Docker environment lost HOMEDRIVE"
  grep -Fx "HOMEPATH=${HOMEPATH}" "${sanitized_environment_receipt}" >/dev/null \
    || fail "sanitized Docker environment lost HOMEPATH"
else
  grep -Fx "HOME=${HOME}" "${sanitized_environment_receipt}" >/dev/null \
    || fail "sanitized Docker environment lost HOME"
  grep -Fx 'USERPROFILE=' "${sanitized_environment_receipt}" >/dev/null \
    || fail "sanitized Unix Docker environment inherited USERPROFILE"
fi

rm -f -- "${docker_mutation_marker}"
if "${default_docker_environment[@]}" PATH="${mock_bin}:${PATH}" \
  PULSO_EXPECTED_DOCKER_CONTEXT=pulso-other-context \
  PULSO_EXPECTED_DOCKER_ENDPOINT="${expected_docker_endpoint}" \
  PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${backup_root}" \
  PULSO_OPS_COMPOSE_FILE="${backup_compose}" PULSO_OPS_ENV_FILE="${backup_env}" \
  PULSO_BACKUP_DIR="${backup_directory}" PULSO_BACKUP_TIMESTAMP=20260718T120001Z \
  PULSO_POSTGRES_DB=hyperion_pulso_test bash "${backup_hook}" >/dev/null 2>&1; then
  fail "backup accepted a Docker context different from the runner seal"
fi
[[ ! -e "${docker_mutation_marker}" ]] || fail "backup mutated Docker after a context seal mismatch"

rm -f -- "${docker_invocation_marker}" "${docker_mutation_marker}"
if "${default_docker_environment[@]}" PATH="${mock_bin}:${PATH}" \
  PULSO_EXPECTED_DOCKER_CONTEXT="${expected_docker_context}" \
  PULSO_EXPECTED_DOCKER_ENDPOINT=ssh://remote.example/run/docker.sock \
  PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${backup_root}" \
  PULSO_OPS_COMPOSE_FILE="${backup_compose}" PULSO_OPS_ENV_FILE="${backup_env}" \
  PULSO_BACKUP_DIR="${backup_directory}" PULSO_BACKUP_TIMESTAMP=20260718T120001Z \
  PULSO_POSTGRES_DB=hyperion_pulso_test bash "${backup_hook}" >/dev/null 2>&1; then
  fail "backup accepted a remote Docker endpoint"
fi
[[ ! -e "${docker_invocation_marker}" && ! -e "${docker_mutation_marker}" ]] \
  || fail "backup invoked Docker after rejecting a remote endpoint"

if "${default_docker_environment[@]}" PATH="${mock_bin}:${PATH}" "${sealed_docker_identity[@]}" \
  PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${backup_root}" \
  PULSO_OPS_COMPOSE_FILE="${backup_compose}" PULSO_OPS_ENV_FILE="${backup_env}" \
  PULSO_BACKUP_DIR="${backup_directory}" PULSO_BACKUP_TIMESTAMP=20260718T120001Z \
  PULSO_POSTGRES_DB=hyperion bash "${backup_hook}" >/dev/null 2>&1; then
  fail "backup accepted a non-PULSO database"
fi

restore_compose="${restore_root}/docker-compose.pulso-ops.yml"
restore_env="${restore_root}/.env.pulso-ops"
restore_directory="${restore_root}/backups/pulso"
mkdir -p -- "${restore_directory}"
: >"${restore_compose}"
: >"${restore_env}"
restore_archive="${restore_directory}/${backup_archive##*/}"
cp -- "${backup_archive}" "${restore_archive}"
restore_sha="$(sha256sum -- "${restore_archive}" | awk '{ print $1 }')"
restore_database=hyperion_pulso_restore_drill
confirmation="RESTORE PULSO ${restore_database} SHA256 ${restore_sha}"
for docker_routing_override in "${docker_routing_overrides[@]}"; do
  rm -f -- "${docker_invocation_marker}"
  if "${default_docker_environment[@]}" "${docker_routing_override}=" PATH="${mock_bin}:${PATH}" \
    "${sealed_docker_identity[@]}" \
    PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${restore_root}" \
    PULSO_OPS_COMPOSE_FILE="${restore_compose}" PULSO_OPS_ENV_FILE="${restore_env}" \
    PULSO_BACKUP_DIR="${restore_directory}" PULSO_RESTORE_ARCHIVE="${restore_archive}" \
    PULSO_RESTORE_DATABASE="${restore_database}" PULSO_RESTORE_SHA256="${restore_sha}" \
    PULSO_RESTORE_CONFIRM="${confirmation}" bash "${restore_hook}" >/dev/null 2>&1; then
    fail "restore accepted ${docker_routing_override}"
  fi
  [[ ! -e "${docker_invocation_marker}" ]] \
    || fail "restore invoked Docker after rejecting ${docker_routing_override}"
done

rm -f -- "${docker_mutation_marker}"
if "${default_docker_environment[@]}" PATH="${mock_bin}:${PATH}" \
  PULSO_EXPECTED_DOCKER_CONTEXT="${expected_docker_context}" \
  PULSO_EXPECTED_DOCKER_ENDPOINT="${expected_docker_endpoint}-other" \
  PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${restore_root}" \
  PULSO_OPS_COMPOSE_FILE="${restore_compose}" PULSO_OPS_ENV_FILE="${restore_env}" \
  PULSO_BACKUP_DIR="${restore_directory}" PULSO_RESTORE_ARCHIVE="${restore_archive}" \
  PULSO_RESTORE_DATABASE="${restore_database}" PULSO_RESTORE_SHA256="${restore_sha}" \
  PULSO_RESTORE_CONFIRM="${confirmation}" bash "${restore_hook}" >/dev/null 2>&1; then
  fail "restore accepted a Docker endpoint different from the runner seal"
fi
[[ ! -e "${docker_mutation_marker}" ]] || fail "restore mutated Docker after an endpoint seal mismatch"

restore_output="$("${default_docker_environment[@]}" PATH="${mock_bin}:${PATH}" "${sealed_docker_identity[@]}" \
  "${exported_secrets[@]}" HYPERION_RESTORE_OWNER=forbidden \
  PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${restore_root}" \
  PULSO_OPS_COMPOSE_FILE="${restore_compose}" PULSO_OPS_ENV_FILE="${restore_env}" \
  PULSO_BACKUP_DIR="${restore_directory}" PULSO_RESTORE_ARCHIVE="${restore_archive}" \
  PULSO_RESTORE_DATABASE="${restore_database}" PULSO_RESTORE_SHA256="${restore_sha}" \
  PULSO_RESTORE_CONFIRM="${confirmation}" bash "${restore_hook}")"
grep -F 'RESTORE_PROFILE=pulso' <<<"${restore_output}" >/dev/null || fail "restore profile missing"
grep -F 'RESTORE_OWNER=hyperion_pulso_migrator' <<<"${restore_output}" >/dev/null || fail "restore owner missing"
grep -F "RESTORE_SHA256=${restore_sha}" <<<"${restore_output}" >/dev/null || fail "restore SHA missing"

if "${default_docker_environment[@]}" PATH="${mock_bin}:${PATH}" "${sealed_docker_identity[@]}" \
  PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${restore_root}" \
  PULSO_OPS_COMPOSE_FILE="${restore_compose}" PULSO_OPS_ENV_FILE="${restore_env}" \
  PULSO_BACKUP_DIR="${restore_directory}" PULSO_RESTORE_ARCHIVE="${restore_archive}" \
  PULSO_RESTORE_DATABASE="${restore_database}" PULSO_RESTORE_SHA256="${restore_sha}" \
  PULSO_RESTORE_CONFIRM='RESTORE PULSO' bash "${restore_hook}" >/dev/null 2>&1; then
  fail "restore accepted a non-exact confirmation"
fi

wrong_sha="$(printf '0%.0s' {1..63})1"
if "${default_docker_environment[@]}" PATH="${mock_bin}:${PATH}" "${sealed_docker_identity[@]}" \
  PULSO_OPS_TEST_MODE=1 PULSO_OPS_TEST_ROOT="${restore_root}" \
  PULSO_OPS_COMPOSE_FILE="${restore_compose}" PULSO_OPS_ENV_FILE="${restore_env}" \
  PULSO_BACKUP_DIR="${restore_directory}" PULSO_RESTORE_ARCHIVE="${restore_archive}" \
  PULSO_RESTORE_DATABASE="${restore_database}" PULSO_RESTORE_SHA256="${wrong_sha}" \
  PULSO_RESTORE_CONFIRM="RESTORE PULSO ${restore_database} SHA256 ${wrong_sha}" \
  bash "${restore_hook}" >/dev/null 2>&1; then
  fail "restore accepted an incorrect archive SHA"
fi

printf 'PULSO PostgreSQL backup/restore hooks passed.\n'
