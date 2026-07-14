#!/usr/bin/env bash

# Verify that a Compose service stops cleanly inside the shutdown budget.
#
# Outbox / durable-event runtimes that should be probed (HTTP or JetStream):
#   whatsapp-channel-service  pulso-iris-service  audit-service  lumen-service  agent-service
#
# Example (HTTP stack already up):
#   bash scripts/ci/verify-compose-graceful-stop.sh \
#     .env.example hyperion-ci-base whatsapp-channel-service 75 infra/docker-compose.yml
#   docker compose --env-file .env.example -p hyperion-ci-base -f infra/docker-compose.yml \
#     up --detach --no-deps --no-build --wait --wait-timeout 120 whatsapp-channel-service
#
# CI smoke currently exercises agent-service (HTTP + JetStream). Operators should
# rehearse Channel, PULSO, Audit and LUMEN with the same script before production
# cutover; compose:check already enforces SHUTDOWN_TIMEOUT_MS / stop_grace_period
# for every node runtime including those four.

set -euo pipefail

if (( $# < 5 )); then
  echo "usage: $0 <env-file> <project-name> <service> <budget-seconds> <compose-file> [compose-file ...]" >&2
  exit 64
fi

env_file=$1
project_name=$2
service=$3
budget_seconds=$4
shift 4

if [[ ! $service =~ ^[a-z0-9][a-z0-9-]{0,62}$ || ! $budget_seconds =~ ^[1-9][0-9]*$ ]]; then
  echo "service and budget must be safe explicit values" >&2
  exit 64
fi

compose=(docker compose --env-file "$env_file" --project-name "$project_name")
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

container_id=$("${compose[@]}" ps --quiet "$service")
if [[ -z $container_id || $(docker inspect "$container_id" --format '{{.State.Running}}') != "true" ]]; then
  echo "$service must be running before the graceful-stop probe" >&2
  exit 1
fi

started_at=$(date +%s)
"${compose[@]}" stop --timeout "$budget_seconds" "$service"
elapsed=$(( $(date +%s) - started_at ))

exit_code=$(docker inspect "$container_id" --format '{{.State.ExitCode}}')
oom_killed=$(docker inspect "$container_id" --format '{{.State.OOMKilled}}')
state_error=$(docker inspect "$container_id" --format '{{.State.Error}}')
if [[ $exit_code != "0" || $oom_killed != "false" || -n $state_error || $elapsed -ge $budget_seconds ]]; then
  echo "$service did not stop cleanly inside ${budget_seconds}s (exit=$exit_code oom=$oom_killed elapsed=${elapsed}s)" >&2
  exit 1
fi

echo "$service stopped cleanly in ${elapsed}s with exit code 0"
