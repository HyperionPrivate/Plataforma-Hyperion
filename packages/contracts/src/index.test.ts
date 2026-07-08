import { describe, expect, it } from "vitest";
import {
  platformCatalogSchema,
  productModules,
  pulsoIrisCatalog,
  pulsoIrisCatalogSchema,
  serviceCatalog
} from "./index.js";

describe("platform contracts", () => {
  it("keeps the service and product catalog valid", () => {
    expect(() => platformCatalogSchema.parse({
      services: serviceCatalog,
      productModules
    })).not.toThrow();
  });

  it("keeps the Pulso Iris catalog valid", () => {
    expect(() => pulsoIrisCatalogSchema.parse(pulsoIrisCatalog)).not.toThrow();
  });
});
