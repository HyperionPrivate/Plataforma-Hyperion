import { readPulsoPostgresAdminUrl, readPulsoPostgresDatabase, readPulsoRuntimePasswords } from "./config.js";
import { bootstrapPulsoDatabaseRoles } from "./roles.js";

await bootstrapPulsoDatabaseRoles(
  readPulsoPostgresAdminUrl(),
  readPulsoPostgresDatabase(),
  readPulsoRuntimePasswords()
);
console.info(JSON.stringify({ event: "pulso_database_roles_ready", roleCount: 5 }));
