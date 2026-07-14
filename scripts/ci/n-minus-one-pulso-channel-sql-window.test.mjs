import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(directory, "n-minus-one-pulso-channel-sql-window.sh"), "utf8");
const stateProbe = readFileSync(join(directory, "verify-n-minus-one-delivery-drain-states.sh"), "utf8");
const driftProbe = readFileSync(join(directory, "verify-n-minus-one-sql-window-drift.sh"), "utf8");
const workflow = readFileSync(join(directory, "../../.github/workflows/check.yml"), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing section terminator: ${endMarker}`);
  return source.slice(start, end);
}

test("delivery drain gate is read-only and blocks every non-published state", () => {
  const sql = section(script, "begin transaction read only;", "commit;");
  assert.match(sql, /event\.event_type\s*=\s*'channel\.delivery\.updated\.v1'/);
  assert.match(sql, /event\.status\s+is\s+distinct\s+from\s+'published'/);
  assert.match(sql, /to_jsonb\(event\)/);
  assert.doesNotMatch(sql, /^\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b/im);

  assert.match(stateProbe, /for status in queued retry_scheduled processing dead_letter/);
  assert.match(stateProbe, /insert_probe "\$status"/);
  assert.match(stateProbe, /if "\$\{drain_probe\[@\]\}"[^\n]*; then/);
  assert.match(stateProbe, /insert_probe published/);
  assert.ok(stateProbe.includes('published_snapshot=$("${drain_probe[@]}")'));
  assert.match(stateProbe, /trap cleanup_probe EXIT/);
  assert.match(stateProbe, /-v probe_id="\$probe_id"/);
  assert.match(stateProbe, /delete from channel_runtime\.outbox_events where id = :'probe_id'::uuid/);
});

test("legacy SQL window verifies the exact effective column allow-list", () => {
  const open = section(script, 'if [[ $mode == "open" ]]', 'elif [[ $mode == "close" ]]');
  const close = section(script, 'elif [[ $mode == "close" ]]', 'elif [[ $mode == "verify-open" ]]');
  const verifyOpen = section(script, 'elif [[ $mode == "verify-open" ]]', 'elif [[ $mode == "verify-closed" ]]');
  const verifyClosed = section(script, 'elif [[ $mode == "verify-closed" ]]', "else");

  for (const lifecycle of [open, close]) {
    assert.match(lifecycle, /revoke all privileges on schema channel_runtime from hyperion_pulso/);
    assert.match(lifecycle, /revoke all privileges on all tables in schema channel_runtime from hyperion_pulso/);
    assert.match(lifecycle, /revoke all privileges on all sequences in schema channel_runtime from hyperion_pulso/);
    assert.match(lifecycle, /revoke all privileges on all routines in schema channel_runtime from hyperion_pulso/);
  }
  assert.match(verifyOpen, /information_schema\.columns/);
  assert.match(verifyOpen, /information_schema\.tables/);
  assert.match(verifyOpen, /has_column_privilege\(/);
  assert.match(verifyOpen, /has_table_privilege\(/);
  assert.match(verifyOpen, /has_schema_privilege\([^)]*'CREATE'/s);
  assert.match(verifyOpen, /has_schema_privilege\([^)]*'USAGE WITH GRANT OPTION'/s);
  assert.match(verifyOpen, /pg_catalog\.pg_auth_members/);
  assert.match(verifyOpen, /has_sequence_privilege\(/);
  assert.match(verifyOpen, /has_function_privilege\(/);
  assert.match(verifyOpen, /'SELECT WITH GRANT OPTION'/);
  assert.match(verifyOpen, /'UPDATE WITH GRANT OPTION'/);
  assert.match(verifyOpen, /is distinct from coalesce\(expected\.can_select, false\)/);
  assert.match(verifyOpen, /is distinct from coalesce\(expected\.can_update, false\)/);
  for (const privilege of ["INSERT", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
    assert.ok(verifyOpen.includes(`'${privilege}'`), `missing rejection for extra ${privilege} privilege`);
  }

  const expected = [
    ["thread_bindings", "id", true, false],
    ["thread_bindings", "patient_id", true, true],
    ["thread_bindings", "conversation_id", true, true],
    ["thread_bindings", "tenant_id", true, false],
    ["thread_bindings", "last_inbound_at", false, true],
    ["thread_bindings", "updated_at", false, true],
    ["inbound_events", "tenant_id", true, false],
    ["inbound_events", "external_message_id", true, false],
    ["inbound_events", "provider", true, false],
    ["inbound_events", "thread_binding_id", false, true],
    ["inbound_events", "message_id", false, true],
    ["inbound_events", "updated_at", false, true]
  ];
  for (const [table, column, canSelect, canUpdate] of expected) {
    assert.ok(
      verifyOpen.includes(`('${table}', '${column}', ${canSelect}, ${canUpdate})`),
      `missing exact privilege tuple ${table}.${column}`
    );
  }

  assert.match(verifyClosed, /has_schema_privilege\([^)]*'CREATE'/s);
  assert.match(verifyClosed, /pg_catalog\.pg_auth_members/);
  assert.match(verifyClosed, /has_sequence_privilege\(/);
  assert.match(verifyClosed, /has_function_privilege\(/);
});

test("PostgreSQL drift probe rejects every excess privilege and restores a closed window", () => {
  assert.match(driftProbe, /trap cleanup_on_exit EXIT/);
  assert.match(driftProbe, /cleanup_probe_artifacts/);
  assert.match(driftProbe, /grant create on schema channel_runtime to hyperion_pulso/i);
  assert.match(driftProbe, /grant usage on sequence channel_runtime\.hyperion_n1_sql_window_probe_sequence/i);
  assert.match(
    driftProbe,
    /grant execute on function channel_runtime\.hyperion_n1_sql_window_probe_routine\(\) to public/i
  );
  assert.match(driftProbe, /grant hyperion_n1_sql_window_probe_role to hyperion_pulso/i);
  assert.match(driftProbe, /grant hyperion_pulso to hyperion_n1_sql_window_probe_role/i);
  assert.match(driftProbe, /expect_open_rejection[\s\S]*excess channel_runtime schema privileges/);
  assert.match(driftProbe, /expect_open_rejection[\s\S]*must not grant sequence privileges/);
  assert.match(driftProbe, /expect_open_rejection[\s\S]*must not grant routine execution/);
  assert.match(driftProbe, /expect_open_rejection[\s\S]*requires the fixed unprivileged hyperion_pulso identity/);
  assert.match(driftProbe, /expect_closed_rejection[\s\S]*compatibility privileges remain active/);
  assert.match(driftProbe, /window verify-open/);
  assert.match(driftProbe, /window verify-closed/);
});

test("workflow gates N-1 workloads, compares the immutable snapshot and always closes SQL compatibility", () => {
  const jobEnvironment = section(workflow, "n-minus-one-upgrade-rollback:", "steps:");
  const stopped = workflow.indexOf("- name: Stop current workloads while preserving upgraded PostgreSQL");
  const stateProbeStep = workflow.indexOf("- name: Exercise Channel delivery drain states against PostgreSQL");
  const driftProbeStep = workflow.indexOf("- name: Reject N-1 SQL-window privilege drift against PostgreSQL");
  const gated = workflow.indexOf("- name: Verify Channel delivery is drained before N-1 rollback");
  const lumenWindow = workflow.indexOf("- name: Open bounded LUMEN compatibility for the final N-1 rollback");
  const nMinusOne = workflow.indexOf("- name: Return to N-1 images against the upgraded schema");
  const currentTraffic = workflow.indexOf(
    "- name: Exercise durable Channel to PULSO to SOFIA traffic on a current-capable N-1 rollback"
  );
  const cleanup = workflow.indexOf("- name: Close N-1 SQL window and verify delivery immutability");
  assert.match(jobEnvironment, /HYPERION_ENVIRONMENT:\s*ci/);
  assert.ok(
    stopped < stateProbeStep &&
      stateProbeStep < driftProbeStep &&
      driftProbeStep < gated &&
      gated < lumenWindow &&
      lumenWindow < nMinusOne
  );
  assert.ok(nMinusOne < currentTraffic && currentTraffic < cleanup);

  const stateExerciseStep = section(
    workflow,
    "- name: Exercise Channel delivery drain states against PostgreSQL",
    "- name: Verify Channel delivery is drained before N-1 rollback"
  );
  assert.match(stateExerciseStep, /up --detach --no-build --wait --wait-timeout 120 postgres/);
  assert.match(stateExerciseStep, /verify-n-minus-one-delivery-drain-states\.sh/);
  assert.doesNotMatch(
    stateExerciseStep,
    /\b(identity-service|agent-service|pulso-iris-service|whatsapp-channel-service|lumen-service)\b/
  );

  const driftExerciseStep = section(
    workflow,
    "- name: Reject N-1 SQL-window privilege drift against PostgreSQL",
    "- name: Verify Channel delivery is drained before N-1 rollback"
  );
  assert.match(driftExerciseStep, /up --detach --no-build --wait --wait-timeout 120 postgres/);
  assert.match(driftExerciseStep, /verify-n-minus-one-sql-window-drift\.sh/);
  assert.doesNotMatch(
    driftExerciseStep,
    /\b(identity-service|agent-service|pulso-iris-service|whatsapp-channel-service|lumen-service)\b/
  );

  const gateStep = section(
    workflow,
    "- name: Verify Channel delivery is drained before N-1 rollback",
    "- name: Open bounded LUMEN compatibility for the final N-1 rollback"
  );
  assert.match(gateStep, /up --detach --no-build --wait --wait-timeout 120 postgres/);
  assert.match(gateStep, /verify-delivery-drained/);
  assert.doesNotMatch(
    gateStep,
    /\b(identity-service|agent-service|pulso-iris-service|whatsapp-channel-service|lumen-service)\b/
  );

  const cleanupStep = section(
    workflow,
    "- name: Close N-1 SQL window and verify delivery immutability",
    "- name: Exercise the declared LUMEN N-1 cleanup contract"
  );
  assert.match(cleanupStep, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(
    cleanupStep,
    /channel_stop_status=0[\s\S]*?stop --timeout 75 whatsapp-channel-service \|\| channel_stop_status=\$\?/
  );
  assert.match(
    cleanupStep,
    /pulso_stop_status=0[\s\S]*?stop --timeout 75 pulso-iris-service \|\| pulso_stop_status=\$\?/
  );
  assert.match(cleanupStep, /steps\.n1_delivery_drain\.outputs\.snapshot/);
  assert.match(cleanupStep, /delivery_snapshot_after\s*!=\s*"\$expected_delivery_snapshot"/);
  assert.match(cleanupStep, /n-minus-one-pulso-channel-sql-window\.sh close/);
  assert.match(cleanupStep, /n-minus-one-pulso-channel-sql-window\.sh verify-closed/);
  assert.ok(cleanupStep.indexOf("stop --timeout 75") < cleanupStep.indexOf("verify-delivery-drained"));
  assert.ok(cleanupStep.indexOf("verify-delivery-drained") < cleanupStep.indexOf(".sh close"));
});
