export type LumenViewId = "preconsulta" | "dictado" | "historia";
export type LumenPath = "/lumen/preconsulta" | "/lumen/dictado" | "/lumen/historia";
export type LumenIconId = "clipboard-pulse" | "mic" | "file-check-2";

export interface LumenViewDefinition {
  id: LumenViewId;
  path: LumenPath;
  label: string;
  icon: LumenIconId;
}

export interface LumenLocationLike {
  pathname: string;
  search?: string;
}

export interface LumenLocationState {
  viewId: LumenViewId;
  view: LumenViewDefinition;
  pathname: LumenPath;
  href: string;
  encounterId?: string;
  redirected: boolean;
}

export const LUMEN_VIEWS = [
  {
    id: "preconsulta",
    path: "/lumen/preconsulta",
    label: "Resumen preconsulta",
    icon: "clipboard-pulse"
  },
  { id: "dictado", path: "/lumen/dictado", label: "Dictado clínico", icon: "mic" },
  { id: "historia", path: "/lumen/historia", label: "Historia clínica", icon: "file-check-2" }
] as const satisfies readonly LumenViewDefinition[];

const DEFAULT_PATH: LumenPath = "/lumen/preconsulta";

function cleanPathname(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/, 1)[0] || "/";
  if (withoutQuery === "/") return withoutQuery;
  return withoutQuery.replace(/\/+$/, "");
}

function readLocation(location: string | LumenLocationLike): Required<LumenLocationLike> {
  if (typeof location !== "string") {
    return {
      pathname: location.pathname,
      search: location.search ? (location.search.startsWith("?") ? location.search : `?${location.search}`) : ""
    };
  }

  const parsed = new URL(location, "https://lumen.local");
  return { pathname: parsed.pathname, search: parsed.search };
}

function encounterFrom(location: string | LumenLocationLike | undefined): string | undefined {
  if (!location) return undefined;
  const encounterId = new URLSearchParams(readLocation(location).search).get("encounter")?.trim();
  return encounterId || undefined;
}

function viewForPath(pathname: LumenPath): LumenViewDefinition {
  return LUMEN_VIEWS.find((view) => view.path === pathname) ?? LUMEN_VIEWS[0];
}

function hrefFor(pathname: LumenPath, encounterId: string | undefined): string {
  if (!encounterId) return pathname;
  const params = new URLSearchParams({ encounter: encounterId });
  return `${pathname}?${params.toString()}`;
}

export function normalizeLumenPath(pathname: string): LumenPath | null {
  const cleaned = cleanPathname(pathname);
  if (cleaned === "/lumen") return DEFAULT_PATH;
  const view = LUMEN_VIEWS.find((candidate) => candidate.path === cleaned);
  return view?.path ?? null;
}

export function normalizeLumenHref(location: string | LumenLocationLike): string | null {
  const current = readLocation(location);
  const pathname = normalizeLumenPath(current.pathname);
  if (!pathname) return null;
  return hrefFor(pathname, encounterFrom(current));
}

export function resolveLumenLocation(location: string | LumenLocationLike): LumenLocationState | null {
  const current = readLocation(location);
  const pathname = normalizeLumenPath(current.pathname);
  if (!pathname) return null;
  const encounterId = encounterFrom(current);
  const href = hrefFor(pathname, encounterId);
  const normalizedCurrentPath = cleanPathname(current.pathname);

  return {
    viewId: viewForPath(pathname).id,
    view: viewForPath(pathname),
    pathname,
    href,
    encounterId,
    redirected: normalizedCurrentPath !== pathname || current.search !== href.slice(pathname.length)
  };
}

export function lumenViewHref(viewId: LumenViewId, currentLocation?: string | LumenLocationLike): string {
  const view = LUMEN_VIEWS.find((candidate) => candidate.id === viewId);
  if (!view) return DEFAULT_PATH;
  return hrefFor(view.path, encounterFrom(currentLocation));
}
