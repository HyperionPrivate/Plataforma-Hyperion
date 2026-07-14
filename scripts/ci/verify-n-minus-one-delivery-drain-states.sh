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
drain_probe=(
  bash scripts/ci/n-minus-one-pulso-channel-sql-window.sh
  verify-delivery-drained "$env_file" "$project_name" "$@"
)
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

probe_id=""
cleanup_probe() {
  if [[ -n $probe_id ]]; then
    "${compose[@]}" exec -T postgres \
      psql -X -q -v ON_ERROR_STOP=1 -v probe_id="$probe_id" \
      -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
      -c "delete from channel_runtime.outbox_events where id = :'probe_id'::uuid" >/dev/null
    probe_id=""
  fi
}
trap cleanup_probe EXIT

insert_probe() {
  local status=$1
  probe_id=$(
    "${compose[@]}" exec -T postgres \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -v probe_status="$status" \
      -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
      -c "insert into channel_runtime.outbox_events (
            id, tenant_id, event_type, event_version, aggregate_type, aggregate_id,
            payload, status, occurred_at
          ) values (
            gen_random_uuid(), gen_random_uuid(), 'channel.delivery.updated.v1', 1,
            'n1_delivery_gate_probe', gen_random_uuid(), '{}'::jsonb, :'probe_status', clock_timestamp()
          ) returning id"
  )
  probe_id=${probe_id//$'\r'/}
  if [[ ! $probe_id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo "delivery drain state probe did not create a valid synthetic row" >&2
    exit 1
  fi
}

for status in queued retry_scheduled processing dead_letter; do
  insert_probe "$status"
  if "${drain_probe[@]}" >/dev/null 2>&1; then
    echo "delivery drain gate accepted blocking status $status" >&2
    exit 1
  fi
  cleanup_probe
done

insert_probe published
published_snapshot=$("${drain_probe[@]}")
if [[ ! $published_snapshot =~ ^[0-9]+:[0-9a-f]{32}$ ]]; then
  echo "delivery drain gate did not return a valid snapshot for published rows" >&2
  exit 1
fi
cleanup_probe

echo "delivery drain gate rejected every blocking status and accepted published"
