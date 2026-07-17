import { readServiceUrls } from "@hyperion/config";
import { HttpOutboxDispatcher } from "@hyperion/durable-events";
import {
  createInternalAuthorizationHeaders,
  readInternalCredential,
  validateInternalAuthorization,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import { randomUUID } from "node:crypto";
import { PostgresDocumentsOutbox } from "./outbox.js";
import { createDefaultDocumentsDependencies, registerDocumentsRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_DOCUMENTS_TOKEN");
  const documentsToNovaToken = readInternalCredential(process.env, "DOCUMENTS_TO_NOVA_TOKEN");
  const dependencies = createDefaultDocumentsDependencies(process.env);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/v1/tenants/")) return;
    const authError = validateInternalAuthorization(request.headers, { "api-gateway": gatewayToken });
    if (authError) {
      return reply.code(authError.statusCode).send({ data: { error: authError.message }, requestId: request.id });
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
        return fetch(input, { ...init, headers });
      },
      claim: (limit) => outbox.claim(limit),
      complete: (eventId) => outbox.complete(eventId),
      fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
      batchSize: 10,
      intervalMs: 750,
      timeoutMs: 5_000
    });
    app.addHook("onClose", async () => dispatcher.stop());
    dispatcher.start();
    void readServiceUrls().novaCore;
  }
};
