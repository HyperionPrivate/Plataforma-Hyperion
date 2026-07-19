import { readPulsoMigratorPassword, readPulsoPostgresAdminUrl, readPulsoPostgresDatabase } from "./config.js";
import { bootstrapPulsoLogicalDatabase } from "./database-bootstrap.js";

const databaseName = readPulsoPostgresDatabase();
await bootstrapPulsoLogicalDatabase(readPulsoPostgresAdminUrl(), databaseName, readPulsoMigratorPassword());
console.info(JSON.stringify({ event: "pulso_logical_database_ready", database: databaseName }));
