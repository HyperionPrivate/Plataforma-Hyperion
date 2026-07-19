import { fileURLToPath } from "node:url";
import { readPlatformMigratorDatabaseUrl } from "./config.js";
import { runPlatformMigrations } from "./runner.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const result = await runPlatformMigrations(readPlatformMigratorDatabaseUrl(), sqlDirectory);
console.info(JSON.stringify({ event: "platform_access_migrations_complete", ...result }));
