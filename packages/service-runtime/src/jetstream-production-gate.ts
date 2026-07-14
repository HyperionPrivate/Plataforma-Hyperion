/**
 * Fail-closed gate: single-node JetStream stays blocked in production.
 * Do not fake HA — PRODUCTION_JETSTREAM_ENABLED alone is insufficient.
 */

export function assertJetStreamProductionGate(environment: NodeJS.ProcessEnv = process.env): void {
  const transport = (environment.DURABLE_EVENT_TRANSPORT ?? "http").trim().toLowerCase();
  if (transport !== "jetstream") return;

  const hyperionEnv = (environment.HYPERION_ENVIRONMENT ?? "").trim().toLowerCase();
  const nodeEnv = (environment.NODE_ENV ?? "development").trim().toLowerCase();
  const isProduction = hyperionEnv === "production" || nodeEnv === "production";
  if (!isProduction) return;

  const enabled = environment.PRODUCTION_JETSTREAM_ENABLED?.trim() === "true";
  if (!enabled) {
    throw new Error(
      "DURABLE_EVENT_TRANSPORT=jetstream is refused in production. " +
        "Single-node JetStream remains blocked; set PRODUCTION_JETSTREAM_ENABLED=true only with a real HA cluster (TLS + replicas≥3)."
    );
  }

  const replicas = Number(environment.JETSTREAM_REPLICAS?.trim() ?? "1");
  if (!Number.isSafeInteger(replicas) || replicas < 3) {
    throw new Error(
      "Production JetStream requires JETSTREAM_REPLICAS>=3. Single-node and fake HA configurations are refused."
    );
  }

  const natsUrl = environment.NATS_URL?.trim() ?? "";
  let parsed: URL;
  try {
    parsed = new URL(natsUrl);
  } catch {
    throw new Error("Production JetStream requires a valid tls: NATS_URL");
  }
  if (parsed.protocol !== "tls:") {
    throw new Error(
      "Production JetStream requires NATS_URL with tls: (internal TLS). Plain nats: single-node pilots remain blocked."
    );
  }
}
