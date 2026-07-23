import { describe, expect, it } from "vitest";
import { readNatsAuthentication } from "./nats-auth.js";

describe("readNatsAuthentication", () => {
  it("keeps token authentication backward compatible", () => {
    expect(readNatsAuthentication({ authToken: "local-test-token" }, { required: true })).toEqual({
      authToken: "local-test-token"
    });
  });

  it("can require a username identity without reflecting a rejected token", () => {
    const token = "legacy-token-that-must-not-leak";
    let message = "";
    try {
      readNatsAuthentication({ authToken: token }, { required: true, allowToken: false });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("not allowed");
    expect(message).not.toContain(token);
  });

  it("accepts a validated username/password pair", () => {
    expect(readNatsAuthentication({ username: "pulso", password: "local-test-password" }, { required: true })).toEqual({
      username: "pulso",
      password: "local-test-password"
    });
  });

  it("rejects mixed token and username/password authentication without reflecting secrets", () => {
    const token = "token-that-must-not-leak";
    const password = "password-that-must-not-leak";
    let message = "";
    try {
      readNatsAuthentication({ authToken: token, username: "pulso", password }, { required: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("mutually exclusive");
    expect(message).not.toContain(token);
    expect(message).not.toContain(password);
  });

  it.each([{ username: "pulso" }, { password: "local-test-password" }])(
    "rejects incomplete username/password credentials",
    (input) => {
      expect(() => readNatsAuthentication(input, { required: true })).toThrow(
        "NATS_USERNAME and NATS_PASSWORD must be provided together"
      );
    }
  );

  it("requires credentials when requested", () => {
    expect(() => readNatsAuthentication({}, { required: true })).toThrow("NATS authentication is required");
  });

  it("supports a production minimum without exposing the rejected value", () => {
    const secret = "too-short";
    let message = "";
    try {
      readNatsAuthentication({ authToken: secret }, { required: true, minimumSecretLength: 24 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("NATS_AUTH_TOKEN");
    expect(message).not.toContain(secret);
  });

  it.each(["1starts-with-a-number-and-is-long-enough", "unsafe+character-secret-value"])(
    "rejects server-configuration-unsafe secrets without reflecting %s",
    (secret) => {
      let message = "";
      try {
        readNatsAuthentication(
          { username: "pulso", password: secret },
          { required: true, minimumSecretLength: 24, serverConfigurationSafe: true }
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("NATS_PASSWORD");
      expect(message).not.toContain(secret);
    }
  );

  it("rejects unsafe usernames and control characters in secrets", () => {
    expect(() =>
      readNatsAuthentication({ username: "not safe", password: "local-test-password" }, { required: true })
    ).toThrow("NATS_USERNAME");
    expect(() => readNatsAuthentication({ authToken: "line\nbreak" }, { required: true })).toThrow("NATS_AUTH_TOKEN");
  });
});
