import { platformControlTenantId } from "@hyperion/platform-contracts/platform-control";
import { describe, expect, it } from "vitest";
import {
  isProtectedControlGrant,
  parseUniqueValues,
  platformGrantPath,
  wouldDowngradeOwnControlGrant
} from "./admin-model.js";

describe("neutral administration mutations", () => {
  it("normalizes explicit roles and capabilities without inventing presets", () => {
    expect(parseUniqueValues(" nova:read, nova:admin, nova:read ")).toEqual(["nova:read", "nova:admin"]);
  });

  it("encodes every grant path segment", () => {
    expect(platformGrantPath({ operatorId: "operator/1", tenantId: "tenant 1", productId: "NOVA" })).toBe(
      "/v1/platform/grants/operator%2F1/tenant%201/NOVA"
    );
  });

  it("protects the current administrator's own control-plane grant from UI revocation", () => {
    const grant = { operatorId: "operator-1", tenantId: platformControlTenantId, productId: "PLATFORM" };
    expect(isProtectedControlGrant("operator-1", grant)).toBe(true);
    expect(isProtectedControlGrant("operator-2", grant)).toBe(false);
  });

  it("rejects a UI overwrite that would remove recovery authority from the current administrator", () => {
    const grant = { operatorId: "operator-1", tenantId: platformControlTenantId, productId: "PLATFORM" };
    expect(wouldDowngradeOwnControlGrant("operator-1", grant, ["viewer"], ["view:platform"])).toBe(true);
    expect(
      wouldDowngradeOwnControlGrant("operator-1", grant, ["platform-admin"], ["manage:platform", "view:platform"])
    ).toBe(false);
  });
});
