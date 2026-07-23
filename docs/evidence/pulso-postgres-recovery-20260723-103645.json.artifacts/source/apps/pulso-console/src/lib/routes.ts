const PULSO_ROUTES = new Set([
  "/",
  "/operacion",
  "/conversaciones",
  "/agenda",
  "/rpa",
  "/campanas",
  "/bi",
  "/configuracion"
]);

export function isPulsoRoute(pathname: string): boolean {
  return PULSO_ROUTES.has(pathname.replace(/\/$/, "") || "/");
}
