import { readServiceUrls } from "@hyperion/config";
import { HttpOutboxDispatcher } from "@hyperion/durable-events";
import {
  createInternalAuthorizationHeaders,
  readInternalCredential,
  validateInternalAuthorization,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import { randomUUID } from "node:crypto";
import { createDialerAdapter, UnconfiguredDialerAdapter } from "./dialer-adapter.js";
import { startOutcomePoller } from "./outcome-poller.js";
import { PostgresVoiceOutbox } from "./outbox.js";
import { registerVoiceRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_VOICE_TOKEN");
  const novaToVoiceToken = readInternalCredential(process.env, "NOVA_TO_VOICE_TOKEN");
  const voiceToNovaToken = readInternalCredential(process.env, "VOICE_TO_NOVA_TOKEN");
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
      return;
    }

    if (!request.routeOptions.url?.startsWith("/v1/tenants/")) return;
    const authError = validateInternalAuthorization(request.headers, { "api-gateway": gatewayToken });
    if (authError) {
      return reply.code(authError.statusCode).send({ data: { error: authError.message }, requestId: request.id });
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
  }
};
