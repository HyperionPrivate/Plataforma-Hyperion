import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import rateLimit from "@fastify/rate-limit";
import {
  findLumenGrant,
  LUMEN_BFF_EXACT_ROUTE_POLICIES,
  LUMEN_BFF_PUBLIC_ROUTE_POLICIES,
  LUMEN_BFF_TENANT_ROUTE_POLICIES,
  lumenConsoleRequestHeaderValue,
  lumenGrantAllows,
  lumenProductId,
  type LumenBffTenantRoutePolicy
} from "@hyperion/lumen-contracts";
import { envelope, tenantIdSchema, type AccessPrincipal } from "@hyperion/platform-contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { createLumenOperatorAssertion, OPERATOR_ASSERTION_HEADER } from "./assertion.js";

export {
  LUMEN_BFF_EXACT_ROUTE_POLICIES,
  LUMEN_BFF_PUBLIC_ROUTE_POLICIES,
  LUMEN_BFF_TENANT_ROUTE_POLICIES
} from "@hyperion/lumen-contracts";

export type PrincipalResolver = (token: string) => Promise<AccessPrincipal | undefined>;

export interface LumenBffOptions {
  resolvePrincipal: PrincipalResolver;
  accessKeyReadiness: () => Promise<boolean>;
  accessUrl: string;
  accessCredential: string | undefined;
  upstream: string;
  credential: string | undefined;
  operatorAssertionKey: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

export const LUMEN_SESSION_COOKIE = "__Host-hyperion-lumen-session";
export const LUMEN_CSRF_COOKIE = "__Host-hyperion-lumen-csrf";
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const UPSTREAM_JSON_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const JSON_MEDIA_TYPE_PATTERN = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/i;
const SAFE_UPSTREAM_CACHE_HEADERS = ["cache-control", "pragma", "expires"] as const;
const serviceReadinessSchema = z.object({ status: z.literal("ok") }).passthrough();
export const LUMEN_BFF_READINESS_PROBE_TIMEOUT_MS = 3_000;
type BffReadinessDependency = {
  name: string;
  status: "degraded" | "down" | "ok";
  required: boolean;
};
export const LOGIN_RATE_LIMIT_MAX = 10;
export const LOGIN_RATE_LIMIT_WINDOW = "1 minute";
export const MAX_LUMEN_SESSION_COOKIE_BYTES = 4096;

export function createLumenBff(options: LumenBffOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: false,
    exposeHeadRoutes: false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID()
  });
  const upstream = normalizeUpstream("lumen", options.upstream);
  const accessUrl = normalizeUpstream("access", options.accessUrl);
  const requestFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  app.register(rateLimit, { global: false, hook: "preHandler" });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
  });
  if (!app.hasContentTypeParser("multipart/form-data")) {
    app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.get("/health", async () => ({ service: "lumen-bff", product: lumenProductId, status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    const configurationReady = Boolean(
      options.accessCredential &&
      options.credential &&
      options.operatorAssertionKey &&
      typeof options.accessKeyReadiness === "function"
    );
    const dependencies = configurationReady
      ? await collectReadinessDependencies([
          probeAccessKeyReadiness(options.accessKeyReadiness),
          probeLumenBffDependency(requestFetch, "access-token-minting", `${accessUrl}/ready`, false),
          probeLumenBffDependency(requestFetch, "lumen", `${upstream}/ready`, true)
        ])
      : [{ name: "workload-configuration", status: "down" as const, required: true }];
    const status = dependencies.every((dependency) => !dependency.required || dependency.status === "ok")
      ? "ok"
      : "down";
    return reply.code(status === "ok" ? 200 : 503).send({
      service: "lumen-bff",
      product: lumenProductId,
      status,
      dependencies
    });
  });
  app.get(LUMEN_BFF_PUBLIC_ROUTE_POLICIES.productHealth.path, async (request, reply) => {
    if (!options.credential) {
      return reply.code(503).send(envelope({ error: "LUMEN workload identity is not configured" }, request.id));
    }
    try {
      const response = await requestFetch(`${upstream}${LUMEN_BFF_EXACT_ROUTE_POLICIES.productHealth.path}`, {
        headers: {
          authorization: `Bearer ${options.credential}`,
          "x-hyperion-caller": "lumen-bff",
          "x-request-id": request.id
        },
        redirect: "error",
        signal: AbortSignal.timeout(5_000)
      });
      return sendStrictJsonUpstreamResponse(reply, response, request.id, "LUMEN health returned an unsafe response");
    } catch {
      return reply.code(502).send(envelope({ error: "LUMEN upstream service unavailable" }, request.id));
    }
  });

  app.register(async (loginApp) => {
    loginApp.post(
      LUMEN_BFF_PUBLIC_ROUTE_POLICIES.login.path,
      {
        config: {
          rateLimit: {
            max: LOGIN_RATE_LIMIT_MAX,
            timeWindow: LOGIN_RATE_LIMIT_WINDOW,
            keyGenerator: loginRateLimitKey
          }
        }
      },
      async (request, reply) => {
        if (request.headers["x-requested-with"] !== lumenConsoleRequestHeaderValue) {
          return reply.code(403).send(envelope({ error: "LUMEN console request required" }, request.id));
        }
        if (!options.accessCredential) {
          return reply.code(503).send(envelope({ error: "LUMEN to Access identity is not configured" }, request.id));
        }
        let response: Response;
        try {
          response = await requestFetch(`${accessUrl}/v1/access/token`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.accessCredential}`,
              "x-hyperion-caller": "lumen-bff",
              "content-type": "application/json",
              "x-request-id": request.id
            },
            body: JSON.stringify(request.body ?? {}),
            redirect: "error",
            signal: AbortSignal.timeout(5_000)
          });
        } catch {
          return reply.code(502).send(envelope({ error: "Access service unavailable" }, request.id));
        }
        const parsedResponse = await parseStrictJsonResponse(response);
        if (parsedResponse.kind === "invalid") {
          return reply.code(502).send(envelope({ error: "Access returned an unsafe response" }, request.id));
        }
        const payload = parsedResponse.kind === "json" ? parsedResponse.payload : undefined;
        if (!response.ok) return reply.code(response.status).send(sanitizeAccessError(payload, request.id));
        const token = extractAccessToken(payload);
        if (!token) return reply.code(502).send(envelope({ error: "Access returned no usable session" }, request.id));
        const principal = await options.resolvePrincipal(token);
        if (!principal)
          return reply.code(502).send(envelope({ error: "Access returned an invalid session" }, request.id));

        const csrfToken = randomBytes(32).toString("base64url");
        const maxAge = readSessionMaxAgeSeconds(token, payload, now());
        const sessionCookie = serializeCookie(LUMEN_SESSION_COOKIE, token, { httpOnly: true, maxAge });
        const csrfCookie = serializeCookie(LUMEN_CSRF_COOKIE, csrfToken, { httpOnly: false, maxAge });
        if (
          Buffer.byteLength(sessionCookie, "utf8") > MAX_LUMEN_SESSION_COOKIE_BYTES ||
          Buffer.byteLength(csrfCookie, "utf8") > MAX_LUMEN_SESSION_COOKIE_BYTES
        ) {
          return reply.code(502).send(envelope({ error: "Access session exceeds the cookie-safe budget" }, request.id));
        }
        reply.header("set-cookie", [sessionCookie, csrfCookie]);
        reply.header("cache-control", "no-store");
        return reply.code(201).send(envelope({ principal: lumenPrincipalProjection(principal) }, request.id));
      }
    );
  });

  app.get(LUMEN_BFF_PUBLIC_ROUTE_POLICIES.me.path, async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    reply.header("cache-control", "no-store");
    return envelope(lumenPrincipalProjection(session.principal), request.id);
  });

  app.get(LUMEN_BFF_PUBLIC_ROUTE_POLICIES.session.path, async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    const csrfToken = readCookie(request.headers.cookie, LUMEN_CSRF_COOKIE);
    if (!session || !csrfToken) {
      return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    }
    const grants = session.principal.grants.filter((grant) => grant.active && grant.productId === lumenProductId);
    const tenantIds = [...new Set(grants.map((grant) => grant.tenantId))];
    reply.header("cache-control", "no-store");
    return envelope(
      {
        operator: session.principal.operator,
        tenants: tenantIds.map((id) => ({ id, displayName: `Tenant ${id.slice(0, 8)}` })),
        grants,
        csrfToken
      },
      request.id
    );
  });

  app.post(LUMEN_BFF_PUBLIC_ROUTE_POLICIES.logout.path, async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    if (!hasValidCsrf(request)) {
      return reply.code(403).send(envelope({ error: "Valid CSRF token required" }, request.id));
    }
    clearSessionCookies(reply);
    return envelope({ loggedOut: true }, request.id);
  });

  app.get(LUMEN_BFF_PUBLIC_ROUTE_POLICIES.tenants.path, async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    const tenantIds = [
      ...new Set(
        session.principal.grants
          .filter((grant) => grant.active && grant.productId === lumenProductId)
          .map((grant) => grant.tenantId)
      )
    ];
    return envelope(
      tenantIds.map((id) => ({ id, displayName: `Tenant ${id.slice(0, 8)}` })),
      request.id
    );
  });

  for (const policy of LUMEN_BFF_TENANT_ROUTE_POLICIES) {
    app.route({
      method: policy.method,
      url: policy.path,
      handler: (request, reply) => authorizeAndProxy(request, reply, policy, options, upstream, requestFetch, now)
    });
  }

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(envelope({ error: "Route is not part of the LUMEN cell" }, request.id));
  });
  return app;
}

function loginRateLimitKey(request: FastifyRequest): string {
  const email = readNormalizedLoginEmail(request.body);
  const material = email ? `account:${email}` : `ip:${request.ip}`;
  return createHash("sha256").update(material).digest("base64url");
}

function readNormalizedLoginEmail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("email" in body)) return undefined;
  const value = (body as { email?: unknown }).email;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  return normalized.length > 0 && normalized.length <= 320 ? normalized : undefined;
}

async function authorizeAndProxy(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: LumenBffTenantRoutePolicy,
  options: LumenBffOptions,
  upstream: string,
  requestFetch: typeof fetch,
  now: () => number
): Promise<unknown> {
  const parsedTenant = tenantIdSchema.safeParse(readTenantId(request.params));
  if (!parsedTenant.success) {
    return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
  }
  const session = await resolveCookieSession(request, options.resolvePrincipal);
  if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
  if (request.method !== "GET" && request.method !== "HEAD" && !hasValidCsrf(request)) {
    return reply.code(403).send(envelope({ error: "Valid CSRF token required" }, request.id));
  }

  const grant = findLumenGrant(session.principal, parsedTenant.data);
  if (!grant) return reply.code(403).send(envelope({ error: "LUMEN grant required for this tenant" }, request.id));
  if (!lumenGrantAllows(grant, policy.capability)) {
    return reply.code(403).send(envelope({ error: `${policy.capability} capability required` }, request.id));
  }
  if (!options.credential || !options.operatorAssertionKey) {
    return reply.code(503).send(envelope({ error: "LUMEN workload identity is not configured" }, request.id));
  }

  const target = buildTargetUrl(upstream, request.raw.url ?? request.url);
  if (!target) return reply.code(400).send(envelope({ error: "Invalid request target" }, request.id));
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.credential}`,
    "x-hyperion-caller": "lumen-bff",
    "x-request-id": request.id,
    "x-operator-id": session.principal.operator.id,
    "x-operator-role": grant.roles[0]!,
    [OPERATOR_ASSERTION_HEADER]: createLumenOperatorAssertion(
      {
        operatorId: session.principal.operator.id,
        role: grant.roles[0]!,
        tenantId: parsedTenant.data,
        expiresAtUnix: Math.floor(now() / 1000) + 60
      },
      options.operatorAssertionKey
    )
  };
  const contentType = request.headers["content-type"];
  if (contentType) headers["content-type"] = contentType;

  try {
    const response = await requestFetch(target, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD" ? undefined : serializeBody(request.body, contentType),
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
    return sendStrictJsonUpstreamResponse(reply, response, request.id, "LUMEN upstream returned an unsafe response");
  } catch {
    return reply.code(502).send(envelope({ error: "LUMEN upstream service unavailable" }, request.id));
  }
}

function readTenantId(params: unknown): unknown {
  return typeof params === "object" && params !== null && "tenantId" in params
    ? (params as { tenantId?: unknown }).tenantId
    : undefined;
}

function lumenPrincipalProjection(principal: AccessPrincipal): AccessPrincipal {
  return {
    operator: principal.operator,
    grants: principal.grants.filter((grant) => grant.active && grant.productId === lumenProductId)
  };
}

function normalizeUpstream(component: string, value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid ${component} upstream URL`);
  }
  return url.toString().replace(/\/$/, "");
}

async function probeLumenBffDependency(
  requestFetch: typeof fetch,
  name: string,
  url: string,
  required: boolean
): Promise<BffReadinessDependency> {
  const failureStatus = required ? "down" : "degraded";
  try {
    const response = await requestFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(LUMEN_BFF_READINESS_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      return { name, status: failureStatus, required };
    }
    const parsed = await parseStrictJsonResponse(response);
    const valid = parsed.kind === "json" && serviceReadinessSchema.safeParse(parsed.payload).success;
    return { name, status: valid ? "ok" : failureStatus, required };
  } catch {
    return { name, status: failureStatus, required };
  }
}

async function probeAccessKeyReadiness(accessKeyReadiness: () => Promise<boolean>): Promise<BffReadinessDependency> {
  try {
    return {
      name: "access-signing-keys",
      status: (await accessKeyReadiness()) ? "ok" : "down",
      required: true
    };
  } catch {
    return { name: "access-signing-keys", status: "down", required: true };
  }
}

async function collectReadinessDependencies(
  probes: readonly Promise<BffReadinessDependency>[]
): Promise<BffReadinessDependency[]> {
  const settled = await Promise.allSettled(probes);
  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : { name: `readiness-probe-${index + 1}`, status: "down", required: true }
  );
}

function buildTargetUrl(base: string, rawTarget: string): string | undefined {
  if (!rawTarget.startsWith("/") || hasUnsafeTargetCharacter(rawTarget)) return undefined;
  const rawPath = rawTarget.split("?", 1)[0] ?? "";
  if (/%(?:2e|2f|5c|25)/iu.test(rawPath) || rawPath.split("/").some((part) => part === "." || part === "..")) {
    return undefined;
  }
  return `${base}${rawTarget}`;
}

function hasUnsafeTargetCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return character === "\\" || codePoint <= 31 || codePoint === 127;
  });
}

function serializeBody(body: unknown, contentType: string | undefined): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (contentType?.toLowerCase().includes("application/json")) return JSON.stringify(body);
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function resolveCookieSession(
  request: FastifyRequest,
  resolvePrincipal: PrincipalResolver
): Promise<{ token: string; principal: AccessPrincipal } | undefined> {
  const token = readCookie(request.headers.cookie, LUMEN_SESSION_COOKIE);
  if (!token || token.length < 20) return undefined;
  const principal = await resolvePrincipal(token);
  return principal ? { token, principal } : undefined;
}

function hasValidCsrf(request: FastifyRequest): boolean {
  const cookieToken = readCookie(request.headers.cookie, LUMEN_CSRF_COOKIE);
  const headerToken = request.headers["x-csrf-token"];
  if (!cookieToken || typeof headerToken !== "string") return false;
  const left = Buffer.from(cookieToken);
  const right = Buffer.from(headerToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return undefined;
    try {
      found = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return found;
}

function serializeCookie(name: string, value: string, options: { httpOnly: boolean; maxAge: number }): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    "Secure",
    "SameSite=Strict"
  ];
  if (options.httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

function clearSessionCookies(reply: FastifyReply): void {
  const expired = "Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Strict";
  reply.header("set-cookie", [`${LUMEN_SESSION_COOKIE}=; ${expired}; HttpOnly`, `${LUMEN_CSRF_COOKIE}=; ${expired}`]);
  reply.header("cache-control", "no-store");
}

function extractAccessToken(payload: unknown): string | undefined {
  const data = unwrapEnvelope(payload);
  if (typeof data !== "object" || data === null) return undefined;
  const session = data as { token?: unknown; accessToken?: unknown };
  const value = typeof session.token === "string" ? session.token : session.accessToken;
  return typeof value === "string" && value.length >= 20 ? value : undefined;
}

function readSessionMaxAgeSeconds(token: string, payload: unknown, nowMs: number): number {
  const data = unwrapEnvelope(payload);
  const expiresAt =
    typeof data === "object" && data !== null && typeof (data as { expiresAt?: unknown }).expiresAt === "string"
      ? Date.parse((data as { expiresAt: string }).expiresAt)
      : Number.NaN;
  let expiryMs = expiresAt;
  if (!Number.isFinite(expiryMs)) {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
        exp?: unknown;
      };
      expiryMs = typeof claims.exp === "number" ? claims.exp * 1000 : Number.NaN;
    } catch {
      expiryMs = Number.NaN;
    }
  }
  if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) return 300;
  return Math.max(1, Math.min(900, Math.floor((expiryMs - nowMs) / 1000)));
}

type StrictJsonResponse = { kind: "empty" } | { kind: "json"; payload: unknown; body: Buffer } | { kind: "invalid" };

async function parseStrictJsonResponse(response: Response): Promise<StrictJsonResponse> {
  if (response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    return { kind: "invalid" };
  }
  if (response.status === 204 || response.status === 205) return { kind: "empty" };
  if (!isJsonMediaType(response.headers.get("content-type"))) {
    await cancelResponseBody(response);
    return { kind: "invalid" };
  }
  const body = await readBoundedResponseBody(response);
  if (!body) return { kind: "invalid" };
  try {
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return { kind: "json", payload, body };
  } catch {
    return { kind: "invalid" };
  }
}

async function sendStrictJsonUpstreamResponse(
  reply: FastifyReply,
  response: Response,
  requestId: string,
  error: string
): Promise<unknown> {
  const parsed = await parseStrictJsonResponse(response);
  if (parsed.kind === "invalid") return reply.code(502).send(envelope({ error }, requestId));
  copySafeCacheHeaders(reply, response);
  if (parsed.kind === "empty") return reply.code(response.status).send();
  return reply.code(response.status).type("application/json; charset=utf-8").send(parsed.body);
}

async function readBoundedResponseBody(response: Response): Promise<Buffer | undefined> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > UPSTREAM_JSON_BODY_LIMIT_BYTES) {
      await cancelResponseBody(response);
      return undefined;
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > UPSTREAM_JSON_BODY_LIMIT_BYTES - totalBytes) {
        await cancelReader(reader);
        return undefined;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch {
    await cancelReader(reader);
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

function copySafeCacheHeaders(reply: FastifyReply, response: Response): void {
  for (const name of SAFE_UPSTREAM_CACHE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) reply.header(name, value);
  }
}

function isJsonMediaType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim() ?? "";
  return JSON_MEDIA_TYPE_PATTERN.test(mediaType);
}

function unwrapEnvelope(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data?: unknown }).data
    : payload;
}

function sanitizeAccessError(payload: unknown, requestId: string) {
  const data = unwrapEnvelope(payload);
  const error =
    typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : "Access request failed";
  return envelope({ error }, requestId);
}
