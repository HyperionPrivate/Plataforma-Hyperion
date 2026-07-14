#!/usr/bin/env bash

set -euo pipefail

if (( $# < 3 )); then
  echo "usage: $0 <env-file> <project-name> <compose-file> [compose-file ...]" >&2
  exit 64
fi

env_file=$1
project_name=$2
shift 2

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
window_script="$script_directory/n-minus-one-pulso-channel-sql-window.sh"

compose=(docker compose --env-file "$env_file" --project-name "$project_name")
compose_files=("$@")
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

window() {
  local mode=$1
  bash "$window_script" "$mode" "$env_file" "$project_name" "${compose_files[@]}"
}

admin_psql() {
  "${compose[@]}" exec -T postgres \
    psql -X -q -v ON_ERROR_STOP=1 \
    -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}"
}

cleanup_probe_artifacts() {
  admin_psql <<'SQL'
set client_min_messages = warning;
revoke usage, create on schema channel_runtime from hyperion_pulso;
drop sequence if exists channel_runtime.hyperion_n1_sql_window_probe_sequence;
drop function if exists channel_runtime.hyperion_n1_sql_window_probe_routine();

do $cleanup$
begin
  if exists (
    select 1
     from pg_catalog.pg_roles
     where rolname = 'hyperion_n1_sql_window_probe_role'
  ) then
    if exists (
      select 1
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
        join pg_catalog.pg_roles member_role on member_role.oid = membership.member
       where granted_role.rolname = 'hyperion_n1_sql_window_probe_role'
         and member_role.rolname = 'hyperion_pulso'
    ) then
      execute 'revoke hyperion_n1_sql_window_probe_role from hyperion_pulso';
    end if;
    if exists (
      select 1
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
        join pg_catalog.pg_roles member_role on member_role.oid = membership.member
       where granted_role.rolname = 'hyperion_pulso'
         and member_role.rolname = 'hyperion_n1_sql_window_probe_role'
    ) then
      execute 'revoke hyperion_pulso from hyperion_n1_sql_window_probe_role';
    end if;
    execute 'drop role hyperion_n1_sql_window_probe_role';
  end if;
end
$cleanup$;
SQL
}

cleanup_on_exit() {
  local original_status=$?
  local artifact_status=0
  local close_status=0
  local verify_status=0

  trap - EXIT
  set +e
  cleanup_probe_artifacts >/dev/null 2>&1
  artifact_status=$?
  window close >/dev/null 2>&1
  close_status=$?
  window verify-closed >/dev/null 2>&1
  verify_status=$?

  if (( original_status != 0 )); then
    if (( artifact_status != 0 || close_status != 0 || verify_status != 0 )); then
      echo "N-1 SQL-window drift probe also failed to restore and attest the closed state" >&2
    fi
    exit "$original_status"
  fi
  if (( artifact_status != 0 || close_status != 0 || verify_status != 0 )); then
    echo "N-1 SQL-window drift probe could not restore and attest the closed state" >&2
    exit 1
  fi
}

trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

expect_open_rejection() {
  local label=$1
  local expected_error=$2
  local output

  if output=$(window verify-open 2>&1); then
    echo "N-1 SQL-window verifier accepted disallowed drift: $label" >&2
    return 1
  fi
  if [[ $output != *"$expected_error"* ]]; then
    echo "N-1 SQL-window verifier failed for an unexpected reason while checking: $label" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  echo "N-1 SQL-window verifier rejected: $label"
}

expect_closed_rejection() {
  local label=$1
  local expected_error=$2
  local output

  if output=$(window verify-closed 2>&1); then
    echo "N-1 closed-window verifier accepted disallowed drift: $label" >&2
    return 1
  fi
  if [[ $output != *"$expected_error"* ]]; then
    echo "N-1 closed-window verifier failed for an unexpected reason while checking: $label" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  echo "N-1 closed-window verifier rejected: $label"
}

restore_verified_open_window() {
  cleanup_probe_artifacts
  window close
  window verify-closed
  window open
  window verify-open
}

# Establish a clean positive control before every single-drift case. This makes
# an expected rejection attributable to that injected privilege instead of an
# unrelated database or verifier failure.
restore_verified_open_window

admin_psql <<'SQL'
grant create on schema channel_runtime to hyperion_pulso;
SQL
expect_open_rejection "schema CREATE" "N-1 SQL window has excess channel_runtime schema privileges"
restore_verified_open_window

admin_psql <<'SQL'
create sequence channel_runtime.hyperion_n1_sql_window_probe_sequence;
grant usage on sequence channel_runtime.hyperion_n1_sql_window_probe_sequence to hyperion_pulso;
SQL
expect_open_rejection "sequence USAGE" "N-1 SQL window must not grant sequence privileges"
restore_verified_open_window

admin_psql <<'SQL'
create function channel_runtime.hyperion_n1_sql_window_probe_routine()
returns integer
language sql
immutable
as 'select 1';
revoke all privileges on function channel_runtime.hyperion_n1_sql_window_probe_routine() from public;
grant execute on function channel_runtime.hyperion_n1_sql_window_probe_routine() to public;
SQL
expect_open_rejection "routine EXECUTE inherited from PUBLIC" "N-1 SQL window must not grant routine execution"
restore_verified_open_window

admin_psql <<'SQL'
create role hyperion_n1_sql_window_probe_role
  nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
grant hyperion_n1_sql_window_probe_role to hyperion_pulso;
SQL
expect_open_rejection \
  "role membership" \
  "N-1 SQL window requires the fixed unprivileged hyperion_pulso identity"
restore_verified_open_window

admin_psql <<'SQL'
create role hyperion_n1_sql_window_probe_role
  nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
grant hyperion_pulso to hyperion_n1_sql_window_probe_role;
SQL
expect_open_rejection \
  "inverse role membership that can assume hyperion_pulso" \
  "N-1 SQL window requires the fixed unprivileged hyperion_pulso identity"
restore_verified_open_window

window close
window verify-closed
admin_psql <<'SQL'
grant usage on schema channel_runtime to hyperion_pulso;
SQL
expect_closed_rejection \
  "schema USAGE after closure" \
  "N-1 PULSO-to-Channel SQL compatibility privileges remain active"

cleanup_probe_artifacts
window close
window verify-closed
trap - EXIT

echo "N-1 SQL-window drift rejection and fail-closed restoration verified against PostgreSQL"
