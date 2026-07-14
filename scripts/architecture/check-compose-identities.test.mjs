import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPLOYMENT_ENVIRONMENT_BASE_SERVICES,
  DEPLOYMENT_ENVIRONMENT_OVERLAY_SERVICES,
  deploymentEnvironmentProblems,
  eventTransportProblems,
  gatewayDependencyProblems,
  httpWorkloadIdentityProblems,
  roleBootstrapDependencyProblems,
  shutdownLifecycleProblems
} from "./check-compose-identities.mjs";

test("Compose propaga una clase de despliegue explícita a cada workload relevante", () => {
  const servicesFor = (names, deploymentEnvironment) =>
    Object.fromEntries(names.map((name) => [name, { environment: { HYPERION_ENVIRONMENT: deploymentEnvironment } }]));
  const base = { services: servicesFor(DEPLOYMENT_ENVIRONMENT_BASE_SERVICES, "local") };
  const overlay = { services: servicesFor(DEPLOYMENT_ENVIRONMENT_OVERLAY_SERVICES, "local") };

  assert.deepEqual(deploymentEnvironmentProblems(base, overlay), []);
});

test("Compose rechaza entornos ausentes, divergentes y escapes heredados", () => {
  const base = {
    services: {
      migrations: { environment: { HYPERION_ENVIRONMENT: "local" } },
      "db-role-bootstrap": { environment: {} },
      "api-gateway": {
        environment: {
          HYPERION_ENVIRONMENT: "production",
          CI: "true"
        }
      }
    }
  };
  const overlay = {
    services: {
      nats: {
        environment: {
          HYPERION_ENVIRONMENT: "local",
          HYPERION_ALLOW_EXAMPLE_SECRETS: "true"
        }
      },
      "jetstream-topology-bootstrap": { environment: { HYPERION_ENVIRONMENT: "staging" } }
    }
  };

  assert.deepEqual(
    deploymentEnvironmentProblems(
      base,
      overlay,
      ["migrations", "db-role-bootstrap", "api-gateway"],
      ["nats", "jetstream-topology-bootstrap"]
    ),
    [
      "db-role-bootstrap must declare HYPERION_ENVIRONMENT as local, ci, staging or production",
      "api-gateway must not use ambient CI as a deployment security decision",
      "nats must not receive the legacy HYPERION_ALLOW_EXAMPLE_SECRETS bypass",
      "all environment-aware Compose workloads must receive the same HYPERION_ENVIRONMENT"
    ]
  );
});

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

test("roles siguen el orden postgres, migraciones, bootstrap y runtimes", () => {
  const configuration = {
    services: {
      postgres: {},
      migrations: { depends_on: { postgres: { condition: "service_healthy" } } },
      "db-role-bootstrap": { depends_on: { migrations: { condition: "service_completed_successfully" } } },
      "identity-service": {
        depends_on: { "db-role-bootstrap": { condition: "service_completed_successfully" } }
      },
      "api-gateway": {},
      "web-console": { depends_on: { "api-gateway": { condition: "service_healthy" } } }
    }
  };

  assert.deepEqual(roleBootstrapDependencyProblems(configuration), []);
});

test("roles detectan bootstrap anticipado y runtimes sin barrera", () => {
  const configuration = {
    services: {
      postgres: {},
      migrations: { depends_on: { "db-role-bootstrap": { condition: "service_completed_successfully" } } },
      "db-role-bootstrap": { depends_on: { postgres: { condition: "service_healthy" } } },
      "identity-service": { depends_on: { migrations: { condition: "service_completed_successfully" } } }
    }
  };

  assert.deepEqual(roleBootstrapDependencyProblems(configuration), [
    "migrations must wait for healthy postgres",
    "migrations must run before db-role-bootstrap",
    "db-role-bootstrap must wait for successful migrations",
    "identity-service must not start before db-role-bootstrap completes"
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

test("identidades HTTP aceptan un secreto distinto limitado a cada vínculo", () => {
  const secretA = "controlled-edge-secret-value-001";
  const secretB = "controlled-edge-secret-value-002";
  const edges = {
    A_TO_B_TOKEN: ["producer-a", "consumer-b"],
    C_TO_D_TOKEN: ["producer-c", "consumer-d"]
  };
  const configuration = {
    services: {
      "producer-a": { environment: { A_TO_B_TOKEN: secretA } },
      "consumer-b": { environment: { A_TO_B_TOKEN: secretA } },
      "producer-c": { environment: { C_TO_D_TOKEN: secretB } },
      "consumer-d": { environment: { C_TO_D_TOKEN: secretB } }
    }
  };

  assert.deepEqual(httpWorkloadIdentityProblems(configuration, edges), []);
});

test("identidades HTTP detectan credenciales globales, ausentes, filtradas o reutilizadas", () => {
  const reused = "controlled-edge-secret-value-001";
  const edges = {
    A_TO_B_TOKEN: ["producer-a", "consumer-b"],
    C_TO_D_TOKEN: ["producer-c", "consumer-d"]
  };
  const configuration = {
    services: {
      "producer-a": { environment: { A_TO_B_TOKEN: reused, INTERNAL_SERVICE_TOKEN: "legacy" } },
      "consumer-b": { environment: {} },
      "producer-c": { environment: { C_TO_D_TOKEN: reused } },
      "consumer-d": { environment: { C_TO_D_TOKEN: reused } },
      intruder: { environment: { A_TO_B_TOKEN: reused } }
    }
  };

  assert.deepEqual(httpWorkloadIdentityProblems(configuration, edges), [
    "producer-a must not receive the legacy INTERNAL_SERVICE_TOKEN",
    "consumer-b must receive A_TO_B_TOKEN",
    "intruder must not receive unrelated credential A_TO_B_TOKEN",
    "C_TO_D_TOKEN must not reuse the value of A_TO_B_TOKEN"
  ]);
});

test("la clave de hash telefónico es dedicada y no reutiliza credenciales HTTP", () => {
  const edgeSecret = "controlled-edge-secret-value-001";
  const edges = { A_TO_B_TOKEN: ["producer-a", "whatsapp-channel-service"] };
  const configuration = {
    services: {
      "producer-a": { environment: { A_TO_B_TOKEN: edgeSecret } },
      "whatsapp-channel-service": {
        environment: {
          A_TO_B_TOKEN: edgeSecret,
          WHATSAPP_PHONE_HASH_KEY: edgeSecret
        }
      }
    }
  };

  assert.deepEqual(httpWorkloadIdentityProblems(configuration, edges), [
    "WHATSAPP_PHONE_HASH_KEY must not reuse the value of A_TO_B_TOKEN"
  ]);

  configuration.services["whatsapp-channel-service"].environment.WHATSAPP_PHONE_HASH_KEY =
    "dedicated-phone-hash-key-value-0001";
  assert.deepEqual(httpWorkloadIdentityProblems(configuration, edges), []);
});

test("el presupuesto de Compose permite terminar el drenaje del runtime", () => {
  const configuration = {
    services: {
      worker: {
        environment: { SHUTDOWN_TIMEOUT_MS: "65000" },
        stop_grace_period: "1m15s"
      }
    }
  };

  assert.deepEqual(shutdownLifecycleProblems(configuration, ["worker"]), []);
});

test("el presupuesto de Compose detecta ausencia o SIGKILL anticipado", () => {
  const configuration = {
    services: {
      missing: { environment: { SHUTDOWN_TIMEOUT_MS: "65000" } },
      short: {
        environment: { SHUTDOWN_TIMEOUT_MS: "65000" },
        stop_grace_period: 65_000_000_000
      },
      invalid: {
        environment: { SHUTDOWN_TIMEOUT_MS: "10000" },
        stop_grace_period: "75s"
      }
    }
  };

  assert.deepEqual(shutdownLifecycleProblems(configuration, ["missing", "short", "invalid"]), [
    "missing must declare stop_grace_period",
    "short stop_grace_period must exceed SHUTDOWN_TIMEOUT_MS by at least 5000ms",
    "invalid must declare a valid SHUTDOWN_TIMEOUT_MS between 55000 and 900000"
  ]);
});
