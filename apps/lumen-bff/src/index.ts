import { createLumenBff } from "./app.js";
import { JwksAccessTokenVerifier } from "./jwks.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { allowPrivateAccessJwksHttp, readLumenBffServiceOrigins } from "./runtime-config.js";

export interface LumenBffProcessConfiguration {
  jwksUrl: string;
  issuer: string;
  audience: string;
  allowPrivateHttp: boolean;
  accessUrl: string;
  upstream: string;
  accessCredential?: string;
  credential?: string;
  operatorAssertionKey?: string;
  host: string;
  port: number;
}

export function readLumenBffProcessConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): LumenBffProcessConfiguration {
  const origins = readLumenBffServiceOrigins(environment);
  return Object.freeze({
    jwksUrl: requireEnvironment(environment, "ACCESS_JWKS_URL"),
    issuer: requireEnvironment(environment, "ACCESS_TOKEN_ISSUER"),
    audience: requireEnvironment(environment, "ACCESS_TOKEN_AUDIENCE"),
    allowPrivateHttp: allowPrivateAccessJwksHttp(environment),
    accessUrl: origins.access,
    upstream: origins.lumen,
    accessCredential: readOptionalEnvironment(environment, "LUMEN_BFF_TO_ACCESS_TOKEN"),
    credential: readOptionalEnvironment(environment, "LUMEN_BFF_TO_LUMEN_TOKEN"),
    operatorAssertionKey: readOptionalEnvironment(environment, "LUMEN_OPERATOR_ASSERTION_KEY"),
    host: environment.HOST?.trim() || "0.0.0.0",
    port: readPort(environment.PORT, 8096)
  });
}

export async function startLumenBff(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configuration = readLumenBffProcessConfiguration(environment);
  const verifier = new JwksAccessTokenVerifier({
    jwksUrl: configuration.jwksUrl,
    issuer: configuration.issuer,
    audience: configuration.audience,
    allowPrivateHttp: configuration.allowPrivateHttp
  });
  const app = createLumenBff({
    resolvePrincipal: (token) => verifier.resolve(token),
    accessKeyReadiness: () => verifier.readiness(),
    accessUrl: configuration.accessUrl,
    accessCredential: configuration.accessCredential,
    upstream: configuration.upstream,
    credential: configuration.credential,
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
  startLumenBff().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
