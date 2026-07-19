import { describe, expect, it } from "vitest";
import { resolveLegacyRedirect } from "./redirects.js";

const targets = { nova: "https://nova.example", lumen: "https://lumen.example", pulso: "https://pulso.example" };
const encounterId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

describe("legacy console redirects", () => {
  it("preserves only the allowlisted LUMEN encounter parameter", () =>
    expect(
      resolveLegacyRedirect(
        "/lumen/historia",
        `?access_token=forbidden&encounter=${encounterId}&password=secret`,
        targets
      )
    ).toBe(`https://lumen.example/lumen/historia?encounter=${encounterId}`));

  it("preserves a PULSO conversation deep link only on its owned route", () => {
    expect(resolveLegacyRedirect("/conversaciones", `?conversationId=${conversationId}&token=secret`, targets)).toBe(
      `https://pulso.example/conversaciones?conversationId=${conversationId}`
    );
    expect(resolveLegacyRedirect("/agenda", `?conversationId=${conversationId}`, targets)).toBe(
      "https://pulso.example/agenda"
    );
  });

  it("removes every query from the NOVA compatibility route", () =>
    expect(resolveLegacyRedirect("/nova", "?campaign=1&code=secret", targets)).toBe("https://nova.example/"));

  it("drops duplicate, malformed, and unlisted parameters", () => {
    expect(
      resolveLegacyRedirect("/lumen/historia", `?encounter=${encounterId}&encounter=${conversationId}`, targets)
    ).toBe("https://lumen.example/lumen/historia");
    expect(resolveLegacyRedirect("/lumen/historia", "?encounter=not-a-uuid", targets)).toBe(
      "https://lumen.example/lumen/historia"
    );
    expect(resolveLegacyRedirect("/configuracion", "?id_token=secret", targets)).toBe(
      "https://pulso.example/configuracion"
    );
  });

  it("never accepts or propagates a fragment", () => {
    const target = resolveLegacyRedirect(
      "/lumen/historia#access_token=forbidden",
      `?encounter=${encounterId}`,
      targets
    );
    expect(target).toBeUndefined();
    expect(resolveLegacyRedirect("/nova", "", targets)).not.toContain("#");
  });

  it("returns no redirect for prefixed unknown or foreign routes", () => {
    expect(resolveLegacyRedirect("/nova/admin", "", targets)).toBeUndefined();
    expect(resolveLegacyRedirect("/lumen/not-real", "", targets)).toBeUndefined();
    expect(resolveLegacyRedirect("/unknown", "", targets)).toBeUndefined();
  });

  it("fails closed for unsafe or malformed target configuration", () => {
    expect(
      resolveLegacyRedirect("/nova", "", { ...targets, nova: "https://user:password@nova.example" })
    ).toBeUndefined();
    expect(resolveLegacyRedirect("/nova", "", { ...targets, nova: "not a URL" })).toBeUndefined();
  });
});
