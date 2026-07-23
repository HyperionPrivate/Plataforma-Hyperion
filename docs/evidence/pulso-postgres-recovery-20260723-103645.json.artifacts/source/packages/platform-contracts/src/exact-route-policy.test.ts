import { describe, expect, it } from "vitest";
import { matchExactRoutePolicy } from "./exact-route-policy.js";

describe("matchExactRoutePolicy", () => {
  const policy = {
    method: "GET",
    path: "/v1/tenants/:tenantId/pulso-iris/config/export/:resource",
    resources: ["professionals"]
  } as const;

  it("matches only the exact method, segment count and static namespace", () => {
    expect(
      matchExactRoutePolicy(
        policy,
        "GET",
        "/v1/tenants/7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c/pulso-iris/config/export/professionals"
      )
    ).toMatchObject({
      tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
      resource: "professionals"
    });
    expect(matchExactRoutePolicy(policy, "POST", policy.path)).toBeUndefined();
    expect(
      matchExactRoutePolicy(
        policy,
        "GET",
        "/v1/tenants/7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c/nova/config/export/professionals"
      )
    ).toBeUndefined();
  });

  it("fails closed for resources outside the provider allowlist and wildcard templates", () => {
    expect(
      matchExactRoutePolicy(
        policy,
        "GET",
        "/v1/tenants/7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c/pulso-iris/config/export/secrets"
      )
    ).toBeUndefined();
    expect(matchExactRoutePolicy({ method: "GET", path: "/v1/*" }, "GET", "/v1/admin")).toBeUndefined();
  });
});
