import { afterEach, describe, expect, it, vi } from "vitest";
import { api, resolvePlatformAdminApiBaseUrl } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("platform admin BFF request policy", () => {
  it("accepts only same-origin BFF paths", () => {
    expect(resolvePlatformAdminApiBaseUrl()).toBe("/api");
    expect(resolvePlatformAdminApiBaseUrl("/platform-api/")).toBe("/platform-api");
    expect(() => resolvePlatformAdminApiBaseUrl("//example.test/api")).toThrow(/same-origin/);
    expect(() => resolvePlatformAdminApiBaseUrl("https://example.test/api")).toThrow(/same-origin/);
  });

  it("uses the exact console header and an HttpOnly cookie session for login", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", request);

    await api.post("/v1/auth/login", { email: "admin@example.test", password: "secret" }, { csrf: false });

    const init = request.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("include");
    expect(headers.get("x-requested-with")).toBe("platform-admin-console");
    expect(headers.get("authorization")).toBeNull();
  });

  it.each([
    ["PUT", () => api.put("/v1/platform/grants/operator/tenant/NOVA", { active: true })],
    ["DELETE", () => api.delete("/v1/platform/grants/operator/tenant/NOVA")]
  ])("attaches the double-submit CSRF token to %s mutations", async (method, invoke) => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("document", { cookie: "__Host-hyperion-platform-admin-csrf=csrf-token" });

    await invoke();

    const init = request.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.method).toBe(method);
    expect(headers.get("x-csrf-token")).toBe("csrf-token");
    expect(headers.get("x-requested-with")).toBe("platform-admin-console");
  });
});
