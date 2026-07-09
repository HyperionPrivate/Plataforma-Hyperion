import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

const { Pool } = pg;

export interface DatabaseExecutor {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DatabaseClient extends DatabaseExecutor {
  transaction<T>(work: (client: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function runTransaction<T>(client: PoolClient, work: (client: DatabaseExecutor) => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function createDatabase(connectionString: string): DatabaseClient {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
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
