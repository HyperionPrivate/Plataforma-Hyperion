import { createNovaBff } from "./app.js";
import { JwksAccessTokenVerifier } from "./jwks.js";
import { allowPrivateAccessHttp, readAccessServiceOrigin } from "./runtime-config.js";

const allowPrivateAccessTransport = allowPrivateAccessHttp(process.env);

const verifier = new JwksAccessTokenVerifier({
  jwksUrl: requireEnvironment("ACCESS_JWKS_URL"),
  issuer: requireEnvironment("ACCESS_TOKEN_ISSUER"),
  audience: requireEnvironment("ACCESS_TOKEN_AUDIENCE"),
  allowPrivateHttp: allowPrivateAccessTransport
});

const app = createNovaBff({
  resolvePrincipal: (token) => verifier.resolve(token),
  accessKeyReadiness: () => verifier.readiness(),
  accessUrl: readAccessServiceOrigin(process.env),
  accessCredential: readOptionalEnvironment("NOVA_BFF_TO_ACCESS_TOKEN"),
  upstreams: {
    nova: process.env.NOVA_CORE_SERVICE_URL ?? "http://localhost:8091",
    voice: process.env.VOICE_CHANNEL_SERVICE_URL ?? "http://localhost:8092",
    liwa: process.env.LIWA_CHANNEL_SERVICE_URL ?? "http://localhost:8093",
    documents: process.env.DOCUMENTS_SERVICE_URL ?? "http://localhost:8094"
  },
  credentials: {
    nova: readOptionalEnvironment("NOVA_BFF_TO_NOVA_TOKEN"),
    voice: readOptionalEnvironment("NOVA_BFF_TO_VOICE_TOKEN"),
    liwa: readOptionalEnvironment("NOVA_BFF_TO_LIWA_TOKEN"),
    documents: readOptionalEnvironment("NOVA_BFF_TO_DOCUMENTS_TOKEN")
  },
  operatorAssertionKey: readOptionalEnvironment("NOVA_OPERATOR_ASSERTION_KEY"),
  providerEdgeCredential: readOptionalEnvironment("NOVA_PROVIDER_EDGE_TOKEN")
});

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: readPort(process.env.PORT, 8095) });

function requireEnvironment(name: string): string {
  const value = readOptionalEnvironment(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readOptionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  return port;
}
