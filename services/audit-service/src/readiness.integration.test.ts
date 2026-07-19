import { createDatabase } from "@hyperion/database";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_RUNTIME_MIGRATION_REQUIREMENT } from "@hyperion/audit-migrations/schema-manifest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("Audit provider-owned readiness", () => {
  let service: ServiceHandle;

  beforeAll(async () => {
    service = await createService({
      serviceName: "audit-service",
      databaseRequired: true,
      requiredMigrationLedger: AUDIT_RUNTIME_MIGRATION_REQUIREMENT,
      createDatabase
    });
  });

  afterAll(async () => {
    await service?.app.close();
  });

  it("becomes ready from audit_runtime.migration_ledger without the global ledger", async () => {
    const response = await service.app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      dependencies: expect.arrayContaining([
        expect.objectContaining({ name: "audit_runtime.migration_ledger", status: "ok" })
      ])
    });
  });
});
