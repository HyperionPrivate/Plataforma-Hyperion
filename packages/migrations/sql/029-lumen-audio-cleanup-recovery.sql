-- Recuperacion durable de audio temporal LUMEN con una ventana N/N-1.
--
-- El protocolo actual reconstruye un directorio privado a partir de un owner
-- estable y el UUID del intento. La imagen N-1 usa mkdtemp y no conoce esa
-- ruta; por eso se etiqueta como legacy_ephemeral_v1 y se vincula al scope
-- efimero de su proceso mediante PostgreSQL application_name (PGAPPNAME).
-- Nunca se convierte un intento legacy en una ruta determinista.

alter table lumen.processing_attempts
  add column cleanup_protocol text default 'legacy_ephemeral_v1',
  add column cleanup_owner text,
  add column cleanup_scope_id text,
  add column cleanup_target_status text,
  add column cleanup_disposition text;

-- Los intentos previos a esta expansion no tienen ni ruta determinista ni un
-- scope efimero atribuible. Deben drenarse antes de instalar el trigger que
-- permite nuevos writers N-1 identificados con PGAPPNAME.
do $$
begin
  if exists (
    select 1
    from lumen.processing_attempts
    where operation = 'transcription' and status = 'processing'
  ) then
    raise exception using
      errcode = '55000',
      message = 'drain active LUMEN transcription attempts and clean the legacy temp root before migration 029';
  end if;
end
$$;

-- Structuring nunca maneja audio. Los terminales heredados sólo podían llegar
-- a ese estado bajo el contrato 020 cuando temp_audio_deleted_at era no nulo;
-- se conserva esa evidencia sin inventar una ruta o un scope histórico.
update lumen.processing_attempts
   set cleanup_protocol = null
 where operation = 'structuring';

update lumen.processing_attempts
   set cleanup_disposition = 'legacy_terminal_contract'
 where operation = 'transcription'
   and status in ('completed', 'failed', 'cancelled')
   and temp_audio_deleted_at is not null;

alter table lumen.processing_attempts
  drop constraint if exists processing_attempts_status_check,
  drop constraint if exists ck_lumen_processing_attempt_lifecycle;

alter table lumen.processing_attempts
  add constraint ck_lumen_processing_attempt_status check (
    status in ('processing', 'cleanup_pending', 'completed', 'failed', 'cancelled')
  ) not valid,
  add constraint ck_lumen_processing_attempt_cleanup_protocol check (
    (operation = 'structuring' and cleanup_protocol is null)
    or (
      operation = 'transcription'
      and cleanup_protocol in ('legacy_ephemeral_v1', 'deterministic_v2')
    )
  ) not valid,
  add constraint ck_lumen_processing_attempt_cleanup_state check (
    (cleanup_owner is null or cleanup_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
    and (
      cleanup_scope_id is null
      or cleanup_scope_id ~ '^lumen-n1-[A-Za-z0-9][A-Za-z0-9_.-]{7,47}$'
    )
  ) not valid,
  add constraint ck_lumen_processing_attempt_cleanup_target check (
    (
      status = 'cleanup_pending'
      and operation = 'transcription'
      and cleanup_target_status in ('failed', 'cancelled')
    )
    or (
      status <> 'cleanup_pending'
      and cleanup_target_status is null
    )
  ) not valid,
  add constraint ck_lumen_processing_attempt_cleanup_identity check (
    (
      operation = 'structuring'
      and cleanup_protocol is null
      and cleanup_owner is null
      and cleanup_scope_id is null
      and cleanup_disposition is null
    )
    or (
      operation = 'transcription'
      and cleanup_protocol = 'deterministic_v2'
      and cleanup_owner is not null
      and cleanup_scope_id is null
      and (
        cleanup_disposition is null
        or cleanup_disposition in ('attempt_finalizer', 'deterministic_reconciler')
      )
    )
    or (
      operation = 'transcription'
      and cleanup_protocol = 'legacy_ephemeral_v1'
      and cleanup_owner is null
      and (
        status not in ('processing', 'cleanup_pending')
        or cleanup_scope_id is not null
      )
      and (
        cleanup_disposition is null
        or cleanup_disposition in (
          'legacy_request_finalizer',
          'legacy_terminal_contract',
          'ephemeral_scope_destroyed'
        )
      )
    )
  ) not valid,
  add constraint ck_lumen_processing_attempt_cleanup_evidence check (
    (temp_audio_deleted_at is null and cleanup_disposition is null)
    or (temp_audio_deleted_at is not null and cleanup_disposition is not null)
  ) not valid,
  add constraint ck_lumen_processing_attempt_lifecycle check (
    (
      (
        status = 'processing'
        and completed_at is null
        and failed_at is null
        and cancelled_at is null
        and result_entity_id is null
        and result_snapshot is null
        and result_sha256 is null
        and result_version is null
        and error_code is null
        and temp_audio_deleted_at is null
      )
      or (
        status = 'cleanup_pending'
        and completed_at is null
        and failed_at is null
        and cancelled_at is null
        and result_entity_id is null
        and result_snapshot is null
        and result_sha256 is null
        and result_version is null
        and error_code is not null
        and temp_audio_deleted_at is null
      )
      or (
        status = 'completed'
        and completed_at is not null
        and failed_at is null
        and cancelled_at is null
        and result_entity_id is not null
        and error_code is null
      )
      or (
        status = 'failed'
        and completed_at is null
        and failed_at is not null
        and cancelled_at is null
        and result_entity_id is null
        and result_snapshot is null
        and result_sha256 is null
        and result_version is null
        and error_code is not null
      )
      or (
        status = 'cancelled'
        and completed_at is null
        and failed_at is null
        and cancelled_at is not null
        and result_entity_id is null
        and result_snapshot is null
        and result_sha256 is null
        and result_version is null
        and error_code is null
      )
    )
    and (
      operation <> 'transcription'
      or status in ('processing', 'cleanup_pending')
      or temp_audio_deleted_at is not null
    )
  ) not valid;

comment on column lumen.processing_attempts.cleanup_protocol is
  'Audio cleanup contract: deterministic_v2 for current writers, legacy_ephemeral_v1 only for the supported N-1 rollback window; null for structuring.';
comment on column lumen.processing_attempts.cleanup_owner is
  'Stable, non-secret LUMEN instance owner used only by deterministic_v2 with the attempt UUID; never a filesystem path.';
comment on column lumen.processing_attempts.cleanup_scope_id is
  'Non-secret per-container or per-pod ephemeral scope captured from a validated N-1 PGAPPNAME; never a filesystem path.';
comment on column lumen.processing_attempts.cleanup_target_status is
  'Terminal status to apply only after temporary audio deletion has independent evidence.';
comment on column lumen.processing_attempts.cleanup_disposition is
  'Technical evidence class for confirmed absence/deletion; never claims deterministic cleanup for a legacy random path.';

create or replace function lumen.guard_processing_attempt_transition()
returns trigger
language plpgsql
as $$
declare
  session_application_name text;
  requested_terminal_status text;
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id
        and encounter.id = old.encounter_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'LUMEN processing attempts can only be deleted with their encounter';
    end if;
    return old;
  end if;

  if not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id and tenant.is_active
  ) then
    raise exception using errcode = '23514', message = 'active LUMEN tenant snapshot is required';
  end if;

  if tg_op = 'INSERT' then
    if new.operation = 'structuring' then
      -- The legacy writer omits cleanup_protocol, so the column default is
      -- rewritten to null for its non-audio operation.
      new.cleanup_protocol := null;
    elsif new.cleanup_protocol = 'legacy_ephemeral_v1' then
      session_application_name := btrim(coalesce(current_setting('application_name', true), ''));
      if session_application_name !~ '^lumen-n1-[A-Za-z0-9][A-Za-z0-9_.-]{7,47}$' then
        raise exception using
          errcode = '23514',
          message = 'legacy LUMEN transcription requires a validated N-1 PGAPPNAME scope';
      end if;
      if new.cleanup_scope_id is not null
        and new.cleanup_scope_id is distinct from session_application_name then
        raise exception using
          errcode = '23514',
          message = 'legacy LUMEN cleanup scope must match the database session identity';
      end if;
      new.cleanup_scope_id := session_application_name;
    end if;

    if new.status <> 'processing'
      or new.result_entity_id is not null
      or new.completed_at is not null
      or new.failed_at is not null
      or new.cancelled_at is not null
      or new.cleanup_target_status is not null
      or new.cleanup_disposition is not null
      or new.temp_audio_deleted_at is not null
      or (
        new.operation = 'transcription'
        and new.cleanup_protocol = 'deterministic_v2'
        and (new.cleanup_owner is null or new.cleanup_scope_id is not null)
      )
      or (
        new.operation = 'transcription'
        and new.cleanup_protocol = 'legacy_ephemeral_v1'
        and (new.cleanup_owner is not null or new.cleanup_scope_id is null)
      )
      or (
        new.operation = 'structuring'
        and (new.cleanup_owner is not null or new.cleanup_scope_id is not null)
      ) then
      raise exception using
        errcode = '23514',
        message = 'LUMEN processing attempts must begin in a valid processing state';
    end if;
    return new;
  end if;

  if old.status not in ('processing', 'cleanup_pending') then
    raise exception using
      errcode = '23514',
      message = 'terminal LUMEN processing attempts are immutable';
  end if;

  if new.tenant_id is distinct from old.tenant_id
    or new.encounter_id is distinct from old.encounter_id
    or new.operation is distinct from old.operation
    or new.idempotency_key is distinct from old.idempotency_key
    or new.input_sha256 is distinct from old.input_sha256
    or new.mime_type is distinct from old.mime_type
    or new.source is distinct from old.source
    or new.duration_seconds is distinct from old.duration_seconds
    or new.cleanup_protocol is distinct from old.cleanup_protocol
    or new.cleanup_owner is distinct from old.cleanup_owner
    or new.cleanup_scope_id is distinct from old.cleanup_scope_id
    or new.started_at is distinct from old.started_at
    or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      message = 'LUMEN processing attempt identity and input metadata are immutable';
  end if;

  -- origin/main writes failed/cancelled directly. When its random-directory
  -- finalizer did not confirm deletion, retain a non-terminal cleanup_pending
  -- row instead of accepting a false terminal state or rolling back the trace.
  if old.status = 'processing'
    and old.operation = 'transcription'
    and old.cleanup_protocol = 'legacy_ephemeral_v1'
    and new.status in ('failed', 'cancelled')
    and new.temp_audio_deleted_at is null then
    requested_terminal_status := new.status;
    new.status := 'cleanup_pending';
    new.cleanup_target_status := requested_terminal_status;
    new.completed_at := null;
    new.failed_at := null;
    new.cancelled_at := null;
    new.error_code := coalesce(
      new.error_code,
      case
        when requested_terminal_status = 'cancelled' then 'legacy_cancelled_cleanup_pending'
        else 'legacy_cleanup_pending'
      end
    );
  end if;

  if new.temp_audio_deleted_at is not null
    and old.temp_audio_deleted_at is null
    and new.cleanup_disposition is null then
    new.cleanup_disposition := case
      when old.cleanup_protocol = 'deterministic_v2' then 'attempt_finalizer'
      else 'legacy_request_finalizer'
    end;
  end if;

  if old.status = 'processing' and new.status = 'processing' then
    raise exception using
      errcode = '23514',
      message = 'LUMEN processing attempt update requires cleanup-pending or terminal transition';
  end if;

  if old.status = 'cleanup_pending' and (
    new.status is distinct from old.cleanup_target_status
    or new.cleanup_target_status is not null
    or new.temp_audio_deleted_at is null
    or new.cleanup_disposition is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN cleanup-pending attempts require independent deletion evidence before their target terminal transition';
  end if;

  if new.status = 'completed' and new.operation = 'transcription' and not exists (
    select 1
    from lumen.dictations dictation
    where dictation.tenant_id = new.tenant_id
      and dictation.encounter_id = new.encounter_id
      and dictation.id = new.result_entity_id
      and dictation.processing_attempt_id = new.id
  ) then
    raise exception using
      errcode = '23514',
      message = 'completed LUMEN transcription requires a dictation from the same attempt and encounter';
  end if;

  if new.status = 'completed' and new.operation = 'structuring' and not exists (
    select 1
    from lumen.clinical_records record
    join lumen.dictations dictation
      on dictation.tenant_id = record.tenant_id
      and dictation.encounter_id = record.encounter_id
      and dictation.id = record.dictation_id
    where record.tenant_id = new.tenant_id
      and record.encounter_id = new.encounter_id
      and record.id = new.result_entity_id
      and record.status = 'draft'
      and date_trunc('milliseconds', record.updated_at) = new.result_version
      and new.result_snapshot->>'id' = record.id::text
      and new.result_snapshot->>'tenantId' = record.tenant_id::text
      and new.result_snapshot->>'encounterId' = record.encounter_id::text
      and new.result_snapshot->>'dictationId' = record.dictation_id::text
      and new.result_snapshot->>'status' = record.status
      and new.result_snapshot->>'schemaVersion' = record.schema_version
      and new.result_snapshot->'content' = record.content
      and (new.result_snapshot->>'provider') is not distinct from record.provider
      and (new.result_snapshot->>'model') is not distinct from record.model
      and (new.result_snapshot->>'updatedAt')::timestamptz = new.result_version
      and dictation.reviewed_at is not null
      and dictation.reviewed_by is not null
  ) then
    raise exception using
      errcode = '23514',
      message = 'completed LUMEN structuring requires an exact versioned draft snapshot from the same tenant and encounter';
  end if;

  return new;
end;
$$;

insert into lumen.service_migrations (version, name)
values (29, '029-lumen-audio-cleanup-recovery.sql')
on conflict (version) do update set name = excluded.name;

insert into lumen.schema_version (service_name, current_version, migration_name)
values ('lumen', 29, '029-lumen-audio-cleanup-recovery.sql')
on conflict (service_name) do update set
  current_version = greatest(lumen.schema_version.current_version, excluded.current_version),
  migration_name = case
    when excluded.current_version >= lumen.schema_version.current_version then excluded.migration_name
    else lumen.schema_version.migration_name
  end,
  updated_at = now();
