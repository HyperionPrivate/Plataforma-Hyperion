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
script_file="${script_directory}/${BASH_SOURCE[0]##*/}"
production_root="/opt/hyperion-platform"
restore_profile="${HYPERION_RESTORE_PROFILE:-platform}"
if [[ "${restore_profile}" == "access" ]]; then
  default_compose_file="${repository_root}/infra/docker-compose.access-ops.yml"
  default_environment_file="${repository_root}/.env.access-ops"
  default_target_owner="hyperion_access_migrator"
elif [[ "${restore_profile}" == "audit" ]]; then
  default_compose_file="${repository_root}/infra/docker-compose.audit-ops.yml"
  default_environment_file="${repository_root}/.env.audit-ops"
  default_target_owner="hyperion_audit_migrator"
elif [[ "${restore_profile}" == "nova" ]]; then
  default_compose_file="${repository_root}/infra/docker-compose.nova-ops.yml"
  default_environment_file="${repository_root}/.env.nova-ops"
  default_target_owner="hyperion_nova_migrator"
elif [[ "${restore_profile}" == "lumen" ]]; then
  default_compose_file="${repository_root}/infra/docker-compose.lumen-ops.yml"
  default_environment_file="${repository_root}/.env.lumen-ops"
  default_target_owner="hyperion_lumen_migrator"
elif [[ "${restore_profile}" == "pulso" ]]; then
  default_compose_file="${repository_root}/infra/docker-compose.pulso-ops.yml"
  default_environment_file="${repository_root}/.env.pulso-ops"
  default_target_owner="hyperion_pulso_migrator"
else
  default_compose_file="${repository_root}/infra/docker-compose.yml"
  default_environment_file="${repository_root}/.env"
  default_target_owner="${POSTGRES_USER:-hyperion}"
fi
compose_file="${HYPERION_COMPOSE_FILE:-${default_compose_file}}"
environment_file="${HYPERION_ENV_FILE:-${default_environment_file}}"
backup_archive="${HYPERION_RESTORE_ARCHIVE:-}"
target_database="${HYPERION_RESTORE_DATABASE:-}"
confirm="${HYPERION_RESTORE_CONFIRM:-}"
test_mode="${HYPERION_RESTORE_TEST_MODE:-0}"
expected_sha256="${HYPERION_RESTORE_SHA256:-}"
target_owner="${HYPERION_RESTORE_OWNER:-${default_target_owner}}"
docker_context="${HYPERION_DOCKER_CONTEXT:-}"
docker_endpoint="${HYPERION_DOCKER_ENDPOINT:-}"

[[ "${test_mode}" == "0" || "${test_mode}" == "1" ]] || fail "invalid test mode"
[[ "${restore_profile}" == "platform" || "${restore_profile}" == "access" || "${restore_profile}" == "audit" \
  || "${restore_profile}" == "nova" || "${restore_profile}" == "lumen" || "${restore_profile}" == "pulso" ]] \
  || fail "invalid restore profile"

for required_command in docker gzip sha256sum mktemp find chmod stat realpath awk uname; do
  command -v "${required_command}" >/dev/null 2>&1 || fail "required command unavailable: ${required_command}"
done

if [[ "${restore_profile}" == "pulso" ]]; then
  [[ "${docker_context}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
    || fail "PULSO restore requires a sealed Docker context"
  [[ -n "${docker_endpoint}" && "${docker_endpoint}" != *$'\n'* && "${docker_endpoint}" != *$'\r'* ]] \
    || fail "PULSO restore requires a sealed Docker endpoint"
  if [[ "$(uname -s)" =~ ^(MINGW|MSYS|CYGWIN) ]]; then
    [[ "${docker_endpoint}" == npipe://* ]] || fail "PULSO restore requires a local npipe:// Docker endpoint"
  else
    [[ "${docker_endpoint}" == unix://* ]] || fail "PULSO restore requires a local unix:// Docker endpoint"
  fi
  actual_docker_context="$(docker context show)" || fail "could not resolve the active Docker context"
  [[ "${actual_docker_context}" == "${docker_context}" ]] || fail "active Docker context differs from the sealed context"
  actual_docker_endpoint="$(docker context inspect "${actual_docker_context}" --format '{{.Endpoints.docker.Host}}')" \
    || fail "could not resolve the active Docker endpoint"
  [[ "${actual_docker_endpoint}" == "${docker_endpoint}" ]] || fail "active Docker endpoint differs from the sealed endpoint"
fi

[[ -n "${backup_archive}" ]] || fail "HYPERION_RESTORE_ARCHIVE is required"
[[ -n "${target_database}" ]] || fail "HYPERION_RESTORE_DATABASE is required"
[[ "${target_database}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "unsafe restore database name"
[[ "${target_owner}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "unsafe restore owner name"
if [[ "${restore_profile}" == "access" ]]; then
  [[ "${target_owner}" == "hyperion_access_migrator" ]] \
    || fail "Access restore owner must be hyperion_access_migrator"
  [[ "${target_database}" =~ ^hyperion_access(_[a-z0-9_]+)?$ ]] \
    || fail "Access restore database must use the hyperion_access logical database namespace"
  [[ "${expected_sha256}" =~ ^[a-f0-9]{64}$ && ! "${expected_sha256}" =~ ^0{64}$ ]] \
    || fail "Access restore requires an exact non-zero HYPERION_RESTORE_SHA256"
  expected_confirmation="RESTORE ACCESS ${target_database} SHA256 ${expected_sha256}"
elif [[ "${restore_profile}" == "audit" ]]; then
  [[ "${target_owner}" == "hyperion_audit_migrator" ]] \
    || fail "Audit restore owner must be hyperion_audit_migrator"
  [[ "${target_database}" =~ ^hyperion_audit(_[a-z0-9_]+)?$ ]] \
    || fail "Audit restore database must use the hyperion_audit logical database namespace"
  [[ "${expected_sha256}" =~ ^[a-f0-9]{64}$ && ! "${expected_sha256}" =~ ^0{64}$ ]] \
    || fail "Audit restore requires an exact non-zero HYPERION_RESTORE_SHA256"
  expected_confirmation="RESTORE AUDIT ${target_database} SHA256 ${expected_sha256}"
elif [[ "${restore_profile}" == "nova" ]]; then
  [[ "${target_owner}" == "hyperion_nova_migrator" ]] || fail "NOVA restore owner must be hyperion_nova_migrator"
  [[ "${target_database}" =~ ^hyperion_nova(_[a-z0-9_]+)?$ ]] \
    || fail "NOVA restore database must use the hyperion_nova logical database namespace"
  [[ "${expected_sha256}" =~ ^[a-f0-9]{64}$ && ! "${expected_sha256}" =~ ^0{64}$ ]] \
    || fail "NOVA restore requires an exact non-zero HYPERION_RESTORE_SHA256"
  expected_confirmation="RESTORE NOVA ${target_database} SHA256 ${expected_sha256}"
elif [[ "${restore_profile}" == "lumen" ]]; then
  [[ "${target_owner}" == "hyperion_lumen_migrator" ]] || fail "LUMEN restore owner must be hyperion_lumen_migrator"
  [[ "${target_database}" =~ ^hyperion_lumen(_[a-z0-9_]+)?$ ]] \
    || fail "LUMEN restore database must use the hyperion_lumen logical database namespace"
  [[ "${expected_sha256}" =~ ^[a-f0-9]{64}$ && ! "${expected_sha256}" =~ ^0{64}$ ]] \
    || fail "LUMEN restore requires an exact non-zero HYPERION_RESTORE_SHA256"
  expected_confirmation="RESTORE LUMEN ${target_database} SHA256 ${expected_sha256}"
elif [[ "${restore_profile}" == "pulso" ]]; then
  [[ "${target_owner}" == "hyperion_pulso_migrator" ]] || fail "PULSO restore owner must be hyperion_pulso_migrator"
  [[ "${target_database}" =~ ^hyperion_pulso(_[a-z0-9_]+)?$ ]] \
    || fail "PULSO restore database must use the hyperion_pulso logical database namespace"
  [[ "${expected_sha256}" =~ ^[a-f0-9]{64}$ && ! "${expected_sha256}" =~ ^0{64}$ ]] \
    || fail "PULSO restore requires an exact non-zero HYPERION_RESTORE_SHA256"
  expected_confirmation="RESTORE PULSO ${target_database} SHA256 ${expected_sha256}"
else
  expected_confirmation="RESTORE ${target_database}"
fi
[[ "${confirm}" == "${expected_confirmation}" ]] \
  || fail "HYPERION_RESTORE_CONFIRM must equal '${expected_confirmation}'"

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
  backup_archive="$(realpath -e -- "${backup_archive}")"
  if [[ "${restore_profile}" == "access" ]]; then
    [[ "${compose_file}" == "${repository_root}/infra/docker-compose.access-ops.yml" ]] \
      || fail "production Access Compose file must be canonical"
    [[ "${environment_file}" == "${repository_root}/.env.access-ops" ]] \
      || fail "production Access environment file must be canonical"
    [[ "${backup_archive}" == "${repository_root}/backups/access/"* ]] \
      || fail "production Access restore archive must live under backups/access/"
  elif [[ "${restore_profile}" == "audit" ]]; then
    [[ "${compose_file}" == "${repository_root}/infra/docker-compose.audit-ops.yml" ]] \
      || fail "production Audit Compose file must be canonical"
    [[ "${environment_file}" == "${repository_root}/.env.audit-ops" ]] \
      || fail "production Audit environment file must be canonical"
    [[ "${backup_archive}" == "${repository_root}/backups/audit/"* ]] \
      || fail "production Audit restore archive must live under backups/audit/"
  elif [[ "${restore_profile}" == "nova" ]]; then
    [[ "${compose_file}" == "${repository_root}/infra/docker-compose.nova-ops.yml" ]] \
      || fail "production NOVA Compose file must be canonical"
    [[ "${environment_file}" == "${repository_root}/.env.nova-ops" ]] \
      || fail "production NOVA environment file must be canonical"
    [[ "${backup_archive}" == "${repository_root}/backups/nova/"* ]] \
      || fail "production NOVA restore archive must live under backups/nova/"
  elif [[ "${restore_profile}" == "lumen" ]]; then
    [[ "${compose_file}" == "${repository_root}/infra/docker-compose.lumen-ops.yml" ]] \
      || fail "production LUMEN Compose file must be canonical"
    [[ "${environment_file}" == "${repository_root}/.env.lumen-ops" ]] \
      || fail "production LUMEN environment file must be canonical"
    [[ "${backup_archive}" == "${repository_root}/backups/lumen/"* ]] \
      || fail "production LUMEN restore archive must live under backups/lumen/"
  elif [[ "${restore_profile}" == "pulso" ]]; then
    [[ "${compose_file}" == "${repository_root}/infra/docker-compose.pulso-ops.yml" ]] \
      || fail "production PULSO Compose file must be canonical"
    [[ "${environment_file}" == "${repository_root}/.env.pulso-ops" ]] \
      || fail "production PULSO environment file must be canonical"
    [[ "${backup_archive}" == "${repository_root}/backups/pulso/"* ]] \
      || fail "production PULSO restore archive must live under backups/pulso/"
  else
    [[ "${compose_file}" == "${repository_root}/infra/docker-compose.yml" ]] \
      || fail "production Compose file must be canonical"
    [[ "${environment_file}" == "${repository_root}/.env" ]] \
      || fail "production environment file must be canonical"
    [[ "${backup_archive}" == "${repository_root}/backups/"* ]] \
      || fail "production restore archive must live under backups/"
    [[ "${backup_archive}" != "${repository_root}/backups/access/"* ]] \
      || fail "platform restore cannot consume an Access archive"
    [[ "${backup_archive}" != "${repository_root}/backups/audit/"* ]] \
      || fail "platform restore cannot consume an Audit archive"
    [[ "${backup_archive}" != "${repository_root}/backups/nova/"* ]] \
      || fail "platform restore cannot consume a NOVA archive"
    [[ "${backup_archive}" != "${repository_root}/backups/lumen/"* ]] \
      || fail "platform restore cannot consume a LUMEN archive"
    [[ "${backup_archive}" != "${repository_root}/backups/pulso/"* ]] \
      || fail "platform restore cannot consume a PULSO archive"
  fi
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
fi

[[ -f "${backup_archive}" && ! -L "${backup_archive}" ]] || fail "restore archive must be a regular file"
if [[ "${test_mode}" == "0" ]]; then
  [[ "$(stat -c '%u:%g' -- "${backup_archive}")" == "0:0" ]] \
    || fail "restore archive owner must be root:root"
  [[ "$(stat -c '%h' -- "${backup_archive}")" == "1" ]] \
    || fail "restore archive must not have multiple hard links"
  archive_mode="$(stat -c '%a' -- "${backup_archive}")"
  (( (8#${archive_mode} & 8#077) == 0 )) || fail "restore archive permissions must be private"
fi
if [[ "${restore_profile}" == "access" ]]; then
  [[ "$(basename -- "${backup_archive}")" =~ ^access-[0-9]{8}T[0-9]{6}Z\.dump\.gz$ ]] \
    || fail "Access restore archive must use the access-<UTC timestamp>.dump.gz name"
elif [[ "${restore_profile}" == "audit" ]]; then
  [[ "$(basename -- "${backup_archive}")" =~ ^audit-[0-9]{8}T[0-9]{6}Z\.dump\.gz$ ]] \
    || fail "Audit restore archive must use the audit-<UTC timestamp>.dump.gz name"
elif [[ "${restore_profile}" == "nova" ]]; then
  [[ "$(basename -- "${backup_archive}")" =~ ^nova-[0-9]{8}T[0-9]{6}Z\.dump\.gz$ ]] \
    || fail "NOVA restore archive must use the nova-<UTC timestamp>.dump.gz name"
elif [[ "${restore_profile}" == "lumen" ]]; then
  [[ "$(basename -- "${backup_archive}")" =~ ^lumen-[0-9]{8}T[0-9]{6}Z\.dump\.gz$ ]] \
    || fail "LUMEN restore archive must use the lumen-<UTC timestamp>.dump.gz name"
elif [[ "${restore_profile}" == "pulso" ]]; then
  [[ "$(basename -- "${backup_archive}")" =~ ^pulso-[0-9]{8}T[0-9]{6}Z\.dump\.gz$ ]] \
    || fail "PULSO restore archive must use the pulso-<UTC timestamp>.dump.gz name"
fi
[[ -f "${compose_file}" && ! -L "${compose_file}" ]] || fail "Compose file not found"
[[ -f "${environment_file}" && ! -L "${environment_file}" ]] || fail "environment file not found"

gzip -t -- "${backup_archive}" || fail "archive failed gzip integrity check"
archive_sha256="$(sha256sum -- "${backup_archive}" | awk '{ print $1 }')"
[[ "${archive_sha256}" =~ ^[a-f0-9]{64}$ ]] || fail "invalid SHA-256"
if [[ -n "${expected_sha256}" && "${expected_sha256}" != "${archive_sha256}" ]]; then
  fail "archive SHA-256 does not match HYPERION_RESTORE_SHA256"
fi

compose=(docker)
if [[ "${restore_profile}" == "pulso" ]]; then
  compose+=(--host "${docker_endpoint}")
fi
compose+=(compose --env-file "${environment_file}" -f "${compose_file}")
profile_database_acl_sql=""
if [[ "${restore_profile}" == "access" ]]; then
  compose+=(--profile access-ops)
  profile_database_acl_sql="REVOKE ALL ON DATABASE \"${target_database}\" FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE \"${target_database}\" TO \"hyperion_access_migrator\";
REVOKE CREATE, TEMPORARY ON DATABASE \"${target_database}\" FROM \"hyperion_identity\", \"hyperion_tenant\";
GRANT CONNECT ON DATABASE \"${target_database}\" TO \"hyperion_identity\", \"hyperion_tenant\";"
elif [[ "${restore_profile}" == "audit" ]]; then
  compose+=(--profile audit-ops)
  profile_database_acl_sql="REVOKE ALL ON DATABASE \"${target_database}\" FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE \"${target_database}\" TO \"hyperion_audit_migrator\";
REVOKE CREATE, TEMPORARY ON DATABASE \"${target_database}\" FROM \"hyperion_audit\";
GRANT CONNECT ON DATABASE \"${target_database}\" TO \"hyperion_audit\";"
elif [[ "${restore_profile}" == "nova" ]]; then
  compose+=(--profile nova-ops)
elif [[ "${restore_profile}" == "lumen" ]]; then
  compose+=(--profile lumen-ops)
  profile_database_acl_sql="REVOKE ALL ON DATABASE \"${target_database}\" FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE \"${target_database}\" TO \"hyperion_lumen_migrator\";
REVOKE CREATE, TEMPORARY ON DATABASE \"${target_database}\" FROM \"hyperion_lumen\";
GRANT CONNECT ON DATABASE \"${target_database}\" TO \"hyperion_lumen\";"
elif [[ "${restore_profile}" == "pulso" ]]; then
  compose+=(--profile pulso-ops)
  profile_database_acl_sql="REVOKE ALL ON DATABASE \"${target_database}\" FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE \"${target_database}\" TO \"hyperion_pulso_migrator\";
REVOKE CREATE, TEMPORARY ON DATABASE \"${target_database}\" FROM \"hyperion_pulso\", \"hyperion_sofia\", \"hyperion_knowledge\", \"hyperion_integration\", \"hyperion_channel\";
GRANT CONNECT ON DATABASE \"${target_database}\" TO \"hyperion_pulso\", \"hyperion_sofia\", \"hyperion_knowledge\", \"hyperion_integration\", \"hyperion_channel\";"
fi

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
CREATE DATABASE \"${target_database}\" OWNER \"${target_owner}\";
${profile_database_acl_sql}
SQL
"

gzip -dc -- "${backup_archive}" \
  | "${compose[@]}" exec -T postgres \
    sh -eu -c 'exec pg_restore --clean --if-exists --no-owner --role="$1" -U "$POSTGRES_USER" -d "$2"' \
    _ "${target_owner}" "${target_database}"

if [[ "${restore_profile}" == "access" || "${restore_profile}" == "audit" \
  || "${restore_profile}" == "lumen" || "${restore_profile}" == "pulso" ]]; then
  "${compose[@]}" exec -T postgres \
    sh -eu -c "
psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d postgres <<SQL
${profile_database_acl_sql}
SQL
"
fi

printf 'RESTORE_FILE=%s\n' "$(basename -- "${backup_archive}")"
printf 'RESTORE_PROFILE=%s\n' "${restore_profile}"
printf 'RESTORE_DATABASE=%s\n' "${target_database}"
printf 'RESTORE_OWNER=%s\n' "${target_owner}"
printf 'RESTORE_CATALOG_ENTRIES=%s\n' "${catalog_entries}"
printf 'RESTORE_SHA256=%s\n' "${archive_sha256}"
