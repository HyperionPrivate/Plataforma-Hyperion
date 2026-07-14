#!/usr/bin/env bash

set -euo pipefail

if (( $# < 4 )); then
  echo "usage: $0 <open|close> <env-file> <project-name> <compose-file> [compose-file ...]" >&2
  exit 64
fi

mode=$1
env_file=$2
project_name=$3
shift 3

if [[ $mode != "open" && $mode != "close" ]]; then
  echo "mode must be open or close" >&2
  exit 64
fi

compose=(docker compose --env-file "$env_file" --project-name "$project_name")
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

# N-1 PULSO images still mutate channel_runtime.thread_bindings in SQL. Migration
# 040 revokes that path for current images, which correctly bind through Channel
# HTTP. This rehearsal window restores only the exact privileges N-1 needs and
# must never be applied as a durable production grant.
if [[ $mode == "open" ]]; then
  sql=$(
    cat <<'SQL'
grant usage on schema channel_runtime to hyperion_pulso;
grant select, update on table channel_runtime.thread_bindings to hyperion_pulso;
grant update on table channel_runtime.inbound_events to hyperion_pulso;
SQL
  )
  echo "opening N-1 PULSOâ†’Channel SQL compatibility window"
else
  sql=$(
    cat <<'SQL'
revoke select, update on table channel_runtime.thread_bindings from hyperion_pulso;
revoke update on table channel_runtime.inbound_events from hyperion_pulso;
revoke usage on schema channel_runtime from hyperion_pulso;
SQL
  )
  echo "closing N-1 PULSOâ†’Channel SQL compatibility window"
fi

"${compose[@]}" exec -T postgres \
  psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
  -c "$sql"
