import { describe, expect, it } from "vitest";
import { resolveLegacyRedirect } from "./redirects.js";

const targets = { nova: "https://nova.example", lumen: "https://lumen.example", pulso: "https://pulso.example" };
const encounterId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

describe("legacy console redirects (DEBT-023 retired)", () => {
  it("never redirects product or deep-link paths", () => {
    expect(resolveLegacyRedirect("/nova", "", targets)).toBeUndefined();
    expect(resolveLegacyRedirect("/lumen/historia", `?encounter=${encounterId}`, targets)).toBeUndefined();
    expect(resolveLegacyRedirect("/conversaciones", `?conversationId=${conversationId}`, targets)).toBeUndefined();
    expect(resolveLegacyRedirect("/configuracion", "", targets)).toBeUndefined();
    expect(resolveLegacyRedirect("/unknown", "", targets)).toBeUndefined();
  });
});
