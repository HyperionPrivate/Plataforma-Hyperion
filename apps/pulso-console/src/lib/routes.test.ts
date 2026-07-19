import { describe, expect, it } from "vitest";
import { isPulsoRoute } from "./routes.js";

describe("PULSO router boundary", () => {
  it("accepts only product-owned routes", () => {
    expect(isPulsoRoute("/operacion")).toBe(true);
    expect(isPulsoRoute("/configuracion/")).toBe(true);
  });
  it("returns 404 eligibility for foreign routes before authentication", () => {
    expect(isPulsoRoute("/nova")).toBe(false);
    expect(isPulsoRoute("/lumen/historia")).toBe(false);
    expect(isPulsoRoute("/unknown")).toBe(false);
  });
});
