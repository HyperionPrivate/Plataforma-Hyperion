import { describe, expect, it } from "vitest";
import { assertDialerBaseUrlAllowed, HttpDialerAdapter } from "./dialer-adapter.js";

describe("assertDialerBaseUrlAllowed", () => {
  const env = {
    DIALER_BASE_URL: "https://dialer.internal:8443",
    HYPERION_DEPLOYMENT_ENVIRONMENT: "development"
  } as NodeJS.ProcessEnv;

  it("allows the configured dialer host", () => {
    expect(() => assertDialerBaseUrlAllowed("https://dialer.internal:8443/v1", env)).not.toThrow();
  });

  it("rejects a different host (SSRF guard)", () => {
    expect(() => assertDialerBaseUrlAllowed("https://evil.example/v1", env)).toThrow(/host is not allowed/i);
  });

  it("rejects non-http schemes", () => {
    expect(() => assertDialerBaseUrlAllowed("file:///etc/passwd", env)).toThrow(/HTTP/i);
  });
});

describe("HttpDialerAdapter", () => {
  const credentials = {
    username: "admin",
    password: "secret",
    demoApiKey: "demo-key"
  };

  it("constructs only with an allowed base URL", () => {
    const previous = process.env.DIALER_BASE_URL;
    process.env.DIALER_BASE_URL = "http://127.0.0.1:9000";
    try {
      expect(() => new HttpDialerAdapter("http://127.0.0.1:9000", credentials, fetch)).not.toThrow();
      expect(() => new HttpDialerAdapter("http://metadata.google.internal", credentials, fetch)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.DIALER_BASE_URL;
      else process.env.DIALER_BASE_URL = previous;
    }
  });
});
