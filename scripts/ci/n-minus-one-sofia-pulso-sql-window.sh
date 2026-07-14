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

# The historical N-1 SOFIA image predates the PULSO owner APIs. It still writes
# conversation runtime state and the idempotent outbound message in SQL. Current
# images use authenticated PULSO HTTP routes instead. This expand/contract window
# restores only those legacy columns while an exact N-1 rollback is rehearsed.
if [[ $mode == "open" ]]; then
  sql=$(cat <<'SQL'
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select pg_advisory_xact_lock(hashtextextended('hyperion:n1:sofia-pulso-sql-window', 0));

-- Reset the role's complete PULSO ACL before reconstructing the durable read
-- baseline plus the temporary write allow-list. A table REVOKE also removes
-- its corresponding column grants, so interrupted opens cannot accumulate ACLs.
revoke all privileges on schema pulso_iris from hyperion_sofia;
revoke all privileges on all tables in schema pulso_iris from hyperion_sofia;
revoke all privileges on all sequences in schema pulso_iris from hyperion_sofia;
revoke all privileges on all routines in schema pulso_iris from hyperion_sofia;

grant usage on schema pulso_iris to hyperion_sofia;
grant select on table pulso_iris.administrative_patients,
  pulso_iris.conversations, pulso_iris.messages to hyperion_sofia;

grant update (metadata, primary_intent, updated_at)
  on table pulso_iris.conversations to hyperion_sofia;
grant insert (
    tenant_id, conversation_id, sender, body, provider,
    external_message_id, delivery_status, metadata
  ), update (body)
  on table pulso_iris.messages to hyperion_sofia;

commit;
SQL
  )
  echo "opening N-1 SOFIA-to-PULSO SQL compatibility window"
elif [[ $mode == "close" ]]; then
  sql=$(cat <<'SQL'
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select pg_advisory_xact_lock(hashtextextended('hyperion:n1:sofia-pulso-sql-window', 0));

revoke all privileges on schema pulso_iris from hyperion_sofia;
revoke all privileges on all tables in schema pulso_iris from hyperion_sofia;
revoke all privileges on all sequences in schema pulso_iris from hyperion_sofia;
revoke all privileges on all routines in schema pulso_iris from hyperion_sofia;

grant usage on schema pulso_iris to hyperion_sofia;
grant select on table pulso_iris.administrative_patients,
  pulso_iris.conversations, pulso_iris.messages to hyperion_sofia;

commit;
SQL
  )
  echo "closing N-1 SOFIA-to-PULSO SQL compatibility window"
else
  expected_window_open=false
  if [[ $mode == "verify-open" ]]; then
    expected_window_open=true
    echo "verifying the bounded N-1 SOFIA-to-PULSO SQL compatibility window"
  else
    echo "verifying the N-1 SOFIA-to-PULSO SQL compatibility window is closed"
  fi

  sql=$(cat <<'SQL'
do $verify$
declare
  expected_window_open boolean := __EXPECTED_WINDOW_OPEN__;
begin
  if not exists (
    select 1
      from pg_catalog.pg_roles role_definition
     where role_definition.rolname = 'hyperion_sofia'
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
     where member_role.rolname = 'hyperion_sofia'
        or granted_role.rolname = 'hyperion_sofia'
  ) then
    raise exception 'N-1 SOFIA SQL window requires the fixed unprivileged hyperion_sofia identity';
  end if;

  if not has_database_privilege('hyperion_sofia', current_database(), 'CONNECT')
     or has_database_privilege('hyperion_sofia', current_database(), 'CREATE')
     or has_database_privilege('hyperion_sofia', current_database(), 'TEMPORARY')
     or has_database_privilege('hyperion_sofia', current_database(), 'CONNECT WITH GRANT OPTION')
     or exists (
       select 1
         from pg_catalog.pg_database database_definition
         join pg_catalog.pg_roles owner_role on owner_role.oid = database_definition.datdba
        where database_definition.datname = current_database()
          and owner_role.rolname = 'hyperion_sofia'
     ) then
    raise exception 'N-1 SOFIA SQL window requires CONNECT-only database access';
  end if;

  if exists (
       select 1
         from pg_catalog.pg_namespace namespace
         join pg_catalog.pg_roles owner_role on owner_role.oid = namespace.nspowner
        where namespace.nspname = 'pulso_iris'
          and owner_role.rolname = 'hyperion_sofia'
     )
     or exists (
       select 1
         from pg_catalog.pg_class relation_definition
         join pg_catalog.pg_namespace namespace
           on namespace.oid = relation_definition.relnamespace
         join pg_catalog.pg_roles owner_role on owner_role.oid = relation_definition.relowner
        where namespace.nspname = 'pulso_iris'
          and owner_role.rolname = 'hyperion_sofia'
     )
     or exists (
       select 1
         from pg_catalog.pg_proc routine
         join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
        where namespace.nspname = 'pulso_iris'
          and owner_role.rolname = 'hyperion_sofia'
     )
     or exists (
       select 1
         from pg_catalog.pg_type type_definition
         join pg_catalog.pg_namespace namespace on namespace.oid = type_definition.typnamespace
         join pg_catalog.pg_roles owner_role on owner_role.oid = type_definition.typowner
        where namespace.nspname = 'pulso_iris'
          and owner_role.rolname = 'hyperion_sofia'
     ) then
    raise exception 'N-1 SOFIA SQL window role must not own PULSO objects';
  end if;

  if not has_schema_privilege('hyperion_sofia', 'pulso_iris', 'USAGE')
     or has_schema_privilege('hyperion_sofia', 'pulso_iris', 'CREATE')
     or has_schema_privilege('hyperion_sofia', 'pulso_iris', 'USAGE WITH GRANT OPTION')
     or has_schema_privilege('hyperion_sofia', 'pulso_iris', 'CREATE WITH GRANT OPTION') then
    raise exception 'N-1 SOFIA SQL window has invalid pulso_iris schema privileges';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_class relation_definition
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation_definition.relnamespace
     where namespace.nspname = 'pulso_iris'
       and relation_definition.relkind in ('r', 'p', 'v', 'm', 'f')
       and (
         has_table_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           'SELECT'
         ) is distinct from (
           relation_definition.relname in ('administrative_patients', 'conversations', 'messages')
         )
         or has_table_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           'SELECT WITH GRANT OPTION'
         )
         or has_table_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           'INSERT'
         )
         or has_table_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           'UPDATE'
         )
         or has_table_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           'DELETE'
         )
         or has_table_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           'TRUNCATE'
         )
         or has_table_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           'REFERENCES'
         )
         or has_table_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           'TRIGGER'
         )
       )
  ) then
    raise exception 'N-1 SOFIA SQL window table privileges differ from the durable read baseline';
  end if;

  if exists (
    with expected_write (table_name, column_name, can_insert, can_update) as (
      values
        ('conversations', 'metadata', false, expected_window_open),
        ('conversations', 'primary_intent', false, expected_window_open),
        ('conversations', 'updated_at', false, expected_window_open),
        ('messages', 'tenant_id', expected_window_open, false),
        ('messages', 'conversation_id', expected_window_open, false),
        ('messages', 'sender', expected_window_open, false),
        ('messages', 'body', expected_window_open, expected_window_open),
        ('messages', 'provider', expected_window_open, false),
        ('messages', 'external_message_id', expected_window_open, false),
        ('messages', 'delivery_status', expected_window_open, false),
        ('messages', 'metadata', expected_window_open, false)
    )
    select 1
      from pg_catalog.pg_attribute column_definition
      join pg_catalog.pg_class relation_definition
        on relation_definition.oid = column_definition.attrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation_definition.relnamespace
      left join expected_write
        on expected_write.table_name = relation_definition.relname
       and expected_write.column_name = column_definition.attname
     where namespace.nspname = 'pulso_iris'
       and relation_definition.relkind in ('r', 'p', 'v', 'm', 'f')
       and column_definition.attnum > 0
       and not column_definition.attisdropped
       and (
         has_column_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           column_definition.attnum,
           'SELECT'
         ) is distinct from (
           relation_definition.relname in ('administrative_patients', 'conversations', 'messages')
         )
         or has_column_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           column_definition.attnum,
           'INSERT'
         ) is distinct from coalesce(expected_write.can_insert, false)
         or has_column_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           column_definition.attnum,
           'UPDATE'
         ) is distinct from coalesce(expected_write.can_update, false)
         or has_column_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           column_definition.attnum,
           'REFERENCES'
         )
         or has_column_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           column_definition.attnum,
           'SELECT WITH GRANT OPTION'
         )
         or has_column_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           column_definition.attnum,
           'INSERT WITH GRANT OPTION'
         )
         or has_column_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           column_definition.attnum,
           'UPDATE WITH GRANT OPTION'
         )
         or has_column_privilege(
           'hyperion_sofia',
           relation_definition.oid,
           column_definition.attnum,
           'REFERENCES WITH GRANT OPTION'
         )
       )
  ) then
    if expected_window_open then
      raise exception 'N-1 SOFIA SQL window column privileges differ from the exact allow-list';
    end if;
    raise exception 'N-1 SOFIA-to-PULSO SQL compatibility writes remain active';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_class sequence_definition
      join pg_catalog.pg_namespace namespace
        on namespace.oid = sequence_definition.relnamespace
     where namespace.nspname = 'pulso_iris'
       and sequence_definition.relkind = 'S'
       and (
         has_sequence_privilege('hyperion_sofia', sequence_definition.oid, 'USAGE')
         or has_sequence_privilege('hyperion_sofia', sequence_definition.oid, 'SELECT')
         or has_sequence_privilege('hyperion_sofia', sequence_definition.oid, 'UPDATE')
       )
  ) then
    raise exception 'N-1 SOFIA SQL window must not grant sequence privileges';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
     where namespace.nspname = 'pulso_iris'
       and has_function_privilege('hyperion_sofia', routine.oid, 'EXECUTE')
  ) then
    raise exception 'N-1 SOFIA SQL window must not grant routine execution';
  end if;
end
$verify$;
SQL
  )
  sql=${sql/__EXPECTED_WINDOW_OPEN__/$expected_window_open}

  if [[ $mode == "verify-open" ]]; then
    sql+=$(cat <<'SQL'

-- Parse, authorize and plan the exact historical statements under the service
-- role. WHERE false exercises INSERT/ON CONFLICT without manufacturing rows.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local role hyperion_sofia;
update pulso_iris.conversations
   set metadata = metadata || jsonb_build_object('sofiaStatus', 'processing'),
       primary_intent = coalesce('compatibility_probe', primary_intent),
       updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
   and id = '00000000-0000-0000-0000-000000000000'::uuid
   and false;
insert into pulso_iris.messages (
  tenant_id, conversation_id, sender, body, provider,
  external_message_id, delivery_status, metadata
)
select '00000000-0000-0000-0000-000000000000'::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'sofia',
       'Synthetic compatibility response',
       'whatsapp_web_test',
       'n1-sofia-window-privilege-probe',
       'queued',
       '{}'::jsonb
where false
on conflict (tenant_id, provider, external_message_id)
  where provider is not null and external_message_id is not null
do update set body = pulso_iris.messages.body
returning id, body;
select message.body, conversation.status
  from pulso_iris.messages message
  join pulso_iris.conversations conversation
    on conversation.tenant_id = message.tenant_id
   and conversation.id = message.conversation_id
 where false;
select sender, body, created_at from pulso_iris.messages where false;
select metadata, primary_intent from pulso_iris.conversations where false;
select full_name from pulso_iris.administrative_patients where false;
rollback;
SQL
    )
  fi
fi

"${compose[@]}" exec -T postgres \
  psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
  --file=- <<<"$sql"
