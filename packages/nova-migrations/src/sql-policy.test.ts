import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNovaProviderSqlUsesAllowedSchemas, NOVA_PROVIDER_SCHEMAS } from "./sql-policy.js";

describe("NOVA provider-owned SQL schema policy", () => {
  it("pins the provider boundary to the four NOVA cell schemas", () => {
    expect(NOVA_PROVIDER_SCHEMAS).toEqual(["nova", "voice", "liwa", "documents"]);
  });

  it("accepts every checked-in provider-owned migration", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const sql = await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8");
      expect(() => assertNovaProviderSqlUsesAllowedSchemas(file, sql)).not.toThrow();
    }
  });

  it("accepts legitimate aliases, pseudo-records and comments without treating them as schemas", () => {
    expect(() =>
      assertNovaProviderSqlUsesAllowedSchemas(
        "999-safe.sql",
        `
          -- platform.tenants is documentation, not executable SQL.
          insert into nova.contacts(id)
          select contact.id from nova.contacts as contact
          on conflict (id) do update set id = excluded.id;
        `
      )
    ).not.toThrow();
  });

  it.each([
    ["schema creation", "create schema platform;", "platform"],
    ["qualified DDL", "create table platform.nova_escape(id uuid);", "platform"],
    ["index target", "create index escape_idx on platform.nova_escape(id);", "platform"],
    ["qualified read", "select * from lumen.clinical_records;", "lumen"],
    ["qualified write", "insert into audit_runtime.inbox_events(id) values ('x');", "audit_runtime"],
    ["quoted identifier", 'select * from "pulso_iris"."appointments";', "pulso_iris"],
    ["comment-separated tokens", "create/* boundary bypass */table platform.nova_escape(id uuid);", "platform"],
    ["foreign search path", "set search_path = platform, pg_catalog;", "platform"],
    ["dynamic schema identifier", "execute format('create table %I.escape(id uuid)', target_schema);", "dynamic"]
  ])("rejects %s outside the NOVA schema allowlist", (_label, sql, schema) => {
    expect(() => assertNovaProviderSqlUsesAllowedSchemas("999-unsafe.sql", sql)).toThrow(
      new RegExp(`999-unsafe\\.sql.*${schema}`)
    );
  });
});
