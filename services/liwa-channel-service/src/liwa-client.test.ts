import { describe, expect, it, vi } from "vitest";
import {
  assertLiwaBaseUrlAllowed,
  createLiwaClient,
  DEFAULT_LIWA_BASE_URL,
  HttpLiwaClient,
  UnconfiguredLiwaClient
} from "./liwa-client.js";

describe("assertLiwaBaseUrlAllowed", () => {
  const env = {
    LIWA_BASE_URL: "https://chat.liwa.co/api",
    HYPERION_DEPLOYMENT_ENVIRONMENT: "development"
  } as NodeJS.ProcessEnv;

  it("allows the configured LIWA host", () => {
    expect(() => assertLiwaBaseUrlAllowed("https://chat.liwa.co/api/accounts/tags", env)).not.toThrow();
  });

  it("rejects a different host (SSRF guard)", () => {
    expect(() => assertLiwaBaseUrlAllowed("https://evil.example/api", env)).toThrow(/host is not allowed/i);
  });
});

describe("createLiwaClient", () => {
  it("defaults base URL to /api and returns Unconfigured without token", () => {
    const client = createLiwaClient({
      HYPERION_DEPLOYMENT_ENVIRONMENT: "development"
    } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(UnconfiguredLiwaClient);
    expect(DEFAULT_LIWA_BASE_URL).toBe("https://chat.liwa.co/api");
  });
});

describe("HttpLiwaClient", () => {
  const env = {
    LIWA_BASE_URL: "https://chat.liwa.co/api",
    HYPERION_DEPLOYMENT_ENVIRONMENT: "development",
    LIWA_FORCE_TEXT: "1"
  } as NodeJS.ProcessEnv;

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return handler(url, init);
    }) as unknown as typeof fetch;
  }

  it("sends X-ACCESS-TOKEN and uses /accounts/tags", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe("https://chat.liwa.co/api/accounts/tags");
      expect(new Headers(init?.headers).get("X-ACCESS-TOKEN")).toBe("token-test");
      return new Response(JSON.stringify([{ id: "964001", name: "AG_BARRANCABERMEJA" }]), { status: 200 });
    });

    const client = new HttpLiwaClient("https://chat.liwa.co/api", "token-test", env, fetchImpl);
    const tags = await client.listTags();
    expect(tags).toEqual([{ id: "964001", name: "AG_BARRANCABERMEJA" }]);
  });

  it("applies tags via POST /contacts/{id}/tags/{tag_id}", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe("https://chat.liwa.co/api/contacts/c1/tags/t9");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      return new Response("{}", { status: 200 });
    });

    const client = new HttpLiwaClient("https://chat.liwa.co/api", "token-test", env, fetchImpl);
    await client.applyTag("c1", "t9");
  });

  it("handoffToAgency ensures and applies agency tag (no /handoff endpoint)", async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/accounts/tags") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([{ id: "562888", name: "AG_BUCARAMANGA" }]), { status: 200 });
      }
      if (url.includes("/contacts/contact-1/tags/562888")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });

    const client = new HttpLiwaClient("https://chat.liwa.co/api", "token-test", env, fetchImpl);
    await client.handoffToAgency("contact-1", "AG_BUCARAMANGA");

    expect(calls.some((c) => c.includes("/handoff"))).toBe(false);
    expect(calls).toContain("GET https://chat.liwa.co/api/accounts/tags");
    expect(calls).toContain("POST https://chat.liwa.co/api/contacts/contact-1/tags/562888");
  });

  it("lists flows and account me", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/accounts/me")) {
        return new Response(
          JSON.stringify({ page_id: "1656233", name: "Coopfuturo 2026 Cta Comercial", active: true }),
          { status: 200 }
        );
      }
      if (url.endsWith("/accounts/flows")) {
        return new Response(JSON.stringify([{ id: "1782399915832", name: "Renovaciones" }]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    const client = new HttpLiwaClient("https://chat.liwa.co/api", "token-test", env, fetchImpl);
    await expect(client.getAccountMe()).resolves.toMatchObject({
      pageId: "1656233",
      name: "Coopfuturo 2026 Cta Comercial"
    });
    await expect(client.listFlows()).resolves.toEqual([{ id: "1782399915832", name: "Renovaciones" }]);
  });
});
