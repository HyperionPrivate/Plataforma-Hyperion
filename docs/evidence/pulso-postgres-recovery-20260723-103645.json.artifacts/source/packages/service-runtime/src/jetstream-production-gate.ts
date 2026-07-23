import { isRestrictedDeploymentEnvironment } from "@hyperion/config";

const PILOT_ONLY_MESSAGE =
  "DURABLE_EVENT_TRANSPORT=jetstream is refused in production/staging while Hyperion JetStream remains a single-node pilot";

/**
 * JetStream is currently a local/CI pilot. Environment declarations cannot
 * turn the repository's fixed single-node topology into production HA.
 */
export function assertJetStreamProductionGate(environment: NodeJS.ProcessEnv = process.env): void {
  const transport = (environment.DURABLE_EVENT_TRANSPORT ?? "http").trim().toLowerCase();
  if (transport !== "jetstream") return;
  if (shouldEnforceJetStreamProductionGate(environment)) throw new Error(PILOT_ONLY_MESSAGE);
}

export function shouldEnforceJetStreamProductionGate(environment: NodeJS.ProcessEnv = process.env): boolean {
  return isRestrictedDeploymentEnvironment(environment);
}
