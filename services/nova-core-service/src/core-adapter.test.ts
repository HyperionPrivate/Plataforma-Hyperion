import { describe, expect, it, vi } from "vitest";
import { ContractTestAdapter, HttpCoreAdapter, UnconfiguredCoreAdapter, createCoreAdapter } from "./core-adapter.js";

describe("createCoreAdapter", () => {
  it("does not silently use contract data by default", () => {
    expect(createCoreAdapter({})).toBeInstanceOf(UnconfiguredCoreAdapter);
  });

  it("allows the contract adapter only when explicitly selected outside restricted environments", () => {
    expect(createCoreAdapter({ CORE_MODE: "contract", HYPERION_ENVIRONMENT: "local" })).toBeInstanceOf(
      ContractTestAdapter
    );
  });

  it("requires live Core configuration in production", () => {
    expect(() => createCoreAdapter({ CORE_MODE: "contract", HYPERION_ENVIRONMENT: "production" })).toThrow(/forbidden/);
    expect(() => createCoreAdapter({ HYPERION_ENVIRONMENT: "production" })).toThrow(/CORE_MODE=live/);
    expect(
      createCoreAdapter({
        CORE_MODE: "live",
        CORE_BASE_URL: "https://core.example",
        CORE_API_TOKEN: "core-api-token",
        HYPERION_ENVIRONMENT: "production"
      })
    ).toBeInstanceOf(HttpCoreAdapter);
    expect(() =>
      createCoreAdapter({
        CORE_MODE: "live",
        CORE_BASE_URL: "http://core.example",
        CORE_API_TOKEN: "core-api-token",
        HYPERION_ENVIRONMENT: "production"
      })
    ).toThrow(/HTTPS/);
    expect(() =>
      createCoreAdapter({
        CORE_MODE: "live",
        CORE_BASE_URL: "https://core.example",
        HYPERION_ENVIRONMENT: "production"
      })
    ).toThrow(/CORE_API_TOKEN/);
  });

  it("authenticates live Core requests and disables redirects", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          document_id: "doc-1",
          associate_id: "associate-1",
          full_name: "Test Associate",
          status: "active"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const adapter = new HttpCoreAdapter("https://core.example", "secret-token", request);

    await adapter.lookupAssociate("doc-1");

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer secret-token" })
    });
  });
});
