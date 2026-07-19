import { readAuditPostgresAdminUrl, readAuditPostgresDatabase, readAuditRuntimePassword } from "./config.js";
import { bootstrapAuditDatabaseRole } from "./roles.js";

await bootstrapAuditDatabaseRole(readAuditPostgresAdminUrl(), readAuditPostgresDatabase(), readAuditRuntimePassword());
console.info(JSON.stringify({ event: "audit_database_role_ready", role: "hyperion_audit" }));
