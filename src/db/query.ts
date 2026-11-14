import type { SQLQueryBindings } from "bun:sqlite";
import type { Store } from "./types.ts";

export function get<Row>(store: Store, sql: string, ...parameters: SQLQueryBindings[]): Row | null {
  return store.database.query<Row, SQLQueryBindings[]>(sql).get(...parameters);
}

export function all<Row>(store: Store, sql: string, ...parameters: SQLQueryBindings[]): Row[] {
  return store.database.query<Row, SQLQueryBindings[]>(sql).all(...parameters);
}

/** Runs a statement and returns how many rows it changed. */
export function run(store: Store, sql: string, ...parameters: SQLQueryBindings[]): number {
  return store.database.query<unknown, SQLQueryBindings[]>(sql).run(...parameters).changes;
}

/** Runs `work` in a write transaction that takes the write lock up front. */
export function immediately<Result>(store: Store, work: () => Result): Result {
  return store.database.transaction(work).immediate();
}
