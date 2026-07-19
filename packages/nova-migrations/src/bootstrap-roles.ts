import { readNovaPostgresAdminUrl, readNovaPostgresDatabase, readNovaRolePasswords } from "./config.js";
import { bootstrapNovaDatabaseRoles, fenceNovaRuntimeDatabaseRoles } from "./roles.js";

const adminUrl = readNovaPostgresAdminUrl();
// Fence before reading the target database or runtime passwords. A malformed
// late-stage secret must never leave pre-existing NOVA identities able to login.
await fenceNovaRuntimeDatabaseRoles(adminUrl);
await bootstrapNovaDatabaseRoles(adminUrl, readNovaPostgresDatabase(), readNovaRolePasswords());
console.info(JSON.stringify({ event: "nova_database_roles_ready", roleCount: 4 }));
