import type { SQLQueryBindings } from "bun:sqlite";
import { AlreadySetUpError, NotFoundError, type Store, type User } from "../db/types.ts";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, username: row.username, passwordHash: row.password_hash };
}

export function countUsers(store: Store): number {
  return store.database.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM users").get()?.total ?? 0;
}

/** Creates the initial admin account, but only if none exists. The check and the insert are one transaction. */
export function createFirstUser(store: Store, username: string, passwordHash: string): User {
  return store.database
    .transaction(() => {
      if (countUsers(store) > 0) {
        throw new AlreadySetUpError();
      }
      const result = store.database
        .query<unknown, SQLQueryBindings[]>(
          "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
        )
        .run(username, passwordHash, store.now());
      return { id: Number(result.lastInsertRowid), username, passwordHash };
    })
    .immediate();
}

/** Finds an account by username, ignoring case. */
export function getUserByUsername(store: Store, username: string): User | null {
  const row = store.database
    .query<UserRow, [string]>("SELECT id, username, password_hash FROM users WHERE username = ?")
    .get(username);
  return row === null ? null : toUser(row);
}

export function getUserById(store: Store, id: number): User | null {
  const row = store.database
    .query<UserRow, [number]>("SELECT id, username, password_hash FROM users WHERE id = ?")
    .get(id);
  return row === null ? null : toUser(row);
}

export function updatePassword(store: Store, id: number, passwordHash: string): void {
  const changes = store.database.run("UPDATE users SET password_hash = ? WHERE id = ?", [
    passwordHash,
    id,
  ]).changes;
  if (changes === 0) {
    throw new NotFoundError();
  }
}

/** Removes the admin account (to recover from a forgotten password). Returns how many were removed. */
export function deleteUsers(store: Store): number {
  return store.database.run("DELETE FROM users").changes;
}
