import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createLogger } from "@hyperion/logger";
import pg from "pg";

const { Client } = pg;

export const SERVICE_DATABASE_ROLES = [
  { environmentVariable: "ACCESS_DATABASE_PASSWORD", role: "hyperion_access" },
  { environmentVariable: "SOFIA_DATABASE_PASSWORD", role: "hyperion_sofia" },
  { environmentVariable: "KNOWLEDGE_DATABASE_PASSWORD", role: "hyperion_knowledge" },
  { environmentVariable: "AUDIT_DATABASE_PASSWORD", role: "hyperion_audit" },
  { environmentVariable: "INTEGRATION_DATABASE_PASSWORD", role: "hyperion_integration" },
  { environmentVariable: "PULSO_DATABASE_PASSWORD", role: "hyperion_pulso" },
  { environmentVariable: "CHANNEL_DATABASE_PASSWORD", role: "hyperion_channel" },
  { environmentVariable: "LUMEN_DATABASE_PASSWORD", role: "hyperion_lumen" }
] as const;

export type ServiceDatabaseRole = (typeof SERVICE_DATABASE_ROLES)[number]["role"];
export type ServiceRolePasswords = ReadonlyMap<ServiceDatabaseRole, string>;

const logger = createLogger("database-role-bootstrap");
const PASSWORD_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MINIMUM_PASSWORD_LENGTH = 24;

/**
 * Compose embeds these values in PostgreSQL URIs, so accepting only RFC 3986
 * unreserved characters avoids ambiguous parsing without duplicating secrets
 * into separate raw and percent-encoded variables.
 */
export function readServiceRolePasswords(environment: NodeJS.ProcessEnv = process.env): ServiceRolePasswords {
  const passwords = new Map<ServiceDatabaseRole, string>();
  const seen = new Set<string>();

  for (const definition of SERVICE_DATABASE_ROLES) {
    const password = environment[definition.environmentVariable]?.trim() ?? "";
    if (password.length < MINIMUM_PASSWORD_LENGTH || !PASSWORD_PATTERN.test(password)) {
      throw new Error(
        `${definition.environmentVariable} must contain at least ${MINIMUM_PASSWORD_LENGTH} RFC 3986 unreserved characters`
      );
    }
    if (seen.has(password)) {
      throw new Error("service database passwords must be distinct");
    }
    seen.add(password);
    passwords.set(definition.role, password);
  }

  return passwords;
}

export async function bootstrapDatabaseRoles(databaseUrl: string, passwords: ServiceRolePasswords): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const authority = await client.query<{
      rolcreaterole: boolean;
      rolsuper: boolean;
    }>(
      `select rolsuper, rolcreaterole
         from pg_roles
        where rolname = current_user`
    );
    if (!authority.rows[0]?.rolsuper && !authority.rows[0]?.rolcreaterole) {
      throw new Error("database role bootstrap requires a PostgreSQL role with CREATEROLE");
    }

    await client.query("select pg_advisory_lock(hashtext('hyperion:service-role-bootstrap'))");
    try {
      for (const definition of SERVICE_DATABASE_ROLES) {
        const password = passwords.get(definition.role);
        if (!password) {
          throw new Error(`missing password for ${definition.role}`);
        }

        const exists = await client.query<{ exists: boolean }>(
          "select exists(select 1 from pg_roles where rolname = $1) as exists",
          [definition.role]
        );
        const action = exists.rows[0]?.exists ? "alter" : "create";
        const rendered = await client.query<{ statement: string }>(
          `select format(
             '${action} role %I with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L valid until %L',
             $1::text,
             $2::text,
             'infinity'
           ) as statement`,
          [definition.role, password]
        );
        const statement = rendered.rows[0]?.statement;
        if (!statement) {
          throw new Error(`could not prepare role bootstrap statement for ${definition.role}`);
        }
        try {
          await client.query(statement);
        } catch {
          // Never propagate a driver diagnostic that could echo the rendered
          // PASSWORD clause. The fixed role name is sufficient for operators.
          throw new Error(`could not create or rotate service role ${definition.role}`);
        }
      }
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('hyperion:service-role-bootstrap'))");
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const passwords = readServiceRolePasswords();
  await bootstrapDatabaseRoles(databaseUrl, passwords);
  logger.info("service database roles are ready", { roleCount: SERVICE_DATABASE_ROLES.length });
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    logger.error("service database role bootstrap failed", {
      error: error instanceof Error ? error.message : "unknown error"
    });
    process.exitCode = 1;
  }
}
