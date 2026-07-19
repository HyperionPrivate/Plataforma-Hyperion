#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
snapshot_script="${script_directory}/nova-documents-snapshot.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/hyperion-documents-test.XXXXXX")"

cleanup() {
  [[ -n "${test_root:-}" && -d "${test_root}" && "${test_root}" == *hyperion-documents-test.* ]] \
    && rm -rf -- "${test_root}"
}
trap cleanup EXIT

fail() {
  printf 'NOVA Documents snapshot test failed: %s\n' "$1" >&2
  exit 1
}

bash -n "${snapshot_script}" "$0"
[[ -x "${snapshot_script}" && -x "$0" ]] || fail "Documents scripts must be executable"

mock_bin="${test_root}/mock-bin"
mkdir -p -- "${mock_bin}"
cat >"${mock_bin}/install" <<'MOCK_INSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail
target="${*: -1}"
mkdir -p -- "${target}"
MOCK_INSTALL
chmod 700 -- "${mock_bin}/install"

transport="${test_root}/documents-transport"
cat >"${transport}" <<'MOCK_TRANSPORT'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ -z "${PULSO_DATABASE_PASSWORD+x}" && -z "${LUMEN_DATABASE_PASSWORD+x}" ]] || exit 90
[[ "${DOCUMENTS_S3_BUCKET:-}" == "nova-documents-drill" ]] || exit 91
state_directory="$(cd -- "$(dirname -- "$0")" && pwd -P)/transport-state"
mkdir -p -- "${state_directory}"
action="${1:-}"
bucket="${2:-}"
[[ "${bucket}" == "nova-documents-drill" ]] || exit 92
case "${action}" in
  export)
    printf 'minio://nova-drill/snapshot-0001\n' >"$3"
    printf '%064d\t3\ta.txt\n' 0 >"$4"
    printf '%064d\t5\tfolder%%2Fb.txt\n' 1 >>"$4"
    ;;
  restore)
    [[ -s "$3" && -s "$4" ]] || exit 93
    cp -- "$4" "${state_directory}/restored.inventory.tsv"
    ;;
  inventory)
    cp -- "${state_directory}/restored.inventory.tsv" "$3"
    ;;
  *)
    exit 64
    ;;
esac
MOCK_TRANSPORT
chmod 700 -- "${transport}"

snapshot_root="${test_root}/backups/nova/documents"
timestamp=20260717T210000Z
common_environment=(
  PATH="${mock_bin}:${PATH}"
  NOVA_OPS_TEST_MODE=1
  NOVA_OPS_TEST_ROOT="${test_root}"
  NOVA_DOCUMENTS_BACKUP_DIR="${snapshot_root}"
  NOVA_DOCUMENTS_TRANSPORT_COMMAND="${transport}"
  DOCUMENTS_S3_BUCKET=nova-documents-drill
  DOCUMENTS_S3_ENDPOINT=https://minio.nova.invalid
  DOCUMENTS_S3_ACCESS_KEY=nova-only
  DOCUMENTS_S3_SECRET_KEY=nova-secret
  PULSO_DATABASE_PASSWORD=forbidden
  LUMEN_DATABASE_PASSWORD=forbidden
)

export_output="$(env "${common_environment[@]}" NOVA_DOCUMENTS_SNAPSHOT_TIMESTAMP="${timestamp}" \
  bash "${snapshot_script}" export)"
snapshot_directory="${snapshot_root}/nova-documents-${timestamp}"
[[ -s "${snapshot_directory}/snapshot.ref" && -s "${snapshot_directory}/inventory.tsv" ]] \
  || fail "export did not publish a complete snapshot directory"
snapshot_sha="$(awk -F= '$1 == "DOCUMENTS_SNAPSHOT_SHA256" { print $2 }' <<<"${export_output}")"
inventory_sha="$(awk -F= '$1 == "DOCUMENTS_INVENTORY_SHA256" { print $2 }' <<<"${export_output}")"
bundle_sha="$(awk -F= '$1 == "DOCUMENTS_BUNDLE_SHA256" { print $2 }' <<<"${export_output}")"
[[ "${snapshot_sha}" =~ ^[a-f0-9]{64}$ ]] || fail "snapshot SHA was not reported"
[[ "${inventory_sha}" =~ ^[a-f0-9]{64}$ ]] || fail "inventory SHA was not reported"
[[ "${bundle_sha}" =~ ^[a-f0-9]{64}$ ]] || fail "bundle SHA was not reported"
grep -F 'DOCUMENTS_OBJECT_COUNT=2' <<<"${export_output}" >/dev/null || fail "object count was not reported"
grep -F 'DOCUMENTS_TOTAL_BYTES=8' <<<"${export_output}" >/dev/null || fail "byte count was not reported"

confirmation="RESTORE NOVA DOCUMENTS nova-documents-drill BUNDLE SHA256 ${bundle_sha}"
restore_output="$(env "${common_environment[@]}" \
  NOVA_DOCUMENTS_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  NOVA_DOCUMENTS_SNAPSHOT_SHA256="${snapshot_sha}" \
  NOVA_DOCUMENTS_INVENTORY_SHA256="${inventory_sha}" \
  NOVA_DOCUMENTS_BUNDLE_SHA256="${bundle_sha}" \
  NOVA_DOCUMENTS_RESTORE_CONFIRM="${confirmation}" \
  bash "${snapshot_script}" restore)"
grep -F "DOCUMENTS_INVENTORY_SHA256=${inventory_sha}" <<<"${restore_output}" >/dev/null \
  || fail "restore did not verify the post-restore inventory"

if env "${common_environment[@]}" \
  NOVA_DOCUMENTS_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  NOVA_DOCUMENTS_SNAPSHOT_SHA256="${snapshot_sha}" \
  NOVA_DOCUMENTS_INVENTORY_SHA256="${inventory_sha}" \
  NOVA_DOCUMENTS_BUNDLE_SHA256="${bundle_sha}" \
  NOVA_DOCUMENTS_RESTORE_CONFIRM='RESTORE NOVA DOCUMENTS' \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore accepted a non-exact destructive confirmation"
fi

wrong_sha="$(printf 'f%.0s' {1..64})"
if env "${common_environment[@]}" \
  NOVA_DOCUMENTS_SNAPSHOT_DIRECTORY="${snapshot_directory}" \
  NOVA_DOCUMENTS_SNAPSHOT_SHA256="${snapshot_sha}" \
  NOVA_DOCUMENTS_INVENTORY_SHA256="${wrong_sha}" \
  NOVA_DOCUMENTS_BUNDLE_SHA256="${bundle_sha}" \
  NOVA_DOCUMENTS_RESTORE_CONFIRM="${confirmation}" \
  bash "${snapshot_script}" restore >/dev/null 2>&1; then
  fail "restore accepted an incorrect inventory SHA"
fi

if env PATH="${mock_bin}:${PATH}" NOVA_OPS_TEST_MODE=1 NOVA_OPS_TEST_ROOT="${test_root}" \
  NOVA_DOCUMENTS_BACKUP_DIR="${snapshot_root}" DOCUMENTS_S3_BUCKET=nova-documents-drill \
  NOVA_DOCUMENTS_SNAPSHOT_TIMESTAMP=20260717T210001Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "export did not fail closed without a transport command"
fi

if env PATH="${mock_bin}:${PATH}" NOVA_OPS_TEST_MODE=1 NOVA_OPS_TEST_ROOT="${test_root}" \
  NOVA_DOCUMENTS_BACKUP_DIR="${snapshot_root}" NOVA_DOCUMENTS_TRANSPORT_COMMAND="${transport}" \
  NOVA_DOCUMENTS_SNAPSHOT_TIMESTAMP=20260717T210002Z \
  bash "${snapshot_script}" export >/dev/null 2>&1; then
  fail "export did not fail closed without DOCUMENTS_S3_BUCKET"
fi

printf 'NOVA Documents snapshot export/restore hooks passed.\n'
