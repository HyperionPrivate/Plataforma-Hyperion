import { z } from "zod";

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const productCatalogItemSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    productId: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    name: z.string().min(1),
    cell: z.string().regex(/^[a-z][a-z0-9-]*$/),
    kind: z.enum(["neutral-control-plane", "product"]),
    spec: z.string().min(1),
    requirementPrefix: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    owner: z.string().min(1),
    status: z.enum(["active", "transitioning", "retiring", "planned", "accepted"]),
    issue: z.string().regex(/^HYP-[A-Z]+-\d{3}$/),
    dueDate: isoDateSchema
  })
  .strict();

export const productCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogVersion: semverSchema,
    updatedAt: isoDateSchema,
    items: z.array(productCatalogItemSchema).min(1)
  })
  .strict()
  .superRefine((catalog, context) => {
    for (const [field, values] of [
      ["id", catalog.items.map((item) => item.id)],
      ["productId", catalog.items.map((item) => item.productId)],
      ["cell", catalog.items.map((item) => item.cell)]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} values must be unique` });
      }
    }
    for (const [index, item] of catalog.items.entries()) {
      if (item.kind === "product" && !item.requirementPrefix) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "product entries require requirementPrefix",
          path: ["items", index, "requirementPrefix"]
        });
      }
      if (item.kind === "neutral-control-plane" && item.requirementPrefix) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "neutral control-plane entries cannot declare requirementPrefix",
          path: ["items", index, "requirementPrefix"]
        });
      }
    }
  });

export const PLATFORM_PRODUCT_CATALOG_VERSION = "1.1.0" as const;

/**
 * Versioned, platform-owned runtime catalog. Product applications may link to
 * their own origins, but the platform administration plane never embeds their
 * routes or domain workflows.
 */
export const platformProductCatalogV1 = productCatalogSchema.parse({
  schemaVersion: 1,
  catalogVersion: PLATFORM_PRODUCT_CATALOG_VERSION,
  updatedAt: "2026-07-17",
  items: [
    {
      id: "platform",
      productId: "PLATFORM",
      name: "Hyperion Platform",
      cell: "platform",
      kind: "neutral-control-plane",
      spec: "docs/architecture/decisions/ADR-0006-federated-product-cells.md",
      owner: "platform-core",
      status: "transitioning",
      issue: "HYP-FED-001",
      dueDate: "2026-10-31"
    },
    {
      id: "nova",
      productId: "NOVA",
      name: "NOVA",
      cell: "nova",
      kind: "product",
      spec: "docs/products/NOVA.md",
      requirementPrefix: "NOV",
      owner: "nova-product",
      status: "transitioning",
      issue: "HYP-NOVA-001",
      dueDate: "2026-09-30"
    },
    {
      id: "lumen",
      productId: "LUMEN",
      name: "LUMEN",
      cell: "lumen",
      kind: "product",
      spec: "docs/products/LUMEN.md",
      requirementPrefix: "LUM",
      owner: "lumen-product",
      status: "transitioning",
      issue: "HYP-LUM-001",
      dueDate: "2026-12-31"
    },
    {
      id: "pulso-iris",
      productId: "PULSO_IRIS",
      name: "PULSO IRIS",
      cell: "pulso",
      kind: "product",
      spec: "docs/products/PULSO-IRIS.md",
      requirementPrefix: "PUL",
      owner: "pulso-product",
      status: "transitioning",
      issue: "HYP-PUL-001",
      dueDate: "2027-03-31"
    }
  ]
});

export type ProductCatalogItem = z.infer<typeof productCatalogItemSchema>;
export type ProductCatalog = z.infer<typeof productCatalogSchema>;
