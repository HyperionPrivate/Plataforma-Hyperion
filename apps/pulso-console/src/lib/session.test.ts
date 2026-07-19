import { describe, expect, it } from "vitest";
import { hasPulsoCapability, pulsoGrantFor, type PulsoGrant, type PulsoSession } from "./session.js";

const session: PulsoSession = {
  operator: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "operator@example.com",
    displayName: "Operator",
    role: "advisor"
  },
  tenants: [{ id: "00000000-0000-4000-8000-000000000002", displayName: "Tenant" }],
  grants: [],
  csrfToken: "csrf"
};

describe("PULSO grants", () => {
  it("rejects a tenant without an explicit product grant", () =>
    expect(pulsoGrantFor(session, session.tenants[0]!.id)).toBeUndefined());
  it("selects only a PULSO grant for the requested tenant", () => {
    const grant: PulsoGrant = {
      tenantId: session.tenants[0]!.id,
      productId: "PULSO_IRIS",
      roles: ["advisor"],
      capabilities: ["pulso:read"],
      active: true
    };
    expect(pulsoGrantFor({ ...session, grants: [grant] }, grant.tenantId)).toEqual(grant);
    expect(
      pulsoGrantFor(
        { ...session, grants: [{ ...grant, tenantId: "00000000-0000-4000-8000-000000000003" }] },
        grant.tenantId
      )
    ).toBeUndefined();
    expect(hasPulsoCapability({ ...grant, capabilities: ["pulso:admin"] }, "pulso:write")).toBe(true);
  });
});
