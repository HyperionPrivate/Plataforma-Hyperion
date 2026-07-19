import { describe, expect, it } from "vitest";
import { isValidLiwaWebhookSecret } from "./webhook-auth.js";

describe("LIWA webhook authentication", () => {
  const secret = "liwa-webhook-secret-at-least-32-chars";

  it("accepts only the configured header secret", () => {
    expect(isValidLiwaWebhookSecret(secret, secret)).toBe(true);
    expect(isValidLiwaWebhookSecret("wrong-webhook-secret-at-least-32x", secret)).toBe(false);
  });

  it("fails closed when the header or server configuration is missing", () => {
    expect(isValidLiwaWebhookSecret(undefined, secret)).toBe(false);
    expect(isValidLiwaWebhookSecret(secret, undefined)).toBe(false);
    expect(isValidLiwaWebhookSecret("", secret)).toBe(false);
  });

  it("does not accept query-shaped or non-string credentials", () => {
    expect(isValidLiwaWebhookSecret({ secret }, secret)).toBe(false);
    expect(isValidLiwaWebhookSecret([secret], secret)).toBe(false);
  });
});
