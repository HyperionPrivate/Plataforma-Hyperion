import { readLumenPostgresAdminUrl, readLumenPostgresDatabase, readLumenRuntimePassword } from "./config.js";
import { bootstrapLumenDatabaseRole } from "./roles.js";

await bootstrapLumenDatabaseRole(readLumenPostgresAdminUrl(), readLumenPostgresDatabase(), readLumenRuntimePassword());
console.info(JSON.stringify({ event: "lumen_database_role_ready", role: "hyperion_lumen" }));
