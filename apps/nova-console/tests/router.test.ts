import { describe, expect, it } from "vitest";
import { novaPath, voicePath } from "../src/lib/context.js";
import { resolveNovaRoute } from "../src/lib/router.js";

describe("NOVA router boundary", () => {
  it("publishes only the product root", () => {
    expect(resolveNovaRoute("/")).toBe("console");
    expect(resolveNovaRoute("/nova")).toBe("not-found");
    expect(resolveNovaRoute("/unknown")).toBe("not-found");
  });

  it("builds only NOVA-cell API paths and encodes identifiers", () => {
    expect(novaPath("tenant/id", "campaigns/campaign id/start")).toBe(
      "/v1/tenants/tenant%2Fid/nova/campaigns/campaign%20id/start"
    );
    expect(voicePath("tenant/id", "calls")).toBe("/v1/tenants/tenant%2Fid/voice/calls");
  });
});
