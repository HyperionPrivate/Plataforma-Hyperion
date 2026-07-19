import { readAccessPostgresAdminUrl, readAccessPostgresDatabase, readAccessRolePasswords } from "./config.js";
import { bootstrapAccessDatabaseRoles, fenceAccessRuntimeDatabaseRoles } from "./roles.js";

const adminUrl = readAccessPostgresAdminUrl();
await fenceAccessRuntimeDatabaseRoles(adminUrl);
await bootstrapAccessDatabaseRoles(adminUrl, readAccessPostgresDatabase(), readAccessRolePasswords());
console.info(JSON.stringify({ event: "access_database_roles_ready", roleCount: 2 }));
