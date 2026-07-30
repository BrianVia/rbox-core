/**
 * The state plane's only way to run SQL: prepare, use, finalize.
 *
 * `db.query` caches its statement on the connection and the cached statement
 * outlives the call. A connection that still holds one cannot let SQLite remove
 * `-wal`/`-shm` when it closes, so the database never comes to rest at `S0` —
 * and the next observer reads the surviving sidecars as a WAL crash (`W1`).
 * That makes a read a mutation, which 163 v13 forbids outright, and it is why
 * `statements.test.ts` fails the build on any `.query(` in this vertical.
 */
import type { Database, SQLQueryBinding, Statement } from "bun:sqlite";

export function withStatement<T>(db: Database, sql: string, use: (statement: Statement) => T): T {
  const prepared = db.prepare(sql);
  try {
    return use(prepared);
  } finally {
    prepared.finalize();
  }
}

export function selectRows<T>(db: Database, sql: string, ...bindings: SQLQueryBinding[]): T[] {
  return withStatement(db, sql, (statement) => statement.all(...bindings) as T[]);
}

export function selectRow<T>(db: Database, sql: string, ...bindings: SQLQueryBinding[]): T | null {
  return withStatement(db, sql, (statement) => statement.get(...bindings) as T | null);
}

export function runStatement(db: Database, sql: string, ...bindings: SQLQueryBinding[]): void {
  withStatement(db, sql, (statement) => { statement.run(...bindings); });
}

/**
 * Stream rows through a private statement that is always finalized, including on
 * an early throw. A refusal raised mid-iteration must not leave a cursor open on a
 * connection-owned TEMP table the caller is about to drop. Returning `false` from
 * the visitor stops the scan, which is how byte ceilings are applied DURING paging.
 */
export function streamRows<T>(
  db: Database,
  sql: string,
  params: Array<string | number | Uint8Array | null>,
  visit: (row: T) => boolean | void,
): number {
  return withStatement(db, sql, (statement) => {
    let count = 0;
    for (const row of statement.iterate(...params) as Iterable<T>) {
      count++;
      if (visit(row) === false) break;
    }
    return count;
  });
}
