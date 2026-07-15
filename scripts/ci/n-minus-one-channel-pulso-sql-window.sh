#!/usr/bin/env bash

set -euo pipefail

if (( $# < 4 )); then
  echo "usage: $0 <open|close|verify-open|verify-closed> <env-file> <project-name> <compose-file> [compose-file ...]" >&2
  exit 64
fi

mode=$1
env_file=$2
project_name=$3
shift 3

if [[ $mode != "open" && $mode != "close" && $mode != "verify-open" && $mode != "verify-closed" ]]; then
  echo "mode must be open, close, verify-open or verify-closed" >&2
  exit 64
fi

compose=(docker compose --env-file "$env_file" --project-name "$project_name")
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

# The historical N-1 Channel image predates the PULSO owner APIs. It validates
# and projects outbound delivery state directly against pulso_iris.messages.
# Current images use authenticated PULSO HTTP routes instead. This temporary
# expand/contract window restores only the exact legacy columns while an exact
# N-1 rollback is rehearsed; the durable closed state grants Channel nothing in
# the PULSO schema.
if [[ $mode == "open" ]]; then
  sql=$(cat <<'SQL'
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select pg_advisory_xact_lock(hashtextextended('hyperion:n1:channel-pulso-sql-window', 0));

-- Revoke the role's complete PULSO ACL before reconstructing the temporary
-- column allow-list. Table REVOKE also removes corresponding column grants, so
-- an interrupted or repeated open cannot accumulate privileges.
revoke all privileges on schema pulso_iris from hyperion_channel;
revoke all privileges on all tables in schema pulso_iris from hyperion_channel;
revoke all privileges on all sequences in schema pulso_iris from hyperion_channel;
revoke all privileges on all routines in schema pulso_iris from hyperion_channel;

grant usage on schema pulso_iris to hyperion_channel;
grant select (
    id, tenant_id, conversation_id, sender, body, provider,
    delivery_status, delivered_at, metadata
  )
  on table pulso_iris.messages to hyperion_channel;
grant update (
    provider, provider_message_id, delivery_status, delivered_at, metadata
  )
  on table pulso_iris.messages to hyperion_channel;

commit;
SQL
  )
  echo "opening N-1 Channel-to-PULSO SQL compatibility window"
elif [[ $mode == "close" ]]; then
  sql=$(cat <<'SQL'
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select pg_advisory_xact_lock(hashtextextended('hyperion:n1:channel-pulso-sql-window', 0));

revoke all privileges on schema pulso_iris from hyperion_channel;
revoke all privileges on all tables in schema pulso_iris from hyperion_channel;
revoke all privileges on all sequences in schema pulso_iris from hyperion_channel;
revoke all privileges on all routines in schema pulso_iris from hyperion_channel;

commit;
SQL
  )
  echo "closing N-1 Channel-to-PULSO SQL compatibility window"
else
  expected_window_open=false
  if [[ $mode == "verify-open" ]]; then
    expected_window_open=true
    echo "verifying the bounded N-1 Channel-to-PULSO SQL compatibility window"
  else
    echo "verifying the N-1 Channel-to-PULSO SQL compatibility window is closed"
  fi

  sql=$(cat <<'SQL'
do $verify$
declare
  expected_window_open boolean := __EXPECTED_WINDOW_OPEN__;
begin
  if not exists (
    select 1
      from pg_catalog.pg_roles role_definition
     where role_definition.rolname = 'hyperion_channel'
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
     where member_role.rolname = 'hyperion_channel'
        or granted_role.rolname = 'hyperion_channel'
  ) then
    raise exception 'N-1 Channel SQL window requires the fixed unprivileged hyperion_channel identity';
  end if;

  if not has_database_privilege('hyperion_channel', current_database(), 'CONNECT')
     or has_database_privilege('hyperion_channel', current_database(), 'CREATE')
     or has_database_privilege('hyperion_channel', current_database(), 'TEMPORARY')
     or has_database_privilege('hyperion_channel', current_database(), 'CONNECT WITH GRANT OPTION')
     or exists (
       select 1
         from pg_catalog.pg_database database_definition
         join pg_catalog.pg_roles owner_role on owner_role.oid = database_definition.datdba
        where database_definition.datname = current_database()
          and owner_role.rolname = 'hyperion_channel'
     ) then
    raise exception 'N-1 Channel SQL window requires CONNECT-only database access';
  end if;

  if exists (
       select 1
         from pg_catalog.pg_namespace namespace
         join pg_catalog.pg_roles owner_role on owner_role.oid = namespace.nspowner
        where namespace.nspname = 'pulso_iris'
          and owner_role.rolname = 'hyperion_channel'
     )
     or exists (
       select 1
         from pg_catalog.pg_class relation_definition
         join pg_catalog.pg_namespace namespace
           on namespace.oid = relation_definition.relnamespace
         join pg_catalog.pg_roles owner_role on owner_role.oid = relation_definition.relowner
        where namespace.nspname = 'pulso_iris'
          and owner_role.rolname = 'hyperion_channel'
     )
     or exists (
       select 1
         from pg_catalog.pg_proc routine
         join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
        where namespace.nspname = 'pulso_iris'
          and owner_role.rolname = 'hyperion_channel'
     )
     or exists (
       select 1
         from pg_catalog.pg_type type_definition
         join pg_catalog.pg_namespace namespace on namespace.oid = type_definition.typnamespace
         join pg_catalog.pg_roles owner_role on owner_role.oid = type_definition.typowner
        where namespace.nspname = 'pulso_iris'
          and owner_role.rolname = 'hyperion_channel'
     ) then
    raise exception 'N-1 Channel SQL window role must not own PULSO objects';
  end if;

  if has_schema_privilege('hyperion_channel', 'pulso_iris', 'USAGE')
       is distinct from expected_window_open
     or has_schema_privilege('hyperion_channel', 'pulso_iris', 'CREATE')
     or has_schema_privilege('hyperion_channel', 'pulso_iris', 'USAGE WITH GRANT OPTION')
     or has_schema_privilege('hyperion_channel', 'pulso_iris', 'CREATE WITH GRANT OPTION') then
    raise exception 'N-1 Channel SQL window has invalid pulso_iris schema privileges';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_class relation_definition
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation_definition.relnamespace
     where namespace.nspname = 'pulso_iris'
       and relation_definition.relkind in ('r', 'p', 'v', 'm', 'f')
       and (
         has_table_privilege('hyperion_channel', relation_definition.oid, 'SELECT')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'INSERT')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'UPDATE')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'DELETE')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'TRUNCATE')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'REFERENCES')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'TRIGGER')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'SELECT WITH GRANT OPTION')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'INSERT WITH GRANT OPTION')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'UPDATE WITH GRANT OPTION')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'DELETE WITH GRANT OPTION')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'TRUNCATE WITH GRANT OPTION')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'REFERENCES WITH GRANT OPTION')
         or has_table_privilege('hyperion_channel', relation_definition.oid, 'TRIGGER WITH GRANT OPTION')
       )
  ) then
    raise exception 'N-1 Channel SQL window must not grant any table-wide privilege';
  end if;

  if exists (
    with expected_column (table_name, column_name, can_select, can_update) as (
      values
        ('messages', 'id', expected_window_open, false),
        ('messages', 'tenant_id', expected_window_open, false),
        ('messages', 'conversation_id', expected_window_open, false),
        ('messages', 'sender', expected_window_open, false),
        ('messages', 'body', expected_window_open, false),
        ('messages', 'provider', expected_window_open, expected_window_open),
        ('messages', 'provider_message_id', false, expected_window_open),
        ('messages', 'delivery_status', expected_window_open, expected_window_open),
        ('messages', 'delivered_at', expected_window_open, expected_window_open),
        ('messages', 'metadata', expected_window_open, expected_window_open)
    )
    select 1
      from pg_catalog.pg_attribute column_definition
      join pg_catalog.pg_class relation_definition
        on relation_definition.oid = column_definition.attrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation_definition.relnamespace
      left join expected_column
        on expected_column.table_name = relation_definition.relname
       and expected_column.column_name = column_definition.attname
     where namespace.nspname = 'pulso_iris'
       and relation_definition.relkind in ('r', 'p', 'v', 'm', 'f')
       and column_definition.attnum > 0
       and not column_definition.attisdropped
       and (
         has_column_privilege(
           'hyperion_channel',
           relation_definition.oid,
           column_definition.attnum,
           'SELECT'
         ) is distinct from coalesce(expected_column.can_select, false)
         or has_column_privilege(
           'hyperion_channel',
           relation_definition.oid,
           column_definition.attnum,
           'UPDATE'
         ) is distinct from coalesce(expected_column.can_update, false)
         or has_column_privilege(
           'hyperion_channel',
           relation_definition.oid,
           column_definition.attnum,
           'INSERT'
         )
         or has_column_privilege(
           'hyperion_channel',
           relation_definition.oid,
           column_definition.attnum,
           'REFERENCES'
         )
         or has_column_privilege(
           'hyperion_channel',
           relation_definition.oid,
           column_definition.attnum,
           'SELECT WITH GRANT OPTION'
         )
         or has_column_privilege(
           'hyperion_channel',
           relation_definition.oid,
           column_definition.attnum,
           'UPDATE WITH GRANT OPTION'
         )
         or has_column_privilege(
           'hyperion_channel',
           relation_definition.oid,
           column_definition.attnum,
           'INSERT WITH GRANT OPTION'
         )
         or has_column_privilege(
           'hyperion_channel',
           relation_definition.oid,
           column_definition.attnum,
           'REFERENCES WITH GRANT OPTION'
         )
       )
  ) then
    if expected_window_open then
      raise exception 'N-1 Channel SQL window column privileges differ from the exact allow-list';
    end if;
    raise exception 'N-1 Channel-to-PULSO SQL compatibility privileges remain active';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_class sequence_definition
      join pg_catalog.pg_namespace namespace
        on namespace.oid = sequence_definition.relnamespace
     where namespace.nspname = 'pulso_iris'
       and sequence_definition.relkind = 'S'
       and (
         has_sequence_privilege('hyperion_channel', sequence_definition.oid, 'USAGE')
         or has_sequence_privilege('hyperion_channel', sequence_definition.oid, 'SELECT')
         or has_sequence_privilege('hyperion_channel', sequence_definition.oid, 'UPDATE')
       )
  ) then
    raise exception 'N-1 Channel SQL window must not grant sequence privileges';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
     where namespace.nspname = 'pulso_iris'
       and has_function_privilege('hyperion_channel', routine.oid, 'EXECUTE')
  ) then
    raise exception 'N-1 Channel SQL window must not grant routine execution';
  end if;
end
$verify$;
SQL
  )
  sql=${sql/__EXPECTED_WINDOW_OPEN__/$expected_window_open}

  if [[ $mode == "verify-open" ]]; then
    sql+=$(cat <<'SQL'

-- Parse, authorize and plan representative historical Channel statements under
-- the service identity. WHERE false exercises the full privilege boundary
-- without manufacturing or changing rows.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local role hyperion_channel;
insert into channel_runtime.outbound_messages (
  tenant_id, connection_id, thread_binding_id, message_id,
  provider, idempotency_key, body, status
)
select '00000000-0000-0000-0000-000000000000'::uuid,
       binding.connection_id,
       '00000000-0000-0000-0000-000000000000'::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'whatsapp_web_test',
       'n1-channel-window-privilege-probe',
       message.body,
       'queued'
  from channel_runtime.thread_bindings binding
  join pulso_iris.messages message
    on message.tenant_id = binding.tenant_id
   and message.id = '00000000-0000-0000-0000-000000000000'::uuid
 where false
   and binding.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
   and binding.conversation_id = message.conversation_id
   and message.sender = 'sofia'
   and message.provider = 'whatsapp_web_test'
   and message.delivery_status = 'queued'
on conflict do nothing
returning id;

update pulso_iris.messages
   set provider = 'whatsapp_web_test',
       provider_message_id = 'n1-channel-window-privilege-probe',
       delivery_status = case
         when delivery_status in ('delivered', 'read') then delivery_status
         else 'sent'
       end,
       delivered_at = case
         when delivered_at is null then now()
         else delivered_at
       end,
       metadata = coalesce(metadata, '{}'::jsonb) - 'deliveryReconciliationRequired'
 where tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
   and id = '00000000-0000-0000-0000-000000000000'::uuid
   and false;

select id, tenant_id, conversation_id, sender, body, provider,
       delivery_status, delivered_at, metadata
  from pulso_iris.messages
 where false;
rollback;
SQL
    )
  fi
fi

"${compose[@]}" exec -T postgres \
  psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
  --file=- <<<"$sql"
