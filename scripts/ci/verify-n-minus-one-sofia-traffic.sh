#!/usr/bin/env bash

set -euo pipefail

if (( $# < 3 )); then
  echo "usage: $0 <env-file> <project-name> <compose-file> [compose-file ...]" >&2
  exit 64
fi

env_file=$1
project_name=$2
shift 2

compose=(docker compose --env-file "$env_file" --project-name "$project_name")
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

# Seed only synthetic, body-free identifiers plus a short administrative test
# message. The running N-1 agent must claim it through the N-1 Channel HTTP API,
# call the N-1 PULSO tool API, insert a job against the upgraded schema, finish
# its fallback execution and enqueue the idempotent outbound response. Merely
# incrementing attempt_count is not sufficient: retries/dead letters must fail.
seed=$(
  "${compose[@]}" exec -T postgres \
    psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
    -At -F '|' -c "
      create temporary table compatibility_sofia_probe (
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
        insert into platform.tenants (slug, display_name)
        values ('n1-sofia-' || gen_random_uuid()::text, 'N-1 SOFIA compatibility probe')
        returning id into probe_tenant_id;

        insert into channel_runtime.connections (tenant_id, state)
        values (probe_tenant_id, 'ready')
        returning id into probe_connection_id;

        insert into channel_runtime.thread_bindings (
          tenant_id, connection_id, provider, external_thread_id,
          phone_e164_hash, phone_masked
        ) values (
          probe_tenant_id, probe_connection_id, 'whatsapp_web_test',
          'n1-' || gen_random_uuid()::text || '@s.whatsapp.net',
          repeat('c', 64), '********0199'
        ) returning id into probe_binding_id;

        insert into channel_runtime.inbound_events (
          tenant_id, connection_id, thread_binding_id, provider,
          external_message_id, body, status, occurred_at
        ) values (
          probe_tenant_id, probe_connection_id, probe_binding_id, 'whatsapp_web_test',
          'n1-' || gen_random_uuid()::text, 'Consulta administrativa de compatibilidad',
          'received', now()
        ) returning id into probe_inbound_id;

        insert into compatibility_sofia_probe (tenant_id, inbound_event_id)
        values (probe_tenant_id, probe_inbound_id);
      end
      \$probe\$;

      select tenant_id, inbound_event_id from compatibility_sofia_probe;
    "
)

IFS='|' read -r tenant_id inbound_event_id <<<"$seed"
if [[ ! $tenant_id =~ ^[0-9a-f-]{36}$ || ! $inbound_event_id =~ ^[0-9a-f-]{36}$ ]]; then
  echo "N-1 SOFIA compatibility probe did not return stable identifiers" >&2
  exit 1
fi

for attempt in {1..60}; do
  state=$(
    "${compose[@]}" exec -T postgres \
      psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
      -At -F '|' -c "
        select inbound.status,
               (job.id is not null)::text,
               coalesce(job.status, ''),
               coalesce((job.completed_at is not null)::text, 'false'),
               coalesce((job.stream_id = job.conversation_id)::text, 'false'),
               coalesce((job.stream_sequence > 0)::text, 'false'),
               coalesce(job.ordering_source, ''),
               coalesce(job.attempt_count, 0)::text,
               exists (
                 select 1
                   from agent_runtime.executions execution
                  where execution.tenant_id = job.tenant_id
                    and execution.job_id = job.id
                    and execution.status in ('completed', 'fallback')
                    and execution.completed_at is not null
               )::text,
               exists (
                 select 1
                   from pulso_iris.messages response
                  where response.tenant_id = job.tenant_id
                    and response.conversation_id = job.conversation_id
                    and response.sender = 'sofia'
                    and response.provider = 'whatsapp_web_test'
                    and response.external_message_id = 'sofia-job:' || job.id::text
                    and exists (
                      select 1
                        from channel_runtime.outbound_messages outbound
                       where outbound.tenant_id = response.tenant_id
                         and outbound.message_id = response.id
                         and outbound.provider = 'whatsapp_web_test'
                         and outbound.idempotency_key = 'sofia-job:' || job.id::text
                    )
               )::text
          from channel_runtime.inbound_events inbound
          left join agent_runtime.jobs job
            on job.tenant_id = inbound.tenant_id
           and job.inbound_event_id = inbound.id
         where inbound.tenant_id = '$tenant_id'::uuid
           and inbound.id = '$inbound_event_id'::uuid;
      "
  )

  IFS='|' read -r inbound_status job_exists job_status job_completed stream_matches sequence_valid \
    ordering_source attempt_count execution_completed response_enqueued <<<"$state"
  if [[ $inbound_status == "processed" && $job_exists == "true" && $job_status == "completed" && \
        $job_completed == "true" && $stream_matches == "true" && $sequence_valid == "true" && \
        $ordering_source == "legacy_polling_allocator" && $attempt_count =~ ^[1-9][0-9]*$ && \
        $execution_completed == "true" && $response_enqueued == "true" ]]; then
    echo "N-1 SOFIA polling traffic verified against the upgraded schema"
    exit 0
  fi
  sleep 1
done

echo "N-1 SOFIA did not complete representative polling/job traffic against the upgraded schema" >&2
echo "last state: ${state:-missing}" >&2
exit 1
