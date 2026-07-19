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
import { createDialerAdapter, UnconfiguredDialerAdapter } from "./dialer-adapter.js";
import { startOutcomePoller } from "./outcome-poller.js";
import { PostgresVoiceOutbox } from "./outbox.js";
import { registerVoiceRawJsonBodyParser, registerVoiceRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  registerVoiceRawJsonBodyParser(app);
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_VOICE_TOKEN");
  const novaBffToken = readInternalCredential(process.env, "NOVA_BFF_TO_VOICE_TOKEN");
  const novaToVoiceToken = readInternalCredential(process.env, "NOVA_TO_VOICE_TOKEN");
  const voiceToNovaToken = readInternalCredential(process.env, "VOICE_TO_NOVA_TOKEN");
  const gatewayAssertionKey = readOperatorAssertionKey(process.env);
  const novaAssertionKey = readInternalCredential(process.env, "NOVA_OPERATOR_ASSERTION_KEY");
  if ((novaBffToken || novaToVoiceToken || voiceToNovaToken) && !novaAssertionKey) {
    throw new Error("NOVA_OPERATOR_ASSERTION_KEY is required for NOVA BFF and provider event edges");
  }
  const dialer = createDialerAdapter(process.env);
  const dialerConfigured = !(dialer instanceof UnconfiguredDialerAdapter);
  const novaDestination = `${readServiceUrls().novaCore.replace(/\/$/, "")}/internal/events`;

  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === "/v1/voice/internal/events") {
      const authError = validateInternalAuthorization(request.headers, {
        "nova-core-service": novaToVoiceToken
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

  await registerVoiceRoutes(app, context, { dialer });

  if (context.db && dialerConfigured) {
    const poller = startOutcomePoller({
      db: context.db,
      dialer,
      novaDestination,
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY?.trim(),
      intervalMs: Number(process.env.VOICE_OUTCOME_POLL_MS ?? 5000),
      onError: (error) => app.log.error({ err: error }, "voice outcome poller failed")
    });
    context.registerReadinessCheck?.({
      name: "voice_outcome_poller",
      check: async () => {
        const readiness = await poller.checkReadiness();
        if (readiness.status !== "ok") {
          throw new Error(readiness.detail ?? "voice outcome poller degraded");
        }
      }
    });
    app.addHook("onClose", async () => poller.stop());
  } else if (!dialerConfigured) {
    app.log.warn("Dialer credentials absent — outcome poller disabled until DIALER_* is configured");
  }

  if (context.db && voiceToNovaToken) {
    const workerId = `voice-outbox-${randomUUID()}`;
    const outbox = new PostgresVoiceOutbox(context.db, workerId);
    const dispatcher = new HttpOutboxDispatcher<Record<string, unknown>>({
      workerId,
      internalToken: voiceToNovaToken,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(
          createInternalAuthorizationHeaders("voice-channel-service", voiceToNovaToken)
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
        if (!event.tenantId) throw new Error("Voice outbox event tenantId is required");
        return createProductSystemAssertionHeaders({
          serviceId: "voice-channel-service",
          tenantId: event.tenantId,
          productId: novaProductCode,
          secret: novaAssertionKey!
        });
      }
    });
    app.addHook("onClose", async () => dispatcher.stop());
    dispatcher.start();
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
