#!/usr/bin/env bash

# Offline export and restore for the PULSO WhatsApp session volume. This hook
# deliberately operates on one Compose-labelled volume and never discovers or
# mutates sibling product volumes.

set -Eeuo pipefail

umask 077

fail() {
  printf 'PULSO WhatsApp sessions snapshot failed: %s\n' "$1" >&2
  exit 1
}

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_directory}/../.." && pwd -P)"
script_file="${script_directory}/${BASH_SOURCE[0]##*/}"
production_root=/opt/hyperion-platform
action="${1:-${PULSO_WHATSAPP_ACTION:-}}"
test_mode="${PULSO_OPS_TEST_MODE:-0}"
compose_project="${PULSO_WHATSAPP_COMPOSE_PROJECT:-hyperion-pulso}"
logical_volume=pulso_whatsapp_sessions
snapshot_image="${PULSO_WHATSAPP_SNAPSHOT_IMAGE:-}"
snapshot_image_catalog="${repository_root}/infra/pulso-whatsapp-snapshot-images.v1.txt"
restore_target_project="${PULSO_WHATSAPP_RESTORE_TARGET_PROJECT:-}"
restore_target_volume="${PULSO_WHATSAPP_RESTORE_TARGET_VOLUME:-}"
expected_docker_endpoint="${PULSO_WHATSAPP_EXPECTED_DOCKER_ENDPOINT:-}"
drill_id="${PULSO_WHATSAPP_DRILL_ID:-}"

[[ "${action}" == "export" || "${action}" == "restore" ]] \
  || fail "action must be export or restore"
[[ "${test_mode}" == "0" || "${test_mode}" == "1" ]] || fail "invalid test mode"
restore_as=0
if [[ -n "${restore_target_project}" || -n "${restore_target_volume}" ]]; then
  [[ "${action}" == "restore" ]] || fail "restore-as variables are valid only for restore"
  [[ "${test_mode}" == "1" ]] || fail "restore-as is forbidden outside test/drill mode"
  [[ -n "${restore_target_project}" && -n "${restore_target_volume}" ]] \
    || fail "restore-as requires both target project and target volume"
  restore_as=1
fi
if [[ -n "${expected_docker_endpoint}" ]]; then
  [[ "${test_mode}" == "1" ]] || fail "an expected Docker endpoint override is valid only in test/drill mode"
  [[ "${expected_docker_endpoint}" =~ ^(npipe|unix)://[^[:space:]]+$ ]] \
    || fail "expected Docker endpoint is invalid"
fi
if [[ -n "${drill_id}" ]]; then
  [[ "${test_mode}" == "1" ]] || fail "a drill resource identity is valid only in test/drill mode"
  [[ "${drill_id}" =~ ^[a-z0-9][a-z0-9-]{7,63}$ ]] || fail "drill resource identity is invalid"
fi
[[ "${snapshot_image}" =~ ^alpine@sha256:[a-f0-9]{64}$ ]] \
  || fail "PULSO_WHATSAPP_SNAPSHOT_IMAGE must be a canonical Alpine reference pinned by SHA-256 digest"
max_snapshot_bytes=268435456

docker_routing_overrides=(
  DOCKER_HOST
  DOCKER_CONTEXT
  DOCKER_CONFIG
  DOCKER_CERT_PATH
  DOCKER_TLS
  DOCKER_TLS_VERIFY
)
for docker_routing_override in "${docker_routing_overrides[@]}"; do
  [[ -z "${!docker_routing_override+x}" ]] \
    || fail "${docker_routing_override} must be unset; PULSO operations use the default Docker context through HOME"
done

for required_command in awk chmod cmp env grep install mkdir mktemp mv realpath sha256sum stat; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "required command unavailable: ${required_command}"
done
command -v docker >/dev/null 2>&1 || fail "Docker CLI is unavailable"

if [[ "${test_mode}" == "1" ]]; then
  [[ "${repository_root}" != "${production_root}" ]] || fail "test mode is forbidden in production"
  test_root="${PULSO_OPS_TEST_ROOT:-}"
  [[ -n "${test_root}" && -d "${test_root}" && ! -L "${test_root}" ]] || fail "invalid test root"
  test_root="$(realpath -e -- "${test_root}")"
  [[ "${test_root}" == */hyperion-pulso-whatsapp-test.* ]] || fail "test root is not isolated"
  [[ "${compose_project}" =~ ^hyperion-pulso-whatsapp-test-[a-z0-9][a-z0-9-]{0,30}$ ]] \
    || fail "test Compose project is not isolated"
  if ((restore_as == 1)); then
    [[ "${restore_target_project}" =~ ^hyperion-pulso-whatsapp-test-[a-z0-9][a-z0-9-]{0,30}$ ]] \
      || fail "restore-as target Compose project is not isolated"
    [[ "${restore_target_project}" != "${compose_project}" ]] \
      || fail "restore-as target project must differ from the bundle source project"
    [[ "${restore_target_volume}" == "${restore_target_project}_${logical_volume}" ]] \
      || fail "restore-as target volume must be the exact project-owned PULSO WhatsApp volume"
  fi
  snapshot_root="${PULSO_WHATSAPP_BACKUP_DIR:-${test_root}/backups/pulso/whatsapp-sessions}"
  snapshot_root="$(realpath -m -- "${snapshot_root}")"
  [[ "${snapshot_root}" == "${test_root}/"* ]] || fail "snapshot directory escaped its test root"
else
  ((EUID == 0)) || fail "production snapshots must run as root"
  [[ "${repository_root}" == "${production_root}" ]] || fail "production repository path must be canonical"
  [[ "${compose_project}" == "hyperion-pulso" ]] || fail "production Compose project must be hyperion-pulso"
  snapshot_root="${repository_root}/backups/pulso/whatsapp-sessions"
  [[ -f "${script_file}" && ! -L "${script_file}" ]] || fail "invalid protected script"
  [[ "$(stat -c '%u:%g' -- "${script_file}")" == "0:0" ]] \
    || fail "protected script owner must be root:root"
  [[ "$(stat -c '%h' -- "${script_file}")" == "1" ]] \
    || fail "protected script must not have multiple hard links"
  protected_mode="$(stat -c '%a' -- "${script_file}")"
  (( (8#${protected_mode} & 8#022) == 0 )) \
    || fail "protected script must not be writable by group or others"
fi

[[ "${snapshot_root}" == */backups/pulso/whatsapp-sessions ]] \
  || fail "snapshots must use the dedicated backups/pulso/whatsapp-sessions directory"
if [[ "${test_mode}" == "1" ]]; then
  install -d -m 700 -- "${snapshot_root}"
else
  for protected_directory in "${production_root}"; do
    [[ -d "${protected_directory}" && ! -L "${protected_directory}" ]] \
      || fail "production snapshot parent is not a protected directory"
    [[ "$(stat -c '%u:%g' -- "${protected_directory}")" == "0:0" ]] \
      || fail "production snapshot parents must be owned by root:root"
    protected_directory_mode="$(stat -c '%a' -- "${protected_directory}")"
    (( (8#${protected_directory_mode} & 8#022) == 0 )) \
      || fail "production snapshot parents must not be writable by group or others"
  done
  for protected_directory in \
    "${production_root}/backups" \
    "${production_root}/backups/pulso" \
    "${snapshot_root}"; do
    protected_parent="$(dirname -- "${protected_directory}")"
    [[ -d "${protected_parent}" && ! -L "${protected_parent}" ]] \
      || fail "production snapshot parent is not a protected directory"
    if [[ ! -e "${protected_directory}" && ! -L "${protected_directory}" ]]; then
      mkdir -m 700 -- "${protected_directory}"
    fi
    [[ -d "${protected_directory}" && ! -L "${protected_directory}" ]] \
      || fail "production snapshot parent is not a protected directory"
    [[ "$(stat -c '%u:%g' -- "${protected_directory}")" == "0:0" ]] \
      || fail "production snapshot parents must be owned by root:root"
    protected_directory_mode="$(stat -c '%a' -- "${protected_directory}")"
    (( (8#${protected_directory_mode} & 8#022) == 0 )) \
      || fail "production snapshot parents must not be writable by group or others"
  done
fi
[[ ! -L "${snapshot_root}" ]] || fail "snapshot root must not be a symbolic link"
snapshot_root="$(realpath -e -- "${snapshot_root}")"
if [[ "${test_mode}" == "1" ]]; then
  [[ "${snapshot_root}" == "${test_root}/backups/pulso/whatsapp-sessions" ]] \
    || fail "canonical snapshot directory escaped its test root"
else
  [[ "${snapshot_root}" == "${production_root}/backups/pulso/whatsapp-sessions" ]] \
    || fail "production snapshot directory must be canonical"
  for protected_directory in \
    "${production_root}" \
    "${production_root}/backups" \
    "${production_root}/backups/pulso" \
    "${snapshot_root}"; do
    [[ -d "${protected_directory}" && ! -L "${protected_directory}" ]] \
      || fail "production snapshot parent is not a protected directory"
    [[ "$(stat -c '%u:%g' -- "${protected_directory}")" == "0:0" ]] \
      || fail "production snapshot parents must be owned by root:root"
    protected_directory_mode="$(stat -c '%a' -- "${protected_directory}")"
    (( (8#${protected_directory_mode} & 8#022) == 0 )) \
      || fail "production snapshot parents must not be writable by group or others"
  done
fi

[[ -f "${snapshot_image_catalog}" && ! -L "${snapshot_image_catalog}" ]] \
  || fail "approved WhatsApp snapshot helper catalog is missing or unsafe"
if [[ "${test_mode}" == "0" ]]; then
  [[ "$(stat -c '%u:%g' -- "${snapshot_image_catalog}")" == "0:0" \
    && "$(stat -c '%h' -- "${snapshot_image_catalog}")" == "1" ]] \
    || fail "approved helper catalog must be single-linked and owned by root:root"
  snapshot_catalog_mode="$(stat -c '%a' -- "${snapshot_image_catalog}")"
  (( (8#${snapshot_catalog_mode} & 8#022) == 0 )) \
    || fail "approved helper catalog must not be writable by group or others"
fi
catalog_entries=0
while IFS= read -r catalog_entry || [[ -n "${catalog_entry}" ]]; do
  [[ -z "${catalog_entry}" || "${catalog_entry}" == \#* ]] && continue
  [[ "${catalog_entry}" =~ ^alpine@sha256:[a-f0-9]{64}$ ]] \
    || fail "approved helper catalog contains an invalid entry"
  catalog_entries=$((catalog_entries + 1))
done <"${snapshot_image_catalog}"
((catalog_entries > 0)) || fail "approved helper catalog is empty"
grep -Fx -- "${snapshot_image}" "${snapshot_image_catalog}" >/dev/null \
  || fail "PULSO_WHATSAPP_SNAPSHOT_IMAGE is not present in the approved helper catalog"
timestamp="${PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "${timestamp}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "invalid UTC snapshot timestamp"

source_volume="${compose_project}_${logical_volume}"
volume_project="${compose_project}"
expected_volume="${source_volume}"
if ((restore_as == 1)); then
  volume_project="${restore_target_project}"
  expected_volume="${restore_target_volume}"
fi
[[ "${expected_volume}" =~ ^[a-z0-9][a-z0-9_-]{1,126}$ ]] || fail "derived volume name is unsafe"
volume_identity_format='{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}|{{.Name}}|{{.Driver}}|{{.Scope}}|{{json .Options}}'
expected_volume_identity="${volume_project}|${logical_volume}|${expected_volume}|local|local|null"

[[ -n "${HOME:-}" && "${HOME}" == /* && "${HOME}" != *$'\n'* && "${HOME}" != *$'\r'* ]] \
  || fail "HOME must be an absolute, single-line path for the Docker client"
# The MSYS variables are harmless on Linux and prevent Git Bash from rewriting
# container-only arguments before launching the native Windows Docker CLI.
docker_environment=(
  env -i "PATH=${PATH}" "HOME=${HOME}" "LANG=C" "LC_ALL=C" "TZ=UTC"
  "MSYS_NO_PATHCONV=1" "MSYS2_ARG_CONV_EXCL=*"
)
if [[ -n "${USERPROFILE+x}" ]]; then
  [[ "${USERPROFILE}" =~ ^[A-Za-z]:[\\/].+ \
    && "${USERPROFILE}" != *$'\n'* && "${USERPROFILE}" != *$'\r'* ]] \
    || fail "USERPROFILE is invalid for the Docker client"
  docker_environment+=("USERPROFILE=${USERPROFILE}")
  for windows_home_variable in HOMEDRIVE HOMEPATH; do
    [[ -n "${!windows_home_variable:-}" \
      && "${!windows_home_variable}" != *$'\n'* \
      && "${!windows_home_variable}" != *$'\r'* ]] \
      || fail "${windows_home_variable} is required with USERPROFILE"
    docker_environment+=("${windows_home_variable}=${!windows_home_variable}")
  done
fi

docker_bootstrap_call() {
  "${docker_environment[@]}" docker "$@"
}

docker_context="$(docker_bootstrap_call context show)" \
  || fail "could not resolve the Docker context"
[[ "${docker_context}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
  || fail "Docker context name is unsafe"
docker_endpoint="$(docker_bootstrap_call context inspect "${docker_context}" --format '{{.Endpoints.docker.Host}}')" \
  || fail "could not resolve the Docker endpoint"
[[ "${docker_endpoint}" =~ ^(npipe|unix)://[^[:space:]]+$ ]] \
  || fail "PULSO WhatsApp snapshots require a local npipe:// or unix:// Docker endpoint"
[[ -z "${expected_docker_endpoint}" || "${docker_endpoint}" == "${expected_docker_endpoint}" ]] \
  || fail "Docker endpoint changed after the drill runner sealed it"

docker_call() {
  if [[ "${1:-}" == "run" && -n "${drill_id}" ]]; then
    shift
    "${docker_environment[@]}" docker --host "${docker_endpoint}" run \
      --name "hyperion-pulso-wa-${drill_id}-wrapper" \
      --label "com.docker.compose.project=${volume_project}" \
      --label "com.hyperion.recovery-drill=${drill_id}" \
      --label "com.hyperion.recovery-kind=pulso-whatsapp" \
      "$@"
    return
  fi
  "${docker_environment[@]}" docker --host "${docker_endpoint}" "$@"
}

local_image_digests="$(docker_call image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${snapshot_image}")" \
  || fail "the pinned WhatsApp snapshot helper image is not present locally"
grep -Fx -- "${snapshot_image}" <<<"${local_image_digests}" >/dev/null \
  || fail "the local WhatsApp snapshot helper does not match the approved digest"

mapfile -t matching_volumes < <(
  docker_call volume ls \
    --filter "label=com.docker.compose.project=${volume_project}" \
    --filter "label=com.docker.compose.volume=${logical_volume}" \
    --format '{{.Name}}'
)
[[ ${#matching_volumes[@]} -eq 1 && "${matching_volumes[0]}" == "${expected_volume}" ]] \
  || fail "the exact PULSO WhatsApp Compose volume was not found"
volume_identity="$(docker_call volume inspect \
  --format "${volume_identity_format}" \
  "${expected_volume}")"
[[ "${volume_identity}" == "${expected_volume_identity}" ]] \
  || fail "volume identity, local driver, empty options, or Compose ownership labels do not match"

running_consumers="$(docker_call ps --filter "volume=${expected_volume}" --format '{{.ID}}')"
[[ -z "${running_consumers}" ]] \
  || fail "WhatsApp must be stopped before exporting or restoring its session volume"
if [[ "${action}" == "restore" ]]; then
  attached_consumers="$(docker_call ps -a --filter "volume=${expected_volume}" --format '{{.ID}}')"
  [[ -z "${attached_consumers}" ]] \
    || fail "all containers referencing the WhatsApp session volume must be removed before restore"
fi

archive_mount="type=volume,src=${expected_volume},dst=/sessions,readonly"
restore_mount="type=volume,src=${expected_volume},dst=/sessions"

validate_entry_path() {
  local entry="$1"
  local relative component
  [[ -n "${entry}" ]] || fail "archive contains an empty entry"
  if printf '%s' "${entry}" | LC_ALL=C grep -q '[[:cntrl:][:space:]]'; then
    fail "archive entry names must not contain whitespace or control characters"
  fi
  [[ "${entry}" == "." || "${entry}" == "./" || "${entry}" == ./* ]] \
    || fail "archive contains a non-relative entry"
  relative="${entry#./}"
  relative="${relative%/}"
  [[ "${relative}" != *//* ]] || fail "archive entry contains an empty path component"
  [[ "${relative}" != ".hyperion-restore-staging" \
    && "${relative}" != .hyperion-restore-staging/* \
    && "${relative}" != ".hyperion-restore-previous" \
    && "${relative}" != .hyperion-restore-previous/* \
    && "${relative}" != ".hyperion-restore-lock" \
    && "${relative}" != .hyperion-restore-lock/* ]] \
    || fail "archive uses a reserved restore transaction path"
  [[ -z "${relative}" ]] && return 0
  IFS='/' read -r -a components <<<"${relative}"
  for component in "${components[@]}"; do
    [[ -n "${component}" && "${component}" != "." && "${component}" != ".." ]] \
      || fail "archive contains an unsafe path component"
  done
}

validate_archive() {
  local archive="$1"
  local work_directory="$2"
  local entry mode remainder
  local entry_count=0
  local type_count=0
  local list_file="${work_directory}/entries.list"
  local verbose_file="${work_directory}/entries.verbose"

  docker_call run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint /bin/tar -i \
    "${snapshot_image}" -tzf - <"${archive}" >"${list_file}"
  docker_call run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint /bin/tar -i \
    "${snapshot_image}" -tvzf - <"${archive}" >"${verbose_file}"
  [[ -s "${list_file}" && -s "${verbose_file}" ]] || fail "snapshot archive is empty or unreadable"
  while IFS= read -r entry; do
    validate_entry_path "${entry}"
    entry_count=$((entry_count + 1))
  done <"${list_file}"
  while IFS=' ' read -r mode remainder; do
    [[ -n "${remainder}" ]] || fail "archive verbose inventory is malformed"
    [[ "${mode:0:1}" == "-" || "${mode:0:1}" == "d" ]] \
      || fail "archive contains links, devices, or another unsupported entry type"
    type_count=$((type_count + 1))
  done <"${verbose_file}"
  ((entry_count > 0 && entry_count == type_count)) || fail "archive inventories do not agree"
}

write_volume_inventory() {
  local output_file="$1"
  docker_call run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint /bin/sh --user 1000:1000 \
    --mount "${archive_mount}" "${snapshot_image}" -eu -c \
    '
      inventory_mode=live
      cd /sessions
      find . -mindepth 1 \
        \( -path ./.hyperion-restore-staging -o -path "./.hyperion-restore-staging/*" \
          -o -path ./.hyperion-restore-previous -o -path "./.hyperion-restore-previous/*" \
          -o -path ./.hyperion-restore-lock -o -path "./.hyperion-restore-lock/*" \) -prune \
        -o -type f -exec sha256sum {} \; | LC_ALL=C sort
    ' \
    >"${output_file}"
}

assert_reserved_restore_paths_absent() {
  docker_call run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint /bin/sh --user 1000:1000 \
    --mount "${archive_mount}" "${snapshot_image}" -eu -c '
      restore_preflight=reserved-paths
      test ! -e /sessions/.hyperion-restore-staging
      test ! -e /sessions/.hyperion-restore-previous
      test ! -e /sessions/.hyperion-restore-lock
    '
}

write_archive_inventory() {
  local archive_file="$1"
  local output_file="$2"
  docker_call run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --entrypoint /bin/sh --tmpfs /work:rw,noexec,nosuid,nodev,size=536870912 \
    -i "${snapshot_image}" -eu -c '
      install -d -m 700 /work/snapshot
      tar -xzf - -C /work/snapshot
      cd /work/snapshot
      find . -mindepth 1 -type f -exec sha256sum {} \; | LC_ALL=C sort
    ' <"${archive_file}" >"${output_file}"
}

validate_inventory() {
  local inventory_file="$1"
  local digest separator entry extra
  [[ -f "${inventory_file}" && ! -L "${inventory_file}" ]] || fail "invalid session inventory"
  while IFS= read -r line; do
    digest="${line:0:64}"
    separator="${line:64:2}"
    entry="${line:66}"
    [[ "${digest}" =~ ^[a-f0-9]{64}$ \
      && ( "${separator}" == "  " || "${separator}" == " *" ) \
      && -n "${entry}" ]] \
      || fail "session inventory is malformed"
    validate_entry_path "${entry}"
  done <"${inventory_file}"
}

calculate_bundle_sha() {
  local archive_sha="$1"
  local inventory_sha="$2"
  printf '%s\n%s\n%s\n%s\n' \
    "${compose_project}" "${source_volume}" "${archive_sha}" "${inventory_sha}" \
    | sha256sum \
    | awk '{ print $1 }'
}

if [[ "${action}" == "export" ]]; then
  final_directory="${snapshot_root}/pulso-whatsapp-sessions-${timestamp}"
  [[ ! -e "${final_directory}" && ! -L "${final_directory}" ]] \
    || fail "WhatsApp sessions snapshot already exists for ${timestamp}"
  temporary_directory="$(mktemp -d "${snapshot_root}/.pulso-whatsapp-sessions-${timestamp}.tmp.XXXXXX")"
  cleanup_export() {
    if [[ -n "${temporary_directory:-}" \
      && -d "${temporary_directory}" \
      && "${temporary_directory}" == "${snapshot_root}/.pulso-whatsapp-sessions-${timestamp}.tmp."* ]]; then
      rm -rf -- "${temporary_directory}"
    fi
  }
  trap cleanup_export EXIT
  archive="${temporary_directory}/sessions.tar.gz"
  inventory="${temporary_directory}/inventory.tsv"

  assert_reserved_restore_paths_absent \
    || fail "an unfinished restore transaction is present; keep the volume offline for manual recovery"
  docker_call run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint /bin/tar --user 1000:1000 \
    --mount "${archive_mount}" "${snapshot_image}" -C /sessions -czf - . >"${archive}"
  [[ -s "${archive}" ]] || fail "Docker produced an empty WhatsApp session archive"
  archive_bytes="$(stat -c '%s' -- "${archive}")"
  ((archive_bytes <= max_snapshot_bytes)) || fail "WhatsApp session archive exceeds the 256 MiB safety limit"
  validate_archive "${archive}" "${temporary_directory}"
  write_archive_inventory "${archive}" "${inventory}"
  validate_inventory "${inventory}"
  archive_sha256="$(sha256sum -- "${archive}" | awk '{ print $1 }')"
  inventory_sha256="$(sha256sum -- "${inventory}" | awk '{ print $1 }')"
  bundle_sha256="$(calculate_bundle_sha "${archive_sha256}" "${inventory_sha256}")"
  printf '%s\n' "${compose_project}" >"${temporary_directory}/project"
  printf '%s\n' "${source_volume}" >"${temporary_directory}/volume"
  printf '%s\n' "${archive_sha256}" >"${temporary_directory}/archive.sha256"
  printf '%s\n' "${bundle_sha256}" >"${temporary_directory}/bundle.sha256"
  chmod 600 -- "${temporary_directory}/"*
  chmod 700 -- "${temporary_directory}"
  # -T makes a concurrent publication fail instead of nesting this completed
  # temporary bundle inside an already-published directory.
  mv -T -- "${temporary_directory}" "${final_directory}"
  temporary_directory=""
  trap - EXIT

  printf 'WHATSAPP_SESSIONS_SNAPSHOT_DIRECTORY=%s\n' "${final_directory}"
  printf 'WHATSAPP_SESSIONS_PROJECT=%s\n' "${compose_project}"
  printf 'WHATSAPP_SESSIONS_VOLUME=%s\n' "${source_volume}"
  printf 'WHATSAPP_SESSIONS_ARCHIVE_SHA256=%s\n' "${archive_sha256}"
  printf 'WHATSAPP_SESSIONS_INVENTORY_SHA256=%s\n' "${inventory_sha256}"
  printf 'WHATSAPP_SESSIONS_BUNDLE_SHA256=%s\n' "${bundle_sha256}"
  printf 'WHATSAPP_SESSIONS_ARCHIVE_BYTES=%s\n' "${archive_bytes}"
  exit 0
fi

source_directory="${PULSO_WHATSAPP_SNAPSHOT_DIRECTORY:-}"
[[ -n "${source_directory}" ]] || fail "PULSO_WHATSAPP_SNAPSHOT_DIRECTORY is required for restore"
source_directory="$(realpath -e -- "${source_directory}")"
[[ "${source_directory}" == "${snapshot_root}/pulso-whatsapp-sessions-"* ]] \
  || fail "restore snapshot is outside the dedicated PULSO WhatsApp directory"
[[ "$(basename -- "${source_directory}")" =~ ^pulso-whatsapp-sessions-[0-9]{8}T[0-9]{6}Z$ ]] \
  || fail "restore snapshot directory has an invalid name"
[[ -d "${source_directory}" && ! -L "${source_directory}" ]] \
  || fail "restore snapshot source must be a real directory"
if [[ "${test_mode}" == "0" ]]; then
  [[ "$(stat -c '%u:%g' -- "${source_directory}")" == "0:0" ]] \
    || fail "restore snapshot directory must be owned by root:root"
  source_directory_mode="$(stat -c '%a' -- "${source_directory}")"
  (( (8#${source_directory_mode} & 8#022) == 0 )) \
    || fail "restore snapshot directory must not be writable by group or others"
fi

source_archive="${source_directory}/sessions.tar.gz"
source_inventory="${source_directory}/inventory.tsv"
source_project_file="${source_directory}/project"
source_volume_file="${source_directory}/volume"
source_archive_sha_file="${source_directory}/archive.sha256"
source_bundle_sha_file="${source_directory}/bundle.sha256"
for source_file in \
  "${source_archive}" "${source_inventory}" "${source_project_file}" "${source_volume_file}" \
  "${source_archive_sha_file}" "${source_bundle_sha_file}"; do
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || fail "restore bundle contains an invalid file"
  if [[ "${test_mode}" == "0" ]]; then
    [[ "$(stat -c '%u:%g' -- "${source_file}")" == "0:0" \
      && "$(stat -c '%h' -- "${source_file}")" == "1" ]] \
      || fail "restore bundle files must be single-linked and owned by root:root"
    source_mode="$(stat -c '%a' -- "${source_file}")"
    (( (8#${source_mode} & 8#022) == 0 )) \
      || fail "restore bundle files must not be writable by group or others"
  fi
done

validation_directory="$(mktemp -d "${snapshot_root}/.pulso-whatsapp-validation.XXXXXX")"
restore_transaction_active=0

rollback_restore_volume() {
  local docker_status rollback_consumers rollback_identity
  rollback_identity="$(docker_call volume inspect \
    --format "${volume_identity_format}" \
    "${expected_volume}")" || return 1
  [[ "${rollback_identity}" == "${expected_volume_identity}" ]] || return 1
  rollback_consumers="$(docker_call ps -a --filter "volume=${expected_volume}" --format '{{.ID}}')" || return 1
  [[ -z "${rollback_consumers}" ]] || return 1
  if docker_call run --rm --pull=never --network none --read-only --cap-drop ALL --cap-add CHOWN \
    --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
    --entrypoint /bin/sh --mount "${restore_mount}" "${snapshot_image}" \
    -eu -c '
      rollback_mode=external
      transaction_id=$1
      staging=/sessions/.hyperion-restore-staging
      previous=/sessions/.hyperion-restore-previous
      lock=/sessions/.hyperion-restore-lock
      move_children() {
        source_directory=$1
        target_directory=$2
        set -- "$source_directory"/* "$source_directory"/.[!.]* "$source_directory"/..?*
        for entry; do
          test -e "$entry" || test -L "$entry" || continue
          mv -- "$entry" "$target_directory"/ || return 1
        done
      }
      remove_live_children() {
        set -- /sessions/* /sessions/.[!.]* /sessions/..?*
        for entry; do
          test -e "$entry" || test -L "$entry" || continue
          case "$entry" in
            "$staging"|"$previous"|"$lock") continue ;;
          esac
          rm -rf -- "$entry" || return 1
        done
      }
      if test ! -e "$staging" && test ! -e "$previous" && test ! -e "$lock"; then
        exit 3
      fi
      test -d "$lock"
      test -f "$lock/transaction"
      test "$(cat "$lock/transaction")" = "$transaction_id"
      test -f "$lock/phase"
      restore_phase=$(cat "$lock/phase")
      case "$restore_phase" in
        extracting)
          test ! -e "$previous" || test -d "$previous"
          test ! -e "$staging" || test -d "$staging"
          ;;
        archiving)
          test -d "$staging"
          test -d "$previous"
          move_children "$previous" /sessions
          ;;
        promoting|prepared)
          test -d "$staging"
          test -d "$previous"
          remove_live_children
          move_children "$previous" /sessions
          ;;
        *) exit 4 ;;
      esac
      sync
      rm -rf -- "$staging" "$previous" "$lock"
      sync
    ' hyperion-restore-rollback "${restore_transaction_id}"; then
    return 0
  else
    docker_status=$?
  fi
  # Exit 3 means the destructive helper never established its transaction
  # directories (or its own rollback already removed them).
  ((docker_status == 3)) && return 2
  return 1
}

cleanup_restore() {
  local rollback_status=0 status=$?
  trap - HUP INT TERM EXIT
  if ((restore_transaction_active == 1)); then
    rollback_restore_volume || rollback_status=$?
    if ((rollback_status != 0 && rollback_status != 2)); then
      printf 'PULSO WhatsApp sessions snapshot failed: automatic restore rollback failed; keep the volume offline for manual recovery\n' >&2
      status=1
    fi
  fi
  if [[ -n "${validation_directory:-}" \
    && -d "${validation_directory}" \
    && "${validation_directory}" == "${snapshot_root}/.pulso-whatsapp-validation."* ]]; then
    rm -rf -- "${validation_directory}"
  fi
  exit "${status}"
}
trap cleanup_restore EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for source_file in \
  "${source_archive}" "${source_inventory}" "${source_project_file}" "${source_volume_file}" \
  "${source_archive_sha_file}" "${source_bundle_sha_file}"; do
  install -m 600 -- "${source_file}" "${validation_directory}/$(basename -- "${source_file}")"
done
archive="${validation_directory}/sessions.tar.gz"
inventory="${validation_directory}/inventory.tsv"
project_file="${validation_directory}/project"
volume_file="${validation_directory}/volume"
archive_sha_file="${validation_directory}/archive.sha256"
bundle_sha_file="${validation_directory}/bundle.sha256"
[[ "$(<"${project_file}")" == "${compose_project}" ]] || fail "snapshot belongs to another Compose project"
[[ "$(<"${volume_file}")" == "${source_volume}" ]] || fail "snapshot belongs to another Docker volume"
archive_bytes="$(stat -c '%s' -- "${archive}")"
((archive_bytes <= max_snapshot_bytes)) || fail "WhatsApp session archive exceeds the 256 MiB safety limit"
validate_archive "${archive}" "${validation_directory}"
validate_inventory "${inventory}"
archive_sha256="$(sha256sum -- "${archive}" | awk '{ print $1 }')"
inventory_sha256="$(sha256sum -- "${inventory}" | awk '{ print $1 }')"
bundle_sha256="$(calculate_bundle_sha "${archive_sha256}" "${inventory_sha256}")"
stored_archive_sha256="$(<"${archive_sha_file}")"
stored_bundle_sha256="$(<"${bundle_sha_file}")"
expected_archive_sha256="${PULSO_WHATSAPP_ARCHIVE_SHA256:-}"
expected_bundle_sha256="${PULSO_WHATSAPP_BUNDLE_SHA256:-}"
[[ "${expected_archive_sha256}" =~ ^[a-f0-9]{64}$ \
  && "${stored_archive_sha256}" == "${archive_sha256}" \
  && "${expected_archive_sha256}" == "${archive_sha256}" ]] \
  || fail "WhatsApp session archive SHA-256 does not match"
[[ "${expected_bundle_sha256}" =~ ^[a-f0-9]{64}$ \
  && "${stored_bundle_sha256}" == "${bundle_sha256}" \
  && "${expected_bundle_sha256}" == "${bundle_sha256}" ]] \
  || fail "WhatsApp session bundle SHA-256 does not match"
restore_transaction_id="$(printf '%s\n%s\n%s\n' \
  "${validation_directory}" "$$" "${bundle_sha256}" | sha256sum | awk '{ print $1 }')"
[[ "${restore_transaction_id}" =~ ^[a-f0-9]{64}$ ]] \
  || fail "could not derive a safe restore transaction identity"
if ((restore_as == 1)); then
  expected_confirmation="RESTORE PULSO WHATSAPP ${compose_project}/${source_volume} AS ${volume_project}/${expected_volume} BUNDLE SHA256 ${bundle_sha256}"
else
  expected_confirmation="RESTORE PULSO WHATSAPP ${compose_project}/${source_volume} BUNDLE SHA256 ${bundle_sha256}"
fi
[[ "${PULSO_WHATSAPP_RESTORE_CONFIRM:-}" == "${expected_confirmation}" ]] \
  || fail "PULSO_WHATSAPP_RESTORE_CONFIRM must equal '${expected_confirmation}'"

# Re-check ownership and attachments immediately before the destructive call;
# archive validation can be slow enough for local Docker state to change.
restore_volume_identity="$(docker_call volume inspect \
  --format "${volume_identity_format}" \
  "${expected_volume}")"
[[ "${restore_volume_identity}" == "${expected_volume_identity}" ]] \
  || fail "volume identity changed before restore"
attached_consumers="$(docker_call ps -a --filter "volume=${expected_volume}" --format '{{.ID}}')"
[[ -z "${attached_consumers}" ]] \
  || fail "a container referenced the WhatsApp session volume before restore"
assert_reserved_restore_paths_absent \
  || fail "an unfinished restore transaction is present; keep the volume offline for manual recovery"

restore_transaction_active=1
docker_call run --rm --pull=never --network none --read-only --cap-drop ALL --cap-add CHOWN \
  --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
  --entrypoint /bin/sh --mount "${restore_mount}" -i "${snapshot_image}" \
  -eu -c '
    transaction_id=$1
    staging=/sessions/.hyperion-restore-staging
    previous=/sessions/.hyperion-restore-previous
    lock=/sessions/.hyperion-restore-lock
    phase=initializing
    move_children() {
      source_directory=$1
      target_directory=$2
      set -- "$source_directory"/* "$source_directory"/.[!.]* "$source_directory"/..?*
      for entry; do
        test -e "$entry" || test -L "$entry" || continue
        mv -- "$entry" "$target_directory"/ || return 1
      done
    }
    archive_live_children() {
      set -- /sessions/* /sessions/.[!.]* /sessions/..?*
      for entry; do
        test -e "$entry" || test -L "$entry" || continue
        case "$entry" in
          "$staging"|"$previous"|"$lock") continue ;;
        esac
        mv -- "$entry" "$previous"/ || return 1
      done
    }
    preserve_failed_transaction() {
      status=$?
      trap - HUP INT TERM EXIT
      # Never attempt an in-container second mutation after a partial move. The
      # host owns the single phase-aware rollback attempt and can leave these
      # directories intact for manual recovery if Docker is unavailable.
      sync || status=97
      printf "restore helper failed in phase %s; transaction retained for host rollback\n" "$phase" >&2
      test "$status" -ne 0 || status=97
      exit "$status"
    }
    set_phase() {
      next_phase=$1
      printf "%s\n" "$next_phase" >"$lock/phase.next"
      mv -- "$lock/phase.next" "$lock/phase"
      sync
      phase=$next_phase
    }
    test ! -e "$staging"
    test ! -e "$previous"
    test ! -e "$lock"
    mkdir -m 700 "$lock"
    printf "%s\n" "$transaction_id" >"$lock/transaction"
    printf "extracting\n" >"$lock/phase"
    sync
    phase=extracting
    trap "exit 129" HUP
    trap "exit 130" INT
    trap "exit 143" TERM
    trap preserve_failed_transaction EXIT
    mkdir -m 700 "$staging" "$previous"
    tar -xzf - -C "$staging"
    chown -R 1000:1000 "$staging"
    set_phase archiving
    archive_live_children
    set_phase promoting
    move_children "$staging" /sessions
    sync
    set_phase prepared
    trap - HUP INT TERM EXIT
  ' hyperion-restore "${restore_transaction_id}" <"${archive}"

observed_inventory="${validation_directory}/observed-inventory.tsv"
write_volume_inventory "${observed_inventory}"
validate_inventory "${observed_inventory}"
if ! cmp -s -- "${inventory}" "${observed_inventory}"; then
  rollback_status=0
  # Only one rollback attempt is safe: after a partial move, repeating the
  # promoting-phase algorithm could delete files already returned from previous.
  restore_transaction_active=0
  rollback_restore_volume || rollback_status=$?
  if ((rollback_status == 0)); then
    fail "post-restore WhatsApp session inventory differs from the snapshot; previous state restored"
  fi
  if ((rollback_status == 2)); then
    fail "post-restore WhatsApp session inventory differs and its owned rollback transaction is absent"
  fi
  fail "post-restore WhatsApp session inventory differs from the snapshot and automatic rollback failed"
fi
observed_inventory_sha256="$(sha256sum -- "${observed_inventory}" | awk '{ print $1 }')"

# The new inventory is now proven. Only at this point may the retained previous
# state be discarded; a cleanup failure leaves the verified restored state live.
restore_transaction_active=0
docker_call run --rm --pull=never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges --entrypoint /bin/sh --mount "${restore_mount}" "${snapshot_image}" \
  -eu -c '
    transaction_id=$1
    staging=/sessions/.hyperion-restore-staging
    previous=/sessions/.hyperion-restore-previous
    lock=/sessions/.hyperion-restore-lock
    test -d "$staging"
    test -d "$previous"
    test -d "$lock"
    test -f "$lock/transaction"
    test "$(cat "$lock/transaction")" = "$transaction_id"
    test "$(cat "$lock/phase")" = prepared
    test -z "$(find "$staging" -mindepth 1 -print -quit)"
    rm -rf -- "$staging" "$previous" "$lock"
    sync
  ' hyperion-restore-commit "${restore_transaction_id}" \
  || fail "restored inventory passed but retained previous state could not be discarded safely"

printf 'WHATSAPP_SESSIONS_RESTORE_DIRECTORY=%s\n' "${source_directory}"
printf 'WHATSAPP_SESSIONS_PROJECT=%s\n' "${volume_project}"
printf 'WHATSAPP_SESSIONS_VOLUME=%s\n' "${expected_volume}"
printf 'WHATSAPP_SESSIONS_SOURCE_PROJECT=%s\n' "${compose_project}"
printf 'WHATSAPP_SESSIONS_SOURCE_VOLUME=%s\n' "${source_volume}"
printf 'WHATSAPP_SESSIONS_RESTORE_AS=%s\n' "$([[ ${restore_as} -eq 1 ]] && printf true || printf false)"
printf 'WHATSAPP_SESSIONS_ARCHIVE_SHA256=%s\n' "${archive_sha256}"
printf 'WHATSAPP_SESSIONS_INVENTORY_SHA256=%s\n' "${observed_inventory_sha256}"
printf 'WHATSAPP_SESSIONS_BUNDLE_SHA256=%s\n' "${bundle_sha256}"
