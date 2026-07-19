import { platformControlTenantId } from "@hyperion/platform-contracts/platform-control";
import { describe, expect, it } from "vitest";
import { canAdministerPlatform, type AdminSession } from "./session.js";
import { readCookieValue } from "./api.js";

const base: AdminSession = {
  operator: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "user@example.com",
    displayName: "User",
    role: "auditor"
  },
  tenantIds: [],
  grants: []
};

describe("platform administration grant", () => {
  it("rejects an operator without a platform capability", () => expect(canAdministerPlatform(base)).toBe(false));
  it("rejects a platform capability attached to a customer tenant", () =>
    expect(
      canAdministerPlatform({
        ...base,
        grants: [
          {
            tenantId: "00000000-0000-4000-8000-000000000002",
            productId: "PLATFORM",
            roles: ["platform-admin"],
            capabilities: ["manage:platform"],
            active: true
          }
        ]
      })
    ).toBe(false));

  it("requires the exact active platform-admin grant on the reserved control tenant", () =>
    expect(
      canAdministerPlatform({
        ...base,
        grants: [
          {
            tenantId: platformControlTenantId,
            productId: "PLATFORM",
            roles: ["platform-admin"],
            capabilities: ["manage:platform"],
            active: true
          }
        ]
      })
    ).toBe(true));

  it("does not treat the legacy global admin role as a platform grant", () =>
    expect(canAdministerPlatform({ ...base, operator: { ...base.operator, role: "admin" } })).toBe(false));
});

describe("platform admin CSRF cookie", () => {
  it("reads the public double-submit cookie", () =>
    expect(
      readCookieValue("__Host-hyperion-platform-admin-csrf", "other=1; __Host-hyperion-platform-admin-csrf=abc%20123")
    ).toBe("abc 123"));
  it("rejects ambiguous duplicate cookies", () =>
    expect(readCookieValue("csrf", "csrf=one; csrf=two")).toBeUndefined());
});
