/**
 * Fail-closed gate: single-node JetStream stays blocked in real production.
 * Do not fake HA — PRODUCTION_JETSTREAM_ENABLED alone is insufficient.
 *
 * Compose hardcodes NODE_ENV=production for every workload. CI and local
 * JetStream rehearsals that load `.env.example` may set
 * HYPERION_ALLOW_EXAMPLE_SECRETS=true (or CI=true). Those are pilots, not
 * production cutover. HYPERION_ENVIRONMENT=production|staging always enforces.
 */

export function assertJetStreamProductionGate(environment: NodeJS.ProcessEnv = process.env): void {
  const transport = (environment.DURABLE_EVENT_TRANSPORT ?? "http").trim().toLowerCase();
  if (transport !== "jetstream") return;

  if (!shouldEnforceJetStreamProductionGate(environment)) return;

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

  const maxBytes = Number(environment.JETSTREAM_MAX_BYTES?.trim() ?? "");
  const maxMsgs = Number(environment.JETSTREAM_MAX_MSGS?.trim() ?? "");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxMsgs) || maxMsgs <= 0) {
    throw new Error(
      "Production JetStream requires positive JETSTREAM_MAX_BYTES and JETSTREAM_MAX_MSGS capacity limits."
    );
  }

  const monitorUrl = environment.JETSTREAM_MONITOR_URL?.trim() ?? "";
  if (!monitorUrl.startsWith("https://")) {
    throw new Error("Production JetStream requires JETSTREAM_MONITOR_URL with https:// for operational monitoring.");
  }

  const redrive = environment.JETSTREAM_REDRIVE_RUNBOOK_URL?.trim() ?? "";
  if (!redrive.startsWith("https://") && !redrive.startsWith("./") && !redrive.startsWith("docs/")) {
    throw new Error(
      "Production JetStream requires JETSTREAM_REDRIVE_RUNBOOK_URL pointing to an audited redrive procedure."
    );
  }
}

export function shouldEnforceJetStreamProductionGate(environment: NodeJS.ProcessEnv = process.env): boolean {
  const hyperionEnv = (environment.HYPERION_ENVIRONMENT ?? "").trim().toLowerCase();
  const nodeEnv = (environment.NODE_ENV ?? "development").trim().toLowerCase();

  if (hyperionEnv === "production" || hyperionEnv === "staging") {
    return true;
  }

  if (nodeEnv !== "production" && nodeEnv !== "staging") {
    return false;
  }

  // Compose sets NODE_ENV=production for pilots; allow explicit CI / example-secret rehearsals.
  if (environment.CI === "true") return false;
  if (environment.HYPERION_ALLOW_EXAMPLE_SECRETS === "true") return false;
  return true;
}
