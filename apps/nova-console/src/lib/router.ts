export type NovaRoute = "console" | "not-found";
export const NOVA_CONSOLE_PATH = "/";

export function resolveNovaRoute(pathname: string): NovaRoute {
  return pathname === NOVA_CONSOLE_PATH ? "console" : "not-found";
}
