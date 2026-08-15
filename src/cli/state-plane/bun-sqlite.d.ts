declare module "bun:sqlite" {
  export type SQLQueryBinding = string | number | bigint | boolean | null | Uint8Array;

  export interface Statement {
    run(...bindings: SQLQueryBinding[]): { changes: number; lastInsertRowid: number | bigint };
    get(...bindings: SQLQueryBinding[]): unknown;
    all(...bindings: SQLQueryBinding[]): unknown[];
    iterate(...bindings: SQLQueryBinding[]): Iterable<unknown>;
    safeIntegers(): boolean;
    safeIntegers(enabled: boolean): this;
    finalize(): void;
  }

  export class Database {
    constructor(
      filename?: string,
      options?: number | { readonly?: boolean; readwrite?: boolean; create?: boolean; strict?: boolean },
    );
    readonly inTransaction: boolean;
    exec(sql: string): void;
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    transaction<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result;
    close(throwOnError?: boolean): void;
  }
}
