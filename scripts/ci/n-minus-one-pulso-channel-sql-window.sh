#!/usr/bin/env bash

set -euo pipefail

if (( $# < 4 )); then
  echo "usage: $0 <open|close|verify-open|verify-closed|verify-delivery-drained> <env-file> <project-name> <compose-file> [compose-file ...]" >&2
  exit 64
fi

mode=$1
env_file=$2
project_name=$3
shift 3

if [[ $mode != "open" && $mode != "close" && $mode != "verify-open" && $mode != "verify-closed" && $mode != "verify-delivery-drained" ]]; then
  echo "mode must be open, close, verify-open, verify-closed or verify-delivery-drained" >&2
  exit 64
fi

compose=(docker compose --env-file "$env_file" --project-name "$project_name")
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

# N-1 PULSO images still mutate channel_runtime.thread_bindings in SQL. Migration
# 040 revokes that path for current images, which correctly bind through Channel
# HTTP. This rehearsal window restores only the exact privileges N-1 needs and
# must never be applied as a durable production grant.
if [[ $mode == "open" ]]; then
  sql=$(
    cat <<'SQL'
begin;
revoke all privileges on schema channel_runtime from hyperion_pulso;
revoke all privileges on all tables in schema channel_runtime from hyperion_pulso;
revoke all privileges on all sequences in schema channel_runtime from hyperion_pulso;
revoke all privileges on all routines in schema channel_runtime from hyperion_pulso;
grant usage on schema channel_runtime to hyperion_pulso;
grant select (id, patient_id, conversation_id, tenant_id)
  on table channel_runtime.thread_bindings to hyperion_pulso;
grant update (patient_id, conversation_id, last_inbound_at, updated_at)
  on table channel_runtime.thread_bindings to hyperion_pulso;
grant select (tenant_id, external_message_id, provider)
  on table channel_runtime.inbound_events to hyperion_pulso;
grant update (thread_binding_id, message_id, updated_at)
  on table channel_runtime.inbound_events to hyperion_pulso;
commit;
SQL
  )
  echo "opening N-1 PULSO-to-Channel SQL compatibility window"
elif [[ $mode == "close" ]]; then
  sql=$(
    cat <<'SQL'
begin;
revoke all privileges on schema channel_runtime from hyperion_pulso;
revoke all privileges on all tables in schema channel_runtime from hyperion_pulso;
revoke all privileges on all sequences in schema channel_runtime from hyperion_pulso;
revoke all privileges on all routines in schema channel_runtime from hyperion_pulso;
commit;
SQL
  )
  echo "closing N-1 PULSO-to-Channel SQL compatibility window"
elif [[ $mode == "verify-open" ]]; then
  sql=$(
    cat <<'SQL'
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_roles role_definition
     where role_definition.rolname = 'hyperion_pulso'
       and role_definition.rolcanlogin
       and not role_definition.rolsuper
       and not role_definition.rolcreatedb
       and not role_definition.rolcreaterole
       and not role_definition.rolinherit
       and not role_definition.rolreplication
       and not role_definition.rolbypassrls
  ) or exists (
    select 1
      from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles member_role on member_role.oid = membership.member
      join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
     where member_role.rolname = 'hyperion_pulso'
        or granted_role.rolname = 'hyperion_pulso'
  ) then
    raise exception 'N-1 SQL window requires the fixed unprivileged hyperion_pulso identity';
  end if;

  if not has_schema_privilege('hyperion_pulso', 'channel_runtime', 'USAGE') then
    raise exception 'N-1 SQL window is missing channel_runtime schema usage';
  end if;

  if has_schema_privilege('hyperion_pulso', 'channel_runtime', 'CREATE')
     or has_schema_privilege('hyperion_pulso', 'channel_runtime', 'USAGE WITH GRANT OPTION') then
    raise exception 'N-1 SQL window has excess channel_runtime schema privileges';
  end if;

  if exists (
    select 1
      from information_schema.tables table_definition
     where table_definition.table_schema = 'channel_runtime'
       and (
         has_table_privilege(
           'hyperion_pulso',
           format('%I.%I', table_definition.table_schema, table_definition.table_name),
           'SELECT'
         )
         or has_table_privilege(
           'hyperion_pulso',
           format('%I.%I', table_definition.table_schema, table_definition.table_name),
           'INSERT'
         )
         or has_table_privilege(
           'hyperion_pulso',
           format('%I.%I', table_definition.table_schema, table_definition.table_name),
           'UPDATE'
         )
         or has_table_privilege(
           'hyperion_pulso',
           format('%I.%I', table_definition.table_schema, table_definition.table_name),
           'DELETE'
         )
         or has_table_privilege(
           'hyperion_pulso',
           format('%I.%I', table_definition.table_schema, table_definition.table_name),
           'TRUNCATE'
         )
         or has_table_privilege(
           'hyperion_pulso',
           format('%I.%I', table_definition.table_schema, table_definition.table_name),
           'REFERENCES'
         )
         or has_table_privilege(
           'hyperion_pulso',
           format('%I.%I', table_definition.table_schema, table_definition.table_name),
           'TRIGGER'
         )
       )
  ) then
    raise exception 'N-1 SQL window must not grant any table-wide privilege';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_class sequence_definition
      join pg_catalog.pg_namespace namespace
        on namespace.oid = sequence_definition.relnamespace
     where namespace.nspname = 'channel_runtime'
       and sequence_definition.relkind = 'S'
       and (
         has_sequence_privilege('hyperion_pulso', sequence_definition.oid, 'USAGE')
         or has_sequence_privilege('hyperion_pulso', sequence_definition.oid, 'SELECT')
         or has_sequence_privilege('hyperion_pulso', sequence_definition.oid, 'UPDATE')
       )
  ) then
    raise exception 'N-1 SQL window must not grant sequence privileges';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace
        on namespace.oid = routine.pronamespace
     where namespace.nspname = 'channel_runtime'
       and has_function_privilege('hyperion_pulso', routine.oid, 'EXECUTE')
  ) then
    raise exception 'N-1 SQL window must not grant routine execution';
  end if;

  if exists (
    with expected (table_name, column_name, can_select, can_update) as (
      values
        ('thread_bindings', 'id', true, false),
        ('thread_bindings', 'patient_id', true, true),
        ('thread_bindings', 'conversation_id', true, true),
        ('thread_bindings', 'tenant_id', true, false),
        ('thread_bindings', 'last_inbound_at', false, true),
        ('thread_bindings', 'updated_at', false, true),
        ('inbound_events', 'tenant_id', true, false),
        ('inbound_events', 'external_message_id', true, false),
        ('inbound_events', 'provider', true, false),
        ('inbound_events', 'thread_binding_id', false, true),
        ('inbound_events', 'message_id', false, true),
        ('inbound_events', 'updated_at', false, true)
    )
    select 1
      from information_schema.columns column_definition
      left join expected
        on expected.table_name = column_definition.table_name
       and expected.column_name = column_definition.column_name
     where column_definition.table_schema = 'channel_runtime'
       and (
         has_column_privilege(
           'hyperion_pulso',
           format('%I.%I', column_definition.table_schema, column_definition.table_name),
           column_definition.column_name,
           'SELECT'
         ) is distinct from coalesce(expected.can_select, false)
         or has_column_privilege(
           'hyperion_pulso',
           format('%I.%I', column_definition.table_schema, column_definition.table_name),
           column_definition.column_name,
           'UPDATE'
          ) is distinct from coalesce(expected.can_update, false)
          or has_column_privilege(
            'hyperion_pulso',
            format('%I.%I', column_definition.table_schema, column_definition.table_name),
            column_definition.column_name,
            'SELECT WITH GRANT OPTION'
          )
          or has_column_privilege(
            'hyperion_pulso',
            format('%I.%I', column_definition.table_schema, column_definition.table_name),
            column_definition.column_name,
            'UPDATE WITH GRANT OPTION'
          )
          or has_column_privilege(
           'hyperion_pulso',
           format('%I.%I', column_definition.table_schema, column_definition.table_name),
           column_definition.column_name,
           'INSERT'
         )
         or has_column_privilege(
           'hyperion_pulso',
           format('%I.%I', column_definition.table_schema, column_definition.table_name),
           column_definition.column_name,
           'REFERENCES'
         )
       )
  ) then
    raise exception 'N-1 SQL window column privileges differ from the exact allow-list';
  end if;
end
$$;

begin;
set local role hyperion_pulso;

prepare hyperion_n1_thread_lock(uuid, uuid) as
  select id, patient_id, conversation_id
  from channel_runtime.thread_bindings
  where tenant_id = $1 and id = $2
  for update;
execute hyperion_n1_thread_lock(
  '00000000-0000-0000-0000-000000000000'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid
);

prepare hyperion_n1_thread_update(uuid, uuid, uuid, uuid) as
  update channel_runtime.thread_bindings
  set patient_id = $3, conversation_id = $4, last_inbound_at = now(), updated_at = now()
  where tenant_id = $1 and id = $2;
execute hyperion_n1_thread_update(
  '00000000-0000-0000-0000-000000000000'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  null::uuid,
  null::uuid
);

prepare hyperion_n1_inbound_update(uuid, text, uuid, uuid) as
  update channel_runtime.inbound_events
  set thread_binding_id = $3, message_id = $4, updated_at = now()
  where tenant_id = $1 and external_message_id = $2 and provider = 'whatsapp_web_test';
execute hyperion_n1_inbound_update(
  '00000000-0000-0000-0000-000000000000'::uuid,
  'hyperion-n1-privilege-probe',
  null::uuid,
  null::uuid
);
rollback;
SQL
  )
  echo "verifying the bounded N-1 PULSO-to-Channel SQL compatibility window"
elif [[ $mode == "verify-closed" ]]; then
  sql=$(
    cat <<'SQL'
do $$
begin
  if not exists (
       select 1
         from pg_catalog.pg_roles role_definition
        where role_definition.rolname = 'hyperion_pulso'
          and role_definition.rolcanlogin
          and not role_definition.rolsuper
          and not role_definition.rolcreatedb
          and not role_definition.rolcreaterole
          and not role_definition.rolinherit
          and not role_definition.rolreplication
          and not role_definition.rolbypassrls
     )
     or exists (
       select 1
         from pg_catalog.pg_auth_members membership
         join pg_catalog.pg_roles member_role on member_role.oid = membership.member
         join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
        where member_role.rolname = 'hyperion_pulso'
           or granted_role.rolname = 'hyperion_pulso'
     )
     or has_schema_privilege('hyperion_pulso', 'channel_runtime', 'USAGE')
     or has_schema_privilege('hyperion_pulso', 'channel_runtime', 'CREATE')
     or exists (
       select 1
         from information_schema.tables table_definition
        where table_definition.table_schema = 'channel_runtime'
          and (
            has_table_privilege(
              'hyperion_pulso',
              format('%I.%I', table_definition.table_schema, table_definition.table_name),
              'SELECT'
            )
            or has_table_privilege(
              'hyperion_pulso',
              format('%I.%I', table_definition.table_schema, table_definition.table_name),
              'INSERT'
            )
            or has_table_privilege(
              'hyperion_pulso',
              format('%I.%I', table_definition.table_schema, table_definition.table_name),
              'UPDATE'
            )
            or has_table_privilege(
              'hyperion_pulso',
              format('%I.%I', table_definition.table_schema, table_definition.table_name),
              'DELETE'
            )
            or has_table_privilege(
              'hyperion_pulso',
              format('%I.%I', table_definition.table_schema, table_definition.table_name),
              'TRUNCATE'
            )
            or has_table_privilege(
              'hyperion_pulso',
              format('%I.%I', table_definition.table_schema, table_definition.table_name),
              'REFERENCES'
            )
            or has_table_privilege(
              'hyperion_pulso',
              format('%I.%I', table_definition.table_schema, table_definition.table_name),
              'TRIGGER'
            )
           )
      )
     or exists (
       select 1
         from pg_catalog.pg_class sequence_definition
         join pg_catalog.pg_namespace namespace
           on namespace.oid = sequence_definition.relnamespace
        where namespace.nspname = 'channel_runtime'
          and sequence_definition.relkind = 'S'
          and (
            has_sequence_privilege('hyperion_pulso', sequence_definition.oid, 'USAGE')
            or has_sequence_privilege('hyperion_pulso', sequence_definition.oid, 'SELECT')
            or has_sequence_privilege('hyperion_pulso', sequence_definition.oid, 'UPDATE')
          )
     )
     or exists (
       select 1
         from pg_catalog.pg_proc routine
         join pg_catalog.pg_namespace namespace
           on namespace.oid = routine.pronamespace
        where namespace.nspname = 'channel_runtime'
          and has_function_privilege('hyperion_pulso', routine.oid, 'EXECUTE')
     )
     or exists (
       select 1
         from information_schema.columns column_definition
        where column_definition.table_schema = 'channel_runtime'
          and (
            has_column_privilege(
              'hyperion_pulso',
              format('%I.%I', column_definition.table_schema, column_definition.table_name),
              column_definition.column_name,
              'SELECT'
            )
            or has_column_privilege(
              'hyperion_pulso',
              format('%I.%I', column_definition.table_schema, column_definition.table_name),
              column_definition.column_name,
              'UPDATE'
            )
            or has_column_privilege(
              'hyperion_pulso',
              format('%I.%I', column_definition.table_schema, column_definition.table_name),
              column_definition.column_name,
              'INSERT'
            )
            or has_column_privilege(
              'hyperion_pulso',
              format('%I.%I', column_definition.table_schema, column_definition.table_name),
              column_definition.column_name,
              'REFERENCES'
            )
          )
     ) then
    raise exception 'N-1 PULSO-to-Channel SQL compatibility privileges remain active';
  end if;
end
$$;
SQL
  )
  echo "verifying the N-1 PULSO-to-Channel SQL compatibility window is closed"
else
  sql=$(
    cat <<'SQL'
begin transaction read only;
select count(*) filter (where event.status is distinct from 'published')::bigint,
       count(*)::text || ':' || md5(
         coalesce(string_agg(md5(to_jsonb(event)::text), '' order by event.id), '')
       )
  from channel_runtime.outbox_events event
 where event.event_type = 'channel.delivery.updated.v1';
commit;
SQL
  )
  echo "verifying every current Channel delivery event is published before N-1 starts" >&2
fi

if [[ $mode == "verify-delivery-drained" ]]; then
  delivery_state=$(
    "${compose[@]}" exec -T postgres \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
      -c "$sql"
  )
  delivery_state=${delivery_state//$'\r'/}
  delivery_state=$(printf '%s\n' "$delivery_state" | tail -n 1)
  IFS='|' read -r blocked_count delivery_snapshot <<<"$delivery_state"
  if [[ ! $blocked_count =~ ^[0-9]+$ || ! $delivery_snapshot =~ ^[0-9]+:[0-9a-f]{32}$ ]]; then
    echo "Channel delivery drain verification returned invalid evidence" >&2
    exit 1
  fi
  if [[ $blocked_count -ne 0 ]]; then
    echo "Channel delivery drain verification found $blocked_count non-published event(s)" >&2
    exit 1
  fi
  printf '%s\n' "$delivery_snapshot"
  exit 0
fi

"${compose[@]}" exec -T postgres \
  psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
  -c "$sql"
