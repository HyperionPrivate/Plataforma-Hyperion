import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const originalFetch = globalThis.fetch.bind(globalThis);
const internalHosts = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
  "identity-service",
  "tenant-service",
  "agent-service",
  "prompt-flow-service",
  "knowledge-service",
  "audit-service",
  "integration-service",
  "pulso-iris-service",
  "whatsapp-channel-service",
  "lumen-service",
  "api-gateway"
]);

globalThis.fetch = (input, options = {}) => {
  const request = input instanceof globalThis.Request ? input : undefined;
  const raw = request ? request.url : String(input);
  let url;
  try {
    url = new globalThis.URL(raw);
  } catch {
    return Promise.reject(new Error("CI outbound fetch blocked"));
  }

  const method = String(options.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new globalThis.Headers(request?.headers);
  if (options.headers) {
    const overlay = new globalThis.Headers(options.headers);
    for (const [key, value] of overlay.entries()) headers.set(key, value);
  }
  const body = options.body ?? request?.body ?? null;
  const signal = options.signal ?? request?.signal;

  const isProviderBoundary =
    url.protocol === "https:" &&
    url.hostname === "api.elevenlabs.io" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/v1/speech-to-text" &&
    url.search === "?enable_logging=false" &&
    url.hash === "" &&
    method === "POST" &&
    headers.has("xi-api-key") &&
    String(headers.get("xi-api-key") ?? "").length > 0 &&
    body instanceof globalThis.FormData;
  if (isProviderBoundary) {
    attestProviderBoundaryBlocked();
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  if (url.protocol === "http:" && internalHosts.has(url.hostname)) {
    return originalFetch(input, {
      ...options,
      // Prevent an internal hop from following an external Location and escaping CI.
      redirect: options.redirect ?? "error"
    });
  }
  return Promise.reject(new Error("CI outbound fetch blocked"));
};

function attestProviderBoundaryBlocked() {
  const root = process.env.LUMEN_AUDIO_TEMP_DIR ?? "/tmp/lumen-audio";
  mkdirSync(root, { recursive: true, mode: 0o700 });

  let attemptMarkers = 0;
  for (const entry of safeReaddir(root)) {
    if (!entry.isDirectory()) continue;
    // Legacy ephemeral writers stage under /tmp/lumen-audio/request-<id>.
    if (entry.name.startsWith("request-")) {
      const requestDirectory = join(root, entry.name);
      if (!hasStagedAudio(requestDirectory)) continue;
      writeFileSync(join(requestDirectory, ".provider-network-blocked"), "blocked", {
        mode: 0o600
      });
      attemptMarkers += 1;
      continue;
    }

    const ownerPath = join(root, entry.name);
    for (const child of safeReaddir(ownerPath)) {
      if (!child.isDirectory()) continue;
      if (!child.name.startsWith("attempt-") && !child.name.startsWith("request-")) continue;
      const requestDirectory = join(ownerPath, child.name);
      if (!hasStagedAudio(requestDirectory)) continue;
      writeFileSync(join(requestDirectory, ".provider-network-blocked"), "blocked", {
        mode: 0o600
      });
      attemptMarkers += 1;
    }
  }

  // Root marker remains as a coarse fallback for probes that only check the
  // attested temp root; attempt-scoped markers are preferred when present.
  writeFileSync(join(root, ".provider-network-blocked"), `blocked:${attemptMarkers}`, {
    mode: 0o600
  });
}

function hasStagedAudio(directory) {
  return safeReaddir(directory).some(
    (entry) => entry.isFile() && entry.name.startsWith("audio.")
  );
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
