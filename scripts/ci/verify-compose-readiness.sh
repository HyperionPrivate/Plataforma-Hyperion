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

node_probe='const port=process.argv[1]; const run=async()=>{for(const path of ["health","ready"]){const response=await fetch(`http://127.0.0.1:${port}/${path}`);if(!response.ok)throw new Error(`${path} returned HTTP ${response.status}`);const body=await response.json();if(body.status!=="ok")throw new Error(`${path} reported ${JSON.stringify(body)}`);}};run().catch((error)=>{console.error(error.message);process.exit(1);});'

services=(
  identity-service:8081
  tenant-service:8082
  agent-service:8083
  prompt-flow-service:8084
  knowledge-service:8085
  audit-service:8086
  integration-service:8087
  pulso-iris-service:8088
  whatsapp-channel-service:8089
  lumen-service:8090
  api-gateway:8080
)

"${compose[@]}" ps
"${compose[@]}" exec -T postgres pg_isready -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}"

for service_and_port in "${services[@]}"; do
  service=${service_and_port%%:*}
  port=${service_and_port##*:}
  echo "checking ${service} /health and /ready"
  "${compose[@]}" exec -T "$service" node -e "$node_probe" "$port"
done

gateway_port=${API_GATEWAY_HOST_PORT:-8080}
console_port=${WEB_CONSOLE_HOST_PORT:-3000}
curl --fail --silent --show-error "http://127.0.0.1:${gateway_port}/health" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${gateway_port}/ready" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${console_port}/" >/dev/null
"${compose[@]}" exec -T web-console wget -q -O /dev/null http://127.0.0.1:8080/
