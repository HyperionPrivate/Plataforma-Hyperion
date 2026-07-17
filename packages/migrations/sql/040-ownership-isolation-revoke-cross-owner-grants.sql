-- Shrink transitional cross-owner grants after A-03/A-04/M-12 ownership isolation.
-- Migration 024 remains the bootstrap authority and is updated in the same change;
-- this migration removes the grants from already-applied environments before the
-- next role bootstrap re-applies the reduced matrix.

-- Channel claim helper must no longer project delivery outcomes into PULSO tables.
create or replace function channel_runtime.claim_next_outbound_message(p_worker_id text)
returns setof channel_runtime.outbound_messages
language sql
volatile
as $$
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

revoke update on table pulso_iris.conversations from hyperion_sofia;
revoke insert, update on table pulso_iris.messages from hyperion_sofia;

revoke select, update on table channel_runtime.thread_bindings from hyperion_pulso;
revoke update on table channel_runtime.inbound_events from hyperion_pulso;
revoke usage on schema channel_runtime from hyperion_pulso;

revoke select, update on table pulso_iris.messages from hyperion_channel;
revoke usage on schema pulso_iris from hyperion_channel;
