import { describe, expect, it } from "vitest";
import { PLATFORM_PRODUCT_CATALOG_VERSION, platformProductCatalogV1, productCatalogSchema } from "./product-catalog.js";

describe("platform-owned product catalog", () => {
  it("publishes a schema-versioned SemVer catalog with unique product identities", () => {
    const catalog = productCatalogSchema.parse(platformProductCatalogV1);

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.catalogVersion).toBe(PLATFORM_PRODUCT_CATALOG_VERSION);
    expect(catalog.items.map((item) => item.productId)).toEqual(["PLATFORM", "NOVA", "LUMEN", "PULSO_IRIS"]);
    expect(new Set(catalog.items.map((item) => item.cell)).size).toBe(catalog.items.length);
  });

  it("rejects an unversioned or ambiguous catalog", () => {
    expect(() => productCatalogSchema.parse({ items: platformProductCatalogV1.items })).toThrow();
    expect(() =>
      productCatalogSchema.parse({
        ...platformProductCatalogV1,
        items: [platformProductCatalogV1.items[0], platformProductCatalogV1.items[0]]
      })
    ).toThrow(/unique/);
  });
});
