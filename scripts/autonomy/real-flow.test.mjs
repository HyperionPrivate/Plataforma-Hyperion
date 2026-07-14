import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "real-flow.e2e.mjs");
const source = readFileSync(scriptPath, "utf8");
const workflowPath = join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/check.yml");
const workflow = readFileSync(workflowPath, "utf8");

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

test("autonomy E2E verifies Channel-owned binding fields before advancing the flow", () => {
  assert.match(source, /binding\.patient_id as "patientId"/);
  assert.match(source, /binding\.conversation_id as "conversationId"/);
  assert.match(source, /inbound\.message_id as "messageId"/);
  assert.match(source, /eventThreadBindingId:\s*firstPersistence\.threadBindingId/);
  assert.match(source, /messageId:\s*pulsoProjection\.messageId/);
});
