import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "real-flow.e2e.mjs");
const source = readFileSync(scriptPath, "utf8");
const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows/legacy-monolith-diagnostic.yml"
);
const workflow = readFileSync(workflowPath, "utf8");
const natsAcl = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../infra/nats/nats-server.conf"),
  "utf8"
);
const auditJetStreamSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../services/audit-service/src/audit-jetstream.ts"),
  "utf8"
);
const jetStreamBootstrapSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../packages/durable-events/src/jetstream-bootstrap.ts"),
  "utf8"
);
const liwaBindingSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "liwa-bind-tenant.mjs"), "utf8");

test("autonomy E2E wires the real PULSO-to-Channel thread contract into the consumer", () => {
  assert.match(source, /import \{ createChannelThreadClient \} from/);
  assert.match(source, /import \{ registerThreadBindRoutes \} from/);
  assert.match(source, /serviceName:\s*"whatsapp-channel-service"/);
  assert.match(source, /process\.env\.EXPECTED_DATABASE_ROLE\s*=\s*"hyperion_channel"/);
  assert.match(source, /registerThreadBindRoutes\(app, context, credential\)/);
  assert.match(source, /client:\s*createChannelThreadClient\(\{ channelServiceUrl, credential \}\)/);
  assert.match(source, /channelThreads:\s*channelThreadContract\.client/);
});

test("autonomy E2E wires Channel delivery through its real outbox, dispatcher and PULSO consumer", () => {
  assert.match(source, /import \{ PostgresChannelDeliveryOutbox \} from/);
  assert.match(source, /import \{ startChannelDeliveryJetStreamConsumer \} from/);
  assert.match(source, /const channelDeliveryConsumerProbe = createInspectableDeliveryConsumerFactory\(\)/);
  assert.match(
    source,
    /startChannelDeliveryJetStreamConsumer\([\s\S]*?pulsoDb,[\s\S]*?channelDeliveryConsumerProbe\.factory/
  );
  assert.match(source, /const channelDeliveryOutbox = new PostgresChannelDeliveryOutbox\(/);
  assert.match(source, /const channelDeliveryDispatcher = jetStreamDispatcher\(channelDeliveryOutbox,/);
  assert.match(source, /dispatchers\.push\([\s\S]*?channelDeliveryDispatcher/);
});

test("autonomy E2E requires a first-delivery ACK and then an idle Channel-delivery consumer", () => {
  assert.match(
    source,
    /await channelDeliveryConsumerProbe\.consumeOnce\(\),[\s\S]*?\{ status: "acked", deliveryCount: 1 \}[\s\S]*?confirmed ACK without NAK, redelivery or DLQ/
  );
  assert.match(
    source,
    /assert\.deepEqual\(await channelDeliveryConsumerProbe\.consumeOnce\(\), \{ status: "idle" \}\)/
  );
});

test("autonomy E2E verifies the PULSO delivery projection before and after dispatch", () => {
  assert.match(source, /assert\.equal\(deliveryBeforeDispatch\.deliveryStatus, "queued"\)/);
  assert.match(source, /assertDrain\(await channelDeliveryDispatcher\.drainOnce\(\), "channel-delivery"\)/);
  assert.match(source, /assert\.equal\(deliveryProjection\.deliveryStatus, "sent"\)/);
  assert.match(source, /assert\.equal\(deliveryProjection\.providerMessageId, providerMessageId\)/);
  assert.match(source, /channelDeliveryOutbox:\s*1/);
  assert.match(source, /pulsoDeliveryInbox:\s*1/);
  assert.match(source, /pulsoDeliveryEffect:\s*1/);
});

test("autonomy E2E dispatches and counts Channel and PULSO transactional audit evidence", () => {
  assert.match(source, /import \{ PostgresChannelAuditOutbox \} from/);
  assert.match(source, /import \{ PostgresPulsoAuditOutbox \} from/);
  assert.match(source, /const channelAuditDispatcher = jetStreamDispatcher\(channelAuditOutbox,/);
  assert.match(source, /const pulsoAuditDispatcher = jetStreamDispatcher\(pulsoAuditOutbox,/);
  assert.match(source, /assertDrain\(await channelAuditDispatcher\.drainOnce\(\), "channel-audit"\)/);
  assert.match(source, /assertDrain\(await pulsoAuditDispatcher\.drainOnce\(\), "pulso-audit"\)/);
  assert.match(source, /channelAuditOutbox:\s*1/);
  assert.match(source, /channelAuditInbox:\s*1/);
  assert.match(source, /channelAuditEffect:\s*1/);
  assert.match(source, /pulsoAuditOutbox:\s*2/);
  assert.match(source, /pulsoAuditInbox:\s*2/);
  assert.match(source, /pulsoAuditEffect:\s*2/);
});

test("autonomy E2E reads producer provenance from the Audit inbox owner", () => {
  assert.doesNotMatch(source, /ledger\.source_service/);
  assert.equal(source.match(/inbox\.source_service as "sourceService"/g)?.length, 2);
});

test("CI runs the real autonomy flow before destructive NATS ACL probes", () => {
  const bootstrap = workflow.indexOf("- name: Bootstrap JetStream topology");
  const autonomy = workflow.indexOf("- name: Test autonomous Channel to Audit flow");
  const acl = workflow.indexOf("- name: Verify NATS service ACL denials");
  const stop = workflow.indexOf("- name: Stop NATS JetStream test server");

  assert.ok(bootstrap >= 0);
  assert.ok(bootstrap < autonomy);
  assert.ok(autonomy < acl);
  assert.ok(acl < stop);
});

test("Audit NATS ACL can initialize every provider-owned durable, including NOVA", () => {
  const durableNames = [...auditJetStreamSource.matchAll(/durableName:\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
  assert.ok(durableNames.length > 0);
  for (const durableName of durableNames) {
    assert.equal(jetStreamBootstrapSource.includes(`durableName: "${durableName}"`), true);
    assert.equal(natsAcl.includes(`$JS.API.CONSUMER.INFO.HYPERION_EVENTS.${durableName}`), true);
    assert.equal(natsAcl.includes(`$JS.API.CONSUMER.MSG.NEXT.HYPERION_EVENTS.${durableName}`), true);
    assert.equal(natsAcl.includes(`$JS.ACK.HYPERION_EVENTS.${durableName}.>`), true);
  }
  assert.equal(natsAcl.includes("hyperion.dlq.nova.audit.event.record.v1"), true);
});

test("NATS capacity reserves five rolling-upgrade slots above the managed topology", () => {
  const managedDurableNames = [...jetStreamBootstrapSource.matchAll(/durableName:\s*"([a-z0-9_]+)"/g)].map(
    (match) => match[1]
  );
  const maxConsumers = natsAcl.match(/max_consumers:\s*(\d+)/);

  assert.ok(maxConsumers);
  assert.equal(new Set(managedDurableNames).size, managedDurableNames.length);
  assert.equal(Number(maxConsumers[1]), managedDurableNames.length + 5);
});

test("the real autonomy flow uses the provider-owned Audit database instead of the shared database", () => {
  assert.match(source, /requiredEnvironment\(environment, "TEST_AUDIT_DATABASE_URL"\)/);
  assert.match(source, /requiredEnvironment\(environment, "TEST_AUDIT_ADMIN_DATABASE_URL"\)/);
  assert.match(source, /createDatabase\(configuration\.auditDatabaseUrl\)/);
  assert.match(source, /createDatabase\(configuration\.auditAdminDatabaseUrl\)/);
  assert.doesNotMatch(source, /serviceDatabaseUrl\(configuration, "hyperion_audit"/);
  assert.match(source, /audit_database_must_be_logically_isolated/);
  assert.match(source, /const databasePasswords = \[\s*parsedAuditDatabaseUrl\.password/);
  assert.match(workflow, /TEST_AUDIT_DATABASE_URL=/);
  assert.match(workflow, /TEST_AUDIT_ADMIN_DATABASE_URL:/);

  const sharedCounts = source.slice(
    source.indexOf('const sharedCounts = await oneRow(adminDb, "shared flow counts"'),
    source.indexOf('const auditCounts = await oneRow(auditDb, "Audit flow counts"')
  );
  assert.doesNotMatch(sharedCounts, /audit_runtime|platform\.audit_events/);
  assert.equal(source.match(/queryOneOrUndefined\(auditDb/g)?.length, 2);
  assert.match(source, /const result = await auditDb\.query\(/);
  assert.match(source, /cleanupSyntheticTenant\(adminDb, auditAdminDb, tenantId\)/);
});

test("the autonomy fixture provisions and removes every consumer-owned tenant projection", () => {
  for (const table of [
    "channel_runtime.tenant_snapshots",
    "integration_runtime.tenant_snapshots",
    "agent_runtime.tenant_snapshots",
    "pulso_iris.tenant_snapshots",
    "knowledge_runtime.tenant_snapshots"
  ]) {
    assert.match(source, new RegExp(`"${table.replace(".", "\\.")}"`));
  }
  assert.match(source, /return adminDb\.transaction\(async \(transaction\) =>/);
  assert.match(source, /insert into \$\{table\} \(/);
  assert.match(source, /delete from \$\{table\} where tenant_id = \$1/);
  assert.ok(source.indexOf("delete from ${table}") < source.indexOf("delete from platform.tenants"));
});

test("LIWA tenant provisioning requires explicit account and tenant configuration", () => {
  assert.match(liwaBindingSource, /process\.env\.LIWA_ACCOUNT_ID \?\? ""/);
  assert.match(liwaBindingSource, /process\.env\.LIWA_BIND_TENANT_ID \?\? ""/);
  assert.doesNotMatch(liwaBindingSource, /LIWA_WEBHOOK_DEFAULT_TENANT_ID|1656233/);
  assert.match(liwaBindingSource, /LIWA_BIND_TENANT_ID must be a tenant UUID/);
});

test("autonomy E2E verifies Channel-owned binding fields before advancing the flow", () => {
  assert.match(source, /binding\.patient_id as "patientId"/);
  assert.match(source, /binding\.conversation_id as "conversationId"/);
  assert.match(source, /inbound\.message_id as "messageId"/);
  assert.match(source, /eventThreadBindingId:\s*firstPersistence\.threadBindingId/);
  assert.match(source, /messageId:\s*pulsoProjection\.messageId/);
});
