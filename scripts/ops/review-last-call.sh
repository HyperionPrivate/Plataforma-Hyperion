#!/bin/bash
set -euo pipefail

tenant_id="${1:-${TENANT_ID:-}}"
uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

if [[ -z "$tenant_id" ]]; then
  echo "Usage: $0 <tenant-uuid> (or set TENANT_ID)" >&2
  exit 64
fi

if [[ ! "$tenant_id" =~ $uuid_pattern ]]; then
  echo "ERROR: tenant_id must be a canonical UUID." >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sql_file="$script_dir/review-last-call.sql"

docker exec -i plataforma-hyperion-postgres-1 \
  psql -U hyperion -d hyperion -v ON_ERROR_STOP=1 -v "tenant_id=$tenant_id" -f - < "$sql_file"
