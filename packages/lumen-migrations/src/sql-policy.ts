const TIMEOUT_SETTING_NAMES = ["lock_timeout", "statement_timeout", "idle_in_transaction_session_timeout"] as const;

const TIMEOUT_SETTING_PATTERN = TIMEOUT_SETTING_NAMES.join("|");
const QUOTED_TIMEOUT_SETTING_PATTERN = `(?:["']?)(?:${TIMEOUT_SETTING_PATTERN})(?:["']?)`;
const FORBIDDEN_TIMEOUT_DIRECTIVES: readonly RegExp[] = [
  new RegExp(`\\bset\\s+(?:(?:local|session)\\s+)?${QUOTED_TIMEOUT_SETTING_PATTERN}\\b`, "i"),
  new RegExp(`\\breset\\s+(?:${QUOTED_TIMEOUT_SETTING_PATTERN}\\b|all\\b)`, "i"),
  new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?set_config\\s*\\([\\s\\S]{0,160}\\b(?:${TIMEOUT_SETTING_PATTERN})\\b`, "i"),
  /\bdiscard\s+all\b/i
];

export const LUMEN_MIGRATION_TIMEOUTS = {
  lockTimeout: "10s",
  statementTimeout: "300s",
  idleInTransactionSessionTimeout: "60s"
} as const;

export interface LumenSqlPolicyClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Migration files are data owned by the provider, but the runner exclusively
 * owns its execution budget. Rejecting timeout directives before any file is
 * executed prevents a dump preamble or a later migration from disabling that
 * budget for the rest of the transaction.
 */
export function assertLumenProviderSqlPreservesTimeouts(name: string, sql: string): void {
  // PostgreSQL accepts comments between tokens (for example
  // `SET/* bypass */statement_timeout`). Collapse them before matching so a
  // migration cannot evade the policy with dump formatting or token trivia.
  const executableSql = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
  const forbidden = FORBIDDEN_TIMEOUT_DIRECTIVES.find((directive) => directive.test(executableSql));
  if (forbidden !== undefined) {
    throw new Error(`LUMEN migration ${name} must not SET, RESET, or disable runner-managed database timeouts`);
  }
}

/** Configure transaction-local limits immediately before provider SQL runs. */
export async function configureLumenMigrationTimeouts(client: LumenSqlPolicyClient): Promise<void> {
  await client.query(
    `select
       set_config('lock_timeout', $1, true),
       set_config('statement_timeout', $2, true),
       set_config('idle_in_transaction_session_timeout', $3, true)`,
    [
      LUMEN_MIGRATION_TIMEOUTS.lockTimeout,
      LUMEN_MIGRATION_TIMEOUTS.statementTimeout,
      LUMEN_MIGRATION_TIMEOUTS.idleInTransactionSessionTimeout
    ]
  );
}

/** Bound catalog preflight and every statement outside a migration transaction. */
export async function configureLumenMigrationSessionTimeouts(client: LumenSqlPolicyClient): Promise<void> {
  await client.query(
    `select
       set_config('lock_timeout', $1, false),
       set_config('statement_timeout', $2, false),
       set_config('idle_in_transaction_session_timeout', $3, false)`,
    [
      LUMEN_MIGRATION_TIMEOUTS.lockTimeout,
      LUMEN_MIGRATION_TIMEOUTS.statementTimeout,
      LUMEN_MIGRATION_TIMEOUTS.idleInTransactionSessionTimeout
    ]
  );
}

/**
 * PostgreSQL advisory locks do not honor lock_timeout. Temporarily use the
 * 10-second lock budget as statement_timeout, then always restore the normal
 * 300-second statement budget even when lock acquisition is cancelled.
 */
export async function acquireLumenMigrationLock(client: LumenSqlPolicyClient, key: string): Promise<void> {
  await client.query("select set_config('statement_timeout', $1, false)", [LUMEN_MIGRATION_TIMEOUTS.lockTimeout]);
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [key]);
  } finally {
    await client.query("select set_config('statement_timeout', $1, false)", [
      LUMEN_MIGRATION_TIMEOUTS.statementTimeout
    ]);
  }
}
