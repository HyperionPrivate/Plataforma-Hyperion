import { createHash } from "node:crypto";
import { readServiceUrls } from "@hyperion/config";
import {
  accessMeSchema,
  envelope,
  platformHealthSchema,
  serviceHealthSchema,
  type AccessPrincipal,
  type HealthStatus,
  type PlatformHealth,
  type PlatformRole,
  type ServiceHealth,
  type ServiceName
} from "@hyperion/platform-contracts";
import { productModules, serviceCatalog } from "./compatibility-platform-catalog.js";
import {
  createInternalAuthorizationHeaders,
  createOperatorAssertion,
  OPERATOR_ASSERTION_HEADER,
  readInternalCredential,
  readOperatorAssertionKey,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  isLegacyCustomerProductId,
  noteLegacyGatewayDisabledReject,
  readLegacyProductRequestScope
} from "./legacy-product-policy.js";

interface DownstreamService {
  name: ServiceName;
  url: string;
}

export type SessionResolver = ((token: string) => Promise<AccessPrincipal | undefined>) & {
  invalidate?: (token: string) => void;
};

declare module "fastify" {
  interface FastifyRequest {
    canonicalPath: string;
    canonicalQuery?: string;
    session?: AccessPrincipal;
  }
}

const UPSTREAM_TIMEOUT_MS = 2_500;
const HEALTH_CACHE_TTL_MS = 5_000;

const PUBLIC_PATHS = new Set([
  "/v1/auth/login",
  "/v1/liwa/webhooks",
  "/v1/liwa/webhook", // alias: LIWA / browser probes often omit the trailing "s"
  "/v1/liwa/webhooks/simulate"
]);

let healthCache: { expiresAt: number; payload: PlatformHealth } | undefined;

export function createGatewayRoutes(overrides?: {
  resolveSession?: SessionResolver;
  gatewayCredentials?: {
    identity?: string;
    liwa?: string;
    tenant?: string;
  };
}): RouteRegistrar {
  return async (app) => {
    readOperatorAssertionKey(process.env);
    const urls = readServiceUrls();
    const resolveSession = overrides?.resolveSession ?? createFreshSessionResolver(urls.identity);
    const gatewayCredentials = {
      identity:
        overrides?.gatewayCredentials?.identity ?? readInternalCredential(process.env, "GATEWAY_TO_IDENTITY_TOKEN"),
      liwa: overrides?.gatewayCredentials?.liwa ?? readInternalCredential(process.env, "GATEWAY_TO_LIWA_TOKEN"),
      tenant: overrides?.gatewayCredentials?.tenant ?? readInternalCredential(process.env, "GATEWAY_TO_TENANT_TOKEN")
    };

    // Authenticate before Fastify parses potentially large request payloads.
    app.addHook("onRequest", async (request, reply) => {
      const requestTarget = canonicalizeRequestTarget(request.raw.url ?? request.url);
      if (!requestTarget) {
        return reply.code(400).send(envelope({ error: "Invalid request path" }, request.id));
      }

      request.canonicalPath = requestTarget.path;
      request.canonicalQuery = requestTarget.query;

      const path = requestTarget.path;
      if (!path.startsWith("/v1/") || PUBLIC_PATHS.has(path)) {
        return;
      }

      const token = readBearerToken(request.headers.authorization);
      if (!token) {
        return reply.code(401).send(envelope({ error: "Authentication required" }, request.id));
      }

      const session = await resolveSession(token);
      if (!session) {
        return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
      }

      request.session = session;

      // DEBT-020 / DEBT-032: multiproduct product facade permanently retired.
      if (readLegacyProductRequestScope(path)) {
        noteLegacyGatewayDisabledReject();
        return reply.code(410).send(
          envelope(
            {
              error: "Legacy multiproduct gateway product routes are permanently retired. Use product BFFs."
            },
            request.id
          )
        );
      }

      const denial = authorizeNeutralPlatformRequest(request.method, path, session.operator.role);
      if (denial) {
        return reply.code(403).send(envelope({ error: denial }, request.id));
      }
    });

    app.post(
      "/v1/auth/login",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        return proxyJson(request, reply, buildUpstreamUrl(urls.identity, request), "POST", request.body);
      }
    );

    app.get("/v1/auth/me", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.identity, request), "GET");
    });

    app.post("/v1/auth/logout", async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      return proxyJson(
        request,
        reply,
        buildUpstreamUrl(urls.identity, request),
        "POST",
        undefined,
        UPSTREAM_TIMEOUT_MS,
        () => {
          if (token) resolveSession.invalidate?.(token);
        }
      );
    });

    app.get("/v1/identity/operators", async (request, reply) => {
      return proxyJson(
        request,
        reply,
        buildUpstreamUrl(urls.identity, request),
        "GET",
        undefined,
        UPSTREAM_TIMEOUT_MS,
        undefined,
        gatewayCredentials.identity ?? null
      );
    });

    app.post("/v1/identity/operators", async (request, reply) => {
      return proxyJson(
        request,
        reply,
        buildUpstreamUrl(urls.identity, request),
        "POST",
        request.body,
        UPSTREAM_TIMEOUT_MS,
        undefined,
        gatewayCredentials.identity ?? null
      );
    });

    app.patch("/v1/identity/operators/:operatorId", async (request, reply) => {
      return proxyJson(
        request,
        reply,
        buildUpstreamUrl(urls.identity, request),
        "PATCH",
        request.body,
        UPSTREAM_TIMEOUT_MS,
        undefined,
        gatewayCredentials.identity ?? null
      );
    });

    app.get("/v1/platform/catalog", async (request) => {
      return envelope(
        {
          services: serviceCatalog,
          productModules
        },
        request.id
      );
    });

    // Public LIWA provider webhooks (auth = X-LIWA-WEBHOOK-SECRET upstream).
    const liwaWebhookOk = async (
      request: { id: string },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } }
    ) =>
      reply.code(200).send(
        envelope(
          {
            ok: true,
            hint: "Use POST /v1/liwa/webhooks with JSON body (event + phone). GET is only a probe."
          },
          request.id
        )
      );
    app.get("/v1/liwa/webhooks", liwaWebhookOk);
    app.get("/v1/liwa/webhook", liwaWebhookOk);
    app.post("/v1/liwa/webhooks", async (request, reply) => {
      return proxyLiwaWebhook(request, reply, urls.liwaChannel, gatewayCredentials.liwa ?? null);
    });
    app.post("/v1/liwa/webhook", async (request, reply) => {
      return proxyLiwaWebhook(request, reply, urls.liwaChannel, gatewayCredentials.liwa ?? null);
    });
    app.post("/v1/liwa/webhooks/simulate", async (request, reply) => {
      return proxyLiwaWebhook(
        request,
        reply,
        urls.liwaChannel,
        gatewayCredentials.liwa ?? null,
        "/v1/liwa/webhooks/simulate"
      );
    });

    app.get("/v1/tenants", async (request, reply) => {
      try {
        if (!gatewayCredentials.tenant) {
          return reply
            .code(503)
            .send(envelope({ error: "Gateway tenant edge credential is not configured" }, request.id));
        }
        const response = await fetch(buildUpstreamUrl(urls.tenant, request), {
          headers: {
            "x-request-id": request.id,
            ...createInternalAuthorizationHeaders("api-gateway", gatewayCredentials.tenant)
          },
          redirect: "error",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
        const payload = (await response.json()) as { data?: unknown };
        if (!response.ok) {
          return reply.code(response.status).send(payload);
        }

        const rows = Array.isArray(payload.data) ? payload.data : [];
        const session = request.session;
        const grantedTenantIds = new Set(
          session?.grants
            .filter((grant) => grant.active && isLegacyCustomerProductId(grant.productId))
            .map((grant) => grant.tenantId) ?? []
        );
        const visible = rows.filter(
          (row) => typeof row === "object" && row !== null && grantedTenantIds.has(String((row as { id?: unknown }).id))
        );

        return envelope(visible, request.id);
      } catch {
        return reply.code(502).send(envelope({ error: "Upstream service unavailable" }, request.id));
      }
    });

    app.get("/v1/platform/health", async () => {
      const now = Date.now();
      if (healthCache && healthCache.expiresAt > now) {
        return healthCache.payload;
      }

      const services = buildRegistry();
      const health = await Promise.all(services.map((service) => fetchServiceHealth(service)));
      const status = summarize(health);

      const payload = platformHealthSchema.parse({
        status,
        checkedAt: new Date().toISOString(),
        services: health
      });

      healthCache = { expiresAt: now + HEALTH_CACHE_TTL_MS, payload };
      return payload;
    });
  };
}

export const registerRoutes: RouteRegistrar = createGatewayRoutes();

function canonicalizeRequestTarget(rawTarget: string): { path: string; query?: string } | undefined {
  const queryStart = rawTarget.indexOf("?");
  const rawPath = queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart);
  const query = queryStart === -1 ? undefined : rawTarget.slice(queryStart + 1);

  if (!rawPath.startsWith("/") || rawPath.includes("\\") || containsControlCharacters(rawPath)) {
    return undefined;
  }

  if (rawPath === "/") {
    return { path: rawPath, query };
  }

  const rawSegments = rawPath.slice(1).split("/");
  if (rawSegments.at(-1) === "") {
    rawSegments.pop();
  }
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) {
    return undefined;
  }

  const canonicalSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment).normalize("NFC");
    } catch {
      return undefined;
    }

    // Structural delimiters, dot segments, controls and a remaining percent
    // can be interpreted differently (or decoded again) by another HTTP hop.
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("%") ||
      /[\\/?#;]/.test(decoded) ||
      containsControlCharacters(decoded)
    ) {
      return undefined;
    }

    canonicalSegments.push(encodeURIComponent(decoded));
  }

  return { path: `/${canonicalSegments.join("/")}`, query };
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function readCanonicalTenantId(path: string): string | undefined {
  const match = path.match(/^\/v1\/tenants\/([^/]+)(?:\/|$)/);
  return match ? decodeURIComponent(match[1] ?? "") : undefined;
}

function buildUpstreamUrl(baseUrl: string, request: FastifyRequest, includeQuery = false): string {
  const query = includeQuery && request.canonicalQuery !== undefined ? `?${request.canonicalQuery}` : "";
  return `${baseUrl}${request.canonicalPath}${query}`;
}

function readBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length >= 20 ? token : undefined;
}

function authorizeNeutralPlatformRequest(method: string, path: string, role: PlatformRole): string | undefined {
  if (role === "admin") {
    return undefined;
  }

  if (path.startsWith("/v1/identity/operators")) {
    return "Admin role required";
  }

  if (method === "GET" || method === "HEAD") return undefined;

  if (path === "/v1/auth/logout") {
    return undefined;
  }

  if (role === "auditor") {
    return "Read-only role";
  }

  return "Forbidden";
}

function createFreshSessionResolver(identityUrl: string): SessionResolver {
  const tokenStates = new Map<string, { activeRequests: number; generation: number }>();

  const resolve: SessionResolver = async (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    const tokenState = tokenStates.get(key) ?? { activeRequests: 0, generation: 0 };
    tokenStates.set(key, tokenState);
    tokenState.activeRequests += 1;
    const requestGeneration = tokenState.generation;
    try {
      const response = await fetch(`${identityUrl}/v1/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });

      if (!response.ok) {
        return undefined;
      }

      const payload = (await response.json()) as { data?: unknown };
      const session = accessMeSchema.parse(payload.data);

      // A logout completed while this lookup was in flight. Do not authorize
      // the request or repopulate a token that has just been invalidated.
      if (requestGeneration !== tokenState.generation) {
        return undefined;
      }

      return session;
    } catch {
      return undefined;
    } finally {
      tokenState.activeRequests -= 1;
      if (tokenState.activeRequests === 0 && tokenStates.get(key) === tokenState) {
        tokenStates.delete(key);
      }
    }
  };

  resolve.invalidate = (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    const tokenState = tokenStates.get(key);
    if (tokenState) tokenState.generation += 1;
  };

  return resolve;
}

function buildRegistry(): DownstreamService[] {
  const urls = readServiceUrls();

  return [
    { name: "identity-service", url: urls.identity },
    { name: "tenant-service", url: urls.tenant },
    { name: "agent-service", url: urls.agent },
    { name: "prompt-flow-service", url: urls.promptFlow },
    { name: "knowledge-service", url: urls.knowledge },
    { name: "audit-service", url: urls.audit },
    { name: "integration-service", url: urls.integration },
    { name: "pulso-iris-service", url: urls.pulsoIris },
    { name: "whatsapp-channel-service", url: urls.whatsappChannel },
    { name: "lumen-service", url: urls.lumen },
    { name: "nova-core-service", url: urls.novaCore },
    { name: "voice-channel-service", url: urls.voiceChannel },
    { name: "liwa-channel-service", url: urls.liwaChannel },
    { name: "documents-service", url: urls.documents }
  ];
}

async function proxyLiwaWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  liwaBaseUrl: string,
  gatewayCredential: string | null,
  path = "/v1/liwa/webhooks"
): Promise<unknown> {
  const base = liwaBaseUrl.replace(/\/$/, "");
  const url = `${base}${path}`;
  const requestAbort = createRequestAbortSignal(request, reply);
  try {
    const headers: Record<string, string> = {
      "x-request-id": request.id,
      "content-type": "application/json"
    };
    const webhookSecret = request.headers["x-liwa-webhook-secret"];
    if (typeof webhookSecret === "string" && webhookSecret.trim()) {
      headers["x-liwa-webhook-secret"] = webhookSecret.trim();
    }
    // Optional edge identity; upstream webhook route does not require it.
    if (gatewayCredential) {
      Object.assign(headers, createInternalAuthorizationHeaders("api-gateway", gatewayCredential));
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body ?? {}),
      redirect: "error",
      signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
    });
    const payload = await response.json();
    return reply.code(response.status).send(payload);
  } catch {
    if (requestAbort.signal.aborted && reply.raw.destroyed) return undefined;
    return reply.code(502).send(envelope({ error: "Upstream service unavailable" }, request.id));
  } finally {
    requestAbort.cleanup();
  }
}

async function proxyJson(
  request: FastifyRequest,
  reply: FastifyReply,
  url: string,
  method: "GET" | "POST" | "PATCH" | "PUT",
  body?: unknown,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  onUpstreamSuccess?: () => void,
  gatewayCredential?: string | null
): Promise<unknown> {
  if (gatewayCredential === null || gatewayCredential === "") {
    return reply.code(503).send(envelope({ error: "Gateway workload identity is not configured" }, request.id));
  }
  const requestAbort = createRequestAbortSignal(request, reply);
  try {
    const headers: Record<string, string> = { "x-request-id": request.id };
    if (gatewayCredential !== undefined) {
      Object.assign(headers, createInternalAuthorizationHeaders("api-gateway", gatewayCredential));
    } else if (request.headers.authorization) {
      headers.authorization = request.headers.authorization;
    }
    if (request.session) {
      headers["x-operator-id"] = request.session.operator.id;
      headers["x-operator-role"] = request.session.operator.role;
      const assertionKey = readOperatorAssertionKey(process.env);
      if (assertionKey) {
        const tenantId = readCanonicalTenantId(request.canonicalPath);
        headers[OPERATOR_ASSERTION_HEADER] = createOperatorAssertion(
          {
            operatorId: request.session.operator.id,
            role: request.session.operator.role,
            ...(tenantId ? { tenantId } : {}),
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          assertionKey
        );
      }
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(timeoutMs)])
    });
    if (response.ok) {
      onUpstreamSuccess?.();
    }
    const payload = await response.json();

    return reply.code(response.status).send(payload);
  } catch {
    if (requestAbort.signal.aborted && reply.raw.destroyed) return undefined;
    return reply.code(502).send(envelope({ error: "Upstream service unavailable" }, request.id));
  } finally {
    requestAbort.cleanup();
  }
}

function createRequestAbortSignal(
  request: FastifyRequest,
  reply: FastifyReply
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortRequest = () => controller.abort(new DOMException("Client request aborted", "AbortError"));
  const abortResponse = () => {
    if (!reply.raw.writableEnded) abortRequest();
  };

  request.raw.once("aborted", abortRequest);
  reply.raw.once("close", abortResponse);

  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.off("aborted", abortRequest);
      reply.raw.off("close", abortResponse);
    }
  };
}

async function fetchServiceHealth(service: DownstreamService): Promise<ServiceHealth> {
  const started = performance.now();

  try {
    const response = await fetch(`${service.url}/ready`, {
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    const payload = await response.json();
    const parsed = serviceHealthSchema.parse(payload);

    if (!response.ok || parsed.status !== "ok") {
      return {
        ...parsed,
        status: parsed.status === "ok" ? "degraded" : parsed.status
      };
    }

    return parsed;
  } catch (error) {
    return {
      service: service.name,
      status: "down",
      version: "unknown",
      checkedAt: new Date().toISOString(),
      uptimeSeconds: 0,
      dependencies: [
        {
          name: "http",
          status: "down",
          latencyMs: Math.round(performance.now() - started),
          detail: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

function summarize(services: ServiceHealth[]): HealthStatus {
  if (services.length === 0) {
    return "degraded";
  }

  if (services.every((service) => service.status === "ok")) {
    return "ok";
  }

  if (services.every((service) => service.status === "down")) {
    return "down";
  }

  return "degraded";
}
