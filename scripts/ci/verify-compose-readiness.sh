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
  nova-core-service:8091
  voice-channel-service:8092
  liwa-channel-service:8093
  documents-service:8094
  nova-bff:8095
  lumen-bff:8096
  pulso-bff:8097
  platform-admin-bff:8098
  api-gateway:8080
)

mapfile -t configured_services < <("${compose[@]}" config --services)
declare -A configured=()
for service in "${configured_services[@]}"; do
  configured["$service"]=1
done

has_service() {
  [[ -n ${configured[$1]+configured} ]]
}

"${compose[@]}" ps
if has_service postgres; then
  "${compose[@]}" exec -T postgres pg_isready -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}"
  if has_service nova-migrations; then
    "${compose[@]}" exec -T postgres pg_isready -U "${POSTGRES_USER:-hyperion}" -d "${NOVA_POSTGRES_DB:-hyperion_nova}"
  fi
fi

for service_and_port in "${services[@]}"; do
  service=${service_and_port%%:*}
  port=${service_and_port##*:}
  has_service "$service" || continue
  echo "checking ${service} /health and /ready"
  "${compose[@]}" exec -T "$service" node -e "$node_probe" "$port"
done

if has_service api-gateway; then
  gateway_port=${API_GATEWAY_HOST_PORT:-8080}
  curl --fail --silent --show-error "http://127.0.0.1:${gateway_port}/health" >/dev/null
  curl --fail --silent --show-error "http://127.0.0.1:${gateway_port}/ready" >/dev/null
fi

for console in nova-console lumen-console pulso-console platform-admin-console; do
  has_service "$console" || continue
  "${compose[@]}" exec -T "${console}" wget -q -O /dev/null http://127.0.0.1:8080/healthz
done

if has_service web-console; then
  if has_service nova-console; then
    legacy_console_port=${LEGACY_WEB_CONSOLE_HOST_PORT:-3004}
    "${compose[@]}" exec -T web-console wget -q -O /dev/null http://127.0.0.1:8080/healthz

    legacy_lumen_encounter="11111111-1111-4111-8111-111111111111"
    redirect_headers="$(curl --silent --show-error --dump-header - --output /dev/null \
      "http://127.0.0.1:${legacy_console_port}/lumen/preconsulta?encounter=${legacy_lumen_encounter}")"
    grep -Eiq '^HTTP/[^ ]+ 307' <<<"${redirect_headers}"
    expected_lumen_location="${LUMEN_CONSOLE_ORIGIN:-http://localhost:3002}/lumen/preconsulta?encounter=${legacy_lumen_encounter}"
    grep -Fqi "location: ${expected_lumen_location}" <<<"${redirect_headers}"

    unknown_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      "http://127.0.0.1:${legacy_console_port}/unknown-product-route")"
    [[ "${unknown_status}" == "404" ]]
  else
    legacy_console_port=${WEB_CONSOLE_HOST_PORT:-3000}
    curl --fail --silent --show-error "http://127.0.0.1:${legacy_console_port}/" >/dev/null
  fi
fi
