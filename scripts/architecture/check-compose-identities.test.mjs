import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEPLOYMENT_ENVIRONMENT_BASE_SERVICES,
  DEPLOYMENT_ENVIRONMENT_OVERLAY_SERVICES,
  PLATFORM_DATABASE_IDENTITIES,
  PLATFORM_DEPLOYMENT_ENVIRONMENT_SERVICES,
  accessBootstrapEnvironmentProblems,
  auditBootstrapEnvironmentProblems,
  deploymentEnvironmentProblems,
  eventTransportProblems,
  gatewayDependencyProblems,
  httpWorkloadIdentityProblems,
  novaBootstrapEnvironmentProblems,
  platformComposeIdentityProblems,
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

test("NOVA usa su propia barrera database, migrations y roles", () => {
  const configuration = {
    services: {
      postgres: {},
      migrations: { depends_on: { postgres: { condition: "service_healthy" } } },
      "db-role-bootstrap": { depends_on: { migrations: { condition: "service_completed_successfully" } } },
      "nova-database-bootstrap": { depends_on: { postgres: { condition: "service_healthy" } } },
      "nova-migrations": {
        depends_on: { "nova-database-bootstrap": { condition: "service_completed_successfully" } }
      },
      "nova-role-bootstrap": {
        depends_on: { "nova-migrations": { condition: "service_completed_successfully" } }
      },
      "nova-core-service": {
        depends_on: { "nova-role-bootstrap": { condition: "service_completed_successfully" } }
      }
    }
  };

  assert.deepEqual(roleBootstrapDependencyProblems(configuration), []);
});

test("Audit usa su propia barrera database, migrations y roles sin depender del bootstrap global", () => {
  const configuration = {
    services: {
      postgres: {},
      migrations: { depends_on: { postgres: { condition: "service_healthy" } } },
      "db-role-bootstrap": { depends_on: { migrations: { condition: "service_completed_successfully" } } },
      "audit-database-bootstrap": { depends_on: { postgres: { condition: "service_healthy" } } },
      "audit-migrations": {
        depends_on: { "audit-database-bootstrap": { condition: "service_completed_successfully" } }
      },
      "audit-role-bootstrap": {
        depends_on: { "audit-migrations": { condition: "service_completed_successfully" } }
      },
      "audit-service": {
        depends_on: { "audit-role-bootstrap": { condition: "service_completed_successfully" } }
      }
    }
  };

  assert.deepEqual(roleBootstrapDependencyProblems(configuration), []);
});

test("Audit rechaza one-shots reordenados y una dependencia hacia el bootstrap global", () => {
  const configuration = {
    services: {
      postgres: {},
      migrations: { depends_on: { postgres: { condition: "service_healthy" } } },
      "db-role-bootstrap": { depends_on: { migrations: { condition: "service_completed_successfully" } } },
      "audit-database-bootstrap": { depends_on: {} },
      "audit-migrations": { depends_on: {} },
      "audit-role-bootstrap": { depends_on: {} },
      "audit-service": {
        depends_on: {
          "audit-role-bootstrap": { condition: "service_completed_successfully" },
          "db-role-bootstrap": { condition: "service_completed_successfully" }
        }
      }
    }
  };

  assert.deepEqual(roleBootstrapDependencyProblems(configuration), [
    "audit-database-bootstrap must wait for healthy postgres",
    "audit-migrations must wait for successful audit-database-bootstrap",
    "audit-role-bootstrap must wait for successful audit-migrations",
    "audit-service must not depend on the global db-role-bootstrap"
  ]);
});

test("Platform standalone separa roles Access y encadena sus one-shots propietarios", () => {
  const configuration = validPlatformConfiguration();

  assert.deepEqual(PLATFORM_DATABASE_IDENTITIES, {
    "identity-service": "hyperion_identity",
    "tenant-service": "hyperion_tenant",
    "audit-service": "hyperion_audit"
  });
  assert.deepEqual(PLATFORM_DEPLOYMENT_ENVIRONMENT_SERVICES, [
    "access-database-bootstrap",
    "access-migrations",
    "access-role-bootstrap",
    "audit-database-bootstrap",
    "audit-migrations",
    "audit-role-bootstrap",
    "identity-service",
    "tenant-service",
    "audit-service",
    "platform-admin-bff"
  ]);
  assert.deepEqual(accessBootstrapEnvironmentProblems(configuration), []);
  assert.deepEqual(auditBootstrapEnvironmentProblems(configuration), []);
  assert.deepEqual(roleBootstrapDependencyProblems(configuration), []);
  assert.deepEqual(platformComposeIdentityProblems(configuration), []);
});

test("Platform standalone rechaza gateway, roles Access compartidos y dependencias globales", () => {
  const configuration = validPlatformConfiguration();
  configuration.services["api-gateway"] = { environment: {} };
  configuration.services["identity-service"].environment.DATABASE_URL =
    "postgres://hyperion_access:secret@postgres:5432/hyperion_access";
  configuration.services["identity-service"].environment.EXPECTED_DATABASE_ROLE = "hyperion_access";
  configuration.services["identity-service"].environment.GATEWAY_OPERATOR_ASSERTION_KEY =
    "legacy-gateway-assertion-key-0001";
  configuration.services["identity-service"].environment.ACCESS_LUMEN_PROJECTION_TRANSPORT = "http";
  configuration.services["identity-service"].environment.ACCESS_TO_LUMEN_TOKEN = "legacy-access-lumen-token-00001";
  configuration.services["identity-service"].environment.LUMEN_SERVICE_URL = "http://lumen-service:8090";
  configuration.services["identity-service"].depends_on["db-role-bootstrap"] = {
    condition: "service_completed_successfully"
  };

  const problems = platformComposeIdentityProblems(configuration);
  for (const expected of [
    "Standalone Platform Compose must not include service api-gateway",
    "identity-service must declare EXPECTED_DATABASE_ROLE=hyperion_identity",
    "identity-service DATABASE_URL must authenticate as hyperion_identity",
    "identity-service must not depend on the global db-role-bootstrap",
    "identity-service must not receive legacy gateway credential GATEWAY_OPERATOR_ASSERTION_KEY",
    "identity-service must disable the Access→LUMEN projection in standalone Platform Compose",
    "identity-service must not receive product-specific ACCESS_TO_LUMEN_TOKEN when projection is disabled",
    "identity-service must not receive product-specific LUMEN_SERVICE_URL when projection is disabled"
  ]) {
    assert(problems.includes(expected), `missing problem: ${expected}`);
  }
});

test("NOVA entrega a cada one-shot sólo su credencial de base de datos", () => {
  const configuration = {
    services: {
      "db-role-bootstrap": { environment: {} },
      "nova-database-bootstrap": {
        environment: {
          NOVA_POSTGRES_ADMIN_URL: "postgres://admin:secret@postgres:5432/postgres",
          NOVA_POSTGRES_DB: "hyperion_nova",
          NOVA_MIGRATOR_DATABASE_PASSWORD: "controlled-migrator-secret-001"
        }
      },
      "nova-migrations": {
        environment: {
          NOVA_MIGRATOR_DATABASE_URL: "postgres://hyperion_nova_migrator:secret@postgres:5432/hyperion_nova"
        }
      },
      "nova-role-bootstrap": {
        environment: {
          NOVA_POSTGRES_ADMIN_URL: "postgres://admin:secret@postgres:5432/postgres",
          NOVA_POSTGRES_DB: "hyperion_nova",
          NOVA_DATABASE_PASSWORD: "controlled-nova-secret-0001",
          VOICE_DATABASE_PASSWORD: "controlled-voice-secret-002",
          LIWA_DATABASE_PASSWORD: "controlled-liwa-secret-00003",
          DOCUMENTS_DATABASE_PASSWORD: "controlled-documents-secret-4"
        }
      }
    }
  };

  assert.deepEqual(novaBootstrapEnvironmentProblems(configuration), []);

  configuration.services["db-role-bootstrap"].environment.VOICE_DATABASE_PASSWORD = "leaked-voice-secret";
  configuration.services["nova-database-bootstrap"].environment.NOVA_DATABASE_PASSWORD = "leaked-runtime-secret";
  configuration.services["nova-role-bootstrap"].environment.NOVA_MIGRATOR_DATABASE_URL =
    "postgres://hyperion_nova_migrator:secret@postgres:5432/hyperion_nova";
  assert.deepEqual(novaBootstrapEnvironmentProblems(configuration), [
    "db-role-bootstrap must not receive VOICE_DATABASE_PASSWORD",
    "nova-database-bootstrap must not receive NOVA_DATABASE_PASSWORD",
    "nova-role-bootstrap must not receive NOVA_MIGRATOR_DATABASE_URL"
  ]);
});

test("transporte durable conserva HTTP como rollback y JetStream como overlay", () => {
  const serviceNames = [
    "identity-service",
    "agent-service",
    "audit-service",
    "pulso-iris-service",
    "whatsapp-channel-service",
    "lumen-service"
  ];
  const servicesWithTransport = (transport) =>
    Object.fromEntries(
      serviceNames.map((serviceName) => [
        serviceName,
        {
          environment: {
            DURABLE_EVENT_TRANSPORT: transport,
            ...(serviceName === "identity-service"
              ? {
                  ACCESS_LUMEN_PROJECTION_TRANSPORT: transport === "http" ? "http" : "jetstream",
                  ACCESS_TENANT_SNAPSHOT_TRANSPORT: transport === "http" ? "disabled" : "jetstream"
                }
              : {})
          }
        }
      ])
    );

  const base = { services: servicesWithTransport("http") };
  const overlay = {
    services: { ...servicesWithTransport("jetstream"), nats: {} }
  };

  assert.deepEqual(eventTransportProblems(base, overlay), []);
});

test("transporte durable detecta una base sin rollback o un overlay incompleto", () => {
  const serviceNames = [
    "identity-service",
    "agent-service",
    "audit-service",
    "pulso-iris-service",
    "whatsapp-channel-service",
    "lumen-service"
  ];
  const baseServices = Object.fromEntries(
    serviceNames.map((serviceName) => [
      serviceName,
      {
        environment: {
          DURABLE_EVENT_TRANSPORT: serviceName === "agent-service" ? "jetstream" : "http",
          ...(serviceName === "identity-service"
            ? { ACCESS_LUMEN_PROJECTION_TRANSPORT: "http", ACCESS_TENANT_SNAPSHOT_TRANSPORT: "http" }
            : {})
        }
      }
    ])
  );
  const overlayServices = Object.fromEntries(
    serviceNames.map((serviceName) => [
      serviceName,
      {
        environment: {
          DURABLE_EVENT_TRANSPORT: serviceName === "audit-service" ? "http" : "jetstream",
          ...(serviceName === "identity-service"
            ? { ACCESS_LUMEN_PROJECTION_TRANSPORT: "jetstream", ACCESS_TENANT_SNAPSHOT_TRANSPORT: "disabled" }
            : {})
        }
      }
    ])
  );

  assert.deepEqual(eventTransportProblems({ services: { ...baseServices, nats: {} } }, { services: overlayServices }), [
    "Base Compose must not include NATS",
    "JetStream overlay must include NATS",
    "agent-service must use the HTTP rollback transport in base Compose",
    "audit-service must use JetStream when the overlay is active",
    "identity-service must keep the Access→Channel tenant projection disabled in base Compose",
    "identity-service must publish the Access→Channel tenant projection through JetStream in the overlay"
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

test("identidades HTTP comparan aliases provider-owned sin duplicar la variable del consumidor", () => {
  const secret = "controlled-access-channel-secret-001";
  const edges = {
    ACCESS_TO_CHANNEL_TOKEN: ["identity-service", "whatsapp-channel-service"]
  };
  const configuration = {
    services: {
      "identity-service": { environment: { ACCESS_TO_CHANNEL_TOKEN: secret } },
      "whatsapp-channel-service": {
        environment: {
          ACCESS_TO_CHANNEL_TOKEN: secret,
          WHATSAPP_PHONE_HASH_KEY: "dedicated-phone-hash-key-value-0001"
        }
      }
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

test("Integration consume readiness mediante la API y el contrato propietarios de PULSO", async () => {
  const [integrationSource, providerSource, contractSource, policySource] = await Promise.all([
    readFile(new URL("../../services/integration-service/src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/pulso-iris-service/src/agenda-readiness-routes.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/pulso-contracts/src/domain.ts", import.meta.url), "utf8"),
    readFile(new URL("../../docs/architecture/pulso-integration-readiness-policy.v1.json", import.meta.url), "utf8")
  ]);
  const policy = JSON.parse(policySource);

  assert.doesNotMatch(
    integrationSource,
    /pulso_iris\.(?:agenda_settings|availability_rules|professionals)/,
    "Integration must not fall back to PULSO-owned SQL"
  );
  assert.match(integrationSource, /\/internal\/v1\/tenants\/\$\{tenantId\}\/pulso-iris\/agenda\/readiness/);
  assert.match(integrationSource, /pulsoAgendaReadinessSchema\.safeParse/);
  assert.match(providerSource, /\/internal\/v1\/tenants\/:tenantId\/pulso-iris\/agenda\/readiness/);
  assert.match(providerSource, /"integration-service": integrationCredential/);
  assert.match(contractSource, /export const pulsoAgendaReadinessSchema/);
  assert.equal(policy.consumer.failureMode, "fail-closed-502");
  assert.equal(policy.databasePrivilegeRevocation.status, "sofia-iris-control-plane-revoked-roles-ts-closed");
  assert.ok(
    policy.databasePrivilegeRevocation.evidence.includes("packages/pulso-migrations/src/autonomy.integration.test.ts")
  );
  assert.deepEqual(policy.runtimeSqlPolicy.objects, [
    "pulso_iris.agenda_settings",
    "pulso_iris.availability_rules",
    "pulso_iris.professionals",
    "platform.agents",
    "platform.prompt_flows",
    "platform.products",
    "platform.audit_events",
    "platform.schema_migrations",
    "channel_runtime.outbound_messages"
  ]);
  assert.doesNotMatch(integrationSource, /platform\.(?:agents|prompt_flows|schema_migrations)/);
});

test("PULSO consulta el historial mediante la API Audit acotada y sin fallback SQL", async () => {
  const [appointmentSource, clientSource, auditSource] = await Promise.all([
    readFile(new URL("../../services/pulso-iris-service/src/appointment-routes.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/pulso-iris-service/src/audit-history-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/audit-service/src/app.ts", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(appointmentSource, /platform\.audit_events/);
  assert.match(appointmentSource, /readAuditHistory\(tenantId, "appointment", appointmentId\)/);
  assert.match(
    clientSource,
    /\/internal\/v1\/tenants\/\$\{encodeURIComponent\(parsedTenant\.data\)\}\/audit\/entities\//
  );
  assert.match(clientSource, /redirect: "error"/);
  assert.match(auditSource, /\/internal\/v1\/tenants\/:tenantId\/audit\/entities\/:entityType\/:entityId\/events/);
  assert.match(auditSource, /sourceService = expectedAuditSourceForCaller\(caller\)/);
});

function validPlatformConfiguration() {
  const deployment = { HYPERION_ENVIRONMENT: "local" };
  const runtime = {
    ...deployment,
    SHUTDOWN_TIMEOUT_MS: "65000"
  };
  const accessAdminUrl = "postgres://platform_admin:secret@postgres:5432/postgres";
  const auditAdminUrl = "postgres://platform_admin:secret@postgres:5432/postgres";
  const platformAccessToken = "platform-admin-access-token-0001";
  const platformIdentityToken = "platform-admin-identity-token-001";
  const platformTenantToken = "platform-admin-tenant-token-0001";
  const platformAssertionKey = "platform-admin-assertion-key-0001";

  return {
    services: {
      postgres: {},
      "access-database-bootstrap": {
        environment: {
          ...deployment,
          ACCESS_POSTGRES_ADMIN_URL: accessAdminUrl,
          ACCESS_POSTGRES_DB: "hyperion_access",
          ACCESS_MIGRATOR_DATABASE_PASSWORD: "access-migrator-password-0001"
        },
        depends_on: { postgres: { condition: "service_healthy" } }
      },
      "access-migrations": {
        environment: {
          ...deployment,
          ACCESS_POSTGRES_DB: "hyperion_access",
          ACCESS_MIGRATOR_DATABASE_URL: "postgres://hyperion_access_migrator:secret@postgres:5432/hyperion_access"
        },
        depends_on: { "access-database-bootstrap": { condition: "service_completed_successfully" } }
      },
      "access-role-bootstrap": {
        environment: {
          ...deployment,
          ACCESS_POSTGRES_ADMIN_URL: accessAdminUrl,
          ACCESS_POSTGRES_DB: "hyperion_access",
          ACCESS_MIGRATOR_DATABASE_PASSWORD: "access-migrator-password-0001",
          IDENTITY_DATABASE_PASSWORD: "identity-runtime-password-001",
          TENANT_DATABASE_PASSWORD: "tenant-runtime-password-00001"
        },
        depends_on: { "access-migrations": { condition: "service_completed_successfully" } }
      },
      "audit-database-bootstrap": {
        environment: {
          ...deployment,
          AUDIT_POSTGRES_ADMIN_URL: auditAdminUrl,
          AUDIT_POSTGRES_DB: "hyperion_audit",
          AUDIT_MIGRATOR_DATABASE_PASSWORD: "audit-migrator-password-00001"
        },
        depends_on: { postgres: { condition: "service_healthy" } }
      },
      "audit-migrations": {
        environment: {
          ...deployment,
          AUDIT_MIGRATOR_DATABASE_URL: "postgres://hyperion_audit_migrator:secret@postgres:5432/hyperion_audit"
        },
        depends_on: { "audit-database-bootstrap": { condition: "service_completed_successfully" } }
      },
      "audit-role-bootstrap": {
        environment: {
          ...deployment,
          AUDIT_POSTGRES_ADMIN_URL: auditAdminUrl,
          AUDIT_POSTGRES_DB: "hyperion_audit",
          AUDIT_DATABASE_PASSWORD: "audit-runtime-password-0000001"
        },
        depends_on: { "audit-migrations": { condition: "service_completed_successfully" } }
      },
      "identity-service": {
        environment: {
          ...runtime,
          DATABASE_URL: "postgres://hyperion_identity:secret@postgres:5432/hyperion_access",
          EXPECTED_DATABASE_ROLE: "hyperion_identity",
          PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN: platformAccessToken,
          PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN: platformIdentityToken,
          PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY: platformAssertionKey,
          ACCESS_TENANT_SNAPSHOT_TRANSPORT: "disabled",
          ACCESS_LUMEN_PROJECTION_TRANSPORT: "disabled"
        },
        stop_grace_period: "75s",
        depends_on: { "access-role-bootstrap": { condition: "service_completed_successfully" } }
      },
      "tenant-service": {
        environment: {
          ...runtime,
          DATABASE_URL: "postgres://hyperion_tenant:secret@postgres:5432/hyperion_access",
          EXPECTED_DATABASE_ROLE: "hyperion_tenant",
          PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN: platformTenantToken
        },
        stop_grace_period: "75s",
        depends_on: { "access-role-bootstrap": { condition: "service_completed_successfully" } }
      },
      "audit-service": {
        environment: {
          ...runtime,
          DATABASE_URL: "postgres://hyperion_audit:secret@postgres:5432/hyperion_audit",
          EXPECTED_DATABASE_ROLE: "hyperion_audit",
          DURABLE_EVENT_TRANSPORT: "http"
        },
        stop_grace_period: "75s",
        depends_on: { "audit-role-bootstrap": { condition: "service_completed_successfully" } }
      },
      "platform-admin-bff": {
        environment: {
          ...runtime,
          PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN: platformAccessToken,
          PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN: platformIdentityToken,
          PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN: platformTenantToken,
          PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY: platformAssertionKey
        },
        stop_grace_period: "75s"
      },
      "platform-admin-console": {}
    }
  };
}
