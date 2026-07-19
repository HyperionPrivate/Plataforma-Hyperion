import { fileURLToPath } from "node:url";
import { readLumenMigratorDatabaseUrl } from "./config.js";
import { runLumenMigrations } from "./runner.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const result = await runLumenMigrations(readLumenMigratorDatabaseUrl(), sqlDirectory);
console.info(JSON.stringify({ event: "lumen_migrations_complete", ...result }));
