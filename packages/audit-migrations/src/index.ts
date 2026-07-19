import { fileURLToPath } from "node:url";
import { readAuditMigratorDatabaseUrl } from "./config.js";
import { runAuditMigrations } from "./runner.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const result = await runAuditMigrations(readAuditMigratorDatabaseUrl(), sqlDirectory);
console.info(JSON.stringify({ event: "audit_migrations_complete", ...result }));
