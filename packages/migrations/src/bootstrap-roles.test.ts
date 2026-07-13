import { describe, expect, it } from "vitest";
import { readServiceRolePasswords, SERVICE_DATABASE_ROLES } from "./bootstrap-roles.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SERVICE_DATABASE_ROLES.map((definition, index) => [
      definition.environmentVariable,
      `service-role-${index}-password-000000`
    ])
  );
}

describe("service database role bootstrap configuration", () => {
  it("loads one distinct password for every fixed service role", () => {
    const passwords = readServiceRolePasswords(validEnvironment());

    expect([...passwords.keys()]).toEqual(SERVICE_DATABASE_ROLES.map((definition) => definition.role));
    expect(new Set(passwords.values()).size).toBe(SERVICE_DATABASE_ROLES.length);
  });

  it("rejects a missing or too-short password without including its value", () => {
    const environment = validEnvironment();
    environment.LUMEN_DATABASE_PASSWORD = "short-secret";

    expect(() => readServiceRolePasswords(environment)).toThrow(
      "LUMEN_DATABASE_PASSWORD must contain at least 24 RFC 3986 unreserved characters"
    );
  });

  it("rejects URI-reserved characters", () => {
    const environment = validEnvironment();
    environment.CHANNEL_DATABASE_PASSWORD = "channel/password-that-is-long-enough";

    expect(() => readServiceRolePasswords(environment)).toThrow("CHANNEL_DATABASE_PASSWORD");
  });

  it("rejects password reuse across service roles", () => {
    const environment = validEnvironment();
    environment.LUMEN_DATABASE_PASSWORD = environment.CHANNEL_DATABASE_PASSWORD;

    expect(() => readServiceRolePasswords(environment)).toThrow("service database passwords must be distinct");
  });
});
