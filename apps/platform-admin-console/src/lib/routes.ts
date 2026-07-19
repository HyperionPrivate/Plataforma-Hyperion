const ADMIN_ROUTES = new Set(["/", "/operators", "/tenants", "/grants", "/catalog"]);

export function isPlatformAdminRoute(pathname: string): boolean {
  return ADMIN_ROUTES.has(pathname.replace(/\/$/, "") || "/");
}
