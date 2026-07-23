import { afterEach, describe, expect, it, vi } from "vitest";
import { api, readCookieValue, resolveApiBaseUrl } from "../src/lib/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("NOVA BFF origin policy", () => {
  it("defaults to the same-origin BFF", () => {
    expect(resolveApiBaseUrl(undefined)).toBe("/api");
    expect(resolveApiBaseUrl("/nova-api/")).toBe("/nova-api");
  });

  it("rejects absolute and protocol-relative BFF origins", () => {
    expect(() => resolveApiBaseUrl("https://nova.example.test/")).toThrow(/same-origin/);
    expect(() => resolveApiBaseUrl("http://127.0.0.1:8080")).toThrow(/same-origin/);
    expect(() => resolveApiBaseUrl("//nova.example.test")).toThrow(/same-origin/);
  });

  it("sends mutations through the cookie session without a bearer", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("document", { cookie: "__Host-hyperion-nova-csrf=csrf-test-value" });

    await api.post("/v1/tenants/example/nova/action", { value: 1 });

    const init = request.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("include");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-requested-with")).toBe("nova-console");
    expect(headers.get("x-csrf-token")).toBe("csrf-test-value");
  });

  it("retains additive response metadata when a caller requests the envelope", async () => {
    const analyticsCoverage = {
      status: "complete_since_cutover",
      coverageFrom: "2026-07-23",
      appliedAt: "2026-07-22T19:00:00.000Z"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [], meta: { analyticsCoverage } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const response = await api.getEnvelope<unknown[]>("/v1/tenants/example/nova/analytics/daily");

    expect(response.data).toEqual([]);
    expect(response.meta?.analyticsCoverage).toEqual(analyticsCoverage);
  });

  it("retains machine-readable analytics coverage when the server fails closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              error: "Agency analytics are incomplete",
              code: "agency_analytics_history_partial",
              coverage: { status: "partial", coverageFrom: "2026-07-23", dataReturned: false }
            }
          }),
          { status: 409, headers: { "content-type": "application/json" } }
        )
      )
    );

    await expect(api.getEnvelope("/v1/tenants/example/nova/analytics/daily")).rejects.toMatchObject({
      status: 409,
      data: expect.objectContaining({
        code: "agency_analytics_history_partial",
        coverage: expect.objectContaining({ status: "partial", dataReturned: false })
      })
    });
  });

  it("parses the CSRF cookie defensively", () => {
    expect(readCookieValue("csrf", "a=1; csrf=token%20value; z=2")).toBe("token value");
    expect(readCookieValue("csrf", "csrf=one; csrf=two")).toBeUndefined();
    expect(readCookieValue("csrf", "csrf=%E0%A4%A")).toBeUndefined();
  });
});
