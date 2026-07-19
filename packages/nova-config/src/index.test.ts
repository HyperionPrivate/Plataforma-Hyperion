import { describe, expect, it } from "vitest";
import { NOVA_SECRET_KEYS, assertNoNovaPlaceholderSecrets, readNovaServiceConfig, readServiceUrls } from "./index.js";

describe("NOVA-owned configuration", () => {
  it("contains only NOVA and platform Audit upstreams", () => {
    expect(Object.keys(readServiceUrls({}))).toEqual(["audit", "novaCore", "voiceChannel", "liwaChannel", "documents"]);
  });

  it("uses the independent runtime ports", () => {
    expect(readNovaServiceConfig("documents-service", {}).port).toBe(8094);
  });

  it("rejects NOVA placeholders in restricted environments", () => {
    expect(() =>
      assertNoNovaPlaceholderSecrets({
        HYPERION_ENVIRONMENT: "production",
        NOVA_TO_AUDIT_TOKEN: "replace-audit-edge"
      })
    ).toThrow(/NOVA_TO_AUDIT_TOKEN/);
    expect(() =>
      assertNoNovaPlaceholderSecrets({
        HYPERION_ENVIRONMENT: "staging",
        DATABASE_URL: "postgresql://hyperion_nova:replace-database-secret@postgres/hyperion_nova"
      })
    ).toThrow(/DATABASE_URL/);
  });

  it("covers every secret consumed by NOVA services and migrators", () => {
    expect(NOVA_SECRET_KEYS).toEqual(
      expect.arrayContaining([
        "NOVA_MIGRATOR_DATABASE_PASSWORD",
        "NOVA_TO_DOCUMENTS_TOKEN",
        "VOICE_TO_AUDIT_TOKEN",
        "LIWA_TO_AUDIT_TOKEN",
        "DOCUMENTS_TO_AUDIT_TOKEN",
        "VOICE_TO_DIALER_TOKEN",
        "LIWA_WEBHOOK_SECRET",
        "DIALER_WEBHOOK_HMAC_SECRET",
        "DOCUMENTS_S3_SECRET_KEY"
      ])
    );
  });
});
