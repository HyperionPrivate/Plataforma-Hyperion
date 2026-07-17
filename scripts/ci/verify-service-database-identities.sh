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

# Execute the query through the same DATABASE_URL and production dependency
# closure that each runtime image receives. Checking both values catches an
# administrator URL as well as an unexpected SET ROLE/session indirection.
database_identity_probe='const expected=process.argv[1];const {createDatabase}=await import("./packages/database/dist/index.js");const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error("DATABASE_URL is missing");const db=createDatabase(databaseUrl);try{const result=await db.query("select current_user, session_user");if(result.rowCount!==1)throw new Error(`expected one identity row, received ${result.rowCount}`);const row=result.rows[0];if(row.current_user!==expected||row.session_user!==expected)throw new Error(`database identity mismatch: expected ${expected}, current_user=${row.current_user}, session_user=${row.session_user}`);console.log(`database identity verified: ${expected}`);}finally{await db.close();}'

service_roles=(
  identity-service:hyperion_access
  tenant-service:hyperion_access
  agent-service:hyperion_sofia
  prompt-flow-service:hyperion_sofia
  knowledge-service:hyperion_knowledge
  audit-service:hyperion_audit
  integration-service:hyperion_integration
  pulso-iris-service:hyperion_pulso
  whatsapp-channel-service:hyperion_channel
  lumen-service:hyperion_lumen
  nova-core-service:hyperion_nova
  voice-channel-service:hyperion_voice
  liwa-channel-service:hyperion_liwa
  documents-service:hyperion_documents
)

# N-1 / older compose stacks may omit newer owners (nova/voice/liwa/documents).
# Only probe identities for services that are currently running in the project.
mapfile -t running_services < <("${compose[@]}" ps --services --status running)

service_is_running() {
  local candidate=$1
  local running
  for running in "${running_services[@]}"; do
    if [[ "$running" == "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

for service_and_role in "${service_roles[@]}"; do
  service=${service_and_role%%:*}
  expected_role=${service_and_role##*:}
  if ! service_is_running "$service"; then
    echo "skipping ${service} PostgreSQL identity (not running in ${project_name})"
    continue
  fi
  echo "checking ${service} PostgreSQL identity"
  "${compose[@]}" exec -T "$service" \
    node --input-type=module -e "$database_identity_probe" "$expected_role"
done
