/**
 * Build-time product scoping. A single codebase produces per-product consoles
 * (NOVA, PULSO, LUMEN) or the full shared console, selected at build time with
 * VITE_PRODUCT. This keeps each delivered console focused on one product while
 * the backends stay independent.
 */
export type ActiveProduct = "all" | "nova" | "pulso" | "lumen";

/** Scope tag for a nav item or route. "core" pages belong to the shell itself. */
export type ProductScope = "core" | "nova" | "pulso" | "lumen";

function readActiveProduct(): ActiveProduct {
  const raw = String(import.meta.env.VITE_PRODUCT ?? "all").toLowerCase();
  return raw === "nova" || raw === "pulso" || raw === "lumen" ? raw : "all";
}

/** Product this build is scoped to. "all" keeps the full shared console. */
export const activeProduct: ActiveProduct = readActiveProduct();

/** Sidebar brand label; per-product builds override it (e.g. "NOVA"). */
export const brandLabel: string = String(import.meta.env.VITE_BRAND_LABEL ?? "HYPERION");

/** Whether content tagged for `scope` should be present in the current build. */
export function productEnabled(scope: ProductScope): boolean {
  if (scope === "core") return true;
  if (activeProduct === "all") return true;
  return scope === activeProduct;
}

/** Landing route for the current build. */
export function defaultRoute(): string {
  switch (activeProduct) {
    case "nova":
      return "/nova";
    case "lumen":
      return "/lumen";
    default:
      return "/operacion";
  }
}
