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
window_script="$script_directory/n-minus-one-channel-pulso-sql-window.sh"

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
revoke all privileges on schema pulso_iris from hyperion_channel;
revoke all privileges on table pulso_iris.messages from hyperion_channel;
revoke all privileges on table pulso_iris.sites from hyperion_channel;
drop materialized view if exists pulso_iris.hyperion_n1_channel_sql_window_probe_materialized;
drop table if exists pulso_iris.hyperion_n1_channel_sql_window_probe_owned;
drop type if exists pulso_iris.hyperion_n1_channel_sql_window_probe_owned_type;
drop sequence if exists pulso_iris.hyperion_n1_channel_sql_window_probe_sequence;
drop function if exists pulso_iris.hyperion_n1_channel_sql_window_probe_routine();

do $cleanup$
begin
  if exists (
    select 1
      from pg_catalog.pg_roles
     where rolname = 'hyperion_n1_channel_sql_window_probe_role'
  ) then
    if exists (
      select 1
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
        join pg_catalog.pg_roles member_role on member_role.oid = membership.member
       where granted_role.rolname = 'hyperion_n1_channel_sql_window_probe_role'
         and member_role.rolname = 'hyperion_channel'
    ) then
      execute 'revoke hyperion_n1_channel_sql_window_probe_role from hyperion_channel';
    end if;
    if exists (
      select 1
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
        join pg_catalog.pg_roles member_role on member_role.oid = membership.member
       where granted_role.rolname = 'hyperion_channel'
         and member_role.rolname = 'hyperion_n1_channel_sql_window_probe_role'
    ) then
      execute 'revoke hyperion_channel from hyperion_n1_channel_sql_window_probe_role';
    end if;
    execute 'drop role hyperion_n1_channel_sql_window_probe_role';
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
      echo "N-1 Channel SQL-window drift probe also failed to restore and attest the closed state" >&2
    fi
    exit "$original_status"
  fi
  if (( artifact_status != 0 || close_status != 0 || verify_status != 0 )); then
    echo "N-1 Channel SQL-window drift probe could not restore and attest the closed state" >&2
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
    echo "N-1 Channel SQL-window verifier accepted disallowed drift: $label" >&2
    return 1
  fi
  if [[ $output != *"$expected_error"* ]]; then
    echo "N-1 Channel SQL-window verifier failed for an unexpected reason while checking: $label" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  echo "N-1 Channel SQL-window verifier rejected: $label"
}

expect_closed_rejection() {
  local label=$1
  local expected_error=$2
  local output

  if output=$(window verify-closed 2>&1); then
    echo "N-1 Channel closed-window verifier accepted disallowed drift: $label" >&2
    return 1
  fi
  if [[ $output != *"$expected_error"* ]]; then
    echo "N-1 Channel closed-window verifier failed for an unexpected reason while checking: $label" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  echo "N-1 Channel closed-window verifier rejected: $label"
}

restore_verified_open_window() {
  cleanup_probe_artifacts
  window close
  window verify-closed
  window open
  window verify-open
}

restore_verified_open_window

admin_psql <<'SQL'
grant create on schema pulso_iris to hyperion_channel;
SQL
expect_open_rejection "schema CREATE" "invalid pulso_iris schema privileges"
restore_verified_open_window

admin_psql <<'SQL'
grant select on table pulso_iris.messages to hyperion_channel;
SQL
expect_open_rejection "table-wide SELECT" "must not grant any table-wide privilege"
restore_verified_open_window

admin_psql <<'SQL'
grant update on table pulso_iris.messages to hyperion_channel;
SQL
expect_open_rejection "table-wide UPDATE" "must not grant any table-wide privilege"
restore_verified_open_window

admin_psql <<'SQL'
grant select (created_at) on table pulso_iris.messages to hyperion_channel;
SQL
expect_open_rejection "additional SELECT column" "column privileges differ from the exact allow-list"
restore_verified_open_window

admin_psql <<'SQL'
grant select (provider_message_id) on table pulso_iris.messages to hyperion_channel;
SQL
expect_open_rejection "read access to UPDATE-only provider message ID" "column privileges differ from the exact allow-list"
restore_verified_open_window

admin_psql <<'SQL'
grant update (body) on table pulso_iris.messages to hyperion_channel;
SQL
expect_open_rejection "additional UPDATE column" "column privileges differ from the exact allow-list"
restore_verified_open_window

admin_psql <<'SQL'
grant update (delivery_status) on table pulso_iris.messages to hyperion_channel with grant option;
SQL
expect_open_rejection "column grant option" "column privileges differ from the exact allow-list"
restore_verified_open_window

admin_psql <<'SQL'
grant select on table pulso_iris.sites to hyperion_channel;
SQL
expect_open_rejection "additional readable table" "must not grant any table-wide privilege"
restore_verified_open_window

admin_psql <<'SQL'
create materialized view pulso_iris.hyperion_n1_channel_sql_window_probe_materialized
as select 1::integer as id
with no data;
revoke all privileges on table pulso_iris.hyperion_n1_channel_sql_window_probe_materialized from public;
grant select on table pulso_iris.hyperion_n1_channel_sql_window_probe_materialized to hyperion_channel;
SQL
expect_open_rejection "materialized-view SELECT" "must not grant any table-wide privilege"
restore_verified_open_window

admin_psql <<'SQL'
create table pulso_iris.hyperion_n1_channel_sql_window_probe_owned (id integer primary key);
alter table pulso_iris.hyperion_n1_channel_sql_window_probe_owned owner to hyperion_channel;
SQL
expect_open_rejection "PULSO relation ownership" "role must not own PULSO objects"
restore_verified_open_window

admin_psql <<'SQL'
create type pulso_iris.hyperion_n1_channel_sql_window_probe_owned_type as enum ('probe');
alter type pulso_iris.hyperion_n1_channel_sql_window_probe_owned_type owner to hyperion_channel;
SQL
expect_open_rejection "PULSO type ownership" "role must not own PULSO objects"
restore_verified_open_window

admin_psql <<'SQL'
create sequence pulso_iris.hyperion_n1_channel_sql_window_probe_sequence;
grant usage on sequence pulso_iris.hyperion_n1_channel_sql_window_probe_sequence to hyperion_channel;
SQL
expect_open_rejection "sequence USAGE" "must not grant sequence privileges"
restore_verified_open_window

admin_psql <<'SQL'
create function pulso_iris.hyperion_n1_channel_sql_window_probe_routine()
returns integer
language sql
immutable
as 'select 1';
revoke all privileges on function pulso_iris.hyperion_n1_channel_sql_window_probe_routine() from public;
grant execute on function pulso_iris.hyperion_n1_channel_sql_window_probe_routine() to public;
SQL
expect_open_rejection "routine EXECUTE inherited from PUBLIC" "must not grant routine execution"
restore_verified_open_window

admin_psql <<'SQL'
create role hyperion_n1_channel_sql_window_probe_role
  nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
grant hyperion_n1_channel_sql_window_probe_role to hyperion_channel;
SQL
expect_open_rejection \
  "role membership" \
  "requires the fixed unprivileged hyperion_channel identity"
restore_verified_open_window

admin_psql <<'SQL'
create role hyperion_n1_channel_sql_window_probe_role
  nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
grant hyperion_channel to hyperion_n1_channel_sql_window_probe_role;
SQL
expect_open_rejection \
  "inverse role membership that can assume hyperion_channel" \
  "requires the fixed unprivileged hyperion_channel identity"
restore_verified_open_window

window close
window verify-closed
admin_psql <<'SQL'
grant select (id) on table pulso_iris.messages to hyperion_channel;
SQL
expect_closed_rejection \
  "message SELECT after closure" \
  "N-1 Channel-to-PULSO SQL compatibility privileges remain active"

window close
window verify-closed
admin_psql <<'SQL'
grant update (delivery_status) on table pulso_iris.messages to hyperion_channel;
SQL
expect_closed_rejection \
  "message UPDATE after closure" \
  "N-1 Channel-to-PULSO SQL compatibility privileges remain active"

cleanup_probe_artifacts
window close
window verify-closed
trap - EXIT

echo "N-1 Channel SQL-window drift rejection and fail-closed restoration verified against PostgreSQL"
