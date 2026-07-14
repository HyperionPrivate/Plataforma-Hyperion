import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(directory, "n-minus-one-pulso-channel-sql-window.sh"), "utf8");
const sofiaScript = readFileSync(join(directory, "n-minus-one-sofia-pulso-sql-window.sh"), "utf8");
const stateProbe = readFileSync(join(directory, "verify-n-minus-one-delivery-drain-states.sh"), "utf8");
const driftProbe = readFileSync(join(directory, "verify-n-minus-one-sql-window-drift.sh"), "utf8");
const sofiaDriftProbe = readFileSync(join(directory, "verify-n-minus-one-sofia-sql-window-drift.sh"), "utf8");
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
  assert.match(stateProbe, /probe_id=\$\([\s\S]*select gen_random_uuid\(\);/);
  assert.match(stateProbe, /values \([\s\S]*:'probe_id'::uuid/);
  assert.match(stateProbe, /-v probe_status="\$status"/);
  assert.equal(stateProbe.match(/--file=-[^\n]*<<'SQL'/g)?.length, 2);
  assert.deepEqual(
    stateProbe.match(/^\s*-c(?:\s|=).*$/gm)?.map((line) => line.trim()),
    ['-c "select gen_random_uuid();"']
  );
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

test("legacy SOFIA window reconstructs the durable read baseline and exact write allow-list", () => {
  const open = section(sofiaScript, 'if [[ $mode == "open" ]]', 'elif [[ $mode == "close" ]]');
  const close = section(sofiaScript, 'elif [[ $mode == "close" ]]', "else");
  const verifier = section(sofiaScript, "do $verify$", 'if [[ $mode == "verify-open" ]]');
  const functionalProbe = section(sofiaScript, "-- Parse, authorize and plan", "rollback;");

  for (const lifecycle of [open, close]) {
    assert.match(lifecycle, /pg_advisory_xact_lock/);
    assert.match(lifecycle, /set local lock_timeout = '5s'/);
    assert.match(lifecycle, /set local statement_timeout = '30s'/);
    assert.match(lifecycle, /revoke all privileges on schema pulso_iris from hyperion_sofia/);
    assert.match(lifecycle, /revoke all privileges on all tables in schema pulso_iris from hyperion_sofia/);
    assert.match(lifecycle, /revoke all privileges on all sequences in schema pulso_iris from hyperion_sofia/);
    assert.match(lifecycle, /revoke all privileges on all routines in schema pulso_iris from hyperion_sofia/);
    assert.match(lifecycle, /grant usage on schema pulso_iris to hyperion_sofia/);
    assert.match(
      lifecycle,
      /grant select on table pulso_iris\.administrative_patients,[\s\S]*pulso_iris\.conversations, pulso_iris\.messages to hyperion_sofia/
    );
  }

  assert.match(open, /grant update \(metadata, primary_intent, updated_at\)/);
  assert.match(
    open,
    /grant insert \([\s\S]*tenant_id, conversation_id, sender, body, provider,[\s\S]*external_message_id, delivery_status, metadata[\s\S]*\), update \(body\)/
  );
  assert.doesNotMatch(close, /grant (?:insert|update)/);
  assert.doesNotMatch(open, /grant (?:insert|update)\s+on table/i);

  assert.match(verifier, /has_database_privilege/);
  assert.match(verifier, /CONNECT-only database access/);
  assert.match(verifier, /role must not own PULSO objects/);
  assert.match(verifier, /pg_catalog\.pg_auth_members/);
  assert.match(verifier, /pg_catalog\.pg_class/);
  assert.match(verifier, /pg_catalog\.pg_attribute/);
  assert.match(verifier, /pg_catalog\.pg_type/);
  assert.match(verifier, /relkind in \('r', 'p', 'v', 'm', 'f'\)/);
  assert.doesNotMatch(verifier, /information_schema\.(?:tables|columns)/);
  assert.match(verifier, /has_schema_privilege/);
  assert.match(verifier, /has_table_privilege/);
  assert.match(verifier, /has_column_privilege/);
  assert.match(verifier, /has_sequence_privilege/);
  assert.match(verifier, /has_function_privilege/);
  assert.match(verifier, /'SELECT WITH GRANT OPTION'/);
  assert.match(verifier, /'INSERT WITH GRANT OPTION'/);
  assert.match(verifier, /'UPDATE WITH GRANT OPTION'/);

  const expectedWrites = [
    ["conversations", "metadata", false, "expected_window_open"],
    ["conversations", "primary_intent", false, "expected_window_open"],
    ["conversations", "updated_at", false, "expected_window_open"],
    ["messages", "tenant_id", "expected_window_open", false],
    ["messages", "conversation_id", "expected_window_open", false],
    ["messages", "sender", "expected_window_open", false],
    ["messages", "body", "expected_window_open", "expected_window_open"],
    ["messages", "provider", "expected_window_open", false],
    ["messages", "external_message_id", "expected_window_open", false],
    ["messages", "delivery_status", "expected_window_open", false],
    ["messages", "metadata", "expected_window_open", false]
  ];
  for (const [table, column, canInsert, canUpdate] of expectedWrites) {
    assert.ok(
      verifier.includes(`('${table}', '${column}', ${canInsert}, ${canUpdate})`),
      `missing SOFIA privilege tuple ${table}.${column}`
    );
  }

  assert.match(functionalProbe, /set local lock_timeout = '5s'/);
  assert.match(functionalProbe, /set local statement_timeout = '30s'/);
  assert.match(functionalProbe, /set local role hyperion_sofia/);
  assert.match(functionalProbe, /update pulso_iris\.conversations[\s\S]*and false;/);
  assert.match(functionalProbe, /insert into pulso_iris\.messages/);
  assert.match(functionalProbe, /where false[\s\S]*on conflict/);
  assert.match(functionalProbe, /do update set body = pulso_iris\.messages\.body/);
  assert.match(functionalProbe, /select full_name from pulso_iris\.administrative_patients where false/);
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

test("SOFIA PostgreSQL drift probe rejects write, read, ownership and identity expansion", () => {
  assert.match(sofiaDriftProbe, /trap cleanup_on_exit EXIT/);
  assert.match(sofiaDriftProbe, /grant create on schema pulso_iris to hyperion_sofia/i);
  assert.match(sofiaDriftProbe, /grant update on table pulso_iris\.conversations to hyperion_sofia/i);
  assert.match(sofiaDriftProbe, /grant update \(status\) on table pulso_iris\.conversations/i);
  assert.match(
    sofiaDriftProbe,
    /grant update \(metadata\) on table pulso_iris\.conversations to hyperion_sofia with grant option/i
  );
  assert.match(sofiaDriftProbe, /grant select on table pulso_iris\.sites to hyperion_sofia/i);
  assert.match(sofiaDriftProbe, /create materialized view pulso_iris\./i);
  assert.match(
    sofiaDriftProbe,
    /grant select on table pulso_iris\.hyperion_n1_sofia_sql_window_probe_materialized to hyperion_sofia/i
  );
  assert.match(sofiaDriftProbe, /owner to hyperion_sofia/i);
  assert.match(sofiaDriftProbe, /create type pulso_iris\.[^\s]+ as enum/i);
  assert.match(sofiaDriftProbe, /alter type pulso_iris\.[^\s]+ owner to hyperion_sofia/i);
  assert.match(sofiaDriftProbe, /grant usage on sequence pulso_iris\./i);
  assert.match(sofiaDriftProbe, /grant execute on function pulso_iris\.[^(]+\(\) to public/i);
  assert.match(sofiaDriftProbe, /grant hyperion_n1_sofia_sql_window_probe_role to hyperion_sofia/i);
  assert.match(sofiaDriftProbe, /grant hyperion_sofia to hyperion_n1_sofia_sql_window_probe_role/i);
  assert.match(sofiaDriftProbe, /window verify-open/);
  assert.match(sofiaDriftProbe, /window verify-closed/);
  assert.match(sofiaDriftProbe, /window close/);
});

test("workflow gates N-1 workloads, compares the immutable snapshot and always closes SQL compatibility", () => {
  const jobEnvironment = section(workflow, "n-minus-one-upgrade-rollback:", "steps:");
  const stopped = workflow.indexOf("- name: Stop current workloads while preserving upgraded PostgreSQL");
  const stateProbeStep = workflow.indexOf("- name: Exercise Channel delivery drain states against PostgreSQL");
  const driftProbeStep = workflow.indexOf("- name: Reject N-1 SQL-window privilege drift against PostgreSQL");
  const gated = workflow.indexOf("- name: Verify Channel delivery is drained before N-1 rollback");
  const lumenWindow = workflow.indexOf("- name: Open bounded LUMEN compatibility for the final N-1 rollback");
  const channelWindow = workflow.indexOf(
    "- name: Open bounded PULSO-to-Channel SQL compatibility before N-1 workloads"
  );
  const sofiaWindow = workflow.indexOf("- name: Open bounded SOFIA-to-PULSO SQL compatibility before N-1 workloads");
  const nMinusOne = workflow.indexOf("- name: Return to N-1 images against the upgraded schema");
  const currentTraffic = workflow.indexOf(
    "- name: Exercise durable Channel to PULSO to SOFIA traffic on a current-capable N-1 rollback"
  );
  const cleanup = workflow.indexOf("- name: Close N-1 SQL windows and verify delivery immutability");
  const diagnostics = workflow.indexOf("- name: Print compatibility diagnostics");
  const teardown = workflow.indexOf("- name: Remove compatibility containers and volumes");
  assert.match(jobEnvironment, /HYPERION_ENVIRONMENT:\s*ci/);
  assert.ok(
    stopped < stateProbeStep &&
      stateProbeStep < driftProbeStep &&
      driftProbeStep < gated &&
      gated < lumenWindow &&
      lumenWindow < channelWindow &&
      channelWindow < sofiaWindow &&
      sofiaWindow < nMinusOne
  );
  assert.ok(nMinusOne < currentTraffic && currentTraffic < cleanup && cleanup < diagnostics && diagnostics < teardown);

  const stopCurrentStep = section(
    workflow,
    "- name: Stop current workloads while preserving upgraded PostgreSQL",
    "- name: Exercise Channel delivery drain states against PostgreSQL"
  );
  assert.match(stopCurrentStep, /current_compose\[@\].*stop --timeout 75/s);
  assert.match(stopCurrentStep, /ps --status running --quiet postgres/);
  assert.doesNotMatch(stopCurrentStep, /\bdown\b|--remove-orphans/);

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
  assert.match(driftExerciseStep, /verify-n-minus-one-sofia-sql-window-drift\.sh/);
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

  const channelWindowStep = section(
    workflow,
    "- name: Open bounded PULSO-to-Channel SQL compatibility before N-1 workloads",
    "- name: Open bounded SOFIA-to-PULSO SQL compatibility before N-1 workloads"
  );
  assert.match(channelWindowStep, /traffic_contract == 'legacy'/);
  assert.match(channelWindowStep, /up --detach --no-build --wait --wait-timeout 120 postgres/);
  assert.ok(channelWindowStep.indexOf(".sh open") < channelWindowStep.indexOf(".sh verify-open"));
  assert.doesNotMatch(
    channelWindowStep,
    /\b(identity-service|agent-service|pulso-iris-service|whatsapp-channel-service|lumen-service)\b/
  );

  const sofiaWindowStep = section(
    workflow,
    "- name: Open bounded SOFIA-to-PULSO SQL compatibility before N-1 workloads",
    "- name: Return to N-1 images against the upgraded schema"
  );
  assert.match(sofiaWindowStep, /sofia_pulso_contract == 'legacy_sql'/);
  assert.match(sofiaWindowStep, /up --detach --no-build --wait --wait-timeout 120 postgres/);
  assert.ok(sofiaWindowStep.indexOf(".sh open") < sofiaWindowStep.indexOf(".sh verify-open"));
  assert.doesNotMatch(
    sofiaWindowStep,
    /\b(identity-service|agent-service|pulso-iris-service|whatsapp-channel-service|lumen-service)\b/
  );

  const nMinusOneStep = section(
    workflow,
    "- name: Return to N-1 images against the upgraded schema",
    "- name: Exercise durable Channel to PULSO to SOFIA traffic on a current-capable N-1 rollback"
  );
  assert.doesNotMatch(nMinusOneStep, /sql-window\.sh open/);
  assert.ok(
    nMinusOneStep.indexOf("verify-compose-readiness.sh") < nMinusOneStep.indexOf("verify-n-minus-one-sofia-traffic.sh")
  );
  assert.ok(
    nMinusOneStep.indexOf("verify-service-database-identities.sh") <
      nMinusOneStep.indexOf("verify-n-minus-one-sofia-traffic.sh")
  );

  const cleanupStep = section(
    workflow,
    "- name: Close N-1 SQL windows and verify delivery immutability",
    "- name: Exercise the declared LUMEN N-1 cleanup contract"
  );
  assert.match(cleanupStep, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(cleanupStep, /agent_stop_status=0[\s\S]*?stop --timeout 75 agent-service \|\| agent_stop_status=\$\?/);
  assert.match(
    cleanupStep,
    /prompt_flow_stop_status=0[\s\S]*?stop --timeout 75 prompt-flow-service \|\| prompt_flow_stop_status=\$\?/
  );
  assert.match(
    cleanupStep,
    /channel_stop_status=0[\s\S]*?stop --timeout 75 whatsapp-channel-service \|\| channel_stop_status=\$\?/
  );
  assert.match(
    cleanupStep,
    /pulso_stop_status=0[\s\S]*?stop --timeout 75 pulso-iris-service \|\| pulso_stop_status=\$\?/
  );
  assert.match(cleanupStep, /steps\.n1_delivery_drain\.outputs\.snapshot/);
  assert.match(cleanupStep, /steps\.n1_delivery_drain\.outcome/);
  assert.match(cleanupStep, /delivery_baseline_outcome\s*==\s*"success"/);
  assert.match(cleanupStep, /delivery_snapshot_after\s*!=\s*"\$expected_delivery_snapshot"/);
  assert.match(cleanupStep, /delivery_evidence_status=1/);
  assert.doesNotMatch(cleanupStep, /-z \$expected_delivery_snapshot \|\| \$delivery_snapshot_after/);
  assert.match(cleanupStep, /n-minus-one-pulso-channel-sql-window\.sh close/);
  assert.match(cleanupStep, /n-minus-one-pulso-channel-sql-window\.sh verify-closed/);
  assert.match(cleanupStep, /n-minus-one-sofia-pulso-sql-window\.sh close/);
  assert.match(cleanupStep, /n-minus-one-sofia-pulso-sql-window\.sh verify-closed/);
  assert.match(cleanupStep, /sofia_pulso_contract\s*==\s*"legacy_sql"/);
  assert.match(cleanupStep, /current_compose\[@\].*stop --timeout 75 \|\| current_stop_status=\$\?/s);
  assert.match(cleanupStep, /ps --status running --quiet postgres/);
  assert.match(
    cleanupStep,
    /for service in agent-service prompt-flow-service whatsapp-channel-service pulso-iris-service/
  );
  assert.match(cleanupStep, /ps --status running --quiet "\$service"/);
  assert.match(cleanupStep, /n1_workload_fence_status/);
  assert.doesNotMatch(cleanupStep, /\bdown\b|--remove-orphans|\|\| true/);

  const postgresFence = cleanupStep.indexOf("ps --status running --quiet postgres");
  const n1PostgresStart = cleanupStep.indexOf('"${n1_compose[@]}" up');
  assert.ok(postgresFence < n1PostgresStart);
  const evidence = cleanupStep.indexOf("verify-delivery-drained");
  for (const service of [
    "stop --timeout 75 agent-service",
    "stop --timeout 75 prompt-flow-service",
    "stop --timeout 75 whatsapp-channel-service",
    "stop --timeout 75 pulso-iris-service"
  ]) {
    assert.ok(cleanupStep.indexOf(service) < evidence, `${service} must precede delivery evidence`);
  }
  const channelClose = cleanupStep.indexOf("n-minus-one-pulso-channel-sql-window.sh close");
  const sofiaClose = cleanupStep.indexOf("n-minus-one-sofia-pulso-sql-window.sh close");
  const channelClosed = cleanupStep.indexOf("n-minus-one-pulso-channel-sql-window.sh verify-closed");
  const sofiaClosed = cleanupStep.indexOf("n-minus-one-sofia-pulso-sql-window.sh verify-closed");
  assert.ok(
    evidence < channelClose && channelClose < sofiaClose && sofiaClose < channelClosed && channelClosed < sofiaClosed
  );
  assert.match(cleanupStep, /for status in[\s\S]*exit "\$overall_status"/);
});
