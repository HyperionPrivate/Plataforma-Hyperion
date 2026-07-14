#!/usr/bin/env bash

set -euo pipefail

if (( $# < 5 )); then
  echo "usage: $0 <legacy|current> <env-file> <project-name> <current-migrations-image> <compose-file> [compose-file ...]" >&2
  exit 64
fi

contract=$1
if [[ $contract != "legacy" && $contract != "current" ]]; then
  echo "N-1 LUMEN contract must be legacy or current" >&2
  exit 64
fi
shift

env_file=$1
project_name=$2
current_migrations_image=$3
shift 3

cleanup_scope_id=${LUMEN_N1_CLEANUP_SCOPE_ID:-}
if [[ $contract == "legacy" && -z $cleanup_scope_id ]]; then
  echo "LUMEN_N1_CLEANUP_SCOPE_ID is required for the legacy contract" >&2
  exit 64
fi
compose=(docker compose --env-file "$env_file" --project-name "$project_name")
for compose_file in "$@"; do
  compose+=(-f "$compose_file")
done

postgres_container=$("${compose[@]}" ps --quiet postgres)
lumen_container=$("${compose[@]}" ps --quiet lumen-service)
if [[ -z $postgres_container || -z $lumen_container || -z $current_migrations_image ]]; then
  echo "N-1 LUMEN probe requires running postgres/lumen containers and the current migrations image" >&2
  exit 1
fi

network_json=$(docker inspect "$postgres_container" --format '{{json .NetworkSettings.Networks}}')
n1_network=$(node -e '
  const networks = JSON.parse(process.argv[1]);
  const names = Object.keys(networks);
  if (names.length !== 1) process.exit(1);
  process.stdout.write(names[0]);
' "$network_json")
admin_database_url="postgres://${POSTGRES_USER:-hyperion}:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@postgres:5432/${POSTGRES_DB:-hyperion}"
runtime_database_url=$(
  "${compose[@]}" exec -T lumen-service node -e 'process.stdout.write(process.env.DATABASE_URL ?? "")'
)
if [[ $runtime_database_url != postgres://hyperion_lumen:* ]]; then
  echo "N-1 LUMEN runtime does not use hyperion_lumen" >&2
  exit 1
fi

runtime_cleanup_owner=""
runtime_gateway_token=""
if [[ $contract == "current" ]]; then
  runtime_cleanup_owner=$(
    "${compose[@]}" exec -T lumen-service node -e 'process.stdout.write(process.env.LUMEN_INSTANCE_ID ?? "")'
  )
  if [[ ! $runtime_cleanup_owner =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "Current N-1 LUMEN runtime does not expose a stable cleanup owner" >&2
    exit 1
  fi
  runtime_gateway_token=$(
    "${compose[@]}" exec -T lumen-service node -e \
      'process.stdout.write(process.env.GATEWAY_TO_LUMEN_TOKEN ?? "")'
  )
  if [[ -z $runtime_gateway_token ]]; then
    echo "Current N-1 LUMEN runtime does not expose its gateway edge credential" >&2
    exit 1
  fi
fi

runtime_temp_root=$(
  "${compose[@]}" exec -T lumen-service node -e 'process.stdout.write(process.env.LUMEN_AUDIO_TEMP_DIR ?? "")'
)
if [[ $runtime_temp_root != "/tmp/lumen-audio" ]]; then
  echo "N-1 LUMEN temporary-audio root is outside the attested ephemeral boundary" >&2
  exit 1
fi

# The destruction attestation is valid only for a private container tmpfs, not
# a bind mount or named/persistent volume. Check both the resolved mount and the
# security options Docker will apply before creating any synthetic audio.
docker inspect "$lumen_container" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const container = JSON.parse(input)[0];
    const tmpfs = container?.HostConfig?.Tmpfs ?? {};
    const options = new Set(String(tmpfs["/tmp/lumen-audio"] ?? "").split(","));
    const conflicts = (container?.Mounts ?? []).filter(
      (mount) => mount.Destination === "/tmp/lumen-audio"
    );
    const sizeOptions = [...options].filter((option) => option.startsWith("size="));
    const valid = Object.hasOwn(tmpfs, "/tmp/lumen-audio") && conflicts.length === 0 &&
      ["rw", "noexec", "nosuid", "nodev", "uid=1000", "gid=1000", "mode=0700"]
        .every((option) => options.has(option)) && sizeOptions.length === 1;
    process.exit(valid ? 0 : 1);
  });
'

docker exec "$lumen_container" node --input-type=module -e '
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n");
  const mount = lines.find((line) => line.split(" ")[4] === "/tmp/lumen-audio");
  if (!mount) process.exit(1);
  const [left, right] = mount.split(" - ");
  const mountOptions = new Set(left.split(" ")[5].split(","));
  const fileSystemType = right.split(" ")[0];
  process.exit(
    fileSystemType === "tmpfs" && mountOptions.has("rw") && mountOptions.has("noexec") &&
      mountOptions.has("nosuid") && mountOptions.has("nodev") ? 0 : 1
  );
'

# Prove the exact running N-1 dependency closure uses the restricted identity.
"${compose[@]}" exec -T lumen-service node --input-type=module -e '
  const { createDatabase } = await import("./packages/database/dist/index.js");
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    const result = await db.query("select current_user, session_user");
    const row = result.rows[0];
    if (row?.current_user !== "hyperion_lumen" || row?.session_user !== "hyperion_lumen") {
      throw new Error("unexpected LUMEN database identity");
    }
  } finally {
    await db.close();
  }
'

# Only synthetic identifiers and a one-second silent WAV are used. The N-1
# container has an abort-aware fetch preload, so provider network is impossible.
fixture=$(
  "${compose[@]}" exec -T postgres \
    psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
    -At -F '|' -c "
      create temporary table compatibility_lumen_probe (
        tenant_id uuid not null,
        encounter_id uuid not null,
        operator_id uuid not null,
        idempotency_key uuid not null
      ) on commit preserve rows;

      do \$probe\$
      declare
        probe_tenant_id uuid;
        probe_encounter_id uuid := gen_random_uuid();
        probe_patient_id uuid := gen_random_uuid();
        probe_site_id uuid := gen_random_uuid();
        probe_professional_id uuid := gen_random_uuid();
      begin
        insert into platform.tenants (slug, display_name, status)
        values ('n1-lumen-' || gen_random_uuid()::text, 'N-1 LUMEN synthetic compatibility', 'active')
        returning id into probe_tenant_id;

        insert into lumen.tenant_snapshots (
          tenant_id, status, is_demo, is_active, source_version, source_updated_at, payload_hash
        ) values (probe_tenant_id, 'active', true, true, 1, now(), repeat('a', 64));

        insert into lumen.encounter_reference_snapshots (
          tenant_id, encounter_id, patient_id, site_id, professional_id,
          patient_display_name, professional_name, site_name,
          patient_is_demo, professional_is_demo, source_version, source_updated_at, payload_hash
        ) values (
          probe_tenant_id, probe_encounter_id, probe_patient_id, probe_site_id, probe_professional_id,
          'Paciente sintético', 'Profesional sintético', 'Sede sintética',
          true, true, 1, now(), repeat('b', 64)
        );

        insert into lumen.encounters (
          id, tenant_id, patient_id, professional_id, site_id, scheduled_at,
          is_demo, demo_key, metadata
        ) values (
          probe_encounter_id, probe_tenant_id, probe_patient_id, probe_professional_id,
          probe_site_id, now(), true, 'n1-ci-' || gen_random_uuid()::text, '{\"synthetic\":true}'::jsonb
        );

        insert into compatibility_lumen_probe
        values (probe_tenant_id, probe_encounter_id, gen_random_uuid(), gen_random_uuid());
      end
      \$probe\$;

      select tenant_id, encounter_id, operator_id, idempotency_key
        from compatibility_lumen_probe;
    "
)

IFS='|' read -r tenant_id encounter_id operator_id idempotency_key <<<"$fixture"
for identifier in "$tenant_id" "$encounter_id" "$operator_id" "$idempotency_key"; do
  if [[ ! $identifier =~ ^[0-9a-f-]{36}$ ]]; then
    echo "N-1 LUMEN fixture did not return stable synthetic identifiers" >&2
    exit 1
  fi
done

request_probe='const [contract,tenantId,encounterId,operatorId,idempotencyKey]=process.argv.slice(1);let gatewayToken="";for await(const chunk of process.stdin)gatewayToken+=chunk;gatewayToken=gatewayToken.trim();const sampleRate=8000;const samples=sampleRate;const dataBytes=samples*2;const wav=Buffer.alloc(44+dataBytes);wav.write("RIFF",0);wav.writeUInt32LE(36+dataBytes,4);wav.write("WAVE",8);wav.write("fmt ",12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(sampleRate,24);wav.writeUInt32LE(sampleRate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write("data",36);wav.writeUInt32LE(dataBytes,40);const headers={"content-type":"application/json","x-operator-role":"admin","x-operator-id":operatorId};if(contract==="current"){if(!gatewayToken)throw new Error("missing current LUMEN gateway credential");headers.authorization=`Bearer ${gatewayToken}`;headers["x-hyperion-caller"]="api-gateway";}const response=await fetch(`http://lumen-service:8090/v1/tenants/${tenantId}/lumen/encounters/${encounterId}/transcriptions`,{method:"POST",headers,body:JSON.stringify({audioBase64:wav.toString("base64"),mimeType:"audio/wav",source:"authorized_upload",durationSeconds:1,idempotencyKey})});throw new Error(`N-1 LUMEN request returned unexpectedly with HTTP ${response.status}`);'
probe_container="${project_name}-lumen-audio-probe"
docker rm --force "$probe_container" >/dev/null 2>&1 || true
printf '%s' "$runtime_gateway_token" | \
  docker run --rm --interactive --name "$probe_container" --network "$n1_network" "$current_migrations_image" \
    node --input-type=module -e "$request_probe" \
    "$contract" "$tenant_id" "$encounter_id" "$operator_id" "$idempotency_key" \
    >/dev/null 2>&1 &
request_pid=$!

cleanup_probe() {
  docker rm --force "$probe_container" >/dev/null 2>&1 || true
}
trap cleanup_probe EXIT

attempt_id=""
for _attempt in {1..60}; do
  attempt_state=$(
    "${compose[@]}" exec -T postgres \
      psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
      -At -F '|' -c "
        select id, status, cleanup_protocol, cleanup_scope_id, cleanup_owner
          from lumen.processing_attempts
         where tenant_id = '$tenant_id'::uuid
           and encounter_id = '$encounter_id'::uuid
           and operation = 'transcription'
           and idempotency_key = '$idempotency_key'::uuid;
      "
  )
  IFS='|' read -r attempt_id attempt_status cleanup_protocol observed_scope observed_owner <<<"$attempt_state"
  if [[ $attempt_id =~ ^[0-9a-f-]{36}$ && $attempt_status == "processing" ]]; then
    if [[ $contract == "legacy" && $cleanup_protocol == "legacy_ephemeral_v1" && \
          $observed_scope == "$cleanup_scope_id" ]]; then
      break
    fi
    if [[ $contract == "current" && $cleanup_protocol == "deterministic_v2" && \
          -z $observed_scope && $observed_owner == "$runtime_cleanup_owner" ]]; then
      break
    fi
  fi
  if ! docker container inspect "$probe_container" >/dev/null 2>&1; then
    echo "N-1 LUMEN request ended before the real writer reserved an attempt" >&2
    exit 1
  fi
  sleep 1
done

if [[ ! $attempt_id =~ ^[0-9a-f-]{36}$ || $attempt_status != "processing" ]]; then
  echo "N-1 LUMEN did not persist the expected processing attempt" >&2
  exit 1
fi
if [[ $contract == "legacy" && \
      ($cleanup_protocol != "legacy_ephemeral_v1" || $observed_scope != "$cleanup_scope_id") ]]; then
  echo "N-1 LUMEN did not persist the expected attributed legacy attempt" >&2
  exit 1
fi
if [[ $contract == "current" && \
      ($cleanup_protocol != "deterministic_v2" || -n $observed_scope || \
       $observed_owner != "$runtime_cleanup_owner") ]]; then
  echo "N-1 LUMEN did not persist the expected deterministic cleanup attempt" >&2
  exit 1
fi

# A reserved database row alone does not prove that the old binary staged the
# payload. Wait until the real N-1 writer has created a non-empty private file
# and its provider call has reached the fetch preload. The marker is written by
# the preload instead of opening a socket, so no provider request can escape.
temporary_audio_observed=false
for _attempt in {1..60}; do
  if docker exec "$lumen_container" node --input-type=module -e '
    import { readdir, stat } from "node:fs/promises";
    const [contract, cleanupOwner, attemptId] = process.argv.slice(1);
    const root = process.env.LUMEN_AUDIO_TEMP_DIR ?? "/tmp/lumen-audio";
    let audioFound = false;
    let attemptMarker = false;

    if (contract === "current") {
      const { temporaryAudioRequestDirectory } = await import(
        "./services/lumen-service/dist/temporary-audio.js"
      );
      const { requestDirectory } = temporaryAudioRequestDirectory(root, cleanupOwner, attemptId);
      const files = await readdir(requestDirectory, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile()) continue;
        if (file.name === ".provider-network-blocked") {
          attemptMarker = (await stat(`${requestDirectory}/${file.name}`)).isFile();
          continue;
        }
        if (!file.name.startsWith("audio.")) continue;
        const metadata = await stat(`${requestDirectory}/${file.name}`);
        if (metadata.size > 44) audioFound = true;
      }
    } else {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("request-")) continue;
        const requestDirectory = `${root}/${entry.name}`;
        const files = await readdir(requestDirectory, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (!file.isFile()) continue;
          if (file.name === ".provider-network-blocked") {
            attemptMarker = (await stat(`${requestDirectory}/${file.name}`)).isFile();
            continue;
          }
          if (!file.name.startsWith("audio.")) continue;
          const metadata = await stat(`${requestDirectory}/${file.name}`);
          if (metadata.size > 44) audioFound = true;
        }
      }
    }
    process.exit(attemptMarker && audioFound ? 0 : 1);
  ' "$contract" "$runtime_cleanup_owner" "$attempt_id"; then
    temporary_audio_observed=true
    break
  fi
  sleep 1
done
if [[ $temporary_audio_observed != "true" ]]; then
  echo "N-1 LUMEN never reached its real temporary-audio writer and blocked provider boundary" >&2
  exit 1
fi

if [[ $contract == "current" ]]; then
  # Simulate an abrupt process loss. The private tmpfs disappears with the
  # container; expiring only the dead holder's lease lets the exact N-1 binary
  # reacquire its stable owner and reconcile the interrupted attempt.
  docker update --restart=no "$lumen_container" >/dev/null
  docker kill --signal KILL "$lumen_container" >/dev/null
  docker rm "$lumen_container" >/dev/null
  wait "$request_pid" >/dev/null 2>&1 || true

  "${compose[@]}" exec -T postgres \
    psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
    -c "update lumen.audio_cleanup_owner_leases
           set expires_at = clock_timestamp() - interval '1 second'
         where cleanup_owner = '$runtime_cleanup_owner';" >/dev/null

  "${compose[@]}" up --detach --no-deps --no-build --wait --wait-timeout 120 lumen-service

  recovered=""
  for _attempt in {1..60}; do
    recovered=$(
      "${compose[@]}" exec -T postgres \
        psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
        -At -F '|' -c "
          select status, cleanup_protocol, cleanup_owner,
                 cleanup_disposition, temp_audio_deleted_at is not null,
                 error_code
            from lumen.processing_attempts
           where id = '$attempt_id'::uuid;
        "
    )
    IFS='|' read -r recovered_status recovered_protocol recovered_owner \
      recovered_disposition recovered_deleted recovered_error <<<"$recovered"
    if [[ $recovered_status == "failed" && $recovered_protocol == "deterministic_v2" && \
          $recovered_owner == "$runtime_cleanup_owner" && \
          $recovered_disposition == "deterministic_reconciler" && \
          $recovered_deleted == "t" && $recovered_error == "process_interrupted" ]]; then
      trap - EXIT
      cleanup_probe
      echo "Current N-1 LUMEN deterministic crash recovery verified against the upgraded schema"
      exit 0
    fi
    sleep 1
  done

  echo "Current N-1 LUMEN did not reconcile its interrupted deterministic attempt" >&2
  echo "last state: $recovered" >&2
  exit 1
fi

# Disable restart before SIGKILL, then remove the container. Removal destroys
# its private tmpfs and is the external fact attested below; no path is guessed.
docker update --restart=no "$lumen_container" >/dev/null
docker kill --signal KILL "$lumen_container" >/dev/null
docker rm "$lumen_container" >/dev/null
wait "$request_pid" >/dev/null 2>&1 || true

docker run --rm --network "$n1_network" \
  --env "DATABASE_URL=$admin_database_url" \
  --env "LUMEN_N1_CLEANUP_SCOPE_ID=$cleanup_scope_id" \
  "$current_migrations_image" \
  node packages/migrations/dist/lumen-n-minus-one-compatibility.js close

destroyed_at=$(
  "${compose[@]}" exec -T postgres \
    psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
    -Atc "select clock_timestamp();"
)
attestation_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
scope_evidence_sha256=$(
  printf '%s\n' \
    "scope=$cleanup_scope_id" \
    "removed-container=$lumen_container" \
    "attempt=$attempt_id" \
    "destroyed-at=$destroyed_at" |
    sha256sum | awk '{print $1}'
)

docker run --rm --network "$n1_network" \
  --env "DATABASE_URL=$admin_database_url" \
  --env "LUMEN_N1_CLEANUP_SCOPE_ID=$cleanup_scope_id" \
  --env "LUMEN_N1_SCOPE_DESTRUCTION_CONFIRMED=true" \
  --env "LUMEN_N1_SCOPE_DESTROYED_AT=$destroyed_at" \
  --env "LUMEN_N1_SCOPE_EVIDENCE_SHA256=$scope_evidence_sha256" \
  --env "LUMEN_N1_SCOPE_ATTESTATION_ID=$attestation_id" \
  "$current_migrations_image" \
  node packages/migrations/dist/lumen-n-minus-one-compatibility.js attest-destroyed-scope

verified=$(
  "${compose[@]}" exec -T postgres \
    psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-hyperion}" -d "${POSTGRES_DB:-hyperion}" \
    -Atc "
      select (
        exists (
          select 1 from lumen.processing_attempts
           where id = '$attempt_id'::uuid
             and status = 'failed'
             and cleanup_protocol = 'legacy_ephemeral_v1'
             and cleanup_scope_id = '$cleanup_scope_id'
             and cleanup_disposition = 'ephemeral_scope_destroyed'
             and temp_audio_deleted_at is not null
        )
        and exists (
          select 1 from lumen.legacy_audio_scope_attestations
           where attestation_id = '$attestation_id'::uuid
             and cleanup_scope_id = '$cleanup_scope_id'
             and evidence_sha256 = '$scope_evidence_sha256'
             and finalized_attempt_count = 1
        )
        and exists (
          select 1 from lumen.n_minus_one_compatibility_windows
           where cleanup_scope_id = '$cleanup_scope_id' and closed_at is not null
        )
        and not exists (
          select 1 from lumen.n_minus_one_compatibility_windows where closed_at is null
        )
        and not (select rolcanlogin from pg_roles where rolname = 'hyperion_lumen')
        and not has_schema_privilege('hyperion_lumen', 'platform', 'USAGE')
        and not has_schema_privilege('hyperion_lumen', 'pulso_iris', 'USAGE')
        and not has_table_privilege('hyperion_lumen', 'platform.schema_migrations', 'SELECT')
        and not has_table_privilege('hyperion_lumen', 'platform.audit_events', 'INSERT')
        and not has_table_privilege('hyperion_lumen', 'pulso_iris.administrative_patients', 'SELECT')
        and not has_table_privilege('hyperion_lumen', 'pulso_iris.professionals', 'SELECT')
        and not has_table_privilege('hyperion_lumen', 'pulso_iris.sites', 'SELECT')
        and not has_table_privilege('hyperion_lumen', 'lumen.n_minus_one_compatibility_windows', 'SELECT')
        and not has_table_privilege('hyperion_lumen', 'lumen.legacy_audio_scope_attestations', 'INSERT')
      );
    "
)
if [[ $verified != "t" ]]; then
  echo "N-1 LUMEN close/attestation postconditions were not satisfied" >&2
  exit 1
fi

# NOLOGIN is also exercised as an actual connection denial, not only observed
# through catalog helper functions. Exit 42 means PostgreSQL returned SQLSTATE
# 28000; every tooling, transport or module failure has a distinct failure code.
set +e
docker run --rm --network "$n1_network" --env "DATABASE_URL=$runtime_database_url" \
  "$current_migrations_image" node --input-type=module -e '
    const { createRequire } = await import("node:module");
    const require = createRequire(new URL("./packages/migrations/package.json", import.meta.url));
    const pg = require("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try { await client.connect(); await client.end(); process.exit(0); }
    catch (error) { process.exit(error?.code === "28000" ? 42 : 43); }
  '
connection_probe_status=$?
set -e
if [[ $connection_probe_status -eq 0 ]]; then
  echo "hyperion_lumen unexpectedly connected after the closed rollback fence" >&2
  exit 1
fi
if [[ $connection_probe_status -ne 42 ]]; then
  echo "hyperion_lumen NOLOGIN connection probe failed for an unexpected reason" >&2
  exit 1
fi

trap - EXIT
cleanup_probe
echo "N-1 LUMEN binary writer, ephemeral-scope destruction and attestation verified"
