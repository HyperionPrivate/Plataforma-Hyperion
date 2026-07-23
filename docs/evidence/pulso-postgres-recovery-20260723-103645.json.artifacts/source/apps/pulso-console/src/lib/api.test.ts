import { afterEach, describe, expect, it, vi } from "vitest";
import { api, resolvePulsoApiBaseUrl } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("PULSO BFF request policy", () => {
  it("accepts only same-origin BFF paths", () => {
    expect(resolvePulsoApiBaseUrl()).toBe("/api");
    expect(resolvePulsoApiBaseUrl("/pulso-api/")).toBe("/pulso-api");
    expect(() => resolvePulsoApiBaseUrl("//example.test/api")).toThrow(/same-origin/);
    expect(() => resolvePulsoApiBaseUrl("https://example.test/api")).toThrow(/same-origin/);
  });

  it("uses the exact console header and an HttpOnly cookie session for mutations", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", request);

    await api.post("/v1/auth/login", { email: "operator@example.test", password: "secret" }, { csrf: false });

    const init = request.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("include");
    expect(headers.get("x-requested-with")).toBe("pulso-console");
    expect(headers.get("authorization")).toBeNull();
  });
});
