-- Valida por fases el contrato de recuperacion introducido en 029. Los CHECK
-- NOT VALID ya protegen escrituras nuevas; esta fase separada inspecciona las
-- filas historicas bajo los presupuestos de lock/statement del runner.

alter table lumen.processing_attempts
  validate constraint ck_lumen_processing_attempt_status;

alter table lumen.processing_attempts
  validate constraint ck_lumen_processing_attempt_cleanup_protocol;

alter table lumen.processing_attempts
  validate constraint ck_lumen_processing_attempt_cleanup_state;

alter table lumen.processing_attempts
  validate constraint ck_lumen_processing_attempt_cleanup_target;

alter table lumen.processing_attempts
  validate constraint ck_lumen_processing_attempt_cleanup_identity;

alter table lumen.processing_attempts
  validate constraint ck_lumen_processing_attempt_cleanup_evidence;

alter table lumen.processing_attempts
  validate constraint ck_lumen_processing_attempt_lifecycle;

-- La lease verifica que un cleanup_owner solo tenga un proceso habilitado para
-- recuperar o eliminar sus directorios deterministas. El holder cambia en cada
-- proceso y nunca forma parte de una ruta de filesystem.
create table lumen.audio_cleanup_owner_leases (
  cleanup_owner text primary key,
  holder_id uuid not null,
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint ck_lumen_audio_cleanup_lease_owner check (
    cleanup_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
  ),
  constraint ck_lumen_audio_cleanup_lease_window check (
    acquired_at <= heartbeat_at and heartbeat_at < expires_at
  )
);

comment on table lumen.audio_cleanup_owner_leases is
  'Exclusive renewable leases that fence temporary-audio recovery by stable cleanup owner.';
comment on column lumen.audio_cleanup_owner_leases.holder_id is
  'Random per-process fencing identity; never a credential or filesystem path.';

-- La compatibilidad N-1 amplía privilegios únicamente durante una ventana
-- explícita y auditable. Estas tablas son administrativas: el runtime LUMEN no
-- recibe DML sobre ellas y no puede autoatestiguar la destrucción de su scope.
create table lumen.n_minus_one_compatibility_windows (
  cleanup_scope_id text primary key,
  rollback_evidence_sha256 text not null,
  opened_at timestamptz not null default now(),
  opened_by text not null default session_user,
  closed_at timestamptz,
  closed_by text,
  close_reason text,
  constraint ck_lumen_n1_window_scope check (
    cleanup_scope_id ~ '^lumen-n1-[A-Za-z0-9][A-Za-z0-9_.-]{7,47}$'
  ),
  constraint ck_lumen_n1_window_evidence check (
    rollback_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint ck_lumen_n1_window_close check (
    (
      closed_at is null
      and closed_by is null
      and close_reason is null
    )
    or (
      closed_at is not null
      and closed_at >= opened_at
      and length(btrim(closed_by)) between 1 and 120
      and close_reason in ('operator_closed', 'bootstrap_reconciled')
    )
  )
);

-- Incluso un cliente administrativo que omita el CLI no puede mantener dos
-- ventanas abiertas al mismo tiempo. La tabla es nueva y vacia en esta fase,
-- por lo que el indice no necesita una construccion concurrente.
create unique index ux_lumen_single_open_n1_compatibility_window
  on lumen.n_minus_one_compatibility_windows ((1))
  where closed_at is null;

create table lumen.legacy_audio_scope_attestations (
  attestation_id uuid primary key,
  cleanup_scope_id text not null unique
    references lumen.n_minus_one_compatibility_windows(cleanup_scope_id) on delete restrict,
  destroyed_at timestamptz not null,
  evidence_sha256 text not null,
  finalized_attempt_count integer not null default 0,
  attested_at timestamptz not null default now(),
  attested_by text not null default session_user,
  constraint ck_lumen_legacy_scope_attestation_evidence check (
    evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint ck_lumen_legacy_scope_attestation_count check (
    finalized_attempt_count >= 0
  ),
  constraint ck_lumen_legacy_scope_attestation_time check (
    destroyed_at <= attested_at
  )
);

comment on table lumen.n_minus_one_compatibility_windows is
  'Admin-only audit of temporary, least-privilege database grants used by one exact N-1 LUMEN rollback scope.';
comment on table lumen.legacy_audio_scope_attestations is
  'Admin-only cryptographic evidence that an N-1 ephemeral scope was destroyed before its legacy attempts were finalized.';
comment on column lumen.legacy_audio_scope_attestations.evidence_sha256 is
  'SHA-256 of external orchestrator evidence; raw logs, paths and credentials are never stored here.';

revoke all privileges on table lumen.audio_cleanup_owner_leases from public;
grant select, insert, update, delete on table lumen.audio_cleanup_owner_leases to hyperion_lumen;
revoke all privileges on table lumen.n_minus_one_compatibility_windows from public, hyperion_lumen;
revoke all privileges on table lumen.legacy_audio_scope_attestations from public, hyperion_lumen;

-- El guard 029 primero normaliza y vincula el INSERT legacy al PGAPPNAME. Este
-- segundo guard corre AFTER INSERT para comprobar, con autoridad administrativa
-- y sin exponer el ledger al runtime, que ese scope tiene una ventana abierta.
-- Si no existe, la excepcion revierte el INSERT completo.
create or replace function lumen.require_open_n1_compatibility_window()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, lumen
as $$
begin
  if new.cleanup_scope_id is null or not exists (
    select 1
      from lumen.n_minus_one_compatibility_windows compatibility_window
     where compatibility_window.cleanup_scope_id = new.cleanup_scope_id
       and compatibility_window.closed_at is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'legacy LUMEN transcription requires an open administrative compatibility window';
  end if;
  return new;
end;
$$;

revoke all privileges
  on function lumen.require_open_n1_compatibility_window()
  from public, hyperion_lumen;

drop trigger if exists trg_require_open_n1_compatibility_window on lumen.processing_attempts;
create trigger trg_require_open_n1_compatibility_window
after insert on lumen.processing_attempts
for each row
when (
  new.operation = 'transcription'
  and new.cleanup_protocol = 'legacy_ephemeral_v1'
)
execute function lumen.require_open_n1_compatibility_window();

-- Un runtime legacy puede confirmar el rm de su propia solicitud mientras el
-- intento sigue en processing, pero nunca puede inventar la destruccion de un
-- scope ni sacar por si mismo un cleanup_pending a estado terminal. Esas dos
-- transiciones requieren una sesion administrativa y una atestacion durable
-- del mismo scope/timestamp. AFTER UPDATE garantiza que el guard 029 ya aplico
-- todas sus normalizaciones e invariantes antes de esta comprobacion.
create or replace function lumen.require_attested_legacy_cleanup_terminal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, lumen
as $$
declare
  caller_is_administrator boolean;
  requires_attestation boolean;
begin
  requires_attestation := (
    old.status = 'cleanup_pending'
    and new.status in ('failed', 'cancelled')
  ) or (
    new.cleanup_disposition = 'ephemeral_scope_destroyed'
    and old.cleanup_disposition is distinct from new.cleanup_disposition
  );

  if not requires_attestation then
    return new;
  end if;

  if old.status = 'cleanup_pending'
    and new.cleanup_disposition is distinct from 'ephemeral_scope_destroyed' then
    raise exception using
      errcode = '23514',
      message = 'legacy cleanup-pending terminalization requires scope-destruction attestation';
  end if;

  select coalesce(role.rolsuper or role.rolcreaterole, false)
    into caller_is_administrator
    from pg_catalog.pg_roles role
   where role.rolname = session_user;

  if not coalesce(caller_is_administrator, false) then
    raise exception using
      errcode = '42501',
      message = 'legacy scope destruction can only be finalized by an administrative role';
  end if;

  if new.cleanup_scope_id is null
    or new.temp_audio_deleted_at is null
    or not exists (
      select 1
        from lumen.legacy_audio_scope_attestations attestation
        join lumen.n_minus_one_compatibility_windows compatibility_window
          on compatibility_window.cleanup_scope_id = attestation.cleanup_scope_id
       where attestation.cleanup_scope_id = new.cleanup_scope_id
         and attestation.destroyed_at = new.temp_audio_deleted_at
         and compatibility_window.closed_at is not null
    ) then
    raise exception using
      errcode = '23514',
      message = 'legacy scope destruction requires a matching closed-window attestation';
  end if;

  return new;
end;
$$;

revoke all privileges
  on function lumen.require_attested_legacy_cleanup_terminal()
  from public, hyperion_lumen;

drop trigger if exists trg_require_attested_legacy_cleanup_terminal on lumen.processing_attempts;
create trigger trg_require_attested_legacy_cleanup_terminal
after update on lumen.processing_attempts
for each row
when (
  old.cleanup_protocol = 'legacy_ephemeral_v1'
  and (
    old.status = 'cleanup_pending'
    or new.cleanup_disposition = 'ephemeral_scope_destroyed'
  )
)
execute function lumen.require_attested_legacy_cleanup_terminal();

insert into lumen.service_migrations (version, name)
values (32, '032-lumen-audio-cleanup-contract.sql')
on conflict (version) do update set name = excluded.name;

insert into lumen.schema_version (service_name, current_version, migration_name)
values ('lumen', 32, '032-lumen-audio-cleanup-contract.sql')
on conflict (service_name) do update set
  current_version = greatest(lumen.schema_version.current_version, excluded.current_version),
  migration_name = case
    when excluded.current_version >= lumen.schema_version.current_version then excluded.migration_name
    else lumen.schema_version.migration_name
  end,
  updated_at = now();
