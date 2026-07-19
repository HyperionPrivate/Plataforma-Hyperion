-- Provider-owned PULSO autonomous baseline.
--
-- Provenance: schema-only extraction of the effective PostgreSQL 16 state after
-- legacy migrations 001-platform.sql through 046-pulso-channel-delivery-inbox-contract.sql,
-- restricted to the PULSO cell closure. The Access overlay
-- 005-remove-pulso-agenda-trigger.sql is reflected: neither the cross-owner
-- tenant trigger nor its historical PULSO function is present. Customer seed
-- data, Access identities, Audit, NOVA and LUMEN objects are intentionally absent.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: agent_runtime; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS agent_runtime;


--
-- Name: channel_runtime; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS channel_runtime;


--
-- Name: platform; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS platform;


--
-- Name: pulso_iris; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS pulso_iris;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: jobs; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    inbound_event_id uuid NOT NULL,
    job_type text DEFAULT 'sofia_message'::text NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    priority integer DEFAULT 50 NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 2 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_error_code text,
    last_error_message text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stream_id uuid NOT NULL,
    stream_sequence bigint NOT NULL,
    ordering_source text NOT NULL,
    CONSTRAINT ck_agent_jobs_ordered_stream CHECK (((stream_id = conversation_id) AND (stream_sequence > 0) AND (ordering_source = ANY (ARRAY['pulso_durable'::text, 'legacy_polling_allocator'::text])))),
    CONSTRAINT jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT jobs_idempotency_key_check CHECK ((length(TRIM(BOTH FROM idempotency_key)) >= 8)),
    CONSTRAINT jobs_input_check CHECK ((jsonb_typeof(input) = 'object'::text)),
    CONSTRAINT jobs_job_type_check CHECK ((job_type = 'sofia_message'::text)),
    CONSTRAINT jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10))),
    CONSTRAINT jobs_priority_check CHECK (((priority >= 0) AND (priority <= 100))),
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'retry_scheduled'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'dead_letter'::text])))
);


--
-- Name: COLUMN jobs.stream_sequence; Type: COMMENT; Schema: agent_runtime; Owner: -
--

COMMENT ON COLUMN agent_runtime.jobs.stream_sequence IS 'SOFIA execution position; successors remain blocked until predecessors complete';


--
-- Name: claim_next_job(text); Type: FUNCTION; Schema: agent_runtime; Owner: -
--

CREATE FUNCTION agent_runtime.claim_next_job(p_worker_id text) RETURNS SETOF agent_runtime.jobs
    LANGUAGE sql
    AS $$
  with terminalized as (
    update agent_runtime.jobs
       set status = 'dead_letter', locked_at = null, locked_by = null, updated_at = now()
     where status = 'running'
       and locked_at < now() - interval '2 minutes'
       and attempt_count >= max_attempts
    returning id
  ), candidate as (
    select candidate.id
      from agent_runtime.jobs candidate
     where (
         candidate.status in ('queued', 'retry_scheduled')
         or (candidate.status = 'running' and candidate.locked_at < now() - interval '2 minutes')
       )
       and candidate.stream_id is not null
       and candidate.stream_sequence is not null
       and candidate.next_attempt_at <= now()
       and candidate.attempt_count < candidate.max_attempts
       and not exists (
         select 1
           from agent_runtime.jobs predecessor
          where predecessor.tenant_id = candidate.tenant_id
            and predecessor.stream_id = candidate.stream_id
            and predecessor.stream_sequence < candidate.stream_sequence
            and predecessor.status <> 'completed'
       )
     order by candidate.priority desc, candidate.next_attempt_at, candidate.created_at
     for update of candidate skip locked
     limit 1
  )
  update agent_runtime.jobs job
     set status = 'running',
         attempt_count = job.attempt_count + 1,
         locked_at = now(), locked_by = p_worker_id, updated_at = now()
    from candidate
   where job.id = candidate.id
  returning job.*;
$$;


--
-- Name: prepare_ordered_job(); Type: FUNCTION; Schema: agent_runtime; Owner: -
--

CREATE FUNCTION agent_runtime.prepare_ordered_job() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'agent_runtime'
    AS $$
declare
  existing_job agent_runtime.jobs%rowtype;
  current_sequence bigint;
begin
  select candidate.*
    into existing_job
    from agent_runtime.jobs candidate
   where candidate.tenant_id = new.tenant_id
     and candidate.inbound_event_id = new.inbound_event_id;
  if found then
    new.stream_id := existing_job.stream_id;
    new.stream_sequence := existing_job.stream_sequence;
    new.ordering_source := existing_job.ordering_source;
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || new.conversation_id::text, 0)
  );
  select position.last_sequence
    into current_sequence
    from agent_runtime.job_stream_positions position
   where position.tenant_id = new.tenant_id
     and position.stream_id = new.conversation_id
   for update;
  if not found then
    select count(*)::bigint
      into current_sequence
      from agent_runtime.jobs candidate
     where candidate.tenant_id = new.tenant_id
       and candidate.conversation_id = new.conversation_id;
  end if;
  current_sequence := coalesce(current_sequence, 0);

  if new.stream_id is null and new.stream_sequence is null then
    new.stream_id := new.conversation_id;
    new.stream_sequence := current_sequence + 1;
    new.ordering_source := 'legacy_polling_allocator';
  elsif new.stream_id <> new.conversation_id
        or new.stream_sequence is null
        or new.stream_sequence <> current_sequence + 1
        or new.ordering_source <> 'pulso_durable' then
    raise exception using errcode = '23514', message = 'SOFIA job stream position is not the next durable position';
  end if;

  insert into agent_runtime.job_stream_positions (tenant_id, stream_id, last_sequence)
  values (new.tenant_id, new.stream_id, new.stream_sequence)
  on conflict (tenant_id, stream_id) do update
  set last_sequence = excluded.last_sequence,
      updated_at = now();

  if exists (
    select 1
      from agent_runtime.jobs predecessor
     where predecessor.tenant_id = new.tenant_id
       and predecessor.conversation_id = new.conversation_id
       and predecessor.status <> 'completed'
  ) then
    new.next_attempt_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;


--
-- Name: reject_unpositioned_job_claim(); Type: FUNCTION; Schema: agent_runtime; Owner: -
--

CREATE FUNCTION agent_runtime.reject_unpositioned_job_claim() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'agent_runtime'
    AS $$
begin
  if new.status = 'running'
     and old.status <> 'running'
     and (new.stream_id is null or new.stream_sequence is null or new.ordering_source is null) then
    raise exception using errcode = '55000', message = 'SOFIA job ordering backfill is incomplete';
  end if;
  return new;
end;
$$;


--
-- Name: release_next_ordered_job(); Type: FUNCTION; Schema: agent_runtime; Owner: -
--

CREATE FUNCTION agent_runtime.release_next_ordered_job() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'agent_runtime'
    AS $$
begin
  if new.status = 'completed'
     and old.status <> 'completed'
     and new.stream_id is not null
     and new.stream_sequence is not null then
    update agent_runtime.jobs successor
       set next_attempt_at = now(), updated_at = now()
     where successor.tenant_id = new.tenant_id
       and successor.stream_id = new.stream_id
       and successor.stream_sequence = new.stream_sequence + 1
       and successor.status in ('queued', 'retry_scheduled')
       and successor.next_attempt_at = 'infinity'::timestamptz
       and not exists (
         select 1
           from agent_runtime.jobs predecessor
          where predecessor.tenant_id = successor.tenant_id
            and predecessor.stream_id = successor.stream_id
            and predecessor.stream_sequence < successor.stream_sequence
            and predecessor.status <> 'completed'
       );
  end if;
  return new;
end;
$$;


--
-- Name: resolve_legacy_pulso_inbox_position(); Type: FUNCTION; Schema: agent_runtime; Owner: -
--

CREATE FUNCTION agent_runtime.resolve_legacy_pulso_inbox_position() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  producer_position record;
begin
  if new.source_service not in ('pulso-core', 'pulso-iris-service')
     or new.event_type <> 'pulso.message.received.v1' then
    return new;
  end if;

  select position.stream_id, position.stream_sequence,
         position.source_stream_id, position.source_stream_sequence
    into producer_position
    from pulso_iris.outbox_events event
    join pulso_iris.outbox_event_positions position
      on position.tenant_id = event.tenant_id
     and position.event_id = event.id
     and position.stream_id = event.stream_id
     and position.stream_sequence = event.stream_sequence
     and position.source_stream_id = event.source_stream_id
     and position.source_stream_sequence = event.source_stream_sequence
   where event.tenant_id = new.tenant_id
     and event.id = new.event_id
     and event.event_type = 'pulso.message.received.v1'
     and event.event_version = 1;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event has no owner-ledger position';
  end if;

  if new.stream_id is not null or new.stream_sequence is not null
     or new.source_stream_id is not null or new.source_stream_sequence is not null then
    if new.stream_id is null or new.stream_sequence is null
       or new.source_stream_id is null or new.source_stream_sequence is null
       or new.stream_id <> producer_position.stream_id
       or new.stream_sequence <> producer_position.stream_sequence
       or new.source_stream_id <> producer_position.source_stream_id
       or new.source_stream_sequence <> producer_position.source_stream_sequence then
      raise exception using
        errcode = '23514',
        message = 'Legacy PULSO inbox position conflicts with the owner ledger';
    end if;
  end if;

  new.stream_id := producer_position.stream_id;
  new.stream_sequence := producer_position.stream_sequence;
  new.source_stream_id := producer_position.source_stream_id;
  new.source_stream_sequence := producer_position.source_stream_sequence;
  return new;
end;
$$;


--
-- Name: FUNCTION resolve_legacy_pulso_inbox_position(); Type: COMMENT; Schema: agent_runtime; Owner: -
--

COMMENT ON FUNCTION agent_runtime.resolve_legacy_pulso_inbox_position() IS 'N-1 rollback adapter: resolves a v1 SOFIA inbox position from the exact PULSO owner ledger row.';


--
-- Name: inbound_events; Type: TABLE; Schema: channel_runtime; Owner: -
--

CREATE TABLE channel_runtime.inbound_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    thread_binding_id uuid,
    message_id uuid,
    provider text NOT NULL,
    external_message_id text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error_code text,
    last_error_message text,
    occurred_at timestamp with time zone NOT NULL,
    processed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inbound_events_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT inbound_events_body_check CHECK (((length(body) >= 1) AND (length(body) <= 4096))),
    CONSTRAINT inbound_events_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 20))),
    CONSTRAINT inbound_events_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT inbound_events_status_check CHECK ((status = ANY (ARRAY['received'::text, 'queued'::text, 'processing'::text, 'processed'::text, 'ignored'::text, 'retry_scheduled'::text, 'failed'::text, 'dead_letter'::text])))
);


--
-- Name: claim_next_inbound_event(text); Type: FUNCTION; Schema: channel_runtime; Owner: -
--

CREATE FUNCTION channel_runtime.claim_next_inbound_event(p_worker_id text) RETURNS SETOF channel_runtime.inbound_events
    LANGUAGE sql
    AS $$
  with terminalized as (
    update channel_runtime.inbound_events
    set status = 'dead_letter',
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where status = 'processing'
      and locked_at < now() - interval '2 minutes'
      and attempt_count >= max_attempts
    returning id
  ), candidate as (
    select id, status
    from channel_runtime.inbound_events
    where (
        status in ('received', 'queued', 'retry_scheduled')
        or (status = 'processing' and locked_at < now() - interval '2 minutes')
      )
      and next_attempt_at <= now()
      and attempt_count < max_attempts
    order by next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update channel_runtime.inbound_events e
  set status = 'processing',
      attempt_count = e.attempt_count + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      updated_at = now()
  from candidate
  where e.id = candidate.id
  returning e.*;
$$;


--
-- Name: outbound_messages; Type: TABLE; Schema: channel_runtime; Owner: -
--

CREATE TABLE channel_runtime.outbound_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    thread_binding_id uuid NOT NULL,
    message_id uuid NOT NULL,
    provider text NOT NULL,
    idempotency_key text NOT NULL,
    body text NOT NULL,
    provider_message_id text,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error_code text,
    last_error_message text,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbound_messages_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT outbound_messages_body_check CHECK (((length(body) >= 1) AND (length(body) <= 4096))),
    CONSTRAINT outbound_messages_idempotency_key_check CHECK ((length(TRIM(BOTH FROM idempotency_key)) >= 8)),
    CONSTRAINT outbound_messages_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 20))),
    CONSTRAINT outbound_messages_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'sending'::text, 'retry_scheduled'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'cancelled'::text, 'dead_letter'::text, 'reconciliation_required'::text])))
);


--
-- Name: claim_next_outbound_message(text); Type: FUNCTION; Schema: channel_runtime; Owner: -
--

CREATE FUNCTION channel_runtime.claim_next_outbound_message(p_worker_id text) RETURNS SETOF channel_runtime.outbound_messages
    LANGUAGE sql
    AS $$
  with uncertain as (
    update channel_runtime.outbound_messages
    set status = 'reconciliation_required',
        locked_at = null,
        locked_by = null,
        last_error_code = 'delivery_outcome_unknown',
        last_error_message = null,
        updated_at = now()
    where status = 'sending'
      and locked_at < now() - interval '2 minutes'
    returning tenant_id, message_id
  ), terminalized as (
    update channel_runtime.outbound_messages
    set status = 'dead_letter',
        locked_at = null,
        locked_by = null,
        last_error_code = 'claim_attempts_exhausted',
        last_error_message = null,
        updated_at = now()
    where status = 'processing'
      and locked_at < now() - interval '2 minutes'
      and attempt_count >= max_attempts
    returning tenant_id, message_id
  ), candidate as (
    select id, status
    from channel_runtime.outbound_messages
    where (
        status in ('queued', 'retry_scheduled')
        or (status = 'processing' and locked_at < now() - interval '2 minutes')
      )
      and next_attempt_at <= now()
      and attempt_count < max_attempts
    order by next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update channel_runtime.outbound_messages m
  set status = 'processing',
      attempt_count = m.attempt_count + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      updated_at = now()
  from candidate
  where m.id = candidate.id
  returning m.*;
$$;


--
-- Name: defer_non_head_outbox_event(); Type: FUNCTION; Schema: channel_runtime; Owner: -
--

CREATE FUNCTION channel_runtime.defer_non_head_outbox_event() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'channel_runtime'
    AS $$
begin
  if new.event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
     and new.stream_id is not null
     and new.stream_sequence is not null
     and exists (
       select 1
       from channel_runtime.outbox_events predecessor
       where predecessor.tenant_id = new.tenant_id
         and predecessor.stream_id = new.stream_id
         and predecessor.stream_sequence < new.stream_sequence
         and predecessor.status <> 'published'
     ) then
    new.next_attempt_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;


--
-- Name: mirror_inbound_event_to_outbox(); Type: FUNCTION; Schema: channel_runtime; Owner: -
--

CREATE FUNCTION channel_runtime.mirror_inbound_event_to_outbox() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'channel_runtime'
    AS $_$
declare
  binding channel_runtime.thread_bindings%rowtype;
  allocated_sequence bigint;
begin
  if new.status not in ('received', 'queued', 'processing', 'retry_scheduled') then
    return new;
  end if;

  select candidate.*
    into binding
    from channel_runtime.thread_bindings candidate
   where candidate.tenant_id = new.tenant_id
     and candidate.id = new.thread_binding_id;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'channel inbound event requires a local thread binding for durable publication';
  end if;

  if new.provider <> 'whatsapp_web_test'
     or char_length(new.external_message_id) not between 1 and 512
     or char_length(binding.external_thread_id) not between 1 and 512
     or binding.phone_e164_hash !~ '^[a-f0-9]{64}$'
     or char_length(binding.phone_masked) not between 3 and 32 then
    raise exception using
      errcode = '23514',
      message = 'channel inbound event does not satisfy the durable publication contract';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || binding.id::text, 0)
  );

  select position.stream_sequence
    into allocated_sequence
    from channel_runtime.outbox_event_positions position
   where position.tenant_id = new.tenant_id
     and position.event_id = new.id;

  if allocated_sequence is null then
    insert into channel_runtime.outbox_stream_positions (tenant_id, stream_id, last_sequence)
    values (new.tenant_id, binding.id, 1)
    on conflict (tenant_id, stream_id) do update
    set last_sequence = channel_runtime.outbox_stream_positions.last_sequence + 1,
        updated_at = now()
    returning last_sequence into allocated_sequence;

    insert into channel_runtime.outbox_event_positions (
      tenant_id, event_id, stream_id, stream_sequence
    ) values (
      new.tenant_id, new.id, binding.id, allocated_sequence
    );
  end if;

  insert into channel_runtime.outbox_events (
    tenant_id,
    event_type,
    event_version,
    aggregate_type,
    aggregate_id,
    stream_id,
    stream_sequence,
    payload,
    occurred_at
  ) values (
    new.tenant_id,
    'channel.inbound.received.v1',
    1,
    'channel_inbound_event',
    new.id,
    binding.id,
    allocated_sequence,
    jsonb_build_object(
      'inboundEventId', new.id,
      'threadBindingId', binding.id,
      'provider', new.provider,
      'externalThreadId', binding.external_thread_id,
      'externalMessageId', new.external_message_id,
      'phoneHash', binding.phone_e164_hash,
      'phoneMasked', binding.phone_masked,
      'body', new.body,
      'receivedAt', new.occurred_at
    ),
    new.occurred_at
  )
  on conflict (tenant_id, event_type, aggregate_id) do nothing;

  return new;
end;
$_$;


--
-- Name: release_next_outbox_event(); Type: FUNCTION; Schema: channel_runtime; Owner: -
--

CREATE FUNCTION channel_runtime.release_next_outbox_event() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'channel_runtime'
    AS $$
begin
  if new.status = 'published'
     and old.status <> 'published'
     and new.stream_id is not null
     and new.stream_sequence is not null then
    update channel_runtime.outbox_events successor
    set next_attempt_at = now(),
        updated_at = now()
    where successor.tenant_id = new.tenant_id
      and successor.stream_id = new.stream_id
      and successor.stream_sequence = new.stream_sequence + 1
      and successor.status in ('queued', 'retry_scheduled')
      and successor.next_attempt_at = 'infinity'::timestamptz
      and not exists (
        select 1
        from channel_runtime.outbox_events predecessor
        where predecessor.tenant_id = successor.tenant_id
          and predecessor.stream_id = successor.stream_id
          and predecessor.stream_sequence < successor.stream_sequence
          and predecessor.status <> 'published'
      );
  end if;
  return new;
end;
$$;


--
-- Name: guard_slot_capacity_claim(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.guard_slot_capacity_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  claim_key bigint;
  is_occupying boolean;
begin
  if tg_table_name = 'appointment_holds' then
    is_occupying := new.status = 'active';
  else
    is_occupying := new.status not in (
      'cancelled', 'no_show', 'rescheduled', 'external_rejected', 'failed', 'expired'
    );
  end if;

  if not is_occupying
    or new.site_id is null
    or new.professional_id is null
    or new.appointment_type_id is null
    or new.scheduled_at is null
    or new.slot_capacity_token is null then
    return new;
  end if;

  claim_key := hashtextextended(concat_ws(
    '|',
    new.tenant_id::text,
    new.site_id::text,
    new.professional_id::text,
    new.appointment_type_id::text,
    new.scheduled_at::text,
    new.slot_capacity_token::text
  ), 0);
  perform pg_advisory_xact_lock(claim_key);

  if tg_table_name = 'appointment_holds' then
    if exists (
      select 1 from pulso_iris.appointments a
      where a.tenant_id = new.tenant_id
        and a.site_id = new.site_id
        and a.professional_id = new.professional_id
        and a.appointment_type_id = new.appointment_type_id
        and a.scheduled_at = new.scheduled_at
        and a.slot_capacity_token = new.slot_capacity_token
        and a.status not in ('cancelled', 'no_show', 'rescheduled', 'external_rejected', 'failed', 'expired')
        and (new.appointment_id is null or a.id <> new.appointment_id)
    ) then
      raise exception using errcode = '23505', message = 'slot capacity token is already occupied';
    end if;
  else
    if exists (
      select 1 from pulso_iris.appointment_holds h
      where h.tenant_id = new.tenant_id
        and h.site_id = new.site_id
        and h.professional_id = new.professional_id
        and h.appointment_type_id = new.appointment_type_id
        and h.scheduled_at = new.scheduled_at
        and h.slot_capacity_token = new.slot_capacity_token
        and h.status = 'active'
        and h.expires_at > now()
        and (new.hold_id is null or h.id <> new.hold_id)
    ) then
      raise exception using errcode = '23505', message = 'slot capacity token has an active hold';
    end if;
  end if;

  return new;
end;
$$;


--
-- Name: prepare_legacy_message_source_position(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.prepare_legacy_message_source_position() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  existing_event pulso_iris.outbox_events%rowtype;
  source_inbox pulso_iris.inbox_events%rowtype;
  current_source_sequence bigint;
begin
  if new.event_type <> 'pulso.message.received.v1' then
    return new;
  end if;

  if new.event_version <> 1
     or new.payload ? 'sourceStreamId'
     or new.payload ? 'sourceStreamSequence' then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event does not match the strict v1 contract';
  end if;

  select candidate.*
    into existing_event
    from pulso_iris.outbox_events candidate
   where candidate.tenant_id = new.tenant_id
     and candidate.event_type = 'pulso.message.received.v1'
     and candidate.event_version = 1
     and candidate.aggregate_id = new.aggregate_id
   limit 1;
  if found then
    if existing_event.source_stream_id is null
       or existing_event.source_stream_sequence is null then
      raise exception using
        errcode = '23514',
        message = 'Existing legacy PULSO event has no source position';
    end if;
    if new.source_stream_id is not null or new.source_stream_sequence is not null then
      if new.source_stream_id is null or new.source_stream_sequence is null
         or new.source_stream_id <> existing_event.source_stream_id
         or new.source_stream_sequence <> existing_event.source_stream_sequence then
        raise exception using
          errcode = '23514',
          message = 'Legacy PULSO event source position conflicts with the persisted event';
      end if;
    end if;
    new.source_stream_id := existing_event.source_stream_id;
    new.source_stream_sequence := existing_event.source_stream_sequence;
    return new;
  end if;

  if new.payload ->> 'inboundEventId' !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or new.payload ->> 'threadBindingId' !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event has no valid Channel stream identifier';
  end if;

  select inbox.*
    into source_inbox
    from pulso_iris.inbox_events inbox
    join channel_runtime.outbox_events producer
      on producer.tenant_id = inbox.tenant_id
     and producer.id = inbox.event_id
     and producer.event_type = 'channel.inbound.received.v1'
     and producer.event_version = 1
     and producer.aggregate_type = 'channel_inbound_event'
     and producer.aggregate_id = (new.payload ->> 'inboundEventId')::uuid
     and producer.occurred_at = new.occurred_at
    join channel_runtime.outbox_event_positions position
      on position.tenant_id = producer.tenant_id
     and position.event_id = producer.aggregate_id
     and position.stream_id = producer.stream_id
     and position.stream_sequence = producer.stream_sequence
   where inbox.tenant_id = new.tenant_id
     and inbox.source_service = 'whatsapp-channel-service'
     and inbox.event_type = 'channel.inbound.received.v1'
     and inbox.event_version = 1
     and inbox.processed_at is null
     and inbox.stream_id = position.stream_id
     and inbox.stream_sequence = position.stream_sequence
     and inbox.stream_id = (new.payload ->> 'threadBindingId')::uuid
     and inbox.occurred_at = producer.occurred_at;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event has no exact local Channel owner position';
  end if;

  if new.source_stream_id is not null or new.source_stream_sequence is not null then
    if new.source_stream_id is null or new.source_stream_sequence is null
       or new.source_stream_id <> source_inbox.stream_id
       or new.source_stream_sequence <> source_inbox.stream_sequence then
      raise exception using
        errcode = '23514',
        message = 'Legacy PULSO event source position conflicts with the Channel owner ledger';
    end if;
  end if;

  select thread.last_inbound_sequence
    into current_source_sequence
    from pulso_iris.channel_threads thread
   where thread.tenant_id = new.tenant_id
     and thread.id = source_inbox.stream_id
   for update;
  if not found or source_inbox.stream_sequence <> current_source_sequence + 1 then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event is not the next Channel stream position';
  end if;

  update pulso_iris.channel_threads
     set last_inbound_sequence = source_inbox.stream_sequence,
         updated_at = now()
   where tenant_id = new.tenant_id
     and id = source_inbox.stream_id
     and last_inbound_sequence = current_source_sequence;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'Legacy PULSO Channel checkpoint changed concurrently';
  end if;

  new.source_stream_id := source_inbox.stream_id;
  new.source_stream_sequence := source_inbox.stream_sequence;
  return new;
end;
$_$;


--
-- Name: FUNCTION prepare_legacy_message_source_position(); Type: COMMENT; Schema: pulso_iris; Owner: -
--

COMMENT ON FUNCTION pulso_iris.prepare_legacy_message_source_position() IS 'N-1 rollback adapter: carries the locally resolved Channel position into a strict PULSO v1 outbox row.';


--
-- Name: prepare_ordered_message_outbox_event(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.prepare_ordered_message_outbox_event() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pulso_iris'
    AS $_$
declare
  existing_event pulso_iris.outbox_events%rowtype;
  resolved_stream_id uuid;
  resolved_source_stream_id uuid;
  resolved_source_sequence bigint;
  current_sequence bigint;
  allocated_sequence bigint;
begin
  if new.event_type not in ('pulso.message.received.v1', 'pulso.message.received.v2') then
    return new;
  end if;

  if new.payload ->> 'conversationId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or new.payload ->> 'inboundEventId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or new.payload ->> 'threadBindingId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '23514', message = 'PULSO message outbox contract is missing stable identifiers';
  end if;
  resolved_stream_id := (new.payload ->> 'conversationId')::uuid;

  select candidate.*
    into existing_event
    from pulso_iris.outbox_events candidate
   where candidate.tenant_id = new.tenant_id
     and candidate.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
     and candidate.aggregate_id = new.aggregate_id
   limit 1;
  if found then
    if existing_event.event_type <> new.event_type then
      raise exception using errcode = '23505', message = 'PULSO message aggregate already uses another contract version';
    end if;
    new.stream_id := existing_event.stream_id;
    new.stream_sequence := existing_event.stream_sequence;
    new.source_stream_id := existing_event.source_stream_id;
    new.source_stream_sequence := existing_event.source_stream_sequence;
    if new.event_type = 'pulso.message.received.v1' then
      new.payload := new.payload - 'sourceStreamId' - 'sourceStreamSequence';
    end if;
    return new;
  end if;

  if new.source_stream_id is not null and new.source_stream_sequence is not null then
    resolved_source_stream_id := new.source_stream_id;
    resolved_source_sequence := new.source_stream_sequence;
  elsif new.payload ->> 'sourceStreamId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and new.payload ->> 'sourceStreamSequence' ~ '^[1-9][0-9]*$' then
    resolved_source_stream_id := (new.payload ->> 'sourceStreamId')::uuid;
    resolved_source_sequence := (new.payload ->> 'sourceStreamSequence')::bigint;
  else
    raise exception using
      errcode = '23514',
      message = 'PULSO message outbox requires an owner-resolved Channel source position';
  end if;

  if resolved_source_stream_id <> (new.payload ->> 'threadBindingId')::uuid
     or resolved_source_sequence <= 0 then
    raise exception using errcode = '23514', message = 'PULSO message source position conflicts with its thread binding';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || resolved_stream_id::text, 0)
  );

  if exists (
    select 1
      from pulso_iris.outbox_event_positions position
     where position.tenant_id = new.tenant_id
       and position.source_stream_id = resolved_source_stream_id
       and position.source_stream_sequence = resolved_source_sequence
  ) then
    raise exception using errcode = '23505', message = 'PULSO source position is already mapped';
  end if;

  select position.last_sequence
    into current_sequence
    from pulso_iris.outbox_stream_positions position
   where position.tenant_id = new.tenant_id
     and position.stream_id = resolved_stream_id
   for update;
  if not found then
    select count(*)::bigint
      into current_sequence
      from pulso_iris.outbox_events candidate
     where candidate.tenant_id = new.tenant_id
       and candidate.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
       and case
             when candidate.stream_id is not null then candidate.stream_id
             when candidate.payload ->> 'conversationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               then (candidate.payload ->> 'conversationId')::uuid
           end = resolved_stream_id;
  end if;
  allocated_sequence := coalesce(current_sequence, 0) + 1;

  insert into pulso_iris.outbox_stream_positions (tenant_id, stream_id, last_sequence)
  values (new.tenant_id, resolved_stream_id, allocated_sequence)
  on conflict (tenant_id, stream_id) do update
  set last_sequence = excluded.last_sequence,
      updated_at = now();

  new.stream_id := resolved_stream_id;
  new.stream_sequence := allocated_sequence;
  new.source_stream_id := resolved_source_stream_id;
  new.source_stream_sequence := resolved_source_sequence;
  if new.event_type = 'pulso.message.received.v1' then
    new.payload := new.payload - 'sourceStreamId' - 'sourceStreamSequence';
  end if;

  insert into pulso_iris.outbox_event_positions (
    tenant_id, event_id, stream_id, stream_sequence,
    source_stream_id, source_stream_sequence
  ) values (
    new.tenant_id, new.id, new.stream_id, new.stream_sequence,
    new.source_stream_id, new.source_stream_sequence
  );

  if exists (
    select 1
      from pulso_iris.outbox_events predecessor
     where predecessor.tenant_id = new.tenant_id
       and case
             when predecessor.stream_id is not null then predecessor.stream_id
             when predecessor.payload ->> 'conversationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               then (predecessor.payload ->> 'conversationId')::uuid
           end = new.stream_id
       and predecessor.status <> 'published'
  ) then
    new.next_attempt_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$_$;


--
-- Name: record_appointment_status_transition(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.record_appointment_status_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    insert into pulso_iris.appointment_status_history (
      tenant_id,
      appointment_id,
      from_status,
      to_status,
      actor_id,
      reason,
      created_at
    ) values (
      new.tenant_id,
      new.id,
      case when tg_op = 'INSERT' then null else old.status end,
      new.status,
      case
        when new.metadata ->> 'status_actor' is not null then new.metadata ->> 'status_actor'
        when new.status in ('verified', 'confirmed') then new.verified_by
        when new.status = 'external_rejected' then new.external_rejected_by
        when new.status in ('cancelled', 'rescheduled') then new.cancelled_by
        else new.metadata ->> 'created_by'
      end,
      case
        when new.status = 'external_rejected' then new.external_rejection_reason
        when new.status in ('cancelled', 'rescheduled') then new.cancellation_reason
        else null
      end,
      clock_timestamp()
    );
  end if;
  return new;
end;
$$;


--
-- Name: reject_unpositioned_message_claim(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.reject_unpositioned_message_claim() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pulso_iris'
    AS $$
begin
  if new.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
     and new.status = 'processing'
     and old.status <> 'processing'
     and (new.stream_id is null or new.stream_sequence is null
          or new.source_stream_id is null or new.source_stream_sequence is null) then
    raise exception using errcode = '55000', message = 'PULSO outbox backfill is incomplete';
  end if;
  return new;
end;
$$;


--
-- Name: release_next_message_outbox_event(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.release_next_message_outbox_event() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pulso_iris'
    AS $$
begin
  if new.status = 'published'
     and old.status <> 'published'
     and new.stream_id is not null
     and new.stream_sequence is not null then
    update pulso_iris.outbox_events successor
       set next_attempt_at = now(), updated_at = now()
     where successor.tenant_id = new.tenant_id
       and successor.stream_id = new.stream_id
       and successor.stream_sequence = new.stream_sequence + 1
       and successor.status in ('queued', 'retry_scheduled')
       and successor.next_attempt_at = 'infinity'::timestamptz
       and not exists (
         select 1
           from pulso_iris.outbox_events predecessor
          where predecessor.tenant_id = successor.tenant_id
            and predecessor.stream_id = successor.stream_id
            and predecessor.stream_sequence < successor.stream_sequence
            and predecessor.status <> 'published'
       );
  end if;
  return new;
end;
$$;


--
-- Name: resolve_legacy_channel_inbox_position(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.resolve_legacy_channel_inbox_position() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  producer_position record;
begin
  if new.source_service <> 'whatsapp-channel-service'
     or new.event_type <> 'channel.inbound.received.v1' then
    return new;
  end if;

  select position.stream_id, position.stream_sequence
    into producer_position
    from channel_runtime.outbox_events event
    join channel_runtime.outbox_event_positions position
      on position.tenant_id = event.tenant_id
     and position.event_id = event.aggregate_id
   where event.tenant_id = new.tenant_id
     and event.id = new.event_id
     and event.event_type = 'channel.inbound.received.v1'
     and event.event_version = 1
     and event.aggregate_type = 'channel_inbound_event'
     and event.stream_id = position.stream_id
     and event.stream_sequence = position.stream_sequence;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Legacy Channel event has no owner-ledger position';
  end if;

  if new.stream_id is not null or new.stream_sequence is not null then
    if new.stream_id is null or new.stream_sequence is null
       or new.stream_id <> producer_position.stream_id
       or new.stream_sequence <> producer_position.stream_sequence then
      raise exception using
        errcode = '23514',
        message = 'Legacy Channel inbox position conflicts with the owner ledger';
    end if;
  end if;

  new.stream_id := producer_position.stream_id;
  new.stream_sequence := producer_position.stream_sequence;
  return new;
end;
$$;


--
-- Name: FUNCTION resolve_legacy_channel_inbox_position(); Type: COMMENT; Schema: pulso_iris; Owner: -
--

COMMENT ON FUNCTION pulso_iris.resolve_legacy_channel_inbox_position() IS 'N-1 rollback adapter: resolves a v1 Channel inbox position from the exact Channel owner ledger row.';


--
-- Name: touch_appointment_status_updated_at(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.touch_appointment_status_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    new.status_updated_at := now();
  end if;
  return new;
end;
$$;


--
-- Name: validate_availability_rule(); Type: FUNCTION; Schema: pulso_iris; Owner: -
--

CREATE FUNCTION pulso_iris.validate_availability_rule() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  appointment_duration integer;
begin
  select duration_min into appointment_duration
  from pulso_iris.appointment_types
  where tenant_id = new.tenant_id and id = new.appointment_type_id;

  if appointment_duration is null then
    raise exception using errcode = '23503', message = 'appointment type does not belong to tenant';
  end if;

  if new.slot_duration_min < appointment_duration then
    raise exception using errcode = '23514', message = 'slot duration cannot be shorter than appointment duration';
  end if;

  if not exists (
    select 1 from pulso_iris.professional_sites
    where tenant_id = new.tenant_id
      and professional_id = new.professional_id
      and site_id = new.site_id
      and status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'professional is not active at site';
  end if;

  if not exists (
    select 1 from pulso_iris.professional_appointment_types
    where tenant_id = new.tenant_id
      and professional_id = new.professional_id
      and appointment_type_id = new.appointment_type_id
      and status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'professional is not authorized for appointment type';
  end if;

  return new;
end;
$$;


--
-- Name: executions; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    agent_code text DEFAULT 'SOFIA'::text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    status text NOT NULL,
    attempt_number integer DEFAULT 1 NOT NULL,
    latency_ms integer,
    input_tokens integer,
    output_tokens integer,
    tool_names jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT executions_agent_code_check CHECK ((agent_code = 'SOFIA'::text)),
    CONSTRAINT executions_attempt_number_check CHECK ((attempt_number >= 1)),
    CONSTRAINT executions_input_tokens_check CHECK (((input_tokens IS NULL) OR (input_tokens >= 0))),
    CONSTRAINT executions_latency_ms_check CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT executions_output_tokens_check CHECK (((output_tokens IS NULL) OR (output_tokens >= 0))),
    CONSTRAINT executions_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'fallback'::text]))),
    CONSTRAINT executions_tool_names_check CHECK ((jsonb_typeof(tool_names) = 'array'::text))
);


--
-- Name: inbox_events; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.inbox_events (
    event_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    source_service text NOT NULL,
    event_type text NOT NULL,
    event_version integer NOT NULL,
    payload_hash text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    processed_at timestamp with time zone,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    stream_id uuid,
    stream_sequence bigint,
    source_stream_id uuid,
    source_stream_sequence bigint,
    CONSTRAINT ck_agent_pulso_inbox_contract_version CHECK (((source_service <> ALL (ARRAY['pulso-core'::text, 'pulso-iris-service'::text])) OR (event_type <> ALL (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text])) OR ((event_type = 'pulso.message.received.v1'::text) AND (event_version = 1)) OR ((event_type = 'pulso.message.received.v2'::text) AND (event_version = 2)))),
    CONSTRAINT ck_agent_pulso_inbox_stream_position CHECK (((source_service <> ALL (ARRAY['pulso-core'::text, 'pulso-iris-service'::text])) OR (event_type <> ALL (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text])) OR ((stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL) AND (stream_sequence > 0) AND (source_stream_id IS NOT NULL) AND (source_stream_sequence IS NOT NULL) AND (source_stream_sequence > 0)))),
    CONSTRAINT inbox_events_event_type_check CHECK (((char_length(event_type) >= 3) AND (char_length(event_type) <= 160))),
    CONSTRAINT inbox_events_event_version_check CHECK (((event_version >= 1) AND (event_version <= 1000))),
    CONSTRAINT inbox_events_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT inbox_events_result_check CHECK ((jsonb_typeof(result) = 'object'::text)),
    CONSTRAINT inbox_events_source_service_check CHECK (((char_length(source_service) >= 1) AND (char_length(source_service) <= 80)))
);


--
-- Name: job_stream_positions; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.job_stream_positions (
    tenant_id uuid NOT NULL,
    stream_id uuid NOT NULL,
    last_sequence bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_stream_positions_last_sequence_check CHECK ((last_sequence >= 0))
);


--
-- Name: outbox_events; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    event_type text NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
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
    CONSTRAINT outbox_events_aggregate_type_check CHECK (((char_length(aggregate_type) >= 1) AND (char_length(aggregate_type) <= 80))),
    CONSTRAINT outbox_events_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT outbox_events_event_type_check CHECK (((char_length(event_type) >= 3) AND (char_length(event_type) <= 160))),
    CONSTRAINT outbox_events_event_version_check CHECK (((event_version >= 1) AND (event_version <= 1000))),
    CONSTRAINT outbox_events_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 100))),
    CONSTRAINT outbox_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT outbox_events_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text, 'published'::text, 'dead_letter'::text])))
);


--
-- Name: pulso_stream_positions; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.pulso_stream_positions (
    tenant_id uuid NOT NULL,
    stream_id uuid NOT NULL,
    last_sequence bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pulso_stream_positions_last_sequence_check CHECK ((last_sequence >= 0))
);


--
-- Name: connections; Type: TABLE; Schema: channel_runtime; Owner: -
--

CREATE TABLE channel_runtime.connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    provider_mode text DEFAULT 'whatsapp_web_test'::text NOT NULL,
    state text DEFAULT 'disconnected'::text NOT NULL,
    phone_masked text,
    session_restorable boolean DEFAULT false NOT NULL,
    qr_expires_at timestamp with time zone,
    last_activity_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    connected_at timestamp with time zone,
    disconnected_at timestamp with time zone,
    reconnect_attempts integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connections_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT connections_provider_mode_check CHECK ((provider_mode = 'whatsapp_web_test'::text)),
    CONSTRAINT connections_reconnect_attempts_check CHECK ((reconnect_attempts >= 0)),
    CONSTRAINT connections_state_check CHECK ((state = ANY (ARRAY['disconnected'::text, 'qr_pending'::text, 'connecting'::text, 'ready'::text, 'degraded'::text])))
);


--
-- Name: delivery_receipts; Type: TABLE; Schema: channel_runtime; Owner: -
--

CREATE TABLE channel_runtime.delivery_receipts (
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    provider_message_id text NOT NULL,
    status text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT delivery_receipts_provider_check CHECK ((provider = 'whatsapp_web_test'::text)),
    CONSTRAINT delivery_receipts_provider_message_id_check CHECK (((char_length(provider_message_id) >= 1) AND (char_length(provider_message_id) <= 512))),
    CONSTRAINT delivery_receipts_status_check CHECK ((status = ANY (ARRAY['delivered'::text, 'read'::text, 'failed'::text])))
);


--
-- Name: outbox_event_positions; Type: TABLE; Schema: channel_runtime; Owner: -
--

CREATE TABLE channel_runtime.outbox_event_positions (
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    stream_id uuid NOT NULL,
    stream_sequence bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_event_positions_stream_sequence_check CHECK ((stream_sequence > 0))
);


--
-- Name: outbox_events; Type: TABLE; Schema: channel_runtime; Owner: -
--

CREATE TABLE channel_runtime.outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    event_type text NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
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
    stream_id uuid,
    stream_sequence bigint,
    dedupe_key text,
    CONSTRAINT ck_channel_outbox_dedupe_key CHECK (((dedupe_key IS NULL) OR ((length(btrim(dedupe_key)) >= 3) AND (length(btrim(dedupe_key)) <= 240)))),
    CONSTRAINT ck_channel_outbox_ordered_stream_position CHECK (((event_type <> ALL (ARRAY['channel.inbound.received.v1'::text, 'channel.inbound.received.v2'::text])) OR ((stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL) AND (stream_sequence > 0)))),
    CONSTRAINT outbox_events_aggregate_type_check CHECK (((char_length(aggregate_type) >= 1) AND (char_length(aggregate_type) <= 80))),
    CONSTRAINT outbox_events_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT outbox_events_event_type_check CHECK (((char_length(event_type) >= 3) AND (char_length(event_type) <= 160))),
    CONSTRAINT outbox_events_event_version_check CHECK (((event_version >= 1) AND (event_version <= 1000))),
    CONSTRAINT outbox_events_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 100))),
    CONSTRAINT outbox_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT outbox_events_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text, 'published'::text, 'dead_letter'::text])))
);


--
-- Name: COLUMN outbox_events.stream_id; Type: COMMENT; Schema: channel_runtime; Owner: -
--

COMMENT ON COLUMN channel_runtime.outbox_events.stream_id IS 'Ordered aggregate identifier carried in the durable event envelope';


--
-- Name: COLUMN outbox_events.stream_sequence; Type: COMMENT; Schema: channel_runtime; Owner: -
--

COMMENT ON COLUMN channel_runtime.outbox_events.stream_sequence IS 'One-based monotonic position within tenant_id + stream_id';


--
-- Name: outbox_stream_positions; Type: TABLE; Schema: channel_runtime; Owner: -
--

CREATE TABLE channel_runtime.outbox_stream_positions (
    tenant_id uuid NOT NULL,
    stream_id uuid NOT NULL,
    last_sequence bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_stream_positions_last_sequence_check CHECK ((last_sequence > 0))
);


--
-- Name: thread_bindings; Type: TABLE; Schema: channel_runtime; Owner: -
--

CREATE TABLE channel_runtime.thread_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider text NOT NULL,
    external_thread_id text NOT NULL,
    phone_e164_hash text NOT NULL,
    phone_masked text NOT NULL,
    patient_id uuid,
    conversation_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    last_inbound_at timestamp with time zone,
    last_outbound_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_bindings_phone_e164_hash_check CHECK ((length(phone_e164_hash) = 64)),
    CONSTRAINT thread_bindings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text, 'blocked'::text])))
);


--
-- Name: agents; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    product_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    channel text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    runtime_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'retired'::text])))
);


--
-- Name: integrations; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    provider text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integrations_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'failed'::text, 'archived'::text])))
);


--
-- Name: knowledge_sources; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.knowledge_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    name text NOT NULL,
    source_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    checksum text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_sources_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'indexing'::text, 'ready'::text, 'failed'::text, 'archived'::text])))
);


--
-- Name: products; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    owner_service text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT products_status_check CHECK ((status = ANY (ARRAY['foundation'::text, 'building'::text, 'active'::text, 'paused'::text])))
);


--
-- Name: prompt_flows; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.prompt_flows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    agent_id uuid,
    name text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    definition jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prompt_flows_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'archived'::text])))
);


--
-- Name: tenants; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text])))
);


--
-- Name: administrative_patients; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.administrative_patients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    document_type text,
    document_number_hash text,
    document_number_masked text,
    full_name text,
    preferred_channel text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    phone text,
    phone_e164_hash text,
    phone_masked text,
    CONSTRAINT administrative_patients_phone_e164_hash_check CHECK (((phone_e164_hash IS NULL) OR (length(phone_e164_hash) = 64))),
    CONSTRAINT administrative_patients_preferred_channel_check CHECK ((preferred_channel = ANY (ARRAY['voice'::text, 'whatsapp'::text]))),
    CONSTRAINT administrative_patients_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive_12m'::text, 'waiting_list'::text, 'high_noshow_risk'::text, 'partial_optout'::text, 'total_optout'::text, 'data_cleanup'::text])))
);


--
-- Name: agenda_blocks; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.agenda_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    site_id uuid,
    professional_id uuid,
    appointment_type_id uuid,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    block_type text DEFAULT 'block'::text NOT NULL,
    CONSTRAINT agenda_blocks_block_type_check CHECK ((block_type = ANY (ARRAY['block'::text, 'absence'::text, 'vacation'::text]))),
    CONSTRAINT agenda_blocks_check CHECK ((starts_at < ends_at)),
    CONSTRAINT agenda_blocks_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text])))
);


--
-- Name: agenda_settings; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.agenda_settings (
    tenant_id uuid NOT NULL,
    mode text DEFAULT 'hybrid_manual'::text NOT NULL,
    timezone text DEFAULT 'America/Bogota'::text NOT NULL,
    booking_horizon_days integer DEFAULT 90 NOT NULL,
    hold_duration_minutes integer DEFAULT 10 NOT NULL,
    max_alternatives integer DEFAULT 3 NOT NULL,
    max_reschedules integer DEFAULT 3 NOT NULL,
    external_confirmation_sla_minutes integer DEFAULT 240 NOT NULL,
    external_reference_required boolean DEFAULT true NOT NULL,
    capacity_policy text DEFAULT 'strict'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agenda_settings_booking_horizon_days_check CHECK (((booking_horizon_days >= 1) AND (booking_horizon_days <= 730))),
    CONSTRAINT agenda_settings_capacity_policy_check CHECK ((capacity_policy = 'strict'::text)),
    CONSTRAINT agenda_settings_check CHECK (((mode <> 'hybrid_manual'::text) OR external_reference_required)),
    CONSTRAINT agenda_settings_check1 CHECK (((mode <> 'legacy_integrated'::text) OR (status = 'paused'::text))),
    CONSTRAINT agenda_settings_external_confirmation_sla_minutes_check CHECK (((external_confirmation_sla_minutes >= 1) AND (external_confirmation_sla_minutes <= 10080))),
    CONSTRAINT agenda_settings_hold_duration_minutes_check CHECK (((hold_duration_minutes >= 1) AND (hold_duration_minutes <= 1440))),
    CONSTRAINT agenda_settings_max_alternatives_check CHECK (((max_alternatives >= 1) AND (max_alternatives <= 20))),
    CONSTRAINT agenda_settings_max_reschedules_check CHECK (((max_reschedules >= 0) AND (max_reschedules <= 20))),
    CONSTRAINT agenda_settings_mode_check CHECK ((mode = ANY (ARRAY['internal'::text, 'hybrid_manual'::text, 'legacy_integrated'::text]))),
    CONSTRAINT agenda_settings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text]))),
    CONSTRAINT agenda_settings_timezone_check CHECK ((length(TRIM(BOTH FROM timezone)) > 0))
);


--
-- Name: appointment_holds; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.appointment_holds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid,
    conversation_id uuid,
    site_id uuid NOT NULL,
    professional_id uuid NOT NULL,
    payer_id uuid,
    appointment_type_id uuid NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    duration_min integer NOT NULL,
    slot_capacity_token integer NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    idempotency_key text NOT NULL,
    appointment_id uuid,
    created_by text,
    consumed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appointment_holds_check CHECK ((expires_at > created_at)),
    CONSTRAINT appointment_holds_check1 CHECK (((status <> 'consumed'::text) OR ((appointment_id IS NOT NULL) AND (consumed_at IS NOT NULL)))),
    CONSTRAINT appointment_holds_duration_min_check CHECK ((duration_min > 0)),
    CONSTRAINT appointment_holds_idempotency_key_check CHECK ((length(TRIM(BOTH FROM idempotency_key)) >= 4)),
    CONSTRAINT appointment_holds_slot_capacity_token_check CHECK ((slot_capacity_token > 0)),
    CONSTRAINT appointment_holds_status_check CHECK ((status = ANY (ARRAY['active'::text, 'consumed'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: appointment_status_history; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.appointment_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    appointment_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    actor_id text,
    reason text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: appointment_types; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.appointment_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    duration_min integer DEFAULT 20 NOT NULL,
    preparation_text text,
    bookable_by_ia boolean DEFAULT true NOT NULL,
    slot_priority integer DEFAULT 50 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appointment_types_category_check CHECK ((category = ANY (ARRAY['consulta'::text, 'ayuda_dx'::text, 'valoracion_qx'::text, 'control_post'::text]))),
    CONSTRAINT appointment_types_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: appointments; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.appointments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid,
    conversation_id uuid,
    site_id uuid,
    professional_id uuid,
    payer_id uuid,
    appointment_type text,
    status text DEFAULT 'offered'::text NOT NULL,
    scheduled_at timestamp with time zone,
    legacy_reference text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    appointment_type_id uuid,
    origin text DEFAULT 'sofia_wa'::text NOT NULL,
    slot_capacity_token integer,
    duration_min integer,
    idempotency_key text,
    hold_id uuid,
    verification_mode text,
    external_system text,
    external_reference text,
    external_note text,
    verified_at timestamp with time zone,
    verified_by text,
    external_sla_due_at timestamp with time zone,
    reschedule_count integer DEFAULT 0 NOT NULL,
    previous_appointment_id uuid,
    cancellation_reason text,
    cancelled_at timestamp with time zone,
    cancelled_by text,
    external_rejection_reason text,
    external_rejected_at timestamp with time zone,
    external_rejected_by text,
    status_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appointments_duration_min_check CHECK (((duration_min IS NULL) OR (duration_min > 0))),
    CONSTRAINT appointments_reschedule_count_check CHECK ((reschedule_count >= 0)),
    CONSTRAINT appointments_slot_capacity_token_check CHECK (((slot_capacity_token IS NULL) OR (slot_capacity_token > 0))),
    CONSTRAINT appointments_status_check CHECK ((status = ANY (ARRAY['offered'::text, 'registered'::text, 'pending_provider'::text, 'submitted'::text, 'pending_external_confirmation'::text, 'verified'::text, 'confirmed'::text, 'deferred'::text, 'verification_failed'::text, 'failed'::text, 'external_rejected'::text, 'expired'::text, 'rescheduled'::text, 'cancelled'::text, 'no_show'::text]))),
    CONSTRAINT appointments_verification_mode_check CHECK (((verification_mode IS NULL) OR (verification_mode = ANY (ARRAY['internal'::text, 'manual_external'::text, 'legacy_provider'::text, 'simulated'::text]))))
);


--
-- Name: availability_rules; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.availability_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    site_id uuid NOT NULL,
    professional_id uuid NOT NULL,
    appointment_type_id uuid NOT NULL,
    weekday smallint NOT NULL,
    starts_at time without time zone NOT NULL,
    ends_at time without time zone NOT NULL,
    slot_duration_min integer DEFAULT 20 NOT NULL,
    capacity integer DEFAULT 1 NOT NULL,
    timezone text DEFAULT 'America/Bogota'::text NOT NULL,
    effective_from date,
    effective_to date,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT availability_rules_capacity_check CHECK ((capacity > 0)),
    CONSTRAINT availability_rules_check CHECK ((starts_at < ends_at)),
    CONSTRAINT availability_rules_check1 CHECK (((effective_to IS NULL) OR (effective_from IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT availability_rules_slot_duration_min_check CHECK ((slot_duration_min > 0)),
    CONSTRAINT availability_rules_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text]))),
    CONSTRAINT availability_rules_weekday_check CHECK (((weekday >= 0) AND (weekday <= 6)))
);


--
-- Name: campaign_contacts; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.campaign_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts jsonb DEFAULT '[]'::jsonb NOT NULL,
    result text,
    appointment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_contacts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'contacted'::text, 'interested'::text, 'not_interested'::text, 'no_answer'::text, 'appointment'::text])))
);


--
-- Name: campaigns; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    campaign_type text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    channels jsonb DEFAULT '[]'::jsonb NOT NULL,
    segment jsonb DEFAULT '{}'::jsonb NOT NULL,
    cadence jsonb DEFAULT '{}'::jsonb NOT NULL,
    budget_cop numeric,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaigns_campaign_type_check CHECK ((campaign_type = ANY (ARRAY['reminder'::text, 'reactivation'::text, 'confirmation'::text, 'survey'::text, 'reschedule'::text]))),
    CONSTRAINT campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'finished'::text])))
);


--
-- Name: channel_threads; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.channel_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    external_thread_id text NOT NULL,
    phone_e164_hash text NOT NULL,
    phone_masked text NOT NULL,
    patient_id uuid,
    conversation_id uuid,
    last_inbound_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_inbound_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT channel_threads_external_thread_id_check CHECK (((char_length(external_thread_id) >= 1) AND (char_length(external_thread_id) <= 512))),
    CONSTRAINT channel_threads_phone_e164_hash_check CHECK ((phone_e164_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT channel_threads_phone_masked_check CHECK (((char_length(phone_masked) >= 3) AND (char_length(phone_masked) <= 32))),
    CONSTRAINT channel_threads_provider_check CHECK ((provider = 'whatsapp_web_test'::text)),
    CONSTRAINT ck_pulso_channel_thread_last_inbound_sequence CHECK ((last_inbound_sequence >= 0))
);


--
-- Name: COLUMN channel_threads.last_inbound_sequence; Type: COMMENT; Schema: pulso_iris; Owner: -
--

COMMENT ON COLUMN pulso_iris.channel_threads.last_inbound_sequence IS 'Last contiguous Channel stream position committed by PULSO';


--
-- Name: configuration_imports; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.configuration_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    idempotency_key text NOT NULL,
    content_hash text NOT NULL,
    status text DEFAULT 'previewed'::text NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    accepted_count integer DEFAULT 0 NOT NULL,
    rejected_count integer DEFAULT 0 NOT NULL,
    preview jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT configuration_imports_accepted_count_check CHECK ((accepted_count >= 0)),
    CONSTRAINT configuration_imports_check CHECK (((accepted_count + rejected_count) <= row_count)),
    CONSTRAINT configuration_imports_check1 CHECK (((status <> 'applied'::text) OR (applied_at IS NOT NULL))),
    CONSTRAINT configuration_imports_content_hash_check CHECK ((length(content_hash) >= 32)),
    CONSTRAINT configuration_imports_idempotency_key_check CHECK ((length(TRIM(BOTH FROM idempotency_key)) >= 8)),
    CONSTRAINT configuration_imports_kind_check CHECK ((kind = ANY (ARRAY['professionals'::text, 'professional_sites'::text, 'professional_appointment_types'::text, 'availability_rules'::text, 'payer_exclusions'::text, 'agenda_blocks'::text]))),
    CONSTRAINT configuration_imports_rejected_count_check CHECK ((rejected_count >= 0)),
    CONSTRAINT configuration_imports_row_count_check CHECK ((row_count >= 0)),
    CONSTRAINT configuration_imports_status_check CHECK ((status = ANY (ARRAY['previewed'::text, 'applying'::text, 'applied'::text, 'failed'::text])))
);


--
-- Name: conversations; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid,
    channel text NOT NULL,
    direction text DEFAULT 'inbound'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    primary_intent text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    site_id uuid,
    CONSTRAINT conversations_channel_check CHECK ((channel = ANY (ARRAY['voice'::text, 'whatsapp'::text]))),
    CONSTRAINT conversations_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
    CONSTRAINT conversations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resolved'::text, 'handoff_required'::text, 'closed'::text])))
);


--
-- Name: handoffs; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.handoffs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid,
    conversation_id uuid,
    trigger_code text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    summary text,
    sla_due_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT handoffs_priority_check CHECK ((priority = ANY (ARRAY['max'::text, 'high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT handoffs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'assigned'::text, 'in_progress'::text, 'resolved'::text, 'returned_to_sofia'::text])))
);


--
-- Name: holidays; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.holidays (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    holiday_date date NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT holidays_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: inbox_events; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.inbox_events (
    event_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    source_service text NOT NULL,
    event_type text NOT NULL,
    event_version integer NOT NULL,
    payload_hash text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    processed_at timestamp with time zone,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    stream_id uuid,
    stream_sequence bigint,
    CONSTRAINT ck_pulso_channel_delivery_inbox_stream_position CHECK (((source_service <> 'whatsapp-channel-service'::text) OR (event_type <> 'channel.delivery.updated.v1'::text) OR ((stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL) AND (stream_sequence > 0)))),
    CONSTRAINT ck_pulso_channel_inbox_contract_version CHECK (((source_service <> 'whatsapp-channel-service'::text) OR (event_type <> ALL (ARRAY['channel.inbound.received.v1'::text, 'channel.inbound.received.v2'::text])) OR ((event_type = 'channel.inbound.received.v1'::text) AND (event_version = 1)) OR ((event_type = 'channel.inbound.received.v2'::text) AND (event_version = 2)))),
    CONSTRAINT inbox_events_event_type_check CHECK (((char_length(event_type) >= 3) AND (char_length(event_type) <= 160))),
    CONSTRAINT inbox_events_event_version_check CHECK (((event_version >= 1) AND (event_version <= 1000))),
    CONSTRAINT inbox_events_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT inbox_events_result_check CHECK ((jsonb_typeof(result) = 'object'::text)),
    CONSTRAINT inbox_events_source_service_check CHECK (((char_length(source_service) >= 1) AND (char_length(source_service) <= 80)))
);


--
-- Name: messages; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender text NOT NULL,
    body text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL,
    provider text,
    external_message_id text,
    provider_message_id text,
    delivery_status text,
    delivered_at timestamp with time zone,
    CONSTRAINT ck_pulso_iris_messages_delivery_status CHECK (((delivery_status IS NULL) OR (delivery_status = ANY (ARRAY['received'::text, 'queued'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text, 'ignored'::text])))),
    CONSTRAINT messages_sender_check CHECK ((sender = ANY (ARRAY['sofia'::text, 'patient'::text, 'advisor'::text, 'system'::text])))
);


--
-- Name: operational_kpi_snapshots; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.operational_kpi_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbox_event_positions; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.outbox_event_positions (
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    stream_id uuid NOT NULL,
    stream_sequence bigint NOT NULL,
    source_stream_id uuid NOT NULL,
    source_stream_sequence bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_event_positions_source_stream_sequence_check CHECK ((source_stream_sequence > 0)),
    CONSTRAINT outbox_event_positions_stream_sequence_check CHECK ((stream_sequence > 0))
);


--
-- Name: outbox_events; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    event_type text NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
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
    stream_id uuid,
    stream_sequence bigint,
    source_stream_id uuid,
    source_stream_sequence bigint,
    dedupe_key text,
    CONSTRAINT ck_pulso_message_outbox_contract_version CHECK (((event_type <> ALL (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text])) OR ((event_type = 'pulso.message.received.v1'::text) AND (event_version = 1)) OR ((event_type = 'pulso.message.received.v2'::text) AND (event_version = 2)))),
    CONSTRAINT ck_pulso_outbox_dedupe_key CHECK (((dedupe_key IS NULL) OR ((length(btrim(dedupe_key)) >= 3) AND (length(btrim(dedupe_key)) <= 240)))),
    CONSTRAINT ck_pulso_outbox_message_stream_position CHECK (((event_type <> ALL (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text])) OR ((stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL) AND (stream_sequence > 0) AND (source_stream_id IS NOT NULL) AND (source_stream_sequence IS NOT NULL) AND (source_stream_sequence > 0)))),
    CONSTRAINT outbox_events_aggregate_type_check CHECK (((char_length(aggregate_type) >= 1) AND (char_length(aggregate_type) <= 80))),
    CONSTRAINT outbox_events_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT outbox_events_event_type_check CHECK (((char_length(event_type) >= 3) AND (char_length(event_type) <= 160))),
    CONSTRAINT outbox_events_event_version_check CHECK (((event_version >= 1) AND (event_version <= 1000))),
    CONSTRAINT outbox_events_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 100))),
    CONSTRAINT outbox_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT outbox_events_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text, 'published'::text, 'dead_letter'::text])))
);


--
-- Name: COLUMN outbox_events.stream_id; Type: COMMENT; Schema: pulso_iris; Owner: -
--

COMMENT ON COLUMN pulso_iris.outbox_events.stream_id IS 'PULSO conversation UUID emitted as the ordered v2 streamId';


--
-- Name: COLUMN outbox_events.stream_sequence; Type: COMMENT; Schema: pulso_iris; Owner: -
--

COMMENT ON COLUMN pulso_iris.outbox_events.stream_sequence IS 'One-based position derived while consuming the ordered Channel source';


--
-- Name: outbox_stream_positions; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.outbox_stream_positions (
    tenant_id uuid NOT NULL,
    stream_id uuid NOT NULL,
    last_sequence bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_stream_positions_last_sequence_check CHECK ((last_sequence >= 0))
);


--
-- Name: payers; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.payers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    payer_group text NOT NULL,
    requires_authorization boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payers_payer_group_check CHECK ((payer_group = ANY (ARRAY['eps'::text, 'private_prepaid'::text, 'policy'::text, 'particular'::text, 'other'::text]))),
    CONSTRAINT payers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: professional_appointment_types; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.professional_appointment_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    professional_id uuid NOT NULL,
    appointment_type_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT professional_appointment_types_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: professional_payer_exclusions; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.professional_payer_exclusions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    professional_id uuid NOT NULL,
    payer_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT professional_payer_exclusions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: professional_sites; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.professional_sites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    professional_id uuid NOT NULL,
    site_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT professional_sites_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: professionals; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.professionals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    professional_type text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    subspecialty text,
    is_pilot boolean DEFAULT false NOT NULL,
    CONSTRAINT professionals_professional_type_check CHECK ((professional_type = ANY (ARRAY['ophthalmologist'::text, 'optometrist'::text]))),
    CONSTRAINT professionals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: rpa_actions; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.rpa_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    appointment_id uuid,
    conversation_id uuid,
    action_type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    priority integer DEFAULT 50 NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    worker_id uuid,
    phase text,
    duration_ms integer,
    executed_at timestamp with time zone,
    CONSTRAINT rpa_actions_action_type_check CHECK ((action_type = ANY (ARRAY['check_availability'::text, 'register_appointment'::text, 'cancel'::text, 'reschedule'::text, 'confirm'::text, 'sweep'::text, 'create_patient'::text]))),
    CONSTRAINT rpa_actions_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'verification_failed'::text, 'deferred'::text, 'failed'::text])))
);


--
-- Name: rpa_events; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.rpa_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    worker_id uuid,
    level text DEFAULT 'info'::text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rpa_events_level_check CHECK ((level = ANY (ARRAY['info'::text, 'warn'::text, 'error'::text])))
);


--
-- Name: rpa_workers; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.rpa_workers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    vps_host text,
    status text DEFAULT 'active'::text NOT NULL,
    session_started_at timestamp with time zone,
    last_keepalive_at timestamp with time zone,
    current_action text,
    cpu_pct integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rpa_workers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'standby'::text, 'quarantine'::text, 'maintenance'::text, 'inactive'::text])))
);


--
-- Name: sites; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.sites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    city text,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    address text,
    phone text,
    CONSTRAINT sites_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: waitlist; Type: TABLE; Schema: pulso_iris; Owner: -
--

CREATE TABLE pulso_iris.waitlist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid,
    appointment_type_id uuid,
    sites jsonb DEFAULT '[]'::jsonb NOT NULL,
    time_slots jsonb DEFAULT '[]'::jsonb NOT NULL,
    clinical_priority integer DEFAULT 50 NOT NULL,
    deadline date,
    status text DEFAULT 'active'::text NOT NULL,
    offers jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT waitlist_status_check CHECK ((status = ANY (ARRAY['active'::text, 'offered'::text, 'fulfilled'::text, 'expired'::text])))
);


--
-- Name: executions executions_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.executions
    ADD CONSTRAINT executions_pkey PRIMARY KEY (id);


--
-- Name: executions executions_tenant_id_job_id_attempt_number_key; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.executions
    ADD CONSTRAINT executions_tenant_id_job_id_attempt_number_key UNIQUE (tenant_id, job_id, attempt_number);


--
-- Name: inbox_events inbox_events_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.inbox_events
    ADD CONSTRAINT inbox_events_pkey PRIMARY KEY (event_id);


--
-- Name: job_stream_positions job_stream_positions_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.job_stream_positions
    ADD CONSTRAINT job_stream_positions_pkey PRIMARY KEY (tenant_id, stream_id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.jobs
    ADD CONSTRAINT jobs_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: jobs jobs_tenant_id_inbound_event_id_key; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.jobs
    ADD CONSTRAINT jobs_tenant_id_inbound_event_id_key UNIQUE (tenant_id, inbound_event_id);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: outbox_events outbox_events_tenant_id_event_type_aggregate_id_key; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.outbox_events
    ADD CONSTRAINT outbox_events_tenant_id_event_type_aggregate_id_key UNIQUE (tenant_id, event_type, aggregate_id);


--
-- Name: pulso_stream_positions pulso_stream_positions_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.pulso_stream_positions
    ADD CONSTRAINT pulso_stream_positions_pkey PRIMARY KEY (tenant_id, stream_id);


--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);


--
-- Name: connections connections_tenant_id_key; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.connections
    ADD CONSTRAINT connections_tenant_id_key UNIQUE (tenant_id);


--
-- Name: delivery_receipts delivery_receipts_pkey; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.delivery_receipts
    ADD CONSTRAINT delivery_receipts_pkey PRIMARY KEY (tenant_id, provider, provider_message_id, status);


--
-- Name: inbound_events inbound_events_pkey; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.inbound_events
    ADD CONSTRAINT inbound_events_pkey PRIMARY KEY (id);


--
-- Name: inbound_events inbound_events_tenant_id_provider_external_message_id_key; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.inbound_events
    ADD CONSTRAINT inbound_events_tenant_id_provider_external_message_id_key UNIQUE (tenant_id, provider, external_message_id);


--
-- Name: outbound_messages outbound_messages_pkey; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbound_messages
    ADD CONSTRAINT outbound_messages_pkey PRIMARY KEY (id);


--
-- Name: outbound_messages outbound_messages_tenant_id_provider_idempotency_key_key; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbound_messages
    ADD CONSTRAINT outbound_messages_tenant_id_provider_idempotency_key_key UNIQUE (tenant_id, provider, idempotency_key);


--
-- Name: outbox_event_positions outbox_event_positions_pkey; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbox_event_positions
    ADD CONSTRAINT outbox_event_positions_pkey PRIMARY KEY (tenant_id, event_id);


--
-- Name: outbox_event_positions outbox_event_positions_tenant_id_stream_id_stream_sequence_key; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbox_event_positions
    ADD CONSTRAINT outbox_event_positions_tenant_id_stream_id_stream_sequence_key UNIQUE (tenant_id, stream_id, stream_sequence);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: outbox_events outbox_events_tenant_id_event_type_aggregate_id_key; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbox_events
    ADD CONSTRAINT outbox_events_tenant_id_event_type_aggregate_id_key UNIQUE (tenant_id, event_type, aggregate_id);


--
-- Name: outbox_stream_positions outbox_stream_positions_pkey; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbox_stream_positions
    ADD CONSTRAINT outbox_stream_positions_pkey PRIMARY KEY (tenant_id, stream_id);


--
-- Name: thread_bindings thread_bindings_pkey; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.thread_bindings
    ADD CONSTRAINT thread_bindings_pkey PRIMARY KEY (id);


--
-- Name: thread_bindings thread_bindings_tenant_id_provider_external_thread_id_key; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.thread_bindings
    ADD CONSTRAINT thread_bindings_tenant_id_provider_external_thread_id_key UNIQUE (tenant_id, provider, external_thread_id);


--
-- Name: thread_bindings thread_bindings_tenant_id_provider_phone_e164_hash_key; Type: CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.thread_bindings
    ADD CONSTRAINT thread_bindings_tenant_id_provider_phone_e164_hash_key UNIQUE (tenant_id, provider, phone_e164_hash);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: agents agents_tenant_id_code_key; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.agents
    ADD CONSTRAINT agents_tenant_id_code_key UNIQUE (tenant_id, code);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: knowledge_sources knowledge_sources_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.knowledge_sources
    ADD CONSTRAINT knowledge_sources_pkey PRIMARY KEY (id);


--
-- Name: products products_code_key; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.products
    ADD CONSTRAINT products_code_key UNIQUE (code);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: prompt_flows prompt_flows_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.prompt_flows
    ADD CONSTRAINT prompt_flows_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: administrative_patients administrative_patients_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.administrative_patients
    ADD CONSTRAINT administrative_patients_pkey PRIMARY KEY (id);


--
-- Name: agenda_blocks agenda_blocks_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.agenda_blocks
    ADD CONSTRAINT agenda_blocks_pkey PRIMARY KEY (id);


--
-- Name: agenda_settings agenda_settings_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.agenda_settings
    ADD CONSTRAINT agenda_settings_pkey PRIMARY KEY (tenant_id);


--
-- Name: appointment_holds appointment_holds_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT appointment_holds_pkey PRIMARY KEY (id);


--
-- Name: appointment_status_history appointment_status_history_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_status_history
    ADD CONSTRAINT appointment_status_history_pkey PRIMARY KEY (id);


--
-- Name: appointment_types appointment_types_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_types
    ADD CONSTRAINT appointment_types_pkey PRIMARY KEY (id);


--
-- Name: appointment_types appointment_types_tenant_id_name_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_types
    ADD CONSTRAINT appointment_types_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: appointments appointments_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (id);


--
-- Name: availability_rules availability_rules_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.availability_rules
    ADD CONSTRAINT availability_rules_pkey PRIMARY KEY (id);


--
-- Name: campaign_contacts campaign_contacts_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.campaign_contacts
    ADD CONSTRAINT campaign_contacts_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: channel_threads channel_threads_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.channel_threads
    ADD CONSTRAINT channel_threads_pkey PRIMARY KEY (id);


--
-- Name: channel_threads channel_threads_tenant_id_provider_external_thread_id_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.channel_threads
    ADD CONSTRAINT channel_threads_tenant_id_provider_external_thread_id_key UNIQUE (tenant_id, provider, external_thread_id);


--
-- Name: appointments chk_appointments_manual_verification; Type: CHECK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE pulso_iris.appointments
    ADD CONSTRAINT chk_appointments_manual_verification CHECK (((verification_mode IS DISTINCT FROM 'manual_external'::text) OR ((length(TRIM(BOTH FROM COALESCE(external_reference, ''::text))) > 0) AND (length(TRIM(BOTH FROM COALESCE(external_system, ''::text))) > 0) AND (verified_by IS NOT NULL) AND (verified_at IS NOT NULL)))) NOT VALID;


--
-- Name: appointments chk_appointments_verified_evidence; Type: CHECK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE pulso_iris.appointments
    ADD CONSTRAINT chk_appointments_verified_evidence CHECK (((status <> ALL (ARRAY['verified'::text, 'confirmed'::text])) OR ((verification_mode IS NOT NULL) AND (verified_at IS NOT NULL)))) NOT VALID;


--
-- Name: configuration_imports configuration_imports_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.configuration_imports
    ADD CONSTRAINT configuration_imports_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: availability_rules ex_pulso_iris_availability_rules_overlap; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.availability_rules
    ADD CONSTRAINT ex_pulso_iris_availability_rules_overlap EXCLUDE USING gist (tenant_id WITH =, professional_id WITH =, weekday WITH =, int4range((EXTRACT(epoch FROM starts_at))::integer, (EXTRACT(epoch FROM ends_at))::integer, '[)'::text) WITH &&, daterange(COALESCE(effective_from, '-infinity'::date), COALESCE(effective_to, 'infinity'::date), '[]'::text) WITH &&) WHERE ((status = 'active'::text));


--
-- Name: handoffs handoffs_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.handoffs
    ADD CONSTRAINT handoffs_pkey PRIMARY KEY (id);


--
-- Name: holidays holidays_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.holidays
    ADD CONSTRAINT holidays_pkey PRIMARY KEY (id);


--
-- Name: inbox_events inbox_events_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.inbox_events
    ADD CONSTRAINT inbox_events_pkey PRIMARY KEY (event_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: operational_kpi_snapshots operational_kpi_snapshots_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.operational_kpi_snapshots
    ADD CONSTRAINT operational_kpi_snapshots_pkey PRIMARY KEY (id);


--
-- Name: outbox_event_positions outbox_event_positions_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.outbox_event_positions
    ADD CONSTRAINT outbox_event_positions_pkey PRIMARY KEY (tenant_id, event_id);


--
-- Name: outbox_event_positions outbox_event_positions_tenant_id_source_stream_id_source_st_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.outbox_event_positions
    ADD CONSTRAINT outbox_event_positions_tenant_id_source_stream_id_source_st_key UNIQUE (tenant_id, source_stream_id, source_stream_sequence);


--
-- Name: outbox_event_positions outbox_event_positions_tenant_id_stream_id_stream_sequence_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.outbox_event_positions
    ADD CONSTRAINT outbox_event_positions_tenant_id_stream_id_stream_sequence_key UNIQUE (tenant_id, stream_id, stream_sequence);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: outbox_events outbox_events_tenant_id_event_type_aggregate_id_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.outbox_events
    ADD CONSTRAINT outbox_events_tenant_id_event_type_aggregate_id_key UNIQUE (tenant_id, event_type, aggregate_id);


--
-- Name: outbox_stream_positions outbox_stream_positions_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.outbox_stream_positions
    ADD CONSTRAINT outbox_stream_positions_pkey PRIMARY KEY (tenant_id, stream_id);


--
-- Name: payers payers_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.payers
    ADD CONSTRAINT payers_pkey PRIMARY KEY (id);


--
-- Name: professional_appointment_types professional_appointment_type_tenant_id_professional_id_app_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_appointment_types
    ADD CONSTRAINT professional_appointment_type_tenant_id_professional_id_app_key UNIQUE (tenant_id, professional_id, appointment_type_id);


--
-- Name: professional_appointment_types professional_appointment_types_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_appointment_types
    ADD CONSTRAINT professional_appointment_types_pkey PRIMARY KEY (id);


--
-- Name: professional_payer_exclusions professional_payer_exclusions_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_payer_exclusions
    ADD CONSTRAINT professional_payer_exclusions_pkey PRIMARY KEY (id);


--
-- Name: professional_sites professional_sites_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_sites
    ADD CONSTRAINT professional_sites_pkey PRIMARY KEY (id);


--
-- Name: professional_sites professional_sites_tenant_id_professional_id_site_id_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_sites
    ADD CONSTRAINT professional_sites_tenant_id_professional_id_site_id_key UNIQUE (tenant_id, professional_id, site_id);


--
-- Name: professionals professionals_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professionals
    ADD CONSTRAINT professionals_pkey PRIMARY KEY (id);


--
-- Name: rpa_actions rpa_actions_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_actions
    ADD CONSTRAINT rpa_actions_pkey PRIMARY KEY (id);


--
-- Name: rpa_actions rpa_actions_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_actions
    ADD CONSTRAINT rpa_actions_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: rpa_events rpa_events_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_events
    ADD CONSTRAINT rpa_events_pkey PRIMARY KEY (id);


--
-- Name: rpa_workers rpa_workers_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_workers
    ADD CONSTRAINT rpa_workers_pkey PRIMARY KEY (id);


--
-- Name: rpa_workers rpa_workers_tenant_id_name_key; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_workers
    ADD CONSTRAINT rpa_workers_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


--
-- Name: waitlist waitlist_pkey; Type: CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.waitlist
    ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);


--
-- Name: idx_agent_runtime_executions_job; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_agent_runtime_executions_job ON agent_runtime.executions USING btree (tenant_id, job_id, attempt_number DESC);


--
-- Name: idx_agent_runtime_jobs_claim; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_agent_runtime_jobs_claim ON agent_runtime.jobs USING btree (status, priority DESC, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'retry_scheduled'::text, 'running'::text]));


--
-- Name: ix_agent_inbox_tenant_received; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX ix_agent_inbox_tenant_received ON agent_runtime.inbox_events USING btree (tenant_id, received_at DESC);


--
-- Name: ix_agent_job_stream_head; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX ix_agent_job_stream_head ON agent_runtime.jobs USING btree (tenant_id, stream_id, stream_sequence, status, next_attempt_at);


--
-- Name: ix_agent_outbox_claim; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX ix_agent_outbox_claim ON agent_runtime.outbox_events USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text]));


--
-- Name: uq_agent_job_stream_sequence; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_agent_job_stream_sequence ON agent_runtime.jobs USING btree (tenant_id, stream_id, stream_sequence);


--
-- Name: uq_agent_pulso_inbox_source_sequence; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_agent_pulso_inbox_source_sequence ON agent_runtime.inbox_events USING btree (tenant_id, source_stream_id, source_stream_sequence) WHERE ((source_service = ANY (ARRAY['pulso-core'::text, 'pulso-iris-service'::text])) AND (event_type = ANY (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text])) AND (source_stream_id IS NOT NULL) AND (source_stream_sequence IS NOT NULL));


--
-- Name: uq_agent_pulso_inbox_stream_sequence; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_agent_pulso_inbox_stream_sequence ON agent_runtime.inbox_events USING btree (tenant_id, stream_id, stream_sequence) WHERE ((source_service = ANY (ARRAY['pulso-core'::text, 'pulso-iris-service'::text])) AND (event_type = ANY (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text])) AND (stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL));


--
-- Name: uq_agent_runtime_executions_tenant_id_id; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_agent_runtime_executions_tenant_id_id ON agent_runtime.executions USING btree (tenant_id, id);


--
-- Name: uq_agent_runtime_jobs_tenant_id_id; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_agent_runtime_jobs_tenant_id_id ON agent_runtime.jobs USING btree (tenant_id, id);


--
-- Name: idx_channel_runtime_connections_retry; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE INDEX idx_channel_runtime_connections_retry ON channel_runtime.connections USING btree (state, next_retry_at) WHERE (state = ANY (ARRAY['degraded'::text, 'connecting'::text]));


--
-- Name: idx_channel_runtime_inbound_events_claim; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE INDEX idx_channel_runtime_inbound_events_claim ON channel_runtime.inbound_events USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['received'::text, 'queued'::text, 'retry_scheduled'::text, 'processing'::text]));


--
-- Name: idx_channel_runtime_outbound_messages_claim; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE INDEX idx_channel_runtime_outbound_messages_claim ON channel_runtime.outbound_messages USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'retry_scheduled'::text, 'processing'::text, 'sending'::text]));


--
-- Name: idx_channel_runtime_outbound_messages_lease; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE INDEX idx_channel_runtime_outbound_messages_lease ON channel_runtime.outbound_messages USING btree (status, locked_at) WHERE (status = ANY (ARRAY['processing'::text, 'sending'::text]));


--
-- Name: idx_channel_runtime_thread_bindings_conversation; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE INDEX idx_channel_runtime_thread_bindings_conversation ON channel_runtime.thread_bindings USING btree (tenant_id, conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: ix_channel_outbox_claim; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE INDEX ix_channel_outbox_claim ON channel_runtime.outbox_events USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text]));


--
-- Name: ix_channel_outbox_stream_head; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE INDEX ix_channel_outbox_stream_head ON channel_runtime.outbox_events USING btree (tenant_id, stream_id, stream_sequence, status) WHERE (event_type = ANY (ARRAY['channel.inbound.received.v1'::text, 'channel.inbound.received.v2'::text]));


--
-- Name: ix_channel_runtime_delivery_receipts_retention; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE INDEX ix_channel_runtime_delivery_receipts_retention ON channel_runtime.delivery_receipts USING btree (tenant_id, received_at DESC);


--
-- Name: uq_channel_outbox_dedupe; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_channel_outbox_dedupe ON channel_runtime.outbox_events USING btree (tenant_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: uq_channel_outbox_stream_sequence; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_channel_outbox_stream_sequence ON channel_runtime.outbox_events USING btree (tenant_id, stream_id, stream_sequence) WHERE ((stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL));


--
-- Name: uq_channel_runtime_connections_tenant_id_id; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_channel_runtime_connections_tenant_id_id ON channel_runtime.connections USING btree (tenant_id, id);


--
-- Name: uq_channel_runtime_inbound_events_tenant_id_id; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_channel_runtime_inbound_events_tenant_id_id ON channel_runtime.inbound_events USING btree (tenant_id, id);


--
-- Name: uq_channel_runtime_outbound_messages_tenant_id_id; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_channel_runtime_outbound_messages_tenant_id_id ON channel_runtime.outbound_messages USING btree (tenant_id, id);


--
-- Name: uq_channel_runtime_outbound_provider_message; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_channel_runtime_outbound_provider_message ON channel_runtime.outbound_messages USING btree (tenant_id, provider, provider_message_id) WHERE (provider_message_id IS NOT NULL);


--
-- Name: uq_channel_runtime_outbound_source_message; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_channel_runtime_outbound_source_message ON channel_runtime.outbound_messages USING btree (tenant_id, provider, message_id);


--
-- Name: uq_channel_runtime_thread_bindings_tenant_id_id; Type: INDEX; Schema: channel_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_channel_runtime_thread_bindings_tenant_id_id ON channel_runtime.thread_bindings USING btree (tenant_id, id);


--
-- Name: idx_agents_tenant_id; Type: INDEX; Schema: platform; Owner: -
--

CREATE INDEX idx_agents_tenant_id ON platform.agents USING btree (tenant_id);


--
-- Name: idx_integrations_tenant_id; Type: INDEX; Schema: platform; Owner: -
--

CREATE INDEX idx_integrations_tenant_id ON platform.integrations USING btree (tenant_id);


--
-- Name: idx_knowledge_sources_tenant_id; Type: INDEX; Schema: platform; Owner: -
--

CREATE INDEX idx_knowledge_sources_tenant_id ON platform.knowledge_sources USING btree (tenant_id);


--
-- Name: idx_prompt_flows_agent_id; Type: INDEX; Schema: platform; Owner: -
--

CREATE INDEX idx_prompt_flows_agent_id ON platform.prompt_flows USING btree (agent_id);


--
-- Name: idx_pulso_iris_agenda_blocks_professional_range; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_agenda_blocks_professional_range ON pulso_iris.agenda_blocks USING btree (tenant_id, professional_id, starts_at, ends_at);


--
-- Name: idx_pulso_iris_agenda_blocks_tenant_range; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_agenda_blocks_tenant_range ON pulso_iris.agenda_blocks USING btree (tenant_id, status, starts_at, ends_at);


--
-- Name: idx_pulso_iris_appointment_holds_expiry; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_appointment_holds_expiry ON pulso_iris.appointment_holds USING btree (tenant_id, status, expires_at);


--
-- Name: idx_pulso_iris_appointment_status_history_lookup; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_appointment_status_history_lookup ON pulso_iris.appointment_status_history USING btree (tenant_id, appointment_id, created_at DESC);


--
-- Name: idx_pulso_iris_appointment_types_tenant; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_appointment_types_tenant ON pulso_iris.appointment_types USING btree (tenant_id);


--
-- Name: idx_pulso_iris_appointments_external_queue; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_appointments_external_queue ON pulso_iris.appointments USING btree (tenant_id, status, external_sla_due_at, created_at) WHERE (status = ANY (ARRAY['pending_external_confirmation'::text, 'deferred'::text, 'verification_failed'::text]));


--
-- Name: idx_pulso_iris_appointments_previous; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_appointments_previous ON pulso_iris.appointments USING btree (tenant_id, previous_appointment_id) WHERE (previous_appointment_id IS NOT NULL);


--
-- Name: idx_pulso_iris_appointments_slot_lookup; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_appointments_slot_lookup ON pulso_iris.appointments USING btree (tenant_id, site_id, professional_id, appointment_type_id, scheduled_at) WHERE ((scheduled_at IS NOT NULL) AND (site_id IS NOT NULL) AND (professional_id IS NOT NULL) AND (appointment_type_id IS NOT NULL) AND (status <> ALL (ARRAY['cancelled'::text, 'no_show'::text])));


--
-- Name: idx_pulso_iris_appointments_tenant_scheduled; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_appointments_tenant_scheduled ON pulso_iris.appointments USING btree (tenant_id, scheduled_at DESC);


--
-- Name: idx_pulso_iris_appointments_tenant_type; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_appointments_tenant_type ON pulso_iris.appointments USING btree (tenant_id, appointment_type_id);


--
-- Name: idx_pulso_iris_availability_rules_professional; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_availability_rules_professional ON pulso_iris.availability_rules USING btree (tenant_id, professional_id, weekday, starts_at);


--
-- Name: idx_pulso_iris_availability_rules_site; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_availability_rules_site ON pulso_iris.availability_rules USING btree (tenant_id, site_id, weekday, starts_at);


--
-- Name: idx_pulso_iris_availability_rules_tenant_status; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_availability_rules_tenant_status ON pulso_iris.availability_rules USING btree (tenant_id, status, weekday, starts_at);


--
-- Name: idx_pulso_iris_campaign_contacts_campaign; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_campaign_contacts_campaign ON pulso_iris.campaign_contacts USING btree (campaign_id, status);


--
-- Name: idx_pulso_iris_campaigns_tenant; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_campaigns_tenant ON pulso_iris.campaigns USING btree (tenant_id, status);


--
-- Name: idx_pulso_iris_configuration_imports_created; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_configuration_imports_created ON pulso_iris.configuration_imports USING btree (tenant_id, created_at DESC);


--
-- Name: idx_pulso_iris_conversations_tenant_site; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_conversations_tenant_site ON pulso_iris.conversations USING btree (tenant_id, site_id);


--
-- Name: idx_pulso_iris_conversations_tenant_started; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_conversations_tenant_started ON pulso_iris.conversations USING btree (tenant_id, started_at DESC);


--
-- Name: idx_pulso_iris_handoffs_tenant_status; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_handoffs_tenant_status ON pulso_iris.handoffs USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_pulso_iris_holidays_tenant_status_date; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_holidays_tenant_status_date ON pulso_iris.holidays USING btree (tenant_id, status, holiday_date);


--
-- Name: idx_pulso_iris_kpis_tenant_snapshot; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_kpis_tenant_snapshot ON pulso_iris.operational_kpi_snapshots USING btree (tenant_id, snapshot_at DESC);


--
-- Name: idx_pulso_iris_messages_delivery; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_messages_delivery ON pulso_iris.messages USING btree (tenant_id, delivery_status, created_at DESC);


--
-- Name: idx_pulso_iris_messages_tenant_created; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_messages_tenant_created ON pulso_iris.messages USING btree (tenant_id, created_at DESC);


--
-- Name: idx_pulso_iris_patients_tenant; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_patients_tenant ON pulso_iris.administrative_patients USING btree (tenant_id);


--
-- Name: idx_pulso_iris_payers_tenant; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_payers_tenant ON pulso_iris.payers USING btree (tenant_id);


--
-- Name: idx_pulso_iris_professional_appointment_types_lookup; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_professional_appointment_types_lookup ON pulso_iris.professional_appointment_types USING btree (tenant_id, status, professional_id, appointment_type_id);


--
-- Name: idx_pulso_iris_professional_payer_exclusions_lookup; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_professional_payer_exclusions_lookup ON pulso_iris.professional_payer_exclusions USING btree (tenant_id, status, payer_id, professional_id);


--
-- Name: idx_pulso_iris_professional_sites_lookup; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_professional_sites_lookup ON pulso_iris.professional_sites USING btree (tenant_id, status, professional_id, site_id);


--
-- Name: idx_pulso_iris_professionals_tenant; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_professionals_tenant ON pulso_iris.professionals USING btree (tenant_id);


--
-- Name: idx_pulso_iris_rpa_actions_tenant_status; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_rpa_actions_tenant_status ON pulso_iris.rpa_actions USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_pulso_iris_rpa_events_tenant_created; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_rpa_events_tenant_created ON pulso_iris.rpa_events USING btree (tenant_id, created_at DESC);


--
-- Name: idx_pulso_iris_rpa_workers_tenant; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_rpa_workers_tenant ON pulso_iris.rpa_workers USING btree (tenant_id, status);


--
-- Name: idx_pulso_iris_sites_tenant; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_sites_tenant ON pulso_iris.sites USING btree (tenant_id);


--
-- Name: idx_pulso_iris_waitlist_tenant_status; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX idx_pulso_iris_waitlist_tenant_status ON pulso_iris.waitlist USING btree (tenant_id, status, clinical_priority);


--
-- Name: ix_pulso_channel_threads_conversation; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX ix_pulso_channel_threads_conversation ON pulso_iris.channel_threads USING btree (tenant_id, conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: ix_pulso_inbox_tenant_received; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX ix_pulso_inbox_tenant_received ON pulso_iris.inbox_events USING btree (tenant_id, received_at DESC);


--
-- Name: ix_pulso_message_outbox_stream_head; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX ix_pulso_message_outbox_stream_head ON pulso_iris.outbox_events USING btree (tenant_id, stream_id, stream_sequence, status, next_attempt_at) WHERE (event_type = ANY (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text]));


--
-- Name: ix_pulso_outbox_claim; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE INDEX ix_pulso_outbox_claim ON pulso_iris.outbox_events USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text]));


--
-- Name: uq_pulso_channel_delivery_inbox_stream_sequence; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_channel_delivery_inbox_stream_sequence ON pulso_iris.inbox_events USING btree (tenant_id, source_service, stream_id, stream_sequence) WHERE ((source_service = 'whatsapp-channel-service'::text) AND (event_type = 'channel.delivery.updated.v1'::text));


--
-- Name: uq_pulso_channel_inbox_stream_sequence; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_channel_inbox_stream_sequence ON pulso_iris.inbox_events USING btree (tenant_id, source_service, stream_id, stream_sequence) WHERE ((source_service = 'whatsapp-channel-service'::text) AND (event_type = ANY (ARRAY['channel.inbound.received.v1'::text, 'channel.inbound.received.v2'::text])) AND (stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL));


--
-- Name: uq_pulso_iris_agenda_blocks_natural; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_agenda_blocks_natural ON pulso_iris.agenda_blocks USING btree (tenant_id, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(professional_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(appointment_type_id, '00000000-0000-0000-0000-000000000000'::uuid), starts_at, ends_at, block_type, lower(TRIM(BOTH FROM reason)));


--
-- Name: uq_pulso_iris_agenda_blocks_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_agenda_blocks_tenant_id_id ON pulso_iris.agenda_blocks USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_appointment_holds_active_capacity; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointment_holds_active_capacity ON pulso_iris.appointment_holds USING btree (tenant_id, site_id, professional_id, appointment_type_id, scheduled_at, slot_capacity_token) WHERE (status = 'active'::text);


--
-- Name: uq_pulso_iris_appointment_holds_appointment; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointment_holds_appointment ON pulso_iris.appointment_holds USING btree (tenant_id, appointment_id) WHERE (appointment_id IS NOT NULL);


--
-- Name: uq_pulso_iris_appointment_holds_idempotency; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointment_holds_idempotency ON pulso_iris.appointment_holds USING btree (tenant_id, idempotency_key);


--
-- Name: uq_pulso_iris_appointment_holds_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointment_holds_tenant_id_id ON pulso_iris.appointment_holds USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_appointment_status_history_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointment_status_history_tenant_id_id ON pulso_iris.appointment_status_history USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_appointment_types_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointment_types_tenant_id_id ON pulso_iris.appointment_types USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_appointments_external_reference; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointments_external_reference ON pulso_iris.appointments USING btree (tenant_id, lower(TRIM(BOTH FROM external_system)), lower(TRIM(BOTH FROM external_reference))) WHERE ((external_reference IS NOT NULL) AND (length(TRIM(BOTH FROM external_reference)) > 0));


--
-- Name: uq_pulso_iris_appointments_hold; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointments_hold ON pulso_iris.appointments USING btree (tenant_id, hold_id) WHERE (hold_id IS NOT NULL);


--
-- Name: uq_pulso_iris_appointments_idempotency; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointments_idempotency ON pulso_iris.appointments USING btree (tenant_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_pulso_iris_appointments_slot_capacity_token; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointments_slot_capacity_token ON pulso_iris.appointments USING btree (tenant_id, site_id, professional_id, appointment_type_id, scheduled_at, slot_capacity_token) WHERE ((scheduled_at IS NOT NULL) AND (site_id IS NOT NULL) AND (professional_id IS NOT NULL) AND (appointment_type_id IS NOT NULL) AND (slot_capacity_token IS NOT NULL) AND (status <> ALL (ARRAY['cancelled'::text, 'no_show'::text, 'rescheduled'::text, 'external_rejected'::text, 'failed'::text, 'expired'::text])));


--
-- Name: uq_pulso_iris_appointments_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_appointments_tenant_id_id ON pulso_iris.appointments USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_availability_rules_slot; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_availability_rules_slot ON pulso_iris.availability_rules USING btree (tenant_id, site_id, professional_id, appointment_type_id, weekday, starts_at, COALESCE(effective_from, '1900-01-01'::date));


--
-- Name: uq_pulso_iris_availability_rules_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_availability_rules_tenant_id_id ON pulso_iris.availability_rules USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_campaigns_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_campaigns_tenant_id_id ON pulso_iris.campaigns USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_configuration_imports_idempotency; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_configuration_imports_idempotency ON pulso_iris.configuration_imports USING btree (tenant_id, idempotency_key);


--
-- Name: uq_pulso_iris_configuration_imports_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_configuration_imports_tenant_id_id ON pulso_iris.configuration_imports USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_conversations_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_conversations_tenant_id_id ON pulso_iris.conversations USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_handoffs_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_handoffs_tenant_id_id ON pulso_iris.handoffs USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_holidays_tenant_date; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_holidays_tenant_date ON pulso_iris.holidays USING btree (tenant_id, holiday_date);


--
-- Name: uq_pulso_iris_holidays_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_holidays_tenant_id_id ON pulso_iris.holidays USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_messages_inbound_external; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_messages_inbound_external ON pulso_iris.messages USING btree (tenant_id, provider, external_message_id) WHERE ((provider IS NOT NULL) AND (external_message_id IS NOT NULL));


--
-- Name: uq_pulso_iris_messages_outbound_provider; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_messages_outbound_provider ON pulso_iris.messages USING btree (tenant_id, provider, provider_message_id) WHERE ((provider IS NOT NULL) AND (provider_message_id IS NOT NULL));


--
-- Name: uq_pulso_iris_messages_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_messages_tenant_id_id ON pulso_iris.messages USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_patients_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_patients_tenant_id_id ON pulso_iris.administrative_patients USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_patients_tenant_phone_hash; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_patients_tenant_phone_hash ON pulso_iris.administrative_patients USING btree (tenant_id, phone_e164_hash) WHERE (phone_e164_hash IS NOT NULL);


--
-- Name: uq_pulso_iris_payers_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_payers_tenant_id_id ON pulso_iris.payers USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_professional_appointment_types_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_professional_appointment_types_tenant_id_id ON pulso_iris.professional_appointment_types USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_professional_payer_exclusions_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_professional_payer_exclusions_tenant_id_id ON pulso_iris.professional_payer_exclusions USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_professional_payer_exclusions_unique; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_professional_payer_exclusions_unique ON pulso_iris.professional_payer_exclusions USING btree (tenant_id, professional_id, payer_id);


--
-- Name: uq_pulso_iris_professional_sites_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_professional_sites_tenant_id_id ON pulso_iris.professional_sites USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_professionals_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_professionals_tenant_id_id ON pulso_iris.professionals USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_professionals_tenant_normalized_name; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_professionals_tenant_normalized_name ON pulso_iris.professionals USING btree (tenant_id, lower(TRIM(BOTH FROM name)));


--
-- Name: uq_pulso_iris_rpa_actions_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_rpa_actions_tenant_id_id ON pulso_iris.rpa_actions USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_rpa_workers_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_rpa_workers_tenant_id_id ON pulso_iris.rpa_workers USING btree (tenant_id, id);


--
-- Name: uq_pulso_iris_sites_tenant_id_id; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_iris_sites_tenant_id_id ON pulso_iris.sites USING btree (tenant_id, id);


--
-- Name: uq_pulso_message_outbox_source_sequence; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_message_outbox_source_sequence ON pulso_iris.outbox_events USING btree (tenant_id, source_stream_id, source_stream_sequence) WHERE ((event_type = ANY (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text])) AND (source_stream_id IS NOT NULL) AND (source_stream_sequence IS NOT NULL));


--
-- Name: uq_pulso_message_outbox_stream_sequence; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_message_outbox_stream_sequence ON pulso_iris.outbox_events USING btree (tenant_id, stream_id, stream_sequence) WHERE ((event_type = ANY (ARRAY['pulso.message.received.v1'::text, 'pulso.message.received.v2'::text])) AND (stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL));


--
-- Name: uq_pulso_outbox_dedupe; Type: INDEX; Schema: pulso_iris; Owner: -
--

CREATE UNIQUE INDEX uq_pulso_outbox_dedupe ON pulso_iris.outbox_events USING btree (tenant_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: inbox_events trg_agent_inbox_resolve_legacy_pulso_position; Type: TRIGGER; Schema: agent_runtime; Owner: -
--

CREATE TRIGGER trg_agent_inbox_resolve_legacy_pulso_position BEFORE INSERT ON agent_runtime.inbox_events FOR EACH ROW EXECUTE FUNCTION agent_runtime.resolve_legacy_pulso_inbox_position();


--
-- Name: jobs trg_agent_jobs_prepare_ordered; Type: TRIGGER; Schema: agent_runtime; Owner: -
--

CREATE TRIGGER trg_agent_jobs_prepare_ordered BEFORE INSERT ON agent_runtime.jobs FOR EACH ROW EXECUTE FUNCTION agent_runtime.prepare_ordered_job();


--
-- Name: jobs trg_agent_jobs_reject_unpositioned_claim; Type: TRIGGER; Schema: agent_runtime; Owner: -
--

CREATE TRIGGER trg_agent_jobs_reject_unpositioned_claim BEFORE UPDATE OF status ON agent_runtime.jobs FOR EACH ROW EXECUTE FUNCTION agent_runtime.reject_unpositioned_job_claim();


--
-- Name: jobs trg_agent_jobs_release_ordered; Type: TRIGGER; Schema: agent_runtime; Owner: -
--

CREATE TRIGGER trg_agent_jobs_release_ordered AFTER UPDATE OF status ON agent_runtime.jobs FOR EACH ROW EXECUTE FUNCTION agent_runtime.release_next_ordered_job();


--
-- Name: inbound_events trg_channel_inbound_outbox_compat; Type: TRIGGER; Schema: channel_runtime; Owner: -
--

CREATE TRIGGER trg_channel_inbound_outbox_compat AFTER INSERT ON channel_runtime.inbound_events FOR EACH ROW EXECUTE FUNCTION channel_runtime.mirror_inbound_event_to_outbox();


--
-- Name: outbox_events trg_channel_outbox_defer_non_head; Type: TRIGGER; Schema: channel_runtime; Owner: -
--

CREATE TRIGGER trg_channel_outbox_defer_non_head BEFORE INSERT ON channel_runtime.outbox_events FOR EACH ROW EXECUTE FUNCTION channel_runtime.defer_non_head_outbox_event();


--
-- Name: outbox_events trg_channel_outbox_release_successor; Type: TRIGGER; Schema: channel_runtime; Owner: -
--

CREATE TRIGGER trg_channel_outbox_release_successor AFTER UPDATE OF status ON channel_runtime.outbox_events FOR EACH ROW EXECUTE FUNCTION channel_runtime.release_next_outbox_event();


--
-- Name: appointments trg_guard_appointment_capacity_claim; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_guard_appointment_capacity_claim BEFORE INSERT OR UPDATE OF tenant_id, site_id, professional_id, appointment_type_id, scheduled_at, slot_capacity_token, status, hold_id ON pulso_iris.appointments FOR EACH ROW EXECUTE FUNCTION pulso_iris.guard_slot_capacity_claim();


--
-- Name: appointment_holds trg_guard_hold_capacity_claim; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_guard_hold_capacity_claim BEFORE INSERT OR UPDATE OF tenant_id, site_id, professional_id, appointment_type_id, scheduled_at, slot_capacity_token, status, appointment_id ON pulso_iris.appointment_holds FOR EACH ROW EXECUTE FUNCTION pulso_iris.guard_slot_capacity_claim();


--
-- Name: inbox_events trg_pulso_inbox_resolve_legacy_channel_position; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_pulso_inbox_resolve_legacy_channel_position BEFORE INSERT ON pulso_iris.inbox_events FOR EACH ROW EXECUTE FUNCTION pulso_iris.resolve_legacy_channel_inbox_position();


--
-- Name: outbox_events trg_pulso_outbox_legacy_source_position; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_pulso_outbox_legacy_source_position BEFORE INSERT ON pulso_iris.outbox_events FOR EACH ROW EXECUTE FUNCTION pulso_iris.prepare_legacy_message_source_position();


--
-- Name: outbox_events trg_pulso_outbox_prepare_ordered_message; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_pulso_outbox_prepare_ordered_message BEFORE INSERT ON pulso_iris.outbox_events FOR EACH ROW EXECUTE FUNCTION pulso_iris.prepare_ordered_message_outbox_event();


--
-- Name: outbox_events trg_pulso_outbox_reject_unpositioned_claim; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_pulso_outbox_reject_unpositioned_claim BEFORE UPDATE OF status ON pulso_iris.outbox_events FOR EACH ROW EXECUTE FUNCTION pulso_iris.reject_unpositioned_message_claim();


--
-- Name: outbox_events trg_pulso_outbox_release_ordered_message; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_pulso_outbox_release_ordered_message AFTER UPDATE OF status ON pulso_iris.outbox_events FOR EACH ROW EXECUTE FUNCTION pulso_iris.release_next_message_outbox_event();


--
-- Name: appointments trg_record_appointment_status_transition; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_record_appointment_status_transition AFTER INSERT OR UPDATE OF status ON pulso_iris.appointments FOR EACH ROW EXECUTE FUNCTION pulso_iris.record_appointment_status_transition();


--
-- Name: appointments trg_touch_appointment_status_updated_at; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_touch_appointment_status_updated_at BEFORE INSERT OR UPDATE OF status ON pulso_iris.appointments FOR EACH ROW EXECUTE FUNCTION pulso_iris.touch_appointment_status_updated_at();


--
-- Name: availability_rules trg_validate_availability_rule; Type: TRIGGER; Schema: pulso_iris; Owner: -
--

CREATE TRIGGER trg_validate_availability_rule BEFORE INSERT OR UPDATE OF tenant_id, site_id, professional_id, appointment_type_id, slot_duration_min ON pulso_iris.availability_rules FOR EACH ROW EXECUTE FUNCTION pulso_iris.validate_availability_rule();


--
-- Name: executions executions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.executions
    ADD CONSTRAINT executions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: executions fk_agent_executions_job_tenant; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.executions
    ADD CONSTRAINT fk_agent_executions_job_tenant FOREIGN KEY (tenant_id, job_id) REFERENCES agent_runtime.jobs(tenant_id, id) ON DELETE CASCADE;


--
-- Name: jobs jobs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.jobs
    ADD CONSTRAINT jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: connections connections_tenant_id_fkey; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.connections
    ADD CONSTRAINT connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: delivery_receipts delivery_receipts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.delivery_receipts
    ADD CONSTRAINT delivery_receipts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: inbound_events fk_channel_inbound_connection_tenant; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.inbound_events
    ADD CONSTRAINT fk_channel_inbound_connection_tenant FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_runtime.connections(tenant_id, id) ON DELETE CASCADE;


--
-- Name: inbound_events fk_channel_inbound_thread_tenant; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.inbound_events
    ADD CONSTRAINT fk_channel_inbound_thread_tenant FOREIGN KEY (tenant_id, thread_binding_id) REFERENCES channel_runtime.thread_bindings(tenant_id, id) ON DELETE SET NULL (thread_binding_id);


--
-- Name: outbound_messages fk_channel_outbound_connection_tenant; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbound_messages
    ADD CONSTRAINT fk_channel_outbound_connection_tenant FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_runtime.connections(tenant_id, id) ON DELETE CASCADE;


--
-- Name: outbound_messages fk_channel_outbound_thread_tenant; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbound_messages
    ADD CONSTRAINT fk_channel_outbound_thread_tenant FOREIGN KEY (tenant_id, thread_binding_id) REFERENCES channel_runtime.thread_bindings(tenant_id, id);


--
-- Name: thread_bindings fk_channel_thread_connection_tenant; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.thread_bindings
    ADD CONSTRAINT fk_channel_thread_connection_tenant FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_runtime.connections(tenant_id, id) ON DELETE CASCADE;


--
-- Name: inbound_events inbound_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.inbound_events
    ADD CONSTRAINT inbound_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: outbound_messages outbound_messages_tenant_id_fkey; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.outbound_messages
    ADD CONSTRAINT outbound_messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: thread_bindings thread_bindings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: channel_runtime; Owner: -
--

ALTER TABLE ONLY channel_runtime.thread_bindings
    ADD CONSTRAINT thread_bindings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: agents agents_product_id_fkey; Type: FK CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.agents
    ADD CONSTRAINT agents_product_id_fkey FOREIGN KEY (product_id) REFERENCES platform.products(id) ON DELETE SET NULL;


--
-- Name: agents agents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.agents
    ADD CONSTRAINT agents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: integrations integrations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.integrations
    ADD CONSTRAINT integrations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: knowledge_sources knowledge_sources_tenant_id_fkey; Type: FK CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.knowledge_sources
    ADD CONSTRAINT knowledge_sources_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: prompt_flows prompt_flows_agent_id_fkey; Type: FK CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.prompt_flows
    ADD CONSTRAINT prompt_flows_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES platform.agents(id) ON DELETE CASCADE;


--
-- Name: prompt_flows prompt_flows_tenant_id_fkey; Type: FK CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.prompt_flows
    ADD CONSTRAINT prompt_flows_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: administrative_patients administrative_patients_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.administrative_patients
    ADD CONSTRAINT administrative_patients_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: agenda_blocks agenda_blocks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.agenda_blocks
    ADD CONSTRAINT agenda_blocks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: agenda_settings agenda_settings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.agenda_settings
    ADD CONSTRAINT agenda_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: appointment_holds appointment_holds_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT appointment_holds_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: appointment_status_history appointment_status_history_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_status_history
    ADD CONSTRAINT appointment_status_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: appointment_types appointment_types_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_types
    ADD CONSTRAINT appointment_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: appointments appointments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT appointments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: availability_rules availability_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.availability_rules
    ADD CONSTRAINT availability_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: campaign_contacts campaign_contacts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.campaign_contacts
    ADD CONSTRAINT campaign_contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.campaigns
    ADD CONSTRAINT campaigns_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: configuration_imports configuration_imports_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.configuration_imports
    ADD CONSTRAINT configuration_imports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.conversations
    ADD CONSTRAINT conversations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: agenda_blocks fk_agenda_blocks_appointment_type_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.agenda_blocks
    ADD CONSTRAINT fk_agenda_blocks_appointment_type_tenant FOREIGN KEY (tenant_id, appointment_type_id) REFERENCES pulso_iris.appointment_types(tenant_id, id);


--
-- Name: agenda_blocks fk_agenda_blocks_professional_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.agenda_blocks
    ADD CONSTRAINT fk_agenda_blocks_professional_tenant FOREIGN KEY (tenant_id, professional_id) REFERENCES pulso_iris.professionals(tenant_id, id);


--
-- Name: agenda_blocks fk_agenda_blocks_site_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.agenda_blocks
    ADD CONSTRAINT fk_agenda_blocks_site_tenant FOREIGN KEY (tenant_id, site_id) REFERENCES pulso_iris.sites(tenant_id, id);


--
-- Name: appointment_holds fk_appointment_holds_appointment_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT fk_appointment_holds_appointment_tenant FOREIGN KEY (tenant_id, appointment_id) REFERENCES pulso_iris.appointments(tenant_id, id);


--
-- Name: appointment_holds fk_appointment_holds_conversation_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT fk_appointment_holds_conversation_tenant FOREIGN KEY (tenant_id, conversation_id) REFERENCES pulso_iris.conversations(tenant_id, id);


--
-- Name: appointment_holds fk_appointment_holds_patient_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT fk_appointment_holds_patient_tenant FOREIGN KEY (tenant_id, patient_id) REFERENCES pulso_iris.administrative_patients(tenant_id, id);


--
-- Name: appointment_holds fk_appointment_holds_payer_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT fk_appointment_holds_payer_tenant FOREIGN KEY (tenant_id, payer_id) REFERENCES pulso_iris.payers(tenant_id, id);


--
-- Name: appointment_holds fk_appointment_holds_professional_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT fk_appointment_holds_professional_tenant FOREIGN KEY (tenant_id, professional_id) REFERENCES pulso_iris.professionals(tenant_id, id);


--
-- Name: appointment_holds fk_appointment_holds_site_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT fk_appointment_holds_site_tenant FOREIGN KEY (tenant_id, site_id) REFERENCES pulso_iris.sites(tenant_id, id);


--
-- Name: appointment_holds fk_appointment_holds_type_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_holds
    ADD CONSTRAINT fk_appointment_holds_type_tenant FOREIGN KEY (tenant_id, appointment_type_id) REFERENCES pulso_iris.appointment_types(tenant_id, id);


--
-- Name: appointment_status_history fk_appointment_status_history_appointment_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointment_status_history
    ADD CONSTRAINT fk_appointment_status_history_appointment_tenant FOREIGN KEY (tenant_id, appointment_id) REFERENCES pulso_iris.appointments(tenant_id, id) ON DELETE CASCADE;


--
-- Name: appointments fk_appointments_appointment_type_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT fk_appointments_appointment_type_tenant FOREIGN KEY (tenant_id, appointment_type_id) REFERENCES pulso_iris.appointment_types(tenant_id, id);


--
-- Name: appointments fk_appointments_conversation_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT fk_appointments_conversation_tenant FOREIGN KEY (tenant_id, conversation_id) REFERENCES pulso_iris.conversations(tenant_id, id);


--
-- Name: appointments fk_appointments_hold_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT fk_appointments_hold_tenant FOREIGN KEY (tenant_id, hold_id) REFERENCES pulso_iris.appointment_holds(tenant_id, id);


--
-- Name: appointments fk_appointments_patient_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT fk_appointments_patient_tenant FOREIGN KEY (tenant_id, patient_id) REFERENCES pulso_iris.administrative_patients(tenant_id, id);


--
-- Name: appointments fk_appointments_payer_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT fk_appointments_payer_tenant FOREIGN KEY (tenant_id, payer_id) REFERENCES pulso_iris.payers(tenant_id, id);


--
-- Name: appointments fk_appointments_previous_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT fk_appointments_previous_tenant FOREIGN KEY (tenant_id, previous_appointment_id) REFERENCES pulso_iris.appointments(tenant_id, id);


--
-- Name: appointments fk_appointments_professional_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT fk_appointments_professional_tenant FOREIGN KEY (tenant_id, professional_id) REFERENCES pulso_iris.professionals(tenant_id, id);


--
-- Name: appointments fk_appointments_site_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.appointments
    ADD CONSTRAINT fk_appointments_site_tenant FOREIGN KEY (tenant_id, site_id) REFERENCES pulso_iris.sites(tenant_id, id);


--
-- Name: availability_rules fk_availability_rules_appointment_type_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.availability_rules
    ADD CONSTRAINT fk_availability_rules_appointment_type_tenant FOREIGN KEY (tenant_id, appointment_type_id) REFERENCES pulso_iris.appointment_types(tenant_id, id);


--
-- Name: availability_rules fk_availability_rules_professional_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.availability_rules
    ADD CONSTRAINT fk_availability_rules_professional_tenant FOREIGN KEY (tenant_id, professional_id) REFERENCES pulso_iris.professionals(tenant_id, id);


--
-- Name: availability_rules fk_availability_rules_site_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.availability_rules
    ADD CONSTRAINT fk_availability_rules_site_tenant FOREIGN KEY (tenant_id, site_id) REFERENCES pulso_iris.sites(tenant_id, id);


--
-- Name: campaign_contacts fk_campaign_contacts_appointment_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.campaign_contacts
    ADD CONSTRAINT fk_campaign_contacts_appointment_tenant FOREIGN KEY (tenant_id, appointment_id) REFERENCES pulso_iris.appointments(tenant_id, id);


--
-- Name: campaign_contacts fk_campaign_contacts_campaign_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.campaign_contacts
    ADD CONSTRAINT fk_campaign_contacts_campaign_tenant FOREIGN KEY (tenant_id, campaign_id) REFERENCES pulso_iris.campaigns(tenant_id, id) ON DELETE CASCADE;


--
-- Name: campaign_contacts fk_campaign_contacts_patient_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.campaign_contacts
    ADD CONSTRAINT fk_campaign_contacts_patient_tenant FOREIGN KEY (tenant_id, patient_id) REFERENCES pulso_iris.administrative_patients(tenant_id, id);


--
-- Name: conversations fk_conversations_patient_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.conversations
    ADD CONSTRAINT fk_conversations_patient_tenant FOREIGN KEY (tenant_id, patient_id) REFERENCES pulso_iris.administrative_patients(tenant_id, id);


--
-- Name: conversations fk_conversations_site_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.conversations
    ADD CONSTRAINT fk_conversations_site_tenant FOREIGN KEY (tenant_id, site_id) REFERENCES pulso_iris.sites(tenant_id, id);


--
-- Name: handoffs fk_handoffs_conversation_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.handoffs
    ADD CONSTRAINT fk_handoffs_conversation_tenant FOREIGN KEY (tenant_id, conversation_id) REFERENCES pulso_iris.conversations(tenant_id, id);


--
-- Name: handoffs fk_handoffs_patient_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.handoffs
    ADD CONSTRAINT fk_handoffs_patient_tenant FOREIGN KEY (tenant_id, patient_id) REFERENCES pulso_iris.administrative_patients(tenant_id, id);


--
-- Name: messages fk_messages_conversation_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.messages
    ADD CONSTRAINT fk_messages_conversation_tenant FOREIGN KEY (tenant_id, conversation_id) REFERENCES pulso_iris.conversations(tenant_id, id) ON DELETE CASCADE;


--
-- Name: professional_appointment_types fk_professional_appointment_types_professional_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_appointment_types
    ADD CONSTRAINT fk_professional_appointment_types_professional_tenant FOREIGN KEY (tenant_id, professional_id) REFERENCES pulso_iris.professionals(tenant_id, id) ON DELETE CASCADE;


--
-- Name: professional_appointment_types fk_professional_appointment_types_type_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_appointment_types
    ADD CONSTRAINT fk_professional_appointment_types_type_tenant FOREIGN KEY (tenant_id, appointment_type_id) REFERENCES pulso_iris.appointment_types(tenant_id, id) ON DELETE CASCADE;


--
-- Name: professional_payer_exclusions fk_professional_payer_exclusions_payer_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_payer_exclusions
    ADD CONSTRAINT fk_professional_payer_exclusions_payer_tenant FOREIGN KEY (tenant_id, payer_id) REFERENCES pulso_iris.payers(tenant_id, id);


--
-- Name: professional_payer_exclusions fk_professional_payer_exclusions_professional_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_payer_exclusions
    ADD CONSTRAINT fk_professional_payer_exclusions_professional_tenant FOREIGN KEY (tenant_id, professional_id) REFERENCES pulso_iris.professionals(tenant_id, id);


--
-- Name: professional_sites fk_professional_sites_professional_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_sites
    ADD CONSTRAINT fk_professional_sites_professional_tenant FOREIGN KEY (tenant_id, professional_id) REFERENCES pulso_iris.professionals(tenant_id, id) ON DELETE CASCADE;


--
-- Name: professional_sites fk_professional_sites_site_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_sites
    ADD CONSTRAINT fk_professional_sites_site_tenant FOREIGN KEY (tenant_id, site_id) REFERENCES pulso_iris.sites(tenant_id, id) ON DELETE CASCADE;


--
-- Name: channel_threads fk_pulso_channel_thread_conversation; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.channel_threads
    ADD CONSTRAINT fk_pulso_channel_thread_conversation FOREIGN KEY (tenant_id, conversation_id) REFERENCES pulso_iris.conversations(tenant_id, id) ON DELETE SET NULL (conversation_id);


--
-- Name: channel_threads fk_pulso_channel_thread_patient; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.channel_threads
    ADD CONSTRAINT fk_pulso_channel_thread_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES pulso_iris.administrative_patients(tenant_id, id) ON DELETE SET NULL (patient_id);


--
-- Name: rpa_actions fk_rpa_actions_appointment_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_actions
    ADD CONSTRAINT fk_rpa_actions_appointment_tenant FOREIGN KEY (tenant_id, appointment_id) REFERENCES pulso_iris.appointments(tenant_id, id);


--
-- Name: rpa_actions fk_rpa_actions_conversation_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_actions
    ADD CONSTRAINT fk_rpa_actions_conversation_tenant FOREIGN KEY (tenant_id, conversation_id) REFERENCES pulso_iris.conversations(tenant_id, id);


--
-- Name: rpa_actions fk_rpa_actions_worker_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_actions
    ADD CONSTRAINT fk_rpa_actions_worker_tenant FOREIGN KEY (tenant_id, worker_id) REFERENCES pulso_iris.rpa_workers(tenant_id, id);


--
-- Name: rpa_events fk_rpa_events_worker_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_events
    ADD CONSTRAINT fk_rpa_events_worker_tenant FOREIGN KEY (tenant_id, worker_id) REFERENCES pulso_iris.rpa_workers(tenant_id, id);


--
-- Name: waitlist fk_waitlist_appointment_type_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.waitlist
    ADD CONSTRAINT fk_waitlist_appointment_type_tenant FOREIGN KEY (tenant_id, appointment_type_id) REFERENCES pulso_iris.appointment_types(tenant_id, id);


--
-- Name: waitlist fk_waitlist_patient_tenant; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.waitlist
    ADD CONSTRAINT fk_waitlist_patient_tenant FOREIGN KEY (tenant_id, patient_id) REFERENCES pulso_iris.administrative_patients(tenant_id, id);


--
-- Name: handoffs handoffs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.handoffs
    ADD CONSTRAINT handoffs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: holidays holidays_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.holidays
    ADD CONSTRAINT holidays_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: operational_kpi_snapshots operational_kpi_snapshots_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.operational_kpi_snapshots
    ADD CONSTRAINT operational_kpi_snapshots_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: payers payers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.payers
    ADD CONSTRAINT payers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: professional_appointment_types professional_appointment_types_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_appointment_types
    ADD CONSTRAINT professional_appointment_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: professional_payer_exclusions professional_payer_exclusions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_payer_exclusions
    ADD CONSTRAINT professional_payer_exclusions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: professional_sites professional_sites_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professional_sites
    ADD CONSTRAINT professional_sites_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: professionals professionals_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.professionals
    ADD CONSTRAINT professionals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: rpa_actions rpa_actions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_actions
    ADD CONSTRAINT rpa_actions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: rpa_events rpa_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_events
    ADD CONSTRAINT rpa_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: rpa_workers rpa_workers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.rpa_workers
    ADD CONSTRAINT rpa_workers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: sites sites_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.sites
    ADD CONSTRAINT sites_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


--
-- Name: waitlist waitlist_tenant_id_fkey; Type: FK CONSTRAINT; Schema: pulso_iris; Owner: -
--

ALTER TABLE ONLY pulso_iris.waitlist
    ADD CONSTRAINT waitlist_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id) ON DELETE CASCADE;


-- Provider-owned control plane. The migration ledger is created atomically by
-- the runner after this baseline succeeds.
CREATE TABLE pulso_iris.schema_version (
  service_name text PRIMARY KEY,
  current_version integer NOT NULL CHECK (current_version > 0),
  migration_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schema_version_service_name_check CHECK (service_name = 'pulso')
);

CREATE TABLE pulso_iris.service_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 3 AND 160),
  applied_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL PRIVILEGES ON SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM PUBLIC;

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (1, '001-pulso-autonomous-baseline.sql');

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 1, '001-pulso-autonomous-baseline.sql');

