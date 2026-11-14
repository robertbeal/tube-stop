import type { SQLQueryBindings } from "bun:sqlite";
import { get, immediately, requireRow, run } from "../db/query.ts";
import { AlreadySetUpError, type Store, type User } from "../db/types.ts";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, username: row.username, passwordHash: row.password_hash };
}

export function countUsers(store: Store): number {
  return get<{ total: number }>(store, "SELECT COUNT(*) AS total FROM users")?.total ?? 0;
}

/** Creates the initial admin account, but only if none exists. The check and the insert are one transaction. */
export function createFirstUser(store: Store, username: string, passwordHash: string): User {
  return immediately(store, () => {
    if (countUsers(store) > 0) {
      throw new AlreadySetUpError();
    }
    const result = store.database
      .query<unknown, SQLQueryBindings[]>(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
      )
      .run(username, passwordHash, store.now());
    return { id: Number(result.lastInsertRowid), username, passwordHash };
  });
}

/** Finds an account by username, ignoring case. */
export function getUserByUsername(store: Store, username: string): User | null {
  const row = get<UserRow>(
    store,
    "SELECT id, username, password_hash FROM users WHERE username = ?",
    username,
  );
  return row === null ? null : toUser(row);
}

export function getUserById(store: Store, id: number): User | null {
  const row = get<UserRow>(store, "SELECT id, username, password_hash FROM users WHERE id = ?", id);
  return row === null ? null : toUser(row);
}

export function updatePassword(store: Store, id: number, passwordHash: string): void {
  requireRow(run(store, "UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, id));
}

/** Removes every admin account (to recover from a forgotten password). Returns how many there were. */
export function deleteUsers(store: Store): number {
  return run(store, "DELETE FROM users");
}
