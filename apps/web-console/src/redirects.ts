export interface ConsoleTargets {
  nova: string;
  lumen: string;
  pulso: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LUMEN_ROUTES = new Set([
  "/lumen",
  "/lumen/preconsulta",
  "/lumen/dictado",
  "/lumen/historia",
  "/lumen/laboratorios",
  "/lumen/asistente",
  "/lumen/modelos",
  "/lumen/consentimientos",
  "/lumen/facturacion",
  "/lumen/dashboard"
]);

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

function sanitizedUuidQuery(search: string, allowedName?: string): string {
  if (!allowedName) return "";
  const input = new URLSearchParams(search);
  const values = input.getAll(allowedName);
  if (values.length !== 1 || !UUID_PATTERN.test(values[0] ?? "")) return "";
  return new URLSearchParams({ [allowedName]: values[0] }).toString();
}

function appendLocation(base: string, path: string, query: string): string | undefined {
  try {
    const target = new URL(base);
    if (
      (target.protocol !== "https:" && target.protocol !== "http:") ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    ) {
      return undefined;
    }
    const prefix = target.pathname.replace(/\/$/, "");
    target.pathname = `${prefix}${path.startsWith("/") ? path : `/${path}`}` || "/";
    target.search = query;
    target.hash = "";
    return target.toString();
  } catch {
    return undefined;
  }
}

export function resolveLegacyRedirect(pathname: string, search: string, targets: ConsoleTargets): string | undefined {
  if (pathname === "/nova" || pathname === "/nova/") {
    return appendLocation(targets.nova, "/", "");
  }
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (LUMEN_ROUTES.has(normalized)) {
    return appendLocation(targets.lumen, normalized, sanitizedUuidQuery(search, "encounter"));
  }
  if (PULSO_ROUTES.has(normalized)) {
    const query = normalized === "/conversaciones" ? sanitizedUuidQuery(search, "conversationId") : "";
    return appendLocation(targets.pulso, normalized, query);
  }
  return undefined;
}
