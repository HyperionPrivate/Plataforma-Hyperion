-- Provider-owned LUMEN autonomous baseline.
--
-- Provenance: extracted from the effective lumen schema after legacy migrations
-- 018-lumen-clinical-demo.sql, 019-lumen-clinical-invariants.sql,
-- 020-lumen-real-audio-pipeline.sql, 022-lumen-autonomy.sql,
-- 026-audit-source-provenance.sql,
-- 029-lumen-audio-cleanup-recovery.sql, 032-lumen-audio-cleanup-contract.sql,
-- 033-lumen-audio-cleanup-index.sql and
-- 039-lumen-unresolved-cleanup-owner-index.sql.
-- Cross-owner bootstrap reads, FKs and triggers had already been removed by 022;
-- this baseline contains only final objects in the lumen schema.

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: lumen; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS lumen;


--
-- Name: finalize_clinical_record_approval(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.finalize_clinical_record_approval() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status = 'draft' and new.status = 'approved' then
    update lumen.encounter_reference_snapshots
    set frozen_at = coalesce(frozen_at, new.approved_at, now()), updated_at = now()
    where tenant_id = new.tenant_id and encounter_id = new.encounter_id;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN approval requires a reference snapshot';
    end if;

    update lumen.encounters
    set status = 'approved', updated_at = now()
    where tenant_id = new.tenant_id and id = new.encounter_id;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN approval encounter is missing';
    end if;

    insert into lumen.outbox_events (
      tenant_id, event_type, event_version, aggregate_type, aggregate_id,
      dedupe_key, payload, occurred_at
    )
    values (
      new.tenant_id,
      'lumen.audit.event.record.v1',
      1,
      'lumen_clinical_record',
      new.id,
      'clinical-record:' || new.id::text || ':draft-approved',
      jsonb_build_object(
        'tenantId', new.tenant_id::text,
        'actorId', new.approved_by::text,
        'eventType', 'lumen.record.approved',
        'entityType', 'lumen_clinical_record',
        'entityId', new.id::text,
        'metadata', jsonb_build_object(
          'source', 'lumen-service',
          'encounterId', new.encounter_id::text,
          'schemaVersion', new.schema_version
        )
      ),
      coalesce(new.approved_at, now())
    )
    on conflict (tenant_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;


--
-- Name: guard_approved_dictation(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.guard_approved_dictation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  locked_encounter record;
begin
  if tg_op = 'UPDATE' then
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where (encounter.tenant_id = old.tenant_id and encounter.id = old.encounter_id)
         or (encounter.tenant_id = new.tenant_id and encounter.id = new.encounter_id)
      order by encounter.tenant_id, encounter.id
      for update
    loop
      if locked_encounter.status = 'approved' then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  elsif tg_op = 'INSERT' then
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where encounter.tenant_id = new.tenant_id and encounter.id = new.encounter_id
      for update
    loop
      if locked_encounter.status = 'approved' then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  else
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id and encounter.id = old.encounter_id
      for update
    loop
      if locked_encounter.status = 'approved' then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;


--
-- Name: guard_clinical_record(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.guard_clinical_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op <> 'DELETE' and not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id and tenant.is_active
  ) then
    raise exception using errcode = '23514', message = 'active LUMEN tenant snapshot is required';
  end if;

  if tg_op <> 'DELETE' and not exists (
    select 1
    from lumen.dictations dictation
    where dictation.tenant_id = new.tenant_id
      and dictation.encounter_id = new.encounter_id
      and dictation.id = new.dictation_id
      and dictation.status = 'transcribed'
      and btrim(dictation.transcript) <> ''
  ) then
    raise exception using errcode = '23514', message = 'LUMEN record requires a completed dictation from the same encounter';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'approved' or new.approved_by is not null or new.approved_at is not null then
      raise exception using errcode = '23514', message = 'LUMEN records must be approved by transition';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'approved' then
      raise exception using errcode = '23514', message = 'approved LUMEN records are immutable';
    end if;
    return old;
  end if;

  if old.status = 'approved' then
    raise exception using errcode = '23514', message = 'approved LUMEN records are immutable';
  end if;

  if new.status = 'approved' then
    if old.status <> 'draft' then
      raise exception using errcode = '23514', message = 'invalid LUMEN approval transition';
    end if;

    perform 1
    from lumen.encounters encounter
    where encounter.tenant_id = new.tenant_id
      and encounter.id = new.encounter_id
      and encounter.status = 'review'
    for update;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN encounter is not ready for approval';
    end if;

    if not exists (
      select 1 from lumen.operator_grants grant_snapshot
      where grant_snapshot.operator_id = new.approved_by
        and grant_snapshot.tenant_id = new.tenant_id
        and grant_snapshot.is_active
        and grant_snapshot.can_review
    ) then
      raise exception using errcode = '23514', message = 'LUMEN approver grant is missing or inactive';
    end if;
  end if;

  return new;
end;
$$;


--
-- Name: guard_dictation_real_audio_lineage(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.guard_dictation_real_audio_lineage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id and tenant.is_active
  ) then
    raise exception using errcode = '23514', message = 'active LUMEN tenant snapshot is required';
  end if;

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
    select 1 from lumen.operator_grants grant_snapshot
    where grant_snapshot.operator_id = new.reviewed_by
      and grant_snapshot.tenant_id = new.tenant_id
      and grant_snapshot.is_active
      and grant_snapshot.can_review
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN transcript reviewer grant is missing or inactive';
  end if;

  return new;
end;
$$;


--
-- Name: guard_encounter_reference_snapshot(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.guard_encounter_reference_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1 from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id and encounter.id = old.encounter_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'referenced LUMEN encounter snapshots cannot be deleted';
    end if;
    return old;
  end if;

  if not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id
  ) then
    raise exception using errcode = '23514', message = 'LUMEN tenant snapshot is required';
  end if;

  if not new.patient_is_demo or not new.professional_is_demo then
    raise exception using errcode = '23514', message = 'LUMEN references must remain synthetic';
  end if;

  if tg_op = 'UPDATE' then
    if old.tenant_id is distinct from new.tenant_id
      or old.encounter_id is distinct from new.encounter_id then
      raise exception using errcode = '23514', message = 'LUMEN snapshot identity is immutable';
    end if;

    if old.frozen_at is not null or exists (
      select 1 from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id
        and encounter.id = old.encounter_id
        and encounter.status = 'approved'
    ) then
      raise exception using errcode = '23514', message = 'approved LUMEN reference snapshots are immutable';
    end if;

    if new.source_version < old.source_version then
      raise exception using errcode = '23514', message = 'stale LUMEN reference snapshot version';
    end if;

    if new.frozen_at is not null and old.frozen_at is null and not exists (
      select 1 from lumen.clinical_records record
      where record.tenant_id = new.tenant_id
        and record.encounter_id = new.encounter_id
        and record.status = 'approved'
    ) then
      raise exception using errcode = '23514', message = 'LUMEN snapshots freeze only during record approval';
    end if;
  elsif new.frozen_at is not null and not exists (
    select 1 from lumen.encounters encounter
    where encounter.tenant_id = new.tenant_id
      and encounter.id = new.encounter_id
      and encounter.status = 'approved'
  ) then
    raise exception using errcode = '23514', message = 'new LUMEN snapshots cannot start frozen';
  end if;

  return new;
end;
$$;


--
-- Name: guard_processing_attempt_transition(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.guard_processing_attempt_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;


--
-- Name: guard_synthetic_encounter(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.guard_synthetic_encounter() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' then
      raise exception using errcode = '23514', message = 'approved LUMEN encounters are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    raise exception using errcode = '23514', message = 'approved LUMEN encounters are immutable';
  end if;

  if not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id and tenant.is_active
  ) then
    raise exception using errcode = '23514', message = 'active LUMEN tenant snapshot is required';
  end if;

  if new.status = 'approved' and (
    tg_op = 'INSERT'
    or not exists (
      select 1 from lumen.clinical_records record
      where record.tenant_id = new.tenant_id
        and record.encounter_id = new.id
        and record.status = 'approved'
    )
  ) then
    raise exception using errcode = '23514', message = 'LUMEN encounter approval requires an approved record';
  end if;

  if not new.is_demo
    or new.demo_key is null
    or coalesce(new.metadata->>'synthetic', 'false') <> 'true' then
    raise exception using errcode = '23514', message = 'LUMEN encounters must be explicitly synthetic';
  end if;

  if not exists (
    select 1
    from lumen.encounter_reference_snapshots reference
    where reference.tenant_id = new.tenant_id
      and reference.encounter_id = new.id
      and reference.patient_id = new.patient_id
      and reference.professional_id = new.professional_id
      and reference.site_id = new.site_id
      and reference.patient_is_demo
      and reference.professional_is_demo
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN encounter requires a matching synthetic reference snapshot';
  end if;

  return new;
end;
$$;


--
-- Name: require_attested_legacy_cleanup_terminal(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.require_attested_legacy_cleanup_terminal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'lumen'
    AS $$
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


--
-- Name: require_open_n1_compatibility_window(); Type: FUNCTION; Schema: lumen; Owner: -
--

CREATE FUNCTION lumen.require_open_n1_compatibility_window() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'lumen'
    AS $$
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audio_cleanup_owner_leases; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.audio_cleanup_owner_leases (
    cleanup_owner text NOT NULL,
    holder_id uuid NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_lumen_audio_cleanup_lease_owner CHECK ((cleanup_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'::text)),
    CONSTRAINT ck_lumen_audio_cleanup_lease_window CHECK (((acquired_at <= heartbeat_at) AND (heartbeat_at < expires_at)))
);


--
-- Name: TABLE audio_cleanup_owner_leases; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON TABLE lumen.audio_cleanup_owner_leases IS 'Exclusive renewable leases that fence temporary-audio recovery by stable cleanup owner.';


--
-- Name: COLUMN audio_cleanup_owner_leases.holder_id; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.audio_cleanup_owner_leases.holder_id IS 'Random per-process fencing identity; never a credential or filesystem path.';


--
-- Name: clinical_records; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.clinical_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    encounter_id uuid NOT NULL,
    dictation_id uuid NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    schema_version text DEFAULT 'ophthalmology-demo-v1'::text NOT NULL,
    content jsonb NOT NULL,
    provider text,
    model text,
    approved_by uuid,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_lumen_record_approval_fields CHECK ((((status = 'draft'::text) AND (approved_by IS NULL) AND (approved_at IS NULL)) OR ((status = 'approved'::text) AND (approved_by IS NOT NULL) AND (approved_at IS NOT NULL)))),
    CONSTRAINT ck_lumen_record_approval_ready CHECK (((status <> 'approved'::text) OR ((jsonb_typeof((content -> 'uncertainties'::text)) = 'array'::text) AND (jsonb_array_length(
CASE
    WHEN (jsonb_typeof((content -> 'uncertainties'::text)) = 'array'::text) THEN (content -> 'uncertainties'::text)
    ELSE '[null]'::jsonb
END) = 0) AND ((btrim(COALESCE((content ->> 'reasonForVisit'::text), ''::text)) <> ''::text) OR (btrim(COALESCE((content ->> 'history'::text), ''::text)) <> ''::text))))),
    CONSTRAINT clinical_records_check CHECK (((status = 'approved'::text) = ((approved_at IS NOT NULL) AND (approved_by IS NOT NULL)))),
    CONSTRAINT clinical_records_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text])))
);


--
-- Name: dictations; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.dictations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    encounter_id uuid NOT NULL,
    status text NOT NULL,
    transcript text DEFAULT ''::text NOT NULL,
    mime_type text NOT NULL,
    provider text,
    model text,
    duration_seconds integer,
    error_code text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_transcript text,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    processing_attempt_id uuid,
    CONSTRAINT ck_lumen_dictation_provider_transcript CHECK (((provider_transcript IS NULL) OR ((btrim(provider_transcript) <> ''::text) AND (length(provider_transcript) <= 20000)))),
    CONSTRAINT ck_lumen_dictation_review_fields CHECK ((((reviewed_at IS NULL) AND (reviewed_by IS NULL)) OR ((reviewed_at IS NOT NULL) AND (reviewed_by IS NOT NULL) AND (reviewed_at >= created_at) AND (btrim(transcript) <> ''::text)))),
    CONSTRAINT dictations_duration_seconds_check CHECK (((duration_seconds >= 1) AND (duration_seconds <= 90))),
    CONSTRAINT dictations_status_check CHECK ((status = ANY (ARRAY['transcribed'::text, 'failed'::text])))
);


--
-- Name: encounter_reference_snapshots; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.encounter_reference_snapshots (
    tenant_id uuid NOT NULL,
    encounter_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    site_id uuid NOT NULL,
    professional_id uuid NOT NULL,
    patient_display_name text NOT NULL,
    patient_age integer,
    payer text,
    document_masked text,
    professional_name text NOT NULL,
    subspecialty text,
    site_name text NOT NULL,
    patient_is_demo boolean NOT NULL,
    professional_is_demo boolean NOT NULL,
    source_event_id uuid,
    source_version bigint NOT NULL,
    source_updated_at timestamp with time zone NOT NULL,
    payload_hash text NOT NULL,
    frozen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT encounter_reference_snapshots_check CHECK ((patient_is_demo AND professional_is_demo)),
    CONSTRAINT encounter_reference_snapshots_document_masked_check CHECK (((document_masked IS NULL) OR ((length(btrim(document_masked)) >= 1) AND (length(btrim(document_masked)) <= 80)))),
    CONSTRAINT encounter_reference_snapshots_patient_age_check CHECK (((patient_age >= 0) AND (patient_age <= 130))),
    CONSTRAINT encounter_reference_snapshots_patient_display_name_check CHECK (((length(btrim(patient_display_name)) >= 1) AND (length(btrim(patient_display_name)) <= 240))),
    CONSTRAINT encounter_reference_snapshots_payer_check CHECK (((payer IS NULL) OR ((length(btrim(payer)) >= 1) AND (length(btrim(payer)) <= 240)))),
    CONSTRAINT encounter_reference_snapshots_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT encounter_reference_snapshots_professional_name_check CHECK (((length(btrim(professional_name)) >= 1) AND (length(btrim(professional_name)) <= 240))),
    CONSTRAINT encounter_reference_snapshots_site_name_check CHECK (((length(btrim(site_name)) >= 1) AND (length(btrim(site_name)) <= 240))),
    CONSTRAINT encounter_reference_snapshots_source_version_check CHECK ((source_version > 0)),
    CONSTRAINT encounter_reference_snapshots_subspecialty_check CHECK (((subspecialty IS NULL) OR ((length(btrim(subspecialty)) >= 1) AND (length(btrim(subspecialty)) <= 240))))
);


--
-- Name: encounters; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.encounters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    professional_id uuid NOT NULL,
    site_id uuid NOT NULL,
    status text DEFAULT 'preconsultation'::text NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    demo_key text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_lumen_encounter_synthetic_only CHECK ((is_demo AND (demo_key IS NOT NULL) AND (COALESCE((metadata ->> 'synthetic'::text), 'false'::text) = 'true'::text))),
    CONSTRAINT encounters_status_check CHECK ((status = ANY (ARRAY['preconsultation'::text, 'in_progress'::text, 'review'::text, 'approved'::text])))
);


--
-- Name: inbox_events; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.inbox_events (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    source_service text NOT NULL,
    event_type text NOT NULL,
    event_version integer NOT NULL,
    payload_hash text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    processed_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inbox_events_event_type_check CHECK (((length(btrim(event_type)) >= 3) AND (length(btrim(event_type)) <= 160))),
    CONSTRAINT inbox_events_event_version_check CHECK (((event_version >= 1) AND (event_version <= 1000))),
    CONSTRAINT inbox_events_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT inbox_events_result_check CHECK ((jsonb_typeof(result) = 'object'::text)),
    CONSTRAINT inbox_events_source_service_check CHECK (((length(btrim(source_service)) >= 1) AND (length(btrim(source_service)) <= 80)))
);


--
-- Name: legacy_audio_scope_attestations; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.legacy_audio_scope_attestations (
    attestation_id uuid NOT NULL,
    cleanup_scope_id text NOT NULL,
    destroyed_at timestamp with time zone NOT NULL,
    evidence_sha256 text NOT NULL,
    finalized_attempt_count integer DEFAULT 0 NOT NULL,
    attested_at timestamp with time zone DEFAULT now() NOT NULL,
    attested_by text DEFAULT SESSION_USER NOT NULL,
    CONSTRAINT ck_lumen_legacy_scope_attestation_count CHECK ((finalized_attempt_count >= 0)),
    CONSTRAINT ck_lumen_legacy_scope_attestation_evidence CHECK ((evidence_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT ck_lumen_legacy_scope_attestation_time CHECK ((destroyed_at <= attested_at))
);


--
-- Name: TABLE legacy_audio_scope_attestations; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON TABLE lumen.legacy_audio_scope_attestations IS 'Admin-only cryptographic evidence that an N-1 ephemeral scope was destroyed before its legacy attempts were finalized.';


--
-- Name: COLUMN legacy_audio_scope_attestations.evidence_sha256; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.legacy_audio_scope_attestations.evidence_sha256 IS 'SHA-256 of external orchestrator evidence; raw logs, paths and credentials are never stored here.';


--
-- Name: n_minus_one_compatibility_windows; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.n_minus_one_compatibility_windows (
    cleanup_scope_id text NOT NULL,
    rollback_evidence_sha256 text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_by text DEFAULT SESSION_USER NOT NULL,
    closed_at timestamp with time zone,
    closed_by text,
    close_reason text,
    CONSTRAINT ck_lumen_n1_window_close CHECK ((((closed_at IS NULL) AND (closed_by IS NULL) AND (close_reason IS NULL)) OR ((closed_at IS NOT NULL) AND (closed_at >= opened_at) AND ((length(btrim(closed_by)) >= 1) AND (length(btrim(closed_by)) <= 120)) AND (close_reason = ANY (ARRAY['operator_closed'::text, 'bootstrap_reconciled'::text]))))),
    CONSTRAINT ck_lumen_n1_window_evidence CHECK ((rollback_evidence_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT ck_lumen_n1_window_scope CHECK ((cleanup_scope_id ~ '^lumen-n1-[A-Za-z0-9][A-Za-z0-9_.-]{7,47}$'::text))
);


--
-- Name: TABLE n_minus_one_compatibility_windows; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON TABLE lumen.n_minus_one_compatibility_windows IS 'Admin-only audit of temporary, least-privilege database grants used by one exact N-1 LUMEN rollback scope.';


--
-- Name: operator_grants; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.operator_grants (
    operator_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    role text NOT NULL,
    is_active boolean NOT NULL,
    can_review boolean NOT NULL,
    source_event_id uuid,
    source_version bigint NOT NULL,
    source_updated_at timestamp with time zone NOT NULL,
    payload_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_grants_check CHECK (((NOT can_review) OR is_active)),
    CONSTRAINT operator_grants_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT operator_grants_role_check CHECK (((length(btrim(role)) >= 1) AND (length(btrim(role)) <= 80))),
    CONSTRAINT operator_grants_source_version_check CHECK ((source_version > 0))
);


--
-- Name: outbox_events; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    event_type text NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    dedupe_key text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 12 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error_code text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_events_aggregate_type_check CHECK (((length(btrim(aggregate_type)) >= 1) AND (length(btrim(aggregate_type)) <= 80))),
    CONSTRAINT outbox_events_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT outbox_events_dedupe_key_check CHECK (((length(btrim(dedupe_key)) >= 3) AND (length(btrim(dedupe_key)) <= 240))),
    CONSTRAINT outbox_events_event_type_check CHECK (((length(btrim(event_type)) >= 3) AND (length(btrim(event_type)) <= 160))),
    CONSTRAINT outbox_events_event_version_check CHECK (((event_version >= 1) AND (event_version <= 1000))),
    CONSTRAINT outbox_events_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 100))),
    CONSTRAINT outbox_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT outbox_events_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text, 'published'::text, 'dead_letter'::text])))
);


--
-- Name: preconsultation_summaries; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.preconsultation_summaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    encounter_id uuid NOT NULL,
    content jsonb NOT NULL,
    source_count integer DEFAULT 0 NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT preconsultation_summaries_source_count_check CHECK ((source_count >= 0))
);


--
-- Name: processing_attempts; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.processing_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    encounter_id uuid NOT NULL,
    operation text NOT NULL,
    idempotency_key uuid NOT NULL,
    input_sha256 text NOT NULL,
    status text DEFAULT 'processing'::text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    mime_type text,
    source text,
    duration_seconds integer,
    request_id_hash text,
    trace_id_hash text,
    error_code text,
    result_entity_id uuid,
    result_snapshot jsonb,
    result_sha256 text,
    result_version timestamp with time zone,
    temp_audio_deleted_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cleanup_protocol text DEFAULT 'legacy_ephemeral_v1'::text,
    cleanup_owner text,
    cleanup_scope_id text,
    cleanup_target_status text,
    cleanup_disposition text,
    CONSTRAINT ck_lumen_processing_attempt_audio_metadata CHECK ((((operation = 'transcription'::text) AND (mime_type = ANY (ARRAY['audio/aac'::text, 'audio/mpeg'::text, 'audio/mp4'::text, 'audio/ogg'::text, 'audio/ogg;codecs=opus'::text, 'audio/wav'::text, 'audio/webm'::text, 'audio/webm;codecs=opus'::text, 'audio/x-m4a'::text, 'audio/x-wav'::text])) AND (source = ANY (ARRAY['browser_microphone'::text, 'authorized_upload'::text])) AND ((duration_seconds >= 1) AND (duration_seconds <= 90))) OR ((operation = 'structuring'::text) AND (mime_type IS NULL) AND (source IS NULL) AND (duration_seconds IS NULL) AND (temp_audio_deleted_at IS NULL)))),
    CONSTRAINT ck_lumen_processing_attempt_cleanup_evidence CHECK ((((temp_audio_deleted_at IS NULL) AND (cleanup_disposition IS NULL)) OR ((temp_audio_deleted_at IS NOT NULL) AND (cleanup_disposition IS NOT NULL)))),
    CONSTRAINT ck_lumen_processing_attempt_cleanup_identity CHECK ((((operation = 'structuring'::text) AND (cleanup_protocol IS NULL) AND (cleanup_owner IS NULL) AND (cleanup_scope_id IS NULL) AND (cleanup_disposition IS NULL)) OR ((operation = 'transcription'::text) AND (cleanup_protocol = 'deterministic_v2'::text) AND (cleanup_owner IS NOT NULL) AND (cleanup_scope_id IS NULL) AND ((cleanup_disposition IS NULL) OR (cleanup_disposition = ANY (ARRAY['attempt_finalizer'::text, 'deterministic_reconciler'::text])))) OR ((operation = 'transcription'::text) AND (cleanup_protocol = 'legacy_ephemeral_v1'::text) AND (cleanup_owner IS NULL) AND ((status <> ALL (ARRAY['processing'::text, 'cleanup_pending'::text])) OR (cleanup_scope_id IS NOT NULL)) AND ((cleanup_disposition IS NULL) OR (cleanup_disposition = ANY (ARRAY['legacy_request_finalizer'::text, 'legacy_terminal_contract'::text, 'ephemeral_scope_destroyed'::text])))))),
    CONSTRAINT ck_lumen_processing_attempt_cleanup_protocol CHECK ((((operation = 'structuring'::text) AND (cleanup_protocol IS NULL)) OR ((operation = 'transcription'::text) AND (cleanup_protocol = ANY (ARRAY['legacy_ephemeral_v1'::text, 'deterministic_v2'::text]))))),
    CONSTRAINT ck_lumen_processing_attempt_cleanup_state CHECK ((((cleanup_owner IS NULL) OR (cleanup_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'::text)) AND ((cleanup_scope_id IS NULL) OR (cleanup_scope_id ~ '^lumen-n1-[A-Za-z0-9][A-Za-z0-9_.-]{7,47}$'::text)))),
    CONSTRAINT ck_lumen_processing_attempt_cleanup_target CHECK ((((status = 'cleanup_pending'::text) AND (operation = 'transcription'::text) AND (cleanup_target_status = ANY (ARRAY['failed'::text, 'cancelled'::text]))) OR ((status <> 'cleanup_pending'::text) AND (cleanup_target_status IS NULL)))),
    CONSTRAINT ck_lumen_processing_attempt_lifecycle CHECK (((((status = 'processing'::text) AND (completed_at IS NULL) AND (failed_at IS NULL) AND (cancelled_at IS NULL) AND (result_entity_id IS NULL) AND (result_snapshot IS NULL) AND (result_sha256 IS NULL) AND (result_version IS NULL) AND (error_code IS NULL) AND (temp_audio_deleted_at IS NULL)) OR ((status = 'cleanup_pending'::text) AND (completed_at IS NULL) AND (failed_at IS NULL) AND (cancelled_at IS NULL) AND (result_entity_id IS NULL) AND (result_snapshot IS NULL) AND (result_sha256 IS NULL) AND (result_version IS NULL) AND (error_code IS NOT NULL) AND (temp_audio_deleted_at IS NULL)) OR ((status = 'completed'::text) AND (completed_at IS NOT NULL) AND (failed_at IS NULL) AND (cancelled_at IS NULL) AND (result_entity_id IS NOT NULL) AND (error_code IS NULL)) OR ((status = 'failed'::text) AND (completed_at IS NULL) AND (failed_at IS NOT NULL) AND (cancelled_at IS NULL) AND (result_entity_id IS NULL) AND (result_snapshot IS NULL) AND (result_sha256 IS NULL) AND (result_version IS NULL) AND (error_code IS NOT NULL)) OR ((status = 'cancelled'::text) AND (completed_at IS NULL) AND (failed_at IS NULL) AND (cancelled_at IS NOT NULL) AND (result_entity_id IS NULL) AND (result_snapshot IS NULL) AND (result_sha256 IS NULL) AND (result_version IS NULL) AND (error_code IS NULL))) AND ((operation <> 'transcription'::text) OR (status = ANY (ARRAY['processing'::text, 'cleanup_pending'::text])) OR (temp_audio_deleted_at IS NOT NULL)))),
    CONSTRAINT ck_lumen_processing_attempt_result_snapshot CHECK ((((operation = 'transcription'::text) AND (result_snapshot IS NULL) AND (result_sha256 IS NULL) AND (result_version IS NULL)) OR ((operation = 'structuring'::text) AND (((status = 'completed'::text) AND (jsonb_typeof(result_snapshot) = 'object'::text) AND (result_sha256 IS NOT NULL) AND (result_version IS NOT NULL)) OR ((status <> 'completed'::text) AND (result_snapshot IS NULL) AND (result_sha256 IS NULL) AND (result_version IS NULL)))))),
    CONSTRAINT ck_lumen_processing_attempt_status CHECK ((status = ANY (ARRAY['processing'::text, 'cleanup_pending'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT ck_lumen_processing_attempt_timestamp_order CHECK (((updated_at >= created_at) AND (started_at >= created_at) AND ((completed_at IS NULL) OR (completed_at >= started_at)) AND ((failed_at IS NULL) OR (failed_at >= started_at)) AND ((cancelled_at IS NULL) OR (cancelled_at >= started_at)) AND ((temp_audio_deleted_at IS NULL) OR (temp_audio_deleted_at >= started_at)) AND ((result_version IS NULL) OR (result_version >= date_trunc('milliseconds'::text, started_at))))),
    CONSTRAINT processing_attempts_error_code_check CHECK (((error_code IS NULL) OR (error_code ~ '^[a-z0-9_.-]{1,80}$'::text))),
    CONSTRAINT processing_attempts_input_sha256_check CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT processing_attempts_model_check CHECK (((length(btrim(model)) >= 1) AND (length(btrim(model)) <= 160))),
    CONSTRAINT processing_attempts_operation_check CHECK ((operation = ANY (ARRAY['transcription'::text, 'structuring'::text]))),
    CONSTRAINT processing_attempts_provider_check CHECK (((length(btrim(provider)) >= 1) AND (length(btrim(provider)) <= 120))),
    CONSTRAINT processing_attempts_request_id_hash_check CHECK (((request_id_hash IS NULL) OR (request_id_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT processing_attempts_result_sha256_check CHECK (((result_sha256 IS NULL) OR (result_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT processing_attempts_trace_id_hash_check CHECK (((trace_id_hash IS NULL) OR (trace_id_hash ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: TABLE processing_attempts; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON TABLE lumen.processing_attempts IS 'Tenant-scoped, idempotent technical trace for LUMEN transcription and structuring; never stores audio.';


--
-- Name: COLUMN processing_attempts.input_sha256; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.input_sha256 IS 'SHA-256 of authorized audio bytes, or of dictationId-or-null + separator + reviewed transcript for structuring.';


--
-- Name: COLUMN processing_attempts.request_id_hash; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.request_id_hash IS 'SHA-256 of a provider request identifier when one is returned; never the raw identifier.';


--
-- Name: COLUMN processing_attempts.trace_id_hash; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.trace_id_hash IS 'SHA-256 of a provider trace identifier when one is returned; never the raw identifier.';


--
-- Name: COLUMN processing_attempts.result_entity_id; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.result_entity_id IS 'Polymorphic UUID: dictation for transcription, clinical record for structuring.';


--
-- Name: COLUMN processing_attempts.result_snapshot; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.result_snapshot IS 'Immutable, tenant-scoped snapshot of the exact structured draft returned by this attempt; never contains audio or secrets.';


--
-- Name: COLUMN processing_attempts.result_sha256; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.result_sha256 IS 'Application-canonical SHA-256 of result_snapshot, verified before idempotent replay.';


--
-- Name: COLUMN processing_attempts.result_version; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.result_version IS 'clinical_records.updated_at version captured atomically with a structuring result snapshot.';


--
-- Name: COLUMN processing_attempts.cleanup_protocol; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.cleanup_protocol IS 'Audio cleanup contract: deterministic_v2 for current writers, legacy_ephemeral_v1 only for the supported N-1 rollback window; null for structuring.';


--
-- Name: COLUMN processing_attempts.cleanup_owner; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.cleanup_owner IS 'Stable, non-secret LUMEN instance owner used only by deterministic_v2 with the attempt UUID; never a filesystem path.';


--
-- Name: COLUMN processing_attempts.cleanup_scope_id; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.cleanup_scope_id IS 'Non-secret per-container or per-pod ephemeral scope captured from a validated N-1 PGAPPNAME; never a filesystem path.';


--
-- Name: COLUMN processing_attempts.cleanup_target_status; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.cleanup_target_status IS 'Terminal status to apply only after temporary audio deletion has independent evidence.';


--
-- Name: COLUMN processing_attempts.cleanup_disposition; Type: COMMENT; Schema: lumen; Owner: -
--

COMMENT ON COLUMN lumen.processing_attempts.cleanup_disposition IS 'Technical evidence class for confirmed absence/deletion; never claims deterministic cleanup for a legacy random path.';


--
-- Name: schema_version; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.schema_version (
    service_name text NOT NULL,
    current_version integer NOT NULL,
    migration_name text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schema_version_current_version_check CHECK ((current_version > 0)),
    CONSTRAINT schema_version_service_name_check CHECK ((service_name = 'lumen'::text))
);


--
-- Name: service_migrations; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.service_migrations (
    version integer NOT NULL,
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_migrations_name_check CHECK (((length(btrim(name)) >= 3) AND (length(btrim(name)) <= 160))),
    CONSTRAINT service_migrations_version_check CHECK ((version > 0))
);


--
-- Name: tenant_snapshots; Type: TABLE; Schema: lumen; Owner: -
--

CREATE TABLE lumen.tenant_snapshots (
    tenant_id uuid NOT NULL,
    status text NOT NULL,
    is_demo boolean NOT NULL,
    is_active boolean NOT NULL,
    source_event_id uuid,
    source_version bigint NOT NULL,
    source_updated_at timestamp with time zone NOT NULL,
    payload_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_snapshots_check CHECK ((is_active = (status = 'active'::text))),
    CONSTRAINT tenant_snapshots_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT tenant_snapshots_source_version_check CHECK ((source_version > 0)),
    CONSTRAINT tenant_snapshots_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text])))
);


--
-- Name: audio_cleanup_owner_leases audio_cleanup_owner_leases_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.audio_cleanup_owner_leases
    ADD CONSTRAINT audio_cleanup_owner_leases_pkey PRIMARY KEY (cleanup_owner);


--
-- Name: clinical_records clinical_records_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.clinical_records
    ADD CONSTRAINT clinical_records_pkey PRIMARY KEY (id);


--
-- Name: clinical_records clinical_records_tenant_id_encounter_id_key; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.clinical_records
    ADD CONSTRAINT clinical_records_tenant_id_encounter_id_key UNIQUE (tenant_id, encounter_id);


--
-- Name: clinical_records clinical_records_tenant_id_id_key; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.clinical_records
    ADD CONSTRAINT clinical_records_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: dictations dictations_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.dictations
    ADD CONSTRAINT dictations_pkey PRIMARY KEY (id);


--
-- Name: dictations dictations_tenant_id_id_key; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.dictations
    ADD CONSTRAINT dictations_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: encounter_reference_snapshots encounter_reference_snapshots_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.encounter_reference_snapshots
    ADD CONSTRAINT encounter_reference_snapshots_pkey PRIMARY KEY (tenant_id, encounter_id);


--
-- Name: encounters encounters_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.encounters
    ADD CONSTRAINT encounters_pkey PRIMARY KEY (id);


--
-- Name: encounters encounters_tenant_id_id_key; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.encounters
    ADD CONSTRAINT encounters_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: inbox_events inbox_events_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.inbox_events
    ADD CONSTRAINT inbox_events_pkey PRIMARY KEY (id);


--
-- Name: legacy_audio_scope_attestations legacy_audio_scope_attestations_cleanup_scope_id_key; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.legacy_audio_scope_attestations
    ADD CONSTRAINT legacy_audio_scope_attestations_cleanup_scope_id_key UNIQUE (cleanup_scope_id);


--
-- Name: legacy_audio_scope_attestations legacy_audio_scope_attestations_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.legacy_audio_scope_attestations
    ADD CONSTRAINT legacy_audio_scope_attestations_pkey PRIMARY KEY (attestation_id);


--
-- Name: n_minus_one_compatibility_windows n_minus_one_compatibility_windows_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.n_minus_one_compatibility_windows
    ADD CONSTRAINT n_minus_one_compatibility_windows_pkey PRIMARY KEY (cleanup_scope_id);


--
-- Name: operator_grants operator_grants_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.operator_grants
    ADD CONSTRAINT operator_grants_pkey PRIMARY KEY (operator_id, tenant_id);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: preconsultation_summaries preconsultation_summaries_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.preconsultation_summaries
    ADD CONSTRAINT preconsultation_summaries_pkey PRIMARY KEY (id);


--
-- Name: preconsultation_summaries preconsultation_summaries_tenant_id_encounter_id_key; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.preconsultation_summaries
    ADD CONSTRAINT preconsultation_summaries_tenant_id_encounter_id_key UNIQUE (tenant_id, encounter_id);


--
-- Name: preconsultation_summaries preconsultation_summaries_tenant_id_id_key; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.preconsultation_summaries
    ADD CONSTRAINT preconsultation_summaries_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: processing_attempts processing_attempts_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.processing_attempts
    ADD CONSTRAINT processing_attempts_pkey PRIMARY KEY (id);


--
-- Name: schema_version schema_version_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.schema_version
    ADD CONSTRAINT schema_version_pkey PRIMARY KEY (service_name);


--
-- Name: service_migrations service_migrations_name_key; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.service_migrations
    ADD CONSTRAINT service_migrations_name_key UNIQUE (name);


--
-- Name: service_migrations service_migrations_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.service_migrations
    ADD CONSTRAINT service_migrations_pkey PRIMARY KEY (version);


--
-- Name: tenant_snapshots tenant_snapshots_pkey; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.tenant_snapshots
    ADD CONSTRAINT tenant_snapshots_pkey PRIMARY KEY (tenant_id);


--
-- Name: dictations uq_lumen_dictation_encounter_identity; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.dictations
    ADD CONSTRAINT uq_lumen_dictation_encounter_identity UNIQUE (tenant_id, encounter_id, id);


--
-- Name: outbox_events uq_lumen_outbox_dedupe; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.outbox_events
    ADD CONSTRAINT uq_lumen_outbox_dedupe UNIQUE (tenant_id, dedupe_key);


--
-- Name: processing_attempts uq_lumen_processing_attempt_idempotency; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.processing_attempts
    ADD CONSTRAINT uq_lumen_processing_attempt_idempotency UNIQUE (tenant_id, encounter_id, operation, idempotency_key);


--
-- Name: processing_attempts uq_lumen_processing_attempt_identity; Type: CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.processing_attempts
    ADD CONSTRAINT uq_lumen_processing_attempt_identity UNIQUE (tenant_id, encounter_id, id);


--
-- Name: idx_lumen_dictations_encounter; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX idx_lumen_dictations_encounter ON lumen.dictations USING btree (tenant_id, encounter_id, created_at DESC);


--
-- Name: idx_lumen_dictations_processing_attempt; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX idx_lumen_dictations_processing_attempt ON lumen.dictations USING btree (tenant_id, encounter_id, processing_attempt_id) WHERE (processing_attempt_id IS NOT NULL);


--
-- Name: idx_lumen_encounters_worklist; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX idx_lumen_encounters_worklist ON lumen.encounters USING btree (tenant_id, scheduled_at, status);


--
-- Name: idx_lumen_processing_attempts_cleanup_pending; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX idx_lumen_processing_attempts_cleanup_pending ON lumen.processing_attempts USING btree (cleanup_owner, created_at, id) WHERE ((status = 'cleanup_pending'::text) AND (cleanup_protocol = 'deterministic_v2'::text));


--
-- Name: idx_lumen_processing_attempts_encounter; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX idx_lumen_processing_attempts_encounter ON lumen.processing_attempts USING btree (tenant_id, encounter_id, operation, created_at DESC);


--
-- Name: idx_lumen_processing_attempts_status; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX idx_lumen_processing_attempts_status ON lumen.processing_attempts USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_lumen_processing_attempts_unresolved_cleanup_owner; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX idx_lumen_processing_attempts_unresolved_cleanup_owner ON lumen.processing_attempts USING btree (cleanup_owner) WHERE ((operation = 'transcription'::text) AND (cleanup_protocol = 'deterministic_v2'::text) AND (status = ANY (ARRAY['processing'::text, 'cleanup_pending'::text])));


--
-- Name: idx_lumen_records_status; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX idx_lumen_records_status ON lumen.clinical_records USING btree (tenant_id, status, updated_at DESC);


--
-- Name: ix_lumen_inbox_tenant_received; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX ix_lumen_inbox_tenant_received ON lumen.inbox_events USING btree (tenant_id, received_at DESC);


--
-- Name: ix_lumen_operator_grants_review; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX ix_lumen_operator_grants_review ON lumen.operator_grants USING btree (tenant_id, operator_id) WHERE (is_active AND can_review);


--
-- Name: ix_lumen_outbox_claim; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX ix_lumen_outbox_claim ON lumen.outbox_events USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text]));


--
-- Name: ix_lumen_reference_patient; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX ix_lumen_reference_patient ON lumen.encounter_reference_snapshots USING btree (tenant_id, patient_id);


--
-- Name: ix_lumen_reference_professional; Type: INDEX; Schema: lumen; Owner: -
--

CREATE INDEX ix_lumen_reference_professional ON lumen.encounter_reference_snapshots USING btree (tenant_id, professional_id);


--
-- Name: uq_lumen_encounters_demo_key; Type: INDEX; Schema: lumen; Owner: -
--

CREATE UNIQUE INDEX uq_lumen_encounters_demo_key ON lumen.encounters USING btree (tenant_id, demo_key) WHERE (demo_key IS NOT NULL);


--
-- Name: ux_lumen_single_open_n1_compatibility_window; Type: INDEX; Schema: lumen; Owner: -
--

CREATE UNIQUE INDEX ux_lumen_single_open_n1_compatibility_window ON lumen.n_minus_one_compatibility_windows USING btree ((1)) WHERE (closed_at IS NULL);


--
-- Name: clinical_records trg_finalize_clinical_record_approval; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_finalize_clinical_record_approval AFTER UPDATE OF status ON lumen.clinical_records FOR EACH ROW EXECUTE FUNCTION lumen.finalize_clinical_record_approval();


--
-- Name: dictations trg_guard_approved_dictation; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_guard_approved_dictation BEFORE INSERT OR DELETE OR UPDATE ON lumen.dictations FOR EACH ROW EXECUTE FUNCTION lumen.guard_approved_dictation();


--
-- Name: clinical_records trg_guard_clinical_record; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_guard_clinical_record BEFORE INSERT OR DELETE OR UPDATE ON lumen.clinical_records FOR EACH ROW EXECUTE FUNCTION lumen.guard_clinical_record();


--
-- Name: dictations trg_guard_dictation_real_audio_lineage; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_guard_dictation_real_audio_lineage BEFORE INSERT OR UPDATE OF tenant_id, encounter_id, processing_attempt_id, provider_transcript, transcript, reviewed_at, reviewed_by ON lumen.dictations FOR EACH ROW EXECUTE FUNCTION lumen.guard_dictation_real_audio_lineage();


--
-- Name: encounter_reference_snapshots trg_guard_encounter_reference_snapshot; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_guard_encounter_reference_snapshot BEFORE INSERT OR DELETE OR UPDATE ON lumen.encounter_reference_snapshots FOR EACH ROW EXECUTE FUNCTION lumen.guard_encounter_reference_snapshot();


--
-- Name: processing_attempts trg_guard_processing_attempt_transition; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_guard_processing_attempt_transition BEFORE INSERT OR DELETE OR UPDATE ON lumen.processing_attempts FOR EACH ROW EXECUTE FUNCTION lumen.guard_processing_attempt_transition();


--
-- Name: encounters trg_guard_synthetic_encounter; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_guard_synthetic_encounter BEFORE INSERT OR DELETE OR UPDATE ON lumen.encounters FOR EACH ROW EXECUTE FUNCTION lumen.guard_synthetic_encounter();


--
-- Name: processing_attempts trg_require_attested_legacy_cleanup_terminal; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_require_attested_legacy_cleanup_terminal AFTER UPDATE ON lumen.processing_attempts FOR EACH ROW WHEN (((old.cleanup_protocol = 'legacy_ephemeral_v1'::text) AND ((old.status = 'cleanup_pending'::text) OR (new.cleanup_disposition = 'ephemeral_scope_destroyed'::text)))) EXECUTE FUNCTION lumen.require_attested_legacy_cleanup_terminal();


--
-- Name: processing_attempts trg_require_open_n1_compatibility_window; Type: TRIGGER; Schema: lumen; Owner: -
--

CREATE TRIGGER trg_require_open_n1_compatibility_window AFTER INSERT ON lumen.processing_attempts FOR EACH ROW WHEN (((new.operation = 'transcription'::text) AND (new.cleanup_protocol = 'legacy_ephemeral_v1'::text))) EXECUTE FUNCTION lumen.require_open_n1_compatibility_window();


--
-- Name: dictations fk_lumen_dictation_encounter_tenant; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.dictations
    ADD CONSTRAINT fk_lumen_dictation_encounter_tenant FOREIGN KEY (tenant_id, encounter_id) REFERENCES lumen.encounters(tenant_id, id) ON DELETE CASCADE;


--
-- Name: dictations fk_lumen_dictation_processing_attempt; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.dictations
    ADD CONSTRAINT fk_lumen_dictation_processing_attempt FOREIGN KEY (tenant_id, encounter_id, processing_attempt_id) REFERENCES lumen.processing_attempts(tenant_id, encounter_id, id) ON DELETE CASCADE;


--
-- Name: operator_grants fk_lumen_operator_grant_tenant_snapshot; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.operator_grants
    ADD CONSTRAINT fk_lumen_operator_grant_tenant_snapshot FOREIGN KEY (tenant_id) REFERENCES lumen.tenant_snapshots(tenant_id) ON DELETE CASCADE;


--
-- Name: preconsultation_summaries fk_lumen_preconsultation_encounter_tenant; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.preconsultation_summaries
    ADD CONSTRAINT fk_lumen_preconsultation_encounter_tenant FOREIGN KEY (tenant_id, encounter_id) REFERENCES lumen.encounters(tenant_id, id) ON DELETE CASCADE;


--
-- Name: processing_attempts fk_lumen_processing_attempt_encounter_tenant; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.processing_attempts
    ADD CONSTRAINT fk_lumen_processing_attempt_encounter_tenant FOREIGN KEY (tenant_id, encounter_id) REFERENCES lumen.encounters(tenant_id, id) ON DELETE CASCADE;


--
-- Name: clinical_records fk_lumen_record_dictation_encounter; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.clinical_records
    ADD CONSTRAINT fk_lumen_record_dictation_encounter FOREIGN KEY (tenant_id, encounter_id, dictation_id) REFERENCES lumen.dictations(tenant_id, encounter_id, id) ON DELETE RESTRICT;


--
-- Name: clinical_records fk_lumen_record_encounter_tenant; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.clinical_records
    ADD CONSTRAINT fk_lumen_record_encounter_tenant FOREIGN KEY (tenant_id, encounter_id) REFERENCES lumen.encounters(tenant_id, id) ON DELETE CASCADE;


--
-- Name: encounter_reference_snapshots fk_lumen_reference_tenant_snapshot; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.encounter_reference_snapshots
    ADD CONSTRAINT fk_lumen_reference_tenant_snapshot FOREIGN KEY (tenant_id) REFERENCES lumen.tenant_snapshots(tenant_id) ON DELETE RESTRICT;


--
-- Name: legacy_audio_scope_attestations legacy_audio_scope_attestations_cleanup_scope_id_fkey; Type: FK CONSTRAINT; Schema: lumen; Owner: -
--

ALTER TABLE ONLY lumen.legacy_audio_scope_attestations
    ADD CONSTRAINT legacy_audio_scope_attestations_cleanup_scope_id_fkey FOREIGN KEY (cleanup_scope_id) REFERENCES lumen.n_minus_one_compatibility_windows(cleanup_scope_id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

-- Match the fail-closed legacy privilege boundary before the runtime-role
-- migration runs. PostgreSQL grants PUBLIC execute on new functions by default.
revoke all privileges on schema lumen from public;
revoke all privileges on all tables in schema lumen from public;
revoke all privileges on all sequences in schema lumen from public;
revoke execute on all functions in schema lumen from public;

insert into lumen.service_migrations (version, name)
values (39, '001-lumen-autonomous-baseline.sql')
on conflict (version) do update set name = excluded.name;

insert into lumen.schema_version (service_name, current_version, migration_name)
values ('lumen', 39, '001-lumen-autonomous-baseline.sql')
on conflict (service_name) do update set
  current_version = greatest(lumen.schema_version.current_version, excluded.current_version),
  migration_name = case
    when excluded.current_version >= lumen.schema_version.current_version then excluded.migration_name
    else lumen.schema_version.migration_name
  end,
  updated_at = now();
