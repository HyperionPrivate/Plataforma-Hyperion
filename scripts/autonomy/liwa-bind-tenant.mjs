/**
 * Seed liwa.tenant_bindings for webhook resolution.
 *
 * Prints SQL (always). If DATABASE_URL is set and `psql` is on PATH, executes it.
 *
 * Uso:
 *   LIWA_BIND_TENANT_ID=<uuid> node scripts/autonomy/liwa-bind-tenant.mjs
 *   DATABASE_URL=postgres://... LIWA_BIND_TENANT_ID=<uuid> node scripts/autonomy/liwa-bind-tenant.mjs
 */

import { spawnSync } from "node:child_process";

const accountId = (process.env.LIWA_ACCOUNT_ID ?? "1656233").trim();
const tenantId = (process.env.LIWA_BIND_TENANT_ID ?? process.env.LIWA_WEBHOOK_DEFAULT_TENANT_ID ?? "").trim();
const defaultAgency = (process.env.LIWA_DEFAULT_AGENCY_CODE ?? "BGA").trim();
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!tenantId) {
  console.error("LIWA_BIND_TENANT_ID (tenant UUID) is required");
  process.exit(64);
}

const sql = `insert into liwa.tenant_bindings (liwa_account_id, tenant_id, default_agency_code)
values ('${accountId.replace(/'/g, "''")}', '${tenantId.replace(/'/g, "''")}', '${defaultAgency.replace(/'/g, "''")}')
on conflict (liwa_account_id) do update
set tenant_id = excluded.tenant_id,
    default_agency_code = coalesce(excluded.default_agency_code, liwa.tenant_bindings.default_agency_code);
`;

console.log("-- Apply against Hyperion Postgres (liwa schema)");
console.log(sql);

if (!databaseUrl) {
  console.log(JSON.stringify({ ok: true, mode: "sql_only", liwa_account_id: accountId, tenant_id: tenantId }, null, 2));
  process.exit(0);
}

const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", sql], {
  encoding: "utf8"
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "psql failed");
  console.error("SQL printed above; apply manually if psql is unavailable.");
  process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ ok: true, mode: "psql", liwa_account_id: accountId, tenant_id: tenantId }, null, 2));
