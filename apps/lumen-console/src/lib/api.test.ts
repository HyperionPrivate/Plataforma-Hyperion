import { afterEach, describe, expect, it, vi } from "vitest";
import { api, resolveLumenApiBaseUrl } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("LUMEN BFF request policy", () => {
  it("accepts only same-origin BFF paths", () => {
    expect(resolveLumenApiBaseUrl()).toBe("/api");
    expect(resolveLumenApiBaseUrl("/lumen-api/")).toBe("/lumen-api");
    expect(() => resolveLumenApiBaseUrl("//example.test/api")).toThrow(/same-origin/);
    expect(() => resolveLumenApiBaseUrl("https://example.test/api")).toThrow(/same-origin/);
  });

  it("uses the exact console header and an HttpOnly cookie session for mutations", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", request);

    await api.post("/v1/auth/login", { email: "operator@example.test", password: "secret" });

    const init = request.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("include");
    expect(headers.get("x-requested-with")).toBe("lumen-console");
    expect(headers.get("authorization")).toBeNull();
  });
});
