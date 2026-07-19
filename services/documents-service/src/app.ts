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
  type RouteRegistrar
} from "@hyperion/nova-service-runtime";
import { randomUUID } from "node:crypto";
import { PostgresDocumentsOutbox } from "./outbox.js";
import { createDefaultDocumentsDependencies, registerDocumentsRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_DOCUMENTS_TOKEN");
  const novaBffToken = readInternalCredential(process.env, "NOVA_BFF_TO_DOCUMENTS_TOKEN");
  const documentsToNovaToken = readInternalCredential(process.env, "DOCUMENTS_TO_NOVA_TOKEN");
  const gatewayAssertionKey = readOperatorAssertionKey(process.env);
  const novaAssertionKey = readInternalCredential(process.env, "NOVA_OPERATOR_ASSERTION_KEY");
  if ((novaBffToken || documentsToNovaToken) && !novaAssertionKey) {
    throw new Error("NOVA_OPERATOR_ASSERTION_KEY is required for NOVA BFF and provider event edges");
  }
  const dependencies = createDefaultDocumentsDependencies(process.env);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/v1/tenants/")) return;
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

  await registerDocumentsRoutes(app, context, dependencies);

  if (context.db && documentsToNovaToken) {
    const workerId = `documents-outbox-${randomUUID()}`;
    const outbox = new PostgresDocumentsOutbox(context.db, workerId);
    const dispatcher = new HttpOutboxDispatcher<Record<string, unknown>>({
      workerId,
      internalToken: documentsToNovaToken,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(
          createInternalAuthorizationHeaders("documents-service", documentsToNovaToken)
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
        if (!event.tenantId) throw new Error("Documents outbox event tenantId is required");
        return createProductSystemAssertionHeaders({
          serviceId: "documents-service",
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
