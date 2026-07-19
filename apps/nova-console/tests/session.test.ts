import { describe, expect, it } from "vitest";
import {
  authorizedNovaTenantIds,
  findNovaGrant,
  novaGrantAllows,
  parseAccessPrincipal,
  primaryNovaRole,
  type AccessPrincipal
} from "../src/lib/session.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

function principal(): AccessPrincipal {
  return {
    operator: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "operador@example.test",
      displayName: "Operador NOVA",
      role: "advisor"
    },
    grants: [
      {
        tenantId: TENANT_A,
        productId: "NOVA",
        roles: ["asesor"],
        capabilities: ["nova:read"],
        active: true
      },
      {
        tenantId: TENANT_B,
        productId: "NOVA",
        roles: ["supervisor"],
        capabilities: ["nova:read", "nova:write"],
        active: true
      }
    ]
  };
}

describe("NOVA grants", () => {
  it("derives tenant access exclusively from active product grants", () => {
    const session = principal();
    expect(authorizedNovaTenantIds(session)).toEqual([TENANT_A, TENANT_B]);
    expect(findNovaGrant(session, TENANT_A)?.roles).toEqual(["asesor"]);
  });

  it("requires the requested capability and does not inherit writes from the platform role", () => {
    const session = principal();
    const readOnly = findNovaGrant(session, TENANT_A);
    const writer = findNovaGrant(session, TENANT_B);

    expect(novaGrantAllows(readOnly, "nova:read")).toBe(true);
    expect(novaGrantAllows(readOnly, "nova:write")).toBe(false);
    expect(novaGrantAllows(writer, "nova:write")).toBe(true);
    expect(primaryNovaRole(writer!)).toBe("supervisor");
  });

  it("rejects inactive, foreign and structurally invalid grants", () => {
    const session = principal();
    session.grants[0]!.active = false;
    session.grants[1]!.productId = "OTHER";

    expect(authorizedNovaTenantIds(session)).toEqual([]);
    expect(findNovaGrant(session, TENANT_A)).toBeUndefined();
    expect(() => parseAccessPrincipal({ operator: session.operator, tenantIds: [TENANT_A] })).toThrow(/principal/i);
  });

  it("accepts a BFF response that wraps the principal", () => {
    expect(parseAccessPrincipal({ principal: principal() })).toEqual(principal());
  });
});
