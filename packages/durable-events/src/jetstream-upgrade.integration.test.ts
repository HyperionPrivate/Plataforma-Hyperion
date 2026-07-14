import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { describe, expect, it } from "vitest";
import { HYPERION_KNOWN_CONSUMERS, provisionHyperionJetStreamTopology } from "./jetstream-bootstrap.js";
import {
  HYPERION_EVENTS_STREAM,
  createNatsTopologyAdapter,
  ensureHyperionJetStreamTopology
} from "./jetstream-consumer.js";

const testUrl = process.env.TEST_NATS_UPGRADE_URL;
const topologyPassword = process.env.TEST_NATS_TOPOLOGY_PASSWORD;
const describeIntegration = testUrl && topologyPassword ? describe : describe.skip;

describeIntegration("JetStream rolling topology upgrade", () => {
  it("keeps an unknown stale durable while adding all managed durables beside the legacy Audit drain", async () => {
    const connection = await connect({
      servers: testUrl!,
      user: "topology",
      pass: topologyPassword!,
      inboxPrefix: "_INBOX.topology",
      name: "topology-upgrade-integration-test",
      timeout: 5_000
    });

    try {
      const manager = await jetstreamManager(connection, { timeout: 5_000 });
      const adapter = createNatsTopologyAdapter(manager);
      const legacyAudit = HYPERION_KNOWN_CONSUMERS.find(({ durableName }) => durableName === "audit_event_record_v1");
      expect(legacyAudit).toBeDefined();

      await ensureHyperionJetStreamTopology(adapter, legacyAudit!);
      await ensureHyperionJetStreamTopology(adapter, {
        eventType: "upgrade.stale.unknown.v1",
        durableName: "upgrade_stale_unknown_v1"
      });

      const result = await provisionHyperionJetStreamTopology(adapter);
      expect(result.consumers).toHaveLength(10);
      for (const definition of HYPERION_KNOWN_CONSUMERS) {
        await expect(adapter.getConsumer(HYPERION_EVENTS_STREAM, definition.durableName)).resolves.toBeDefined();
      }
      await expect(adapter.getConsumer(HYPERION_EVENTS_STREAM, "upgrade_stale_unknown_v1")).resolves.toBeDefined();
    } finally {
      await connection.close();
    }
  }, 20_000);
});
