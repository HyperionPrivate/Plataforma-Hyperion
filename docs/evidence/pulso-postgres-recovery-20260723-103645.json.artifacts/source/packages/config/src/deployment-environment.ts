export const HYPERION_DEPLOYMENT_ENVIRONMENTS = ["local", "ci", "staging", "production"] as const;

export type HyperionDeploymentEnvironment = (typeof HYPERION_DEPLOYMENT_ENVIRONMENTS)[number];

const HYPERION_DEPLOYMENT_ENVIRONMENT_SET = new Set<string>(HYPERION_DEPLOYMENT_ENVIRONMENTS);
const NODE_DEPLOYMENT_ENVIRONMENTS = ["local", "development", "test", "ci", "staging", "production"] as const;
const NODE_DEPLOYMENT_ENVIRONMENT_MAP = new Map<string, HyperionDeploymentEnvironment>([
  ["local", "local"],
  ["development", "local"],
  ["test", "ci"],
  ["ci", "ci"],
  ["staging", "staging"],
  ["production", "production"]
]);

/**
 * Classifies the deployment once for every runtime security decision.
 * HYPERION_ENVIRONMENT is authoritative when present because container images
 * intentionally use NODE_ENV=production even for local and CI rehearsals.
 */
export function readDeploymentEnvironment(environment: NodeJS.ProcessEnv = process.env): HyperionDeploymentEnvironment {
  const explicitValue = environment.HYPERION_ENVIRONMENT;
  if (explicitValue !== undefined) {
    const explicit = explicitValue.trim().toLowerCase();
    if (!HYPERION_DEPLOYMENT_ENVIRONMENT_SET.has(explicit)) {
      throw new Error(`HYPERION_ENVIRONMENT must be one of: ${HYPERION_DEPLOYMENT_ENVIRONMENTS.join(", ")}`);
    }
    return explicit as HyperionDeploymentEnvironment;
  }

  const nodeEnvironmentValue = environment.NODE_ENV;
  if (nodeEnvironmentValue === undefined) return "local";

  const nodeEnvironment = nodeEnvironmentValue.trim().toLowerCase();
  const deploymentEnvironment = NODE_DEPLOYMENT_ENVIRONMENT_MAP.get(nodeEnvironment);
  if (!deploymentEnvironment) {
    throw new Error(`NODE_ENV must be one of: ${NODE_DEPLOYMENT_ENVIRONMENTS.join(", ")}`);
  }
  return deploymentEnvironment;
}

export function isRestrictedDeploymentEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  const deploymentEnvironment = readDeploymentEnvironment(environment);
  return deploymentEnvironment === "production" || deploymentEnvironment === "staging";
}

export function isCiDeploymentEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return readDeploymentEnvironment(environment) === "ci";
}
