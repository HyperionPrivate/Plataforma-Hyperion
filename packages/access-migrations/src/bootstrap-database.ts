import { readAccessMigratorPassword, readAccessPostgresAdminUrl, readAccessPostgresDatabase } from "./config.js";
import { bootstrapAccessLogicalDatabase } from "./database-bootstrap.js";
import { fenceAccessRuntimeDatabaseRoles } from "./roles.js";

const adminUrl = readAccessPostgresAdminUrl();
await fenceAccessRuntimeDatabaseRoles(adminUrl);
const databaseName = readAccessPostgresDatabase();
await bootstrapAccessLogicalDatabase(adminUrl, databaseName, readAccessMigratorPassword());
console.info(JSON.stringify({ event: "access_logical_database_ready", database: databaseName }));
