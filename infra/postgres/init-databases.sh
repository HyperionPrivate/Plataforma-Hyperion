#!/bin/bash
set -euo pipefail

# psql defaults to a DB named like POSTGRES_USER; connect to POSTGRES_DB instead.
PSQL=(psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${POSTGRES_DB:-postgres}")

"${PSQL[@]}" <<-EOSQL
CREATE DATABASE db_pilot_core;
CREATE DATABASE db_whatsapp;
CREATE DATABASE db_documents;
CREATE DATABASE db_handoff;
EOSQL

PILOT_PASS="${PILOT_CORE_DB_PASSWORD:-CHANGE_ME_pilot_core}"
WA_PASS="${WHATSAPP_DB_PASSWORD:-CHANGE_ME_whatsapp}"
DOC_PASS="${DOCUMENTS_DB_PASSWORD:-CHANGE_ME_documents}"
HO_PASS="${HANDOFF_DB_PASSWORD:-CHANGE_ME_handoff}"

"${PSQL[@]}" <<-EOSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_pilot_core') THEN
    CREATE ROLE app_pilot_core LOGIN PASSWORD '${PILOT_PASS}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_whatsapp') THEN
    CREATE ROLE app_whatsapp LOGIN PASSWORD '${WA_PASS}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_documents') THEN
    CREATE ROLE app_documents LOGIN PASSWORD '${DOC_PASS}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_handoff') THEN
    CREATE ROLE app_handoff LOGIN PASSWORD '${HO_PASS}';
  END IF;
END
\$\$;
EOSQL

grant_db() {
  local db="$1"
  local role="$2"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
    REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
    GRANT CONNECT, CREATE, TEMP ON DATABASE ${db} TO ${role};
    GRANT USAGE, CREATE ON SCHEMA public TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role};
EOSQL
}

grant_db db_pilot_core app_pilot_core
grant_db db_whatsapp app_whatsapp
grant_db db_documents app_documents
grant_db db_handoff app_handoff

# Explicit: no cross grants
"${PSQL[@]}" <<-EOSQL
REVOKE ALL ON DATABASE db_whatsapp FROM app_pilot_core;
REVOKE ALL ON DATABASE db_documents FROM app_pilot_core;
REVOKE ALL ON DATABASE db_handoff FROM app_pilot_core;
REVOKE ALL ON DATABASE db_pilot_core FROM app_whatsapp;
REVOKE ALL ON DATABASE db_pilot_core FROM app_documents;
REVOKE ALL ON DATABASE db_pilot_core FROM app_handoff;
EOSQL

echo "init-databases: unit DBs + least-privilege roles ready"
