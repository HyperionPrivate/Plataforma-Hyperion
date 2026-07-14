import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

const { Pool } = pg;
const DATABASE_TRANSACTION = Symbol("hyperion.database.transaction");

// Runtime services must finish or release work inside the 65s coordinated
// shutdown budget. Schema migrations use their own administrative client and
// explicit per-migration budgets, so these limits only constrain application
// queries and lock waits.
const APPLICATION_LOCK_TIMEOUT_MS = 5_000;
const APPLICATION_STATEMENT_TIMEOUT_MS = 10_000;
const APPLICATION_QUERY_TIMEOUT_MS = 12_000;

export interface DatabaseExecutor {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** Nominal executor that exists only while its owning BEGIN/COMMIT scope is active. */
export interface DatabaseTransaction extends DatabaseExecutor {
  readonly [DATABASE_TRANSACTION]: true;
}

export interface DatabaseClient extends DatabaseExecutor {
  transaction<T>(work: (client: DatabaseTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function runTransaction<T>(client: PoolClient, work: (client: DatabaseTransaction) => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const transaction: DatabaseTransaction = {
      [DATABASE_TRANSACTION]: true,
      query: (text, params) => client.query(text, params)
    };
    const result = await work(transaction);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function isDatabaseTransaction(value: unknown): value is DatabaseTransaction {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [DATABASE_TRANSACTION]?: unknown })[DATABASE_TRANSACTION] === true
  );
}

/**
 * Adapts helpers that expect a DatabaseClient to an existing transaction.
 * Nested transaction callbacks reuse the same owner transaction; closing this
 * scoped adapter is forbidden so a domain helper cannot terminate the pool.
 */
export function asTransactionalDatabase(transaction: DatabaseTransaction): DatabaseClient {
  if (!isDatabaseTransaction(transaction)) throw new TypeError("A live database transaction is required");
  return {
    query: (text, params) => transaction.query(text, params),
    transaction: async (work) => work(transaction),
    close: async () => {
      throw new Error("A transaction-scoped database adapter cannot be closed");
    }
  };
}

export function createDatabase(connectionString: string): DatabaseClient {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    lock_timeout: APPLICATION_LOCK_TIMEOUT_MS,
    statement_timeout: APPLICATION_STATEMENT_TIMEOUT_MS,
    query_timeout: APPLICATION_QUERY_TIMEOUT_MS
  });

  return {
    query: (text, params) => pool.query(text, params),
    transaction: async (work) => runTransaction(await pool.connect(), work),
    close: () => pool.end()
  };
}

export async function checkDatabase(db: DatabaseClient): Promise<number> {
  const started = performance.now();
  await db.query("select 1");
  return Math.round(performance.now() - started);
}
