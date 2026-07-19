import { readNovaMigratorPassword, readNovaPostgresAdminUrl, readNovaPostgresDatabase } from "./config.js";
import { bootstrapNovaLogicalDatabase } from "./database-bootstrap.js";

const databaseName = readNovaPostgresDatabase();
await bootstrapNovaLogicalDatabase(readNovaPostgresAdminUrl(), databaseName, readNovaMigratorPassword());
console.info(JSON.stringify({ event: "nova_logical_database_ready", database: databaseName }));
