export interface ExactRoutePolicy {
  method: string;
  path: string;
  resources?: readonly string[];
}

/**
 * Matches one canonical request path against a provider-owned exact route
 * template. Only named single-segment parameters are supported; wildcards are
 * intentionally forbidden so a compatibility facade cannot broaden a BFF
 * allowlist by accident.
 */
export function matchExactRoutePolicy(
  policy: ExactRoutePolicy,
  method: string,
  canonicalPath: string
): Readonly<Record<string, string>> | undefined {
  if (method !== policy.method || !isCanonicalRoute(policy.path) || !isCanonicalRoute(canonicalPath)) {
    return undefined;
  }

  const templateSegments = policy.path.slice(1).split("/");
  const requestSegments = canonicalPath.slice(1).split("/");
  if (templateSegments.length !== requestSegments.length) return undefined;

  const parameters: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const template = templateSegments[index]!;
    const value = requestSegments[index]!;
    if (!template.startsWith(":")) {
      if (template !== value) return undefined;
      continue;
    }
    const name = template.slice(1);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || value.length === 0 || parameters[name] !== undefined) {
      return undefined;
    }
    parameters[name] = value;
  }

  if (policy.resources && !policy.resources.includes(parameters.resource ?? "")) return undefined;
  return Object.freeze(parameters);
}

function isCanonicalRoute(path: string): boolean {
  return path.startsWith("/") && path !== "/" && !path.endsWith("/") && !path.includes("//") && !path.includes("*");
}
