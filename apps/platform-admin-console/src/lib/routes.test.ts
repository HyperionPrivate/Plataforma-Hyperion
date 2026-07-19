import { describe, expect, it } from "vitest";
import { isPlatformAdminRoute } from "./routes.js";

describe("platform admin router boundary", () => {
  it("accepts neutral administration routes", () => {
    expect(isPlatformAdminRoute("/operators")).toBe(true);
    expect(isPlatformAdminRoute("/catalog/")).toBe(true);
  });
  it("rejects every product route", () => {
    expect(isPlatformAdminRoute("/nova")).toBe(false);
    expect(isPlatformAdminRoute("/lumen")).toBe(false);
    expect(isPlatformAdminRoute("/operacion")).toBe(false);
  });
});
