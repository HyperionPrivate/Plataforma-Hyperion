import { describe, expect, it } from "vitest";
import {
  PULSO_RUNTIME_ROLE_DEFINITIONS,
  readPulsoMigratorDatabaseUrl,
  readPulsoPostgresDatabase,
  readPulsoRuntimePasswords
} from "./config.js";

const runtimeEnvironment = Object.fromEntries(
  PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition, index) => [
    definition.environmentVariable,
    `pulso-runtime-${index}-password-2026`
  ])
);

describe("PULSO migration configuration", () => {
  it("accepts a dedicated migrator URL and safe logical database name", () => {
    expect(
      readPulsoMigratorDatabaseUrl({ PULSO_MIGRATOR_DATABASE_URL: "postgres://migrator:secret@db/pulso" })
    ).toContain("/pulso");
    expect(readPulsoPostgresDatabase({ PULSO_POSTGRES_DB: "hyperion_pulso" })).toBe("hyperion_pulso");
  });

  it("requires all five distinct runtime passwords", () => {
    const passwords = readPulsoRuntimePasswords(runtimeEnvironment);
    expect(passwords.size).toBe(5);
    expect([...passwords.keys()]).toEqual(PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition) => definition.role));
  });

  it("rejects missing, unsafe and duplicate runtime secrets", () => {
    expect(() => readPulsoRuntimePasswords({})).toThrow("PULSO_DATABASE_PASSWORD");
    expect(() =>
      readPulsoRuntimePasswords({ ...runtimeEnvironment, CHANNEL_DATABASE_PASSWORD: "contains spaces and is unsafe" })
    ).toThrow("CHANNEL_DATABASE_PASSWORD");
    expect(() =>
      readPulsoRuntimePasswords({
        ...runtimeEnvironment,
        CHANNEL_DATABASE_PASSWORD: runtimeEnvironment.PULSO_DATABASE_PASSWORD
      })
    ).toThrow("must be distinct");
  });

  it("rejects placeholders in restricted environments", () => {
    expect(() =>
      readPulsoRuntimePasswords({
        ...runtimeEnvironment,
        NODE_ENV: "production",
        PULSO_DATABASE_PASSWORD: "replace-pulso-runtime-password"
      })
    ).toThrow("placeholder");
  });
});
