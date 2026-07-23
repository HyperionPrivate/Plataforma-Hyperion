import { describe, expect, it, vi } from "vitest";
import { isAccessTokenJtiRevoked, revokeAccessTokenJti } from "./access-token-denylist.js";

const JTI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("Access JWT denylist", () => {
  it("reports a jti as revoked when a non-expired denylist row exists", async () => {
    const query = vi.fn(async () => ({ rows: [{ jti: JTI }] }));
    await expect(isAccessTokenJtiRevoked({ query } as never, JTI)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("access_token_denylist"), [JTI]);
  });

  it("reports a jti as active when no denylist row matches", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(isAccessTokenJtiRevoked({ query } as never, JTI)).resolves.toBe(false);
  });

  it("inserts a denylist row with the token expiry", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const expiresAt = new Date("2026-07-23T16:30:00.000Z");
    await revokeAccessTokenJti({ query } as never, JTI, expiresAt);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into platform.access_token_denylist"), [
      JTI,
      expiresAt.toISOString()
    ]);
  });
});
