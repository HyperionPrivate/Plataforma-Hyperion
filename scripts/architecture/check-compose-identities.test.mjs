import assert from "node:assert/strict";
import test from "node:test";

import { eventTransportProblems, gatewayDependencyProblems } from "./check-compose-identities.mjs";

test("gateway rechaza acoplar su arranque a la disponibilidad de un producto", () => {
  const configuration = {
    services: {
      "api-gateway": {
        environment: {
          WHATSAPP_CHANNEL_SERVICE_URL: "http://whatsapp-channel-service:8089"
        },
        depends_on: {
          "whatsapp-channel-service": { condition: "service_healthy" }
        }
      },
      "whatsapp-channel-service": {}
    }
  };

  assert.deepEqual(gatewayDependencyProblems(configuration), [
    "api-gateway must not use a startup dependency on whatsapp-channel-service; downstream availability is runtime state"
  ]);
});

test("gateway acepta una URL interna sin dependencia de arranque", () => {
  const configuration = {
    services: {
      "api-gateway": {
        environment: {
          WHATSAPP_CHANNEL_SERVICE_URL: "http://whatsapp-channel-service:8089"
        }
      },
      "whatsapp-channel-service": {}
    }
  };

  assert.deepEqual(gatewayDependencyProblems(configuration), []);
});

test("gateway rechaza URLs invalidas y servicios inexistentes", () => {
  const configuration = {
    services: {
      "api-gateway": {
        environment: {
          AGENT_SERVICE_URL: "not-a-url",
          UNKNOWN_SERVICE_URL: "http://unknown-service:9999"
        }
      }
    }
  };

  assert.deepEqual(gatewayDependencyProblems(configuration), [
    "api-gateway AGENT_SERVICE_URL must be a valid internal service URL",
    "api-gateway UNKNOWN_SERVICE_URL references missing Compose service unknown-service"
  ]);
});

test("transporte durable conserva HTTP como rollback y JetStream como overlay", () => {
  const serviceNames = [
    "agent-service",
    "audit-service",
    "pulso-iris-service",
    "whatsapp-channel-service",
    "lumen-service"
  ];
  const servicesWithTransport = (transport) =>
    Object.fromEntries(
      serviceNames.map((serviceName) => [serviceName, { environment: { DURABLE_EVENT_TRANSPORT: transport } }])
    );

  const base = { services: servicesWithTransport("http") };
  const overlay = {
    services: { ...servicesWithTransport("jetstream"), nats: {} }
  };

  assert.deepEqual(eventTransportProblems(base, overlay), []);
});

test("transporte durable detecta una base sin rollback o un overlay incompleto", () => {
  const serviceNames = [
    "agent-service",
    "audit-service",
    "pulso-iris-service",
    "whatsapp-channel-service",
    "lumen-service"
  ];
  const baseServices = Object.fromEntries(
    serviceNames.map((serviceName) => [
      serviceName,
      { environment: { DURABLE_EVENT_TRANSPORT: serviceName === "agent-service" ? "jetstream" : "http" } }
    ])
  );
  const overlayServices = Object.fromEntries(
    serviceNames.map((serviceName) => [
      serviceName,
      { environment: { DURABLE_EVENT_TRANSPORT: serviceName === "audit-service" ? "http" : "jetstream" } }
    ])
  );

  assert.deepEqual(eventTransportProblems({ services: { ...baseServices, nats: {} } }, { services: overlayServices }), [
    "Base Compose must not include NATS",
    "JetStream overlay must include NATS",
    "agent-service must use the HTTP rollback transport in base Compose",
    "audit-service must use JetStream when the overlay is active"
  ]);
});
