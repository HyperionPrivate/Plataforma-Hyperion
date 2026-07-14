import { pathToFileURL } from "node:url";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  createNatsTopologyAdapter,
  ensureHyperionJetStreamTopology,
  type HyperionJetStreamTopologyOptions,
  type HyperionJetStreamTopologyResult,
  type JetStreamTopologyAdapter
} from "./jetstream-consumer.js";
import { natsInboxPrefix, readNatsAuthentication, type NatsAuthentication } from "./nats-auth.js";

export const HYPERION_KNOWN_CONSUMERS = [
  { eventType: "channel.inbound.received.v1", durableName: "pulso_channel_inbound_v1" },
  { eventType: "channel.inbound.received.v2", durableName: "pulso_channel_inbound_v2" },
  { eventType: "pulso.message.received.v1", durableName: "sofia_pulso_message_v1" },
  { eventType: "pulso.message.received.v2", durableName: "sofia_pulso_message_v2" },
  { eventType: "sofia.audit.event.record.v1", durableName: "audit_sofia_event_record_v1" },
  { eventType: "lumen.audit.event.record.v1", durableName: "audit_lumen_event_record_v1" },
  { eventType: "audit.event.record.v1", durableName: "audit_event_record_v1" },
  { eventType: "access.lumen.tenant-snapshot.v1", durableName: "lumen_tenant_snapshot_v1" },
  { eventType: "access.lumen.operator-grant.v1", durableName: "lumen_operator_grant_v1" },
  { eventType: "pulso.lumen.encounter-reference.v1", durableName: "lumen_encounter_reference_v1" }
] as const satisfies readonly HyperionJetStreamTopologyOptions[];

export interface BootstrapHyperionJetStreamOptions {
  readonly server: string;
  readonly authToken?: string;
  readonly username?: string;
  readonly password?: string;
  readonly connectionName?: string;
  readonly timeoutMs?: number;
  readonly allowToken?: boolean;
}

export interface HyperionTopologyProvisioningResult {
  readonly consumers: ReadonlyArray<
    HyperionJetStreamTopologyOptions & Readonly<{ result: HyperionJetStreamTopologyResult }>
  >;
}

export async function provisionHyperionJetStreamTopology(
  adapter: JetStreamTopologyAdapter,
  definitions: readonly HyperionJetStreamTopologyOptions[] = HYPERION_KNOWN_CONSUMERS
): Promise<HyperionTopologyProvisioningResult> {
  assertUniqueDefinitions(definitions);
  const consumers = [];
  for (const definition of definitions) {
    const result = await ensureHyperionJetStreamTopology(adapter, definition);
    consumers.push({ ...definition, result });
  }
  return { consumers };
}

/** One-shot administrative bootstrap. Application services must use provisionTopology=false. */
export async function bootstrapHyperionJetStreamTopology(
  options: BootstrapHyperionJetStreamOptions
): Promise<HyperionTopologyProvisioningResult> {
  if (!options || typeof options !== "object") {
    throw new TypeError("JetStream bootstrap options are required");
  }
  const server = requireCredentialFreeNatsUrl(options.server);
  const authentication = readNatsAuthentication(
    { authToken: options.authToken, username: options.username, password: options.password },
    {
      required: true,
      minimumSecretLength: 24,
      serverConfigurationSafe: true,
      allowToken: options.allowToken
    }
  );
  const timeoutMs = requireTimeout(options.timeoutMs ?? 5_000);
  const connectionName = requireConnectionName(options.connectionName ?? "hyperion-topology-bootstrap");
  let connection: NatsConnection | undefined;
  try {
    connection = await connect({
      servers: server,
      name: connectionName,
      timeout: timeoutMs,
      inboxPrefix: natsInboxPrefix(authentication),
      ...toNatsConnectionAuthentication(authentication!)
    });
    const manager = await jetstreamManager(connection, { timeout: timeoutMs });
    return await provisionHyperionJetStreamTopology(createNatsTopologyAdapter(manager));
  } finally {
    if (connection !== undefined && !connection.isClosed()) {
      try {
        await connection.drain();
      } catch {
        if (!connection.isClosed()) await connection.close();
      }
    }
  }
}

async function main(): Promise<void> {
  const result = await bootstrapHyperionJetStreamTopology({
    server: process.env.NATS_URL ?? "",
    authToken: process.env.NATS_AUTH_TOKEN,
    username: process.env.NATS_USERNAME,
    password: process.env.NATS_PASSWORD,
    allowToken: process.env.NODE_ENV !== "production"
  });
  process.stdout.write(
    `${JSON.stringify({ status: "ready", stream: "HYPERION_EVENTS", consumers: result.consumers.length })}\n`
  );
}

function assertUniqueDefinitions(definitions: readonly HyperionJetStreamTopologyOptions[]): void {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new TypeError("at least one JetStream consumer definition is required");
  }
  const eventDurables = new Set<string>();
  const durableNames = new Set<string>();
  for (const definition of definitions) {
    const key = `${definition.eventType}\u0000${definition.durableName}`;
    if (eventDurables.has(key) || durableNames.has(definition.durableName)) {
      throw new TypeError("JetStream consumer definitions must use unique durable names");
    }
    eventDurables.add(key);
    durableNames.add(definition.durableName);
  }
}

function requireCredentialFreeNatsUrl(value: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error("NATS_URL is required for JetStream topology bootstrap");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("NATS_URL must be a valid credential-free NATS URL");
  }
  if (
    (parsed.protocol !== "nats:" && parsed.protocol !== "tls:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NATS_URL must be a credential-free nats: or tls: endpoint without path, query, or hash");
  }
  return normalized;
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError("timeoutMs must be an integer between 1 and 60000");
  }
  return value;
}

function requireConnectionName(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError("connectionName must be a safe NATS name");
  }
  return value;
}

function toNatsConnectionAuthentication(
  authentication: NatsAuthentication
): Readonly<{ token: string }> | Readonly<{ user: string; pass: string }> {
  if (authentication.authToken !== undefined) return { token: authentication.authToken };
  return { user: authentication.username, pass: authentication.password };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("jetstream_topology_bootstrap_failed\n");
    process.exitCode = 1;
  });
}
