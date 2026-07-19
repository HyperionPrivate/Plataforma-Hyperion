import { readAuditMigratorPassword, readAuditPostgresAdminUrl, readAuditPostgresDatabase } from "./config.js";
import { bootstrapAuditLogicalDatabase } from "./database-bootstrap.js";

const databaseName = readAuditPostgresDatabase();
await bootstrapAuditLogicalDatabase(readAuditPostgresAdminUrl(), databaseName, readAuditMigratorPassword());
console.info(JSON.stringify({ event: "audit_logical_database_ready", database: databaseName }));
