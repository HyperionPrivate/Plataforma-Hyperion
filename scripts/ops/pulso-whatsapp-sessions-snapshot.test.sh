#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
snapshot_script="${script_directory}/pulso-whatsapp-sessions-snapshot.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/hyperion-pulso-whatsapp-test.XXXXXX")"

cleanup() {
  [[ -n "${test_root:-}" \
    && -d "${test_root}" \
    && "${test_root}" == *hyperion-pulso-whatsapp-test.* ]] \
    && rm -rf -- "${test_root}"
}
trap cleanup EXIT

fail() {
  printf 'PULSO WhatsApp sessions snapshot test failed: %s\n' "$1" >&2
  exit 1
}

bash -n "${snapshot_script}" "$0"
[[ -x "${snapshot_script}" && -x "$0" ]] || fail "WhatsApp snapshot scripts must be executable"
if [[ "${MSYSTEM:-}" == MINGW* ]]; then
  msys_arguments="$(env -i \
    "PATH=${PATH}" "HOME=${HOME}" "LANG=C" "LC_ALL=C" "TZ=UTC" \
    "MSYS_NO_PATHCONV=1" "MSYS2_ARG_CONV_EXCL=*" \
    "USERPROFILE=${USERPROFILE}" "HOMEDRIVE=${HOMEDRIVE}" "HOMEPATH=${HOMEPATH}" \
    node -e 'console.log(process.argv.slice(1).join("|"))' /bin/sh dst=/sessions)"
  [[ "${msys_arguments}" == '/bin/sh|dst=/sessions' ]] \
    || fail "Git Bash rewrote container-only Docker arguments"
fi

mock_bin="${test_root}/mock-bin"
mock_control="${test_root}/mock-control"
mock_volume="${test_root}/mock-volume"
mock_target_volume="${test_root}/mock-target-volume"
tenant_id=11111111-1111-4111-8111-111111111111
mkdir -p -- "${mock_bin}" "${mock_control}" \
  "${mock_volume}/${tenant_id}" \
  "${mock_volume}/.channel-event-spool/tenant-$(printf synthetic-tenant | sha256sum | awk '{ print $1 }')" \
  "${mock_target_volume}"
printf '{"registered":true,"me":{"id":"synthetic:1@s.whatsapp.net"},"account":{"details":"synthetic"}}\n' \
  >"${mock_volume}/${tenant_id}/creds.json"
printf '{"keyData":"c3ludGhldGljLW5vbi1zZWNyZXQ="}\n' \
  >"${mock_volume}/${tenant_id}/app-state-sync-key-synthetic.json"
printf 'synthetic-non-sensitive-spool-record-v1\n' \
  >"${mock_volume}/.channel-event-spool/tenant-$(printf synthetic-tenant | sha256sum | awk '{ print $1 }')/${tenant_id}.evt"
printf 'target-state-before-restore\n' >"${mock_target_volume}/target-before.txt"

cat >"${mock_bin}/install" <<'MOCK_INSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail
target="${*: -1}"
if [[ " $* " == *" -d "* ]]; then
  mkdir -p -- "${target}"
else
  source_file="${@: -2:1}"
  cp -- "${source_file}" "${target}"
  chmod 600 -- "${target}"
fi
MOCK_INSTALL
chmod 700 -- "${mock_bin}/install"

cat >"${mock_bin}/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail

for forbidden in \
  PULSO_POSTGRES_ADMIN_PASSWORD PULSO_DATABASE_PASSWORD NOVA_DATABASE_PASSWORD \
  LUMEN_DATABASE_PASSWORD DOCUMENTS_S3_SECRET_KEY; do
  [[ -z "${!forbidden+x}" ]] || exit 90
done

mock_bin="$(cd -- "$(dirname -- "$0")" && pwd -P)"
test_root="$(cd -- "${mock_bin}/.." && pwd -P)"
control="${test_root}/mock-control"
source_volume_directory="${test_root}/mock-volume"
target_volume_directory="${test_root}/mock-target-volume"
source_project=hyperion-pulso-whatsapp-test-case
target_project=hyperion-pulso-whatsapp-test-target
logical_volume=pulso_whatsapp_sessions
drill_id=20260718t180000z-deadbeef
source_volume="${source_project}_${logical_volume}"
target_volume="${target_project}_${logical_volume}"
image="alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40"
touch "${control}/docker-invoked"

[[ "${MSYS_NO_PATHCONV:-}" == "1" && "${MSYS2_ARG_CONV_EXCL:-}" == "*" ]] || exit 85

if [[ -f "${control}/expected-userprofile" ]]; then
  [[ "${USERPROFILE:-}" == "$(<"${control}/expected-userprofile")" \
    && "${HOMEDRIVE:-}" == "$(<"${control}/expected-homedrive")" \
    && "${HOMEPATH:-}" == "$(<"${control}/expected-homepath")" ]] || exit 88
fi

if [[ "$1" == "context" && "$2" == "show" ]]; then
  printf 'pulso-local-test\n'
  exit 0
fi
if [[ "$1" == "context" && "$2" == "inspect" ]]; then
  [[ "$3" == "pulso-local-test" ]] || exit 87
  if [[ -e "${control}/remote-endpoint" ]]; then
    printf 'ssh://unsafe.example/run/docker.sock\n'
  else
    printf 'unix:///var/run/docker.sock\n'
  fi
  exit 0
fi
if [[ "$1" == "--host" ]]; then
  [[ "$2" == "unix:///var/run/docker.sock" ]] || exit 86
  shift 2
fi
arguments=" $* "

if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  [[ "${*: -1}" == "${image}" ]] || exit 89
  printf '%s\n' "${image}"
  exit 0
fi

if [[ "$1" == "volume" && "$2" == "ls" ]]; then
  [[ "${arguments}" == *" label=com.docker.compose.volume=${logical_volume} "* ]] || exit 91
  if [[ "${arguments}" == *" label=com.docker.compose.project=${source_project} "* ]]; then
    volume="${source_volume}"
  elif [[ "${arguments}" == *" label=com.docker.compose.project=${target_project} "* ]]; then
    volume="${target_volume}"
  else
    exit 91
  fi
  if [[ -e "${control}/foreign-volume" ]]; then
    printf 'foreign_whatsapp_sessions\n'
  else
    printf '%s\n' "${volume}"
  fi
  exit 0
fi

if [[ "$1" == "volume" && "$2" == "inspect" ]]; then
  volume="${*: -1}"
  if [[ "${volume}" == "${source_volume}" ]]; then
    project="${source_project}"
  elif [[ "${volume}" == "${target_volume}" ]]; then
    project="${target_project}"
  else
    exit 92
  fi
  if [[ -e "${control}/foreign-driver" ]]; then
    printf '%s|%s|%s|local|global|{"device":"shared"}\n' \
      "${project}" "${logical_volume}" "${volume}"
  else
    printf '%s|%s|%s|local|local|null\n' "${project}" "${logical_volume}" "${volume}"
  fi
  exit 0
fi

if [[ "$1" == "ps" ]]; then
  [[ "${arguments}" == *" volume=${source_volume} "* \
    || "${arguments}" == *" volume=${target_volume} "* ]] || exit 93
  if [[ "${arguments}" == *" -a "* && -e "${control}/attached" ]]; then
    printf 'stopped-container\n'
  elif [[ "${arguments}" != *" -a "* && -e "${control}/running" ]]; then
    printf 'running-container\n'
  fi
  exit 0
fi

[[ "$1" == "run" ]] || exit 64
[[ "${arguments}" == *" --pull=never "* \
  && "${arguments}" == *" --name hyperion-pulso-wa-${drill_id}-wrapper "* \
  && "${arguments}" == *" --network none "* \
  && "${arguments}" == *" --read-only "* \
  && "${arguments}" == *" --cap-drop ALL "* \
  && "${arguments}" == *" --security-opt no-new-privileges "* \
  && "${arguments}" == *" --label com.hyperion.recovery-drill=${drill_id} "* \
  && "${arguments}" == *" --label com.hyperion.recovery-kind=pulso-whatsapp "* \
  && "${arguments}" == *" --entrypoint /bin/"* \
  && "${arguments}" == *" ${image} "* ]] || exit 94
[[ "${arguments}" != *"pulso_postgres_data"* \
  && "${arguments}" != *"src=whatsapp_sessions,"* \
  && "${arguments}" != *"nova"* \
  && "${arguments}" != *"lumen"* ]] || exit 95

volume=""
volume_directory=""
if [[ "${arguments}" == *"src=${target_volume},"* ]]; then
  volume="${target_volume}"
  volume_directory="${target_volume_directory}"
elif [[ "${arguments}" == *"src=${source_volume},"* ]]; then
  volume="${source_volume}"
  volume_directory="${source_volume_directory}"
fi

if [[ "${arguments}" == *"restore_preflight=reserved-paths"* ]]; then
  [[ "${arguments}" == *" --user 1000:1000 "* \
    && "${arguments}" == *" type=volume,src=${volume},dst=/sessions,readonly "* ]] || exit 96
  [[ ! -e "${control}/unfinished-restore" ]] || exit 102
elif [[ "${arguments}" == *" --entrypoint /bin/tar "* \
  && "${arguments}" == *" ${image} -C /sessions -czf - . "* ]]; then
  [[ "${arguments}" == *" --user 1000:1000 "* \
    && "${arguments}" == *" type=volume,src=${volume},dst=/sessions,readonly "* ]] || exit 96
  tar -C "${volume_directory}" -czf - .
elif [[ "${arguments}" == *" --entrypoint /bin/tar "* \
  && "${arguments}" == *" ${image} -tzf - "* ]]; then
  tar -tzf -
elif [[ "${arguments}" == *" --entrypoint /bin/tar "* \
  && "${arguments}" == *" ${image} -tvzf - "* ]]; then
  tar -tvzf -
elif [[ "${arguments}" == *"install -d -m 700 /work/snapshot"* ]]; then
  [[ "${arguments}" == *" --entrypoint /bin/sh "* ]] || exit 99
  archive_staging="$(mktemp -d "${test_root}/mock-archive.XXXXXX")"
  trap 'rm -rf -- "${archive_staging}"' EXIT
  tar -xzf - -C "${archive_staging}"
  cd -- "${archive_staging}"
  find . -mindepth 1 -type f -exec sha256sum {} \; | LC_ALL=C sort
elif [[ "${arguments}" == *"inventory_mode=live"* ]]; then
  [[ "${arguments}" == *" --user 1000:1000 "* \
    && "${arguments}" == *" --entrypoint /bin/sh "* \
    && "${arguments}" == *" type=volume,src=${volume},dst=/sessions,readonly "* ]] || exit 97
  cd -- "${volume_directory}"
  find . -mindepth 1 -type f -exec sha256sum {} \; | LC_ALL=C sort
elif [[ "${arguments}" == *"phase=extracting"* ]]; then
  [[ "${arguments}" == *" type=volume,src=${volume},dst=/sessions "* \
    && "${arguments}" == *" --entrypoint /bin/sh "* \
    && "${arguments}" == *" --cap-add CHOWN "* \
    && "${arguments}" == *" --cap-add DAC_OVERRIDE "* \
    && "${arguments}" == *" --cap-add FOWNER "* ]] || exit 98
  restore_staging="$(mktemp -d "${test_root}/mock-restore.XXXXXX")"
  previous_directory="${control}/previous-${volume}"
  rm -rf -- "${previous_directory}"
  mkdir -p -- "${previous_directory}"
  cp -a -- "${volume_directory}/." "${previous_directory}/"
  if [[ -e "${control}/fail-after-prepare" ]]; then
    touch "${control}/main-restore-failed-${volume}"
    exit 104
  fi
  trap 'rm -rf -- "${restore_staging}"' EXIT
  tar -xzf - -C "${restore_staging}"
  find "${volume_directory}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  cp -a -- "${restore_staging}/." "${volume_directory}/"
  if [[ -e "${control}/force-post-restore-mismatch" ]]; then
    printf 'mismatch\n' >"${volume_directory}/post-restore-mismatch.txt"
  fi
elif [[ "${arguments}" == *"rollback_mode=external"* ]]; then
  previous_directory="${control}/previous-${volume}"
  [[ -d "${previous_directory}" ]] || exit 3
  if [[ -e "${control}/rollback-fails" ]]; then
    touch "${control}/rollback-failed-${volume}"
    exit 103
  fi
  find "${volume_directory}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  cp -a -- "${previous_directory}/." "${volume_directory}/"
  rm -rf -- "${previous_directory}"
  touch "${control}/rollback-invoked-${volume}"
elif [[ "${arguments}" == *"test -z \"\$(find \"\$staging\" -mindepth 1 -print -quit)\""* ]]; then
  previous_directory="${control}/previous-${volume}"
  [[ -d "${previous_directory}" ]] || exit 101
  rm -rf -- "${previous_directory}"
  touch "${control}/commit-invoked-${volume}"
else
  printf 'Unexpected mock Docker invocation: %s\n' "${arguments}" >&2
  exit 64
fi
MOCK_DOCKER
chmod 700 -- "${mock_bin}/docker"

project=hyperion-pulso-whatsapp-test-case
volume="${project}_pulso_whatsapp_sessions"
target_project=hyperion-pulso-whatsapp-test-target
target_volume="${target_project}_pulso_whatsapp_sessions"
snapshot_root="${test_root}/backups/pulso/whatsapp-sessions"
snapshot_image=alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
timestamp=20260718T180000Z
common_environment=(
  PATH="${mock_bin}:${PATH}"
  PULSO_OPS_TEST_MODE=1
  PULSO_OPS_TEST_ROOT="${test_root}"
  PULSO_WHATSAPP_BACKUP_DIR="${snapshot_root}"
  PULSO_WHATSAPP_COMPOSE_PROJECT="${project}"
  PULSO_WHATSAPP_SNAPSHOT_IMAGE="${snapshot_image}"
  PULSO_WHATSAPP_EXPECTED_DOCKER_ENDPOINT=unix:///var/run/docker.sock
  PULSO_WHATSAPP_DRILL_ID=20260718t180000z-deadbeef
  PULSO_POSTGRES_ADMIN_PASSWORD=forbidden
  PULSO_DATABASE_PASSWORD=forbidden
  NOVA_DATABASE_PASSWORD=forbidden
  LUMEN_DATABASE_PASSWORD=forbidden
  DOCUMENTS_S3_SECRET_KEY=forbidden
)

if [[ -n "${USERPROFILE+x}" ]]; then
  printf '%s' "${USERPROFILE}" >"${mock_control}/expected-userprofile"
  printf '%s' "${HOMEDRIVE}" >"${mock_control}/expected-homedrive"
  printf '%s' "${HOMEPATH}" >"${mock_control}/expected-homepath"
fi

for docker_override in \
  DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS DOCKER_TLS_VERIFY; do
  rm -f -- "${mock_control}/docker-invoked"
  if env "${common_environment[@]}" "${docker_override}=forbidden" \
    PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T175959Z \
    bash "${snapshot_script}" export >/dev/null 2>&1; then
    fail "snapshot accepted Docker routing override ${docker_override}"
  fi
  [[ ! -e "${mock_control}/docker-invoked" ]] \
    || fail "snapshot invoked Docker before rejecting ${docker_override}"
done

touch "${mock_control}/remote-endpoint"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T175958Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "snapshot accepted a remote Docker endpoint"
fi
rm -f -- "${mock_control}/remote-endpoint"

if env "${common_environment[@]}" \
  PULSO_WHATSAPP_EXPECTED_DOCKER_ENDPOINT=unix:///another/docker.sock \
  PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T175957Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "snapshot accepted a Docker endpoint different from the runner-sealed endpoint"
fi

grep -F 'previous=/sessions/.hyperion-restore-previous' "${snapshot_script}" >/dev/null \
  || fail "restore does not retain the previous session state"
grep -F 'trap preserve_failed_transaction EXIT' "${snapshot_script}" >/dev/null \
  || fail "restore helper does not preserve a failed transaction for host rollback"
grep -F 'promoting|prepared)' "${snapshot_script}" >/dev/null \
  || fail "restore does not distinguish promotion from archival rollback"
grep -F 'restore_transaction_active=1' "${snapshot_script}" >/dev/null \
  || fail "restore does not arm host rollback before the destructive helper"
grep -F 'rollback_mode=external' "${snapshot_script}" >/dev/null \
  || fail "restore does not expose its owned external rollback transaction"
if grep -F '|| true' "${snapshot_script}" >/dev/null; then
  fail "restore still ignores a rollback mutation failure"
fi
grep -F 'mv -T -- "${temporary_directory}" "${final_directory}"' "${snapshot_script}" >/dev/null \
  || fail "snapshot publication can still nest into a concurrently published bundle"

# Execute the exact phase-aware rollback body from the production wrapper on a
# private host directory. Only the fixed /sessions mountpoint is substituted.
external_rollback_script="$(awk '
  /rollback_mode=external/ { capture=1 }
  capture && /hyperion-restore-rollback/ { exit }
  capture { sub(/^      /, ""); print }
' "${snapshot_script}")"
[[ "${external_rollback_script}" == rollback_mode=external* \
  && "${external_rollback_script}" == *'remove_live_children'* \
  && "${external_rollback_script}" == *'move_children "$previous" /sessions'* ]] \
  || fail "could not extract the exact external rollback helper"
phase_bin="${test_root}/phase-bin"
mkdir -p -- "${phase_bin}"
phase_real_mv="$(command -v mv)"
phase_real_rm="$(command -v rm)"
phase_real_sync="$(command -v sync)"
cat >"${phase_bin}/mv" <<'PHASE_MV'
#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "$@"; do
  if [[ -n "${PHASE_FAIL_MV_BASENAME:-}" && "${argument##*/}" == "${PHASE_FAIL_MV_BASENAME}" ]]; then
    exit 42
  fi
done
exec "${PHASE_REAL_MV}" "$@"
PHASE_MV
cat >"${phase_bin}/rm" <<'PHASE_RM'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${PHASE_FAIL_RM_MATCH:-}" && " $* " == *"${PHASE_FAIL_RM_MATCH}"* ]]; then
  exit 43
fi
exec "${PHASE_REAL_RM}" "$@"
PHASE_RM
cat >"${phase_bin}/sync" <<'PHASE_SYNC'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${PHASE_FAIL_SYNC:-0}" != "1" ]] || exit 44
exec "${PHASE_REAL_SYNC}" "$@"
PHASE_SYNC
chmod 700 -- "${phase_bin}/mv" "${phase_bin}/rm" "${phase_bin}/sync"
phase_transaction="$(printf 'a%.0s' {1..64})"

prepare_rollback_phase() {
  local phase="$1"
  local root="$2"
  local sessions="${root}/sessions"
  mkdir -p -- "${sessions}/.hyperion-restore-lock" \
    "${sessions}/.hyperion-restore-staging" "${sessions}/.hyperion-restore-previous"
  printf '%s\n' "${phase_transaction}" >"${sessions}/.hyperion-restore-lock/transaction"
  printf '%s\n' "${phase}" >"${sessions}/.hyperion-restore-lock/phase"
  case "${phase}" in
    extracting)
      printf 'old-live\n' >"${sessions}/old-live.txt"
      printf 'partial-new\n' >"${sessions}/.hyperion-restore-staging/new.txt"
      ;;
    archiving)
      printf 'old-a\n' >"${sessions}/.hyperion-restore-previous/old-a.txt"
      printf 'old-b\n' >"${sessions}/old-b.txt"
      printf 'new\n' >"${sessions}/.hyperion-restore-staging/new.txt"
      ;;
    promoting|prepared)
      printf 'old-a\n' >"${sessions}/.hyperion-restore-previous/old-a.txt"
      printf 'old-b\n' >"${sessions}/.hyperion-restore-previous/old-b.txt"
      printf 'new-live\n' >"${sessions}/new-live.txt"
      ;;
    *) fail "unknown rollback phase fixture: ${phase}" ;;
  esac
}

run_extracted_rollback() {
  local root="$1"
  shift
  local sessions="${root}/sessions"
  local phase_script="${external_rollback_script//\/sessions/${sessions}}"
  env "PATH=${phase_bin}:${PATH}" \
    "PHASE_REAL_MV=${phase_real_mv}" "PHASE_REAL_RM=${phase_real_rm}" "PHASE_REAL_SYNC=${phase_real_sync}" \
    "$@" bash -eu -c "${phase_script}" phase-rollback "${phase_transaction}"
}

for rollback_phase in extracting archiving promoting prepared; do
  rollback_root="${test_root}/phase-success-${rollback_phase}"
  prepare_rollback_phase "${rollback_phase}" "${rollback_root}"
  run_extracted_rollback "${rollback_root}"
  rollback_sessions="${rollback_root}/sessions"
  [[ ! -e "${rollback_sessions}/.hyperion-restore-lock" \
    && ! -e "${rollback_sessions}/.hyperion-restore-staging" \
    && ! -e "${rollback_sessions}/.hyperion-restore-previous" ]] \
    || fail "${rollback_phase} rollback retained transaction paths after success"
  if [[ "${rollback_phase}" == "extracting" ]]; then
    grep -Fx old-live "${rollback_sessions}/old-live.txt" >/dev/null \
      || fail "extracting rollback changed the live state"
  else
    grep -Fx old-a "${rollback_sessions}/old-a.txt" >/dev/null \
      || fail "${rollback_phase} rollback lost old-a"
    grep -Fx old-b "${rollback_sessions}/old-b.txt" >/dev/null \
      || fail "${rollback_phase} rollback lost old-b"
    [[ ! -e "${rollback_sessions}/new-live.txt" ]] \
      || fail "${rollback_phase} rollback retained promoted content"
  fi
done

rollback_root="${test_root}/phase-failed-mv"
prepare_rollback_phase promoting "${rollback_root}"
if run_extracted_rollback "${rollback_root}" PHASE_FAIL_MV_BASENAME=old-b.txt >/dev/null 2>&1; then
  fail "phase rollback ignored a partial mv failure"
fi
[[ -f "${rollback_root}/sessions/old-a.txt" \
  && -f "${rollback_root}/sessions/.hyperion-restore-previous/old-b.txt" \
  && -d "${rollback_root}/sessions/.hyperion-restore-lock" ]] \
  || fail "partial mv failure deleted the remaining previous state or its lock"

rollback_root="${test_root}/phase-failed-rm"
prepare_rollback_phase promoting "${rollback_root}"
if run_extracted_rollback "${rollback_root}" PHASE_FAIL_RM_MATCH=new-live.txt >/dev/null 2>&1; then
  fail "phase rollback ignored a live-state rm failure"
fi
[[ -f "${rollback_root}/sessions/new-live.txt" \
  && -f "${rollback_root}/sessions/.hyperion-restore-previous/old-a.txt" \
  && -f "${rollback_root}/sessions/.hyperion-restore-previous/old-b.txt" ]] \
  || fail "rm failure altered the retained previous state"

rollback_root="${test_root}/phase-failed-sync"
prepare_rollback_phase promoting "${rollback_root}"
if run_extracted_rollback "${rollback_root}" PHASE_FAIL_SYNC=1 >/dev/null 2>&1; then
  fail "phase rollback ignored a sync failure"
fi
[[ -f "${rollback_root}/sessions/old-a.txt" \
  && -f "${rollback_root}/sessions/old-b.txt" \
  && -d "${rollback_root}/sessions/.hyperion-restore-lock" \
  && -d "${rollback_root}/sessions/.hyperion-restore-previous" ]] \
  || fail "sync failure discarded the recovered state or transaction evidence"

export_output="$(env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP="${timestamp}" \
  bash "${snapshot_script}" export)"
snapshot_directory="${snapshot_root}/pulso-whatsapp-sessions-${timestamp}"
for snapshot_file in sessions.tar.gz inventory.tsv project volume archive.sha256 bundle.sha256; do
  [[ -f "${snapshot_directory}/${snapshot_file}" && ! -L "${snapshot_directory}/${snapshot_file}" ]] \
    || fail "export did not publish ${snapshot_file}"
done
archive_sha="$(awk -F= '$1 == "WHATSAPP_SESSIONS_ARCHIVE_SHA256" { print $2 }' <<<"${export_output}")"
inventory_sha="$(awk -F= '$1 == "WHATSAPP_SESSIONS_INVENTORY_SHA256" { print $2 }' <<<"${export_output}")"
bundle_sha="$(awk -F= '$1 == "WHATSAPP_SESSIONS_BUNDLE_SHA256" { print $2 }' <<<"${export_output}")"
[[ "${archive_sha}" =~ ^[a-f0-9]{64}$ \
  && "${inventory_sha}" =~ ^[a-f0-9]{64}$ \
  && "${bundle_sha}" =~ ^[a-f0-9]{64}$ ]] || fail "export did not report valid SHA-256 values"
grep -F "WHATSAPP_SESSIONS_VOLUME=${volume}" <<<"${export_output}" >/dev/null \
  || fail "export did not report the exact PULSO volume"
[[ "$(<"${snapshot_directory}/archive.sha256")" == "${archive_sha}" ]] \
  || fail "stored archive SHA differs from export output"

printf '{"registered":false,"syntheticMutation":true}\n' >"${mock_volume}/${tenant_id}/creds.json"
confirmation="RESTORE PULSO WHATSAPP ${project}/${volume} BUNDLE SHA256 ${bundle_sha}"
restore_output="$(env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${confirmation}" \
  bash "${snapshot_script}" restore)"
grep -F '"registered":true' "${mock_volume}/${tenant_id}/creds.json" >/dev/null \
  || fail "restore did not recover the exported session content"
grep -F "WHATSAPP_SESSIONS_INVENTORY_SHA256=${inventory_sha}" <<<"${restore_output}" >/dev/null \
  || fail "restore did not verify the recovered inventory"
[[ -e "${mock_control}/commit-invoked-${volume}" ]] \
  || fail "restore discarded no retained previous state after inventory validation"

restore_as_confirmation="RESTORE PULSO WHATSAPP ${project}/${volume} AS ${target_project}/${target_volume} BUNDLE SHA256 ${bundle_sha}"
restore_as_output="$(env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_TARGET_PROJECT="${target_project}" \
  PULSO_WHATSAPP_RESTORE_TARGET_VOLUME="${target_volume}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${restore_as_confirmation}" \
  bash "${snapshot_script}" restore)"
grep -F '"registered":true' "${mock_target_volume}/${tenant_id}/creds.json" >/dev/null \
  || fail "restore-as did not recover the source bundle into the isolated target"
grep -F "WHATSAPP_SESSIONS_SOURCE_VOLUME=${volume}" <<<"${restore_as_output}" >/dev/null \
  || fail "restore-as did not preserve the bundle source identity"
grep -F "WHATSAPP_SESSIONS_VOLUME=${target_volume}" <<<"${restore_as_output}" >/dev/null \
  || fail "restore-as did not report the exact isolated target"
grep -F 'WHATSAPP_SESSIONS_RESTORE_AS=true' <<<"${restore_as_output}" >/dev/null \
  || fail "restore-as did not report its drill-only mode"

find "${mock_target_volume}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
printf 'target-state-before-mismatch\n' >"${mock_target_volume}/target-before.txt"
rm -f -- "${mock_control}/rollback-invoked-${target_volume}"
touch "${mock_control}/force-post-restore-mismatch"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_TARGET_PROJECT="${target_project}" \
  PULSO_WHATSAPP_RESTORE_TARGET_VOLUME="${target_volume}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${restore_as_confirmation}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore-as accepted a post-restore inventory mismatch"
fi
rm -f -- "${mock_control}/force-post-restore-mismatch"
grep -F 'target-state-before-mismatch' "${mock_target_volume}/target-before.txt" >/dev/null \
  || fail "post-inventory failure did not restore the previous target state"
[[ -e "${mock_control}/rollback-invoked-${target_volume}" ]] \
  || fail "post-inventory failure did not invoke the real rollback phase"

find "${mock_target_volume}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
printf 'target-state-before-interrupted-helper\n' >"${mock_target_volume}/target-before.txt"
rm -f -- "${mock_control}/rollback-invoked-${target_volume}"
touch "${mock_control}/fail-after-prepare"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_TARGET_PROJECT="${target_project}" \
  PULSO_WHATSAPP_RESTORE_TARGET_VOLUME="${target_volume}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${restore_as_confirmation}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore-as accepted an interrupted destructive helper"
fi
rm -f -- "${mock_control}/fail-after-prepare"
grep -F 'target-state-before-interrupted-helper' "${mock_target_volume}/target-before.txt" >/dev/null \
  || fail "host rollback was not armed before the destructive helper returned"
[[ -e "${mock_control}/rollback-invoked-${target_volume}" ]] \
  || fail "interrupted destructive helper did not invoke host rollback"

find "${mock_target_volume}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
printf 'target-state-retained-for-manual-recovery\n' >"${mock_target_volume}/target-before.txt"
rm -f -- "${mock_control}/commit-invoked-${target_volume}" \
  "${mock_control}/rollback-failed-${target_volume}"
touch "${mock_control}/force-post-restore-mismatch" "${mock_control}/rollback-fails"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_TARGET_PROJECT="${target_project}" \
  PULSO_WHATSAPP_RESTORE_TARGET_VOLUME="${target_volume}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${restore_as_confirmation}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore-as accepted a failed rollback"
fi
rm -f -- "${mock_control}/force-post-restore-mismatch" "${mock_control}/rollback-fails"
grep -F 'target-state-retained-for-manual-recovery' \
  "${mock_control}/previous-${target_volume}/target-before.txt" >/dev/null \
  || fail "failed rollback deleted or altered the retained previous state"
[[ -e "${mock_control}/rollback-failed-${target_volume}" \
  && ! -e "${mock_control}/commit-invoked-${target_volume}" ]] \
  || fail "failed rollback reached commit or did not report its failure"
rm -rf -- "${mock_control}/previous-${target_volume}"

printf '%s\n' "${target_project}" >"${snapshot_directory}/project"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_TARGET_PROJECT="${target_project}" \
  PULSO_WHATSAPP_RESTORE_TARGET_VOLUME="${target_volume}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${restore_as_confirmation}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore-as accepted a bundle with a changed source project identity"
fi
printf '%s\n' "${project}" >"${snapshot_directory}/project"

rm -f -- "${mock_control}/docker-invoked"
if env "${common_environment[@]}" \
  PULSO_OPS_TEST_MODE=0 \
  PULSO_WHATSAPP_RESTORE_TARGET_PROJECT="${target_project}" \
  PULSO_WHATSAPP_RESTORE_TARGET_VOLUME="${target_volume}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "production mode accepted restore-as"
fi
[[ ! -e "${mock_control}/docker-invoked" ]] \
  || fail "production restore-as reached Docker before failing closed"

rm -f -- "${mock_control}/docker-invoked"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_RESTORE_TARGET_PROJECT="${target_project}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore-as accepted an incomplete target identity"
fi
[[ ! -e "${mock_control}/docker-invoked" ]] \
  || fail "incomplete restore-as identity reached Docker"

if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM='RESTORE PULSO WHATSAPP' \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore accepted a non-exact destructive confirmation"
fi

wrong_sha="$(printf 'f%.0s' {1..64})"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${wrong_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${confirmation}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore accepted an incorrect archive SHA"
fi

touch "${mock_control}/attached"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${confirmation}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore accepted a volume still referenced by a container"
fi
rm -f -- "${mock_control}/attached"

touch "${mock_control}/running"
if env "${common_environment[@]}" PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T180001Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "export accepted a volume used by a running container"
fi
rm -f -- "${mock_control}/running"

touch "${mock_control}/foreign-volume"
if env "${common_environment[@]}" PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T180002Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "export accepted a foreign or ambiguously labelled volume"
fi
rm -f -- "${mock_control}/foreign-volume"

touch "${mock_control}/foreign-driver"
if env "${common_environment[@]}" PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T180005Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "export accepted a shared, option-backed, or non-local volume identity"
fi
rm -f -- "${mock_control}/foreign-driver"

touch "${mock_control}/unfinished-restore"
if env "${common_environment[@]}" PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T180006Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "export accepted an unfinished restore transaction"
fi
rm -f -- "${mock_control}/unfinished-restore"

if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_IMAGE=alpine:latest \
  PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T180003Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "export accepted an unpinned helper image"
fi

rm -f -- "${mock_control}/docker-invoked"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_IMAGE=alpine@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP=20260718T180004Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "export accepted a pinned helper absent from the approved catalog"
fi
[[ ! -e "${mock_control}/docker-invoked" ]] \
  || fail "snapshot invoked Docker before rejecting an unapproved helper"

outside_directory="${test_root}/outside/pulso-whatsapp-sessions-${timestamp}"
mkdir -p -- "${outside_directory}"
if env "${common_environment[@]}" \
  PULSO_WHATSAPP_SNAPSHOT_DIRECTORY="${outside_directory}" \
  PULSO_WHATSAPP_ARCHIVE_SHA256="${archive_sha}" \
  PULSO_WHATSAPP_BUNDLE_SHA256="${bundle_sha}" \
  PULSO_WHATSAPP_RESTORE_CONFIRM="${confirmation}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore accepted a snapshot directory outside its dedicated root"
fi

printf 'PULSO WhatsApp sessions snapshot export/restore hooks passed.\n'
