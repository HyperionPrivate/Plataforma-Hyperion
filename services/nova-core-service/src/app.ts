import { novaCatalog } from "@hyperion/nova-contracts";
import { readServiceUrls } from "@hyperion/nova-config";
import { HttpOutboxDispatcher } from "@hyperion/nova-durable-events";
import {
  createInternalAuthorizationHeaders,
  createProductSystemAssertionHeaders,
  readInternalCaller,
  readInternalCredential,
  readOperatorAssertionKey,
  validateInternalAuthorization,
  validateProductOperatorAssertionContext,
  validateProductSystemAssertionContext,
  type RouteRegistrar
} from "@hyperion/nova-service-runtime";
import { randomUUID } from "node:crypto";
import { PostgresNovaOutbox } from "./outbox.js";
import { registerNovaRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_NOVA_TOKEN");
  const novaBffToken = readInternalCredential(process.env, "NOVA_BFF_TO_NOVA_TOKEN");
  const gatewayAssertionKey = readOperatorAssertionKey(process.env);
  const novaAssertionKey = readInternalCredential(process.env, "NOVA_OPERATOR_ASSERTION_KEY");
  const novaToVoiceToken = readInternalCredential(process.env, "NOVA_TO_VOICE_TOKEN");
  const novaToLiwaToken = readInternalCredential(process.env, "NOVA_TO_LIWA_TOKEN");
  const novaToAuditToken = readInternalCredential(process.env, "NOVA_TO_AUDIT_TOKEN");
  const voiceToNovaToken = readInternalCredential(process.env, "VOICE_TO_NOVA_TOKEN");
  const liwaToNovaToken = readInternalCredential(process.env, "LIWA_TO_NOVA_TOKEN");
  const documentsToNovaToken = readInternalCredential(process.env, "DOCUMENTS_TO_NOVA_TOKEN");
  if (
    (novaBffToken ||
      novaToVoiceToken ||
      novaToLiwaToken ||
      voiceToNovaToken ||
      liwaToNovaToken ||
      documentsToNovaToken) &&
    !novaAssertionKey
  ) {
    throw new Error("NOVA_OPERATOR_ASSERTION_KEY is required for NOVA BFF and provider event edges");
  }

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
      const caller = readInternalCaller(request.headers);
      const tenantId = readEventTenantId(request.body);
      const assertionError =
        caller && tenantId
          ? validateProductSystemAssertionContext(
              request.headers,
              novaAssertionKey,
              tenantId,
              novaCatalog.product.code,
              caller
            )
          : { statusCode: 403 as const, message: "Operator assertion mismatch" as const };
      if (assertionError) {
        return reply.code(assertionError.statusCode).send(envelopeError(assertionError.message, request.id));
      }
      return;
    }

    if (!request.routeOptions.url?.startsWith("/v1/tenants/")) return;

    const tenantId = readTenantParam(request.params);
    if (tenantId === undefined) return;

    const authError = validateInternalAuthorization(request.headers, {
      "nova-bff": novaBffToken,
      "api-gateway": gatewayToken
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelopeError(authError.message, request.id));
    }

    const assertionError = validateProductOperatorAssertionContext(
      request.headers,
      readInternalCaller(request.headers) === "nova-bff" ? novaAssertionKey : gatewayAssertionKey,
      tenantId,
      novaCatalog.product.code
    );
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
      timeoutMs: 5_000,
      requestHeaders: (event) =>
        event.tenantId &&
        (event.destination.startsWith(serviceUrls.voiceChannel.replace(/\/$/, "")) ||
          event.destination.startsWith(serviceUrls.liwaChannel.replace(/\/$/, "")))
          ? createProductSystemAssertionHeaders({
              serviceId: "nova-core-service",
              tenantId: event.tenantId,
              productId: novaCatalog.product.code,
              secret: novaAssertionKey!
            })
          : {}
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

function readEventTenantId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = "tenantId" in body ? body.tenantId : "tenant_id" in body ? body.tenant_id : undefined;
  return typeof raw === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw)
    ? raw
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
    const caller = "nova-core-service";

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
    return fetch(input, { ...init, headers, redirect: "error" });
  };
}
