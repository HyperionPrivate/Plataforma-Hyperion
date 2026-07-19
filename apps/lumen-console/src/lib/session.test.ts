import { describe, expect, it } from "vitest";
import type { LumenSession } from "./session.js";
import { hasLumenCapability, viewGrantFor } from "./session.js";

const baseSession: LumenSession = {
  operator: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "clinico@example.test",
    displayName: "Profesional clínico",
    role: "advisor"
  },
  csrfToken: "csrf-test-token",
  tenants: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      displayName: "Clínica demo"
    }
  ],
  grants: []
};

describe("LUMEN product grants", () => {
  it("rejects a session without the LUMEN view capability", () => {
    expect(viewGrantFor(baseSession)).toBeUndefined();
  });

  it("selects the tenant-scoped LUMEN grant and keeps write explicit", () => {
    const session: LumenSession = {
      ...baseSession,
      grants: [
        {
          tenantId: baseSession.tenants[0]!.id,
          productId: "LUMEN",
          roles: ["advisor"],
          capabilities: ["lumen:read"],
          active: true
        }
      ]
    };
    const grant = viewGrantFor(session);
    expect(grant?.tenantId).toBe(baseSession.tenants[0]!.id);
    expect(grant && hasLumenCapability(grant, "lumen:read")).toBe(true);
    expect(grant && hasLumenCapability(grant, "lumen:write")).toBe(false);
  });
});
