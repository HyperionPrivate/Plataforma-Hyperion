import { readServiceUrls } from "@hyperion/nova-config";
import { novaProductCode } from "@hyperion/nova-contracts";
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
import { PostgresLiwaOutbox } from "./outbox.js";
import { createDefaultLiwaDependencies, registerLiwaRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_LIWA_TOKEN");
  const novaBffToken = readInternalCredential(process.env, "NOVA_BFF_TO_LIWA_TOKEN");
  const novaToLiwaToken = readInternalCredential(process.env, "NOVA_TO_LIWA_TOKEN");
  const liwaToNovaToken = readInternalCredential(process.env, "LIWA_TO_NOVA_TOKEN");
  const gatewayAssertionKey = readOperatorAssertionKey(process.env);
  const novaAssertionKey = readInternalCredential(process.env, "NOVA_OPERATOR_ASSERTION_KEY");
  if ((novaBffToken || novaToLiwaToken || liwaToNovaToken) && !novaAssertionKey) {
    throw new Error("NOVA_OPERATOR_ASSERTION_KEY is required for NOVA BFF and provider event edges");
  }
  const dependencies = createDefaultLiwaDependencies(process.env);

  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === "/v1/liwa/internal/events") {
      const authError = validateInternalAuthorization(request.headers, {
        "nova-core-service": novaToLiwaToken
      });
      if (authError) {
        return reply.code(authError.statusCode).send({ data: { error: authError.message }, requestId: request.id });
      }
      const tenantId = readEventTenantId(request.body);
      const assertionError = tenantId
        ? validateProductSystemAssertionContext(
            request.headers,
            novaAssertionKey,
            tenantId,
            novaProductCode,
            "nova-core-service"
          )
        : { statusCode: 403 as const, message: "Operator assertion mismatch" as const };
      if (assertionError) {
        return reply
          .code(assertionError.statusCode)
          .send({ data: { error: assertionError.message }, requestId: request.id });
      }
      return;
    }

    if (request.routeOptions.url === "/v1/liwa/webhooks" || request.routeOptions.url === "/v1/liwa/webhooks/simulate") {
      return;
    }

    if (!request.routeOptions.url?.startsWith("/v1/tenants/") && request.routeOptions.url !== "/v1/liwa/catalog") {
      return;
    }

    if (request.routeOptions.url === "/v1/liwa/catalog") return;

    const authError = validateInternalAuthorization(request.headers, {
      "nova-bff": novaBffToken,
      "api-gateway": gatewayToken
    });
    if (authError) {
      return reply.code(authError.statusCode).send({ data: { error: authError.message }, requestId: request.id });
    }

    const tenantId = readTenantParam(request.params);
    if (tenantId === undefined) return;
    const assertionError = validateProductOperatorAssertionContext(
      request.headers,
      readInternalCaller(request.headers) === "nova-bff" ? novaAssertionKey : gatewayAssertionKey,
      tenantId,
      novaProductCode
    );
    if (assertionError) {
      return reply
        .code(assertionError.statusCode)
        .send({ data: { error: assertionError.message }, requestId: request.id });
    }
  });

  await registerLiwaRoutes(app, context, dependencies);

  if (context.db && liwaToNovaToken) {
    const workerId = `liwa-outbox-${randomUUID()}`;
    const outbox = new PostgresLiwaOutbox(context.db, workerId);
    const dispatcher = new HttpOutboxDispatcher<Record<string, unknown>>({
      workerId,
      internalToken: liwaToNovaToken,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(
          createInternalAuthorizationHeaders("liwa-channel-service", liwaToNovaToken)
        )) {
          headers.set(name, value);
        }
        return fetch(input, { ...init, headers, redirect: "error" });
      },
      claim: (limit) => outbox.claim(limit),
      complete: (eventId) => outbox.complete(eventId),
      fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
      batchSize: 10,
      intervalMs: 750,
      timeoutMs: 5_000,
      requestHeaders: (event) => {
        if (!event.tenantId) throw new Error("LIWA outbox event tenantId is required");
        return createProductSystemAssertionHeaders({
          serviceId: "liwa-channel-service",
          tenantId: event.tenantId,
          productId: novaProductCode,
          secret: novaAssertionKey!
        });
      }
    });
    app.addHook("onClose", async () => dispatcher.stop());
    dispatcher.start();
    void readServiceUrls().novaCore;
  }
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
