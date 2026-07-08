import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

const { Pool } = pg;

export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
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
    close: () => pool.end()
  };
}

export async function checkDatabase(db: DatabaseClient): Promise<number> {
  const started = performance.now();
  await db.query("select 1");
  return Math.round(performance.now() - started);
}
