import { fileURLToPath } from "node:url";
import { readPulsoMigratorDatabaseUrl } from "./config.js";
import { runPulsoMigrations } from "./runner.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const result = await runPulsoMigrations(readPulsoMigratorDatabaseUrl(), sqlDirectory);
console.info(JSON.stringify({ event: "pulso_migrations_complete", ...result }));
