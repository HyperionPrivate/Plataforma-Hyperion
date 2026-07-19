const PRIVATE_HTTP_ENVIRONMENTS = new Set(["local", "development", "test", "ci"]);
const LOCAL_FALLBACK_ENVIRONMENTS = new Set(["local", "development", "test"]);
const PRIVATE_ACCESS_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "identity-service"]);

export function allowPrivateAccessHttp(environment: NodeJS.ProcessEnv): boolean {
  if (environment.ACCESS_JWKS_ALLOW_PRIVATE_HTTP?.trim().toLowerCase() !== "true") return false;

  const deployment = deploymentEnvironment(environment);
  if (!PRIVATE_HTTP_ENVIRONMENTS.has(deployment)) {
    throw new Error("ACCESS_JWKS_ALLOW_PRIVATE_HTTP is forbidden outside local/CI");
  }
  return true;
}

export function readAccessServiceOrigin(environment: NodeJS.ProcessEnv): string {
  const allowPrivateHttp = allowPrivateAccessHttp(environment);
  const deployment = deploymentEnvironment(environment);
  const configured = environment.ACCESS_SERVICE_URL?.trim();
  const value =
    configured || (allowPrivateHttp && LOCAL_FALLBACK_ENVIRONMENTS.has(deployment) ? "http://localhost:8081" : "");

  if (!value) throw new Error("ACCESS_SERVICE_URL is required");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ACCESS_SERVICE_URL must be a valid HTTPS origin");
  }

  const permittedPrivateHttp =
    allowPrivateHttp && url.protocol === "http:" && PRIVATE_ACCESS_HTTP_HOSTS.has(url.hostname);
  if (
    (url.protocol !== "https:" && !permittedPrivateHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "ACCESS_SERVICE_URL must be a credential-free HTTPS origin without path, query or hash unless private HTTP is explicitly enabled for local/CI"
    );
  }
  return url.origin;
}

function deploymentEnvironment(environment: NodeJS.ProcessEnv): string {
  return (environment.HYPERION_ENVIRONMENT ?? environment.NODE_ENV ?? "local").trim().toLowerCase();
}
