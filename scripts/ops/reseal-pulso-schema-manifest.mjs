#!/usr/bin/env node
/**
 * Apply PULSO SQL migrations on a disposable PG16 database and print the tip
 * structural manifest (counts + fingerprints) for resealing schema-manifest.ts.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsRoot = path.join(root, "packages/pulso-migrations");
const migrationsDist = path.join(migrationsRoot, "dist");
const sqlDirectory = path.join(migrationsRoot, "sql");
const require = createRequire(path.join(migrationsRoot, "package.json"));
const pg = require("pg");

const { bootstrapPulsoLogicalDatabase } = await import(
  pathToFileURL(path.join(migrationsDist, "database-bootstrap.js")).href
);
const { inspectPulsoSchema, createPulsoStructuralManifest, PULSO_CURRENT_SCHEMA_VERSION } = await import(
  pathToFileURL(path.join(migrationsDist, "schema-manifest.js")).href
);

const adminUrl = process.env.PULSO_POSTGRES_ADMIN_URL?.trim();
const database = process.env.PULSO_POSTGRES_DB?.trim();
const migratorPassword = process.env.PULSO_MIGRATOR_DATABASE_PASSWORD?.trim();
const migratorUrl = process.env.PULSO_MIGRATOR_DATABASE_URL?.trim();
if (!adminUrl || !database || !migratorPassword || !migratorUrl) {
  throw new Error(
    "PULSO_POSTGRES_ADMIN_URL, PULSO_POSTGRES_DB, PULSO_MIGRATOR_DATABASE_PASSWORD and PULSO_MIGRATOR_DATABASE_URL are required"
  );
}

const { Client } = pg;
const CONTROL_TABLES_DDL = `
create table if not exists pulso_iris.schema_version (
  service_name text primary key,
  current_version integer not null check (current_version > 0),
  migration_name text not null,
  updated_at timestamptz not null default now(),
  constraint schema_version_service_name_check check (service_name = 'pulso')
);
create table if not exists pulso_iris.service_migrations (
  version integer primary key check (version > 0),
  name text not null unique check (length(btrim(name)) between 3 and 160),
  applied_at timestamptz not null default now()
);
create table if not exists pulso_iris.migration_ledger (
  name text primary key check (length(btrim(name)) between 3 and 160),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now()
);
`;

await bootstrapPulsoLogicalDatabase(adminUrl, database, migratorPassword);

const through = process.env.PULSO_RESEAL_THROUGH?.trim();
const files = (await readdir(sqlDirectory))
  .filter((name) => /^\d{3}-.+\.sql$/u.test(name))
  .filter((name) => (through ? name.localeCompare(through) <= 0 : true))
  .sort((left, right) => left.localeCompare(right));
if (files.length === 0) throw new Error("No migration files selected for reseal");

const client = new Client({ connectionString: migratorUrl });
await client.connect();
try {
  for (const [index, name] of files.entries()) {
    const sql = (await readFile(path.join(sqlDirectory, name), "utf8")).replaceAll("\r\n", "\n");
    const checksum = createHash("sha256").update(sql).digest("hex");
    await client.query("begin");
    try {
      await client.query(sql);
      if (index === 0) await client.query(CONTROL_TABLES_DDL);
      await client.query("insert into pulso_iris.migration_ledger(name, checksum) values ($1, $2)", [name, checksum]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    console.error(`applied ${name}`);
  }

  const inspection = await inspectPulsoSchema(client, "migrator");
  const managed = createPulsoStructuralManifest(inspection.catalog);
  console.log(
    JSON.stringify(
      {
        currentVersion: PULSO_CURRENT_SCHEMA_VERSION,
        inspectionVersion: inspection.currentVersion,
        migrationName: inspection.migrationName,
        state: inspection.state,
        issues: inspection.issues,
        managed
      },
      null,
      2
    )
  );
} finally {
  await client.end();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${database} with (force)`);
  } finally {
    await admin.end();
  }
}
