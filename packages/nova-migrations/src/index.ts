import { fileURLToPath } from "node:url";
import { readNovaMigratorDatabaseUrl } from "./config.js";
import { runNovaMigrations } from "./runner.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const result = await runNovaMigrations(readNovaMigratorDatabaseUrl(), sqlDirectory);
console.info(JSON.stringify({ event: "nova_migrations_complete", ...result }));
