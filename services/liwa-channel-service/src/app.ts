import { readServiceUrls } from "@hyperion/config";
import { HttpOutboxDispatcher } from "@hyperion/durable-events";
import {
  createInternalAuthorizationHeaders,
  readInternalCredential,
  validateInternalAuthorization,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import { randomUUID } from "node:crypto";
import { PostgresLiwaOutbox } from "./outbox.js";
import { createDefaultLiwaDependencies, registerLiwaRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_LIWA_TOKEN");
  const novaToLiwaToken = readInternalCredential(process.env, "NOVA_TO_LIWA_TOKEN");
  const liwaToNovaToken = readInternalCredential(process.env, "LIWA_TO_NOVA_TOKEN");
  const dependencies = createDefaultLiwaDependencies(process.env);

  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === "/v1/liwa/internal/events") {
      const authError = validateInternalAuthorization(request.headers, {
        "nova-core-service": novaToLiwaToken
      });
      if (authError) {
        return reply.code(authError.statusCode).send({ data: { error: authError.message }, requestId: request.id });
      }
      return;
    }

    if (
      request.routeOptions.url === "/v1/liwa/webhooks" ||
      request.routeOptions.url === "/v1/liwa/webhooks/simulate"
    ) {
      return;
    }

    if (!request.routeOptions.url?.startsWith("/v1/tenants/") && request.routeOptions.url !== "/v1/liwa/catalog") {
      return;
    }

    if (request.routeOptions.url === "/v1/liwa/catalog") return;

    const authError = validateInternalAuthorization(request.headers, { "api-gateway": gatewayToken });
    if (authError) {
      return reply.code(authError.statusCode).send({ data: { error: authError.message }, requestId: request.id });
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
