import { describe, expect, it } from "vitest";
import { platformCatalogSchema, productModules, serviceCatalog } from "./index.js";

describe("platform contracts", () => {
  it("keeps the service and product catalog valid", () => {
    expect(() => platformCatalogSchema.parse({
      services: serviceCatalog,
      productModules
    })).not.toThrow();
  });
});
