import { createPlatformAdminBff } from "./app.js";
import { PlatformJwksVerifier } from "./jwks.js";

const deploymentEnvironment = process.env.HYPERION_ENVIRONMENT ?? process.env.NODE_ENV ?? "production";
const verifier = new PlatformJwksVerifier({
  jwksUrl: requireEnvironment("ACCESS_JWKS_URL"),
  issuer: requireEnvironment("ACCESS_TOKEN_ISSUER"),
  audience: "platform-admin-bff",
  allowPrivateHttp: readBoolean("ACCESS_JWKS_ALLOW_PRIVATE_HTTP"),
  deploymentEnvironment
});

const app = createPlatformAdminBff({
  resolvePrincipal: (token) => verifier.resolve(token),
  accessUrl: process.env.ACCESS_SERVICE_URL ?? "http://localhost:8081",
  accessCredential: optionalEnvironment("PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN"),
  upstreams: {
    identity: process.env.IDENTITY_SERVICE_URL ?? "http://localhost:8081",
    tenant: process.env.TENANT_SERVICE_URL ?? "http://localhost:8082"
  },
  credentials: {
    identity: optionalEnvironment("PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN"),
    tenant: optionalEnvironment("PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN")
  },
  operatorAssertionKey: optionalEnvironment("PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY")
});

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: readPort(process.env.PORT, 8098) });

function requireEnvironment(name: string): string {
  const value = optionalEnvironment(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readBoolean(name: string): boolean {
  const value = optionalEnvironment(name);
  if (!value) return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  return port;
}
