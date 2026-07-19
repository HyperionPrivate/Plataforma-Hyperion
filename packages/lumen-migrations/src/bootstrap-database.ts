import { readLumenMigratorPassword, readLumenPostgresAdminUrl, readLumenPostgresDatabase } from "./config.js";
import { bootstrapLumenLogicalDatabase } from "./database-bootstrap.js";

const databaseName = readLumenPostgresDatabase();
await bootstrapLumenLogicalDatabase(readLumenPostgresAdminUrl(), databaseName, readLumenMigratorPassword());
console.info(JSON.stringify({ event: "lumen_logical_database_ready", database: databaseName }));
