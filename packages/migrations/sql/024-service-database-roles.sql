-- Incremental PostgreSQL isolation for Compose service identities.
--
-- Compose runs migrations while service identities remain NOLOGIN. This
-- migration creates or preserves that fenced state so its checksum can never
-- record a false no-op. Only after all migrations succeed does
-- packages/migrations/src/bootstrap-roles.ts validate the privilege matrix,
-- rotate credentials atomically and activate the roles.

do $$
declare
  required_roles constant text[] := array[
    'hyperion_access',
    'hyperion_sofia',
    'hyperion_knowledge',
    'hyperion_audit',
    'hyperion_integration',
    'hyperion_pulso',
    'hyperion_channel',
    'hyperion_lumen'
  ];
  managed_schemas constant text[] := array[
    'platform',
    'pulso_iris',
    'channel_runtime',
    'agent_runtime',
    'audit_runtime',
    'lumen'
  ];
  access_tables constant text[] := array[
    'platform.tenants',
    'platform.operators',
    'platform.operator_sessions',
    'platform.operator_tenants',
    'platform.products'
  ];
  sofia_tables constant text[] := array[
    'platform.agents',
    'platform.prompt_flows',
    'agent_runtime.jobs',
    'agent_runtime.executions',
    'agent_runtime.inbox_events',
    'agent_runtime.outbox_events'
  ];
  knowledge_tables constant text[] := array[
    'platform.knowledge_sources'
  ];
  audit_tables constant text[] := array[
    'platform.audit_events',
    'audit_runtime.inbox_events'
  ];
  integration_tables constant text[] := array[
    'platform.integrations'
  ];
  pulso_tables constant text[] := array[
    'pulso_iris.sites',
    'pulso_iris.professionals',
    'pulso_iris.payers',
    'pulso_iris.administrative_patients',
    'pulso_iris.conversations',
    'pulso_iris.messages',
    'pulso_iris.appointments',
    'pulso_iris.rpa_actions',
    'pulso_iris.handoffs',
    'pulso_iris.operational_kpi_snapshots',
    'pulso_iris.appointment_types',
    'pulso_iris.rpa_workers',
    'pulso_iris.rpa_events',
    'pulso_iris.campaigns',
    'pulso_iris.campaign_contacts',
    'pulso_iris.waitlist',
    'pulso_iris.availability_rules',
    'pulso_iris.agenda_blocks',
    'pulso_iris.holidays',
    'pulso_iris.professional_payer_exclusions',
    'pulso_iris.agenda_settings',
    'pulso_iris.professional_sites',
    'pulso_iris.professional_appointment_types',
    'pulso_iris.appointment_holds',
    'pulso_iris.appointment_status_history',
    'pulso_iris.configuration_imports',
    'pulso_iris.inbox_events',
    'pulso_iris.channel_threads',
    'pulso_iris.outbox_events'
  ];
  channel_tables constant text[] := array[
    'channel_runtime.connections',
    'channel_runtime.thread_bindings',
    'channel_runtime.inbound_events',
    'channel_runtime.outbound_messages',
    'channel_runtime.delivery_receipts',
    'channel_runtime.outbox_events'
  ];
  lumen_tables constant text[] := array[
    'lumen.service_migrations',
    'lumen.schema_version',
    'lumen.tenant_snapshots',
    'lumen.operator_grants',
    'lumen.encounter_reference_snapshots',
    'lumen.inbox_events',
    'lumen.outbox_events',
    'lumen.encounters',
    'lumen.preconsultation_summaries',
    'lumen.dictations',
    'lumen.clinical_records',
    'lumen.processing_attempts'
  ];
  role_name text;
  schema_name text;
  qualified_table text;
  owned_tables text[];
  owned_role text;
  sequence_name text;
begin
  foreach role_name in array required_roles loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'create role %I with nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
        role_name
      );
    end if;
  end loop;

  if exists (
    select 1
      from pg_roles
     where rolname = any(required_roles)
       and (rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolreplication or rolbypassrls)
  ) then
    raise exception 'Hyperion service roles have unsafe PostgreSQL capabilities';
  end if;

  -- Existing memberships or object ownership would make the effective rights
  -- wider than this migration can prove. Fail closed instead of layering a
  -- misleading allow-list on top of them.
  if exists (
    select 1
      from pg_auth_members membership
      join pg_roles member_role on member_role.oid = membership.member
     where member_role.rolname = any(required_roles)
  ) then
    raise exception 'Hyperion service LOGIN roles must not inherit or SET ROLE into other roles';
  end if;

  if exists (
    select 1
      from pg_shdepend dependency
      join pg_roles owner_role on owner_role.oid = dependency.refobjid
     where dependency.refclassid = 'pg_authid'::regclass
       and dependency.deptype = 'o'
       and owner_role.rolname = any(required_roles)
  ) or exists (
    select 1 from pg_class object
      join pg_roles owner_role on owner_role.oid = object.relowner
     where owner_role.rolname = any(required_roles)
  ) or exists (
    select 1 from pg_namespace object
      join pg_roles owner_role on owner_role.oid = object.nspowner
     where owner_role.rolname = any(required_roles)
  ) or exists (
    select 1 from pg_proc object
      join pg_roles owner_role on owner_role.oid = object.proowner
     where owner_role.rolname = any(required_roles)
  ) or exists (
    select 1 from pg_database object
      join pg_roles owner_role on owner_role.oid = object.datdba
     where owner_role.rolname = any(required_roles)
  ) or exists (
    select 1 from pg_type object
      join pg_roles owner_role on owner_role.oid = object.typowner
     where owner_role.rolname = any(required_roles)
  ) or exists (
    select 1 from pg_extension object
      join pg_roles owner_role on owner_role.oid = object.extowner
     where owner_role.rolname = any(required_roles)
  ) then
    raise exception 'Hyperion service LOGIN roles must not own database objects';
  end if;

  -- In an explicitly bootstrapped environment, database access is allow-listed.
  -- The database owner keeps its inherent administration rights.
  execute format(
    'revoke connect, create, temporary on database %I from public',
    current_database()
  );

  foreach role_name in array required_roles loop
    execute format('revoke all privileges on database %I from %I', current_database(), role_name);
    execute format('grant connect on database %I to %I', current_database(), role_name);

    foreach schema_name in array managed_schemas loop
      execute format('revoke all privileges on schema %I from %I', schema_name, role_name);
      execute format('revoke all privileges on all tables in schema %I from %I', schema_name, role_name);
      execute format('revoke all privileges on all sequences in schema %I from %I', schema_name, role_name);
      execute format('revoke all privileges on all functions in schema %I from %I', schema_name, role_name);
    end loop;
  end loop;

  -- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Managed
  -- service objects must always be explicitly reachable instead.
  foreach schema_name in array managed_schemas loop
    execute format('revoke all privileges on all tables in schema %I from public', schema_name);
    execute format('revoke all privileges on all sequences in schema %I from public', schema_name);
    execute format('revoke execute on all functions in schema %I from public', schema_name);
    execute format('revoke create on schema %I from public', schema_name);

    execute format(
      'alter default privileges for role %I in schema %I revoke all on tables from public',
      current_user,
      schema_name
    );
    execute format(
      'alter default privileges for role %I in schema %I revoke all on sequences from public',
      current_user,
      schema_name
    );
    execute format(
      'alter default privileges for role %I in schema %I revoke execute on functions from public',
      current_user,
      schema_name
    );
  end loop;

  -- Schema visibility. LUMEN intentionally receives no USAGE outside lumen.
  grant usage on schema platform to hyperion_access, hyperion_sofia, hyperion_knowledge,
    hyperion_audit, hyperion_integration, hyperion_pulso, hyperion_channel;
  grant usage on schema pulso_iris to hyperion_sofia, hyperion_integration, hyperion_pulso;
  grant usage on schema channel_runtime to hyperion_sofia, hyperion_channel;
  grant usage on schema agent_runtime to hyperion_sofia;
  grant usage on schema audit_runtime to hyperion_audit;
  grant usage on schema lumen to hyperion_lumen;

  -- An owner role receives ordinary DML on its explicitly owned tables. Object
  -- ownership remains with the migration administrator so services cannot alter
  -- schemas or bypass future grant review.
  for owned_role, owned_tables in
    select * from (values
      ('hyperion_access', access_tables),
      ('hyperion_sofia', sofia_tables),
      ('hyperion_knowledge', knowledge_tables),
      ('hyperion_audit', audit_tables),
      ('hyperion_integration', integration_tables),
      ('hyperion_pulso', pulso_tables),
      ('hyperion_channel', channel_tables),
      ('hyperion_lumen', lumen_tables)
    ) ownership(role_name, tables)
  loop
    foreach qualified_table in array owned_tables loop
      execute format(
        'grant select, insert, update, delete on table %I.%I to %I',
        split_part(qualified_table, '.', 1),
        split_part(qualified_table, '.', 2),
        owned_role
      );

      -- Cover any identity/serial sequence attached to an owned table without
      -- granting unrelated sequences from the shared platform schema.
      for sequence_name in
        select pg_get_serial_sequence(qualified_table, attribute.attname)
          from pg_attribute attribute
         where attribute.attrelid = to_regclass(qualified_table)
           and attribute.attnum > 0
           and not attribute.attisdropped
           and pg_get_serial_sequence(qualified_table, attribute.attname) is not null
      loop
        execute format('grant usage on sequence %s to %I', sequence_name, owned_role);
      end loop;
    end loop;
  end loop;

  -- Audit owns an append-only ledger and inbox. Its runtime may append and
  -- read evidence, but ordinary service credentials cannot rewrite or erase it.
  revoke update, delete on table platform.audit_events from hyperion_audit;
  revoke update, delete on table audit_runtime.inbox_events from hyperion_audit;

  -- Readiness checks still use the central migration ledger until each service
  -- has its own schema version. LUMEN already uses lumen.schema_version.
  grant select on table platform.schema_migrations to hyperion_access, hyperion_sofia,
    hyperion_knowledge, hyperion_audit, hyperion_integration, hyperion_pulso, hyperion_channel;

  -- Transitional runtime debt, kept table- and verb-specific. These grants
  -- mirror docs/architecture/boundary-baseline.json and must shrink with it.
  grant select on table platform.products to hyperion_sofia;
  grant select on table pulso_iris.administrative_patients, pulso_iris.conversations,
    pulso_iris.messages to hyperion_sofia;
  grant select on table channel_runtime.outbound_messages to hyperion_sofia;

  grant select on table platform.agents, platform.prompt_flows to hyperion_integration;
  grant select on table pulso_iris.agenda_settings, pulso_iris.availability_rules,
    pulso_iris.professionals to hyperion_integration;

  grant select on table platform.audit_events to hyperion_pulso;

  -- The legacy tenant bootstrap trigger is the sole remaining write that
  -- crosses from Access into PULSO. Keep Access out of the PULSO schema: the
  -- narrowly scoped trigger function runs as its migration-admin owner and
  -- uses a fixed, trusted search_path until that coupling becomes an event.
  alter function pulso_iris.initialize_agenda_settings() security definer;
  alter function pulso_iris.initialize_agenda_settings() set search_path = pg_catalog, pulso_iris;

  -- Runtime-invoked functions and trigger functions remain scoped to their
  -- service schemas. No cross-service EXECUTE grant is needed.
  grant execute on all functions in schema pulso_iris to hyperion_pulso;
  grant execute on all functions in schema channel_runtime to hyperion_channel;
  grant execute on all functions in schema agent_runtime to hyperion_sofia;
  grant execute on all functions in schema lumen to hyperion_lumen;

  -- Default grants are safe only for single-owner schemas. The shared platform
  -- schema intentionally requires an explicit table grant in a future migration.
  alter default privileges for role current_user in schema pulso_iris
    grant select, insert, update, delete on tables to hyperion_pulso;
  alter default privileges for role current_user in schema pulso_iris
    grant usage on sequences to hyperion_pulso;
  alter default privileges for role current_user in schema pulso_iris
    grant execute on functions to hyperion_pulso;

  alter default privileges for role current_user in schema channel_runtime
    grant select, insert, update, delete on tables to hyperion_channel;
  alter default privileges for role current_user in schema channel_runtime
    grant usage on sequences to hyperion_channel;
  alter default privileges for role current_user in schema channel_runtime
    grant execute on functions to hyperion_channel;

  alter default privileges for role current_user in schema agent_runtime
    grant select, insert, update, delete on tables to hyperion_sofia;
  alter default privileges for role current_user in schema agent_runtime
    grant usage on sequences to hyperion_sofia;
  alter default privileges for role current_user in schema agent_runtime
    grant execute on functions to hyperion_sofia;

  alter default privileges for role current_user in schema audit_runtime
    grant select, insert on tables to hyperion_audit;
  alter default privileges for role current_user in schema audit_runtime
    grant usage on sequences to hyperion_audit;

  alter default privileges for role current_user in schema lumen
    grant select, insert, update, delete on tables to hyperion_lumen;
  alter default privileges for role current_user in schema lumen
    grant usage on sequences to hyperion_lumen;
  alter default privileges for role current_user in schema lumen
    grant execute on functions to hyperion_lumen;
end
$$;
