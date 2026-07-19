import { describe, expect, it } from "vitest";
import { assertAccessProviderSqlUsesAllowedSchemas } from "./sql-policy.js";

describe("Access provider SQL policy", () => {
  it("accepts only the provider-owned legacy-compatible schemas", () => {
    expect(() =>
      assertAccessProviderSqlUsesAllowedSchemas(
        "001.sql",
        "select * from platform.tenants join access_runtime.product_grants on true"
      )
    ).not.toThrow();
  });

  it.each(["nova.leads", "lumen.encounters", "pulso_iris.appointments", "audit_runtime.inbox_events"])(
    "rejects cross-cell relation %s",
    (relation) => {
      expect(() => assertAccessProviderSqlUsesAllowedSchemas("bad.sql", `select * from ${relation}`)).toThrow(
        "forbidden schemas"
      );
    }
  );

  it("ignores examples in comments and strings but rejects the legacy global ledger", () => {
    expect(() =>
      assertAccessProviderSqlUsesAllowedSchemas("comment.sql", "-- nova.leads\nselect 'lumen.encounters'")
    ).not.toThrow();
    expect(() =>
      assertAccessProviderSqlUsesAllowedSchemas("legacy.sql", "select * from platform.schema_migrations")
    ).toThrow("legacy global migration ledger");
  });

  it.each([
    'select * from "nova"."secrets"',
    'select * from platform."Tenants"',
    "set search_path = nova, public",
    "set local search_path = access_runtime",
    "select set_config('search_path', 'nova', false)",
    "select set_config(E'search_path', 'nova', false)",
    "select set_config($key$search_path$key$, 'nova', false)",
    "set role postgres",
    "set session authorization postgres",
    "reset search_path",
    "reset all",
    "set schema 'nova'",
    "create schema nova",
    "create table stray (id integer)",
    "do $$ begin execute 'select * from nova.secrets'; end $$",
    "do $$ begin execute format('select * from %I.secrets', 'nova'); end $$",
    "do 'begin perform 1; end'",
    "create function access_runtime.escape() returns int language sql as U&'select count(*) from nova.secrets'",
    "select query_to_xml('select * from nova.secrets', false, false, '')",
    "select query_to_xml_and_xmlschema('select * from nova.secrets', false, false, '')",
    "select table_to_xml('nova.secrets'::regclass, false, false, '')",
    "select table_to_xml_and_xmlschema('nova.secrets'::regclass, false, false, '')",
    "select nextval('nova.secret_sequence'::regclass)",
    "select dblink_open('cursor_name', 'select * from nova.secrets')",
    "copy access_runtime.product_grants to '/tmp/grants.csv'",
    "create function access_runtime.escape() returns int language sql as 'select count(*) from nova.secrets'"
  ])("rejects quoted, search-path, schema-DDL or dynamic-policy bypass: %s", (sql) => {
    expect(() => assertAccessProviderSqlUsesAllowedSchemas("bypass.sql", sql)).toThrow();
  });

  it("permits only the fixed dynamic current-database ACL statements", () => {
    expect(() =>
      assertAccessProviderSqlUsesAllowedSchemas(
        "acl.sql",
        `do $database$
         begin
           execute format('revoke all privileges on database %I from public', current_database());
           execute format('grant connect on database %I to hyperion_identity', current_database());
         end
         $database$;`
      )
    ).not.toThrow();
  });

  it("accepts a statically referenced provider-owned trigger function", () => {
    expect(() =>
      assertAccessProviderSqlUsesAllowedSchemas(
        "trigger.sql",
        `create function access_runtime.guard() returns trigger language plpgsql as $body$
         begin new.updated_at := greatest(new.updated_at, old.updated_at); return new; end
         $body$;
         create trigger guard before update on platform.tenants
         for each row execute function access_runtime.guard();`
      )
    ).not.toThrow();
  });

  it("permits only a function-scoped pg_catalog search_path hardening clause", () => {
    expect(() =>
      assertAccessProviderSqlUsesAllowedSchemas(
        "hardened-trigger.sql",
        `create function access_runtime.guard() returns trigger language plpgsql
         set search_path = pg_catalog as $body$
         begin new.updated_at := clock_timestamp(); return new; end
         $body$;`
      )
    ).not.toThrow();
    expect(() =>
      assertAccessProviderSqlUsesAllowedSchemas(
        "unsafe-trigger.sql",
        `create function access_runtime.guard() returns trigger language plpgsql
         set search_path = public as $body$ begin return new; end $body$;`
      )
    ).toThrow("must not change search_path");
  });

  it("does not mistake a foreign relation for a trigger pseudo-record", () => {
    expect(() =>
      assertAccessProviderSqlUsesAllowedSchemas(
        "bad-trigger.sql",
        `create function access_runtime.guard() returns trigger language plpgsql as $body$
         begin perform 1 from new.secrets; return new; end
         $body$;`
      )
    ).toThrow("invalid trigger pseudo-record reference");
  });
});
