-- Trazabilidad durable del pipeline LUMEN. El audio nunca se persiste en
-- PostgreSQL: solo se conservan hashes, metadatos tecnicos y resultados.

create table lumen.processing_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  encounter_id uuid not null,
  operation text not null check (operation in ('transcription', 'structuring')),
  idempotency_key uuid not null,
  input_sha256 text not null
    check (input_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed', 'cancelled')),
  provider text not null check (length(btrim(provider)) between 1 and 120),
  model text not null check (length(btrim(model)) between 1 and 160),
  mime_type text,
  source text,
  duration_seconds integer,
  request_id_hash text
    check (request_id_hash is null or request_id_hash ~ '^[0-9a-f]{64}$'),
  trace_id_hash text
    check (trace_id_hash is null or trace_id_hash ~ '^[0-9a-f]{64}$'),
  error_code text
    check (error_code is null or error_code ~ '^[a-z0-9_.-]{1,80}$'),
  result_entity_id uuid,
  result_snapshot jsonb,
  result_sha256 text
    check (result_sha256 is null or result_sha256 ~ '^[0-9a-f]{64}$'),
  result_version timestamptz,
  temp_audio_deleted_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_lumen_processing_attempt_encounter_tenant
    foreign key (tenant_id, encounter_id)
      references lumen.encounters(tenant_id, id) on delete cascade,
  constraint uq_lumen_processing_attempt_identity
    unique (tenant_id, encounter_id, id),
  constraint uq_lumen_processing_attempt_idempotency
    unique (tenant_id, encounter_id, operation, idempotency_key),
  constraint ck_lumen_processing_attempt_audio_metadata check (
    (
      operation = 'transcription'
      and mime_type in (
        'audio/aac',
        'audio/mpeg',
        'audio/mp4',
        'audio/ogg',
        'audio/ogg;codecs=opus',
        'audio/wav',
        'audio/webm',
        'audio/webm;codecs=opus',
        'audio/x-m4a',
        'audio/x-wav'
      )
      and source in ('browser_microphone', 'authorized_upload')
      and duration_seconds between 1 and 90
    )
    or (
      operation = 'structuring'
      and mime_type is null
      and source is null
      and duration_seconds is null
      and temp_audio_deleted_at is null
    )
  ),
  constraint ck_lumen_processing_attempt_lifecycle check (
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
      )
    )
    and (operation <> 'transcription' or status = 'processing' or temp_audio_deleted_at is not null)
  ),
  constraint ck_lumen_processing_attempt_result_snapshot check (
    (
      operation = 'transcription'
      and result_snapshot is null
      and result_sha256 is null
      and result_version is null
    )
    or (
      operation = 'structuring'
      and (
        (
          status = 'completed'
          and jsonb_typeof(result_snapshot) = 'object'
          and result_sha256 is not null
          and result_version is not null
        )
        or (
          status <> 'completed'
          and result_snapshot is null
          and result_sha256 is null
          and result_version is null
        )
      )
    )
  ),
  constraint ck_lumen_processing_attempt_timestamp_order check (
    updated_at >= created_at
    and started_at >= created_at
    and (completed_at is null or completed_at >= started_at)
    and (failed_at is null or failed_at >= started_at)
    and (cancelled_at is null or cancelled_at >= started_at)
    and (temp_audio_deleted_at is null or temp_audio_deleted_at >= started_at)
    and (result_version is null or result_version >= date_trunc('milliseconds', started_at))
  )
);

comment on table lumen.processing_attempts is
  'Tenant-scoped, idempotent technical trace for LUMEN transcription and structuring; never stores audio.';
comment on column lumen.processing_attempts.input_sha256 is
  'SHA-256 of authorized audio bytes, or of dictationId-or-null + separator + reviewed transcript for structuring.';
comment on column lumen.processing_attempts.result_entity_id is
  'Polymorphic UUID: dictation for transcription, clinical record for structuring.';
comment on column lumen.processing_attempts.result_snapshot is
  'Immutable, tenant-scoped snapshot of the exact structured draft returned by this attempt; never contains audio or secrets.';
comment on column lumen.processing_attempts.result_sha256 is
  'Application-canonical SHA-256 of result_snapshot, verified before idempotent replay.';
comment on column lumen.processing_attempts.result_version is
  'clinical_records.updated_at version captured atomically with a structuring result snapshot.';
comment on column lumen.processing_attempts.request_id_hash is
  'SHA-256 of a provider request identifier when one is returned; never the raw identifier.';
comment on column lumen.processing_attempts.trace_id_hash is
  'SHA-256 of a provider trace identifier when one is returned; never the raw identifier.';

create index idx_lumen_processing_attempts_status
  on lumen.processing_attempts(tenant_id, status, created_at desc);

create index idx_lumen_processing_attempts_encounter
  on lumen.processing_attempts(tenant_id, encounter_id, operation, created_at desc);

alter table lumen.dictations
  add column provider_transcript text,
  add column reviewed_at timestamptz,
  add column reviewed_by uuid,
  add column processing_attempt_id uuid;

-- Preserve the original provider output for any provider-backed rows that
-- predate this migration. Synthetic/manual rows deliberately remain null.
update lumen.dictations
set provider_transcript = transcript
where provider is not null
  and provider <> 'manual'
  and btrim(transcript) <> '';

alter table lumen.dictations
  add constraint fk_lumen_dictation_reviewer
    foreign key (reviewed_by) references platform.operators(id) on delete restrict,
  add constraint fk_lumen_dictation_processing_attempt
    foreign key (tenant_id, encounter_id, processing_attempt_id)
      references lumen.processing_attempts(tenant_id, encounter_id, id) on delete cascade,
  add constraint ck_lumen_dictation_provider_transcript check (
    provider_transcript is null
    or (btrim(provider_transcript) <> '' and length(provider_transcript) <= 20000)
  ),
  add constraint ck_lumen_dictation_review_fields check (
    (reviewed_at is null and reviewed_by is null)
    or (
      reviewed_at is not null
      and reviewed_by is not null
      and reviewed_at >= created_at
      and btrim(transcript) <> ''
    )
  );

create index idx_lumen_dictations_processing_attempt
  on lumen.dictations(tenant_id, encounter_id, processing_attempt_id)
  where processing_attempt_id is not null;

create or replace function lumen.guard_dictation_real_audio_lineage()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
    and new.provider_transcript is distinct from old.provider_transcript then
    raise exception using
      errcode = '23514',
      message = 'LUMEN provider transcript is immutable after dictation creation';
  end if;

  if tg_op = 'UPDATE'
    and old.processing_attempt_id is not null
    and new.processing_attempt_id is distinct from old.processing_attempt_id then
    raise exception using
      errcode = '23514',
      message = 'LUMEN dictation processing lineage is immutable once assigned';
  end if;

  if tg_op = 'INSERT'
    and new.status = 'transcribed'
    and coalesce(new.metadata->>'source', '') in ('browser_microphone', 'authorized_upload')
    and (new.provider_transcript is null or new.processing_attempt_id is null) then
    raise exception using
      errcode = '23514',
      message = 'real LUMEN audio dictations require immutable provider output and processing lineage';
  end if;

  if new.processing_attempt_id is not null and not exists (
    select 1
    from lumen.processing_attempts attempt
    where attempt.tenant_id = new.tenant_id
      and attempt.encounter_id = new.encounter_id
      and attempt.id = new.processing_attempt_id
      and attempt.operation = 'transcription'
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN dictation requires a transcription attempt from the same tenant and encounter';
  end if;

  if new.reviewed_by is not null and not exists (
    select 1
    from platform.operators operator
    where operator.id = new.reviewed_by
      and operator.status = 'active'
      and (
        operator.role = 'admin'
        or (
          operator.role in ('coordinator', 'advisor')
          and exists (
            select 1
            from platform.operator_tenants membership
            where membership.operator_id = operator.id
              and membership.tenant_id = new.tenant_id
          )
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN transcript reviewer is not authorized for tenant';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_dictation_real_audio_lineage on lumen.dictations;
create trigger trg_guard_dictation_real_audio_lineage
before insert or update of tenant_id, encounter_id, processing_attempt_id, provider_transcript, transcript, reviewed_at, reviewed_by
on lumen.dictations
for each row execute function lumen.guard_dictation_real_audio_lineage();

create or replace function lumen.guard_processing_attempt_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    -- Direct deletion would erase technical evidence. Cascades remain possible
    -- only after the owning synthetic encounter has itself been removed.
    if exists (
      select 1
      from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id
        and encounter.id = old.encounter_id
    ) and exists (
      select 1 from platform.tenants tenant where tenant.id = old.tenant_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'LUMEN processing attempts can only be deleted with their encounter';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'processing'
      or new.result_entity_id is not null
      or new.completed_at is not null
      or new.failed_at is not null
      or new.cancelled_at is not null then
      raise exception using
        errcode = '23514',
        message = 'LUMEN processing attempts must begin in processing state';
    end if;
    return new;
  end if;

  if old.status <> 'processing' then
    raise exception using
      errcode = '23514',
      message = 'terminal LUMEN processing attempts are immutable';
  end if;

  if new.status = 'processing' then
    raise exception using
      errcode = '23514',
      message = 'LUMEN processing attempt update requires one terminal transition';
  end if;

  if new.tenant_id is distinct from old.tenant_id
    or new.encounter_id is distinct from old.encounter_id
    or new.operation is distinct from old.operation
    or new.idempotency_key is distinct from old.idempotency_key
    or new.input_sha256 is distinct from old.input_sha256
    or new.mime_type is distinct from old.mime_type
    or new.source is distinct from old.source
    or new.duration_seconds is distinct from old.duration_seconds
    or new.started_at is distinct from old.started_at
    or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      message = 'LUMEN processing attempt identity and input metadata are immutable';
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

drop trigger if exists trg_guard_processing_attempt_transition on lumen.processing_attempts;
create trigger trg_guard_processing_attempt_transition
before insert or update or delete on lumen.processing_attempts
for each row execute function lumen.guard_processing_attempt_transition();
