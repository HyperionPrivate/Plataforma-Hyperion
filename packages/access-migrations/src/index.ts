import { fileURLToPath } from "node:url";
import { readAccessMigratorDatabaseUrl } from "./config.js";
import { runAccessMigrations } from "./runner.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const result = await runAccessMigrations(readAccessMigratorDatabaseUrl(), sqlDirectory);
console.info(JSON.stringify({ event: "access_migrations_complete", ...result }));
