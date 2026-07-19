#!/usr/bin/env bash

# Export and restore the NOVA Documents object store through an operator-supplied
# transport. The transport is deliberately mandatory: a database-only recovery
# set is not accepted as a NOVA backup.

set -Eeuo pipefail

umask 077

fail() {
  printf 'NOVA Documents snapshot failed: %s\n' "$1" >&2
  exit 1
}

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_directory}/../.." && pwd -P)"
script_file="${script_directory}/${BASH_SOURCE[0]##*/}"
production_root=/opt/hyperion-platform
action="${1:-${NOVA_DOCUMENTS_ACTION:-}}"
test_mode="${NOVA_OPS_TEST_MODE:-0}"
bucket="${DOCUMENTS_S3_BUCKET:-}"
transport_command="${NOVA_DOCUMENTS_TRANSPORT_COMMAND:-}"

[[ "${action}" == "export" || "${action}" == "restore" ]] \
  || fail "action must be export or restore"
[[ "${test_mode}" == "0" || "${test_mode}" == "1" ]] || fail "invalid test mode"
[[ "${bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] \
  || fail "DOCUMENTS_S3_BUCKET must be an explicit S3-compatible bucket name"
[[ "${bucket}" != *..* && ! "${bucket}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "DOCUMENTS_S3_BUCKET is unsafe"
[[ "${transport_command}" == /* ]] \
  || fail "NOVA_DOCUMENTS_TRANSPORT_COMMAND must be an absolute executable path"
[[ -f "${transport_command}" && ! -L "${transport_command}" && -x "${transport_command}" ]] \
  || fail "NOVA_DOCUMENTS_TRANSPORT_COMMAND is unavailable, linked, or not executable"

for required_command in awk chmod cmp env install mktemp mv realpath sha256sum stat; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "required command unavailable: ${required_command}"
done

if [[ "${test_mode}" == "1" ]]; then
  [[ "${repository_root}" != "${production_root}" ]] || fail "test mode is forbidden in production"
  test_root="${NOVA_OPS_TEST_ROOT:-}"
  [[ -n "${test_root}" && -d "${test_root}" && ! -L "${test_root}" ]] || fail "invalid test root"
  test_root="$(realpath -e -- "${test_root}")"
  [[ "${test_root}" == */hyperion-documents-test.* ]] || fail "test root is not isolated"
  snapshot_root="${NOVA_DOCUMENTS_BACKUP_DIR:-${test_root}/backups/nova/documents}"
  snapshot_root="$(realpath -m -- "${snapshot_root}")"
  transport_command="$(realpath -e -- "${transport_command}")"
  [[ "${snapshot_root}" == "${test_root}/"* ]] || fail "snapshot directory escaped its test root"
  [[ "${transport_command}" == "${test_root}/"* ]] || fail "transport escaped its test root"
  timestamp="${NOVA_DOCUMENTS_SNAPSHOT_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
else
  ((EUID == 0)) || fail "production snapshots must run as root"
  [[ "${repository_root}" == "${production_root}" ]] || fail "production repository path must be canonical"
  snapshot_root="${repository_root}/backups/nova/documents"
  timestamp="${NOVA_DOCUMENTS_SNAPSHOT_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
  for protected_file in "${script_file}" "${transport_command}"; do
    [[ -f "${protected_file}" && ! -L "${protected_file}" ]] || fail "invalid protected file"
    [[ "$(stat -c '%u:%g' -- "${protected_file}")" == "0:0" ]] \
      || fail "protected file owner must be root:root"
    [[ "$(stat -c '%h' -- "${protected_file}")" == "1" ]] \
      || fail "protected file must not have multiple hard links"
    protected_mode="$(stat -c '%a' -- "${protected_file}")"
    (( (8#${protected_mode} & 8#022) == 0 )) \
      || fail "protected file must not be writable by group or others"
  done
fi

[[ "${snapshot_root}" == */backups/nova/documents ]] \
  || fail "Documents snapshots must use the dedicated backups/nova/documents directory"
[[ "${timestamp}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "invalid UTC snapshot timestamp"

transport_environment=(
  env -i
  "PATH=${PATH}"
  "HOME=${HOME:-/}"
  "LANG=C"
  "LC_ALL=C"
  "TZ=UTC"
  "DOCUMENTS_S3_BUCKET=${bucket}"
)
for variable_name in \
  DOCUMENTS_S3_ENDPOINT \
  DOCUMENTS_S3_ACCESS_KEY \
  DOCUMENTS_S3_SECRET_KEY \
  DOCUMENTS_S3_SESSION_TOKEN \
  DOCUMENTS_S3_REGION \
  DOCUMENTS_S3_FORCE_PATH_STYLE; do
  if [[ -n "${!variable_name:-}" ]]; then
    transport_environment+=("${variable_name}=${!variable_name}")
  fi
done

inventory_object_count=0
inventory_total_bytes=0
validate_inventory() {
  local inventory_file="$1"
  local previous_key=""
  local digest size key extra

  [[ -s "${inventory_file}" && -f "${inventory_file}" && ! -L "${inventory_file}" ]] \
    || fail "transport inventory is missing or empty"
  if awk -F '\t' 'NF != 3 { exit 1 }' "${inventory_file}"; then
    :
  else
    fail "transport inventory must contain exactly SHA256, bytes, and percent-encoded key columns"
  fi

  inventory_object_count=0
  inventory_total_bytes=0
  while IFS=$'\t' read -r digest size key extra; do
    [[ -z "${extra:-}" ]] || fail "transport inventory has extra columns"
    [[ "${digest}" =~ ^[a-f0-9]{64}$ ]] || fail "transport inventory contains an invalid object SHA-256"
    [[ "${size}" =~ ^[0-9]+$ && ${#size} -le 16 ]] || fail "transport inventory contains an invalid object size"
    [[ -n "${key}" && "${key}" != *[[:space:]]* ]] \
      || fail "transport inventory keys must be non-empty percent-encoded strings"
    if [[ -n "${previous_key}" ]]; then
      [[ "${key}" > "${previous_key}" ]] \
        || fail "transport inventory keys must be strictly sorted and unique"
    fi
    previous_key="${key}"
    inventory_object_count=$((inventory_object_count + 1))
    inventory_total_bytes=$((inventory_total_bytes + 10#${size}))
  done <"${inventory_file}"
  ((inventory_object_count > 0)) || fail "transport inventory contains no objects"
}

validate_snapshot_ref() {
  local snapshot_ref_file="$1"
  local lines=()
  [[ -s "${snapshot_ref_file}" && -f "${snapshot_ref_file}" && ! -L "${snapshot_ref_file}" ]] \
    || fail "transport snapshot reference is missing or empty"
  mapfile -t lines <"${snapshot_ref_file}"
  [[ ${#lines[@]} -eq 1 ]] || fail "transport snapshot reference must contain exactly one line"
  [[ ${#lines[0]} -le 512 && "${lines[0]}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$ ]] \
    || fail "transport snapshot reference is not a safe opaque identifier"
}

calculate_bundle_sha() {
  local snapshot_sha="$1"
  local inventory_sha="$2"
  printf '%s\n%s\n%s\n%s\n%s\n' \
    "${bucket}" \
    "${snapshot_sha}" \
    "${inventory_sha}" \
    "${inventory_object_count}" \
    "${inventory_total_bytes}" \
    | sha256sum \
    | awk '{ print $1 }'
}

install -d -m 700 -- "${snapshot_root}"
[[ ! -L "${snapshot_root}" ]] || fail "snapshot root must not be a symbolic link"

if [[ "${action}" == "export" ]]; then
  final_directory="${snapshot_root}/nova-documents-${timestamp}"
  [[ ! -e "${final_directory}" && ! -L "${final_directory}" ]] \
    || fail "Documents snapshot already exists for ${timestamp}"
  temporary_directory="$(mktemp -d "${snapshot_root}/.nova-documents-${timestamp}.tmp.XXXXXX")"
  cleanup_export() {
    if [[ -n "${temporary_directory:-}" && -d "${temporary_directory}" ]]; then
      rm -rf -- "${temporary_directory}"
    fi
  }
  trap cleanup_export EXIT
  snapshot_ref_file="${temporary_directory}/snapshot.ref"
  inventory_file="${temporary_directory}/inventory.tsv"

  "${transport_environment[@]}" "${transport_command}" \
    export "${bucket}" "${snapshot_ref_file}" "${inventory_file}"
  validate_snapshot_ref "${snapshot_ref_file}"
  validate_inventory "${inventory_file}"
  snapshot_sha256="$(sha256sum -- "${snapshot_ref_file}" | awk '{ print $1 }')"
  inventory_sha256="$(sha256sum -- "${inventory_file}" | awk '{ print $1 }')"
  bundle_sha256="$(calculate_bundle_sha "${snapshot_sha256}" "${inventory_sha256}")"
  printf '%s\n' "${bucket}" >"${temporary_directory}/bucket"
  printf '%s\n' "${bundle_sha256}" >"${temporary_directory}/bundle.sha256"
  chmod 600 -- "${temporary_directory}/"*
  chmod 700 -- "${temporary_directory}"
  mv -- "${temporary_directory}" "${final_directory}"
  temporary_directory=""
  trap - EXIT

  printf 'DOCUMENTS_SNAPSHOT_DIRECTORY=%s\n' "${final_directory}"
  printf 'DOCUMENTS_BUCKET=%s\n' "${bucket}"
  printf 'DOCUMENTS_SNAPSHOT_SHA256=%s\n' "${snapshot_sha256}"
  printf 'DOCUMENTS_INVENTORY_SHA256=%s\n' "${inventory_sha256}"
  printf 'DOCUMENTS_BUNDLE_SHA256=%s\n' "${bundle_sha256}"
  printf 'DOCUMENTS_OBJECT_COUNT=%s\n' "${inventory_object_count}"
  printf 'DOCUMENTS_TOTAL_BYTES=%s\n' "${inventory_total_bytes}"
  exit 0
fi

source_directory="${NOVA_DOCUMENTS_SNAPSHOT_DIRECTORY:-}"
[[ -n "${source_directory}" ]] || fail "NOVA_DOCUMENTS_SNAPSHOT_DIRECTORY is required for restore"
source_directory="$(realpath -e -- "${source_directory}")"
[[ "${source_directory}" == "${snapshot_root}/nova-documents-"* ]] \
  || fail "restore snapshot is outside the dedicated NOVA Documents directory"
[[ "$(basename -- "${source_directory}")" =~ ^nova-documents-[0-9]{8}T[0-9]{6}Z$ ]] \
  || fail "restore snapshot directory has an invalid name"
snapshot_ref_file="${source_directory}/snapshot.ref"
inventory_file="${source_directory}/inventory.tsv"
bucket_file="${source_directory}/bucket"
bundle_file="${source_directory}/bundle.sha256"
for source_file in "${snapshot_ref_file}" "${inventory_file}" "${bucket_file}" "${bundle_file}"; do
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || fail "restore bundle contains an invalid file"
done
[[ "$(<"${bucket_file}")" == "${bucket}" ]] || fail "restore bundle belongs to another bucket"
validate_snapshot_ref "${snapshot_ref_file}"
validate_inventory "${inventory_file}"
snapshot_sha256="$(sha256sum -- "${snapshot_ref_file}" | awk '{ print $1 }')"
inventory_sha256="$(sha256sum -- "${inventory_file}" | awk '{ print $1 }')"
bundle_sha256="$(calculate_bundle_sha "${snapshot_sha256}" "${inventory_sha256}")"
stored_bundle_sha256="$(<"${bundle_file}")"
expected_snapshot_sha256="${NOVA_DOCUMENTS_SNAPSHOT_SHA256:-}"
expected_inventory_sha256="${NOVA_DOCUMENTS_INVENTORY_SHA256:-}"
expected_bundle_sha256="${NOVA_DOCUMENTS_BUNDLE_SHA256:-}"
[[ "${expected_snapshot_sha256}" =~ ^[a-f0-9]{64}$ && "${expected_snapshot_sha256}" == "${snapshot_sha256}" ]] \
  || fail "snapshot reference SHA-256 does not match NOVA_DOCUMENTS_SNAPSHOT_SHA256"
[[ "${expected_inventory_sha256}" =~ ^[a-f0-9]{64}$ && "${expected_inventory_sha256}" == "${inventory_sha256}" ]] \
  || fail "inventory SHA-256 does not match NOVA_DOCUMENTS_INVENTORY_SHA256"
[[ "${stored_bundle_sha256}" == "${bundle_sha256}" && "${expected_bundle_sha256}" == "${bundle_sha256}" ]] \
  || fail "Documents bundle SHA-256 does not match"
expected_confirmation="RESTORE NOVA DOCUMENTS ${bucket} BUNDLE SHA256 ${bundle_sha256}"
[[ "${NOVA_DOCUMENTS_RESTORE_CONFIRM:-}" == "${expected_confirmation}" ]] \
  || fail "NOVA_DOCUMENTS_RESTORE_CONFIRM must equal '${expected_confirmation}'"

observed_inventory="$(mktemp "${snapshot_root}/.nova-documents-observed.XXXXXX")"
cleanup_restore() {
  [[ -n "${observed_inventory:-}" && -e "${observed_inventory}" ]] && rm -f -- "${observed_inventory}"
}
trap cleanup_restore EXIT
"${transport_environment[@]}" "${transport_command}" \
  restore "${bucket}" "${snapshot_ref_file}" "${inventory_file}"
"${transport_environment[@]}" "${transport_command}" \
  inventory "${bucket}" "${observed_inventory}"
validate_inventory "${observed_inventory}"
cmp -s -- "${inventory_file}" "${observed_inventory}" \
  || fail "post-restore Documents inventory differs from the backup inventory"
observed_inventory_sha256="$(sha256sum -- "${observed_inventory}" | awk '{ print $1 }')"

printf 'DOCUMENTS_RESTORE_DIRECTORY=%s\n' "${source_directory}"
printf 'DOCUMENTS_BUCKET=%s\n' "${bucket}"
printf 'DOCUMENTS_SNAPSHOT_SHA256=%s\n' "${snapshot_sha256}"
printf 'DOCUMENTS_INVENTORY_SHA256=%s\n' "${observed_inventory_sha256}"
printf 'DOCUMENTS_BUNDLE_SHA256=%s\n' "${bundle_sha256}"
printf 'DOCUMENTS_OBJECT_COUNT=%s\n' "${inventory_object_count}"
printf 'DOCUMENTS_TOTAL_BYTES=%s\n' "${inventory_total_bytes}"
