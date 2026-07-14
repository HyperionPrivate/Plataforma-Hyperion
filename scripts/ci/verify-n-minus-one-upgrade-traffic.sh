#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: $0 seed <legacy|current> <env-file> <project-name> <compose-file> [compose-file ...]" >&2
  echo "       $0 verify <legacy|current> <tenant-uuid> <inbound-uuid> <env-file> <project-name> <compose-file> [compose-file ...]" >&2
  exit 64
}

if (( $# < 5 )); then
  usage
fi

mode=$1
contract=$2
shift 2

if [[ $contract != "legacy" && $contract != "current" ]]; then
  usage
fi

tenant_id=""
inbound_event_id=""
if [[ $mode == "verify" ]]; then
  if (( $# < 5 )); then
    usage
  fi
  tenant_id=$1
  inbound_event_id=$2
  shift 2
elif [[ $mode != "seed" ]]; then
  usage
fi

env_file=$1
project_name=$2
shift 2

if (( $# < 1 )); then
  usage
fi

compose=(docker compose --env-file "$env_file" --project-name "$project_name")
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

uuid_pattern='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

if [[ $mode == "seed" && $contract == "legacy" ]]; then
  agent_container=$("${compose[@]}" ps --all --quiet agent-service)
  if [[ -n $agent_container && $(docker inspect "$agent_container" --format '{{.State.Running}}') == "true" ]]; then
    echo "stop the N-1 agent-service before creating a deliberately pending inbound event" >&2
    exit 1
  fi

  seed=$(
    "${compose[@]}" exec -T postgres \
      psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
      -At -F '|' -c "
        do \$precondition\$
        begin
          if to_regclass('channel_runtime.outbox_events') is not null then
            raise exception 'legacy upgrade probe requires the exact pre-outbox schema';
          end if;
        end
        \$precondition\$;

        create temporary table compatibility_upgrade_probe (
          tenant_id uuid not null,
          inbound_event_id uuid not null
        ) on commit preserve rows;

        do \$probe\$
        declare
          probe_tenant_id uuid;
          probe_connection_id uuid;
          probe_binding_id uuid;
          probe_inbound_id uuid;
        begin
          insert into platform.tenants (slug, display_name, status, metadata)
          values (
            'n1-upgrade-' || gen_random_uuid()::text,
            'N-1 upgrade compatibility probe',
            'active',
            '{\"synthetic\":true,\"purpose\":\"n1_upgrade_probe\"}'::jsonb
          ) returning id into probe_tenant_id;

          insert into channel_runtime.connections (tenant_id, state)
          values (probe_tenant_id, 'ready')
          returning id into probe_connection_id;

          insert into channel_runtime.thread_bindings (
            tenant_id, connection_id, provider, external_thread_id,
            phone_e164_hash, phone_masked
          ) values (
            probe_tenant_id, probe_connection_id, 'whatsapp_web_test',
            'n1-upgrade-' || gen_random_uuid()::text || '@s.whatsapp.net',
            repeat('d', 64), '********0299'
          ) returning id into probe_binding_id;

          insert into channel_runtime.inbound_events (
            tenant_id, connection_id, thread_binding_id, provider,
            external_message_id, body, status, occurred_at
          ) values (
            probe_tenant_id, probe_connection_id, probe_binding_id, 'whatsapp_web_test',
            'n1-upgrade-' || gen_random_uuid()::text,
            'Consulta administrativa sintética de compatibilidad',
            'received', now()
          ) returning id into probe_inbound_id;

          insert into compatibility_upgrade_probe (tenant_id, inbound_event_id)
          values (probe_tenant_id, probe_inbound_id);
        end
        \$probe\$;

        select tenant_id, inbound_event_id from compatibility_upgrade_probe;
      "
  )

  IFS='|' read -r tenant_id inbound_event_id <<<"$seed"
  if [[ ! $tenant_id =~ $uuid_pattern || ! $inbound_event_id =~ $uuid_pattern ]]; then
    echo "legacy upgrade probe did not return stable identifiers" >&2
    exit 1
  fi
  printf '%s|%s\n' "$tenant_id" "$inbound_event_id"
  exit 0
fi

if [[ $mode == "seed" && $contract == "current" ]]; then
  "${compose[@]}" exec -T pulso-iris-service node -e '
    if (process.env.CHANNEL_INBOUND_V1_COMPATIBILITY !== "disabled") process.exit(1);
  '

  tenant_id=$(
    "${compose[@]}" exec -T postgres \
      psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
      -At -c "
        with tenant as (
          insert into platform.tenants (slug, display_name, status, metadata)
          values (
            '$contract-' || gen_random_uuid()::text,
            '$contract compatibility probe',
            'active',
            jsonb_build_object('synthetic', true, 'purpose', '${contract}_probe')
          ) returning id
        ), connection as (
          insert into channel_runtime.connections (tenant_id, state)
          select id, 'ready' from tenant
        )
        select id from tenant;
      "
  )
  if [[ ! $tenant_id =~ $uuid_pattern ]]; then
    echo "current v2 probe did not return a stable tenant identifier" >&2
    exit 1
  fi

  inbound_event_id=$(
    "${compose[@]}" exec -T whatsapp-channel-service \
      node --input-type=module -e '
        import { randomUUID } from "node:crypto";
        import { createDatabase } from "./packages/database/dist/index.js";
        import { PostgresChannelRepository } from "./services/whatsapp-channel-service/dist/channel-repository.js";

        const tenantId = process.argv[1];
        const contract = process.argv[2];
        const db = createDatabase(process.env.DATABASE_URL);
        try {
          const repository = new PostgresChannelRepository(db);
          const result = await repository.persistInbound({
            tenantId,
            provider: "whatsapp_web_test",
            externalMessageId: `${contract}-${randomUUID()}`,
            providerAddress: `${contract}-${randomUUID()}@s.whatsapp.net`,
            phoneHash: "e".repeat(64),
            phoneMasked: "********0399",
            body: `Consulta administrativa sintética del contrato ${contract}`,
            receivedAt: new Date()
          });
          process.stdout.write(`${result.eventId}\n`);
        } finally {
          await db.close();
        }
      ' "$tenant_id" "$contract"
  )
  if [[ ! $inbound_event_id =~ $uuid_pattern ]]; then
    echo "current v2 writer did not return a stable inbound identifier" >&2
    exit 1
  fi
  printf '%s|%s\n' "$tenant_id" "$inbound_event_id"
  exit 0
fi

if [[ ! $tenant_id =~ $uuid_pattern || ! $inbound_event_id =~ $uuid_pattern ]]; then
  echo "upgrade probe identifiers must be UUIDs" >&2
  exit 64
fi

if [[ $contract == "legacy" ]]; then
  "${compose[@]}" exec -T pulso-iris-service node -e '
    if (process.env.CHANNEL_INBOUND_V1_COMPATIBILITY !== "enabled") process.exit(1);
  '
  expected_channel_type="channel.inbound.received.v1"
  expected_channel_version="1"
elif [[ $contract == "current" ]]; then
  "${compose[@]}" exec -T pulso-iris-service node -e '
    if (process.env.CHANNEL_INBOUND_V1_COMPATIBILITY !== "disabled") process.exit(1);
  '
  expected_channel_type="channel.inbound.received.v2"
  expected_channel_version="2"
fi

expected_pulso_type="pulso.message.received.v2"
expected_pulso_version="2"
expected_agent_type="pulso.message.received.v2"
expected_agent_version="2"
expected_job_ordering="pulso_durable"

state="missing"
for _attempt in {1..120}; do
  state=$(
    "${compose[@]}" exec -T postgres \
      psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
      -At -F '|' -c "
        with source as materialized (
          select inbound.id, inbound.tenant_id, inbound.thread_binding_id,
                 inbound.status, inbound.processed_at
            from channel_runtime.inbound_events inbound
           where inbound.tenant_id = '$tenant_id'::uuid
             and inbound.id = '$inbound_event_id'::uuid
        ), channel_event as materialized (
          select outbox.*
            from channel_runtime.outbox_events outbox
            join source on source.tenant_id = outbox.tenant_id
                       and source.id = outbox.aggregate_id
           where outbox.event_type in (
             'channel.inbound.received.v1', 'channel.inbound.received.v2'
           )
           order by outbox.created_at, outbox.id
           limit 1
        ), pulso_inbox as materialized (
          select inbox.*
            from pulso_iris.inbox_events inbox
            join channel_event on channel_event.id = inbox.event_id
        ), pulso_event as materialized (
          select outbox.*
            from pulso_iris.outbox_events outbox
            join pulso_inbox
              on outbox.tenant_id = pulso_inbox.tenant_id
             and outbox.aggregate_id = (pulso_inbox.result ->> 'messageId')::uuid
           where outbox.event_type in (
             'pulso.message.received.v1', 'pulso.message.received.v2'
           )
           order by outbox.created_at, outbox.id
           limit 1
        ), agent_inbox as materialized (
          select inbox.*
            from agent_runtime.inbox_events inbox
            join pulso_event on pulso_event.id = inbox.event_id
        ), job as materialized (
          select candidate.*
            from agent_runtime.jobs candidate
            join source on source.tenant_id = candidate.tenant_id
                       and source.id = candidate.inbound_event_id
           order by candidate.created_at, candidate.id
           limit 1
        )
        select
          coalesce((select status from source), 'missing'),
          coalesce((select processed_at is not null from source), false)::text,
          coalesce((select event_type from channel_event), 'missing'),
          coalesce((select event_version::text from channel_event), '0'),
          coalesce((select status from channel_event), 'missing'),
          coalesce((select published_at is not null from channel_event), false)::text,
          coalesce((select stream_id = source.thread_binding_id and stream_sequence > 0
                      from channel_event cross join source), false)::text,
          coalesce((select processed_at is not null
                      and event_type = channel_event.event_type
                      and event_version = channel_event.event_version
                      and stream_id = channel_event.stream_id
                      and stream_sequence = channel_event.stream_sequence
                      from pulso_inbox cross join channel_event), false)::text,
          coalesce((select event_type from pulso_event), 'missing'),
          coalesce((select event_version::text from pulso_event), '0'),
          coalesce((select status from pulso_event), 'missing'),
          coalesce((select published_at is not null
                      and stream_id is not null and stream_sequence > 0
                      and source_stream_id = channel_event.stream_id
                      and source_stream_sequence = channel_event.stream_sequence
                      from pulso_event cross join channel_event), false)::text,
          coalesce((select processed_at is not null
                      and event_type = '$expected_agent_type'
                      and event_version = $expected_agent_version
                      and stream_id = pulso_event.stream_id
                      and stream_sequence = pulso_event.stream_sequence
                      and source_stream_id = pulso_event.source_stream_id
                      and source_stream_sequence = pulso_event.source_stream_sequence
                      from agent_inbox cross join pulso_event), false)::text,
          coalesce((select status from job), 'missing'),
          coalesce((select completed_at is not null
                      and ordering_source = '$expected_job_ordering'
                      and stream_id = pulso_event.stream_id
                      and stream_sequence = pulso_event.stream_sequence
                      from job cross join pulso_event), false)::text,
          coalesce((select exists (
                    select 1 from agent_runtime.executions execution
                     where execution.tenant_id = job.tenant_id
                       and execution.job_id = job.id
                       and execution.status in ('completed', 'fallback')
                       and execution.completed_at is not null
                  ) from job), false)::text,
          coalesce((select exists (
                    select 1
                      from pulso_iris.messages response
                     where response.tenant_id = job.tenant_id
                       and response.conversation_id = job.conversation_id
                       and response.sender = 'sofia'
                       and response.external_message_id = 'sofia-job:' || job.id::text
                       and exists (
                         select 1 from channel_runtime.outbound_messages outbound
                          where outbound.tenant_id = response.tenant_id
                            and outbound.message_id = response.id
                            and outbound.idempotency_key = 'sofia-job:' || job.id::text
                       )
                  ) from job), false)::text,
          (
            (select count(*) from channel_runtime.outbox_events
              where event_type = 'channel.inbound.received.v1'
                and status <> 'published')
            +
            (select count(*) from pulso_iris.outbox_events
              where event_type = 'pulso.message.received.v1'
                and status <> 'published')
          )::text,
          coalesce((select stream_sequence::text from channel_event), '0');
      "
  )

  IFS='|' read -r inbound_status inbound_processed channel_type channel_version channel_status \
    channel_published channel_position pulso_inbox_processed pulso_type pulso_version pulso_status \
    pulso_position agent_inbox_processed job_status job_completed execution_completed response_enqueued \
    pending_v1 channel_sequence <<<"$state"

  if [[ $inbound_status == "processed" && $inbound_processed == "true" && \
        $channel_type == "$expected_channel_type" && $channel_version == "$expected_channel_version" && \
        $channel_status == "published" && $channel_published == "true" && $channel_position == "true" && \
        $pulso_inbox_processed == "true" && $pulso_type == "$expected_pulso_type" && \
        $pulso_version == "$expected_pulso_version" && $pulso_status == "published" && \
        $pulso_position == "true" && \
        $agent_inbox_processed == "true" && $job_status == "completed" && $job_completed == "true" && \
        $execution_completed == "true" && $response_enqueued == "true" && $pending_v1 == "0" && \
        $channel_sequence =~ ^[1-9][0-9]*$ ]]; then
    echo "$contract upgrade traffic completed through Channel, PULSO and SOFIA"
    exit 0
  fi
  sleep 1
done

echo "$contract upgrade traffic did not complete against the upgraded schema" >&2
echo "last state: $state" >&2
exit 1
