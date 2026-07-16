import { novaCatalog } from "@hyperion/contracts";
import { readServiceUrls } from "@hyperion/config";
import { HttpOutboxDispatcher } from "@hyperion/durable-events";
import {
  createInternalAuthorizationHeaders,
  readInternalCredential,
  readOperatorAssertionKey,
  validateInternalAuthorization,
  validateOperatorAssertionContext,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import { randomUUID } from "node:crypto";
import { PostgresNovaOutbox } from "./outbox.js";
import { registerNovaRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_NOVA_TOKEN");
  const operatorAssertionKey = readOperatorAssertionKey(process.env);
  const novaToVoiceToken = readInternalCredential(process.env, "NOVA_TO_VOICE_TOKEN");
  const novaToLiwaToken = readInternalCredential(process.env, "NOVA_TO_LIWA_TOKEN");
  const novaToAuditToken = readInternalCredential(process.env, "NOVA_TO_AUDIT_TOKEN");
  const voiceToNovaToken = readInternalCredential(process.env, "VOICE_TO_NOVA_TOKEN");
  const liwaToNovaToken = readInternalCredential(process.env, "LIWA_TO_NOVA_TOKEN");
  const documentsToNovaToken = readInternalCredential(process.env, "DOCUMENTS_TO_NOVA_TOKEN");

  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === "/internal/events") {
      const authError = validateInternalAuthorization(request.headers, {
        "voice-channel-service": voiceToNovaToken,
        "liwa-channel-service": liwaToNovaToken,
        "documents-service": documentsToNovaToken
      });
      if (authError) {
        return reply.code(authError.statusCode).send(envelopeError(authError.message, request.id));
      }
      return;
    }

    if (!request.routeOptions.url?.startsWith("/v1/tenants/")) return;

    const tenantId = readTenantParam(request.params);
    if (tenantId === undefined) return;

    const authError = validateInternalAuthorization(request.headers, { "api-gateway": gatewayToken });
    if (authError) {
      return reply.code(authError.statusCode).send(envelopeError(authError.message, request.id));
    }

    const assertionError = validateOperatorAssertionContext(request.headers, operatorAssertionKey, tenantId);
    if (assertionError) {
      return reply.code(assertionError.statusCode).send(envelopeError(assertionError.message, request.id));
    }
  });

  await registerNovaRoutes(app, context);

  if (context.db && (novaToVoiceToken || novaToLiwaToken || novaToAuditToken)) {
    const workerId = `nova-outbox-${randomUUID()}`;
    const outbox = new PostgresNovaOutbox(context.db, workerId);
    const serviceUrls = readServiceUrls();
    const dispatcher = new HttpOutboxDispatcher<Record<string, unknown>>({
      workerId,
      internalToken: novaToAuditToken ?? novaToVoiceToken ?? novaToLiwaToken ?? "",
      fetch: createNovaOutboxFetch({
        auditToken: novaToAuditToken,
        voiceToken: novaToVoiceToken,
        liwaToken: novaToLiwaToken,
        auditUrl: serviceUrls.audit,
        voiceUrl: serviceUrls.voiceChannel,
        liwaUrl: serviceUrls.liwaChannel
      }),
      claim: (limit) => outbox.claim(limit),
      complete: (eventId) => outbox.complete(eventId),
      fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
      batchSize: 10,
      intervalMs: 750,
      timeoutMs: 5_000
    });
    app.addHook("onClose", async () => dispatcher.stop());
    dispatcher.start();
  }

  app.get("/v1/nova/health", async (request) => ({
    data: {
      service: "nova-core-service",
      product: novaCatalog.product.code,
      status: "ok"
    },
    requestId: request.id
  }));
};

function readTenantParam(params: unknown): string | undefined {
  return typeof params === "object" &&
    params !== null &&
    "tenantId" in params &&
    typeof (params as { tenantId?: unknown }).tenantId === "string"
    ? (params as { tenantId: string }).tenantId
    : undefined;
}

function envelopeError(error: string, requestId: string) {
  return { data: { error }, requestId };
}

function createNovaOutboxFetch(options: {
  auditToken?: string;
  voiceToken?: string;
  liwaToken?: string;
  auditUrl: string;
  voiceUrl: string;
  liwaUrl: string;
}): typeof fetch {
  const auditBase = options.auditUrl.replace(/\/$/, "");
  const voiceBase = options.voiceUrl.replace(/\/$/, "");
  const liwaBase = options.liwaUrl.replace(/\/$/, "");

  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let token = options.auditToken;
    let caller = "nova-core-service";

    if (url.startsWith(voiceBase)) {
      token = options.voiceToken;
    } else if (url.startsWith(liwaBase)) {
      token = options.liwaToken;
    } else if (url.startsWith(auditBase)) {
      token = options.auditToken;
    }

    const headers = new Headers(init?.headers);
    if (token) {
      for (const [name, value] of Object.entries(createInternalAuthorizationHeaders(caller, token))) {
        headers.set(name, value);
      }
    }
    return fetch(input, { ...init, headers });
  };
}
