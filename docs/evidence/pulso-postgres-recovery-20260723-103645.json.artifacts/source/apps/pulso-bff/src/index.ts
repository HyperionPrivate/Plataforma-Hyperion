import { createPulsoBff } from "./app.js";
import { JwksAccessTokenVerifier } from "./jwks.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { allowPrivateAccessJwksHttp, readPulsoBffServiceOrigins } from "./runtime-config.js";

export interface PulsoBffProcessConfiguration {
  jwksUrl: string;
  issuer: string;
  audience: string;
  allowPrivateHttp: boolean;
  accessUrl: string;
  upstreams: Omit<ReturnType<typeof readPulsoBffServiceOrigins>, "access">;
  accessCredential?: string;
  credentials: {
    core: string | undefined;
    sofia: string | undefined;
    "prompt-flow": string | undefined;
    knowledge: string | undefined;
    integration: string | undefined;
    whatsapp: string | undefined;
  };
  operatorAssertionKey?: string;
  host: string;
  port: number;
}

export function readPulsoBffProcessConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): PulsoBffProcessConfiguration {
  const origins = readPulsoBffServiceOrigins(environment);
  const { access: accessUrl, ...upstreams } = origins;
  return Object.freeze({
    jwksUrl: requireEnvironment(environment, "ACCESS_JWKS_URL"),
    issuer: requireEnvironment(environment, "ACCESS_TOKEN_ISSUER"),
    audience: requireEnvironment(environment, "ACCESS_TOKEN_AUDIENCE"),
    allowPrivateHttp: allowPrivateAccessJwksHttp(environment),
    accessUrl,
    accessCredential: readOptionalEnvironment(environment, "PULSO_BFF_TO_ACCESS_TOKEN"),
    upstreams,
    credentials: Object.freeze({
      core: readOptionalEnvironment(environment, "PULSO_BFF_TO_CORE_TOKEN"),
      sofia: readOptionalEnvironment(environment, "PULSO_BFF_TO_SOFIA_TOKEN"),
      "prompt-flow": readOptionalEnvironment(environment, "PULSO_BFF_TO_PROMPT_FLOW_TOKEN"),
      knowledge: readOptionalEnvironment(environment, "PULSO_BFF_TO_KNOWLEDGE_TOKEN"),
      integration: readOptionalEnvironment(environment, "PULSO_BFF_TO_INTEGRATION_TOKEN"),
      whatsapp: readOptionalEnvironment(environment, "PULSO_BFF_TO_WHATSAPP_TOKEN")
    }),
    operatorAssertionKey: readOptionalEnvironment(environment, "PULSO_OPERATOR_ASSERTION_KEY"),
    host: environment.HOST?.trim() || "0.0.0.0",
    port: readPort(environment.PORT, 8097)
  });
}

export async function startPulsoBff(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configuration = readPulsoBffProcessConfiguration(environment);
  const verifier = new JwksAccessTokenVerifier({
    jwksUrl: configuration.jwksUrl,
    issuer: configuration.issuer,
    audience: configuration.audience,
    allowPrivateHttp: configuration.allowPrivateHttp
  });
  const app = createPulsoBff({
    resolvePrincipal: (token) => verifier.resolve(token),
    accessKeyReadiness: () => verifier.readiness(),
    accessUrl: configuration.accessUrl,
    accessCredential: configuration.accessCredential,
    upstreams: configuration.upstreams,
    credentials: configuration.credentials,
    operatorAssertionKey: configuration.operatorAssertionKey
  });
  await app.listen({ host: configuration.host, port: configuration.port });
}

function requireEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = readOptionalEnvironment(environment, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readOptionalEnvironment(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  return port;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  startPulsoBff().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
